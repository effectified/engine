// The recipe: every decision a facade needs that the types cannot make. Which exports the facade offers, which
// handles it wraps and how each is released, which events become streams, how failures map to tagged errors, and
// which handles become services. The engine drafts one from a surface and a scan; an agent or a person reviews each
// decision, and the generator reads nothing else. A redraft keeps what an agent or a person decided.

import { Effect, Schema } from "effect";
import type { Scan } from "./scan.ts";
import type { Export, Handle, Surface } from "./surface.ts";

/** Who made a decision: the engine's draft, a coding agent, or a person. A redraft replaces only the engine's. */
export const DecidedBy = Schema.Literals(["engine", "agent", "person"]);

/** One decision and why it was made. */
export const Decision = Schema.Struct({
	id: Schema.String,
	question: Schema.String,
	answer: Schema.String,
	why: Schema.String,
	by: DecidedBy,
});
export type Decision = typeof Decision.Type;

/** How the facade treats one handle. */
export const HandleRecipe = Schema.Struct({
	/** The method that releases it: acquiring it then needs a `Scope`, and closing the scope calls this. */
	release: Schema.optional(Schema.String),
	/** Events offered as `Stream`s. */
	events: Schema.Array(Schema.String),
});
export type HandleRecipe = typeof HandleRecipe.Type;

/** One tagged error and which upstream failures become it; the first match wins, the package's base error last. */
export const ErrorRecipe = Schema.Struct({
	tag: Schema.String,
	/** An exported upstream class the failure is an instance of; none for the catch-all. */
	instanceOf: Schema.optional(Schema.String),
	/** Error codes (`cause.code`) that select this error. */
	codes: Schema.Array(Schema.String),
});
export type ErrorRecipe = typeof ErrorRecipe.Type;

/** How the facade treats one method, overriding what the analyzer read; `exclude` leaves it out of the facade. */
export const MethodOverride = Schema.Literals(["async", "stream", "sync", "exclude"]);
export type MethodOverride = typeof MethodOverride.Type;

/** Everything the generator needs. */
export const Recipe = Schema.Struct({
	$schema: Schema.optional(Schema.String),
	package: Schema.String,
	version: Schema.String,
	types: Schema.Struct({ from: Schema.Literals(["bundled", "definitely-typed"]), package: Schema.String, version: Schema.String }),
	/** The facade's npm name. */
	name: Schema.String,
	/** The prefix of the facade's own names: its catch-all error is `<prefix>Error`. */
	prefix: Schema.String,
	/** Exported functions and classes the facade offers. */
	exports: Schema.Array(Schema.String),
	handles: Schema.Record(Schema.String, HandleRecipe),
	errors: Schema.Array(ErrorRecipe),
	/** Handles provided as `Context.Service`s, with the export that acquires one. */
	services: Schema.Array(Schema.Struct({ name: Schema.String, handle: Schema.String, acquire: Schema.String })),
	/**
	 * Per-method overrides by `<Handle>.<method>`. `reconcile` writes those the compiler demands (where upstream's
	 * types and the analyzer read a method differently); an agent or a person may add `exclude`s.
	 */
	methods: Schema.Record(Schema.String, MethodOverride),
	/**
	 * Generic methods (`<Handle>.<method>`) kept on the derived types, which lose their type parameters, because the
	 * explicit signature the generator writes for them does not compile (it names a type upstream does not export).
	 */
	derived: Schema.Array(Schema.String),
	/** Packages the facade's own tests need (a Redis client, say), added to its devDependencies by exact version. */
	testDependencies: Schema.Record(Schema.String, Schema.String),
	decisions: Schema.Array(Decision),
});
export type Recipe = typeof Recipe.Type;

/** Reads a stored recipe; files are a trust boundary. */
export const decodeRecipe = Schema.decodeUnknownEffect(Schema.fromJsonString(Recipe));

/** Release methods in the order the draft prefers them. */
const RELEASE_PREFERENCE = ["close", "quit", "disconnect", "destroy", "shutdown", "terminate", "stop", "end", "dispose", "release"];

/** Drafts a recipe from a surface, the scan and the package README; keeps the decisions of `previous` not made by the engine. */
export const draftRecipe = Effect.fn("draftRecipe")(function* (surface: Surface, scan: Scan, readme: string, previous?: Recipe) {
	const decisions: Array<Decision> = [];
	const kept = new Map((previous?.decisions ?? []).filter((decision) => decision.by !== "engine").map((decision) => [decision.id, decision]));
	const decide = (id: string, question: string, answer: string, why: string): string => {
		const prior = kept.get(id);
		decisions.push(prior ?? { id, question, answer, why, by: "engine" });
		return prior?.answer ?? answer;
	};

	const prefix = pascal(surface.package.replace(/^@[^/]+\//, "").replace(/-(core|js|node)$/, ""));
	const offered = offeredExports(surface, readme);
	const exports = decide(
		"exports",
		"Which exported functions and classes does the facade offer?",
		offered.names.join(", "),
		offered.why,
	)
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);

	const handles: Record<string, HandleRecipe> = {};
	for (const name of reachableHandles(surface, exports)) {
		const handle = surface.handles[name];
		if (handle === undefined) continue;
		const release = decide(
			`handles.${name}.release`,
			`Which method releases a ${name}, so acquiring one opens a scope? ("none" keeps it unscoped)`,
			preferredRelease(handle) ?? "none",
			handle.releases.length === 0 ? "its type has no release method" : `its release methods are ${handle.releases.join(", ")}`,
		);
		const offeredEvents = decide(
			`handles.${name}.events`,
			`Which events of ${name} does the facade offer as Streams? ("none" for none)`,
			handle.events.filter((event) => event !== "*").join(", ") || "none",
			handle.events.length === 0 ? "its `on` names no events" : "the events its `on` names in its types",
		);
		handles[name] = {
			...(release === "none" ? {} : { release }),
			events: offeredEvents === "none" ? [] : offeredEvents.split(",").map((event) => event.trim()),
		};
	}

	const errors = draftErrors(surface, scan, prefix);
	decide(
		"errors",
		"Which upstream failures become which tagged errors?",
		errors.map((error) => `${error.tag}${error.instanceOf === undefined ? "" : ` <- instanceof ${error.instanceOf}`}`).join("; "),
		`exported error classes, most specific first, then the catch-all ${prefix}Error carrying \`code\` (the source sets ${scan.codes.slice(0, 6).join(", ") || "no codes"})`,
	);

	const services = surface.exports
		.filter((item) => exports.includes(item.name))
		.flatMap((item) => {
			const handle = producedHandle(item);
			return handle !== undefined && handles[handle]?.release !== undefined ? [{ name: serviceName(prefix, handle), handle, acquire: item.name }] : [];
		});
	decide(
		"services",
		"Which handles are provided as services (Context.Service with a layer)?",
		services.map((service) => `${service.name} <- ${service.acquire}`).join(", ") || "none",
		"every offered export that acquires a releasable handle",
	);

	return {
		$schema: "https://effectified.dev/schema/recipe.json",
		package: surface.package,
		version: surface.version,
		types: surface.types,
		name: `@effectified/${surface.package.replace(/^@[^/]+\//, "")}`,
		prefix,
		exports,
		handles,
		errors,
		services: dedupeBy(services, (service) => service.name),
		methods: previous?.methods ?? {},
		derived: previous?.derived ?? [],
		testDependencies: previous?.testDependencies ?? {},
		decisions,
	} satisfies Recipe;
});

/** Exports worth offering: those the README uses, or else every function and class that is async or yields a handle. */
function offeredExports(surface: Surface, readme: string): { readonly names: ReadonlyArray<string>; readonly why: string } {
	const candidates = surface.exports.filter(
		(item) =>
			(item.kind === "function" && item.signatures.some((s) => s.handle !== undefined || s.traits.includes("async"))) ||
			(item.kind === "class" && !item.error && surface.handles[item.handle] !== undefined),
	);
	const used = candidates.filter((item) => new RegExp(`(\\bnew\\s+${item.name}\\b|\\b${item.name}\\s*\\(|\\.${item.name}\\s*\\()`).test(readme));
	if (used.length > 0) return { names: used.map((item) => item.name), why: "the exports the package README calls" };
	return { names: candidates.map((item) => item.name), why: "every exported function or class that is async or yields a handle" };
}

/** The handle an export produces. */
function producedHandle(item: Export): string | undefined {
	if (item.kind === "class") return item.handle;
	if (item.kind === "function") return item.signatures.find((signature) => signature.handle !== undefined)?.handle;
	return undefined;
}

/** Every handle reachable from the offered exports through method results. */
function reachableHandles(surface: Surface, exports: ReadonlyArray<string>): ReadonlyArray<string> {
	const seen = new Set<string>();
	const queue = surface.exports.filter((item) => exports.includes(item.name)).flatMap((item) => {
		const handle = producedHandle(item);
		return handle === undefined ? [] : [handle];
	});
	for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
		const handle = surface.handles[name];
		if (seen.has(name) || handle === undefined) continue;
		seen.add(name);
		for (const signatures of Object.values(handle.methods)) {
			for (const signature of signatures) if (signature.handle !== undefined) queue.push(signature.handle);
		}
	}
	return [...seen];
}

function preferredRelease(handle: Handle): string | undefined {
	return RELEASE_PREFERENCE.find((name) => handle.releases.includes(name));
}

/** Exported error classes, subclasses before their bases, then the catch-all `<prefix>Error`. */
function draftErrors(surface: Surface, scan: Scan, prefix: string): ReadonlyArray<ErrorRecipe> {
	const exported = surface.exports.filter((item) => item.kind === "class" && item.error).map((item) => item.name);
	// The types say what each error class extends; the scan fills in what they do not (and is blind in minified code).
	const base = new Map(scan.errorClasses.map((item) => [item.name, item.base]));
	for (const item of surface.exports) if (item.kind === "class" && item.base !== undefined) base.set(item.name, item.base);
	const depth = (name: string): number => {
		let level = 0;
		for (let parent = base.get(name); parent !== undefined && level < 10; parent = base.get(parent)) level++;
		return level;
	};
	const catchAll = `${prefix}Error`;
	const classes = exported
		.filter((name) => name !== catchAll)
		.sort((a, b) => depth(b) - depth(a) || a.localeCompare(b))
		.map((name) => ({ tag: name, instanceOf: name, codes: [] }));
	return [...classes, { tag: catchAll, codes: scan.codes.slice(0, 20) }];
}

function pascal(name: string): string {
	return name
		.split(/[^a-zA-Z0-9]+/)
		.filter((part) => part.length > 0)
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join("");
}

function dedupeBy<A>(items: ReadonlyArray<A>, key: (item: A) => string): ReadonlyArray<A> {
	const seen = new Set<string>();
	return items.filter((item) => !seen.has(key(item)) && seen.add(key(item)) !== undefined);
}

/** A service's name: `<Prefix><Handle>`, or `<Handle>Service` when the handle already carries the prefix. */
function serviceName(prefix: string, handle: string): string {
	return handle.startsWith(prefix) ? `${handle}Service` : `${prefix}${handle}`;
}
