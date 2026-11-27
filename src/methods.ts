// Which methods and properties of a handle the facade wraps, and how: the generator writes them into the facade, and
// the docs describe the same lists.

import type { Recipe } from "./recipe.ts";
import type { Handle, Signature } from "./surface.ts";

/**
 * The methods of handle `name` the facade wraps: all upstream declares, less the recipe's `exclude`s and the members a
 * facade has of its own (`ownMembers`).
 */
export function wrappedMethods(
	name: string,
	methods: Readonly<Record<string, ReadonlyArray<Signature>>>,
	recipe: Recipe,
): ReadonlyArray<string> {
	const own = ownMembers(recipe);
	return Object.keys(methods)
		.filter((method) => recipe.methods[`${name}.${method}`] !== "exclude" && !own.has(method))
		.sort();
}

/**
 * The members a facade has of its own, so never wraps (`.upstream` still reaches upstream's): `upstream`, and for a
 * runtime facade (the runtime's `OWN_MEMBERS`) `toJSON` and `toString`, since it serialises and prints as its
 * handle's name whatever upstream's (bullmq's `Job.toJSON`) show. A frontend facade hands its mounts upstream's own
 * instances, whose members stay upstream's.
 */
function ownMembers(recipe: Recipe): ReadonlySet<string> {
	return recipe.ui === undefined ? RUNTIME_MEMBERS : FRONTEND_MEMBERS;
}

const RUNTIME_MEMBERS: ReadonlySet<string> = new Set(["upstream", "toJSON", "toString"]);

const FRONTEND_MEMBERS: ReadonlySet<string> = new Set(["upstream"]);

/**
 * The wrapped methods of handle `name` that are `kind`: as the recipe overrides them, else as the analyzer read them
 * (async when an overload returns a promise; a stream when one returns an async iterable and none a promise).
 */
export function classified(
	name: string,
	methods: Readonly<Record<string, ReadonlyArray<Signature>>>,
	recipe: Recipe,
	kind: "async" | "stream",
): ReadonlyArray<string> {
	return wrappedMethods(name, methods, recipe).filter((method) => {
		const override = recipe.methods[`${name}.${method}`];
		if (override !== undefined) return override === kind;
		const signatures = methods[method] ?? [];
		const isAsync = signatures.some((signature) => signature.traits.includes("async"));
		return kind === "async"
			? isAsync
			: !isAsync && signatures.some((signature) => signature.traits.includes("stream"));
	});
}

/**
 * The wrapped methods of handle `name` that report through a trailing callback and have no promise or iterable to
 * report through instead, with how the callback reports (`node`: error first; `done`: a call when done).
 */
export function callbackMethods(
	name: string,
	methods: Readonly<Record<string, ReadonlyArray<Signature>>>,
	recipe: Recipe,
): Readonly<Record<string, "node" | "done">> {
	const found: Record<string, "node" | "done"> = {};
	for (const method of wrappedMethods(name, methods, recipe)) {
		if (recipe.methods[`${name}.${method}`] !== undefined) continue;
		const signatures = methods[method] ?? [];
		if (!signatures.every((signature) => signature.traits.includes("callback"))) continue;
		const reports = signatures.find(
			(signature) => signature.callback === "node" || signature.callback === "done",
		)?.callback;
		if (reports === "node" || reports === "done") found[method] = reports;
	}
	return found;
}

/** Where a call takes its `AbortSignal`, as the analyzer read it. */
export type SignalSlot = NonNullable<Signature["signal"]>;

/** Where the wrapped async and stream methods of handle `name` take their `AbortSignal`. */
export function signalSlots(
	name: string,
	methods: Readonly<Record<string, ReadonlyArray<Signature>>>,
	recipe: Recipe,
): Readonly<Record<string, SignalSlot>> {
	const found: Record<string, SignalSlot> = {};
	for (const method of [
		...classified(name, methods, recipe, "async"),
		...classified(name, methods, recipe, "stream"),
	].sort()) {
		const slot = agreedSignal(methods[method] ?? []);
		if (slot !== undefined) found[method] = slot;
	}
	return found;
}

/**
 * The one place every overload that takes an `AbortSignal` takes it; undefined when none takes one, or when they
 * disagree (the runtime puts the signal at one place for every call).
 */
export function agreedSignal(signatures: ReadonlyArray<Signature>): SignalSlot | undefined {
	const slots = signatures.flatMap((signature) => (signature.signal === undefined ? [] : [signature.signal]));
	const [first] = slots;
	if (first === undefined) return undefined;
	return slots.every((slot) => slot.index === first.index && slot.property === first.property) ? first : undefined;
}

/**
 * The wrapped async methods of handle `name` whose value may be absent in every overload the facade keeps
 * (`Promise<T | null>`, `Promise<T | undefined>`): the facade resolves each to an `Option`. A method the recipe
 * overrides keeps upstream's value as it is.
 */
export function optionMethods(
	name: string,
	methods: Readonly<Record<string, ReadonlyArray<Signature>>>,
	recipe: Recipe,
): ReadonlyArray<string> {
	return classified(name, methods, recipe, "async").filter(
		(method) => recipe.methods[`${name}.${method}`] === undefined && isOptional(methods[method] ?? []),
	);
}

/**
 * Whether every signature a facade keeps (no trailing callback) resolves, or returns, a value that may be absent: a
 * union, as the checker prints it, of `null` or `undefined` and something present. A stream never is.
 */
export function isOptional(signatures: ReadonlyArray<Signature>): boolean {
	const kept = signatures.filter((signature) => !signature.traits.includes("callback"));
	return (
		kept.length > 0 &&
		kept.every(
			(signature) =>
				!signature.traits.includes("stream") && present(signature.resolves ?? signature.returns) !== undefined,
		)
	);
}

/**
 * The present part of a type that may be absent (`ElementHandle<Node> | null` gives `ElementHandle<Node>`), or
 * undefined when the type is never absent, or never present (`void`, `undefined`).
 */
export function present(type: string): string | undefined {
	const parts = topLevelUnion(type);
	if (!parts.some((part) => part === "null" || part === "undefined")) return undefined;
	const kept = parts.filter((part) => !ABSENT.has(part));
	return kept.length === 0 ? undefined : kept.join(" | ");
}

const ABSENT = new Set(["null", "undefined", "void", "never"]);

/** The members of a union type's text, split at its top-level `|`. */
function topLevelUnion(type: string): ReadonlyArray<string> {
	const parts: Array<string> = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < type.length; index++) {
		const char = type[index];
		if (char === "<" || char === "(" || char === "{" || char === "[") depth++;
		else if ((char === ">" && type[index - 1] !== "=") || char === ")" || char === "}" || char === "]") depth--;
		else if (char === "|" && depth === 0) {
			parts.push(type.slice(start, index).trim());
			start = index + 1;
		}
	}
	parts.push(type.slice(start).trim());
	return parts.filter((part) => part.length > 0);
}

/**
 * The handle a present value is (`HTTPResponse` of `HTTPResponse | null`) when `handles` has it, by the name the
 * analyzer gave it: the type's own name, generic arguments and an `import("...")` qualifier aside. The analyzer reads
 * no handle in a union, so the generator finds it here for the `Option` it wraps. A present part that is a union names
 * no one handle (the runtime's `HandleOf`).
 */
export function presentHandle(type: string, handles: Readonly<Record<string, unknown>>): string | undefined {
	const kept = present(type);
	return kept === undefined ? undefined : namedHandle(kept, handles);
}

/**
 * The handle a type's text names, by its own name, generic arguments and an `import("...")` or `Upstream.` qualifier
 * aside, when `handles` has it; none for a union, whose `A<x> | B<y>` the pattern alone would read as `A`.
 */
function namedHandle(type: string, handles: Readonly<Record<string, unknown>>): string | undefined {
	if (topLevelUnion(type).length !== 1) return undefined;
	const name = NAMED_TYPE.exec(type.trim())?.[1];
	return name !== undefined && handles[name] !== undefined ? name : undefined;
}

/**
 * The handle each wrapped method of handle `name` returns, read from the overloads the facade keeps: sharp's
 * `toBuffer(callback)` returns a `Sharp`, while the `toBuffer()` the facade runs resolves to a Buffer. A value that
 * may be absent names its handle in its type's present part (`HTTPResponse | null`): an async method's `Option`, a
 * synchronous one's facade or the absence (`ElementHandle.asElement()`), as the runtime's `Lift` types it.
 */
export function returnedHandles(
	name: string,
	methods: Readonly<Record<string, ReadonlyArray<Signature>>>,
	recipe: Recipe,
): ReadonlyArray<readonly [method: string, handle: string]> {
	const asyncMethods = classified(name, methods, recipe, "async");
	const options = optionMethods(name, methods, recipe);
	return wrappedMethods(name, methods, recipe).flatMap((method) => {
		const isAsync = asyncMethods.includes(method);
		const kept = keptSignatures(methods[method] ?? [], isAsync);
		// One handle in some overloads and a list in others (ts-morph's `addExtends(text)` and `addExtends(texts)`): no
		// one wrapping fits every call, so the method gives its value as it is, typed so.
		if (kept.some((signature) => listedHandle(signature.resolves ?? signature.returns, recipe.handles) !== undefined))
			return [];
		const into =
			kept.find((signature) => signature.handle !== undefined && recipe.handles[signature.handle] !== undefined)
				?.handle ??
			(options.includes(method) || !isAsync
				? kept
						.map((signature) => presentHandle(signature.resolves ?? signature.returns, recipe.handles))
						.find((found) => found !== undefined)
				: undefined);
		return into === undefined ? [] : [[method, into] as const];
	});
}

/**
 * The methods of `returnedHandles` that give their handle in some overloads the facade keeps and no handle in others:
 * cheerio's `html()` reads a string and `html(value)` sets it and returns the selection, `attr()` reads a record of
 * them. The runtime wraps such a result only when it has every method of the handle, as its overload's type says, and
 * gives any other value as it is (`HandleSpec.mixed`); wrapping every object would make a facade of `attr()`'s record.
 * An overload names no handle when its type's text names none, alone, absent or in an array, and the analyzer read
 * none in it; a generic one may still be a handle (ts-morph's `getFirstAncestor<T extends Node>(): T | undefined`),
 * which its type then says, and which the runtime wraps, since it has the handle's methods.
 */
export function mixedMethods(
	name: string,
	methods: Readonly<Record<string, ReadonlyArray<Signature>>>,
	recipe: Recipe,
): ReadonlyArray<string> {
	const asyncMethods = classified(name, methods, recipe, "async");
	return returnedHandles(name, methods, recipe).flatMap(([method]) =>
		keptSignatures(methods[method] ?? [], asyncMethods.includes(method)).some((signature) => {
			const type = signature.resolves ?? signature.returns;
			return (
				signature.handle === undefined &&
				signature.handles === undefined &&
				namedHandle(type, recipe.handles) === undefined &&
				presentHandle(type, recipe.handles) === undefined &&
				listedHandle(type, recipe.handles) === undefined
			);
		})
			? [method]
			: [],
	);
}

/** The signatures of a method the facade runs as it is classified (async or not), none reporting through a callback. */
function keptSignatures(signatures: ReadonlyArray<Signature>, isAsync: boolean): ReadonlyArray<Signature> {
	return signatures.filter(
		(signature) => signature.traits.includes("async") === isAsync && !signature.traits.includes("callback"),
	);
}

/**
 * The handles each wrapped method of handle `name` that returns no one handle (`returnedHandles`) may give, when the
 * result of a signature the facade keeps is a conditional of them (`Signature.handles`, puppeteer's `HandleFor<T>`),
 * each wrapped: the runtime's `HandleSpec.choices`, which the generator orders.
 */
export function chosenHandles(
	name: string,
	methods: Readonly<Record<string, ReadonlyArray<Signature>>>,
	recipe: Recipe,
): ReadonlyArray<readonly [method: string, handles: ReadonlyArray<string>]> {
	const asyncMethods = classified(name, methods, recipe, "async");
	const returned = new Set(returnedHandles(name, methods, recipe).map(([method]) => method));
	return wrappedMethods(name, methods, recipe).flatMap((method) => {
		if (returned.has(method)) return [];
		const handles = keptSignatures(methods[method] ?? [], asyncMethods.includes(method))
			// An array's items are a list's (`listedHandles`), never a choice.
			.filter((signature) => !isArrayType(signature.resolves ?? signature.returns))
			.map((signature) => signature.handles)
			.find((found) => found !== undefined && found.every((handle) => recipe.handles[handle] !== undefined));
		return handles === undefined ? [] : [[method, handles] as const];
	});
}

/**
 * The methods and properties of handle `name` whose value is an array of a wrapped handle's objects (the runtime's
 * `HandleSpec.lists`), with that handle: `Browser.pages()` (`Page[]`), a terminal's `markers` (`readonly IMarker[]`).
 * The facade gives each item's facade: an async method's the caller's unless borrowed (`borrowedMethods`; the
 * runtime's `ResolvedList`), a synchronous call's or a property's borrowed (`Listed`). A method that returns a handle,
 * may resolve to nothing (an `Option`), iterates or reports through a callback is none.
 */
export function listedHandles(
	name: string,
	handle: Handle,
	recipe: Recipe,
): ReadonlyArray<readonly [member: string, handle: string]> {
	const { methods } = handle;
	const asyncMethods = classified(name, methods, recipe, "async");
	const excluded = new Set([
		...returnedHandles(name, methods, recipe).map(([method]) => method),
		...chosenHandles(name, methods, recipe).map(([method]) => method),
		...optionMethods(name, methods, recipe),
		...classified(name, methods, recipe, "stream"),
		...Object.keys(callbackMethods(name, methods, recipe)),
	]);
	const fromMethods = wrappedMethods(name, methods, recipe).flatMap((method) => {
		if (excluded.has(method)) return [];
		// Every overload the facade keeps gives the list: one that gives another value, a list of a union
		// (`EnumDeclaration.addMembers`: `EnumMember[]`, or `(CommentEnumMember | EnumMember)[]`) or a handle, would have
		// its value wrapped as the list's, so such a method gives its value as it is, typed so.
		const found = keptSignatures(methods[method] ?? [], asyncMethods.includes(method)).map((signature) =>
			listedHandle(signature.resolves ?? signature.returns, recipe.handles, signature.handles),
		);
		const [into] = found;
		return into === undefined || found.some((other) => other !== into) ? [] : [[method, into] as const];
	});
	const fromProperties = wrappedProperties(name, handle, recipe).flatMap((property) => {
		const held = handle.properties[property];
		const into = held?.handle === undefined ? listedHandle(held?.type ?? "", recipe.handles) : undefined;
		return into === undefined ? [] : [[property, into] as const];
	});
	return [...fromMethods, ...fromProperties].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The handle an array type holds (`Page` of `Page[]`, `readonly Page[]`, `ReadonlyArray<Page>`, `Array<Page>`) when
 * `handles` has it, by its own name, generic arguments and an `import("...")` or `Upstream.` qualifier aside: what the
 * runtime's `Listed` reads from the type. Items that are a conditional of one handle (`chosen`, the analyzer's
 * `Signature.handles`: bullmq's `JobBase<T>[]`) hold that one. An array of a union (postcss's `ChildNode[]`, an alias the
 * text names, or `Array<A<x> | B<y>>` written out), or one that may be absent, holds none.
 */
export function listedHandle(
	type: string,
	handles: Readonly<Record<string, unknown>>,
	chosen: ReadonlyArray<string> = [],
): string | undefined {
	const items = ARRAY_TYPE.exec(type.trim())?.[1] ?? ARRAY_GENERIC.exec(type.trim())?.[1];
	if (items === undefined) return undefined;
	const [only, ...others] = chosen;
	return (
		namedHandle(items, handles) ??
		(only !== undefined && others.length === 0 && handles[only] !== undefined ? only : undefined)
	);
}

/** Whether a type's text is an array's, as `listedHandle` reads one. */
function isArrayType(type: string): boolean {
	return ARRAY_TYPE.test(type.trim()) || ARRAY_GENERIC.test(type.trim());
}

// A type named by itself, its qualifier and generic arguments aside: the name is the match's first group.
const NAMED = String.raw`(?:import\("[^"]*"\)\.)?(?:Upstream\.)?([\w$]+)(?:<.*>)?`;

const NAMED_TYPE = new RegExp(String.raw`^${NAMED}$`, "s");

// An array's item type, the match's first group: `Page` of `Page[]`, `readonly Page[]`, `Array<Page>`.
const ARRAY_TYPE = new RegExp(String.raw`^(?:readonly\s+)?(${NAMED})\[\]$`, "s");

const ARRAY_GENERIC = new RegExp(String.raw`^(?:Readonly)?Array<(${NAMED})>$`, "s");

/**
 * The methods of handle `name` whose releasable handle, or async list of them, the facade does not own (the runtime's
 * `HandleSpec.borrowed`): as the recipe's `borrowed` lists them, a list that wins over the rule both ways, else by the
 * engine's rule (`borrowedByRule`). Their facades leave out the handle's release methods, which are its owner's. Any
 * other method returning a releasable handle made it: an Effect acquires it in the caller's scope, each of a list it
 * resolves to too (puppeteer's `$$`), and a synchronous call hands the caller its facade, release methods and all. A
 * synchronous call's list and a property's are always borrowed, so never listed here.
 */
export function borrowedMethods(name: string, handle: Handle, recipe: Recipe): ReadonlyArray<string> {
	const effects = effectMethods(name, handle.methods, recipe);
	const asyncMethods = classified(name, handle.methods, recipe, "async");
	// A choice (`chosenHandles`) is releasable when any handle of it is, and borrowed by the rule when any is.
	return [
		...returnedHandles(name, handle.methods, recipe).map(([method, into]) => [method, [into]] as const),
		...chosenHandles(name, handle.methods, recipe),
		...listedHandles(name, handle, recipe)
			.filter(([member]) => asyncMethods.includes(member))
			.map(([member, into]) => [member, [into]] as const),
	]
		.filter(
			([method, intos]) =>
				intos.some((into) => recipe.handles[into]?.release !== undefined) &&
				(recipe.borrowed?.includes(`${name}.${method}`) ??
					intos.some((into) => borrowedByRule(name, handle, method, into, effects.includes(method)))),
		)
		.map(([method]) => method)
		.sort();
}

/** The lookups of handle `name`: its borrowed methods that are Effects, of a handle upstream already holds. */
export function lookupMethods(name: string, handle: Handle, recipe: Recipe): ReadonlyArray<string> {
	const effects = effectMethods(name, handle.methods, recipe);
	return borrowedMethods(name, handle, recipe).filter((method) => effects.includes(method));
}

/** The wrapped methods of handle `name` the facade runs as an Effect or a Stream: async, iterating or reporting through a callback. */
function effectMethods(
	name: string,
	methods: Readonly<Record<string, ReadonlyArray<Signature>>>,
	recipe: Recipe,
): ReadonlyArray<string> {
	return [
		...classified(name, methods, recipe, "async"),
		...classified(name, methods, recipe, "stream"),
		...Object.keys(callbackMethods(name, methods, recipe)),
	];
}

/**
 * Whether the engine's rule reads method `method` of handle `name`, returning releasable handle `into`, as borrowed:
 * what decides for a recipe without a `borrowed` list, and what the draft proposes for one. The types cannot tell a
 * handle a call makes from one upstream already holds; the rule guesses. A lookup by name (`isLookup`), Effect or not.
 * For a synchronous method (`effect` false), also the receiver itself: a method of `name` returning `name`, since the
 * analyzer reads a method through its handle's type, which turns a declared `this` into the handle (bullmq's
 * `Queue.on`, puppeteer's `ElementHandle.move`), unless it is named a copy (`clone`, `copy`, `duplicate`), which makes
 * a new one; and a handle of a type the receiver holds as a property.
 */
export function borrowedByRule(name: string, handle: Handle, method: string, into: string, effect: boolean): boolean {
	if (isLookup(method, into)) return true;
	if (effect) return false;
	return (
		(into === name && !/^(?:clone|copy|duplicate)(?![a-z])/.test(method)) ||
		Object.values(handle.properties).some((property) => property.handle === into)
	);
}

/**
 * The methods that release handle `name`, for a releasable one: its recipe's `release`, and every other method the
 * analyzer read as releasing it (Browser's `disconnect`) that the facade wraps. A borrowed facade leaves out those the
 * types say are no step (`keptReleases`).
 */
export function releaseMethods(name: string, handle: Handle, recipe: Recipe): ReadonlyArray<string> {
	const release = recipe.handles[name]?.release;
	if (release === undefined) return [];
	const wrapped = wrappedMethods(name, handle.methods, recipe);
	return [...new Set([release, ...handle.releases.filter((method) => wrapped.includes(method))])].sort();
}

/**
 * The release methods of handle `name` (`releaseMethods`) a borrowed facade keeps, since the types cannot tell them
 * from a step (`hiddenWhenBorrowed`, read against the surface's `handles`); it leaves out every other one.
 */
export function keptReleases(
	name: string,
	handle: Handle,
	handles: Readonly<Record<string, unknown>>,
	recipe: Recipe,
): ReadonlyArray<string> {
	return releaseMethods(name, handle, recipe).filter(
		(method) => !hiddenWhenBorrowed(handle.methods[method] ?? [], handles),
	);
}

/**
 * Whether a borrowed facade, which never releases its handle, leaves out a release method with `signatures`: only when
 * the types make it certain the method is no step of a traversal. So every signature gives no handle of `handles`
 * (void, a boolean, a promise of those, or any value the facade gives as it is: no handle the analyzer read, `handle`
 * or a choice of `handles`, and none alone, absent or in a list by its text, `presentHandle`, `listedHandle`), or gives
 * its receiver as upstream declares it, `this` or a promise of it (`Signature.receiver`: Node's `Server.close(): this`).
 * A release whose result names a handle by its class stays on a borrowed facade, as every release did in 0.3.0: zmq's
 * `Socket.close(): Socket` closes the socket and returns it, cheerio's `end(): Cheerio<AnyNode>` steps back to another
 * selection, and the types cannot tell them apart, while hiding a step would break every traversal of a borrowed one.
 */
export function hiddenWhenBorrowed(
	signatures: ReadonlyArray<Signature>,
	handles: Readonly<Record<string, unknown>>,
): boolean {
	return signatures.every((signature) => {
		const type = signature.resolves ?? signature.returns;
		return (
			signature.receiver === true ||
			(signature.handle === undefined &&
				signature.handles === undefined &&
				presentHandle(type, handles) === undefined &&
				listedHandle(type, handles, signature.handles) === undefined)
		);
	});
}

/**
 * Whether a method that resolves to a handle looks one up rather than makes one: its name, past a `get`, `find`,
 * `waitFor` or `as`, is the handle's, or its plural (`page`, `pages`, `asPage` for a `Page`, `waitForTarget` for a
 * `Target`). `newPage` and `createBrowserContext` make theirs. The types cannot tell the two apart; the draft
 * proposes these lookups for the recipe's `borrowed`.
 */
function isLookup(method: string, handle: string): boolean {
	const named = lowerFirst(method.replace(/^(?:get|find|waitFor|as)(?=[A-Z])/, ""));
	const noun = lowerFirst(handle);
	return named === noun || named === `${noun}s`;
}

function lowerFirst(name: string): string {
	return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

/**
 * The properties of handle `name` the facade reads through: all the analyzer read, less `exclude`s and the members a
 * facade has of its own.
 */
export function wrappedProperties(name: string, handle: Handle, recipe: Recipe): ReadonlyArray<string> {
	const own = ownMembers(recipe);
	return Object.keys(handle.properties)
		.filter((property) => !own.has(property) && recipe.methods[`${name}.${property}`] !== "exclude")
		.sort();
}
