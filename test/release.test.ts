// How a facade is released on npm: its version (`facadeVersion`, from the revision a redraft gives), what the generator
// writes for npm (its package.json, install lines and docs.json), what npm holds of a package (`published`, with npm's
// answers made by a `fetch` of the test's), and what a release does with each facade from that (`releasePlan`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, Struct } from "effect";
import { FetchHttpClient } from "effect/http";
import { generate } from "../src/generate.ts";
import { isAtLeast, type Published, published } from "../src/npm.ts";
import { releasePlan } from "../src/pipeline.ts";
import { draftRecipe, facadeVersion, Recipe, redraftedRevision } from "../src/recipe.ts";
import { Surface } from "../src/surface.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const readJson = <S extends Schema.Top>(schema: S, file: string) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(schema) as unknown as Schema.Codec<S["Type"], string>)(
		readFileSync(file, "utf8"),
	);
const nodemailer = {
	surface: readJson(Surface, join(fixtures, "nodemailer", "surface.json")),
	recipe: readJson(Recipe, join(fixtures, "nodemailer", "recipe.json")),
};
const xterm = {
	surface: readJson(Surface, join(fixtures, "xterm__xterm", "surface.json")),
	recipe: readJson(Recipe, join(fixtures, "xterm__xterm", "recipe.json")),
};

/** nodemailer's recipe at upstream's `version` and `revision`. */
const at = (version: string, revision: number | undefined): Recipe => {
	const unrevised = Struct.omit(nodemailer.recipe, ["revision"]);
	return { ...unrevised, version, ...(revision === undefined ? {} : { revision }) };
};

/** The recipe a redraft at upstream's `version` writes over `previous`. */
const redrafted = (previous: Recipe, version: string) =>
	draftRecipe(
		{ ...nodemailer.surface, version },
		{ files: 0, errorClasses: [], codes: [], events: [] },
		"",
		previous,
		false,
	);

describe("the facade's npm version: upstream's major.minor, then its releases for it", () => {
	it.effect("is upstream's major.minor and how many releases came before for it, from 0", () =>
		Effect.gen(function* () {
			expect(yield* facadeVersion(at("10.6.1", undefined))).toBe("10.6.0");
			expect(yield* facadeVersion(at("10.6.1", 1))).toBe("10.6.0");
			expect(yield* facadeVersion(at("10.6.1", 7))).toBe("10.6.6");
		}),
	);

	it.effect("starts again at revision 1 for a new upstream major.minor", () =>
		Effect.gen(function* () {
			const minor = yield* redrafted(at("10.6.1", 7), "10.7.0");
			expect(minor.revision).toBeUndefined();
			expect(yield* facadeVersion(minor)).toBe("10.7.0");
			const major = yield* redrafted(at("10.6.1", 7), "11.0.2");
			expect(major.revision).toBeUndefined();
			expect(yield* facadeVersion(major)).toBe("11.0.0");
		}),
	);

	it.effect("goes up by one when upstream moves a patch: another release of the same major.minor", () =>
		Effect.gen(function* () {
			const patched = yield* redrafted(at("10.6.1", 7), "10.6.2");
			expect(patched.revision).toBe(8);
			expect(yield* facadeVersion(patched)).toBe("10.6.7");
			// A facade's first release had no revision: the patch after it is its second.
			const second = yield* redrafted(at("10.6.1", undefined), "10.6.3");
			expect(second.revision).toBe(2);
			expect(yield* facadeVersion(second)).toBe("10.6.1");
		}),
	);

	it.effect("goes up by one for a fix: a person raises the revision, upstream's version stays", () =>
		Effect.gen(function* () {
			// A fix is a person's revision bump, which a redraft at the same version keeps.
			const fixed = yield* redrafted(at("10.6.1", 8), "10.6.1");
			expect(fixed.revision).toBe(8);
			expect(yield* facadeVersion(fixed)).toBe("10.6.7");
			expect(redraftedRevision(undefined, "10.6.1")).toBeUndefined();
		}),
	);

	it.effect("refuses a prerelease of upstream's, and generates nothing for it", () =>
		Effect.gen(function* () {
			const beta = at("11.0.0-beta.1", undefined);
			const refused = yield* Effect.exit(facadeVersion(beta));
			expect(Exit.isFailure(refused)).toBe(true);
			const error = yield* Effect.flip(facadeVersion(beta));
			expect(error._tag).toBe("VersionError");
			expect(error.reason).toMatch(/^a prerelease: /);
			expect((yield* Effect.flip(facadeVersion(at("10.6", undefined)))).reason).toMatch(
				/not a `major\.minor\.patch`/,
			);
			const generated = yield* Effect.flip(generate({ ...nodemailer.surface, version: beta.version }, beta));
			expect(generated._tag).toBe("VersionError");
			// A prerelease is no step of a major.minor's count either.
			expect(redraftedRevision(at("11.0.0-beta.1", 3), "11.0.0")).toBeUndefined();
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it("reads a revision only from 1, as a whole number", () => {
		const decode = (revision: unknown) =>
			Schema.decodeUnknownExit(Recipe)({ ...Schema.encodeSync(Recipe)(nodemailer.recipe), revision });
		expect(Exit.isSuccess(decode(1))).toBe(true);
		expect(Exit.isFailure(decode(0))).toBe(true);
		expect(Exit.isFailure(decode(2.5))).toBe(true);
	});
});

describe("generate: a facade for npm", () => {
	it.effect(
		"writes the npm version and effectified/packages as the repository, which npm checks as it publishes",
		() =>
			Effect.gen(function* () {
				for (const [{ surface, recipe }, directory] of [
					[nodemailer, "nodemailer"],
					[xterm, "xterm__xterm"],
				] as const) {
					const files = yield* generate(surface, { ...recipe, revision: 7 });
					const manifest: unknown = JSON.parse(files.get("package.json") ?? "{}");
					expect(manifest).toMatchObject({
						name: recipe.name,
						version: `${recipe.version.split(".").slice(0, 2).join(".")}.6`,
						repository: {
							type: "git",
							url: "git+https://github.com/effectified/packages.git",
							directory: `targets/${directory}/package`,
						},
						dependencies: { [recipe.package]: recipe.version },
					});
				}
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("installs by name from npm, with no version and no URL but Effect UI's snapshot", () =>
		Effect.gen(function* () {
			const runtime = yield* generate(nodemailer.surface, { ...nodemailer.recipe, revision: 7 });
			expect(runtime.get("README.md")).toContain(
				[
					"```sh",
					"pnpm add @effectified/nodemailer effect",
					"npm install @effectified/nodemailer effect",
					"bun add @effectified/nodemailer effect",
					"```",
				].join("\n"),
			);
			expect(runtime.get("SKILL.md")).toContain("```sh\npnpm add @effectified/nodemailer effect\n```");
			const ui = yield* generate(xterm.surface, { ...xterm.recipe, revision: 7 });
			const snapshot = `https://pkg.pr.new/Effect-TS/ui/@effect/ui@${xterm.recipe.ui?.effectUi}`;
			expect(ui.get("README.md")).toContain(`npm install --allow-remote=root @effectified/xterm effect ${snapshot}`);
			for (const file of [runtime, ui].flatMap((files) => [files.get("README.md"), files.get("SKILL.md")])) {
				expect(file).not.toMatch(/\.tgz|releases\/download|effectified\.dev\/[\w.-]+\.tgz/);
			}
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("writes docs.json schema 2: npm's page and the release's tag, no tarball URLs", () =>
		Effect.gen(function* () {
			const runtime = JSON.parse(
				(yield* generate(nodemailer.surface, { ...nodemailer.recipe, revision: 7 })).get("docs.json") ?? "{}",
			);
			expect(runtime.schema).toBe(2);
			expect(runtime.version).toBe("10.6.6");
			expect(runtime.install).toStrictEqual({
				npm: "https://www.npmjs.com/package/@effectified/nodemailer",
				tag: "nodemailer-v10.6.6",
			});
			const ui = JSON.parse(
				(yield* generate(xterm.surface, { ...xterm.recipe, revision: 7 })).get("docs.json") ?? "{}",
			);
			expect(ui.install).toStrictEqual({
				npm: "https://www.npmjs.com/package/@effectified/xterm",
				tag: "xterm-v6.0.6",
				effectUi: `https://pkg.pr.new/Effect-TS/ui/@effect/ui@${xterm.recipe.ui?.effectUi}`,
			});
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

/** A registry of the test's: npm's answer to each URL it is asked, a 404 for any other, and what it was asked. */
function registry(answers: Readonly<Record<string, () => Response>>) {
	const asked: Array<{ readonly url: string; readonly accept: string | null }> = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const url = String(input);
		asked.push({ url, accept: new Headers(init?.headers).get("accept") });
		return answers[url]?.() ?? new Response("{}", { status: 404 });
	};
	return { asked, fetch };
}

/** What npm answers for a package it has, at `versions`. */
const record = (versions: ReadonlyArray<string>) => () =>
	Response.json({ name: "x", versions: Object.fromEntries(versions.map((version) => [version, {}])) });

const NODEMAILER = "https://registry.npmjs.org/@effectified%2fnodemailer";

describe("what a release does with a facade, from what npm holds of it", () => {
	const ask = (name: string, fake: ReturnType<typeof registry>) =>
		published(name).pipe(
			Effect.provide(FetchHttpClient.layer),
			Effect.provideService(FetchHttpClient.Fetch, fake.fetch),
		);

	it.effect("reads npm's versions of a package, asking for the short record by its escaped name", () =>
		Effect.gen(function* () {
			const fake = registry({ [NODEMAILER]: record(["0.0.0", "10.6.6"]) });
			expect(yield* ask("@effectified/nodemailer", fake)).toStrictEqual({
				kind: "present",
				versions: ["0.0.0", "10.6.6"],
			});
			expect(fake.asked).toStrictEqual([{ url: NODEMAILER, accept: "application/vnd.npm.install-v1+json" }]);
		}),
	);

	it.effect("skips a version npm has, and makes only its GitHub release when that is missing", () =>
		Effect.gen(function* () {
			const npm = yield* ask("@effectified/nodemailer", registry({ [NODEMAILER]: record(["0.0.0", "10.6.6"]) }));
			expect(releasePlan(npm, "10.6.6", true)).toBe("released");
			expect(releasePlan(npm, "10.6.6", false)).toBe("announce");
		}),
	);

	it.effect("publishes a version npm lacks, but not over a GitHub release that holds its tag", () =>
		Effect.gen(function* () {
			const npm = yield* ask("@effectified/nodemailer", registry({ [NODEMAILER]: record(["0.0.0", "10.6.5"]) }));
			expect(releasePlan(npm, "10.6.6", false)).toBe("publish");
			expect(releasePlan(npm, "10.6.6", true)).toBe("conflict");
		}),
	);

	it.effect("leaves a package npm has never seen to the bootstrap, failing nothing", () =>
		Effect.gen(function* () {
			const npm = yield* ask("@effectified/nodemailer", registry({}));
			expect(npm).toStrictEqual({ kind: "absent" } satisfies Published);
			expect(releasePlan(npm, "10.6.6", false)).toBe("bootstrap");
			expect(releasePlan(npm, "10.6.6", true)).toBe("bootstrap");
		}),
	);

	it.effect("fails when npm answers neither the record nor that it has none", () =>
		Effect.gen(function* () {
			const down = yield* Effect.flip(
				ask("@effectified/nodemailer", registry({ [NODEMAILER]: () => new Response("busy", { status: 503 }) })),
			);
			expect(down._tag).toBe("NpmError");
			expect(down.reason).toContain("npm answered 503");
			const garbled = yield* Effect.flip(
				ask("@effectified/nodemailer", registry({ [NODEMAILER]: () => Response.json({ versions: "10.6.6" }) })),
			);
			expect(garbled._tag).toBe("NpmError");
		}),
	);

	it("requires an npm that publishes without a token, and refuses what is no version", () => {
		expect(isAtLeast("11.5.1", [11, 5, 1])).toBe(true);
		expect(isAtLeast("11.6.0", [11, 5, 1])).toBe(true);
		expect(isAtLeast("12.2.3", [11, 15, 0])).toBe(true);
		expect(isAtLeast("11.5.0", [11, 5, 1])).toBe(false);
		expect(isAtLeast("10.9.4", [11, 5, 1])).toBe(false);
		expect(isAtLeast("", [11, 5, 1])).toBe(false);
	});
});
