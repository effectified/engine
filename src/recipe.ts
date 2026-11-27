// The recipe: every decision a facade needs that the types cannot make. Which exports the facade offers, which
// handles it wraps and how each is released, which events become streams, how failures map to tagged errors, and
// which handles become services. The engine drafts one from a surface and a scan; an agent or a person reviews each
// decision, and the generator reads nothing else. A redraft keeps what an agent or a person decided.

import { Effect, Schema } from "effect";
import { borrowedByRule, hiddenWhenBorrowed, listedHandle, presentHandle } from "./methods.ts";
import type { Scan } from "./scan.ts";
import {
	type Export,
	type Handle,
	isIdentifierName,
	isRelease,
	RELEASE_NAMES,
	type Signature,
	type Surface,
} from "./surface.ts";

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
	types: Schema.Struct({
		from: Schema.Literals(["bundled", "definitely-typed"]),
		package: Schema.String,
		version: Schema.String,
	}),
	/** The facade's npm name. */
	name: Schema.String,
	/** The prefix of the facade's own names: its catch-all error is `<prefix>Error`. */
	prefix: Schema.String,
	/**
	 * One line on what the facade shows of its library (`a builder that is also a Node stream`), written by an agent
	 * or a person: the facade's README, skill and page lead with it, and a redraft keeps it.
	 */
	tagline: Schema.optional(Schema.String),
	/** Exported functions and classes the facade offers. */
	exports: Schema.Array(Schema.String),
	/**
	 * Upstream's values the facade re-exports as they are, needing no wrapping: constants, synchronous functions that
	 * make no handle, and classes with nothing async, streamed, reported through a callback or released. Unset, the
	 * engine's list (`passthroughCandidates`); a name the facade declares itself, or one the surface marks `erased`
	 * (Node cannot import it by name, so the facade would fail as it loads), is never re-exported.
	 */
	passthrough: Schema.optional(Schema.Array(Schema.String)),
	handles: Schema.Record(Schema.String, HandleRecipe),
	errors: Schema.Array(ErrorRecipe),
	/** Handles provided as `Context.Service`s, with the export that acquires one. */
	services: Schema.Array(Schema.Struct({ name: Schema.String, handle: Schema.String, acquire: Schema.String })),
	/**
	 * Per-method overrides by `<Handle>.<method>`. `reconcile` writes those the compiler demands (where upstream's
	 * types and the analyzer read a method differently); an agent or a person may add `exclude`s. A frontend
	 * facade excludes an element by `<tag>`, a property by `<tag>.<property>` and an event by `<tag>@<event>`.
	 */
	methods: Schema.Record(Schema.String, MethodOverride),
	/**
	 * Secrets upstream takes, by call (`<export>`, `<Class>` for its constructor, `<Handle>.<method>`, `<Class>.<static>`)
	 * and path (`0.auth.pass`: the argument's index, then property names). The facade takes each as upstream types it
	 * or as `Redacted` (from `Config.redacted`), and reveals it to upstream only in the call; the generated code
	 * checks every path reaches a string in upstream's types. A property the facade reads through shows the secret as
	 * `Redacted` again where upstream keeps it at the same path (a transport's `options.auth.pass`); a property that
	 * keeps it in another shape (a signer made of the key) is left out (`methods`: `"<Handle>.<property>": "exclude"`).
	 * Decided by an agent or a person from upstream's options and source.
	 */
	secrets: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
	/**
	 * Branded types for ids and keys that must not mix, by name (`JobId`), with where each applies: a property a handle
	 * reads through (`Job.id`), a parameter of a method, an export or a constructor (`Queue.getJob(0)`, with a path
	 * into an options object: `Queue.add(2).jobId`), or a field of what an async call resolves to
	 * (`Mail.sendMail().messageId`). Each is exported as `Schema.String.pipe(Schema.brand(name))`; brands are types
	 * only (the facade validates nothing), and the generated code checks every place is a string in upstream's types.
	 */
	brands: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
	/**
	 * Calls on a per-item hot path (`<Handle>.<method>`, `<export>`), run without a span (`Effect.fnUntraced`); every
	 * other Effect and Stream of the facade is traced as `<Handle>.<method>`.
	 */
	untraced: Schema.optional(Schema.Array(Schema.String)),
	/**
	 * Methods (`<Handle>.<method>`) whose releasable handle the facade does not own: a lookup of one upstream already
	 * holds (puppeteer's `Target.page()`, `Browser.waitForTarget()`, `Frame.page()`), the receiver itself (bullmq's
	 * `Queue.on`, puppeteer's `ElementHandle.move`), a handle the receiver holds. The facade wraps it without its release
	 * methods and never releases it, so the call needs no `Scope`; whoever made it releases it. Every other method
	 * returning a releasable handle made it: an Effect acquires it in the caller's scope, a synchronous call hands the
	 * caller its facade, release methods and all. The types cannot tell the two apart: the draft proposes the engine's
	 * rule (`borrowedByRule`) for a person to confirm. A list, empty too, wins over the rule both ways; unset, the rule
	 * decides. A handle a property holds is always borrowed.
	 */
	borrowed: Schema.optional(Schema.Array(Schema.String)),
	/**
	 * Generic methods (`<Handle>.<method>`) kept on the derived types, which lose their type parameters, because the
	 * explicit signature the generator writes for them does not compile (it names a type upstream does not export).
	 */
	derived: Schema.Array(Schema.String),
	/**
	 * Derived generic methods TypeScript cannot type through a call (`lifted`): type parameters whose defaults depend
	 * on each other, say. `reconcile` writes them; they keep the derived type, their type parameters as constraints.
	 */
	unlifted: Schema.optional(Schema.Array(Schema.String)),
	/**
	 * A frontend facade for Effect UI: the snapshot of @effect/ui it builds against (a commit of Effect-TS/ui on
	 * pkg.pr.new), the mounts it offers, each a module `src/mounts/<name>.ts` written by an agent or a person, and
	 * the packages those mounts import besides upstream, at upstream's own range (`@codemirror/state`: a second copy
	 * of it would reject the editor's extensions).
	 */
	ui: Schema.optional(
		Schema.Struct({
			effectUi: Schema.String,
			mounts: Schema.Array(Schema.String),
			dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
		}),
	),
	/**
	 * The facade's release within its upstream's major.minor, from 1: it starts at 1 for a new major.minor and goes up
	 * by one for every later release in it, whether upstream moved a patch or the facade was fixed. It makes the
	 * facade's npm version (`facadeVersion`), since a release is never replaced. Unset is 1.
	 */
	revision: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	/**
	 * Packages the facade's declarations name (`import("typed-query-selector/parser")` in a kept upstream type), at
	 * the range upstream depends on each: `reconcile` finds them in the emitted declarations.
	 */
	typeDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	/** Packages the facade's own tests need (a Redis client, say), added to its devDependencies by exact version. */
	testDependencies: Schema.Record(Schema.String, Schema.String),
	decisions: Schema.Array(Decision),
});
export type Recipe = typeof Recipe.Type;

/** A facade has no npm version: upstream's version is a prerelease, or no `major.minor.patch`. */
export class VersionError extends Schema.TaggedError<VersionError, { readonly brand: unique symbol }>()(
	"VersionError",
	{
		package: Schema.String,
		version: Schema.String,
		reason: Schema.String,
	},
) {}

/**
 * The facade's npm version, DefinitelyTyped's scheme: `<upstream major>.<upstream minor>.<revision - 1>`, so
 * `@effectified/nodemailer@10.6.6` is the seventh release for nodemailer 10.6, whose exact version its package depends
 * on. npm drops `+build` metadata, so a fix cannot be told from upstream's version by it. A prerelease of upstream's
 * has no such version: it would be published as a release of its major.minor.
 */
export const facadeVersion = Effect.fn("facadeVersion")(function* (recipe: Recipe) {
	const release = releaseVersion(recipe.version);
	if (release === undefined) {
		return yield* new VersionError({
			package: recipe.package,
			version: recipe.version,
			reason: recipe.version.includes("-")
				? "a prerelease: a facade's version (`<major>.<minor>.<n>`, n counting its releases for that major.minor) cannot tell it from a release, so the facade is published only for a release of upstream's"
				: "not a `major.minor.patch` version, which a facade's version (`<major>.<minor>.<n>`) is made from",
		});
	}
	return `${release.major}.${release.minor}.${(recipe.revision ?? 1) - 1}`;
});

/** The major and minor of a release's version (`10.6.1`), or nothing for a prerelease or anything else. */
function releaseVersion(version: string): { readonly major: string; readonly minor: string } | undefined {
	const [, major, minor] = /^(\d+)\.(\d+)\.\d+$/.exec(version) ?? [];
	return major === undefined || minor === undefined ? undefined : { major, minor };
}

/**
 * The revision a redraft at upstream's `version` gives the facade: the same at the same version, one more at another
 * version of the same major.minor (each is one more release the facade's version counts), and none, the first, for a
 * new major.minor or a new facade.
 */
export function redraftedRevision(previous: Recipe | undefined, version: string): number | undefined {
	if (previous === undefined) return undefined;
	if (previous.version === version) return previous.revision;
	const before = releaseVersion(previous.version);
	const after = releaseVersion(version);
	return before !== undefined && after !== undefined && before.major === after.major && before.minor === after.minor
		? (previous.revision ?? 1) + 1
		: undefined;
}

/** The repository facades live in and are released from: the engine makes them, the community keeps them there. */
export const PACKAGES_REPOSITORY = "effectified/packages";

/** A facade's directory in PACKAGES_REPOSITORY, under `targets/`: `@codemirror/view` is `codemirror__view`. */
export function targetDirectory(recipe: Recipe): string {
	return recipe.package.replace(/^@/, "").replace("/", "__");
}

/** A facade's description, the first line of its package.json, its README and its skill. */
export function description(recipe: Recipe): string {
	return recipe.ui === undefined
		? `${recipe.package} in Effect: its async calls as traced Effects, absent values as Options, its iterables as Streams, its resources scoped, its failures tagged`
		: `${recipe.package} for Effect UI: typed bindings and mounts, its events as messages, its instances scoped to their elements`;
}

/**
 * The facade's `repository` in its package.json, PACKAGES_REPOSITORY: npm publishes a package through a workflow's
 * identity only when this names the workflow's repository, and the provenance attestation it makes names it too.
 */
export function facadeRepository(recipe: Recipe): {
	readonly type: "git";
	readonly url: string;
	readonly directory: string;
} {
	return {
		type: "git",
		url: `git+https://github.com/${PACKAGES_REPOSITORY}.git`,
		directory: `targets/${targetDirectory(recipe)}/package`,
	};
}

/** The site that lists every facade, each with a page `/<slug>`. */
export const SITE = "https://effectified.dev";

/** The facade's name without its scope: `@effectified/sharp` is `sharp`. */
export function slug(recipe: Recipe): string {
	return recipe.name.replace(/^@effectified\//, "");
}

/** The tag of the facade's release at `version` (its `facadeVersion`): `<slug>-v<version>`. */
export function releaseTag(recipe: Recipe, version: string): string {
	return `${slug(recipe)}-v${version}`;
}

/** Where `effectify publish` puts a frontend facade's built demo: an asset of its GitHub release at `version`. */
export function demoUrl(recipe: Recipe, version: string): string {
	return `https://github.com/${PACKAGES_REPOSITORY}/releases/download/${releaseTag(recipe, version)}/${demoArchive(recipe, version)}`;
}

/** The file name of a frontend facade's built demo at `version`. */
export function demoArchive(recipe: Recipe, version: string): string {
	return `effectified-${slug(recipe)}-${version}-demo.tgz`;
}

/** Reads a stored recipe; files are a trust boundary. */
export const decodeRecipe = Schema.decodeUnknownEffect(Schema.fromJsonString(Recipe));

/** The Effect UI snapshot frontend facades build against: a commit of Effect-TS/ui, published on pkg.pr.new. */
export const EFFECT_UI = "2fd1a57";

/** The URL of Effect UI's snapshot build at `commit` (a recipe's `ui.effectUi`), which a frontend facade installs. */
export function effectUiUrl(commit: string): string {
	return `https://pkg.pr.new/Effect-TS/ui/@effect/ui@${commit}`;
}

/** Drafts a recipe from a surface, the scan and the package README; keeps the decisions of `previous` not made by the engine. */
export const draftRecipe = Effect.fn("draftRecipe")(function* (
	surface: Surface,
	scan: Scan,
	readme: string,
	previous: Recipe | undefined,
	frontend: boolean,
) {
	const decisions: Array<Decision> = [];
	const kept = new Map(
		(previous?.decisions ?? [])
			.filter((decision) => decision.by !== "engine")
			.map((decision) => [decision.id, decision]),
	);
	const decide = (id: string, question: string, answer: string, why: string): string => {
		const prior = kept.get(id);
		decisions.push(prior ?? { id, question, answer, why, by: "engine" });
		return prior?.answer ?? answer;
	};

	// A name and prefix once decided stay: a redraft (on `sync`) must not rename a released facade.
	const name = previous?.name ?? facadeName(surface.package);
	const prefix = previous?.prefix ?? pascal(name.slice("@effectified/".length).replace(/-(core|js|node)$/, ""));
	// A web-component library, or one already made a frontend facade, is one for Effect UI.
	const ui =
		previous?.ui ?? (surface.elements !== undefined || frontend ? { effectUi: EFFECT_UI, mounts: [] } : undefined);
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

	const passthrough = decide(
		"passthrough",
		'Which of upstream\'s values does the facade re-export as they are? ("none" for none)',
		passthroughCandidates(surface, exports).join(", ") || "none",
		"constants, synchronous functions that make no handle, and classes with nothing async, streamed, reported through a callback or released",
	);

	const handles: Record<string, HandleRecipe> = {};
	const reachable = reachableHandles(surface, exports);
	const holders = propertyHolders(surface, reachable);
	for (const name of reachable) {
		const handle = surface.handles[name];
		if (handle === undefined) continue;
		const holder = holders.get(name);
		const releases = draftReleases(handle);
		// What a borrowed view of it keeps, as the generator decides it.
		const kept = releases.filter((method) => !hiddenWhenBorrowed(handle.methods[method] ?? [], surface.handles));
		const hidden = releases.filter((method) => !kept.includes(method));
		const release = decide(
			`handles.${name}.release`,
			`Which method releases a ${name}, so acquiring one opens a scope? ("none" keeps it unscoped)`,
			releases[0] ?? "none",
			releases.length === 0
				? "its type has no release method"
				: [
						`its release methods are ${releases.join(", ")}`,
						...(holder === undefined || hidden.length === 0
							? []
							: [
									`${holder} holds it, whose borrowed view must not offer ${kept.length === 0 ? "them" : hidden.join(", ")}`,
								]),
						...(kept.length === 0
							? []
							: [
									`a borrowed ${name} keeps ${kept.join(", ")}: each gives a handle named by its class, not \`this\`, which the types cannot tell from a step to another one`,
								]),
					].join("; "),
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
		errors
			.map((error) => `${error.tag}${error.instanceOf === undefined ? "" : ` <- instanceof ${error.instanceOf}`}`)
			.join("; "),
		`exported error classes, most specific first, then the catch-all ${prefix}Error carrying \`code\` (the source sets ${scan.codes.slice(0, 6).join(", ") || "no codes"})`,
	);

	const services = surface.exports
		.filter((item) => exports.includes(item.name))
		.flatMap((item) => {
			const handle = producedHandle(item);
			return handle !== undefined && handles[handle]?.release !== undefined
				? [{ name: serviceName(prefix, handle), handle, acquire: item.name }]
				: [];
		});
	decide(
		"services",
		"Which handles are provided as services (Context.Service with a layer)?",
		services.map((service) => `${service.name} <- ${service.acquire}`).join(", ") || "none",
		"every offered export that acquires a releasable handle",
	);
	const brands = parseBrands(
		decide(
			"brands",
			'Which ids and keys are branded, and where? (`<Brand>: <place>, ...; ...`, places as `brands` says; "none" for none)',
			brandsText(draftBrands(surface, Object.keys(handles), exports)),
			"a handle's string `id` and the parameters named `<handle>Id` of the calls the facade offers; fields of results (a message id) are named by an agent",
		),
	);
	decide(
		"secrets",
		"Which arguments carry secrets (passwords, tokens, keys), taken also as `Redacted`? (`secrets`: `<call>` -> `<index>.<property>...`)",
		Object.entries(previous?.secrets ?? {})
			.map(([call, paths]) => `${call}: ${paths.join(", ")}`)
			.join("; ") || "none",
		"the engine does not read option shapes: name each secret upstream's options and README document, and exclude each property where upstream keeps one in another shape than it was given",
	);
	decide(
		"untraced",
		"Which calls run on a per-item hot path, without a span? (`untraced`)",
		(previous?.untraced ?? []).join(", ") || "none",
		"every Effect and Stream is traced as `<Handle>.<method>` unless a call runs per item (per row, per frame)",
	);
	const borrowed = decide(
		"borrowed",
		'Which methods return a releasable handle the facade does not own (a lookup of one upstream already holds, the receiver itself, a handle the receiver holds), which it wraps without its release methods and never releases? (`<Handle>.<method>`, "none" for none)',
		borrowCandidates(surface, handles).join(", ") || "none",
		"the engine's rule, for a person to confirm (the types cannot tell): a method named after the handle it returns (`page`, `pages`, `asPage`, `waitForTarget`) finds one that exists; a synchronous method returning its own handle's type returns the receiver (`on`, `move`) unless it is named a copy (`clone`, `copy`, `duplicate`), and one returning a type the receiver holds as a property returns that one; any other method returning a releasable handle made it: an Effect acquires it in the caller's scope, and a synchronous call hands the caller its facade, release methods and all; an Effect resolving to a list of them made each (`$$`) unless it is named after them (`pages`), and a synchronous call's list is always borrowed",
	);
	const revision = redraftedRevision(previous, surface.version);

	return {
		$schema: "https://effectified.dev/schema/recipe.json",
		package: surface.package,
		version: surface.version,
		types: surface.types,
		name,
		prefix,
		exports,
		passthrough:
			passthrough === "none"
				? []
				: passthrough
						.split(",")
						.map((name) => name.trim())
						.filter((name) => name.length > 0),
		handles,
		errors,
		services: dedupeBy(services, (service) => service.name),
		methods: previous?.methods ?? {},
		derived: previous?.derived ?? [],
		testDependencies: previous?.testDependencies ?? {},
		...(previous?.tagline === undefined ? {} : { tagline: previous.tagline }),
		...(previous?.unlifted === undefined ? {} : { unlifted: previous.unlifted }),
		...(previous?.secrets === undefined ? {} : { secrets: previous.secrets }),
		...(Object.keys(brands).length === 0 ? {} : { brands }),
		...(previous?.untraced === undefined ? {} : { untraced: previous.untraced }),
		borrowed:
			borrowed === "none"
				? []
				: borrowed
						.split(",")
						.map((method) => method.trim())
						.filter((method) => method.length > 0),
		...(previous?.typeDependencies === undefined ? {} : { typeDependencies: previous.typeDependencies }),
		...(revision === undefined ? {} : { revision }),
		...(ui === undefined ? {} : { ui }),
		decisions,
	} satisfies Recipe;
});

/**
 * Exports worth offering: those the README uses, or else every function and class that is async or yields a handle;
 * none named by a string, which the facade cannot wrap (`wrappedExports`).
 */
function offeredExports(
	surface: Surface,
	readme: string,
): { readonly names: ReadonlyArray<string>; readonly why: string } {
	const candidates = surface.exports.filter(
		(item) =>
			isIdentifierName(item.name) &&
			((item.kind === "function" &&
				item.signatures.some((s) => s.handle !== undefined || s.traits.includes("async"))) ||
				(item.kind === "class" && !item.error && surface.handles[item.handle] !== undefined)),
	);
	const used = candidates.filter((item) =>
		new RegExp(`(\\bnew\\s+${item.name}\\b|\\b${item.name}\\s*\\(|\\.${item.name}\\s*\\()`).test(readme),
	);
	if (used.length > 0) return { names: used.map((item) => item.name), why: "the exports the package README calls" };
	return {
		names: candidates.map((item) => item.name),
		why: "every exported function or class that is async or yields a handle",
	};
}

/**
 * The exports the recipe offers that its facade wraps: each the surface has whose name is an identifier name. A
 * wrapper is a declaration named after its export (`<name>`, `make<Class>`, `Statics<Class>`), which a string cannot
 * name: an export named by one stays `Upstream["<name>"]`, and `reconcile` says so (`unwrappedNote`).
 */
export function wrappedExports(surface: Surface, recipe: Recipe): ReadonlyArray<Export> {
	return surface.exports.filter((item) => recipe.exports.includes(item.name) && isIdentifierName(item.name));
}

/**
 * Upstream's values that need no wrapping, the facade offering none of them (see `Recipe.passthrough`); one named by a
 * string is re-exported by it (`export { "review-sentinel" } from`).
 */
export function passthroughCandidates(surface: Surface, offered: ReadonlyArray<string>): ReadonlyArray<string> {
	const plain = (handle: Handle | undefined) =>
		handle === undefined ||
		(handle.releases.length === 0 &&
			Object.values(handle.methods).every((signatures) =>
				signatures.every(
					(signature) =>
						!signature.traits.some((trait) => trait === "async" || trait === "stream" || trait === "callback"),
				),
			));
	return surface.exports
		.filter((item) => item.name !== "default" && !offered.includes(item.name) && item.erased === undefined)
		.filter((item) => {
			if (item.kind === "value") return true;
			if (item.kind === "function")
				return item.signatures.every(
					(signature) =>
						signature.handle === undefined &&
						(signature.traits.includes("sync") || signature.traits.includes("returns-this")),
				);
			return item.error || plain(surface.handles[item.handle]);
		})
		.map((item) => item.name)
		.sort();
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
	const queue = surface.exports
		.filter((item) => exports.includes(item.name))
		.flatMap((item) => {
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
		// A handle a property holds is reachable too: puppeteer's `page.keyboard` and `page.mouse`.
		for (const property of Object.values(handle.properties))
			if (property.handle !== undefined) queue.push(property.handle);
	}
	return [...seen];
}

/**
 * The borrowed methods the draft proposes: each method of a wrapped handle returning a releasable handle, or resolving
 * to a list of them, that the engine's rule reads as borrowed (`borrowedByRule`), from the signatures the facade keeps
 * (an async one's handle, one that may be absent, or list, else a synchronous one's handle or one that may be absent,
 * whose list is always borrowed; either's conditional of handles, any of them; a trailing callback's never).
 */
function borrowCandidates(surface: Surface, handles: Readonly<Record<string, HandleRecipe>>): ReadonlyArray<string> {
	return Object.keys(handles)
		.flatMap((name) => {
			const handle = surface.handles[name];
			if (handle === undefined) return [];
			return Object.entries(handle.methods).flatMap(([method, signatures]) => {
				const kept = signatures.filter((signature) => !signature.traits.includes("callback"));
				const effect = kept.some((signature) => signature.traits.includes("async"));
				const intos = kept
					.filter((signature) => signature.traits.includes("async") === effect)
					.flatMap((signature) => {
						const type = signature.resolves ?? signature.returns;
						const into =
							signature.handle ??
							presentHandle(type, handles) ??
							(effect ? listedHandle(type, handles, signature.handles) : undefined);
						return into === undefined ? (signature.handles ?? []) : [into];
					})
					.filter((found) => handles[found]?.release !== undefined);
				return intos.some((into) => borrowedByRule(name, handle, method, into, effect))
					? [`${name}.${method}`]
					: [];
			});
		})
		.sort();
}

/**
 * The brands the draft proposes: `<Handle>Id` for a handle's `id` that is a string, at that property and at every
 * parameter named `<handle>Id` (a string) of the handles' methods and the offered exports and constructors.
 */
function draftBrands(
	surface: Surface,
	handles: ReadonlyArray<string>,
	exports: ReadonlyArray<string>,
): Readonly<Record<string, ReadonlyArray<string>>> {
	const places = new Map<string, Set<string>>();
	const add = (brand: string, place: string) => places.set(brand, (places.get(brand) ?? new Set()).add(place));
	for (const name of handles) {
		const id = surface.handles[name]?.properties["id"];
		if (id !== undefined && STRING_TYPE.test(id.type)) add(`${name}Id`, `${name}.id`);
	}
	const byParameter = new Map(
		handles.map((name) => [`${name.charAt(0).toLowerCase()}${name.slice(1)}Id`, `${name}Id`]),
	);
	const visit = (call: string, signatures: ReadonlyArray<Signature>) => {
		for (const signature of signatures) {
			for (const [index, parameter] of signature.parameters.entries()) {
				const brand = byParameter.get(parameter.name);
				if (brand !== undefined && STRING_TYPE.test(parameter.type)) add(brand, `${call}(${index})`);
			}
		}
	};
	for (const name of handles)
		for (const [method, signatures] of Object.entries(surface.handles[name]?.methods ?? {}))
			visit(`${name}.${method}`, signatures);
	for (const item of surface.exports.filter((candidate) => exports.includes(candidate.name))) {
		if (item.kind === "function") visit(item.name, item.signatures);
		if (item.kind === "class") visit(item.name, item.constructors);
	}
	return Object.fromEntries(
		[...places].sort(([a], [b]) => a.localeCompare(b)).map(([brand, found]) => [brand, [...found].sort()]),
	);
}

const STRING_TYPE = /^string(?: \| (?:undefined|null))*$/;

/** Brands as a decision's answer: `JobId: Job.id, Queue.getJob(0); WorkerId: Worker.id`, or `none`. */
function brandsText(brands: Readonly<Record<string, ReadonlyArray<string>>>): string {
	const entries = Object.entries(brands);
	return entries.length === 0 ? "none" : entries.map(([brand, places]) => `${brand}: ${places.join(", ")}`).join("; ");
}

/** A brands decision's answer, read back into the recipe's field. */
function parseBrands(answer: string): Readonly<Record<string, ReadonlyArray<string>>> {
	if (answer.trim() === "none") return {};
	return Object.fromEntries(
		answer
			.split(";")
			.map((entry) => entry.split(":"))
			.flatMap(([brand = "", places = ""]) =>
				brand.trim() === ""
					? []
					: [
							[
								brand.trim(),
								places
									.split(",")
									.map((place) => place.trim())
									.filter((place) => place !== ""),
							] as const,
						],
			),
	);
}

/**
 * The release methods the draft may offer for `handle`, the one it offers first: each the analyzer read as one
 * (`Handle.releases`) that is a release by the engine's one rule (`isRelease`: named so, callable with no argument,
 * whatever it gives), which a surface studied before it may not have kept to, in the order of `RELEASE_NAMES`. A method
 * that releases a handle under another name (MapLibre's `Map.remove`, puppeteer's `CDPSession.detach`) is a person's
 * decision.
 */
function draftReleases(handle: Handle): ReadonlyArray<string> {
	return RELEASE_NAMES.filter((name) => handle.releases.includes(name) && isRelease(name, handle.methods[name] ?? []));
}

/** Each handle of `names` a property of another of them holds, with the first such property (`Mail.transporter`). */
function propertyHolders(surface: Surface, names: ReadonlyArray<string>): ReadonlyMap<string, string> {
	const holders = new Map<string, string>();
	for (const owner of names)
		for (const [property, held] of Object.entries(surface.handles[owner]?.properties ?? {}))
			if (held.handle !== undefined && held.handle !== owner && !holders.has(held.handle))
				holders.set(held.handle, `${owner}.${property}`);
	return holders;
}

/**
 * Exported error classes, subclasses before their bases, then the catch-all `<prefix>Error`. An error's tag is its
 * class's export name, a class the facade declares: one exported under a string is left to the catch-all.
 */
function draftErrors(surface: Surface, scan: Scan, prefix: string): ReadonlyArray<ErrorRecipe> {
	const exported = surface.exports
		.filter((item) => item.kind === "class" && item.error && isIdentifierName(item.name))
		.map((item) => item.name);
	// The types say what each error class extends; the scan fills in what they do not (and is blind in minified code).
	const base = new Map(scan.errorClasses.map((item) => [item.name, item.base]));
	for (const item of surface.exports)
		if (item.kind === "class" && item.base !== undefined) base.set(item.name, item.base);
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

/**
 * The facade's npm name: `@effectified/<package>`. A scoped package keeps its scope (`@codemirror/view` is
 * `codemirror-view`), since other scopes publish the same names, unless its name already says it (`@xterm/xterm`).
 */
function facadeName(pkg: string): string {
	const scoped = /^@([^/]+)\/(.+)$/.exec(pkg);
	if (scoped === null) return `@effectified/${pkg}`;
	const [, scope = "", name = ""] = scoped;
	return `@effectified/${name === scope || name.startsWith(`${scope}-`) ? name : `${scope}-${name}`}`;
}

/** A service's name: `<Prefix><Handle>`, or `<Handle>Service` when the handle already carries the prefix. */
function serviceName(prefix: string, handle: string): string {
	return handle.startsWith(prefix) ? `${handle}Service` : `${prefix}${handle}`;
}
