// The engine's steps over one target directory (`<out>/<package>/`): study (surface and scan), draft (the recipe),
// build (the facade package) and verify (install and type check it). Each step reads what the one before wrote, so a
// person or an agent can stop after any of them, edit, and go on.

import { Effect, FileSystem, Path, Schema } from "effect";
import { analyze } from "./analyze.ts";
import { manifestPath, readElements } from "./elements.ts";
import { typedElements } from "./element-types.ts";
import { type Drift, drift, driftMarkdown } from "./drift.ts";
import { runCommand } from "./command.ts";
import { generate, writeFiles } from "./generate.ts";
import { decodeRecipe, draftRecipe, facadeVersion, type MethodOverride, PACKAGES_REPOSITORY, type Recipe, releaseTag, releaseUrl } from "./recipe.ts";
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
export class StepError extends Schema.TaggedError<StepError>()("StepError", { step: Schema.String, reason: Schema.String }) {}

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

/** Resolves and installs a target, reads its surface and scans its source; writes `surface.json` and `scan.json`. */
export const study = Effect.fn("study")(function* (input: string, cache: string, out: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const target = yield* resolveTarget(input);
	const workspace = yield* prepareWorkspace(target, cache);
	const analyzed = yield* analyze(workspace);
	const manifest = yield* manifestPath(workspace);
	const read = manifest === undefined ? undefined : yield* readElements(workspace, manifest);
	const surface = read === undefined ? analyzed : { ...analyzed, elements: yield* typedElements(workspace, read.elements, read.documented) };
	const found = yield* scan(workspace);
	const files = yield* targetFiles(out, target.package);
	const readme = yield* fs.readFileString(path.join(workspace.packageDirectory, "README.md")).pipe(Effect.orElseSucceed(() => ""));
	yield* fs.makeDirectory(files.directory, { recursive: true });
	yield* fs.writeFileString(files.surface, json(surface));
	yield* fs.writeFileString(files.scan, json(found));
	return { surface, scan: found, readme, files, workspace };
});

/** Drafts the recipe into `recipe.json`, keeping every decision an agent or a person made in the one already there. */
export const draft = Effect.fn("draft")(function* (surface: Surface, found: Scan, readme: string, files: TargetFiles, frontend = false) {
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
	const generated = yield* generate(surface, recipe);
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

/** Installs the generated package's dependencies (scripts off) and type checks it with TypeScript 7. */
export const verify = Effect.fn("verify")(function* (files: TargetFiles) {
	yield* install(files);
	const check = yield* typeCheck(files);
	if (check.exitCode !== 0) return yield* new StepError({ step: "tsc", reason: tail(check.output) });
});

/**
 * Generates, type checks, and turns what the compiler says about a spec into the recipe's method overrides, until
 * the package compiles. The analyzer and upstream's types can read a method differently (a generic whose result
 * collapses to `any`, say); the facade's types are the compiler's, so the runtime must follow them.
 */
export const reconcile = Effect.fn("reconcile")(function* (files: TargetFiles) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	yield* build(files);
	yield* install(files);
	const decided: Record<string, MethodOverride> = {};
	const kept: Array<string> = [];
	for (let round = 1; round <= MAX_ROUNDS; round++) {
		const check = yield* typeCheck(files);
		if (check.exitCode === 0) {
			// The declarations compile; those they emit may name packages the facade does not declare yet.
			if (!(yield* settleTypeDependencies(files))) return { rounds: round, overrides: decided, derived: kept };
			yield* build(files);
			yield* install(files);
			continue;
		}
		const sources = new Map<string, string>();
		for (const [, file] of check.output.matchAll(/^([\w./-]+\.ts)\(\d+,\d+\): error/gm)) {
			if (file !== undefined && !sources.has(file)) sources.set(file, yield* fs.readFileString(path.join(files.package, file)).pipe(Effect.orElseSucceed(() => "")));
		}
		const rejected = rejectedMarkers(check.output, (file) => sources.get(file) ?? "");
		// A generic signature or an element's type that names what upstream does not declare falls back to derived
		// (untyped) types; a property upstream's element type does not have is left out.
		const derived = rejected.filter((item) => (item.marker === "explicit" || item.marker === "element") && !kept.includes(item.key)).map((item) => item.key);
		// A derived generic method TypeScript cannot type through a call keeps its derived type.
		const unlifted = rejected.filter((item) => item.marker === "lifted" && !kept.includes(`lifted:${item.key}`)).map((item) => item.key);
		const excluded = rejected.filter((item) => item.marker === "property").map((item) => [item.key, "exclude" as MethodOverride] as const);
		// An override already tried once means the spec and the types disagree in a way overrides cannot settle.
		const found = [...Object.entries(overridesFrom(check.output)), ...excluded].filter(([key]) => decided[key] === undefined);
		if (found.length === 0 && derived.length === 0 && unlifted.length === 0) return yield* new StepError({ step: "tsc", reason: tail(check.output) });
		const recipe = yield* readRecipe(files);
		for (const [key, value] of found) decided[key] = value;
		kept.push(...derived, ...unlifted.map((key) => `lifted:${key}`));
		yield* fs.writeFileString(
			files.recipe,
			json({
				...recipe,
				methods: { ...recipe.methods, ...Object.fromEntries(found) },
				derived: [...new Set([...recipe.derived, ...derived])].sort(),
				...(unlifted.length === 0 ? {} : { unlifted: [...new Set([...(recipe.unlifted ?? []), ...unlifted])].sort() }),
			}),
		);
		yield* build(files);
	}
	return yield* new StepError({ step: "reconcile", reason: `the package did not compile after ${MAX_ROUNDS} rounds` });
});

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

/** Whether the facade's current version (`<name>-v<version>`) is released on PACKAGES_REPOSITORY. */
export const isReleased = Effect.fn("isReleased")(function* (files: TargetFiles, root: string) {
	const recipe = yield* readRecipe(files);
	return (yield* runCommand("gh", ["release", "view", releaseTag(recipe), "--repo", PACKAGES_REPOSITORY], root)).exitCode === 0;
});

/**
 * Releases a facade on GitHub: builds it with TypeScript 7, packs it, and attaches the tarball to the release
 * `<name>-v<version>` of PACKAGES_REPOSITORY, made from a clean, pushed HEAD of that repository and never replaced.
 */
export const release = Effect.fn("release")(function* (files: TargetFiles, root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const recipe = yield* readRecipe(files);
	const name = recipe.name.replace(/^@effectified\//, "");
	const version = facadeVersion(recipe);
	const tag = releaseTag(recipe);
	const git = (args: ReadonlyArray<string>) => runCommand("git", args, root);
	if ((yield* git(["status", "--porcelain"])).output.trim() !== "") return yield* new StepError({ step: "release", reason: "the tree has uncommitted changes" });
	const head = (yield* git(["rev-parse", "HEAD"])).output.trim();
	yield* git(["fetch", "--quiet", "origin"]);
	if (!(yield* git(["branch", "--remotes", "--contains", head])).output.includes("origin/")) {
		return yield* new StepError({ step: "release", reason: `HEAD ${head} is not pushed` });
	}
	if ((yield* runCommand("gh", ["release", "view", tag, "--repo", PACKAGES_REPOSITORY], root)).exitCode === 0) {
		return yield* new StepError({ step: "release", reason: `${tag} is released already; a release is never replaced` });
	}
	yield* install(files);
	const built = yield* runCommand("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], files.package);
	if (built.exitCode !== 0) return yield* new StepError({ step: "build", reason: tail(built.output) });
	const packed = yield* fs.makeTempDirectoryScoped();
	const pack = yield* runCommand("npm", ["pack", "--ignore-scripts", "--pack-destination", packed], files.package);
	if (pack.exitCode !== 0) return yield* new StepError({ step: "npm pack", reason: tail(pack.output) });
	// The tarball is named as its URL says, whatever npm made of a `+revision` in the file it wrote.
	const written = (yield* fs.readDirectory(packed)).find((file) => file.endsWith(".tgz")) ?? "";
	const tarball = path.join(packed, `effectified-${name}-${version}.tgz`);
	if (written !== path.basename(tarball)) yield* fs.rename(path.join(packed, written), tarball);
	const url = releaseUrl(recipe);
	const notes = path.join(packed, "NOTES.md");
	yield* fs.writeFileString(
		notes,
		[
			`${recipe.name} ${version}: ${recipe.package}@${recipe.version} in Effect, generated by the effectified engine at ${head}.`,
			"",
			"```sh",
			`npm install --allow-remote=root ${url} effect`,
			`pnpm add ${url} effect`,
			`bun add ${url} effect`,
			"```",
			"",
			`Recipe, surface and tests: https://github.com/${PACKAGES_REPOSITORY}/tree/${head}/targets/${files.directory.split("/").at(-1)}`,
			"",
		].join("\n"),
	);
	const created = yield* runCommand(
		"gh",
		["release", "create", tag, "--repo", PACKAGES_REPOSITORY, "--target", head, "--prerelease", "--title", `${recipe.name} ${version}`, "--notes-file", notes, tarball],
		root,
	);
	if (created.exitCode !== 0) return yield* new StepError({ step: "gh release", reason: tail(created.output) });
	return { tag, url };
}, Effect.scoped);

/** What `sync` did with one target. */
export type Synced =
	| { readonly kind: "current"; readonly package: string; readonly version: string }
	| { readonly kind: "updated"; readonly package: string; readonly from: string; readonly to: string; readonly drift: Drift };

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
	if (latest.version === before.version) return { kind: "current", package: packageName, version: before.version } satisfies Synced;
	const studied = yield* study(`${packageName}@${latest.version}`, cache, out);
	const changes = drift(before, studied.surface);
	yield* fs.writeFileString(path.join(files.directory, "DRIFT.md"), driftMarkdown(changes));
	yield* draft(studied.surface, studied.scan, studied.readme, files);
	yield* reconcile(files);
	yield* test(files);
	return { kind: "updated", package: packageName, from: before.version, to: latest.version, drift: changes } satisfies Synced;
});

/** The npm names of every target under `out` (each directory with a `recipe.json`). */
export const listTargets = Effect.fn("listTargets")(function* (out: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const names: Array<string> = [];
	for (const entry of yield* fs.readDirectory(out)) {
		const recipe = path.join(out, entry, "recipe.json");
		if (yield* fs.exists(recipe)) names.push((yield* readRecipe({ ...(yield* targetFiles(out, entry)), recipe })).package);
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
		const marked = /\/\/ (explicit|lifted|property|element): (\S+)$/.exec(read(file).split("\n")[Number(line) - 1] ?? "");
		if (marked !== null) found.set(`${marked[1]}:${marked[2]}`, { marker: marked[1] as Rejected["marker"], key: marked[2] ?? "" });
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
	for (const [, method, , handle] of diagnostics.matchAll(new RegExp(String.raw`'"([^"]+)"' does not exist in type ${spec}`, "g"))) {
		overrides[`${handle}.${method}`] = "sync";
	}
	// Missing from a spec that upstream's types require.
	for (const [, method, kind, handle] of diagnostics.matchAll(new RegExp(String.raw`Property '([^']+)' is missing in type '.*?' but required in type ${spec}`, "g"))) {
		overrides[`${handle}.${method}`] = kind === "Async" ? "async" : "stream";
	}
	for (const [, kind, handle, list] of diagnostics.matchAll(new RegExp(String.raw`missing the following properties from type ${spec}: ([^.\n]+)`, "g"))) {
		for (const method of (list ?? "").split(/, | and /).filter((name) => /^[\w$]+$/.test(name))) {
			overrides[`${handle}.${method}`] = kind === "Async" ? "async" : "stream";
		}
	}
	// Listed as a method but not one of upstream's public methods.
	for (const [, handle, method] of diagnostics.matchAll(/Type '(\w+)Methods' does not satisfy the constraint '[^']*'\.\s+Type '"([^"]+)"' is not assignable/g)) {
		overrides[`${handle}.${method}`] = "exclude";
	}
	return overrides;
}

const install = Effect.fn("install")(function* (files: TargetFiles) {
	// --allow-remote=all: frontend facades take Effect UI's snapshot build and the puppeteer facade from URLs.
	const result = yield* runCommand("npm", ["install", "--ignore-scripts", "--allow-remote=all", "--no-audit", "--no-fund", "--loglevel=error"], files.package);
	if (result.exitCode !== 0) return yield* new StepError({ step: "npm install", reason: tail(result.output) });
});

/**
 * Emits the facade's declarations and records in the recipe the packages they import that the facade does not
 * declare (puppeteer's `.d.ts` name `typed-query-selector`), at the range upstream depends on each: under a strict
 * install (pnpm) a declaration can only resolve what its own package declares. Only upstream's dependencies count:
 * they are installed with it anyway. Whether the recipe changed.
 */
const settleTypeDependencies = Effect.fn("settleTypeDependencies")(function* (files: TargetFiles) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const out = yield* fs.makeTempDirectoryScoped();
	const emitted = yield* runCommand("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json", "--outDir", out, "--pretty", "false"], files.package);
	if (emitted.exitCode !== 0) return yield* new StepError({ step: "declarations", reason: tail(emitted.output) });
	const recipe = yield* readRecipe(files);
	// Trust boundary: package manifests are files, read as untyped JSON.
	const manifest = (file: string) => fs.readFileString(file).pipe(Effect.map((text): { readonly dependencies?: Record<string, string> } => JSON.parse(text)));
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
	if (Object.keys(found).length === 0) return false;
	const typeDependencies = Object.fromEntries(Object.entries({ ...recipe.typeDependencies, ...found }).sort(([a], [b]) => a.localeCompare(b)));
	yield* fs.writeFileString(files.recipe, json({ ...recipe, typeDependencies }));
	return true;
}, Effect.scoped);

const typeCheck = (files: TargetFiles) =>
	runCommand("node", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--pretty", "false"], files.package);

/** The last lines of a tool's output, enough to say what failed. */
function tail(output: string): string {
	return output.trim().split("\n").slice(-40).join("\n");
}

const readRecipe = Effect.fn("readRecipe")(function* (files: TargetFiles) {
	const fs = yield* FileSystem.FileSystem;
	const recipe: Recipe = yield* fs.readFileString(files.recipe).pipe(Effect.flatMap(decodeRecipe));
	return recipe;
});

function json(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}
