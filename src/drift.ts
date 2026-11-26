// Drift: what changed between two surfaces of one library (two upstream versions), as a list of changes and their
// weight. An addition is new API the facade can take; a removal or a changed signature breaks code written against
// the facade. `sync` reads it to decide whether a new upstream version needs a person.

import type { Export, Handle, Signature, Surface } from "./surface.ts";

/** One change between two surfaces. */
export type Change =
	| { readonly kind: "added"; readonly path: string; readonly detail: string }
	| { readonly kind: "removed"; readonly path: string; readonly detail: string }
	| { readonly kind: "changed"; readonly path: string; readonly before: string; readonly after: string };

/** The drift between two versions and whether it breaks the facade's users. */
export interface Drift {
	readonly from: string;
	readonly to: string;
	readonly changes: ReadonlyArray<Change>;
	/** Removals and changed signatures: code against the facade may no longer compile. */
	readonly breaking: boolean;
}

/** Compares two surfaces: exports, handles, their methods (by printed signatures), properties and events. */
export function drift(before: Surface, after: Surface): Drift {
	const changes: Array<Change> = [];
	compareKeyed(
		changes,
		"export",
		new Map(before.exports.map((item) => [item.name, item])),
		new Map(after.exports.map((item) => [item.name, item])),
		describeExport,
	);
	const handleNames = new Set([...Object.keys(before.handles), ...Object.keys(after.handles)]);
	for (const name of [...handleNames].sort()) {
		const old = before.handles[name];
		const next = after.handles[name];
		if (old === undefined && next !== undefined) changes.push({ kind: "added", path: `handle ${name}`, detail: `${Object.keys(next.methods).length} methods` });
		else if (old !== undefined && next === undefined) changes.push({ kind: "removed", path: `handle ${name}`, detail: old.typeRef });
		else if (old !== undefined && next !== undefined) compareHandle(changes, name, old, next);
	}
	return {
		from: `${before.package}@${before.version}`,
		to: `${after.package}@${after.version}`,
		changes,
		breaking: changes.some((change) => change.kind !== "added"),
	};
}

function compareHandle(changes: Array<Change>, name: string, before: Handle, after: Handle): void {
	compareKeyed(changes, `${name}.`, new Map(Object.entries(before.methods)), new Map(Object.entries(after.methods)), describeSignatures);
	compareKeyed(
		changes,
		`${name}.`,
		new Map(Object.entries(before.properties)),
		new Map(Object.entries(after.properties)),
		(property) => property.type,
	);
	const oldEvents = new Set(before.events);
	const newEvents = new Set(after.events);
	for (const event of after.events) if (!oldEvents.has(event)) changes.push({ kind: "added", path: `${name} event ${event}`, detail: "" });
	for (const event of before.events) if (!newEvents.has(event)) changes.push({ kind: "removed", path: `${name} event ${event}`, detail: "" });
}

/** Adds the changes between two keyed collections, comparing each kept entry by its description. */
function compareKeyed<A>(
	changes: Array<Change>,
	prefix: string,
	before: ReadonlyMap<string, A>,
	after: ReadonlyMap<string, A>,
	describe: (item: A) => string,
): void {
	const separator = prefix.endsWith(".") ? "" : " ";
	for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const old = before.get(key);
		const next = after.get(key);
		const path = `${prefix}${separator}${key}`;
		if (old === undefined && next !== undefined) changes.push({ kind: "added", path, detail: describe(next) });
		else if (old !== undefined && next === undefined) changes.push({ kind: "removed", path, detail: describe(old) });
		else if (old !== undefined && next !== undefined && describe(old) !== describe(next)) {
			changes.push({ kind: "changed", path, before: describe(old), after: describe(next) });
		}
	}
}

function describeExport(item: Export): string {
	if (item.kind === "function") return `function ${describeSignatures(item.signatures)}`;
	if (item.kind === "class") {
		const statics = Object.entries(item.statics ?? {})
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, signatures]) => `; static ${name}${describeSignatures(signatures)}`);
		return `class ${describeSignatures(item.constructors)}${statics.join("")}`;
	}
	return `value ${item.type}`;
}

function describeSignatures(signatures: ReadonlyArray<Signature>): string {
	return signatures
		.map(
			(signature) =>
				`${signature.typeParameters === undefined ? "" : `<${signature.typeParameters}>`}(${signature.parameters
					.map((parameter) => `${parameter.rest ? "..." : ""}${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.type}`)
					.join(", ")}) => ${signature.returns}`,
		)
		.join(" | ");
}

/** The drift as Markdown, for a pull request or an issue: the summary first, then every change. */
export function driftMarkdown(result: Drift): string {
	const count = (kind: Change["kind"]) => result.changes.filter((change) => change.kind === kind).length;
	const line = (change: Change) =>
		change.kind === "changed"
			? `- **changed** \`${change.path}\`\n  - before: \`${change.before.slice(0, 300)}\`\n  - after: \`${change.after.slice(0, 300)}\``
			: `- **${change.kind}** \`${change.path}\`${change.detail === "" ? "" : `: \`${change.detail.slice(0, 200)}\``}`;
	return [
		`## ${result.from} → ${result.to}`,
		"",
		`${count("added")} added, ${count("removed")} removed, ${count("changed")} changed${result.breaking ? " — **breaking for the facade's users**" : ""}.`,
		"",
		...result.changes.map(line),
		"",
	].join("\n");
}
