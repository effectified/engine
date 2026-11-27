// The engine's steps over one target directory (`<out>/<package>/`): study (surface and scan), draft (the recipe),
// build (the facade package), verify (install and type check it), and release it on npm (pack it, then publish it).
// Each step reads what the one before wrote, so a person or an agent can stop after any of them, edit, and go on.

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { analyze } from "./analyze.ts";
import { manifestPath, readElements } from "./elements.ts";
import { typedElements } from "./element-types.ts";
import { type Drift, drift, driftMarkdown } from "./drift.ts";
import { runCommand, temporaryDirectory } from "./command.ts";
import { effectNative } from "./diagnostics.ts";
import { generate, valueExports, writeFiles } from "./generate.ts";
import { entryFiles, type Imported, importableNames, importFiles } from "./imports.ts";
import { installCommands, readTestDocs } from "./docs.ts";
import { PUBLISHING_NPM, type Published, published, requireNpm } from "./npm.ts";
import {
	decodeRecipe,
	demoArchive,
	draftRecipe,
	effectUiUrl,
	facadeVersion,
	type MethodOverride,
	PACKAGES_REPOSITORY,
	type Recipe,
	releaseTag,
	slug,
	targetDirectory,
	wrappedExports,
} from "./recipe.ts";
import { type Scan, scan } from "./scan.ts";
import { decodeSurface, type Surface } from "./surface.ts";
import { resolveTarget } from "./target.ts";
import { prepareWorkspace } from "./workspace.ts";

/** A target's directory and the files the steps keep in it. */
export interface TargetFiles {
	readonly directory: string;
	readonly surface: string;
	readonly scan: string;
	readonly recipe: string;
	readonly package: string;
}

/** A step failed in a way the steps themselves report: the package does not type check, or a file is missing. */
export class StepError extends Schema.TaggedError<StepError, { readonly brand: unique symbol }>()("StepError", {
	step: Schema.String,
	reason: Schema.String,
}) {}

/** Where a package's files are under `out`. */
export const targetFiles = Effect.fn("targetFiles")(function* (out: string, packageName: string) {
	const path = yield* Path.Path;
	const directory = path.resolve(out, packageName.replace(/^@/, "").replace("/", "__"));
	return {
		directory,
		surface: path.join(directory, "surface.json"),
		scan: path.join(directory, "scan.json"),
		recipe: path.join(directory, "recipe.json"),
		package: path.join(directory, "package"),
	} satisfies TargetFiles;
});

/**
 * Resolves and installs a target, reads its surface, marks the exports Node cannot import by name in every build it
 * resolves (`erased`; importing runs upstream's code, bare and within a deadline: `importableNames`), and scans its
 * source; writes `surface.json` and `scan.json`.
 */
export const study = Effect.fn("study")(function* (input: string, cache: string, out: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const target = yield* resolveTarget(input);
	const workspace = yield* prepareWorkspace(target, cache);
	const analyzed = absentAtRunTime(
		yield* analyze(workspace),
		yield* importableNames(workspace.directory, target.package),
	);
	const manifest = yield* manifestPath(workspace);
	const read = manifest === undefined ? undefined : yield* readElements(workspace, manifest);
	const surface =
		read === undefined
			? analyzed
			: { ...analyzed, elements: yield* typedElements(workspace, read.elements, read.documented) };
	const found = yield* scan(workspace);
	const files = yield* targetFiles(out, target.package);
	const readme = yield* fs
		.readFileString(path.join(workspace.packageDirectory, "README.md"))
		.pipe(Effect.orElseSucceed(() => ""));
	yield* fs.makeDirectory(files.directory, { recursive: true });
	yield* fs.writeFileString(files.surface, json(surface));
	yield* fs.writeFileString(files.scan, json(found));
	return { surface, scan: found, readme, files, workspace };
});

/**
 * `surface` with each export the module's run-time `names` lack marked `erased: "runtime"`, those the declarations
 * erase already kept so, and `runtime: "imported"`. A package Node could not import (a library that needs a browser)
 * is left as its declarations say, `runtime: "unimportable"`.
 */
export function absentAtRunTime(surface: Surface, names: Option.Option<ReadonlyArray<string>>): Surface {
	if (Option.isNone(names)) return { ...surface, runtime: "unimportable" };
	const present = new Set(names.value);
	return {
		...surface,
		exports: surface.exports.map((item) =>
			item.erased !== undefined || present.has(item.name) ? item : { ...item, erased: "runtime" as const },
		),
		runtime: "imported",
	};
}

/** Drafts the recipe into `recipe.json`, keeping every decision an agent or a person made in the one already there. */
export const draft = Effect.fn("draft")(function* (
	surface: Surface,
	found: Scan,
	readme: string,
	files: TargetFiles,
	frontend = false,
) {
	const fs = yield* FileSystem.FileSystem;
	const previous = (yield* fs.exists(files.recipe)) ? yield* readRecipe(files) : undefined;
	const recipe = yield* draftRecipe(surface, found, readme, previous, frontend);
	yield* fs.writeFileString(files.recipe, json(recipe));
	return recipe;
});

/** Generates the facade package into `package/` from `surface.json` and `recipe.json`. */
export const build = Effect.fn("build")(function* (files: TargetFiles) {
	const fs = yield* FileSystem.FileSystem;
	const surface = yield* fs.readFileString(files.surface).pipe(Effect.flatMap(decodeSurface));
	const recipe = yield* readRecipe(files);
	const generated = yield* generate(surface, recipe, yield* readTestDocs(files.package, recipe.name));
	yield* writeFiles(generated, files.package);
	// Bindings are all generated: one the recipe no longer offers would still ship and be importable.
	const elements = `${files.package}/src/elements`;
	if (yield* fs.exists(elements)) {
		for (const file of yield* fs.readDirectory(elements)) {
			if (!generated.has(`src/elements/${file}`)) yield* fs.remove(`${elements}/${file}`);
		}
	}
	return { surface, recipe, files: generated };
});

/**
 * Installs the generated package's dependencies (scripts off), type checks it with TypeScript 7, holds it to the
 * Effect-native standard (`@effect/tsgo`'s rules run by tsrs, the idioms run by oxlint), builds its release into
 * `dist/` and imports every entry point of it in Node (`importBuilt`). Returns what only TypeScript 7.1 rejects, as
 * notes, and what Node made of each entry point.
 */
export const verify = Effect.fn("verify")(function* (files: TargetFiles) {
	yield* install(files);
	const check = yield* typeCheck(files);
	if (check.exitCode !== 0) return yield* new StepError({ step: "tsc", reason: tail(check.output) });
	const { notes } = yield* effectNative(files.package);
	yield* buildRelease(files);
	return { notes, imported: yield* importBuilt(files) };
});

/** Builds the facade's release into `dist/` with TypeScript 7, as `release` packs it. */
const buildRelease = Effect.fn("buildRelease")(function* (files: TargetFiles) {
	const built = yield* runCommand(
		"node",
		["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json", "--noCheck", "false"],
		files.package,
	);
	if (built.exitCode !== 0) return yield* new StepError({ step: "build", reason: tail(built.output) });
});

/**
 * Imports every entry point of the facade's built `dist/` in Node, as an importer reaches it (`exports`, wildcards
 * expanded): a runtime facade that builds and tests but cannot be imported (a re-export of a name upstream's module
 * lacks) fails. A frontend facade runs in a browser and ships as its bundler resolves it: what Node makes of it, an
 * error linking it or one while its modules run, is reported, never failed, since its Vite bundle and its browser tests
 * check it.
 */
const importBuilt = Effect.fn("importBuilt")(function* (files: TargetFiles) {
	const recipe = yield* readRecipe(files);
	const entries = yield* entryFiles(files.package);
	const imported: ReadonlyArray<Imported> = yield* importFiles(
		files.package,
		entries,
		recipe.ui === undefined ? "node" : "browser",
	);
	const failed = imported.flatMap((entry) => (entry.kind === "failed" ? [`${entry.file}: ${entry.message}`] : []));
	if (entries.length === 0) failed.push("package.json names no entry point to import");
	if (failed.length > 0) return yield* new StepError({ step: "import", reason: failed.join("\n") });
	return imported;
});

/**
 * Generates, type checks, and turns what the compiler says about a spec into the recipe's method overrides, until
 * the package compiles. The analyzer and upstream's types can read a method differently (a generic whose result
 * collapses to `any`, say); the facade's types are the compiler's, so the runtime must follow them. The compiler is
 * TypeScript 7.0.2, the one the facade's users build with; what only TypeScript 7.1 rejects comes back as notes, a
 * surface studied before engine 0.4.0 as `restudy` (`restudyNote`), and offered exports named by a string, which the
 * facade leaves out, as `unwrapped` (`unwrappedNote`).
 */
export const reconcile = Effect.fn("reconcile")(function* (files: TargetFiles) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const built = yield* build(files);
	const restudy = restudyNote(built.surface, built.recipe);
	const unwrapped = unwrappedNote(built.surface, built.recipe);
	yield* install(files);
	const decided: Record<string, MethodOverride> = {};
	const kept: Array<string> = [];
	for (let round = 1; round <= MAX_ROUNDS; round++) {
		let check = yield* typeCheck(files);
		if (check.exitCode === 0) {
			// The package compiles; its declarations may not (a lifted type naming what upstream does not export),
			// and those they emit may name packages the facade does not declare yet.
			const emitted = yield* settleTypeDependencies(files);
			if (emitted.kind === "settled") {
				// It compiles and emits: it must also hold to the Effect-native standard, which no override can settle.
				const { notes } = yield* effectNative(files.package);
				return { rounds: round, overrides: decided, derived: kept, notes, restudy, unwrapped };
			}
			if (emitted.kind === "changed") {
				yield* build(files);
				yield* install(files);
				continue;
			}
			check = emitted.diagnostics;
		}
		const sources = new Map<string, string>();
		for (const [, file] of check.output.matchAll(/^([\w./-]+\.ts)\(\d+,\d+\): error/gm)) {
			if (file !== undefined && !sources.has(file))
				sources.set(
					file,
					yield* fs.readFileString(path.join(files.package, file)).pipe(Effect.orElseSucceed(() => "")),
				);
		}
		const rejected = rejectedMarkers(check.output, (file) => sources.get(file) ?? "");
		// A generic signature or an element's type that names what upstream does not declare falls back to derived
		// (untyped) types; a property upstream's element type does not have is left out.
		const derived = rejected
			.filter((item) => (item.marker === "explicit" || item.marker === "element") && !kept.includes(item.key))
			.map((item) => item.key);
		// A derived generic method TypeScript cannot type through a call keeps its derived type.
		const unlifted = rejected
			.filter((item) => item.marker === "lifted" && !kept.includes(`lifted:${item.key}`))
			.map((item) => item.key);
		const excluded = rejected
			.filter((item) => item.marker === "property")
			.map((item) => [item.key, "exclude" as MethodOverride] as const);
		// An override already tried once means the spec and the types disagree in a way overrides cannot settle.
		const found = [...Object.entries(overridesFrom(check.output)), ...excluded].filter(
			([key]) => decided[key] === undefined,
		);
		if (found.length === 0 && derived.length === 0 && unlifted.length === 0)
			return yield* new StepError({ step: "tsc", reason: tail(check.output) });
		const recipe = yield* readRecipe(files);
		for (const [key, value] of found) decided[key] = value;
		kept.push(...derived, ...unlifted.map((key) => `lifted:${key}`));
		yield* fs.writeFileString(
			files.recipe,
			json({
				...recipe,
				methods: { ...recipe.methods, ...Object.fromEntries(found) },
				derived: [...new Set([...recipe.derived, ...derived])].sort(),
				...(unlifted.length === 0
					? {}
					: { unlifted: [...new Set([...(recipe.unlifted ?? []), ...unlifted])].sort() }),
			}),
		);
		yield* build(files);
	}
	return yield* new StepError({ step: "reconcile", reason: `the package did not compile after ${MAX_ROUNDS} rounds` });
});

/**
 * The note for a runtime facade whose surface was studied before engine 0.4.0: it tells nothing of what Node can import
 * from upstream by name, so the facade re-exports none of upstream's values (`valueExports`); `study` finds which of
 * them Node can import, and the facade then re-exports those. None when it withholds nothing.
 */
export function restudyNote(surface: Surface, recipe: Recipe): Option.Option<string> {
	const values = valueExports(surface, recipe);
	if (recipe.ui !== undefined || values.kind !== "unprobed" || values.withheld.length === 0) return Option.none();
	return Option.some(
		`${surface.package}'s surface.json was studied before engine 0.4.0 and tells nothing of what Node can import from it by name, so the facade re-exports none of its ${values.withheld.length} values that need no wrapping (${values.withheld.join(", ")}): \`effectify study ${surface.package}@${surface.version}\` finds which of them Node can import, and the facade re-exports those`,
	);
}

/**
 * The note for the exports a recipe offers that its facade leaves out, being named by a string (`export { x as
 * "fetch-it" }`): a wrapper is a declaration named after its export (`wrappedExports`), which a string cannot name, so
 * each stays `Upstream["<name>"]`. None when the facade wraps every export it offers.
 */
export function unwrappedNote(surface: Surface, recipe: Recipe): Option.Option<string> {
	const wrapped = new Set(wrappedExports(surface, recipe).map((item) => item.name));
	const left = surface.exports.filter((item) => recipe.exports.includes(item.name) && !wrapped.has(item.name));
	if (recipe.ui !== undefined || left.length === 0) return Option.none();
	return Option.some(
		`the recipe offers exports named by strings (${left.map((item) => JSON.stringify(item.name)).join(", ")}): a facade declares each wrapper under its export's name, which a string cannot be, so it leaves them out; reach each as \`Upstream["<name>"]\``,
	);
}

/** How often `reconcile` regenerates; tsc names at most a few missing properties per error, so it may take several. */
const MAX_ROUNDS = 12;

/**
 * Runs the facade package's own tests (`test/*.test.ts`, written by agents or people; the generator keeps them)
 * through its `test` script, which carries the package's vitest flags (a browser facade's longer timeout).
 */
export const test = Effect.fn("test")(function* (files: TargetFiles) {
	const result = yield* runCommand("npm", ["run", "--silent", "test"], files.package);
	if (result.exitCode !== 0) return yield* new StepError({ step: "test", reason: tail(result.output) });
	return { output: tail(result.output) };
});

/**
 * What a release does with a facade's version, from what npm holds of its package and whether its GitHub release exists:
 * nothing (`released`); publish it on npm, then make its GitHub release (`publish`); make only the GitHub release, which
 * a run that stopped after publishing left out (`announce`); nothing yet, npm having never seen the package, which it
 * must have before it trusts a workflow to publish it (`bootstrap`, a person's step); or nothing, failing, when npm lacks
 * the version but its tag is a GitHub release already, which a release made otherwise holds (`conflict`: the GitHub-only
 * releases before engine 0.5.0 were tagged by upstream's version, `<slug>-v<upstream version>`).
 */
export type ReleasePlan = "released" | "publish" | "announce" | "bootstrap" | "conflict";

/** The release plan of a facade at `version`, from what npm holds of its package and whether its GitHub release exists. */
export function releasePlan(npm: Published, version: string, onGitHub: boolean): ReleasePlan {
	if (npm.kind === "absent") return "bootstrap";
	if (npm.versions.includes(version)) return onGitHub ? "released" : "announce";
	return onGitHub ? "conflict" : "publish";
}

/** A facade's release: its recipe, its version (`facadeVersion`), its tag and its plan. */
export interface Planned {
	readonly recipe: Recipe;
	readonly version: string;
	readonly tag: string;
	readonly plan: ReleasePlan;
}

/** Plans a facade's release: its version, and what npm and the GitHub releases of PACKAGES_REPOSITORY lack of it. */
export const planRelease = Effect.fn("planRelease")(function* (files: TargetFiles, root: string) {
	const recipe = yield* readRecipe(files);
	const version = yield* facadeVersion(recipe);
	const tag = releaseTag(recipe, version);
	const npm = yield* published(recipe.name);
	return { recipe, version, tag, plan: releasePlan(npm, version, yield* onGitHub(tag, root)) } satisfies Planned;
});

/** Whether PACKAGES_REPOSITORY has the GitHub release `tag`. */
const onGitHub = Effect.fn("onGitHub")(function* (tag: string, root: string) {
	return (yield* runCommand("gh", ["release", "view", tag, "--repo", PACKAGES_REPOSITORY], root)).exitCode === 0;
});

/**
 * The commit a release is made from, HEAD of `root`, which what it publishes names: for a release the tree must be
 * clean and the commit pushed; a dry run takes HEAD as it is.
 */
export const releaseCommit = Effect.fn("releaseCommit")(function* (root: string, dryRun: boolean) {
	const git = (args: ReadonlyArray<string>) => runCommand("git", args, root);
	const head = (yield* git(["rev-parse", "HEAD"])).output.trim();
	if (dryRun) return head;
	if ((yield* git(["status", "--porcelain"])).output.trim() !== "")
		return yield* new StepError({ step: "release", reason: "the tree has uncommitted changes" });
	yield* git(["fetch", "--quiet", "origin"]);
	if (!(yield* git(["branch", "--remotes", "--contains", head])).output.includes("origin/")) {
		return yield* new StepError({ step: "release", reason: `HEAD ${head} is not pushed` });
	}
	return head;
});

/** What `pack` wrote for a facade, `packed.json` beside the files it names: what `publish` needs. */
export const Packed = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	tag: Schema.String,
	/** The commit it was built from, which its GitHub release targets. */
	commit: Schema.String,
	/** The package's tarball, which npm publishes. */
	tarball: Schema.String,
	/** A frontend facade's built demo, which its GitHub release carries. */
	demo: Schema.optional(Schema.String),
});
export type Packed = typeof Packed.Type;

/** What `packRelease` did with a facade: packed it, or left it as npm and its GitHub release hold it. */
export type PackOutcome =
	| { readonly kind: "packed"; readonly planned: Planned; readonly packed: Packed }
	| { readonly kind: "released"; readonly planned: Planned }
	| { readonly kind: "bootstrap"; readonly planned: Planned };

/**
 * Packs a facade whose release has something to do (`planRelease`) into `into/<slug>/`, from `commit`. A package npm
 * has never seen is left, since no workflow may publish it yet, but in a dry run, which publishes nothing and checks it
 * too. A version whose tag another release holds fails (`conflict`): a later revision gives the facade a version of its
 * own.
 */
export const packRelease = Effect.fn("packRelease")(function* (
	files: TargetFiles,
	commit: string,
	into: string,
	root: string,
	dryRun: boolean,
) {
	const planned = yield* planRelease(files, root);
	switch (planned.plan) {
		case "released":
			return { kind: "released", planned } satisfies PackOutcome;
		case "bootstrap":
			if (!dryRun) return { kind: "bootstrap", planned } satisfies PackOutcome;
			break;
		case "conflict":
			return yield* new StepError({
				step: "release",
				reason: `npm lacks ${planned.recipe.name}@${planned.version}, but ${PACKAGES_REPOSITORY} has a GitHub release ${planned.tag} already, made otherwise (before engine 0.5.0 a release was tagged by upstream's version): raise recipe.revision past it, so the facade's version is one of its own`,
			});
		case "publish":
		case "announce":
			break;
	}
	return { kind: "packed", planned, packed: yield* pack(files, planned, commit, into) } satisfies PackOutcome;
});

/**
 * Builds a facade with TypeScript 7, imports every entry point of the build in Node, and packs it into `into/<slug>/`:
 * the tarball npm publishes, the notes of its GitHub release, a frontend facade's demo, and `packed.json`.
 */
const pack = Effect.fn("pack")(function* (files: TargetFiles, planned: Planned, commit: string, into: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const { recipe, version, tag } = planned;
	const directory = path.join(into, slug(recipe));
	yield* fs.makeDirectory(directory, { recursive: true });
	yield* install(files);
	yield* buildRelease(files);
	// What is released must import: a facade that built and tested can still fail as it loads.
	yield* importBuilt(files);
	const packed = yield* runCommand(
		"npm",
		["pack", "--ignore-scripts", "--pack-destination", directory],
		files.package,
	);
	if (packed.exitCode !== 0) return yield* new StepError({ step: "npm pack", reason: tail(packed.output) });
	// npm names the file it wrote as its last line.
	const tarball = packed.stdout.trim().split("\n").at(-1) ?? "";
	// A frontend facade's fixtures, built by Vite, are its demo: effectified.dev embeds the release's own.
	const demo =
		recipe.ui !== undefined && (yield* readTestDocs(files.package, recipe.name)).demos.length > 0
			? yield* buildDemo(files, demoArchive(recipe, version), directory)
			: undefined;
	yield* fs.writeFileString(path.join(directory, NOTES), releaseNotes(recipe, version, commit));
	const written = {
		name: recipe.name,
		version,
		tag,
		commit,
		tarball,
		...(demo === undefined ? {} : { demo }),
	} satisfies Packed;
	yield* fs.writeFileString(path.join(directory, PACKED), json(written));
	return written;
});

/** The record `pack` writes beside a facade's files, and the notes of its GitHub release. */
const PACKED = "packed.json";
const NOTES = "NOTES.md";

/** Builds a frontend facade's demo (`npm run demo`) and archives it as `archive` in `directory`; its file name. */
const buildDemo = Effect.fn("buildDemo")(function* (files: TargetFiles, archive: string, directory: string) {
	const path = yield* Path.Path;
	const site = yield* temporaryDirectory("effectified-demo-");
	const demo = yield* runCommand("npm", ["run", "--silent", "demo", "--", site], files.package);
	if (demo.exitCode !== 0) return yield* new StepError({ step: "demo", reason: tail(demo.output) });
	const tar = yield* runCommand("tar", ["-czf", path.join(directory, archive), "-C", site, "."], files.package);
	if (tar.exitCode !== 0) return yield* new StepError({ step: "tar", reason: tail(tar.output) });
	return archive;
}, Effect.scoped);

/** The notes of a facade's GitHub release: what it is, how to install it from npm, and where it was made. */
function releaseNotes(recipe: Recipe, version: string, commit: string): string {
	return [
		`${recipe.name} ${version}: ${recipe.package}@${recipe.version} in Effect, generated by the effectified engine at ${commit}.`,
		"",
		"```sh",
		...installCommands(recipe.name, recipe.ui === undefined ? undefined : effectUiUrl(recipe.ui.effectUi)),
		"```",
		"",
		`On npm: https://www.npmjs.com/package/${recipe.name}/v/${version}`,
		"",
		`Recipe, surface and tests: https://github.com/${PACKAGES_REPOSITORY}/tree/${commit}/targets/${targetDirectory(recipe)}`,
		"",
	].join("\n");
}

/** Reads every facade `pack` wrote into `from`, in the order of their directories. */
export const readPacked = Effect.fn("readPacked")(function* (from: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const found: Array<{ readonly directory: string; readonly packed: Packed }> = [];
	for (const entry of (yield* fs.readDirectory(from)).sort()) {
		const directory = path.join(from, entry);
		const file = path.join(directory, PACKED);
		// Trust boundary: files an earlier step (CI's pack job) wrote.
		if (yield* fs.exists(file))
			found.push({ directory, packed: yield* fs.readFileString(file).pipe(Effect.flatMap(decodePacked)) });
	}
	return found;
});

const decodePacked = Schema.decodeUnknownEffect(Schema.fromJsonString(Packed));

/** What `publish` did on npm with a packed facade: a dry run's check carries what npm said of the tarball. */
export type NpmOutcome =
	| { readonly kind: "published" }
	| { readonly kind: "checked"; readonly output: string }
	| { readonly kind: "present" }
	| { readonly kind: "bootstrap" };

/** What `publish` did with a packed facade, on npm and on GitHub. */
export interface PublishOutcome {
	readonly packed: Packed;
	readonly npm: NpmOutcome;
	readonly github: "created" | "present" | "skipped";
}

/**
 * Publishes a facade `pack` wrote into `directory` on npm unless npm has its version, then makes its GitHub release
 * unless it exists, so a run that stopped between them is finished by the next. A package npm has never seen is left
 * (`bootstrap` first). A dry run lets npm check the tarball (`npm publish --dry-run`), a package npm has never seen
 * too, and makes no GitHub release.
 */
export const publish = Effect.fn("publish")(function* (
	directory: string,
	packed: Packed,
	root: string,
	dryRun: boolean,
) {
	const path = yield* Path.Path;
	const npm = yield* publishOnNpm(path.join(directory, packed.tarball), packed, directory, dryRun);
	if (dryRun || npm.kind === "bootstrap") return { packed, npm, github: "skipped" } satisfies PublishOutcome;
	if (yield* onGitHub(packed.tag, root)) return { packed, npm, github: "present" } satisfies PublishOutcome;
	const created = yield* runCommand(
		"gh",
		[
			"release",
			"create",
			packed.tag,
			"--repo",
			PACKAGES_REPOSITORY,
			"--target",
			packed.commit,
			// The facades share the repository's releases: none of them is the repository's latest.
			"--latest=false",
			"--title",
			`${packed.name} ${packed.version}`,
			"--notes-file",
			path.join(directory, NOTES),
			...(packed.demo === undefined ? [] : [path.join(directory, packed.demo)]),
		],
		root,
	);
	if (created.exitCode !== 0) return yield* new StepError({ step: "gh release", reason: tail(created.output) });
	return { packed, npm, github: "created" } satisfies PublishOutcome;
});

/**
 * Publishes `tarball` on npm unless npm has its version or has never seen its package; npm takes the workflow's identity
 * in CI (trusted publishing), which needs PUBLISHING_NPM. A dry run lets npm check it, whatever npm holds of the
 * package but the version itself.
 */
const publishOnNpm = Effect.fn("publishOnNpm")(function* (
	tarball: string,
	packed: Packed,
	directory: string,
	dryRun: boolean,
) {
	const npm = yield* published(packed.name);
	if (npm.kind === "present" && npm.versions.includes(packed.version)) return { kind: "present" } satisfies NpmOutcome;
	if (npm.kind === "absent" && !dryRun) return { kind: "bootstrap" } satisfies NpmOutcome;
	if (!dryRun)
		yield* requireNpm(PUBLISHING_NPM, "publishing through the workflow's identity, with no token", directory);
	const result = yield* runCommand(
		"npm",
		["publish", tarball, "--access", "public", "--ignore-scripts", ...(dryRun ? ["--dry-run"] : [])],
		directory,
	);
	if (result.exitCode !== 0) {
		return yield* new StepError({
			step: "npm publish",
			reason: `${packed.name}@${packed.version}: ${tail(result.output)}`,
		});
	}
	return dryRun
		? ({ kind: "checked", output: tail(result.output) } satisfies NpmOutcome)
		: ({ kind: "published" } satisfies NpmOutcome);
});

/** What `sync` did with one target. */
export type Synced =
	| { readonly kind: "current"; readonly package: string; readonly version: string }
	| {
			readonly kind: "updated";
			readonly package: string;
			readonly from: string;
			readonly to: string;
			readonly drift: Drift;
			/** What only TypeScript 7.1 rejects in the regenerated facade (`reconcile`'s notes). */
			readonly notes: ReadonlyArray<string>;
	  };

/**
 * Brings a target to upstream's latest version: studies it, writes the drift (`DRIFT.md`), redrafts the recipe
 * (keeping what agents and people decided), reconciles, and runs the facade's tests. A failing step fails the sync,
 * with the drift already written for whoever picks it up.
 */
export const sync = Effect.fn("sync")(function* (packageName: string, cache: string, out: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const files = yield* targetFiles(out, packageName);
	const before = yield* fs.readFileString(files.surface).pipe(Effect.flatMap(decodeSurface));
	const latest = yield* resolveTarget(packageName);
	if (latest.version === before.version)
		return { kind: "current", package: packageName, version: before.version } satisfies Synced;
	const studied = yield* study(`${packageName}@${latest.version}`, cache, out);
	const changes = drift(before, studied.surface);
	yield* fs.writeFileString(path.join(files.directory, "DRIFT.md"), driftMarkdown(changes));
	yield* draft(studied.surface, studied.scan, studied.readme, files);
	const { notes } = yield* reconcile(files);
	yield* test(files);
	return {
		kind: "updated",
		package: packageName,
		from: before.version,
		to: latest.version,
		drift: changes,
		notes,
	} satisfies Synced;
});

/** The npm names of every target under `out` (each directory with a `recipe.json`). */
export const listTargets = Effect.fn("listTargets")(function* (out: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const names: Array<string> = [];
	for (const entry of yield* fs.readDirectory(out)) {
		const recipe = path.join(out, entry, "recipe.json");
		if (yield* fs.exists(recipe))
			names.push((yield* readRecipe({ ...(yield* targetFiles(out, entry)), recipe })).package);
	}
	return names.sort();
});

/** What the compiler rejected on a line the generator marked: `// explicit: X`, `// lifted: X`, `// property: X`, `// element: X`. */
export interface Rejected {
	readonly marker: "explicit" | "lifted" | "property" | "element";
	readonly key: string;
}

/** The marked lines tsc rejects, reading each erroring file of the package with `read`. */
export function rejectedMarkers(diagnostics: string, read: (file: string) => string): ReadonlyArray<Rejected> {
	const found = new Map<string, Rejected>();
	for (const [, file, line] of diagnostics.matchAll(/^([\w./-]+\.ts)\((\d+),\d+\): error/gm)) {
		if (file === undefined) continue;
		const marked = /\/\/ (explicit|lifted|property|element): (\S+)$/.exec(
			read(file).split("\n")[Number(line) - 1] ?? "",
		);
		if (marked !== null)
			found.set(`${marked[1]}:${marked[2]}`, { marker: marked[1] as Rejected["marker"], key: marked[2] ?? "" });
	}
	return [...found.values()];
}

/** The generic methods whose explicit signature (a line marked `// explicit: <Handle>.<method>`) tsc rejects. */
export function explicitFailures(diagnostics: string, source: string): ReadonlyArray<string> {
	return rejectedMarkers(diagnostics, () => source)
		.filter((rejected) => rejected.marker === "explicit")
		.map((rejected) => rejected.key);
}

/** The method overrides tsc's diagnostics of a generated `index.ts` call for, by `<Handle>.<method>`. */
export function overridesFrom(diagnostics: string): Record<string, MethodOverride> {
	const overrides: Record<string, MethodOverride> = {};
	// `StreamSpec` also names the handles: `StreamSpec<Pick<Page, PageMethods>, Handles>`.
	const spec = String.raw`'(Async|Stream)Spec<Pick<.*?(\w+)Methods>(?:, Handles)?>'`;
	// Listed in a spec, but upstream's types do not read the method so: it is something else.
	for (const [, method, , handle] of diagnostics.matchAll(
		new RegExp(String.raw`'"([^"]+)"' does not exist in type ${spec}`, "g"),
	)) {
		overrides[`${handle}.${method}`] = "sync";
	}
	// Missing from a spec that upstream's types require.
	for (const [, method, kind, handle] of diagnostics.matchAll(
		new RegExp(String.raw`Property '([^']+)' is missing in type '.*?' but required in type ${spec}`, "g"),
	)) {
		overrides[`${handle}.${method}`] = kind === "Async" ? "async" : "stream";
	}
	for (const [, kind, handle, list] of diagnostics.matchAll(
		new RegExp(String.raw`missing the following properties from type ${spec}: ([^.\n]+)`, "g"),
	)) {
		for (const method of (list ?? "").split(/, | and /).filter((name) => /^[\w$]+$/.test(name))) {
			overrides[`${handle}.${method}`] = kind === "Async" ? "async" : "stream";
		}
	}
	// Listed as a method but not one of upstream's public methods.
	for (const [, handle, method] of diagnostics.matchAll(
		/Type '(\w+)Methods' does not satisfy the constraint '[^']*'\.\s+Type '"([^"]+)"' is not assignable/g,
	)) {
		overrides[`${handle}.${method}`] = "exclude";
	}
	return overrides;
}

const install = Effect.fn("install")(function* (files: TargetFiles) {
	// --allow-remote=all: frontend facades take Effect UI's snapshot build and the puppeteer facade from URLs.
	const result = yield* runCommand(
		"npm",
		["install", "--ignore-scripts", "--allow-remote=all", "--no-audit", "--no-fund", "--loglevel=error"],
		files.package,
	);
	if (result.exitCode !== 0) return yield* new StepError({ step: "npm install", reason: tail(result.output) });
});

/**
 * Emits the facade's declarations and records in the recipe the packages they import that the facade does not
 * declare (puppeteer's `.d.ts` name `typed-query-selector`), at the range upstream depends on each: under a strict
 * install (pnpm) a declaration can only resolve what its own package declares. Only upstream's dependencies count:
 * they are installed with it anyway. The emit's diagnostics when it failed, else whether the recipe changed.
 */
const settleTypeDependencies = Effect.fn("settleTypeDependencies")(function* (files: TargetFiles) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const out = yield* temporaryDirectory();
	const emitted = yield* runCommand(
		"node",
		[
			"node_modules/typescript/bin/tsc",
			"-p",
			"tsconfig.build.json",
			"--outDir",
			out,
			"--pretty",
			"false",
			"--noCheck",
			"false",
		],
		files.package,
	);
	if (emitted.exitCode !== 0) return { kind: "failed", diagnostics: emitted } satisfies Emitted;
	const recipe = yield* readRecipe(files);
	// Trust boundary: package manifests are files, read as untyped JSON.
	const manifest = (file: string) =>
		fs
			.readFileString(file)
			.pipe(Effect.map((text): { readonly dependencies?: Record<string, string> } => JSON.parse(text)));
	const own = yield* manifest(path.join(files.package, "package.json"));
	const upstream = yield* manifest(path.join(files.package, "node_modules", recipe.package, "package.json"));
	const found: Record<string, string> = {};
	for (const file of (yield* fs.readDirectory(out, { recursive: true })).filter((name) => name.endsWith(".d.ts"))) {
		const text = yield* fs.readFileString(path.join(out, file));
		for (const match of text.matchAll(/(?:from\s+|import\(\s*)["']((?:@[^/"']+\/)?[^./"'][^/"']*)/g)) {
			const name = match[1] ?? "";
			const range = upstream.dependencies?.[name];
			if (range !== undefined && own.dependencies?.[name] === undefined) found[name] = range;
		}
	}
	if (Object.keys(found).length === 0) return { kind: "settled" } satisfies Emitted;
	const typeDependencies = Object.fromEntries(
		Object.entries({ ...recipe.typeDependencies, ...found }).sort(([a], [b]) => a.localeCompare(b)),
	);
	yield* fs.writeFileString(files.recipe, json({ ...recipe, typeDependencies }));
	return { kind: "changed" } satisfies Emitted;
}, Effect.scoped);

/** What emitting a facade's declarations found: nothing to change, type dependencies added, or diagnostics. */
type Emitted =
	| { readonly kind: "settled" }
	| { readonly kind: "changed" }
	| { readonly kind: "failed"; readonly diagnostics: { readonly exitCode: number; readonly output: string } };

// `--noCheck false`: a tsconfig.json that skips checking (`noCheck`, in it or one it extends) would pass anything.
const typeCheck = (files: TargetFiles) =>
	runCommand(
		"node",
		["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--pretty", "false", "--noCheck", "false"],
		files.package,
	);

/** The last lines of a tool's output, enough to say what failed. */
function tail(output: string): string {
	return output.trim().split("\n").slice(-40).join("\n");
}

/** Reads a target's `recipe.json`. */
export const readRecipe = Effect.fn("readRecipe")(function* (files: TargetFiles) {
	const fs = yield* FileSystem.FileSystem;
	const recipe: Recipe = yield* fs.readFileString(files.recipe).pipe(Effect.flatMap(decodeRecipe));
	return recipe;
});

function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}
