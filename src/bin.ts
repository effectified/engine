// The `effectify` command line: each step of the engine as a command, and `make` running them all on one target.
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { drift, driftMarkdown } from "./drift.ts";
import { ENGINE_VERSION } from "./generate.ts";
import { plan, planMarkdown } from "./plan.ts";
import { usages, usagesMarkdown } from "./usages.ts";
import {
	build,
	draft,
	isReleased,
	listTargets,
	reconcile,
	release,
	study,
	sync,
	targetFiles,
	test,
	verify,
} from "./pipeline.ts";
import { decodeRecipe } from "./recipe.ts";
import { decodeSurface } from "./surface.ts";
import type { Recipe } from "./recipe.ts";
import type { Surface } from "./surface.ts";

const cache = Flag.String("cache").pipe(
	Flag.withDescription("Where installed targets are kept"),
	Flag.withDefault(".cache"),
);
const out = Flag.String("out").pipe(
	Flag.withDescription("Where target directories are written"),
	Flag.withDefault("targets"),
);
const target = Argument.String("target").pipe(
	Argument.withDescription("A GitHub repository URL, or an npm package name with an optional @version"),
);
const ui = Flag.Boolean("ui").pipe(
	Flag.withDescription("Make a frontend facade for Effect UI (web-component libraries are detected)"),
	Flag.withDefault(false),
);
const packageName = Argument.String("package").pipe(
	Argument.withDescription("The npm name of a target already studied"),
);

const studyCommand = Command.make("study", { target, cache, out }, ({ target, cache, out }) =>
	Effect.gen(function* () {
		const studied = yield* study(target, cache, out);
		yield* Console.log(surfaceSummary(studied.surface));
		yield* Console.log(
			`scan: ${studied.scan.files} files, errors ${studied.scan.errorClasses.map((e) => e.name).join(", ") || "none"}, codes ${studied.scan.codes.slice(0, 8).join(", ") || "none"}`,
		);
		yield* Console.log(`wrote ${studied.files.surface} and ${studied.files.scan}`);
	}),
).pipe(
	Command.withDescription(
		"Resolve and install a target, read its surface with TypeScript 7, scan its source, and import it in Node, which runs its code: study only a library you would install",
	),
);

const draftCommand = Command.make("draft", { target, cache, out, ui }, ({ target, cache, out, ui }) =>
	Effect.gen(function* () {
		const studied = yield* study(target, cache, out);
		const recipe = yield* draft(studied.surface, studied.scan, studied.readme, studied.files, ui);
		yield* Console.log(recipeSummary(recipe));
		yield* Console.log(`wrote ${studied.files.recipe}`);
	}),
).pipe(Command.withDescription("Study a target and draft its recipe, keeping decisions an agent or a person made"));

const generateCommand = Command.make("generate", { packageName, out }, ({ packageName, out }) =>
	Effect.gen(function* () {
		const files = yield* targetFiles(out, packageName);
		const built = yield* build(files);
		yield* Console.log(`generated ${built.files.size} files into ${files.package}`);
	}),
).pipe(Command.withDescription("Generate the facade package from surface.json and recipe.json"));

const verifyCommand = Command.make("verify", { packageName, out }, ({ packageName, out }) =>
	Effect.gen(function* () {
		const files = yield* targetFiles(out, packageName);
		const verified = yield* verify(files);
		// A browser facade's reports: what Node made of an entry point, which fails nothing.
		const reported = (kind: "unlinked" | "unevaluated") =>
			verified.imported.flatMap((entry) =>
				entry.kind !== "imported" && entry.kind === kind ? [`  ${entry.file}: ${entry.message}`] : [],
			);
		const unlinked = reported("unlinked");
		const unevaluated = reported("unevaluated");
		const imported = verified.imported.length - unlinked.length - unevaluated.length;
		yield* Console.log(
			[
				unlinked.length + unevaluated.length === 0
					? `${files.package} type checks with TypeScript 7, and its build's ${verified.imported.length} entry point(s) import in Node`
					: `${files.package} type checks with TypeScript 7; its build's ${verified.imported.length} entry point(s), probed in Node, report only for a browser facade, whose Vite bundle and browser tests judge it: ${imported} imported, ${unlinked.length} did not link, ${unevaluated.length} threw or did not settle while running`,
				...(unlinked.length === 0
					? []
					: ["did not link in Node, whose resolution is not its bundler's:", ...unlinked]),
				...(unevaluated.length === 0
					? []
					: ["linked in Node, then threw or did not settle while running:", ...unevaluated]),
			].join("\n"),
		);
		yield* printNotes(verified.notes);
	}),
).pipe(
	Command.withDescription(
		"Install the generated package, type check it, hold it to the standard, build it and import its entry points",
	),
);

const reconcileCommand = Command.make("reconcile", { packageName, out }, ({ packageName, out }) =>
	Effect.gen(function* () {
		const files = yield* targetFiles(out, packageName);
		const reconciled = yield* reconcile(files);
		yield* Console.log(
			`type checks after ${reconciled.rounds} round(s); overrides ${JSON.stringify(reconciled.overrides)}`,
		);
		if (Option.isSome(reconciled.restudy)) yield* Console.log(`note: ${reconciled.restudy.value}`);
		if (Option.isSome(reconciled.unwrapped)) yield* Console.log(`note: ${reconciled.unwrapped.value}`);
		yield* printNotes(reconciled.notes);
	}),
).pipe(
	Command.withDescription(
		"Generate and type check until the compiler agrees with the recipe, recording its overrides",
	),
);

const testCommand = Command.make("test", { packageName, out }, ({ packageName, out }) =>
	Effect.gen(function* () {
		const files = yield* targetFiles(out, packageName);
		const result = yield* test(files);
		yield* Console.log(result.output);
	}),
).pipe(Command.withDescription("Run the facade package's own tests"));

const driftCommand = Command.make(
	"drift",
	{
		before: Argument.String("before").pipe(Argument.withDescription("An older surface.json")),
		after: Argument.String("after").pipe(Argument.withDescription("A newer surface.json")),
	},
	({ before, after }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const read = (file: string) => fs.readFileString(file).pipe(Effect.flatMap(decodeSurface));
			yield* Console.log(driftMarkdown(drift(yield* read(before), yield* read(after))));
		}),
).pipe(Command.withDescription("Print what changed between two surfaces"));

const syncCommand = Command.make(
	"sync",
	{
		packageName: Argument.String("package").pipe(
			Argument.withDescription("A target's npm name; all targets when left out"),
			Argument.optional,
		),
		cache,
		out,
	},
	({ packageName, cache, out }) =>
		Effect.gen(function* () {
			const names = Option.isSome(packageName) ? [packageName.value] : yield* listTargets(out);
			for (const name of names) {
				const result = yield* sync(name, cache, out);
				yield* Console.log(
					result.kind === "current"
						? `${name}: ${result.version} is upstream's latest`
						: `${name}: ${result.from} -> ${result.to}, ${result.drift.changes.length} changes${result.drift.breaking ? " (breaking)" : ""}; regenerated, type checked and tested`,
				);
				if (result.kind === "updated") yield* printNotes(result.notes);
			}
		}),
).pipe(Command.withDescription("Bring targets to upstream's latest version: drift, redraft, reconcile and test"));

const planCommand = Command.make(
	"plan",
	{
		packageName,
		out,
		json: Flag.Boolean("json").pipe(
			Flag.withDescription("Print the plan as JSON, for an orchestrator"),
			Flag.withDefault(false),
		),
	},
	({ packageName, out, json }) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const files = yield* targetFiles(out, packageName);
			const surface = yield* fs.readFileString(files.surface).pipe(Effect.flatMap(decodeSurface));
			const recipe = yield* fs.readFileString(files.recipe).pipe(Effect.flatMap(decodeRecipe));
			const result = plan(surface, recipe, `${out}/${files.directory.split("/").at(-1)}`);
			yield* Console.log(json ? JSON.stringify(result, null, 2) : planMarkdown(result));
		}),
).pipe(Command.withDescription("Plan the judgment work on a target as units for coding agents (T3 orchestration)"));

const usagesCommand = Command.make(
	"usages",
	{
		directory: Argument.String("directory").pipe(Argument.withDescription("An application's source directory")),
		packageName,
	},
	({ directory, packageName }) =>
		Effect.gen(function* () {
			yield* Console.log(usagesMarkdown(packageName, yield* usages(directory, packageName)));
		}),
).pipe(
	Command.withDescription("List where an application uses a library, as a checklist for moving it onto the facade"),
);

const releaseCommand = Command.make(
	"release",
	{
		packageName: Argument.String("package").pipe(
			Argument.withDescription("A target's npm name; every target whose version is not released yet when left out"),
			Argument.optional,
		),
		out,
	},
	({ packageName, out }) =>
		Effect.gen(function* () {
			const names = Option.isSome(packageName) ? [packageName.value] : yield* listTargets(out);
			for (const name of names) {
				const files = yield* targetFiles(out, name);
				// Without a name, a released version is skipped: a release is never replaced, and CI runs this on every push.
				if (Option.isNone(packageName) && (yield* isReleased(files, process.cwd()))) continue;
				const released = yield* release(files, process.cwd());
				yield* Console.log(`released ${released.tag}: ${released.url}`);
			}
		}),
).pipe(Command.withDescription("Build, pack and release facades on GitHub (from a clean, pushed tree)"));

const makeCommand = Command.make("make", { target, cache, out, ui }, ({ target, cache, out, ui }) =>
	Effect.gen(function* () {
		const studied = yield* study(target, cache, out);
		yield* Console.log(surfaceSummary(studied.surface));
		const recipe = yield* draft(studied.surface, studied.scan, studied.readme, studied.files, ui);
		yield* Console.log(recipeSummary(recipe));
		const reconciled = yield* reconcile(studied.files);
		const overrides = Object.entries(reconciled.overrides);
		yield* Console.log(
			`generated into ${studied.files.package}; type checks after ${reconciled.rounds} round(s)${overrides.length === 0 ? "" : `, the compiler overrode ${overrides.map(([key, value]) => `${key}=${value}`).join(", ")}`}`,
		);
		yield* printNotes(reconciled.notes);
	}),
).pipe(Command.withDescription("Study, draft, generate and verify a target in one go"));

/**
 * Prints what tsrs, which follows TypeScript 7.1, rejects in a facade that TypeScript 7.0.2 compiles. It fails
 * nothing: the facade's users build with 7.0.2. Nothing is printed when there is none.
 */
function printNotes(notes: ReadonlyArray<string>) {
	return notes.length === 0
		? Effect.void
		: Console.log(
				[
					`TypeScript 7.1 notes from tsrs: ${notes.length}, not failing (TypeScript 7.0.2 compiles the facade)`,
					...notes.map((note) => `  ${note}`),
				].join("\n"),
			);
}

function surfaceSummary(surface: Surface): string {
	const handles = Object.values(surface.handles);
	const methods = handles.reduce((sum, handle) => sum + Object.keys(handle.methods).length, 0);
	const asyncCount = handles.reduce(
		(sum, handle) =>
			sum +
			Object.values(handle.methods).filter((signatures) => signatures.some((s) => s.traits.includes("async")))
				.length,
		0,
	);
	return `${surface.package}@${surface.version}: ${surface.exports.length} exports, ${handles.length} handles, ${methods} methods (${asyncCount} async), types ${surface.types.from}`;
}

function recipeSummary(recipe: Recipe): string {
	return [
		`recipe ${recipe.name}:`,
		`  exports  ${recipe.exports.join(", ")}`,
		`  handles  ${Object.entries(recipe.handles)
			.map(
				([name, handle]) =>
					`${name}${handle.release === undefined ? "" : `(${handle.release})`}${handle.events.length > 0 ? `[${handle.events.length} events]` : ""}`,
			)
			.join(", ")}`,
		`  errors   ${recipe.errors.map((error) => error.tag).join(", ")}`,
		`  services ${recipe.services.map((service) => `${service.name} <- ${service.acquire}`).join(", ") || "none"}`,
		`  decisions ${recipe.decisions.length} (${recipe.decisions.filter((decision) => decision.by === "engine").length} by the engine, to review)`,
	].join("\n");
}

const effectify = Command.make("effectify").pipe(
	Command.withDescription("The effectified engine: make a library Effect-native, and keep it so"),
	Command.withSubcommands([
		makeCommand,
		studyCommand,
		draftCommand,
		generateCommand,
		reconcileCommand,
		verifyCommand,
		testCommand,
		driftCommand,
		syncCommand,
		planCommand,
		usagesCommand,
		releaseCommand,
	]),
);

/** A failure as one line per field: tagged errors carry their reason in fields, which the default report leaves out. */
function report(error: unknown): string {
	if (typeof error !== "object" || error === null) return String(error);
	const { _tag, ...fields } = error as { _tag?: unknown } & Record<string, unknown>;
	// A list (each finding of a check) is one line per item.
	const lines = Object.entries(fields)
		.filter(([key]) => key !== "stack" && key !== "cause")
		.map(([key, value]) =>
			Array.isArray(value)
				? `  ${key}:\n${value.map((item) => `    ${String(item)}`).join("\n")}`
				: `  ${key}: ${String(value)}`,
		);
	return [`effectify failed: ${String(_tag ?? "error")}`, ...lines].join("\n");
}

effectify.pipe(
	Command.run({ version: ENGINE_VERSION }),
	Effect.tapError((error) => Console.error(report(error))),
	Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
	NodeRuntime.runMain,
);
