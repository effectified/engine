// What Node makes of a package at run time. A package's declarations may give a value its JavaScript does not have (a
// bundled `.d.ts` re-exporting another package's namespace, as puppeteer's `Session`; a CommonJS module whose named
// exports Node's lexer cannot see, as sharp's `block`), and a re-export of such a name fails the importing module as
// it loads. So `study` records which of upstream's exports Node cannot import by name (`importableNames`), and
// `verify` and `release` import every entry point of a built facade (`importFiles`): a runtime facade that builds and
// tests but cannot be imported, or whose import never settles, fails; a browser facade's import is a report, since a
// bundler, not Node, resolves it. Every probe runs in a process of its own within a deadline the engine keeps, and
// writes its results to a file of its own (`probeResults`): what the library prints is the library's, never a result.

import { Config, Duration, Effect, FileSystem, Option, Path, Record, Schema } from "effect";
import { type BoundedResult, runBounded, temporaryDirectory } from "./command.ts";

/**
 * Where a facade runs, so how it is imported: `node`, where any failure fails; `browser`, probed in Node, report only,
 * resolved roughly as a bundler resolves it (`BROWSER_HOOKS`: the `browser` condition of `exports`, a package's string
 * `browser` or its `module` entry over its `main`, as @xterm/xterm's UMD `main` hides its names from Node) with its
 * assets as empty modules. A browser facade ships as its bundler resolves it (a dependency's object-form `browser`
 * map, conditions, aliases), and its Vite bundle and its browser tests in Chrome check it, so nothing Node makes of it
 * fails: an error linking it is reported as `unlinked` (a name a module lacks here, a file or package not found, a
 * module that does not parse), one while its modules run, or an import that does not settle within the deadline, as
 * `unevaluated`, each with its message. `IMPORTS_SCRIPT` tells the two phases apart by when the error came, never by
 * its words or its module's source.
 */
export type Environment = "node" | "browser";

/** The files a bundler turns into modules of its own (styles, images, fonts): empty modules for a browser facade. */
const ASSETS = /\.(?:css|less|scss|svg|png|jpe?g|gif|webp|woff2?|ttf|otf)$/;

/**
 * Defines `hookBrowser()`, which makes Node resolve packages roughly as a bundler does for a browser: the `browser`
 * condition of `exports`, a package's string `browser` or its `module` entry over its `main` when it has no `exports`,
 * and assets as empty modules; not an object-form `browser` map, an alias or a plugin. `moduleNames` and `importFiles`
 * share it.
 */
const BROWSER_HOOKS = `import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
const bundled = (specifier, url) => {
	if (!/^(?:@[^/:]+\\/)?[^/:]+$/.test(specifier) || !url.startsWith("file:")) return undefined;
	for (let directory = new URL(".", url); ; directory = new URL("..", directory)) {
		const file = new URL("package.json", directory);
		const manifest = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
		if (manifest?.name === specifier) {
			const entry = manifest.exports === undefined ? (typeof manifest.browser === "string" ? manifest.browser : manifest.module) : undefined;
			return typeof entry === "string" ? new URL(entry, file).href : undefined;
		}
		if (new URL("..", directory).href === directory.href) return undefined;
	}
};
const assets = new RegExp(${JSON.stringify(ASSETS.source)});
const hookBrowser = () =>
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, { ...context, conditions: ["browser", "import", "module"] });
			const entry = bundled(specifier, resolved.url);
			return entry === undefined ? resolved : { ...resolved, url: entry, format: "module" };
		},
		load(url, context, nextLoad) {
			return assets.test(new URL(url).pathname) ? { format: "module", source: "export default {};", shortCircuit: true } : nextLoad(url, context);
		},
	});
`;

/**
 * The names Node can import by name from `specifier` in every build it resolves from `directory`: under Node's
 * conditions and under a browser's (`moduleNames`), those both give when both import, since a facade re-exporting a
 * name one build lacks fails wherever that build runs; else those of the one that imports; none when neither does.
 */
export const importableNames = Effect.fn("importableNames")(function* (directory: string, specifier: string) {
	const [node, browser] = yield* Effect.all(
		[moduleNames(directory, specifier, "node"), moduleNames(directory, specifier, "browser")],
		{ concurrency: 2 },
	);
	if (Option.isNone(node)) return browser;
	if (Option.isNone(browser)) return node;
	const both = new Set(browser.value);
	return Option.some(node.value.filter((name) => both.has(name)));
});

/**
 * The names the module `specifier` gives when Node imports it from `directory` in `environment`, sorted; none when it
 * cannot be imported there (a library that needs a browser's globals as it loads, or ends the process first).
 * Importing runs the target library's own code (`runBounded`): in a Node process of its own, with only `PATH` and
 * `HOME` of the engine's environment (no `NODE_OPTIONS`), under Node's permission model (`permissions`), and within
 * `deadline`, which the engine keeps: past it the process group is killed and the call fails (`CommandDeadlineError`),
 * and `study` with it. The names come from the probe's results file, whatever the library prints as it loads.
 */
export const moduleNames = Effect.fn("moduleNames")(function* (
	directory: string,
	specifier: string,
	environment: Environment,
	deadline: Duration.Input = NAMES_DEADLINE,
) {
	const results = yield* probeResults;
	yield* runBounded(
		"node",
		[...permissions(results), "--input-type=module", "--eval", NAMES_SCRIPT, results, environment, specifier],
		directory,
		{ deadline, env: yield* bareEnvironment },
	);
	// The process writes its record only once the import settled: without one, the module did not import.
	const [record] = yield* settledRecords(results);
	if (record === undefined) return Option.none<ReadonlyArray<string>>();
	// Trust boundary: a file the child wrote.
	return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(record).pipe(Effect.option);
}, Effect.scoped);

/**
 * The environment `study` imports upstream in: only `PATH` and `HOME` of the engine's, so a token or `NODE_OPTIONS` in
 * the engine's never reaches a library the maintainer only intends to wrap.
 */
const bareEnvironment = Effect.gen(function* () {
	return {
		PATH: yield* Config.String("PATH").pipe(Config.withDefault("")),
		HOME: yield* Config.String("HOME").pipe(Config.withDefault("")),
	};
});

/** How long importing upstream may take in `study`: a large library loads in a few seconds. */
const NAMES_DEADLINE = "60 seconds";

/**
 * Node's permission model for the import: files read, only the results file written, no child process or worker, so
 * an ordinary library leaves no process behind when the deadline kills the import. Native addons are allowed, since
 * sharp's is its library, and the model governs only JavaScript: hygiene against accidents, not a sandbox (see
 * `runBounded`). Node matches the grant against the path as the process writes it, symbolic links unresolved (macOS's
 * temporary directory is one), so the grant is that very path.
 */
function permissions(results: string): ReadonlyArray<string> {
	return ["--permission", "--allow-fs-read=*", `--allow-fs-write=${results}`, "--allow-addons"];
}

/**
 * Imports the module named on its command line, as `environment` resolves it, appends its namespace's keys to the
 * results file, and exits: what the library left running (a timer, a socket) would hold the process to the deadline.
 */
const NAMES_SCRIPT = `import { appendFileSync } from "node:fs";
${BROWSER_HOOKS}
const [results, environment, specifier] = process.argv.slice(1);
if (environment === "browser") hookBrowser();
const namespace = await import(specifier);
appendFileSync(results, JSON.stringify(Object.keys(namespace).sort()) + "\\n");
process.exit(0);
`;

/**
 * An empty file for a probe's results, in a temporary directory of its own that the scope removes, named to the
 * probe's process as an argument. The process appends one newline-terminated JSON record per result, with a
 * synchronous write, as each settles: what it wrote is on disk however the process ends (an exit, a crash, the
 * deadline's kill), and nothing the library prints, on stdout or stderr, is read as a result.
 */
const probeResults = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const file = path.join(yield* temporaryDirectory("effectified-probe-"), "results.jsonl");
	yield* fs.writeFileString(file, "");
	return file;
});

/**
 * The records a probe's process appended to `file`, in order, read once it ended: a last record without its newline,
 * cut short as the process ended, is none.
 */
const settledRecords = Effect.fn("settledRecords")(function* (file: string) {
	const fs = yield* FileSystem.FileSystem;
	return (yield* fs.readFileString(file)).split("\n").slice(0, -1);
});

/**
 * What importing one entry point in Node did: imported; for a runtime facade, failed, which fails `verify` and
 * `release`; for a browser facade, reports that fail nothing: Node could not link it (`unlinked`), or it linked and
 * then threw while its modules ran or did not settle within the deadline (`unevaluated`), each with its message.
 */
export const Imported = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("imported"), file: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("failed"), file: Schema.String, message: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("unlinked"), file: Schema.String, message: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("unevaluated"), file: Schema.String, message: Schema.String }),
]);
export type Imported = typeof Imported.Type;

/**
 * Imports each of `files` (absolute) in order in one Node process run in `directory`, as a facade running in
 * `environment`, within `deadline` (else `importsDeadline`), which the engine keeps (`runBounded`: past it the process
 * group is killed). The process has the engine's whole environment, as the facade's tests run: it imports the code they
 * run, and an entry point that reads a setting as it loads imports as it does for its user. An import whose module
 * awaits what never settles while something keeps Node's event loop alive (a timer, a socket), or that blocks the loop,
 * holds the process open, and only a deadline the engine keeps ends it. The process records each file's result in its
 * results file as it settles (`probeResults`), so however it ends, every file recorded keeps its result, and only the
 * others, the one that did not settle and those after it, which never ran, have none: "did not settle" past the
 * deadline, the exit code or the signal when the process ended first (with the end of what it printed); failed for a
 * runtime facade, since an import that never settles is a defect where it runs, `unevaluated` for a browser facade. No
 * file is imported again alone: one may import only after an earlier one ran (a registration of shared state), as in
 * the process its user's bundle or tests load.
 */
export const importFiles = Effect.fn("importFiles")(function* (
	directory: string,
	files: ReadonlyArray<string>,
	environment: Environment,
	deadline?: Duration.Input,
) {
	if (files.length === 0) return [];
	const bound = deadline ?? (yield* importsDeadline);
	const results = yield* probeResults;
	const run = yield* runBounded(
		"node",
		["--input-type=module", "--eval", IMPORTS_SCRIPT, results, environment, ...files],
		directory,
		{ deadline: bound },
	).pipe(
		Effect.map((result): ProbeRun => result),
		Effect.catchTag("CommandDeadlineError", () => Effect.succeed<ProbeRun>({ kind: "deadline" })),
	);
	const recorded = new Map<string, Imported>();
	for (const record of yield* settledRecords(results)) {
		// Trust boundary: a file the child wrote.
		const entry = yield* Schema.decodeEffect(Schema.fromJsonString(Imported))(record).pipe(Effect.option);
		if (Option.isSome(entry)) recorded.set(entry.value.file, entry.value);
	}
	const unrecorded = environment === "node" ? "failed" : "unevaluated";
	const message = unsettled(run, bound);
	return files.map((file): Imported => recorded.get(file) ?? { kind: unrecorded, file, message });
}, Effect.scoped);

/** How the import probe's process ended: as `runBounded` reports it (an exit or a signal), or killed at the deadline. */
type ProbeRun = BoundedResult | { readonly kind: "deadline" };

/**
 * Why a file has no result: the deadline passed before it settled, or the process ended first, by an exit (the probe
 * exits only once every file settled, so an entry point's own code exited) or by a signal, with the end of what it
 * printed as context.
 */
function unsettled(run: ProbeRun, deadline: Duration.Input): string {
	switch (run.kind) {
		case "deadline":
			return `did not settle within ${Duration.toSeconds(deadline)} s`;
		case "exited":
			return `the process exited with code ${run.exitCode} before this entry settled${printedContext(run.output)}`;
		case "signalled":
			return `a signal ended the process before this entry settled: ${run.reason}${printedContext(run.output)}`;
	}
}

/** The end of what the probe's process printed, as a failure's context: its last lines, at most `CONTEXT` characters. */
function printedContext(output: string): string {
	const tail = output.trim().split("\n").slice(-5).join(" ").slice(-CONTEXT);
	return tail.length === 0 ? "" : `; it printed: ${tail}`;
}

/** How much of what the probe's process printed a failure keeps: a library may print megabytes as it loads. */
const CONTEXT = 500;

/**
 * How long the import probe of a built facade may take: `EFFECTIFY_IMPORTS_DEADLINE` seconds, else 120. The slowest
 * of the 15 facades, Web Awesome's 79 entry points in one process, takes under a second, but an entry point may load
 * slowly where it imports fine for its user (one took 31 s), and a hanging import costs the deadline once.
 */
const importsDeadline = Config.schema(
	// Trust boundary: the user's environment.
	Schema.Finite.check(Schema.isGreaterThan(0)),
	"EFFECTIFY_IMPORTS_DEADLINE",
).pipe(Config.withDefault(120), Config.map(Duration.seconds));

/** The key (`Symbol.for`) of the global `IMPORTS_SCRIPT` sets once an import's modules start to run. */
const EVALUATING = "@effectified/evaluating";

/**
 * Imports the files on its command line one by one, in order, and appends each one's result to the results file as it
 * settles (`probeResults`), so a deadline that kills it, or an exit, leaves the results of the files that settled
 * before; it exits once all settled, whatever they left running. For a browser facade, packages resolve roughly as a
 * bundler resolves them, and a failure is reported as `unlinked` when it came as modules linked, `unevaluated` when it
 * came while they ran. Node links an import's whole module graph (resolves, loads, parses, matches every imported
 * name) before it runs any module, and then runs them dependencies first, in import order. So each file is imported
 * through a module that first imports one that marks the run as started (`EVALUATING`): a failure before the mark is
 * set is a link error, one after it an error while running, a CommonJS module's too, which Node runs then. Each file's
 * marker is a module of its own, so it runs again; a module that failed as an earlier file ran throws again as this one
 * runs, after the mark. A module's own top-level `await import()` links its graph while the module runs: what fails
 * there is `unevaluated`, as any error then.
 */
const IMPORTS_SCRIPT = `import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
${BROWSER_HOOKS}
const [results, environment, ...files] = process.argv.slice(1);
if (environment === "browser") hookBrowser();
const evaluating = Symbol.for(${JSON.stringify(EVALUATING)});
const report = (entry) => appendFileSync(results, JSON.stringify(entry) + "\\n");
for (const [index, file] of files.entries()) {
	globalThis[evaluating] = false;
	const started = "data:text/javascript," + encodeURIComponent("globalThis[Symbol.for(" + JSON.stringify(${JSON.stringify(EVALUATING)}) + ")] = true; // " + index);
	const imported = "import " + JSON.stringify(started) + ";\\nimport " + JSON.stringify(pathToFileURL(file).href) + ";\\n";
	try {
		await import("data:text/javascript," + encodeURIComponent(imported));
		report({ kind: "imported", file });
	} catch (error) {
		const message = String(error instanceof Error ? error.message : error).split("\\n")[0];
		report({ kind: environment === "node" ? "failed" : globalThis[evaluating] === true ? "unevaluated" : "unlinked", file, message });
	}
}
process.exit(0);
`;

/** A package's `exports` names an entry point it does not have: a wildcard no file matches. */
export class EntryPointError extends Schema.TaggedError<EntryPointError, { readonly brand: unique symbol }>()(
	"EntryPointError",
	{
		reason: Schema.String,
	},
) {}

/**
 * Every file a package's `exports` (else its `main`) lets an importer reach, absolute and sorted: each subpath's
 * `import` (or `default`) target, a `*` expanded to the files it matches, as Node matches it (across directories). A
 * wildcard that matches no file fails (`EntryPointError`): the package promises entry points its release lacks.
 */
export const entryFiles = Effect.fn("entryFiles")(function* (packageDirectory: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	// Trust boundary: a file.
	const manifest = yield* fs
		.readFileString(path.join(packageDirectory, "package.json"))
		.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Manifest))));
	const exported = manifest.exports ?? manifest.main ?? "./index.js";
	const targets = (typeof exported === "string" ? [exported] : Record.values(exported)).flatMap((target) => {
		const file = typeof target === "string" ? target : (target.import ?? target.default);
		return file === undefined ? [] : [file];
	});
	const found = new Set<string>();
	for (const written of targets) {
		const target = path.normalize(written);
		const star = target.indexOf("*");
		if (star === -1) {
			found.add(path.join(packageDirectory, target));
			continue;
		}
		const [prefix, suffix] = [target.slice(0, star), target.slice(star + 1)];
		const base = path.join(packageDirectory, path.dirname(`${prefix}x`));
		const files = (yield* fs.exists(base)) ? yield* fs.readDirectory(base, { recursive: true }) : [];
		const matched = files
			.map((file) => path.relative(packageDirectory, path.join(base, file)))
			.filter(
				(relative) =>
					relative.startsWith(prefix) &&
					relative.endsWith(suffix) &&
					relative.length >= prefix.length + suffix.length,
			);
		if (matched.length === 0)
			return yield* new EntryPointError({ reason: `exports target ${written} matches no file` });
		for (const relative of matched) found.add(path.join(packageDirectory, relative));
	}
	return [...found].sort();
});

/** One subpath's target in a package's `exports`: a path, or conditions of which the importer's are `import` and `default`. */
const ExportTarget = Schema.Union([
	Schema.String,
	Schema.Struct({ import: Schema.optional(Schema.String), default: Schema.optional(Schema.String) }),
]);

/** A package.json as far as its entry points go. */
const Manifest = Schema.Struct({
	main: Schema.optional(Schema.String),
	exports: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, ExportTarget)])),
});
