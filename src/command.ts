// Running an external command (npm, tsc, git) and keeping everything it printed, whatever its exit code: the engine
// reports a failing install or type check with the tool's own words.

import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** A command could not be started. */
export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
	command: Schema.String,
	reason: Schema.String,
}) {}

/** What a finished command left: its exit code and its stdout and stderr, interleaved as printed. */
export interface CommandResult {
	readonly exitCode: number;
	readonly output: string;
}

/** Runs `command args` in `cwd` to completion. */
export const runCommand = Effect.fn("runCommand")(function* (command: string, args: ReadonlyArray<string>, cwd: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const label = [command, ...args].join(" ");
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { cwd }));
			const [output, exitCode] = yield* Effect.all([handle.all.pipe(Stream.decodeText, Stream.mkString), handle.exitCode], {
				concurrency: 2,
			});
			return { exitCode: Number(exitCode), output } satisfies CommandResult;
		}),
	).pipe(Effect.mapError((cause) => new CommandError({ command: label, reason: cause.message })));
});
