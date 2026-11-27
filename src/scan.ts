// The source scanner: what a library's JavaScript does that its types do not say. It reads the installed package's
// files with ast-grep (tree-sitter patterns, no type checking) for the error classes it defines and throws, the error
// codes it sets, and the events it emits. The recipe draws its error mapping and its event lists from this evidence.

import { Lang, parse } from "@ast-grep/napi";
import { Effect, FileSystem, Path } from "effect";
import type { Workspace } from "./workspace.ts";

/** What the scanner found in a package's JavaScript. */
export interface Scan {
	readonly files: number;
	/** Error classes the source defines, with their base class and how often they are thrown. */
	readonly errorClasses: ReadonlyArray<{ readonly name: string; readonly base: string; readonly thrown: number }>;
	/** String error codes the source assigns (`err.code = "EAUTH"`, `{ code: "ETIMEDOUT" }`), most frequent first. */
	readonly codes: ReadonlyArray<string>;
	/** Event names the source emits (`this.emit("ready")`), most frequent first. */
	readonly events: ReadonlyArray<string>;
}

/** How many files the scanner reads at most; a package's own code is rarely more. */
const MAX_FILES = 2000;

/** Scans the installed package's JavaScript (never its dependencies). */
export const scan = Effect.fn("scan")(function* (workspace: Workspace) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const entries = yield* fs
		.readDirectory(workspace.packageDirectory, { recursive: true })
		.pipe(Effect.orElseSucceed(() => []));
	const files = entries
		.filter(
			(file) =>
				/\.(c|m)?js$/.test(file) &&
				!file.split(path.sep).includes("node_modules") &&
				!/(^|\/)(test|tests|__tests__)\//.test(file),
		)
		.slice(0, MAX_FILES);
	const found = {
		classes: new Map<string, string>(),
		thrown: new Map<string, number>(),
		codes: new Map<string, number>(),
		events: new Map<string, number>(),
	};
	for (const file of files) {
		const source = yield* fs
			.readFileString(path.join(workspace.packageDirectory, file))
			.pipe(Effect.orElseSucceed(() => ""));
		if (source.length > 0) yield* Effect.sync(() => read(source, found));
	}
	return {
		files: files.length,
		errorClasses: [...found.classes].map(([name, base]) => ({ name, base, thrown: found.thrown.get(name) ?? 0 })),
		codes: byCount(found.codes),
		events: byCount(found.events),
	} satisfies Scan;
});

interface Found {
	readonly classes: Map<string, string>;
	readonly thrown: Map<string, number>;
	readonly codes: Map<string, number>;
	readonly events: Map<string, number>;
}

/** Matches one file's patterns into `found`; a file the parser cannot read adds nothing. */
function read(source: string, found: Found): void {
	let root;
	try {
		root = parse(Lang.JavaScript, source).root();
	} catch {
		return;
	}
	for (const node of root.findAll("class $NAME extends $BASE { $$$ }")) {
		const name = node.getMatch("NAME")?.text();
		const base = node.getMatch("BASE")?.text();
		// A minified bundle renames classes (`class P extends Error`): such names say nothing.
		if (name !== undefined && base !== undefined && base.endsWith("Error") && name.length > 2)
			found.classes.set(name, base);
	}
	for (const node of root.findAll("throw new $NAME($$$)")) {
		const name = node.getMatch("NAME")?.text();
		if (name !== undefined) count(found.thrown, name);
	}
	// Error codes reach errors in many ways (`err.code = "EAUTH"`, `{ code: "ETIMEDOUT" }`, `fail(msg, "EAUTH")`), so
	// every string literal shaped like one counts.
	for (const node of root.findAll({ rule: { kind: "string", regex: "^[\"']E[A-Z][A-Z0-9_]{2,}[\"']$" } })) {
		const code = literal(node.text());
		if (code !== undefined) count(found.codes, code);
	}
	for (const node of root.findAll("$EMITTER.emit($EVENT, $$$)")) {
		const event = literal(node.getMatch("EVENT")?.text());
		if (event !== undefined) count(found.events, event);
	}
}

/** The value of a string literal's source text, or undefined for anything else. */
function literal(text: string | undefined): string | undefined {
	const match = text === undefined ? null : /^(["'`])([^"'`$]*)\1$/.exec(text);
	return match?.[2];
}

function count(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function byCount(map: Map<string, number>): ReadonlyArray<string> {
	return [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
}
