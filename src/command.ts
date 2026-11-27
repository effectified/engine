// Running an external command (npm, tsc, git) and keeping everything it printed, whatever its exit code: the engine
// reports a failing install or type check with the tool's own words. `study` imports the target library through
// `runBounded`, which runs the target library's own code, the code its tests run, with the user's rights: study only on
// a library you would install. Its deadline and environment are hygiene against accidents, not a sandbox. `verify` and
// `release` import a built facade through it too, in the engine's whole environment, as the facade's tests run. Every
// temporary path the engine names to a command is absolute (`temporaryDirectory`).

import { Duration, Effect, Fiber, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/**
 * A temporary directory the scope removes, as an absolute path. Node makes it under `TMPDIR` as given, and a relative
 * one resolves against the engine's directory: a command run in another directory would find nothing at that path.
 */
export const temporaryDirectory = Effect.fn("temporaryDirectory")(function* (prefix?: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	return path.resolve(yield* fs.makeTempDirectoryScoped(prefix === undefined ? undefined : { prefix }));
});

/** A command could not be started. */
export class CommandError extends Schema.TaggedError<CommandError, { readonly brand: unique symbol }>()(
	"CommandError",
	{
		command: Schema.String,
		reason: Schema.String,
	},
) {}

/**
 * A bounded command ran past its deadline: it and every process it started were killed. `output` is what it printed
 * until then, its stdout and stderr interleaved as printed.
 */
export class CommandDeadlineError extends Schema.TaggedError<CommandDeadlineError, { readonly brand: unique symbol }>()(
	"CommandDeadlineError",
	{
		command: Schema.String,
		deadline: Schema.String,
		output: Schema.String,
	},
) {}

/** What a finished command left: its exit code, its stdout and stderr interleaved as printed, and its stdout alone. */
export interface CommandResult {
	readonly exitCode: number;
	readonly output: string;
	readonly stdout: string;
}

/**
 * How a bounded command ended, with its stdout and stderr interleaved as printed, and its stdout alone: it exited with
 * its code, or a signal ended it (`reason`, the spawner's words, which name the signal).
 */
export type BoundedResult =
	| { readonly kind: "exited"; readonly exitCode: number; readonly output: string; readonly stdout: string }
	| { readonly kind: "signalled"; readonly reason: string; readonly output: string; readonly stdout: string };

/**
 * Runs `command args` in `cwd` to completion: until it exited and its output ended, which a worker it started (npm's,
 * tsc's) may still print to. A signal that ends it fails the run at once (`CommandError`), whatever a worker still
 * holding its output prints after. `env` adds variables to the engine's environment, which the command has.
 */
export const runCommand = Effect.fn("runCommand")(function* (
	command: string,
	args: ReadonlyArray<string>,
	cwd: string,
	env?: Readonly<Record<string, string>>,
) {
	const options = env === undefined ? { cwd } : { cwd, env: { ...env }, extendEnv: true };
	const result = yield* spawned(command, args, options, [], "output");
	if (result.kind === "signalled")
		return yield* new CommandError({ command: [command, ...args].join(" "), reason: result.reason });
	return { exitCode: result.exitCode, output: result.output, stdout: result.stdout } satisfies CommandResult;
});

/**
 * How `runBounded` bounds a command: against accidents (a hang, a process left running, an inherited token), not
 * against code set on harm, which runs with the user's rights.
 */
export interface Bounds {
	/** How long it may run; the engine keeps the time, so a command blocking its own event loop cannot outlast it. */
	readonly deadline: Duration.Input;
	/** The command's whole environment, in place of the engine's; without it, the command has the engine's. */
	readonly env?: Readonly<Record<string, string>>;
}

/**
 * Runs `command args` in `cwd` to completion within `bounds`: in the environment they give, and leading a process
 * group of its own, which is killed (`SIGKILL` to the negative pid) when the deadline passes, a descendant still in the
 * group too; the run then fails with `CommandDeadlineError`, which keeps what the command printed until then. Before
 * the deadline it ends as the command did: exited with its code, or ended by a signal, even while a process it started
 * holds its output open, which is killed with the group then (`spawned`'s `"exit"`). It is not a sandbox: a process
 * that leaves the group, or native code, is beyond it. `study` uses it to import the target library, which runs the
 * target library's own code: study only on a library you would install.
 */
export const runBounded = Effect.fn("runBounded")(function* (
	command: string,
	args: ReadonlyArray<string>,
	cwd: string,
	bounds: Bounds,
) {
	// Outside the run, so that what it printed is still at hand once the deadline interrupted it.
	const printed: Array<string> = [];
	const run = spawned(
		command,
		args,
		{
			cwd,
			detached: true,
			killSignal: "SIGKILL",
			env: bounds.env === undefined ? undefined : { ...bounds.env },
			extendEnv: false,
		},
		printed,
		"exit",
	);
	// The run is interrupted first, its scope closed and its process group killed, and only then the failure made.
	return yield* run.pipe(
		Effect.timeoutOrElse({
			duration: bounds.deadline,
			orElse: () =>
				Effect.fail(
					new CommandDeadlineError({
						command,
						deadline: Duration.format(Duration.fromInputUnsafe(bounds.deadline)),
						output: printed.join(""),
					}),
				),
		}),
	);
});

/**
 * When a run ends once its command exited, since a process it started with its output inherited may still hold that
 * output: when the output ends (`"output"`: an ordinary command's, whose workers, npm's or tsc's, may print after it
 * exited; but at once, with what it printed so far, when a signal ended it, since nothing then says its workers will
 * ever let go of the output), or at once (`"exit"`: the import probe's, whose helper may hold the output open for
 * good), its process group ended as the scope's close ends it (`killSignal`, a helper still in the group too) and what
 * is left of its output read until it ends, for at most `DRAIN`.
 */
type RunEnd = "output" | "exit";

/**
 * Spawns a command and waits for it to exit, keeping all it printed, each piece pushed onto `printed` as it arrives,
 * and its stdout alone, and ends the run as `end` says; leaving the scope before it exits kills it.
 */
function spawned(
	command: string,
	args: ReadonlyArray<string>,
	options: ChildProcess.CommandOptions,
	printed: Array<string>,
	end: RunEnd,
): Effect.Effect<BoundedResult, CommandError, ChildProcessSpawner.ChildProcessSpawner> {
	const label = [command, ...args].join(" ");
	return Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], options));
			// Both streams merged as the spawner's `all` merges them, each decoded on its own: a character split between two
			// chunks of one stream is never broken by a chunk of the other.
			const written: Array<string> = [];
			const stdout = Stream.map(Stream.decodeText(handle.stdout), (text) => ({ from: "stdout" as const, text }));
			const stderr = Stream.map(Stream.decodeText(handle.stderr), (text) => ({ from: "stderr" as const, text }));
			const reading = yield* Stream.merge(stdout, stderr).pipe(
				Stream.runForEach((chunk) =>
					Effect.sync(() => {
						printed.push(chunk.text);
						if (chunk.from === "stdout") written.push(chunk.text);
					}),
				),
				Effect.forkScoped,
			);
			// The spawner fails `exitCode` when the process has no exit code, a signal having ended it. The signal is
			// named by the message of the error it gives as the cause (`unknown` in its types); its own message names only
			// the command.
			const ended = yield* handle.exitCode.pipe(
				Effect.map((exitCode) => ({ kind: "exited" as const, exitCode: Number(exitCode) })),
				Effect.catch((error) => {
					const cause = error.reason.cause;
					const reason = cause instanceof Error ? cause.message : error.message;
					return Effect.succeed({ kind: "signalled" as const, reason });
				}),
			);
			if (end === "output") {
				// After a signal a worker may hold the output for good: what was printed so far is the run's output.
				if (ended.kind === "exited") yield* Fiber.join(reading);
			} else {
				// A group with no process left cannot be signalled, which is no failure: nothing holds the output then.
				yield* Effect.ignore(handle.kill({ killSignal: options.killSignal }));
				yield* Effect.timeoutOption(Fiber.join(reading), DRAIN);
			}
			return { ...ended, output: printed.join(""), stdout: written.join("") } satisfies BoundedResult;
		}),
	).pipe(Effect.mapError((cause) => new CommandError({ command: label, reason: cause.message })));
}

/**
 * How long a command's output is still read once it exited and its group was ended: what it printed is in the pipe
 * already, read at once; only a process that left its group can hold the output open longer.
 */
const DRAIN = "1 second";
