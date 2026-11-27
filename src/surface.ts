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
	parameters: Schema.Array(
		Schema.Struct({ name: Schema.String, type: Schema.String, optional: Schema.Boolean, rest: Schema.Boolean }),
	),
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
	 * The handles a call produces when its result is a conditional type that is one of them in every branch, chosen by
	 * the call's type arguments (puppeteer's `HandleFor<T>`: `ElementHandle` or `JSHandle`), sorted: the result itself,
	 * its part beside `null` or `undefined`, or its array's items (bullmq's `JobBase<T> | undefined`, `JobBase<T>[]`),
	 * which the result's text tells apart. No `handle` then.
	 */
	handles: Schema.optional(Schema.Array(Schema.String)),
	/**
	 * Whether the call gives the object it was called on: upstream declares its result `this`, or a promise of it. Only
	 * the declaration tells: the checker prints `this` as the handle's own type wherever it reads the method through a
	 * generic handle or one that inherits it (chart.js's `Chart.stop(): this` prints `Chart<TType, TData, TLabel>`), as
	 * it prints a call that gives another object of that type (cheerio's `end()`, the selection before the last step).
	 * Read only by the rule that hides a release from a borrowed facade (`hiddenWhenBorrowed`).
	 */
	receiver: Schema.optional(Schema.Boolean),
	/**
	 * Where the call takes an `AbortSignal`: the parameter at `index`, or its `property` when that parameter is an
	 * options object (`{ signal }`). The facade puts there a signal that interrupting the call's fiber aborts.
	 */
	signal: Schema.optional(Schema.Struct({ index: Schema.Number, property: Schema.optional(Schema.String) })),
	traits: Schema.Array(Trait),
});
export type Signature = typeof Signature.Type;

/**
 * The names of methods that release what they are called on, in the order the draft prefers one as a handle's release.
 * Every release the analyzer reads and the draft offers is one of them (`isRelease`): a name that also means other
 * things is none, since the scope's finalizer would call it on what the program still holds (postcss's `remove`
 * takes a node out of its tree, protobuf.js's `remove(object)` a child out of its namespace; puppeteer's `detach`).
 */
export const RELEASE_NAMES: ReadonlyArray<string> = [
	"close",
	"quit",
	"disconnect",
	"destroy",
	"shutdown",
	"terminate",
	"stop",
	"end",
	"dispose",
	"release",
];

/**
 * Whether method `name` of a handle, with its `signatures`, may release it: it is named so (`RELEASE_NAMES`), and the
 * scope's finalizer can call it as it calls a release, with no argument: a signature without a required parameter, or,
 * of a method that reports through its trailing callback in every signature (the runtime then gives it one), one whose
 * only required parameter is that callback. Bullmq's `ChildPool.release(child)` releases a child, not the pool. What
 * it gives decides nothing here: the types cannot tell zmq's `Socket.close(): Socket`, which closes the socket and
 * returns it, from cheerio's `end(): Cheerio<AnyNode>`, which steps back to another selection, so both are releases,
 * as in 0.3.0; what a borrowed facade does with each is `hiddenWhenBorrowed`'s.
 */
export function isRelease(name: string, signatures: ReadonlyArray<Signature>): boolean {
	if (!RELEASE_NAMES.includes(name)) return false;
	const reporting = signatures.length > 0 && signatures.every((signature) => signature.traits.includes("callback"));
	return signatures.some((signature) => {
		const required = signature.parameters.filter((parameter) => !parameter.optional && !parameter.rest);
		return (
			required.length === 0 ||
			(reporting &&
				signature.trailingCallback &&
				required.length === 1 &&
				required[0] === signature.parameters.at(-1))
		);
	});
}

/** An object the library hands out and the facade wraps: a class or interface with methods. */
export const Handle = Schema.Struct({
	name: Schema.String,
	/** How generated code names the upstream type, relative to `import * as Upstream`. */
	typeRef: Schema.String,
	methods: Schema.Record(Schema.String, Schema.Array(Signature)),
	/**
	 * Its methods upstream declares optional (`refresh?(): Promise<void>`), which an object of it may lack; absent when it
	 * has none, and from a surface studied before the analyzer read them, whose methods then all count as required.
	 */
	optional: Schema.optional(Schema.Array(Schema.String)),
	/** Its public properties (fields and getters) the target declares, with the handle a property holds, if any. */
	properties: Schema.Record(
		Schema.String,
		Schema.Struct({ type: Schema.String, handle: Schema.optional(Schema.String) }),
	),
	/** Event names, when the handle is an event emitter whose `on` names them in its types. */
	events: Schema.Array(Schema.String),
	/**
	 * Methods that look like they release the handle (`close`, `quit`, `destroy`...: `isRelease`), whatever they give. A
	 * surface studied before engine 0.4.0 may list one that takes an argument, which the draft never offers.
	 */
	releases: Schema.Array(Schema.String),
});
export type Handle = typeof Handle.Type;

/**
 * Why Node cannot import an export by name, though the declarations give it as a value: `declarations`, it exists in
 * no JavaScript (a `const enum`, a namespace of types and const enums only, inlined at compile time); `runtime`,
 * importing the package in Node gives no export of that name (a bundled `.d.ts` re-exporting another package's
 * namespace, as puppeteer's `Session`; a CommonJS module whose named exports Node's lexer cannot see, as sharp's
 * `block`). A facade never re-exports such a name: the re-export would fail it as it loads.
 */
export const Erased = Schema.optional(Schema.Literals(["declarations", "runtime"]));

/** One value export of the library's entry. */
export const Export = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("function"),
		name: Schema.String,
		signatures: Schema.Array(Signature),
		erased: Erased,
	}),
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
		fields: Schema.optional(
			Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String, optional: Schema.Boolean })),
		),
		/** The class it extends, when that is declared by the target too. */
		base: Schema.optional(Schema.String),
		erased: Erased,
	}),
	Schema.Struct({ kind: Schema.Literal("value"), name: Schema.String, type: Schema.String, erased: Erased }),
]);
export type Export = typeof Export.Type;

/** Everything the analyzer read from one version of one package. */
export const Surface = Schema.Struct({
	package: Schema.String,
	version: Schema.String,
	/** Where the types came from: the package itself, or DefinitelyTyped. */
	types: Schema.Struct({
		from: Schema.Literals(["bundled", "definitely-typed"]),
		package: Schema.String,
		version: Schema.String,
	}),
	/** How the entry exports: named exports, or one callable `export =` (named after the package). */
	entry: Schema.Literals(["named", "callable"]),
	exports: Schema.Array(Export),
	handles: Schema.Record(Schema.String, Handle),
	typeExports: Schema.Array(Schema.String),
	/**
	 * What importing the package in Node showed `study` (engine 0.4.0 on): `imported`, so every export Node cannot
	 * import by name is marked `erased`; `unimportable`, Node imported no build of it (a library that needs a browser
	 * as it loads), so only what the declarations erase is marked. A surface without it, studied before 0.4.0, tells
	 * nothing of the run time, and its facade re-exports none of upstream's values (`valueExports`).
	 */
	runtime: Schema.optional(Schema.Literals(["imported", "unimportable"])),
	/** For a web-component library: the elements its Custom Elements Manifest declares. */
	elements: Schema.optional(Schema.Array(Element)),
});
export type Surface = typeof Surface.Type;

/** Reads a stored surface; files are a trust boundary. */
export const decodeSurface = Schema.decodeUnknownEffect(Schema.fromJsonString(Surface));

/**
 * Whether an upstream name is an identifier name, which code may write bare: `Upstream.name`, `{ name }`, `export {
 * name }`. An export named by a string (`export { x as "review-sentinel" }`, ES2022) is none: code writes it as its
 * string where one may stand (`Upstream["review-sentinel"]`, `export { "review-sentinel" } from`).
 */
export function isIdentifierName(name: string): boolean {
	return /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u.test(name);
}
