// The engine's pure parts: reading targets, reading what tsc says about a generated facade, drift, and plans; and
// the generator's determinism, against every target committed under targets/.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { drift } from "../src/drift.ts";
import { generate } from "../src/generate.ts";
import { explicitFailures, overridesFrom } from "../src/pipeline.ts";
import { plan } from "../src/plan.ts";
import { Recipe } from "../src/recipe.ts";
import { Surface } from "../src/surface.ts";
import { parseTarget } from "../src/target.ts";

describe("parseTarget", () => {
	it("reads GitHub URLs, with or without a tree path", () => {
		expect(parseTarget("https://github.com/taskforcesh/bullmq")).toStrictEqual({ kind: "github", owner: "taskforcesh", repo: "bullmq", ref: "HEAD", path: "" });
		expect(parseTarget("https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer-core")).toStrictEqual({
			kind: "github",
			owner: "puppeteer",
			repo: "puppeteer",
			ref: "main",
			path: "packages/puppeteer-core",
		});
		expect(parseTarget("github:steveukx/git-js.git")).toMatchObject({ kind: "github", owner: "steveukx", repo: "git-js" });
	});

	it("reads npm names, scoped or not, with an optional version", () => {
		expect(parseTarget("sharp")).toStrictEqual({ kind: "npm", name: "sharp", version: "latest" });
		expect(parseTarget("nodemailer@8.0.6")).toStrictEqual({ kind: "npm", name: "nodemailer", version: "8.0.6" });
		expect(parseTarget("@scope/name@1.2.3")).toStrictEqual({ kind: "npm", name: "@scope/name", version: "1.2.3" });
		expect(parseTarget("@scope/name")).toStrictEqual({ kind: "npm", name: "@scope/name", version: "latest" });
	});
});

describe("overridesFrom", () => {
	it("reads a method a spec lists that upstream's types do not call async", () => {
		const output = `src/index.ts(237,603): error TS2353: Object literal may only specify known properties, and '"toElement"' does not exist in type 'AsyncSpec<Pick<ElementHandle<any>, ElementHandleMethods>>'.`;
		expect(overridesFrom(output)).toStrictEqual({ "ElementHandle.toElement": "sync" });
	});

	it("reads async methods a spec misses, one or several", () => {
		const one = `src/index.ts(35,48): error TS2741: Property 'get' is missing in type '{ sendMail: true; }' but required in type 'AsyncSpec<Pick<Mail<any, any>, MailMethods>>'.`;
		expect(overridesFrom(one)).toStrictEqual({ "Mail.get": "async" });
		const several = `src/index.ts(9,9): error TS2739: Type '{}' is missing the following properties from type 'StreamSpec<Pick<Page, PageMethods>, Handles>': rows, lines`;
		expect(overridesFrom(several)).toStrictEqual({ "Page.rows": "stream", "Page.lines": "stream" });
	});

	it("reads a listed method that is no public method of upstream", () => {
		const output = `src/index.ts(82,90): error TS2344: Type 'TargetMethods' does not satisfy the constraint 'MethodKeys<Target>'.\n  Type '"logger"' is not assignable to type 'MethodKeys<Target>'.`;
		expect(overridesFrom(output)).toStrictEqual({ "Target.logger": "exclude" });
	});
});

describe("explicitFailures", () => {
	it("names the generic methods whose written-out signature tsc rejects", () => {
		const source = ["line 1", "\tlog<T>(options?: Upstream.Missing<T>): X; // explicit: SimpleGit.log", "line 3"].join("\n");
		expect(explicitFailures("src/index.ts(2,30): error TS2304: Cannot find name 'Missing'.", source)).toStrictEqual(["SimpleGit.log"]);
		expect(explicitFailures("src/index.ts(3,1): error TS1005: ';' expected.", source)).toStrictEqual([]);
	});
});

const signature = (returns: string) => ({ parameters: [], trailingCallback: false, returns, traits: ["sync" as const] });
const surface = (version: string, methods: Record<string, string>): Surface => ({
	package: "lib",
	version,
	types: { from: "bundled", package: "lib", version },
	entry: "named",
	exports: [{ kind: "function", name: "open", signatures: [signature("Client")] }],
	handles: {
		Client: {
			name: "Client",
			typeRef: "Upstream.Client",
			methods: Object.fromEntries(Object.entries(methods).map(([name, returns]) => [name, [signature(returns)]])),
			properties: {},
			events: [],
			releases: [],
		},
	},
	typeExports: [],
});

describe("drift", () => {
	it("is not breaking when upstream only adds", () => {
		const result = drift(surface("1.0.0", { get: "string" }), surface("1.1.0", { get: "string", put: "void" }));
		expect(result.changes).toStrictEqual([{ kind: "added", path: "Client.put", detail: "() => void" }]);
		expect(result.breaking).toBe(false);
	});

	it("is breaking when upstream removes or changes a method", () => {
		const result = drift(surface("1.0.0", { get: "string", put: "void" }), surface("2.0.0", { get: "number" }));
		expect(result.changes.map((change) => `${change.kind} ${change.path}`)).toStrictEqual(["changed Client.get", "removed Client.put"]);
		expect(result.breaking).toBe(true);
	});
});

const targets = join(import.meta.dirname, "..", "targets");
const committed = readdirSync(targets).filter((name) => !name.startsWith("."));
const readJson = <S extends Schema.Top>(schema: S, file: string) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(schema) as unknown as Schema.Codec<S["Type"], string>)(readFileSync(file, "utf8"));

describe("plan", () => {
	it("plans a frontend facade's elements in groups, each a browser test of its own", () => {
		const name = "awesome.me__webawesome";
		const result = plan(readJson(Surface, join(targets, name, "surface.json")), readJson(Recipe, join(targets, name, "recipe.json")), `targets/${name}`);
		const groups = result.units.filter((unit) => unit.id.startsWith("test-elements"));
		expect(groups.length).toBe(7);
		expect(groups[0]?.touches[0]).toBe("targets/awesome.me__webawesome/package/test/elements-1.test.ts");
	});

	it("plans a recipe review, test units per handle, and docs that wait for the tests", () => {
		const name = "nodemailer";
		const result = plan(readJson(Surface, join(targets, name, "surface.json")), readJson(Recipe, join(targets, name, "recipe.json")), `targets/${name}`);
		expect(result.units[0]?.id).toBe("recipe");
		expect(result.units.at(-1)?.id).toBe("docs");
		const tests = result.units.filter((unit) => unit.id.startsWith("test-"));
		expect(tests.length).toBeGreaterThan(0);
		expect(result.units.at(-1)?.dependsOn).toStrictEqual(tests.map((unit) => unit.id));
		expect(new Set(tests.flatMap((unit) => unit.touches)).size).toBe(tests.length);
	});
});

describe("generate", () => {
	for (const name of committed) {
		it.effect(`writes targets/${name}/package/src/index.ts again from its surface and recipe`, () =>
			Effect.gen(function* () {
				const files = yield* generate(
					readJson(Surface, join(targets, name, "surface.json")),
					readJson(Recipe, join(targets, name, "recipe.json")),
				);
				expect(files.get("src/index.ts")).toBe(readFileSync(join(targets, name, "package", "src", "index.ts"), "utf8"));
			}).pipe(Effect.provide(NodeServices.layer)),
		);
	}
});
