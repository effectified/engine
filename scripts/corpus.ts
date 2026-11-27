// The regression corpus: popular libraries no facade of effectified/packages wraps, each made (`make`) and checked
// (`verify`) with the released engine and with this checkout, one after the other. The release checks of 0.4.0 each
// found one more library 0.3.0 made and the candidate rejected; the corpus tries them all at once. A step counts as
// passed only with evidence that it finished (`ranStep`), and a library the released engine passes and the checkout
// fails fails the run, unless the changelog announces that failure, in its step (`announced`). Run it before a release:
// `pnpm corpus` (`--tag <v...>` for another released engine than the latest, `--root <dir>` for another scratch
// directory than `.cache/corpus`).

import { randomUUID } from "node:crypto";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { runCommand } from "../src/command.ts";
import { ENGINE_VERSION } from "../src/generate.ts";

/** A step of a library's run: `make`, `verify`, and the corpus's program (`use`). */
type StepName = "make" | "verify" | "use";

/** A library of the corpus, at an exact version. */
interface Library {
	readonly name: string;
	readonly version: string;
	/** A failure of the checkout's where the released engine passed, which the changelog announces. */
	readonly announced?: Announced;
	/**
	 * A program of the corpus that uses its facade, a file of `scripts/corpus/`: `verify` compiles it as one of the
	 * facade's tests, and Node then runs it, which fails on a wrong result and prints `USE_FINISHED` and its run's token
	 * (`TOKEN_VARIABLE`) as its last act.
	 */
	readonly use?: string;
}

/**
 * A change the changelog announces, for `reason`: the checkout fails `step`, printing what `message` matches. Any other
 * failure of the checkout's, in another step or with another message, is a regression.
 */
interface Announced {
	readonly step: StepName;
	readonly message: RegExp;
	readonly reason: string;
}

/** The corpus: popular libraries of several shapes (trees, streams, clients, builders, CommonJS), none a target. */
export const LIBRARIES: ReadonlyArray<Library> = [
	{ name: "postcss", version: "8.5.33" },
	{ name: "cheerio", version: "1.2.0", use: "cheerio.ts" },
	{ name: "ts-morph", version: "28.0.0" },
	{
		name: "protobufjs",
		version: "7.5.4",
		announced: {
			step: "verify",
			// The import check's report (`importBuilt`) of an entry point that throws as it loads: the facade reads a
			// member of an export Node gives as `undefined`.
			message: /^ {2}step: import\n {2}reason: .+\.js: Cannot read properties of undefined \(reading '[^']+'\)$/m,
			reason:
				"0.4.0's `verify` imports every entry point of the build in Node, and protobufjs's CommonJS module gives Node only `default`: the facade's `Root`, `Type`, `Field` and `load` throw as it loads, which 0.3.0's `verify` never saw (CHANGELOG.md, 0.4.0, For engine users)",
		},
	},
	{ name: "css-tree", version: "3.1.0" },
	{ name: "ioredis", version: "6.1.0" },
	{ name: "pg", version: "8.23.1" },
	{ name: "ws", version: "8.23.0" },
	{ name: "commander", version: "15.1.0" },
	{ name: "yaml", version: "2.9.1" },
	{ name: "undici", version: "8.13.1" },
	{ name: "mongodb", version: "7.9.1" },
	{ name: "socket.io-client", version: "4.8.4" },
	{ name: "playwright-core", version: "1.55.0" },
	{ name: "jsdom", version: "26.1.0" },
	{ name: "archiver", version: "7.0.1" },
	{ name: "node-cron", version: "4.2.1" },
];

/**
 * What a corpus program prints as its last act, followed by a space and its run's token (`TOKEN_VARIABLE`), alone on a
 * line of its stdout: its `use` step passes only once it printed that line, since an async program whose work never
 * settles exits with 0 too, having printed nothing.
 */
export const USE_FINISHED = "corpus: finished";

/**
 * The environment variable that gives a corpus program its run's token, made afresh for each run: a library that
 * prints `corpus: finished` as it loads or runs, and leaves the program's work pending, passes nothing. Evidence
 * against accidents, not a guard: the library runs in the program's process and could read the variable.
 */
export const TOKEN_VARIABLE = "EFFECTIFY_CORPUS_TOKEN";

/** The corpus could not run, or the checkout fails a library the released engine passes. */
class CorpusError extends Schema.TaggedError<CorpusError, { readonly brand: unique symbol }>()("CorpusError", {
	reason: Schema.String,
}) {}

/** A step that ran: `ok` with evidence that it finished, else `failed`, with what it printed either way. */
type Ran = { readonly kind: "ok"; readonly output: string } | { readonly kind: "failed"; readonly output: string };

/**
 * What shows that a step ran to its end: a line of its output that starts with `start` (`line`: the engine's own last
 * line, which names a path and a time), or a whole line of its stdout that is `USE_FINISHED`, a space and `token`,
 * which the step is given in `TOKEN_VARIABLE` (`marker`: a corpus program's).
 */
export type Evidence =
	| { readonly kind: "line"; readonly start: string }
	| { readonly kind: "marker"; readonly token: string };

/** How one step of a library went with one engine: it ran, it was `skipped` after a step before it failed, or it is `none`, a `use` without a program. */
type Step = Ran | { readonly kind: "skipped" } | { readonly kind: "none" };

const SKIPPED: Step = { kind: "skipped" };

const NONE: Step = { kind: "none" };

/** How one engine did with one library: `make`, `verify`, and the corpus's program. */
export interface Outcome {
	readonly make: Step;
	readonly verify: Step;
	readonly use: Step;
}

/** An engine the corpus runs: its command line, and the directory its facades are made in. */
interface Engine {
	readonly name: "released" | "checkout";
	readonly bin: string;
	readonly directory: string;
}

/** Runs the corpus with the released engine `tag` (the latest `v*` tag when none) and the checkout, under `root`. */
const corpus = Effect.fn("corpus")(function* (tag: Option.Option<string>, root: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const checkout = path.resolve(import.meta.dirname, "..");
	const scratch = path.resolve(checkout, root);
	const released = Option.isSome(tag) ? tag.value : yield* latestTag(checkout);
	const worktree = yield* releasedEngine(checkout, scratch, released);
	const before: Engine = {
		name: "released",
		bin: path.join(worktree, "src", "bin.ts"),
		directory: path.join(scratch, "released"),
	};
	const after: Engine = {
		name: "checkout",
		bin: path.join(checkout, "src", "bin.ts"),
		directory: path.join(scratch, "checkout"),
	};
	const logs = path.join(scratch, "logs");
	yield* fs.makeDirectory(logs, { recursive: true });
	const rows: Array<Row> = [];
	for (const library of LIBRARIES) {
		const row = {
			library,
			released: yield* tried(library, before, logs),
			checkout: yield* tried(library, after, logs),
		};
		rows.push(row);
		yield* Console.log(`${spec(library)}: ${verdict(row)}`);
	}
	yield* Console.log(`\n${table(rows, released)}\n\nlogs: ${logs}`);
	const regressed = rows.filter((row) => verdict(row) === "REGRESSION");
	if (regressed.length > 0)
		return yield* new CorpusError({
			reason: `the checkout fails what ${released} passes, unannounced: ${regressed.map((row) => spec(row.library)).join(", ")}`,
		});
});

/** The newest release of the engine: its tags `v<version>`, by version. */
const latestTag = Effect.fn("latestTag")(function* (checkout: string) {
	const listed = yield* runCommand("git", ["tag", "--list", "v*", "--sort=-v:refname"], checkout);
	const newest = listed.output.split("\n")[0]?.trim() ?? "";
	if (listed.exitCode !== 0 || newest === "")
		return yield* new CorpusError({ reason: `no release tag (v*) in ${checkout}: ${listed.output}` });
	return newest;
});

/**
 * A worktree of the checkout at `tag` under `scratch`, its dependencies installed, removed with the scope. A worktree
 * already at that path (a run killed before it removed its own) stops the run: the corpus removes only what it made.
 */
const releasedEngine = Effect.fn("releasedEngine")(function* (checkout: string, scratch: string, tag: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = path.join(scratch, `engine-${tag}`);
	if (yield* fs.exists(directory))
		return yield* new CorpusError({
			reason: `${directory} exists: remove it (\`git worktree remove --force ${directory}\`) and run again`,
		});
	yield* fs.makeDirectory(scratch, { recursive: true });
	yield* Effect.acquireRelease(succeeded("git", ["worktree", "add", "--detach", directory, tag], checkout), () =>
		Effect.ignore(runCommand("git", ["worktree", "remove", "--force", directory], checkout)),
	);
	yield* succeeded("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], directory);
	return directory;
});

/** Runs a command the corpus needs, failing the run unless it exits with 0. */
const succeeded = Effect.fn("succeeded")(function* (command: string, args: ReadonlyArray<string>, cwd: string) {
	const result = yield* runCommand(command, args, cwd);
	if (result.exitCode !== 0)
		return yield* new CorpusError({ reason: `${[command, ...args].join(" ")} failed:\n${result.output}` });
});

/**
 * Makes `library` with `engine`, copies the corpus's program into the facade's tests, verifies it and runs the
 * program; writes what each step printed to `<logs>/<engine>-<directory>.log`. Each step passes only with the line it
 * prints as it finishes: an engine's own last line for `make` and `verify` (0.3.0's too), `USE_FINISHED` with a token
 * made for that run for the program. The library's installs, the facade's and the one `study` made, are removed as its
 * run ends, whatever it gave.
 */
const tried = Effect.fn("tried")(function* (library: Library, engine: Engine, logs: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	// As `targetFiles` names a target's directory.
	const directory = library.name.replace(/^@/, "").replace("/", "__");
	const facade = path.join(engine.directory, "targets", directory, "package");
	const printed: Array<string> = [];
	const step = (args: ReadonlyArray<string>, cwd: string, evidence: Evidence) =>
		ranStep(args, cwd, evidence).pipe(
			Effect.tap((ran) => Effect.sync(() => printed.push(`$ node ${args.join(" ")}\n${ran.output}`))),
		);
	const run = Effect.gen(function* () {
		yield* fs.makeDirectory(engine.directory, { recursive: true });
		const unused = library.use === undefined ? NONE : SKIPPED;
		const made = yield* step([engine.bin, "make", spec(library)], engine.directory, {
			kind: "line",
			start: `generated into ${facade}; type checks after `,
		});
		if (made.kind === "failed") return { make: made, verify: SKIPPED, use: unused } satisfies Outcome;
		if (library.use !== undefined) {
			yield* fs.makeDirectory(path.join(facade, "test"), { recursive: true });
			yield* fs.copyFile(
				path.join(import.meta.dirname, "corpus", library.use),
				path.join(facade, "test", "corpus.ts"),
			);
		}
		const verified = yield* step([engine.bin, "verify", library.name], engine.directory, {
			kind: "line",
			start: `${facade} type checks with TypeScript 7`,
		});
		if (library.use === undefined || verified.kind === "failed")
			return { make: made, verify: verified, use: unused } satisfies Outcome;
		return {
			make: made,
			verify: verified,
			use: yield* step(["test/corpus.ts"], facade, { kind: "marker", token: randomUUID() }),
		} satisfies Outcome;
	});
	// What takes the space is a library's installs: none outlives its run. The log is what the steps printed by then.
	const cleaned = Effect.all([
		Effect.suspend(() => fs.writeFileString(path.join(logs, `${engine.name}-${directory}.log`), printed.join("\n"))),
		fs.remove(path.join(engine.directory, "targets", directory), { recursive: true, force: true }),
		fs.remove(path.join(engine.directory, ".cache"), { recursive: true, force: true }),
	]);
	return yield* run.pipe(Effect.ensuring(Effect.orDie(cleaned)));
});

/**
 * Runs `node <args>` in `cwd` as a step of the corpus: `ok` only when it exits with 0 and prints its `evidence` that it
 * ran to its end, since exiting with 0 is none (an async program whose work never settles exits so, having printed
 * nothing); else `failed`, a signal that ended it too.
 */
export const ranStep = Effect.fn("ranStep")(function* (args: ReadonlyArray<string>, cwd: string, evidence: Evidence) {
	const env = evidence.kind === "marker" ? { [TOKEN_VARIABLE]: evidence.token } : undefined;
	return yield* runCommand("node", args, cwd, env).pipe(
		Effect.map(({ exitCode, output, stdout }): Ran => ({
			kind: exitCode === 0 && finished(evidence, output, stdout) ? "ok" : "failed",
			output,
		})),
		// A signal ended the command: the step failed, and the library's run goes on to the next.
		Effect.catchTag("CommandError", (error) => Effect.succeed<Ran>({ kind: "failed", output: error.reason })),
	);
});

/** Whether a step printed its `evidence`: in its `output` (stdout and stderr), or on its `stdout` alone. */
function finished(evidence: Evidence, output: string, stdout: string): boolean {
	switch (evidence.kind) {
		case "line":
			return output.split("\n").some((line) => line.startsWith(evidence.start));
		case "marker":
			return stdout.split("\n").includes(`${USE_FINISHED} ${evidence.token}`);
	}
}

/** `<name>@<version>`, as `make` takes a library. */
function spec(library: Library): string {
	return `${library.name}@${library.version}`;
}

/** One library's outcomes with both engines. */
interface Row {
	readonly library: Library;
	readonly released: Outcome;
	readonly checkout: Outcome;
}

/**
 * What the checkout did to a library the released engine made: `same` (both pass, or both fail), `fixed` (only the
 * checkout passes), `REGRESSION` (only the released engine passes), or `announced` for the failure the changelog
 * announces, in its step and with its message.
 */
export function verdict(row: Row): string {
	const before = passed(row.released);
	const after = passed(row.checkout);
	if (before === after) return before ? "same" : "same (both fail)";
	if (after) return "fixed";
	const { announced } = row.library;
	const failed = announced === undefined ? undefined : row.checkout[announced.step];
	return announced !== undefined && failed?.kind === "failed" && announced.message.test(failed.output)
		? `announced: ${announced.reason}`
		: "REGRESSION";
}

/** Whether an engine made the library, verified it, and ran its program when it has one. */
function passed(outcome: Outcome): boolean {
	return (
		outcome.make.kind === "ok" &&
		outcome.verify.kind === "ok" &&
		(outcome.use.kind === "ok" || outcome.use.kind === "none")
	);
}

/** The results as a table: a row per library, each engine's steps, and the verdict. */
function table(rows: ReadonlyArray<Row>, released: string): string {
	const steps = (outcome: Outcome) =>
		`make ${outcome.make.kind}, verify ${outcome.verify.kind}${outcome.use.kind === "none" ? "" : `, use ${outcome.use.kind}`}`;
	const lines = [
		["library", `released (${released})`, `checkout (${ENGINE_VERSION})`, "verdict"],
		...rows.map((row) => [spec(row.library), steps(row.released), steps(row.checkout), verdict(row)]),
	];
	const widths = [0, 1, 2].map((column) => Math.max(...lines.map((line) => line[column]?.length ?? 0)));
	return lines
		.map((line) =>
			line
				.map((cell, column) => cell.padEnd(widths[column] ?? 0))
				.join("  ")
				.trimEnd(),
		)
		.join("\n");
}

const tag = Flag.String("tag").pipe(
	Flag.withDescription("The released engine to compare with, a tag `v<version>` (default: the latest)"),
	Flag.optional,
);
const root = Flag.String("root").pipe(
	Flag.withDescription("The scratch directory, relative to the checkout (logs stay there; installs do not)"),
	Flag.withDefault(".cache/corpus"),
);

// Run as a script (`pnpm corpus`); test/corpus.test.ts imports the judgment above without running the corpus.
if (import.meta.main)
	Command.make("corpus", { tag, root }, ({ tag, root }) => Effect.scoped(corpus(tag, root))).pipe(
		Command.withDescription(
			"Make and verify the corpus's libraries with the released engine and this checkout; fail on a regression",
		),
		Command.run({ version: ENGINE_VERSION }),
		// A tagged error's reason is a field, which the default report leaves out.
		Effect.tapErrorTag("CorpusError", (error) => Console.error(`corpus failed: ${error.reason}`)),
		Effect.provide(NodeServices.layer),
		NodeRuntime.runMain,
	);
