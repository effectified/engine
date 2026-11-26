// Which methods and properties of a handle the facade wraps, and how: the generator writes them into the facade, and
// the docs describe the same lists.

import type { Recipe } from "./recipe.ts";
import type { Handle, Signature } from "./surface.ts";

/** The methods of handle `name` the facade wraps: all upstream declares, less the recipe's `exclude`s. */
export function wrappedMethods(name: string, methods: Readonly<Record<string, ReadonlyArray<Signature>>>, recipe: Recipe): ReadonlyArray<string> {
	return Object.keys(methods)
		.filter((method) => recipe.methods[`${name}.${method}`] !== "exclude")
		.sort();
}

/**
 * The wrapped methods of handle `name` that are `kind`: as the recipe overrides them, else as the analyzer read them
 * (async when an overload returns a promise; a stream when one returns an async iterable and none a promise).
 */
export function classified(name: string, methods: Readonly<Record<string, ReadonlyArray<Signature>>>, recipe: Recipe, kind: "async" | "stream"): ReadonlyArray<string> {
	return wrappedMethods(name, methods, recipe).filter((method) => {
		const override = recipe.methods[`${name}.${method}`];
		if (override !== undefined) return override === kind;
		const signatures = methods[method] ?? [];
		const isAsync = signatures.some((signature) => signature.traits.includes("async"));
		return kind === "async" ? isAsync : !isAsync && signatures.some((signature) => signature.traits.includes("stream"));
	});
}

/**
 * The wrapped methods of handle `name` that report through a trailing callback and have no promise or iterable to
 * report through instead, with how the callback reports (`node`: error first; `done`: a call when done).
 */
export function callbackMethods(name: string, methods: Readonly<Record<string, ReadonlyArray<Signature>>>, recipe: Recipe): Readonly<Record<string, "node" | "done">> {
	const found: Record<string, "node" | "done"> = {};
	for (const method of wrappedMethods(name, methods, recipe)) {
		if (recipe.methods[`${name}.${method}`] !== undefined) continue;
		const signatures = methods[method] ?? [];
		if (!signatures.every((signature) => signature.traits.includes("callback"))) continue;
		const reports = signatures.find((signature) => signature.callback === "node" || signature.callback === "done")?.callback;
		if (reports === "node" || reports === "done") found[method] = reports;
	}
	return found;
}

/** Where a call takes its `AbortSignal`, as the analyzer read it. */
export type SignalSlot = NonNullable<Signature["signal"]>;

/** Where the wrapped async and stream methods of handle `name` take their `AbortSignal`. */
export function signalSlots(name: string, methods: Readonly<Record<string, ReadonlyArray<Signature>>>, recipe: Recipe): Readonly<Record<string, SignalSlot>> {
	const found: Record<string, SignalSlot> = {};
	for (const method of [...classified(name, methods, recipe, "async"), ...classified(name, methods, recipe, "stream")].sort()) {
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

/** The properties of handle `name` the facade reads through: all the analyzer read, less `exclude`s and `upstream`. */
export function wrappedProperties(name: string, handle: Handle, recipe: Recipe): ReadonlyArray<string> {
	return Object.keys(handle.properties)
		.filter((property) => property !== "upstream" && recipe.methods[`${name}.${property}`] !== "exclude")
		.sort();
}
