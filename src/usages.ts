// Usages: where an application uses a library, for moving it onto the facade. It reads the application's TypeScript
// and JavaScript with ast-grep for the imports of the package, and the call sites of what each import names, so a
// migration (by an agent, following skills/effectify-migrate) starts from a complete list instead of a search.

import { Lang, parse } from "@ast-grep/napi";
import { Effect, FileSystem, Path } from "effect";

/** One place the application uses the library. */
export interface Usage {
	readonly file: string;
	readonly line: number;
	readonly kind: "import" | "call" | "construct" | "await";
	readonly text: string;
}

/** Every use of `packageName` under `directory`, file by file. */
export const usages = Effect.fn("usages")(function* (directory: string, packageName: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const files = (yield* fs.readDirectory(directory, { recursive: true })).filter(
		(file) =>
			/\.(c|m)?[jt]sx?$/.test(file) &&
			!file.endsWith(".d.ts") &&
			!file.split(path.sep).some((part) => part === "node_modules" || part === "dist"),
	);
	const found: Array<Usage> = [];
	for (const file of files.sort()) {
		const source = yield* fs.readFileString(path.join(directory, file)).pipe(Effect.orElseSucceed(() => ""));
		if (!source.includes(packageName)) continue;
		yield* Effect.sync(() => found.push(...read(file, source, packageName)));
	}
	return found;
});

/** The uses in one file: its imports of the package, then the calls, constructions and awaits of the imported names. */
function read(file: string, source: string, packageName: string): ReadonlyArray<Usage> {
	let root;
	try {
		root = parse(/\.[cm]?tsx$|\.jsx$/.test(file) ? Lang.Tsx : Lang.TypeScript, source).root();
	} catch {
		return [];
	}
	const uses: Array<Usage> = [];
	const names = new Set<string>();
	const quoted = [`"${packageName}"`, `'${packageName}'`];
	for (const node of root.findAll({
		rule: { any: [{ kind: "import_statement" }, { pattern: "require($SOURCE)" }] },
	})) {
		const text = node.text();
		if (!quoted.some((specifier) => text.includes(specifier))) continue;
		uses.push({ file, line: node.range().start.line + 1, kind: "import", text: oneLine(text) });
		for (const [, local] of text.matchAll(/(?:\bas\s+|import\s+|[{,]\s*)([A-Za-z_$][\w$]*)(?=\s*(?:[,}]|from|$))/g)) {
			if (local !== undefined && local !== "type" && local !== "import") names.add(local);
		}
	}
	if (names.size === 0) return uses;
	for (const node of root.findAll({
		rule: { any: [{ kind: "call_expression" }, { kind: "new_expression" }, { kind: "await_expression" }] },
	})) {
		const text = node.text();
		const head = /^(?:await\s+|new\s+)?([A-Za-z_$][\w$]*)/.exec(text)?.[1];
		if (head === undefined || !names.has(head)) continue;
		const kind =
			node.kind() === "await_expression" ? "await" : node.kind() === "new_expression" ? "construct" : "call";
		uses.push({ file, line: node.range().start.line + 1, kind, text: oneLine(text).slice(0, 160) });
	}
	return uses;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** Usages as a migration checklist in Markdown, grouped by file. */
export function usagesMarkdown(packageName: string, found: ReadonlyArray<Usage>): string {
	const byFile = new Map<string, Array<Usage>>();
	for (const use of found) byFile.set(use.file, [...(byFile.get(use.file) ?? []), use]);
	return [
		`# Uses of ${packageName}`,
		"",
		`${found.length} uses in ${byFile.size} files.`,
		"",
		...[...byFile].flatMap(([file, uses]) => [
			`## ${file}`,
			"",
			...uses.map((use) => `- [ ] ${use.line}: ${use.kind} \`${use.text}\``),
			"",
		]),
	].join("\n");
}
