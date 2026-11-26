// The surface of a library: what its types expose, as the analyzer reads it with TypeScript 7's checker. It is the
// engine's one model of upstream: the recipe is drafted from it, the facade generated from it, and drift is the
// difference between two of them. It is stored as JSON, so it is a Schema.

import { Schema } from "effect";
import { Element } from "./elements.ts";

/** What a signature does, as far as the types tell. */
export const Trait = Schema.Literals([
	"async", // returns a promise
	"stream", // returns an async iterable
	"callback", // reports through a trailing callback and returns nothing
	"signal", // takes an AbortSignal somewhere in its parameters
	"returns-this", // returns the object it was called on (a builder)
	"sync", // none of the above
]);
export type Trait = typeof Trait.Type;

/** One call signature, printed by the checker. */
export const Signature = Schema.Struct({
	/** The type parameter list as declared, defaults and constraints included (`T = DefaultLogFields`), when generic. */
	typeParameters: Schema.optional(Schema.String),
	parameters: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String, optional: Schema.Boolean, rest: Schema.Boolean })),
	/** Whether the last parameter is a callback (the facade's own signatures leave it out). */
	trailingCallback: Schema.Boolean,
	/**
	 * What a trailing callback of a call that returns nothing is: `node`, called with an error first and then the
	 * result; `done`, called with nothing when the work is done (xterm's `write(data, callback)`); or `handler`, an
	 * argument like any other that upstream calls for its own reasons (a key handler).
	 */
	callback: Schema.optional(Schema.Literals(["node", "done", "handler"])),
	returns: Schema.String,
	/** For an async signature, the type the promise resolves to. */
	resolves: Schema.optional(Schema.String),
	/** The handle the call produces (awaited), when it produces one. */
	handle: Schema.optional(Schema.String),
	/**
	 * Where the call takes an `AbortSignal`: the parameter at `index`, or its `property` when that parameter is an
	 * options object (`{ signal }`). The facade puts there a signal that interrupting the call's fiber aborts.
	 */
	signal: Schema.optional(Schema.Struct({ index: Schema.Number, property: Schema.optional(Schema.String) })),
	traits: Schema.Array(Trait),
});
export type Signature = typeof Signature.Type;

/** An object the library hands out and the facade wraps: a class or interface with methods. */
export const Handle = Schema.Struct({
	name: Schema.String,
	/** How generated code names the upstream type, relative to `import * as Upstream`. */
	typeRef: Schema.String,
	methods: Schema.Record(Schema.String, Schema.Array(Signature)),
	/** Its public properties (fields and getters) the target declares, with the handle a property holds, if any. */
	properties: Schema.Record(Schema.String, Schema.Struct({ type: Schema.String, handle: Schema.optional(Schema.String) })),
	/** Event names, when the handle is an event emitter whose `on` names them in its types. */
	events: Schema.Array(Schema.String),
	/** Methods that look like they release the handle (`close`, `quit`, `destroy`...). */
	releases: Schema.Array(Schema.String),
});
export type Handle = typeof Handle.Type;

/** One value export of the library's entry. */
export const Export = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("function"), name: Schema.String, signatures: Schema.Array(Signature) }),
	Schema.Struct({
		kind: Schema.Literal("class"),
		name: Schema.String,
		handle: Schema.String,
		/** Its public constructors: none when the constructor is private or protected (instances come from statics). */
		constructors: Schema.Array(Signature),
		/** Its public static methods the target declares, by name (`ModelRuntime.create`). */
		statics: Schema.optional(Schema.Record(Schema.String, Schema.Array(Signature))),
		/** Whether instances are errors (the class extends `Error`). */
		error: Schema.Boolean,
		/** For an error class: the public fields it declares beyond `Error`'s (`status`, `body`), with their types. */
		fields: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String, optional: Schema.Boolean }))),
		/** The class it extends, when that is declared by the target too. */
		base: Schema.optional(Schema.String),
	}),
	Schema.Struct({
		kind: Schema.Literal("value"),
		name: Schema.String,
		type: Schema.String,
		/** A `const enum`: inlined at compile time, it exists in no JavaScript a facade could re-export. */
		constEnum: Schema.optional(Schema.Literal(true)),
	}),
]);
export type Export = typeof Export.Type;

/** Everything the analyzer read from one version of one package. */
export const Surface = Schema.Struct({
	package: Schema.String,
	version: Schema.String,
	/** Where the types came from: the package itself, or DefinitelyTyped. */
	types: Schema.Struct({ from: Schema.Literals(["bundled", "definitely-typed"]), package: Schema.String, version: Schema.String }),
	/** How the entry exports: named exports, or one callable `export =` (named after the package). */
	entry: Schema.Literals(["named", "callable"]),
	exports: Schema.Array(Export),
	handles: Schema.Record(Schema.String, Handle),
	typeExports: Schema.Array(Schema.String),
	/** For a web-component library: the elements its Custom Elements Manifest declares. */
	elements: Schema.optional(Schema.Array(Element)),
});
export type Surface = typeof Surface.Type;

/** Reads a stored surface; files are a trust boundary. */
export const decodeSurface = Schema.decodeUnknownEffect(Schema.fromJsonString(Surface));
