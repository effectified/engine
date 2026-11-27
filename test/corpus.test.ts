// The regression corpus's judgment (scripts/corpus.ts): a step passes only with evidence that it finished, and a
// failure the changelog announces is only the one it names, in its step.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { LIBRARIES, type Outcome, ranStep, TOKEN_VARIABLE, USE_FINISHED, verdict } from "../scripts/corpus.ts";

describe("corpus: a step's evidence", () => {
	const directory = join(import.meta.dirname, "..", ".cache", "corpus-steps");
	const program = (file: string, source: string) => {
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, file), source);
		return file;
	};
	// What a program prints as its last act: the marker and the token its run was given.
	const marker = `${JSON.stringify(`${USE_FINISHED} `)} + process.env[${JSON.stringify(TOKEN_VARIABLE)}]`;
	// An async program whose work never settles: nothing keeps Node running, so it exits with 0, its last act undone.
	const pending = `new Promise(() => {}).then(() => console.log(${marker}));\n`;

	it.effect("fails a program that exits with 0 before it finished, and passes one that printed its marker last", () =>
		Effect.gen(function* () {
			rmSync(directory, { recursive: true, force: true });
			const unfinished = program("unfinished.mjs", pending);
			const finished = program("finished.mjs", `console.log("parent");\nconsole.log(${marker});\n`);
			const exited = program("exited.mjs", `console.log(${marker});\nprocess.exitCode = 1;\n`);
			const steps = yield* Effect.forEach([unfinished, finished, exited], (file) =>
				ranStep([file], directory, { kind: "marker", token: "token-1" }),
			);
			expect(steps.map((step) => step.kind)).toStrictEqual(["failed", "ok", "failed"]);
			rmSync(directory, { recursive: true, force: true });
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"fails a program whose library printed the marker, without its run's token, or not alone on a line of stdout",
		() =>
			Effect.gen(function* () {
				rmSync(directory, { recursive: true, force: true });
				const faked = [
					// A library's own lines as it loads, then work that never settles.
					program("stderr.mjs", `console.error(${JSON.stringify(USE_FINISHED)});\n${pending}`),
					program("stdout.mjs", `console.log(${JSON.stringify(USE_FINISHED)});\n${pending}`),
					program("wrong.mjs", `console.log(${JSON.stringify(`${USE_FINISHED} token-0`)});\n${pending}`),
					// The right line, but on stderr, or inside a longer line of stdout.
					program("stderr-token.mjs", `console.error(${marker});\n${pending}`),
					program("inside.mjs", `console.log("lib: " + ${marker});\n${pending}`),
				];
				const steps = yield* Effect.forEach(faked, (file) =>
					ranStep([file], directory, { kind: "marker", token: "token-2" }),
				);
				expect(steps.map((step) => step.kind)).toStrictEqual(["failed", "failed", "failed", "failed", "failed"]);
				rmSync(directory, { recursive: true, force: true });
			}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe("corpus: an announced failure", () => {
	const protobufjs = LIBRARIES.find((library) => library.name === "protobufjs");
	const ok = (output: string) => ({ kind: "ok", output }) as const;
	const failed = (output: string) => ({ kind: "failed", output }) as const;
	const skipped = { kind: "skipped" } as const;
	const none = { kind: "none" } as const;
	const passing: Outcome = { make: ok(""), verify: ok(""), use: none };
	// What 0.4.0's `verify` prints for protobufjs 7.5.4: the import check's report of an export Node gives as undefined.
	const imported = [
		"effectify failed: StepError",
		"  step: import",
		"  reason: /corpus/checkout/targets/protobufjs/package/dist/index.js: Cannot read properties of undefined (reading 'fromJSON')",
		"[18:38:35.809] ERROR (#2): StepError: ",
	].join("\n");

	it("is the step and the message its entry names; any other failure is a regression", () => {
		expect(protobufjs?.announced?.step).toBe("verify");
		const row = (checkout: Outcome) => verdict({ library: protobufjs!, released: passing, checkout });
		expect(row({ make: ok(""), verify: failed(imported), use: none })).toBe(
			`announced: ${protobufjs?.announced?.reason}`,
		);
		// A `make` failure is no announced change, whatever it prints.
		expect(row({ make: failed(imported), verify: skipped, use: none })).toBe("REGRESSION");
		// Nor is a `verify` failure of another kind.
		const typeError = [
			"effectify failed: StepError",
			"  step: tsc",
			"  reason: src/index.ts(1,1): error TS2344",
		].join("\n");
		expect(row({ make: ok(""), verify: failed(typeError), use: none })).toBe("REGRESSION");
	});
});
