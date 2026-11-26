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
	// Trust boundary: the manifest is a file another tool wrote; only the fields read below are relied on.
	const document: unknown = JSON.parse(yield* fs.readFileString(path.join(workspace.packageDirectory, manifest)));
	const modules = asArray(field(document, "modules"));
	const definitions = new Map<string, string>();
	for (const module of modules) {
		for (const exported of asArray(field(module, "exports"))) {
			if (field(exported, "kind") === "custom-element-definition") definitions.set(String(field(exported, "name")), String(field(module, "path")));
		}
	}
	const elements: Array<Element> = [];
	const manifestDirectory = path.dirname(manifest);
	for (const module of modules) {
		for (const declaration of asArray(field(module, "declarations"))) {
			const tag = field(declaration, "tagName");
			if (typeof tag !== "string" || field(declaration, "customElement") !== true) continue;
			const modulePath = definitions.get(tag) ?? String(field(module, "path"));
			elements.push({
				tag,
				name: "",
				definition: yield* definitionImport(workspace, manifestDirectory, modulePath),
				properties: settableProperties(declaration),
				events: [...new Set(asArray(field(declaration, "events")).map((event) => field(event, "name")).filter((name): name is string => typeof name === "string"))].sort(),
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
 * The import path of the module that defines an element, as a consumer writes it: relative to the manifest, made
 * a package path; a TypeScript source path (`src/x.ts`) is mapped to the JavaScript the package ships, when it exists.
 */
const definitionImport = Effect.fn("definitionImport")(function* (workspace: Workspace, manifestDirectory: string, modulePath: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const candidates = [
		path.join(manifestDirectory, modulePath),
		path.join(manifestDirectory, modulePath.replace(/^src\//, "dist/").replace(/\.ts$/, ".js")),
		path.join(manifestDirectory, modulePath.replace(/\.ts$/, ".js")),
	].map((candidate) => path.normalize(candidate).replace(/^\.\//, ""));
	for (const candidate of candidates) {
		if (yield* fs.exists(path.join(workspace.packageDirectory, candidate))) return `${workspace.target.package}/${candidate}`;
	}
	// No file found: importing the package itself defines its elements in most libraries.
	return workspace.target.package;
});

/** Public, writable instance fields that hold no DOM node (Lit's @query fields are the element's own internals). */
function settableProperties(declaration: unknown): ReadonlyArray<string> {
	return asArray(field(declaration, "members"))
		.filter(
			(member) =>
				field(member, "kind") === "field" &&
				field(member, "static") !== true &&
				field(member, "readonly") !== true &&
				field(member, "privacy") !== "private" &&
				field(member, "privacy") !== "protected" &&
				!String(field(member, "name")).startsWith("_") &&
				!/\b(HTML\w*Element|Element|Node|ShadowRoot|ElementInternals)\b/.test(String(field(field(member, "type"), "text") ?? "")),
		)
		.map((member) => String(field(member, "name")))
		.filter((name, index, all) => all.indexOf(name) === index)
		.sort();
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
