// Secrets and brands as the generator writes them: the places a recipe names (`createTransport` -> `0.auth.pass`,
// `JobId` -> `Job.id`, `Queue.getJob(0)`, `Mail.sendMail().messageId`), the type rewrites a facade's signatures take
// for them (`Effectify.Redacting`, `Effectify.Branding`, `Effectify.Branded`, `Effectify.ResolvingBranded`), the
// runtime's secret paths, and the compile-time check that every place is a string in upstream's own types.

import type { Recipe } from "./recipe.ts";
import { type Export, isIdentifierName, type Surface } from "./surface.ts";

/** One rewrite of a call's parameters or result: a path (an argument's index first, for a parameter) and its leaf. */
export interface Rewrite {
	readonly path: ReadonlyArray<string>;
	/** `redacted` for a secret, else the brand's name. */
	readonly leaf: string;
}

/** One place the recipe names for a brand, read from its text. */
export type BrandPlace =
	| {
			readonly kind: "property";
			readonly brand: string;
			readonly owner: string;
			readonly member: string;
			readonly place: string;
	  }
	| {
			readonly kind: "parameter" | "result";
			readonly brand: string;
			readonly call: string;
			readonly path: ReadonlyArray<string>;
			readonly place: string;
	  }
	| { readonly kind: "unreadable"; readonly brand: string; readonly place: string };

/** The brand places of the recipe: `Handle.property`, `call(<index>)[.path]` or `call()[.path]`. */
export function brandPlaces(recipe: Recipe): ReadonlyArray<BrandPlace> {
	return Object.entries(recipe.brands ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([brand, places]) => places.map((place) => brandPlace(brand, place)));
}

function brandPlace(brand: string, place: string): BrandPlace {
	const found = /^([\w$]+)(?:\.([\w$]+))?(?:\((\d*)\))?((?:\.[\w$]+)*)$/.exec(place);
	if (found === null) return { kind: "unreadable", brand, place };
	const [, owner = "", member, index, rest = ""] = found;
	const fields = rest.split(".").filter((field) => field !== "");
	if (index === undefined) {
		return member === undefined || fields.length > 0
			? { kind: "unreadable", brand, place }
			: { kind: "property", brand, owner, member, place };
	}
	const call = member === undefined ? owner : `${owner}.${member}`;
	return index === ""
		? { kind: "result", brand, call, path: fields, place }
		: { kind: "parameter", brand, call, path: [index, ...fields], place };
}

/** The rewrites a call's parameters take: each secret (`redacted`), and each brand of a parameter. */
export function parameterRewrites(recipe: Recipe, call: string): ReadonlyArray<Rewrite> {
	const secrets = secretPaths(recipe, call).map((path) => ({ path, leaf: "redacted" }));
	const brands = brandPlaces(recipe).flatMap((place) =>
		place.kind === "parameter" && place.call === call ? [{ path: place.path, leaf: place.brand }] : [],
	);
	return [...secrets, ...brands];
}

/** The brands of what a call resolves to, each a path into its value. */
export function resultRewrites(recipe: Recipe, call: string): ReadonlyArray<Rewrite> {
	return brandPlaces(recipe).flatMap((place) =>
		place.kind === "result" && place.call === call ? [{ path: place.path, leaf: place.brand }] : [],
	);
}

/** The brand of a property a handle reads through, if the recipe names one. */
export function propertyBrand(recipe: Recipe, owner: string, member: string): string | undefined {
	return brandPlaces(recipe).find(
		(place) => place.kind === "property" && place.owner === owner && place.member === member,
	)?.brand;
}

/**
 * Rewrites as the runtime's type: `Effectify.Redacting<...>` for the secrets, one `Effectify.Branding<..., Brand>`
 * per brand; the paths of each a union of tuples.
 */
export function rewritesType(rewrites: ReadonlyArray<Rewrite>): string {
	const leaves = [...new Set(rewrites.map((rewrite) => rewrite.leaf))];
	return leaves
		.map((leaf) => {
			const paths = pathsType(rewrites.filter((rewrite) => rewrite.leaf === leaf).map((rewrite) => rewrite.path));
			return leaf === "redacted" ? `Effectify.Redacting<${paths}>` : `Effectify.Branding<${paths}, ${leaf}>`;
		})
		.join(" | ");
}

/** Paths as a type: `readonly ["0", "auth", "pass"] | ...`. */
export function pathsType(paths: ReadonlyArray<ReadonlyArray<string>>): string {
	return paths.map((path) => `readonly [${path.map((step) => JSON.stringify(step)).join(", ")}]`).join(" | ");
}

/** The secret paths the recipe names for one call (`createTransport`, `Mail.sendMail`), each split into its steps. */
export function secretPaths(recipe: Recipe, key: string): ReadonlyArray<ReadonlyArray<string>> {
	return (recipe.secrets?.[key] ?? []).map((path) => path.split("."));
}

/**
 * Where a property may hold a secret the recipe names: each secret path past its argument's index, once (`auth.pass`
 * of `createTransport`'s `0.auth.pass`), calls in name order. Upstream keeps what it was given (a transport's
 * `options`); a secret that is a whole argument (`1`) names no path inside a property.
 */
export function concealedPaths(recipe: Recipe): ReadonlyArray<ReadonlyArray<string>> {
	const found = new Map<string, ReadonlyArray<string>>();
	for (const [, paths] of Object.entries(recipe.secrets ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
		for (const path of paths) {
			const steps = path.split(".").slice(1);
			if (steps.length > 0 && !found.has(steps.join("."))) found.set(steps.join("."), steps);
		}
	}
	return [...found.values()];
}

/** Secret paths as the runtime's value: `[["0", "auth", "pass"], ...]`. */
export function secretsValue(paths: ReadonlyArray<ReadonlyArray<string>>): string {
	return `[${paths.map((path) => `[${path.map((step) => JSON.stringify(step)).join(", ")}]`).join(", ")}]`;
}

/** The brands' Schemas and types, exported: `Schema.String.pipe(Schema.brand("JobId"))`. */
export function brandsSource(recipe: Recipe): ReadonlyArray<string> {
	return Object.entries(recipe.brands ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([brand, places]) => [
			`/** A ${recipe.package} \`${brand}\` (${places.map((place) => `\`${place}\``).join(", ")}): a string branded so it mixes with no other; \`${brand}.make(value)\` brands one. */`,
			`export const ${brand} = Schema.String.pipe(Schema.brand(${JSON.stringify(brand)}));`,
			`/** A ${recipe.package} \`${brand}\`, as \`${brand}\` brands it. */`,
			`export type ${brand} = typeof ${brand}.Type;`,
			"",
		]);
}

/** The names of the facade's brands. */
export function brandNames(recipe: Recipe): ReadonlyArray<string> {
	return Object.keys(recipe.brands ?? {});
}

/**
 * The compile-time check of every secret and brand place the recipe names: each must reach a string in upstream's
 * own types (some overload, some union member), else its line fails to compile and names the place. A call the
 * facade does not offer, a place it cannot read, or a result brand on a call typed by its written-out overloads
 * (whose type parameters a rewrite would lose) fails the same way.
 */
export function rewriteChecks(
	surface: Surface,
	recipe: Recipe,
	wrapped: ReadonlyArray<string>,
	written: ReadonlySet<string>,
): ReadonlyArray<string> {
	const offered = surface.exports.filter((item) => recipe.exports.includes(item.name));
	const secrets = Object.entries(recipe.secrets ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([call, paths]) =>
			paths.map((path) =>
				check(callParameters(call, offered, surface, wrapped), path.split("."), `secret: ${call} ${path}`),
			),
		);
	const brands = brandPlaces(recipe).map((place) => {
		const marker = `brand: ${place.brand} ${place.place}`;
		if (place.kind === "unreadable")
			return `\tEffectify.Expect<false>, // ${marker} is no place (\`Handle.property\`, \`call(<index>).path\`, \`call().path\`)`;
		if (place.kind === "property") {
			const handle = wrapped.includes(place.owner) ? surface.handles[place.owner] : undefined;
			return check(
				handle?.properties[place.member] === undefined
					? undefined
					: `${handle.typeRef}[${JSON.stringify(place.member)}]`,
				[],
				marker,
			);
		}
		if (place.kind === "parameter")
			return check(callParameters(place.call, offered, surface, wrapped), place.path, marker);
		if (written.has(place.call))
			return `\tEffectify.Expect<false>, // ${marker}: a call typed by its written-out overloads takes no result brand`;
		const parameters = callParameters(place.call, offered, surface, wrapped);
		return check(
			parameters === undefined
				? undefined
				: `Awaited<ReturnType<${callFunction(place.call, offered, surface, wrapped)}>>`,
			place.path,
			marker,
		);
	});
	const checks = [...secrets, ...brands];
	if (checks.length === 0) return [];
	return [
		"/** Every secret and brand place the recipe names is a string in upstream's types: one that is not fails to compile here. */",
		"type CheckedPlaces = [",
		...checks,
		"];",
		"",
	];
}

function check(type: string | undefined, path: ReadonlyArray<string>, marker: string): string {
	return type === undefined
		? `\tEffectify.Expect<false>, // ${marker} names no call or property the facade offers`
		: `\tEffectify.Expect<Effectify.ReachesString<${type}, ${pathsType([path])}>>, // ${marker}`;
}

/** The parameters of the call a key names, as a type of every overload's tuple; undefined for no such call. */
function callParameters(
	key: string,
	offered: ReadonlyArray<Export>,
	surface: Surface,
	wrapped: ReadonlyArray<string>,
): string | undefined {
	const item = offered.find((candidate) => candidate.name === key);
	if (item?.kind === "class") return `ConstructorParameters<typeof Upstream${access(key)}>`;
	const fn = callFunction(key, offered, surface, wrapped);
	return fn === undefined ? undefined : `Parameters<${fn}>`;
}

/** Every overload of the function a key names (an export, a static, a handle's method), as a union; undefined for none. */
function callFunction(
	key: string,
	offered: ReadonlyArray<Export>,
	surface: Surface,
	wrapped: ReadonlyArray<string>,
): string | undefined {
	const [owner = "", member] = key.split(".");
	const item = offered.find((candidate) => candidate.name === owner);
	if (member === undefined)
		return item?.kind === "function" ? `Effectify.Overloads<typeof Upstream${access(owner)}>` : undefined;
	if (item?.kind === "class" && item.statics?.[member] !== undefined)
		return `Effectify.Overloads<typeof Upstream${access(owner)}${access(member)}>`;
	const handle = wrapped.includes(owner) ? surface.handles[owner] : undefined;
	return handle?.methods[member] === undefined
		? undefined
		: `Effectify.Overloads<${handle.typeRef}[${JSON.stringify(member)}]>`;
}

function access(name: string): string {
	return isIdentifierName(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}
