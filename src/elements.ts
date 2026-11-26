// The elements of a web-component library: what its Custom Elements Manifest (custom-elements.json, the standard
// Lit, Stencil and others write) declares, read into what an Effect UI binding needs. The manifest gives the
// inventory (tags, the module that defines each, settable properties, events); the types come from upstream's
// declarations when the facade is generated (`HTMLElementTagNameMap`, `GlobalEventHandlersEventMap`).

import { Effect, FileSystem, Path, Schema } from "effect";
import type { Workspace } from "./workspace.ts";

/** One custom element, as a binding needs it. */
export const Element = Schema.Struct({
	tag: Schema.String,
	/** The binding's name: the tag without the library's prefix, in PascalCase (`wa-button` is `Button`). */
	name: Schema.String,
	/** The module whose import defines the element (`customElements.define`), as a package import path. */
	definition: Schema.String,
	/** Properties a view may set: public, writable fields that hold no DOM node of the element's own. */
	properties: Schema.Array(Schema.String),
	events: Schema.Array(Schema.String),
	description: Schema.String,
});
export type Element = typeof Element.Type;

/** The manifest's path inside the package (`customElements` in its package.json), or undefined when it has none. */
export const manifestPath = Effect.fn("manifestPath")(function* (workspace: Workspace) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const manifest: unknown = JSON.parse(yield* fs.readFileString(path.join(workspace.packageDirectory, "package.json")));
	const field = typeof manifest === "object" && manifest !== null ? (manifest as { customElements?: unknown }).customElements : undefined;
	return typeof field === "string" ? field.replace(/^\.\//, "") : undefined;
});

/** Reads the elements a package's manifest declares, sorted by tag. */
export const readElements = Effect.fn("readElements")(function* (workspace: Workspace, manifest: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	// Trust boundary: the manifest and package.json are files other tools wrote; only the fields read below are relied on.
	const document: unknown = JSON.parse(yield* fs.readFileString(path.join(workspace.packageDirectory, manifest)));
	const packageExports = field(JSON.parse(yield* fs.readFileString(path.join(workspace.packageDirectory, "package.json"))), "exports");
	const modules = asArray(field(document, "modules"));
	const definitions = new Map<string, string>();
	const classes = new Map<string, unknown>();
	for (const module of modules) {
		for (const exported of asArray(field(module, "exports"))) {
			if (field(exported, "kind") === "custom-element-definition") definitions.set(String(field(exported, "name")), String(field(module, "path")));
		}
		for (const declaration of asArray(field(module, "declarations"))) {
			classes.set(`${String(field(module, "path"))}#${String(field(declaration, "name"))}`, declaration);
			classes.set(`#${String(field(declaration, "name"))}`, declaration);
		}
	}
	// Every class of the library: a field typed by one holds another element (a list's `items`), not data.
	const elementClasses = new Set(
		modules.flatMap((module) =>
			asArray(field(module, "declarations"))
				.filter((declaration) => field(declaration, "kind") === "class")
				.map((declaration) => String(field(declaration, "name"))),
		),
	);
	const elements: Array<Element> = [];
	const manifestDirectory = path.dirname(manifest);
	for (const module of modules) {
		for (const declaration of asArray(field(module, "declarations"))) {
			const tag = field(declaration, "tagName");
			if (typeof tag !== "string" || field(declaration, "customElement") !== true) continue;
			const modulePath = definitions.get(tag) ?? String(field(module, "path"));
			const chain = ancestry(declaration, classes, workspace.target.package);
			elements.push({
				tag,
				name: "",
				definition: yield* definitionImport(workspace, packageExports, manifestDirectory, modulePath),
				properties: settableProperties(chain.flatMap((link) => asArray(field(link, "members"))), elementClasses),
				events: [...new Set(chain.flatMap((link) => asArray(field(link, "events"))).map((event) => field(event, "name")).filter((name): name is string => typeof name === "string"))].sort(),
				description: firstSentence(String(field(declaration, "summary") ?? field(declaration, "description") ?? "")),
			});
		}
	}
	const prefix = commonPrefix(elements.map((element) => element.tag));
	return elements
		.map((element) => ({ ...element, name: pascal(element.tag.slice(prefix.length)) }))
		.sort((a, b) => a.tag.localeCompare(b.tag));
});

/**
 * A declaration, then its superclasses and mixins found in the same manifest, nearest first. Libraries declare an
 * element as a thin subclass (Material Web's `MdSwitch extends Switch`), and manifests rarely flatten what it
 * inherits. The walk stops at a class of another package (`LitElement`).
 */
function ancestry(declaration: unknown, classes: ReadonlyMap<string, unknown>, ownPackage: string): ReadonlyArray<unknown> {
	const chain: Array<unknown> = [];
	const pending: Array<unknown> = [declaration];
	while (pending.length > 0 && chain.length < 32) {
		const next = pending.shift();
		if (next === undefined || chain.includes(next)) continue;
		chain.push(next);
		for (const reference of [field(next, "superclass"), ...asArray(field(next, "mixins"))]) {
			const from = field(reference, "package");
			if (reference === undefined || (typeof from === "string" && from !== ownPackage)) continue;
			const name = String(field(reference, "name"));
			const found = classes.get(`${String(field(reference, "module") ?? "")}#${name}`) ?? classes.get(`#${name}`);
			if (found !== undefined) pending.push(found);
		}
	}
	return chain;
}

/**
 * The import path of the module that defines an element, as a consumer writes it. The manifest names a module
 * relative to itself or to the package root, often as its TypeScript source (`src/x.ts`); the file the package
 * ships is found, then named through the package's `exports` (which may not expose its path as it is).
 */
const definitionImport = Effect.fn("definitionImport")(function* (
	workspace: Workspace,
	packageExports: unknown,
	manifestDirectory: string,
	modulePath: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const shipped = [modulePath, modulePath.replace(/^src\//, "dist/").replace(/\.ts$/, ".js"), modulePath.replace(/\.ts$/, ".js")];
	const candidates = [manifestDirectory, "."]
		.flatMap((base) => shipped.map((file) => path.normalize(path.join(base, file)).replace(/^\.\//, "")))
		.filter((candidate, index, all) => all.indexOf(candidate) === index && !candidate.endsWith(".ts"));
	for (const candidate of candidates) {
		if (!(yield* fs.exists(path.join(workspace.packageDirectory, candidate)))) continue;
		if (packageExports === undefined) return `${workspace.target.package}/${candidate}`;
		const subpath = exportedSubpath(packageExports, candidate);
		if (subpath !== undefined) return subpath === "." ? workspace.target.package : `${workspace.target.package}/${subpath.slice(2)}`;
	}
	// No file found, or none the package exports: importing the package itself defines its elements in most libraries.
	return workspace.target.package;
});

/** The subpath of `exports` (`./switch/define.js`) that resolves to `file` (`dist/esm/switch/define.js`), if any. */
function exportedSubpath(packageExports: unknown, file: string): string | undefined {
	const entries = typeof packageExports === "string" ? [[".", packageExports] as const] : Object.entries(packageExports as Record<string, unknown>);
	for (const [key, value] of entries) {
		const target = exportTarget(value);
		if (target === undefined) continue;
		const star = new RegExp(`^${target.split("*").map(escapeRegExp).join("(.+)")}$`).exec(`./${file}`);
		if (star === null) continue;
		const parts = star.slice(1);
		// Every `*` of a target stands for the same text (`./dist/esm/*/*.definition.js`).
		if (parts.some((part) => part !== parts[0])) continue;
		const subpath = key.replace("*", parts[0] ?? "");
		if (resolveExport(entries, subpath) === `./${file}`) return subpath;
	}
	return undefined;
}

/** How Node resolves `subpath` through `exports`: an exact key, else the pattern with the longest prefix. */
function resolveExport(entries: ReadonlyArray<readonly [string, unknown]>, subpath: string): string | undefined {
	const exact = entries.find(([key]) => key === subpath);
	if (exact !== undefined) return exportTarget(exact[1]);
	const patterns = entries
		.filter(([key]) => key.includes("*"))
		.map(([key, value]) => ({ prefix: key.slice(0, key.indexOf("*")), suffix: key.slice(key.indexOf("*") + 1), value }))
		.filter((pattern) => subpath.startsWith(pattern.prefix) && subpath.endsWith(pattern.suffix) && subpath.length >= pattern.prefix.length + pattern.suffix.length)
		.sort((a, b) => b.prefix.length - a.prefix.length);
	const best = patterns[0];
	if (best === undefined) return undefined;
	const matched = subpath.slice(best.prefix.length, subpath.length - best.suffix.length);
	return exportTarget(best.value)?.replaceAll("*", matched);
}

/** The file an `exports` value gives a browser bundler: a string, or its `import`, `browser` or `default` condition. */
function exportTarget(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value !== "object" || value === null) return undefined;
	for (const condition of ["import", "browser", "default"]) {
		const target = exportTarget(field(value, condition));
		if (target !== undefined) return target;
	}
	return undefined;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Public, writable instance fields that hold data: not a DOM node of the element's own (Lit's @query fields), not
 * another element of the library (a tab list's `activetab`), not a function (handlers stored as fields), not its
 * `ElementInternals`. `members` lists the element's own first, then what it inherits; the nearest declaration wins.
 */
function settableProperties(members: ReadonlyArray<unknown>, elementClasses: ReadonlySet<string>): ReadonlyArray<string> {
	const seen = new Set<string>();
	const settable: Array<string> = [];
	for (const member of members) {
		const name = String(field(member, "name"));
		if (field(member, "kind") !== "field" || field(member, "static") === true || seen.has(name)) continue;
		seen.add(name);
		const type = String(field(field(member, "type"), "text") ?? "");
		const holdsData =
			field(member, "readonly") !== true &&
			field(member, "privacy") !== "private" &&
			field(member, "privacy") !== "protected" &&
			!name.startsWith("_") &&
			!/internals$/i.test(name) &&
			!type.includes("=>") &&
			!/\b(HTML\w*Element|Element|Node|ShadowRoot|ElementInternals)\b/.test(type) &&
			!type.split(/[^\w$]+/).some((word) => elementClasses.has(word));
		if (holdsData) settable.push(name);
	}
	return settable.sort();
}

/** A description's first sentence, on one line. */
function firstSentence(text: string): string {
	return text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> {
	return Array.isArray(value) ? value : [];
}

/** The prefix every tag shares, up to and including a hyphen (`wa-`), or nothing. */
function commonPrefix(tags: ReadonlyArray<string>): string {
	const first = tags[0];
	if (first === undefined || tags.length === 1) return "";
	const candidate = first.slice(0, first.indexOf("-") + 1);
	return candidate !== "" && tags.every((tag) => tag.startsWith(candidate)) ? candidate : "";
}

function pascal(text: string): string {
	return text
		.split(/[^a-zA-Z0-9]+/)
		.filter((part) => part.length > 0)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join("");
}
