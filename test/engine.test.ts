// The engine's pure parts: reading targets, reading what tsc says about a generated facade, drift, and plans; and
// the generator's output, against fixtures taken from facades in effectified/packages (test/fixtures: a surface, a
// recipe and the src/index.ts they generate). `pnpm test -u` rewrites the expected output after an intended change.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, type Duration, Effect, Option, Schema } from "effect";
import { runBounded, runCommand } from "../src/command.ts";
import {
	EFFECT_PLUGIN,
	effectNative,
	effectRules,
	idioms,
	missingFiles,
	readTsrsOutput,
	suppressionFindings,
	uncheckedFiles,
} from "../src/diagnostics.ts";
import { extractExamples } from "../src/docs.ts";
import { drift } from "../src/drift.ts";
import { analyze } from "../src/analyze.ts";
import { generate, valueExports } from "../src/generate.ts";
import { listedHandle, presentHandle } from "../src/methods.ts";
import { entryFiles, importableNames, importFiles, moduleNames } from "../src/imports.ts";
import {
	absentAtRunTime,
	explicitFailures,
	overridesFrom,
	rejectedMarkers,
	restudyNote,
	unwrappedNote,
} from "../src/pipeline.ts";
import { plan } from "../src/plan.ts";
import { draftRecipe, Recipe } from "../src/recipe.ts";
import { type Signature, Surface } from "../src/surface.ts";
import { parseTarget } from "../src/target.ts";

describe("parseTarget", () => {
	it("reads GitHub URLs, with or without a tree path", () => {
		expect(parseTarget("https://github.com/taskforcesh/bullmq")).toStrictEqual({
			kind: "github",
			owner: "taskforcesh",
			repo: "bullmq",
			ref: "HEAD",
			path: "",
		});
		expect(parseTarget("https://github.com/puppeteer/puppeteer/tree/main/packages/puppeteer-core")).toStrictEqual({
			kind: "github",
			owner: "puppeteer",
			repo: "puppeteer",
			ref: "main",
			path: "packages/puppeteer-core",
		});
		expect(parseTarget("github:steveukx/git-js.git")).toMatchObject({
			kind: "github",
			owner: "steveukx",
			repo: "git-js",
		});
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

describe("readTsrsOutput", () => {
	it("reads Effect rules, TypeScript's own errors, messages over several lines, and diagnostics about the program", () => {
		const output = [
			"src/index.ts(3,2): error TS377001: This Effect value is neither yielded nor used in an assignment. effect(floatingEffect)",
			"src/index.ts(4,8): error TS2322: Type '{ a: string; }' is not assignable to type 'B'.",
			"  Property 'b' is missing in type '{ a: string; }' but required in type 'B'.",
			"test/facade.test.ts(9,1): suggestion TS377098: This Schema number API accepts `NaN`.",
			"  Use `Schema.Finite`. effect(schemaNumber)",
			"error TS18003: No inputs were found in config file 'tsconfig.json'.",
			"/work/facade/src/index.ts",
			"/work/facade/test/facade.test.ts",
			"",
		].join("\n");
		const read = readTsrsOutput(output);
		expect(read.files).toStrictEqual(["/work/facade/src/index.ts", "/work/facade/test/facade.test.ts"]);
		expect(read.unread).toStrictEqual([]);
		expect(read.diagnostics).toStrictEqual([
			{
				kind: "effect",
				at: "src/index.ts:3:2",
				severity: "error",
				rule: "floatingEffect",
				message: "This Effect value is neither yielded nor used in an assignment.",
			},
			{
				kind: "typescript",
				at: "src/index.ts:4:8",
				severity: "error",
				code: 2322,
				message:
					"Type '{ a: string; }' is not assignable to type 'B'. Property 'b' is missing in type '{ a: string; }' but required in type 'B'.",
			},
			{
				kind: "effect",
				at: "test/facade.test.ts:9:1",
				severity: "suggestion",
				rule: "schemaNumber",
				message: "This Schema number API accepts `NaN`. Use `Schema.Finite`.",
			},
			{
				kind: "program",
				severity: "error",
				code: 18003,
				message: "No inputs were found in config file 'tsconfig.json'.",
			},
		]);
	});

	it("keeps a line that starts no diagnostic, continues none and names no file apart, never in a message", () => {
		// A continuation is indented; a crash's line after a TypeScript error is neither.
		const output = [
			"src/index.ts(4,8): error TS2322: Type 'string' is not assignable to type 'number'.",
			"thread 'main' panicked at crates/checker/src/lib.rs:1:1",
			"/work/facade/src/index.ts",
		].join("\n");
		const read = readTsrsOutput(output);
		expect(read.unread).toStrictEqual(["thread 'main' panicked at crates/checker/src/lib.rs:1:1"]);
		expect(read.diagnostics).toMatchObject([{ message: "Type 'string' is not assignable to type 'number'." }]);
	});

	it("continues an Effect rule's message over unindented lines until it names its rule, as real tsrs output does", () => {
		const output = [
			"src/index.ts(12,3): error TS377003: This Effect has unknown or any in its error channel.",
			"Narrow the error type. effect(anyUnknownInErrorContext)",
			"src/index.ts(14,3): error TS377001: This Effect value is neither yielded nor used in an assignment.",
			"effect(floatingEffect)",
			"/work/facade/src/index.ts",
		].join("\n");
		const read = readTsrsOutput(output);
		expect(read.unread).toStrictEqual([]);
		expect(read.diagnostics).toStrictEqual([
			{
				kind: "effect",
				at: "src/index.ts:12:3",
				severity: "error",
				rule: "anyUnknownInErrorContext",
				message: "This Effect has unknown or any in its error channel. Narrow the error type.",
			},
			{
				kind: "effect",
				at: "src/index.ts:14:3",
				severity: "error",
				rule: "floatingEffect",
				message: "This Effect value is neither yielded nor used in an assignment.",
			},
		]);
	});

	it("reads no line after the file list begins as part of a message, and takes Windows line ends and paths", () => {
		const output = [
			"src/index.ts(4,8): error TS2322: Type 'string' is not assignable to type 'number'.",
			"C:\\work\\facade\\src\\index.ts",
			"    fatal runtime error: stack overflow",
			"C:/work/facade/test/facade.test.ts",
			"",
		].join("\r\n");
		const read = readTsrsOutput(output);
		expect(read.diagnostics).toMatchObject([{ message: "Type 'string' is not assignable to type 'number'." }]);
		expect(read.files).toStrictEqual(["C:\\work\\facade\\src\\index.ts", "C:/work/facade/test/facade.test.ts"]);
		expect(read.unread).toStrictEqual(["    fatal runtime error: stack overflow"]);
	});
});

describe("readTsrsOutput: what may follow a diagnostic", () => {
	it("lists only an absolute path with an extension tsrs reads: a crash naming a path is unread", () => {
		const output = [
			"src/index.ts(4,8): error TS2322: Type 'string' is not assignable to type 'number'.",
			"/work/facade/src/index.ts",
			"/work/native/tsrs: segmentation fault",
			"/work/facade/package.json",
		].join("\n");
		const read = readTsrsOutput(output);
		expect(read.files).toStrictEqual(["/work/facade/src/index.ts", "/work/facade/package.json"]);
		expect(read.unread).toStrictEqual(["/work/native/tsrs: segmentation fault"]);
	});

	it("takes no line into an Effect rule's message once it names its rule: an indented line after it is unread", () => {
		const output = [
			"src/index.ts(3,2): error TS377001: This Effect value is neither yielded nor used in an assignment. effect(floatingEffect)",
			"    at native frame 0x1",
			"/work/facade/src/index.ts",
		].join("\n");
		const read = readTsrsOutput(output);
		expect(read.diagnostics).toStrictEqual([
			{
				kind: "effect",
				at: "src/index.ts:3:2",
				severity: "error",
				rule: "floatingEffect",
				message: "This Effect value is neither yielded nor used in an assignment.",
			},
		]);
		expect(read.unread).toStrictEqual(["    at native frame 0x1"]);
		expect(read.files).toStrictEqual(["/work/facade/src/index.ts"]);
	});
});

describe("uncheckedFiles", () => {
	it("compares the files tsrs listed with the package's own whatever separators either uses", () => {
		const files = ["src/index.ts", "test/facade.test.ts", "test/support/demo.ts"];
		const listed = ["C:/work/facade/src/index.ts", "C:\\work\\facade\\test\\facade.test.ts"];
		expect(uncheckedFiles(files, listed, ["C:\\work\\facade"])).toStrictEqual(["test/support/demo.ts"]);
		expect(uncheckedFiles(files, ["/work/facade/src/index.ts"], ["/elsewhere", "/work/facade/"])).toStrictEqual([
			"test/facade.test.ts",
			"test/support/demo.ts",
		]);
	});
});

describe("explicitFailures", () => {
	it("names the generic methods whose written-out signature tsc rejects", () => {
		const source = [
			"line 1",
			"\tlog<T>(options?: Upstream.Missing<T>): X; // explicit: SimpleGit.log",
			"line 3",
		].join("\n");
		expect(explicitFailures("src/index.ts(2,30): error TS2304: Cannot find name 'Missing'.", source)).toStrictEqual([
			"SimpleGit.log",
		]);
		expect(explicitFailures("src/index.ts(3,1): error TS1005: ';' expected.", source)).toStrictEqual([]);
	});
});

const signature = (returns: string) => ({
	parameters: [],
	trailingCallback: false,
	returns,
	traits: ["sync" as const],
});
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
		expect(result.changes.map((change) => `${change.kind} ${change.path}`)).toStrictEqual([
			"changed Client.get",
			"removed Client.put",
		]);
		expect(result.breaking).toBe(true);
	});
});

const fixtures = join(import.meta.dirname, "fixtures");
const committed = readdirSync(fixtures).filter((name) => !name.startsWith("."));
const readJson = <S extends Schema.Top>(schema: S, file: string) =>
	Schema.decodeUnknownSync(Schema.fromJsonString(schema) as unknown as Schema.Codec<S["Type"], string>)(
		readFileSync(file, "utf8"),
	);

describe("plan", () => {
	it("plans a frontend facade's elements in groups, each a browser test of its own", () => {
		const name = "awesome.me__webawesome";
		const result = plan(
			readJson(Surface, join(fixtures, name, "surface.json")),
			readJson(Recipe, join(fixtures, name, "recipe.json")),
			`targets/${name}`,
		);
		const groups = result.units.filter((unit) => unit.id.startsWith("test-elements"));
		expect(groups.length).toBe(7);
		expect(groups[0]?.touches[0]).toBe("targets/awesome.me__webawesome/package/test/elements-1.test.ts");
	});

	it("plans a recipe review, test units per handle, and docs that wait for the tests", () => {
		const name = "nodemailer";
		const result = plan(
			readJson(Surface, join(fixtures, name, "surface.json")),
			readJson(Recipe, join(fixtures, name, "recipe.json")),
			`targets/${name}`,
		);
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
		it.effect(`writes ${name}'s src/index.ts from its surface and recipe`, () =>
			Effect.gen(function* () {
				const files = yield* generate(
					readJson(Surface, join(fixtures, name, "surface.json")),
					readJson(Recipe, join(fixtures, name, "recipe.json")),
				);
				yield* Effect.promise(() =>
					expect(files.get("src/index.ts")).toMatchFileSnapshot(join(fixtures, name, "index.ts.golden")),
				);
			}).pipe(Effect.provide(NodeServices.layer)),
		);
	}

	it.effect("exports a frontend facade's elements only when it binds some: no wildcard without a file to match", () =>
		Effect.gen(function* () {
			const exported = (name: string) =>
				Effect.map(
					generate(
						readJson(Surface, join(fixtures, name, "surface.json")),
						readJson(Recipe, join(fixtures, name, "recipe.json")),
					),
					(files) => {
						const manifest = JSON.parse(files.get("package.json") ?? "{}");
						return { exports: Object.keys(manifest.exports), sideEffects: manifest.sideEffects };
					},
				);
			// xterm's facade offers a mount and no element.
			expect(yield* exported("xterm__xterm")).toStrictEqual({ exports: ["."], sideEffects: ["./dist/index.js"] });
			expect(yield* exported("awesome.me__webawesome")).toStrictEqual({
				exports: [".", "./elements/*"],
				sideEffects: ["./dist/elements/*.js", "./dist/index.js"],
			});
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe("the Effect-native standard", () => {
	// A project under the engine's gitignored `.cache/`, so the runtimes resolve `effect` and `@effect/ui` from it.
	const root = join(import.meta.dirname, "..");
	const project = join(root, ".cache", "standard");

	it.effect("holds every fixture's generated source, its UI bindings and both runtimes to the idioms", () =>
		Effect.gen(function* () {
			rmSync(project, { recursive: true, force: true });
			const written: Array<string> = [];
			for (const name of committed) {
				const files = yield* generate(
					readJson(Surface, join(fixtures, name, "surface.json")),
					readJson(Recipe, join(fixtures, name, "recipe.json")),
				);
				for (const [file, content] of files) {
					if (!file.startsWith("src/") || !file.endsWith(".ts")) continue;
					mkdirSync(dirname(join(project, name, file)), { recursive: true });
					writeFileSync(join(project, name, file), content);
					written.push(join(name, file));
				}
			}
			expect(written).toContain("bullmq/src/internal/effectify.ts");
			expect(written).toContain("material__web/src/internal/ui.ts");
			expect(yield* idioms(project, written)).toStrictEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("finds every idiom's sites, and passes a site that says why it breaks its rule", () =>
		Effect.gen(function* () {
			mkdirSync(join(project, "planted"), { recursive: true });
			writeFileSync(join(project, "planted", "planted.ts"), PLANTED);
			const findings = yield* idioms(project, ["planted/planted.ts"]);
			expect(findings.map((finding) => finding.slice(0, finding.indexOf(": "))).sort()).toStrictEqual(
				[
					"planted/planted.ts:2:22 effect-fn-arrow",
					"planted/planted.ts:3:8 effect-fn",
					"planted/planted.ts:7:2 effect-fn",
					"planted/planted.ts:11:24 effect-fn-name",
					"planted/planted.ts:20:36 branded-id",
					"planted/planted.ts:29:28 effect-fn-arrow",
					// A switch on Effect's tag (a read of `_tag`, through `?.`, brackets, `!`, `as` or an angle-bracket
					// assertion) is a choice over a tagged union; one on a number (line 15, an HTTP response's `status`), on
					// an ordinary field (`type`, `kind`, `status`, `state`), on a property of the tag or on `true` is not.
					"planted/planted.ts:32:2 match",
					"planted/planted.ts:33:2 match",
					"planted/planted.ts:34:2 match",
					"planted/planted.ts:35:2 match",
					"planted/planted.ts:36:2 match",
					"planted/planted.ts:37:2 match",
					"planted/planted.ts:48:2 match",
					"planted/planted.ts:49:2 match",
					"planted/planted.ts:50:2 match",
				].sort(),
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	// A facade's compiler options, with the plugin block every generated tsconfig.json carries.
	const compilerOptions = {
		target: "es2024",
		module: "nodenext",
		moduleResolution: "nodenext",
		lib: ["es2024", "esnext.disposable", "dom", "dom.iterable"],
		types: ["node"],
		strict: true,
		skipLibCheck: true,
		noEmit: true,
		plugins: [EFFECT_PLUGIN],
	};

	it.effect("holds both runtimes to @effect/tsgo's rules as a facade's sources take them", () =>
		Effect.gen(function* () {
			mkdirSync(join(project, "runtime", "src"), { recursive: true });
			for (const file of ["effectify.ts", "ui.ts"])
				writeFileSync(
					join(project, "runtime", "src", file),
					readFileSync(join(root, "src", "runtime", file), "utf8"),
				);
			writeFileSync(
				join(project, "runtime", "tsconfig.json"),
				JSON.stringify({ compilerOptions, include: ["src"] }),
			);
			expect(yield* effectRules(join(project, "runtime"))).toStrictEqual({ findings: [], notes: [] });
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"fails on the rules' errors as sources and tests take them, and notes what only TypeScript 7.1 rejects",
		() =>
			Effect.gen(function* () {
				const planted = join(project, "rules");
				const tsconfig = (options: object, include: ReadonlyArray<string>) =>
					writeFileSync(join(planted, "tsconfig.json"), JSON.stringify({ compilerOptions: options, include }));
				for (const directory of ["src", "test"]) {
					mkdirSync(join(planted, directory), { recursive: true });
					writeFileSync(join(planted, directory, "planted.ts"), PLANTED_RULES);
				}
				tsconfig(compilerOptions, ["src", "test"]);
				// `globalDate` is a rule of a facade's sources only; TypeScript 7.0.2 accepts the destructured `keep`.
				expect(yield* effectRules(planted)).toStrictEqual({
					findings: [
						"src/planted.ts:3:2 floatingEffect: This Effect value is neither yielded nor used in an assignment.",
						"src/planted.ts:5:26 globalDate: This code uses `Date.now()`, time access is represented through `Clock` from Effect.",
						"test/planted.ts:3:2 floatingEffect: This Effect value is neither yielded nor used in an assignment.",
					],
					notes: [
						"src/planted.ts:9:55 TS7031: Binding element 'keep' implicitly has an 'any' type.",
						"test/planted.ts:9:55 TS7031: Binding element 'keep' implicitly has an 'any' type.",
					],
				});
				// Without the plugin block, or without inputs, tsrs checks no rule: neither is a pass.
				tsconfig({ ...compilerOptions, plugins: [] }, ["src", "test"]);
				expect((yield* effectRules(planted)).findings).toStrictEqual([PLUGIN_CHANGED]);
				// A plugin block of the facade's own, a rule turned off in it, would pass what the standard fails.
				const weakened = {
					...EFFECT_PLUGIN,
					diagnosticSeverity: { ...EFFECT_PLUGIN.diagnosticSeverity, floatingEffect: "off" },
				};
				tsconfig({ ...compilerOptions, plugins: [weakened] }, ["src", "test"]);
				expect((yield* effectRules(planted)).findings).toStrictEqual([PLUGIN_CHANGED]);
				tsconfig(compilerOptions, ["nothing"]);
				expect((yield* effectRules(planted)).findings).toStrictEqual([
					expect.stringMatching(/^tsconfig\.json TS18003: No inputs were found/),
					UNCHECKED("src/planted.ts"),
					UNCHECKED("test/planted.ts"),
				]);
				// A tsconfig.json that leaves the tests out hides their findings: that is no pass either.
				tsconfig(compilerOptions, ["src"]);
				expect((yield* effectRules(planted)).findings).toStrictEqual([
					"src/planted.ts:3:2 floatingEffect: This Effect value is neither yielded nor used in an assignment.",
					"src/planted.ts:5:26 globalDate: This code uses `Date.now()`, time access is represented through `Clock` from Effect.",
					UNCHECKED("test/planted.ts"),
				]);
				// One that skips checking would pass anything: the rules run as if it did not.
				tsconfig({ ...compilerOptions, noCheck: true }, ["src", "test"]);
				expect((yield* effectRules(planted)).findings).toStrictEqual([
					"src/planted.ts:3:2 floatingEffect: This Effect value is neither yielded nor used in an assignment.",
					"src/planted.ts:5:26 globalDate: This code uses `Date.now()`, time access is represented through `Clock` from Effect.",
					"test/planted.ts:3:2 floatingEffect: This Effect value is neither yielded nor used in an assignment.",
				]);
			}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe("the Effect-native standard: every TypeScript source, and no suppression without a reason", () => {
	const root = join(import.meta.dirname, "..");
	const planted = join(root, ".cache", "standard", "extensions");
	const compilerOptions = {
		target: "es2024",
		module: "nodenext",
		moduleResolution: "nodenext",
		lib: ["es2024"],
		types: [],
		strict: true,
		skipLibCheck: true,
		noEmit: true,
		jsx: "react-jsx",
		plugins: [EFFECT_PLUGIN],
	};
	const tsconfig = (include: ReadonlyArray<string>) =>
		writeFileSync(join(planted, "tsconfig.json"), JSON.stringify({ compilerOptions, include }));

	it.effect("holds .tsx, .mts and .cts sources to the sources' rules, and finds one tsrs left out", () =>
		Effect.gen(function* () {
			rmSync(planted, { recursive: true, force: true });
			mkdirSync(join(planted, "src"), { recursive: true });
			// `globalDate` is a rule of a facade's sources only.
			for (const extension of ["mts", "cts", "tsx"])
				writeFileSync(join(planted, "src", `clock.${extension}`), "export const now = () => Date.now();\n");
			tsconfig(["src"]);
			expect([...(yield* effectRules(planted)).findings].sort()).toStrictEqual([
				expect.stringMatching(/^src\/clock\.cts:1:\d+ globalDate: /),
				expect.stringMatching(/^src\/clock\.mts:1:\d+ globalDate: /),
				expect.stringMatching(/^src\/clock\.tsx:1:\d+ globalDate: /),
			]);
			tsconfig(["src/**/*.tsx"]);
			expect([...(yield* effectRules(planted)).findings].sort()).toStrictEqual([
				UNCHECKED("src/clock.cts"),
				UNCHECKED("src/clock.mts"),
				expect.stringMatching(/^src\/clock\.tsx:1:\d+ globalDate: /),
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it("lists only real TypeScript and JavaScript extensions as files tsrs checked", () => {
		const listed = ["/w/a.ts", "/w/a.tsx", "/w/a.mts", "/w/a.cts", "/w/a.d.mts", "/w/a.js", "/w/a.cjs", "/w/a.json"];
		const fake = ["/w/a.ctsx", "/w/a.cjsx", "/w/a.mtsx", "/w/a.mjsx"];
		const read = readTsrsOutput([...listed, ...fake].join("\n"));
		expect(read.files).toStrictEqual(listed);
		expect(read.unread).toStrictEqual(fake);
	});

	it("refuses every directive of the Effect rules but one rule turned off on the next line, with a reason", () => {
		const source = [
			`// ${DIRECTIVE}-next-line floatingEffect:off the test observes the Effect it never runs`,
			`// ${DIRECTIVE} floatingEffect:off`,
			`/** ${DIRECTIVE} *:off */`,
			`// ${DIRECTIVE} globalDate:skip-file`,
			`// ${DIRECTIVE}-next-line floatingEffect:off`,
			`// ${DIRECTIVE}-next-line *:off everything, for no reason`,
			`// ${DIRECTIVE}-next-line floatingEffect:warning downgraded, so it fails nothing`,
			`// ${DIRECTIVE}-next-line floatingEffect:off globalDate:off two rules for one reason`,
			"const kept = 1;",
		].join("\n");
		expect(
			suppressionFindings("test/a.test.ts", source).map((finding) => finding.slice(0, finding.indexOf(": "))),
		).toStrictEqual([
			"test/a.test.ts:2:4 suppression",
			"test/a.test.ts:3:5 suppression",
			"test/a.test.ts:4:4 suppression",
			"test/a.test.ts:5:4 suppression",
			"test/a.test.ts:6:4 suppression",
			"test/a.test.ts:7:4 suppression",
			"test/a.test.ts:8:4 suppression",
		]);
	});

	it("reads a directive as tsrs does: a reason is words, not a comment's end, and a mention turns nothing off", () => {
		const source = [
			// Refused: tsrs turns the rule off, and what follows the pair is no reason.
			`/* ${DIRECTIVE}-next-line floatingEffect:off */`,
			`/* ${DIRECTIVE}-next-line floatingEffect:off*/`,
			`const inString = "${DIRECTIVE}-next-line floatingEffect:off";`,
			// Refused: a second pair in the reason, a level in capitals (tsrs reads it), the pair after the reason.
			`// ${DIRECTIVE}-next-line floatingEffect:off the reason, then globalDate:OFF`,
			`// ${DIRECTIVE} floatingEffect:OFF`,
			`// ${DIRECTIVE}-next-line because floatingEffect:off`,
			// Kept: one pair, then words, a comment's end after them.
			`/* ${DIRECTIVE}-next-line floatingEffect:off the test never runs it */`,
			// Mentions: tsrs reads no rule in them, so they turn nothing off.
			`// the ${DIRECTIVE} and ${DIRECTIVE}-next-line directives, see the docs`,
			`const doc = "${DIRECTIVE}-next-line: one rule, then why";`,
			`// ${DIRECTIVE}-next-lines floatingEffect:off`,
			`// ${DIRECTIVE}-next-line,floatingEffect:off`,
			`// ${DIRECTIVE}-next-line floatingEffect: off`,
			`// ${DIRECTIVE}-next-line floatingEffect:offish`,
		].join("\n");
		expect(
			suppressionFindings("test/a.test.ts", source).map((finding) => finding.slice(0, finding.indexOf(": "))),
		).toStrictEqual([
			"test/a.test.ts:1:4 suppression",
			"test/a.test.ts:2:4 suppression",
			"test/a.test.ts:3:19 suppression",
			"test/a.test.ts:4:4 suppression",
			"test/a.test.ts:5:4 suppression",
			"test/a.test.ts:6:4 suppression",
		]);
	});

	it("takes a reason only from inside the directive's comment: code after a block comment's end is none", () => {
		const source = [
			// Refused: each block comment ends right after the pair, and what follows it is code.
			`/* ${DIRECTIVE}-next-line floatingEffect:off */ const unrelated = 1;`,
			`/** ${DIRECTIVE}-next-line floatingEffect:off */ export const alsoUnrelated = 1;`,
			`const before = 1; /* ${DIRECTIVE}-next-line floatingEffect:off */ const after = 2;`,
			`/* see http://example.com ${DIRECTIVE}-next-line floatingEffect:off */ const linked = 1;`,
			// Kept: the reason is inside the block comment, before its end; code may follow.
			`/* ${DIRECTIVE}-next-line floatingEffect:off the test never runs it */ const kept = 1;`,
			// Kept: a line comment's reason runs from the pair to the end of its line.
			`// ${DIRECTIVE}-next-line floatingEffect:off the test never runs it */ nor this`,
			`/* a block before */ // ${DIRECTIVE}-next-line floatingEffect:off the test never runs it`,
			"const last = 1;",
		].join("\n");
		expect(
			suppressionFindings("test/a.test.ts", source).map((finding) => finding.slice(0, finding.indexOf(": "))),
		).toStrictEqual([
			"test/a.test.ts:1:4 suppression",
			"test/a.test.ts:2:5 suppression",
			"test/a.test.ts:3:22 suppression",
			"test/a.test.ts:4:27 suppression",
		]);
	});

	it("reads a directive's rules as tsrs reads them: a prefix before the rule's name still turns it off", () => {
		// What tsrs 7.1.0-beta.tsrs4 honours, tried on a floatingEffect it reports otherwise: after the directive's word and
		// a space, a run of words of `[0-9A-Za-z_:*-]`, in which it finds every `<rule>:<level>` wherever it starts.
		const source = [
			// Refused: each turns floatingEffect off, the first with no reason at all.
			`// ${DIRECTIVE}-next-line -floatingEffect:off`,
			`// ${DIRECTIVE}-next-line x-floatingEffect:off the test never runs it`,
			`// ${DIRECTIVE} :floatingEffect:off`,
			`// ${DIRECTIVE} floatingEffect:skip-file-x`,
			`// ${DIRECTIVE}-next-line floatingEffect:off:x the test never runs it`,
			`// ${DIRECTIVE}\ffloatingEffect:off`,
			// Mentions: tsrs turns nothing off with them (a level it does not know, a pair after the run of words ends, a
			// space it does not read as one, a rule `a` at the level `floatingEffect`).
			`// ${DIRECTIVE}-next-line floatingEffect:off-x`,
			`// ${DIRECTIVE}-next-line why. floatingEffect:off`,
			`// ${DIRECTIVE}-next-line\u00a0floatingEffect:off`,
			`// ${DIRECTIVE}-next-line a:floatingEffect:off`,
			// Only a line's first directive: its words `*` name no rule, and the second is not read.
			`/* ${DIRECTIVE} */ /* ${DIRECTIVE} floatingEffect:off */`,
			// Refused: a word glued to the first is no directive, so the second is the line's first.
			`// ${DIRECTIVE}x ${DIRECTIVE} floatingEffect:off`,
		].join("\n");
		expect(
			suppressionFindings("test/a.test.ts", source).map((finding) => finding.slice(0, finding.indexOf(": "))),
		).toStrictEqual([
			"test/a.test.ts:1:4 suppression",
			"test/a.test.ts:2:4 suppression",
			"test/a.test.ts:3:4 suppression",
			"test/a.test.ts:4:4 suppression",
			"test/a.test.ts:5:4 suppression",
			"test/a.test.ts:6:4 suppression",
			"test/a.test.ts:12:25 suppression",
		]);
	});

	it.effect("fails a facade whose source or test turns a rule off without a reason", () =>
		Effect.gen(function* () {
			rmSync(planted, { recursive: true, force: true });
			for (const directory of ["src", "test"]) mkdirSync(join(planted, directory), { recursive: true });
			writeFileSync(join(planted, "src", "index.ts"), "export const one = 1;\n");
			writeFileSync(
				join(planted, "test", "index.test.mts"),
				`// ${DIRECTIVE} floatingEffect:off\nimport { Effect } from "effect";\nexport const run = () => {\n\tEffect.succeed(1);\n};\n`,
			);
			tsconfig(["src", "test"]);
			const failed = yield* Effect.flip(effectNative(planted));
			expect(failed._tag === "EffectNativeError" ? failed.findings : failed).toStrictEqual([
				expect.stringMatching(/^effect test\/index\.test\.mts:1:4 suppression: /),
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

// The Effect language service's directive, spelled so this file's own text holds none: tsrs reads one even in a string.
const DIRECTIVE = ["@effect", "diagnostics"].join("-");

/** The finding of a facade file tsrs did not check. */
const UNCHECKED = (file: string) => `${file}: tsrs did not check it (tsconfig.json's include leaves it out)`;

/** The finding of a tsconfig.json whose plugin block is not the engine's. */
const PLUGIN_CHANGED = "tsconfig.json's plugins are not the Effect plugin block the engine writes (EFFECT_PLUGIN)";

describe("missingFiles", () => {
	it.effect("finds each file tsrs listed that does not exist", () =>
		Effect.gen(function* () {
			const here = join(import.meta.dirname, "engine.test.ts");
			expect(yield* missingFiles([here, "/work/native/tsrs.ts"])).toStrictEqual([
				"/work/native/tsrs.ts: tsrs listed a file that does not exist",
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe("importing in Node", () => {
	// Packages under the engine's gitignored `.cache/`, so a facade's sources resolve `effect` from the checkout.
	const root = join(import.meta.dirname, "..", ".cache", "imports");
	const write = (file: string, content: string) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), content);
	};

	it.effect("reads the names a module gives when Node imports it, none for one that cannot be imported", () =>
		Effect.gen(function* () {
			rmSync(join(root, "names"), { recursive: true, force: true });
			// CommonJS whose named exports Node's lexer cannot see, as sharp's: only `default` is importable by name.
			write("names/node_modules/cjs-lib/package.json", `{ "name": "cjs-lib", "main": "index.js" }`);
			write(
				"names/node_modules/cjs-lib/index.js",
				"const lib = () => 1;\nObject.assign(lib, { block() {} });\nmodule.exports = lib;\n",
			);
			write(
				"names/node_modules/esm-lib/package.json",
				`{ "name": "esm-lib", "type": "module", "exports": "./index.js" }`,
			);
			write("names/node_modules/esm-lib/index.js", "export const a = 1;\nexport function b() {}\n");
			write(
				"names/node_modules/dom-lib/package.json",
				`{ "name": "dom-lib", "type": "module", "exports": "./index.js" }`,
			);
			write("names/node_modules/dom-lib/index.js", "export const title = document.title;\n");
			const names = (specifier: string) => moduleNames(join(root, "names"), specifier, "node");
			// Node 23 on also gives a CommonJS module's `module.exports`, a name no declaration has.
			const cjs = Option.getOrThrow(yield* names("cjs-lib"));
			expect(cjs).toContain("default");
			expect(cjs).not.toContain("block");
			expect(yield* names("esm-lib")).toStrictEqual(Option.some(["a", "b"]));
			expect(yield* names("dom-lib")).toStrictEqual(Option.none());
			// A package with a browser build of its own: only the names both builds give are importable by name.
			write(
				"names/node_modules/split-lib/package.json",
				`{ "name": "split-lib", "type": "module", "exports": { "browser": "./browser.js", "default": "./node.js" } }`,
			);
			write("names/node_modules/split-lib/node.js", "export const shared = 1;\nexport const nodeOnly = 2;\n");
			write("names/node_modules/split-lib/browser.js", "export const shared = 1;\nexport const browserOnly = 3;\n");
			expect(yield* importableNames(join(root, "names"), "split-lib")).toStrictEqual(Option.some(["shared"]));
			expect(yield* importableNames(join(root, "names"), "esm-lib")).toStrictEqual(Option.some(["a", "b"]));
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"reads a module's names whatever it prints as it loads: a line it leaves open, one shaped like the report",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "printing-names"), { recursive: true, force: true });
				const library = (name: string, source: string) => {
					write(
						`printing-names/node_modules/${name}/package.json`,
						`{ "name": "${name}", "type": "module", "exports": "./index.js" }`,
					);
					write(`printing-names/node_modules/${name}/index.js`, source);
				};
				// A library that announces itself as it loads, leaving its line open.
				library("open-lib", `process.stdout.write("initializing...");\nexport const ready = 1;\n`);
				// One that prints a line shaped like the probe's report of other names.
				library(
					"shaped-lib",
					`process.stdout.write('@effectified/names ["shaped"]\\n');\nexport const real = 1;\n`,
				);
				// One that prints a report of its names and exits before its import settled.
				library(
					"exiting-lib",
					`await new Promise((resolve) => process.stdout.write('@effectified/names ["exiting"]\\n', resolve));\nprocess.exit(17);\nexport const never = 1;\n`,
				);
				const names = (specifier: string) => moduleNames(join(root, "printing-names"), specifier, "node");
				expect(yield* names("open-lib")).toStrictEqual(Option.some(["ready"]));
				expect(yield* names("shaped-lib")).toStrictEqual(Option.some(["real"]));
				expect(yield* names("exiting-lib")).toStrictEqual(Option.none());
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live(
		"runs upstream's module bare and bounded: no inherited environment, a deadline the engine keeps, nothing left running",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "bounded"), { recursive: true, force: true });
				const library = (name: string, source: string) => {
					write(
						`bounded/node_modules/${name}/package.json`,
						`{ "name": "${name}", "type": "module", "exports": "./index.js" }`,
					);
					write(`bounded/node_modules/${name}/index.js`, source);
				};
				const names = (specifier: string, deadline?: Duration.Input) =>
					moduleNames(join(root, "bounded"), specifier, "node", deadline);
				// The engine's environment stays the engine's: a token in it, or NODE_OPTIONS, never reaches upstream's code.
				library(
					"env-lib",
					"if (process.env.EFFECTIFIED_PROBE_TOKEN !== undefined || process.env.NODE_OPTIONS !== undefined) throw new Error('inherited');\nexport const bare = 1;\n",
				);
				const saved = { token: process.env["EFFECTIFIED_PROBE_TOKEN"], options: process.env["NODE_OPTIONS"] };
				process.env["EFFECTIFIED_PROBE_TOKEN"] = "secret";
				process.env["NODE_OPTIONS"] = "--max-old-space-size=512";
				const bare = yield* Effect.ensuring(
					names("env-lib"),
					Effect.sync(() => {
						restore("EFFECTIFIED_PROBE_TOKEN", saved.token);
						restore("NODE_OPTIONS", saved.options);
					}),
				);
				expect(bare).toStrictEqual(Option.some(["bare"]));
				// A module that blocks its own event loop past the deadline: killed, and the call fails.
				library(
					"busy-lib",
					"const until = Date.now() + 30000;\nwhile (Date.now() < until) {}\nexport const late = 1;\n",
				);
				const started = Date.now();
				const blocked = yield* Effect.flip(names("busy-lib", "2 seconds"));
				expect(blocked._tag).toBe("CommandDeadlineError");
				expect(Date.now() - started).toBeLessThan(10_000);
				// A module that starts a descendant in a session of its own: nothing it starts outlives the import.
				const pidFile = join(root, "bounded", "descendant.pid");
				library(
					"spawn-lib",
					`import { spawn } from "node:child_process";\nspawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { detached: true, stdio: "ignore" }).unref();\nexport const spawned = 1;\n`,
				);
				yield* names("spawn-lib");
				yield* Effect.sleep("1 second");
				expect(alive(pidFile)).toBe(false);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("finds a package's entry points, wildcards expanded, and imports each: a name upstream lacks fails", () =>
		Effect.gen(function* () {
			rmSync(join(root, "entries"), { recursive: true, force: true });
			write("entries/node_modules/cjs-lib/package.json", `{ "name": "cjs-lib", "main": "index.js" }`);
			write(
				"entries/node_modules/cjs-lib/index.js",
				"const lib = () => 1;\nObject.assign(lib, { block() {} });\nmodule.exports = lib;\n",
			);
			write(
				"entries/package.json",
				JSON.stringify({
					name: "facade",
					type: "module",
					exports: {
						".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
						"./parts/*": { types: "./dist/parts/*.d.ts", import: "./dist/parts/*.js" },
					},
				}),
			);
			write("entries/dist/index.js", `export { default as lib } from "cjs-lib";\n`);
			write("entries/dist/parts/good.js", `export { default } from "cjs-lib";\n`);
			// What the generator wrote for sharp: a name its declarations give and its module does not.
			write("entries/dist/parts/nested/bad.js", `export { block } from "cjs-lib";\n`);
			const files = yield* entryFiles(join(root, "entries"));
			expect(files.map((file) => file.slice(join(root, "entries").length + 1))).toStrictEqual([
				"dist/index.js",
				"dist/parts/good.js",
				"dist/parts/nested/bad.js",
			]);
			const imported = yield* importFiles(join(root, "entries"), files, "node");
			expect(
				imported.map((entry) => [entry.kind, entry.file.slice(join(root, "entries").length + 1)]),
			).toStrictEqual([
				["imported", "dist/index.js"],
				["imported", "dist/parts/good.js"],
				["failed", "dist/parts/nested/bad.js"],
			]);
			expect(imported[2]).toMatchObject({ message: expect.stringContaining("block") });
			// A wildcard that matches no file names entry points the release does not have: that fails.
			write(
				"entries/package.json",
				JSON.stringify({ name: "facade", type: "module", exports: { "./gone/*": "./dist/gone/*.js" } }),
			);
			const unmatched = yield* Effect.flip(entryFiles(join(root, "entries")));
			expect(unmatched._tag === "EntryPointError" && unmatched.reason).toBe(
				"exports target ./dist/gone/*.js matches no file",
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"probes a browser facade in Node, report only: an error linking it and one while it runs are reported apart, with their messages",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "browser"), { recursive: true, force: true });
				write(
					"browser/node_modules/ui-lib/package.json",
					`{ "name": "ui-lib", "type": "module", "exports": "./index.js" }`,
				);
				write(
					"browser/node_modules/ui-lib/index.js",
					`import "./theme.css";\nexport const title = document.title;\n`,
				);
				write("browser/node_modules/ui-lib/theme.css", ":root { color: red; }\n");
				write("browser/node_modules/cjs-lib/package.json", `{ "name": "cjs-lib", "main": "index.js" }`);
				write("browser/node_modules/cjs-lib/index.js", "module.exports = { shown: 1 };\n");
				write("browser/node_modules/cjs-init/package.json", `{ "name": "cjs-init", "main": "index.js" }`);
				write("browser/node_modules/cjs-init/index.js", `throw new Error("CommonJS init bug");\n`);
				const cases = {
					// Link errors are reported as such: a name a module lacks (an ES module's, a CommonJS module's its lexer
					// cannot see), a file or a package not found, a module that does not parse. A bundler resolves the
					// facade as it ships, and its Vite bundle checks it.
					broken: { source: `export { missing } from "ui-lib";\n`, kind: "unlinked" },
					cjsName: { source: `export { hidden } from "cjs-lib";\n`, kind: "unlinked" },
					missingFile: { source: `export { title } from "./nowhere.js";\n`, kind: "unlinked" },
					missingPackage: { source: `import "not-installed";\nexport {};\n`, kind: "unlinked" },
					unparsed: { source: "export const = 1;\n", kind: "unlinked" },
					// Errors while it runs are reported as such: a browser global, an ordinary bug, a CommonJS module that
					// throws as it runs, and a name missing from a module only a top-level `await import()` reaches, which
					// fails as the module runs, so only its words would tell it from any other error then.
					index: { source: `export { title } from "ui-lib";\n`, kind: "unevaluated" },
					element: { source: "export class Element extends HTMLElement {}\n", kind: "unevaluated" },
					frame: { source: "globalThis.requestAnimationFrame(() => {});\nexport {};\n", kind: "unevaluated" },
					bug: { source: `throw new Error("ordinary init bug");\n`, kind: "unevaluated" },
					cjsInit: { source: `import "cjs-init";\nexport {};\n`, kind: "unevaluated" },
					lazy: { source: `await import("./broken.js");\nexport {};\n`, kind: "unevaluated" },
					typo: { source: "undefinedHelper();\nexport {};\n", kind: "unevaluated" },
				};
				for (const [name, { source }] of Object.entries(cases)) write(`browser/dist/${name}.js`, source);
				const files = Object.keys(cases).map((name) => join(root, "browser", "dist", `${name}.js`));
				const imported = yield* importFiles(join(root, "browser"), files, "browser");
				const named = Object.keys(cases);
				expect(Object.fromEntries(imported.map((entry, index) => [named[index], entry.kind]))).toStrictEqual(
					Object.fromEntries(Object.entries(cases).map(([name, { kind }]) => [name, kind])),
				);
				expect(imported[named.indexOf("index")]).toMatchObject({ message: "document is not defined" });
				expect(imported[named.indexOf("bug")]).toMatchObject({ message: "ordinary init bug" });
				expect(imported[named.indexOf("cjsInit")]).toMatchObject({ message: "CommonJS init bug" });
				expect(imported[named.indexOf("broken")]).toMatchObject({ message: expect.stringContaining("missing") });
				// In Node mode every one fails: Node is where a runtime facade runs.
				expect((yield* importFiles(join(root, "browser"), files, "node")).map((entry) => entry.kind)).toStrictEqual(
					files.map(() => "failed"),
				);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"reports whatever a browser facade throws while it runs, by when it failed, never by its words or its source",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "forms"), { recursive: true, force: true });
				const cases = {
					undefinedName: "export const title = document.title;\n",
					globalRead: "export const title = globalThis.document.title;\n",
					bracketRead: `export const title = globalThis["document"].title;\n`,
					// The reads the source inspection of 0.4.0's earlier rounds failed: brackets on a line of their own,
					// spaces around a dot or in brackets.
					multilineBracket: `export const title = globalThis\n  ["document"].title;\n`,
					spacedBracket: `export const title = globalThis [ "document" ] . title;\n`,
					spacedDot: "export const title = globalThis . document . title;\n",
					// What it passed as a browser global's read, and what it failed as the module's own error: all are
					// errors while the module runs, which its browser tests check.
					spacedMember: "const box = {};\nexport const shown = box . window.title;\n",
					memberRead: "const box = {};\nexport const shown = box.window.title;\n",
					computedKey: `const key = "document";\nexport const title = globalThis[key].title;\n`,
					ownTypeError: `throw new TypeError("invalid window setting");\n`,
					posing: `throw { name: "ReferenceError", message: "document is not defined" };\n`,
					thrownLikeV8: `throw new ReferenceError("document is not defined");\n`,
				};
				for (const [name, source] of Object.entries(cases)) write(`forms/dist/${name}.js`, source);
				const files = Object.keys(cases).map((name) => join(root, "forms", "dist", `${name}.js`));
				const imported = yield* importFiles(join(root, "forms"), files, "browser");
				expect(imported.map((entry) => entry.kind)).toStrictEqual(files.map(() => "unevaluated"));
				expect(imported[Object.keys(cases).indexOf("multilineBracket")]).toMatchObject({
					message: "Cannot read properties of undefined (reading 'title')",
				});
				expect(imported[Object.keys(cases).indexOf("ownTypeError")]).toMatchObject({
					message: "invalid window setting",
				});
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"resolves a browser facade's packages as a bundler does: the browser condition, `module` over `main`",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "bundled"), { recursive: true, force: true });
				// As @xterm/xterm: a UMD bundle as `main`, whose names Node's lexer cannot see, and an ES module as `module`.
				write(
					"bundled/node_modules/umd-lib/package.json",
					`{ "name": "umd-lib", "main": "lib/umd.js", "module": "lib/esm.js" }`,
				);
				write(
					"bundled/node_modules/umd-lib/lib/umd.js",
					"(function (root, factory) { module.exports = factory(); })(this, () => ({ Terminal: class {} }));\n",
				);
				write("bundled/node_modules/umd-lib/lib/esm.js", "export class Terminal {}\n");
				// A package whose `exports` gives browsers their own build.
				write(
					"bundled/node_modules/split-lib/package.json",
					`{ "name": "split-lib", "type": "module", "exports": { "browser": "./browser.js", "default": "./node.js" } }`,
				);
				write("bundled/node_modules/split-lib/browser.js", "export const where = 'browser';\n");
				write("bundled/node_modules/split-lib/node.js", "export const elsewhere = 'node';\n");
				write("bundled/dist/index.js", `export { Terminal } from "umd-lib";\nexport { where } from "split-lib";\n`);
				const files = [join(root, "bundled", "dist", "index.js")];
				expect(
					(yield* importFiles(join(root, "bundled"), files, "browser")).map((entry) => entry.kind),
				).toStrictEqual(["imported"]);
				expect((yield* importFiles(join(root, "bundled"), files, "node")).map((entry) => entry.kind)).toStrictEqual(
					["failed"],
				);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"reports, never fails, a browser facade Node cannot link where a bundler can: a dependency's object-form `browser` map",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "mapped"), { recursive: true, force: true });
				// As a dependency of Chart.js's mount: its `browser` field maps its Node file to a browser one, which a bundler
				// applies and Node does not, and only the browser file has the name the mount imports.
				write(
					"mapped/node_modules/mapped-lib/package.json",
					`{ "name": "mapped-lib", "type": "module", "main": "./node.js", "browser": { "./node.js": "./browser.js" } }`,
				);
				write("mapped/node_modules/mapped-lib/node.js", "export const shared = 1;\n");
				write(
					"mapped/node_modules/mapped-lib/browser.js",
					"export const shared = 1;\nexport const inBrowser = 2;\n",
				);
				write("mapped/dist/mount.js", `export { inBrowser } from "mapped-lib";\n`);
				const file = join(root, "mapped", "dist", "mount.js");
				expect(yield* importFiles(join(root, "mapped"), [file], "browser")).toStrictEqual([
					{ kind: "unlinked", file, message: expect.stringContaining("inBrowser") },
				]);
				// A runtime facade runs in Node: there the same import fails.
				expect((yield* importFiles(join(root, "mapped"), [file], "node")).map((entry) => entry.kind)).toStrictEqual(
					["failed"],
				);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live(
		"bounds every import probe: an entry point that never settles is a report for a browser facade and fails a runtime facade",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "unsettled"), { recursive: true, force: true });
				// As a Chart.js mount whose initialisation never settled under Node: its top level awaits a promise that
				// never settles while a timer keeps Node's event loop alive, so Node neither finishes the import nor exits.
				const pidFile = join(root, "unsettled", "hung.pid");
				write(
					"unsettled/dist/hung.js",
					`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nawait new Promise(() => setInterval(() => {}, 1000));\nexport {};\n`,
				);
				write("unsettled/dist/before.js", "export const before = 1;\n");
				write("unsettled/dist/after.js", "export const after = 1;\n");
				const before = join(root, "unsettled", "dist", "before.js");
				const hung = join(root, "unsettled", "dist", "hung.js");
				const after = join(root, "unsettled", "dist", "after.js");
				const files = [before, hung, after];
				const started = Date.now();
				// The entry point before the one that never settles keeps its result; the one that never settles, and the
				// one after it, which never ran, have none.
				expect(yield* importFiles(join(root, "unsettled"), files, "browser", "2 seconds")).toStrictEqual([
					{ kind: "imported", file: before },
					{ kind: "unevaluated", file: hung, message: "did not settle within 2 s" },
					{ kind: "unevaluated", file: after, message: "did not settle within 2 s" },
				]);
				expect(yield* importFiles(join(root, "unsettled"), files, "node", "2 seconds")).toStrictEqual([
					{ kind: "imported", file: before },
					{ kind: "failed", file: hung, message: "did not settle within 2 s" },
					{ kind: "failed", file: after, message: "did not settle within 2 s" },
				]);
				expect(Date.now() - started).toBeLessThan(30_000);
				// The probe's process group is killed at the deadline: nothing it started is left running.
				yield* Effect.sleep("1 second");
				expect(existsSync(pidFile)).toBe(true);
				expect(alive(pidFile)).toBe(false);
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.live(
		"keeps every result the probe reported before its deadline: an entry point that imports only after another ran",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "registered"), { recursive: true, force: true });
				// As a facade whose first entry point registers shared state (a custom element, a plugin) that the next
				// needs as it loads: in one process, in order, both import; the second alone fails. The batch is cut at
				// its deadline after both settled, by an entry point that never settles: awaiting under a timer for a
				// runtime facade, blocking its event loop for a browser facade.
				write(
					"registered/dist/register.js",
					"globalThis.registry = new Map([['shared', 1]]);\nexport const registered = 1;\n",
				);
				write(
					"registered/dist/dependent.js",
					"if (globalThis.registry?.get('shared') !== 1) throw new Error('nothing registered');\nexport const dependent = 1;\n",
				);
				write("registered/dist/waiting.js", "await new Promise(() => setInterval(() => {}, 1000));\nexport {};\n");
				write("registered/dist/blocking.js", "for (;;) {}\nexport {};\n");
				write("registered/dist/after.js", "export const after = 1;\n");
				const entry = (name: string) => join(root, "registered", "dist", `${name}.js`);
				const [register, dependent, after] = [entry("register"), entry("dependent"), entry("after")];
				const unsettled = "did not settle within 2 s";
				expect(
					yield* importFiles(
						join(root, "registered"),
						[register, dependent, entry("waiting"), after],
						"node",
						"2 seconds",
					),
				).toStrictEqual([
					{ kind: "imported", file: register },
					{ kind: "imported", file: dependent },
					{ kind: "failed", file: entry("waiting"), message: unsettled },
					{ kind: "failed", file: after, message: unsettled },
				]);
				expect(
					yield* importFiles(
						join(root, "registered"),
						[register, dependent, entry("blocking"), after],
						"browser",
						"2 seconds",
					),
				).toStrictEqual([
					{ kind: "imported", file: register },
					{ kind: "imported", file: dependent },
					{ kind: "unevaluated", file: entry("blocking"), message: unsettled },
					{ kind: "unevaluated", file: after, message: unsettled },
				]);
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.effect("imports a facade's entry points with the engine's whole environment, as the facade's tests run", () =>
		Effect.gen(function* () {
			rmSync(join(root, "environment"), { recursive: true, force: true });
			// An entry point that reads a setting as it loads, as an ordinary import and the facade's tests give it.
			write(
				"environment/dist/configured.js",
				"if (process.env.EFFECTIFIED_FACADE_SETTING !== 'on') throw new Error('setting missing');\nexport const configured = 1;\n",
			);
			const file = join(root, "environment", "dist", "configured.js");
			const saved = process.env["EFFECTIFIED_FACADE_SETTING"];
			process.env["EFFECTIFIED_FACADE_SETTING"] = "on";
			const imported = yield* Effect.ensuring(
				importFiles(join(root, "environment"), [file], "node"),
				Effect.sync(() => restore("EFFECTIFIED_FACADE_SETTING", saved)),
			);
			expect(imported).toStrictEqual([{ kind: "imported", file }]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live("bounds the import probe by EFFECTIFY_IMPORTS_DEADLINE seconds when it is set", () =>
		Effect.gen(function* () {
			rmSync(join(root, "slow"), { recursive: true, force: true });
			write(
				"slow/dist/slow.js",
				"await new Promise((resolve) => setTimeout(resolve, 3000));\nexport const slow = 1;\n",
			);
			const file = join(root, "slow", "dist", "slow.js");
			const within = (seconds: string) =>
				importFiles(join(root, "slow"), [file], "node").pipe(
					Effect.provideService(
						ConfigProvider.ConfigProvider,
						ConfigProvider.fromEnv({ env: { EFFECTIFY_IMPORTS_DEADLINE: seconds } }),
					),
				);
			expect(yield* within("1")).toStrictEqual([{ kind: "failed", file, message: "did not settle within 1 s" }]);
			expect(yield* within("10")).toStrictEqual([{ kind: "imported", file }]);
			// Trust boundary: the variable is the user's input, and a deadline that is no positive number fails.
			expect((yield* Effect.flip(within("0")))._tag).toBe("ConfigError");
			expect((yield* Effect.flip(within("soon")))._tag).toBe("ConfigError");
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"takes each entry point's result from a channel of its own: a line left open on stdout, or one shaped like a result before an exit, is none",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "printing"), { recursive: true, force: true });
				const entry = (name: string) => join(root, "printing", "dist", `${name}.js`);
				// As a library that announces itself as it loads, leaving its line open: it imports.
				write("printing/dist/open.js", `process.stdout.write("initializing...");\nexport const open = 1;\n`);
				// A line shaped like the probe's report that this entry point imported, then an exit before it settled.
				const shaped = `@effectified/imported ${JSON.stringify({ kind: "imported", file: entry("shaped") })}\n`;
				write(
					"printing/dist/shaped.js",
					`await new Promise((resolve) => process.stdout.write(${JSON.stringify(shaped)}, resolve));\nprocess.exit(17);\nexport {};\n`,
				);
				write("printing/dist/after.js", "export const after = 1;\n");
				const files = [entry("open"), entry("shaped"), entry("after")];
				const exited = expect.stringMatching(/^the process exited with code 17 before this entry settled/);
				expect(yield* importFiles(join(root, "printing"), files, "node")).toStrictEqual([
					{ kind: "imported", file: entry("open") },
					{ kind: "failed", file: entry("shaped"), message: exited },
					{ kind: "failed", file: entry("after"), message: exited },
				]);
				expect(yield* importFiles(join(root, "printing"), files, "browser")).toStrictEqual([
					{ kind: "imported", file: entry("open") },
					{ kind: "unevaluated", file: entry("shaped"), message: exited },
					{ kind: "unevaluated", file: entry("after"), message: exited },
				]);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live(
		"keeps the result of an entry point that printed a lot when the next one blocks its event loop or exits",
		() =>
			Effect.gen(function* () {
				rmSync(join(root, "flooding"), { recursive: true, force: true });
				const entry = (name: string) => join(root, "flooding", "dist", `${name}.js`);
				// 16 MiB queued on stdout, which Node writes to a pipe as its event loop runs, and the next entry point
				// stops the loop: the queued output never reaches the engine.
				write(
					"flooding/dist/loud.js",
					`process.stdout.write("x".repeat(16 * 1024 * 1024));\nexport const loud = 1;\n`,
				);
				write("flooding/dist/blocking.js", "for (;;) {}\nexport {};\n");
				write("flooding/dist/exiting.js", "process.exit(3);\nexport {};\n");
				expect(
					yield* importFiles(join(root, "flooding"), [entry("loud"), entry("blocking")], "node", "3 seconds"),
				).toStrictEqual([
					{ kind: "imported", file: entry("loud") },
					{ kind: "failed", file: entry("blocking"), message: "did not settle within 3 s" },
				]);
				expect(yield* importFiles(join(root, "flooding"), [entry("loud"), entry("exiting")], "node")).toStrictEqual(
					[
						{ kind: "imported", file: entry("loud") },
						{
							kind: "failed",
							file: entry("exiting"),
							message: expect.stringMatching(/^the process exited with code 3 before this entry settled/),
						},
					],
				);
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.effect("names the signal that ended the probe's process before an entry point settled", () =>
		Effect.gen(function* () {
			rmSync(join(root, "signalled"), { recursive: true, force: true });
			const entry = (name: string) => join(root, "signalled", "dist", `${name}.js`);
			write("signalled/dist/first.js", "export const first = 1;\n");
			write(
				"signalled/dist/killed.js",
				`process.kill(process.pid, "SIGTERM");\nawait new Promise(() => setInterval(() => {}, 1000));\nexport {};\n`,
			);
			expect(yield* importFiles(join(root, "signalled"), [entry("first"), entry("killed")], "node")).toStrictEqual([
				{ kind: "imported", file: entry("first") },
				{
					kind: "failed",
					file: entry("killed"),
					message: expect.stringMatching(/^a signal ended the process before this entry settled: .*SIGTERM/),
				},
			]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	// An entry point that starts a helper with its output inherited, which holds the probe's output open, and then ends
	// the process: by an exit with code 0, or by SIGTERM. Neither of them kills the helper's group on its own.
	for (const [ending, end, said] of [
		[
			"an exit with code 0",
			"process.exit(0);",
			/^the process exited with code 0 before this entry settled; it printed: .*exiting$/,
		],
		[
			"SIGTERM",
			`process.kill(process.pid, "SIGTERM");`,
			/^a signal ended the process before this entry settled: .*SIGTERM.*; it printed: .*exiting$/,
		],
	] as const) {
		it.live(`reports ${ending} at once while a helper holds the output open, and kills the helper`, () =>
			Effect.gen(function* () {
				const name = ending === "SIGTERM" ? "helper-signalled" : "helper-exited";
				rmSync(join(root, name), { recursive: true, force: true });
				const entry = (file: string) => join(root, name, "dist", `${file}.js`);
				const pidFile = join(root, name, "helper.pid");
				write(`${name}/dist/first.js`, "export const first = 1;\n");
				// The helper prints first, so its line comes before the entry's last one.
				const helper = `process.stdout.write("helper up\\n", () => require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))); setInterval(() => {}, 1000);`;
				write(
					`${name}/dist/ending.js`,
					[
						`import { spawn } from "node:child_process";`,
						`import { existsSync } from "node:fs";`,
						`spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], { stdio: "inherit" });`,
						`while (!existsSync(${JSON.stringify(pidFile)})) await new Promise((resolve) => setTimeout(resolve, 20));`,
						`await new Promise((resolve) => process.stdout.write("exiting\\n", resolve));`,
						end,
						"await new Promise(() => setInterval(() => {}, 1000));",
						"export {};",
						"",
					].join("\n"),
				);
				const started = Date.now();
				const imported = yield* importFiles(
					join(root, name),
					[entry("first"), entry("ending")],
					"node",
					"20 seconds",
				);
				expect(Date.now() - started).toBeLessThan(10_000);
				expect(imported).toStrictEqual([
					{ kind: "imported", file: entry("first") },
					{ kind: "failed", file: entry("ending"), message: expect.stringMatching(said) },
				]);
				yield* Effect.sleep("1 second");
				expect(alive(pidFile)).toBe(false);
			}).pipe(Effect.provide(NodeServices.layer)),
		);
	}

	it.effect(
		"generates from a surface 0.3.0 studied a facade that re-exports no value, which imports in Node: sharp's, as released",
		() =>
			Effect.gen(function* () {
				// Sharp's surface and recipe as effectified/packages released them with engine 0.3.0: its surface marks
				// nothing `erased`, since 0.3.0 never imported the package to see what Node can import by name.
				const released = join(import.meta.dirname, "released", "0.3.0", "sharp");
				const surface = readJson(Surface, join(released, "surface.json"));
				const directory = join(root, "released", "sharp");
				rmSync(directory, { recursive: true, force: true });
				const recipe = readJson(Recipe, join(released, "recipe.json"));
				const files = yield* generate(surface, recipe);
				expect(files.get("src/index.ts")).not.toMatch(/^export \{ [^}]+ \} from "sharp";$/m);
				// `reconcile` names the values it leaves out, `block` among them; once studied, Node's names decide.
				expect(restudyNote(surface, recipe)).toStrictEqual(
					Option.some(
						expect.stringMatching(
							/ \((?:\w+, )*block(?:, \w+)*\): `effectify study sharp@0\.35\.5` finds which of them Node can import, and the facade re-exports those$/,
						),
					),
				);
				const studied = absentAtRunTime(surface, Option.some(["default", "module.exports"]));
				expect(studied.runtime).toBe("imported");
				expect(valueExports(studied, recipe)).toStrictEqual({ kind: "reexported", names: [] });
				for (const [file, content] of files) {
					if (file.startsWith("src/")) write(join("released", "sharp", file), content);
				}
				// Sharp as Node sees it: one CommonJS export, whose properties (`block`, `format`...) its lexer cannot see.
				const values = surface.exports.filter((item) => item.name !== "default").map((item) => item.name);
				write("released/sharp/node_modules/sharp/package.json", `{ "name": "sharp", "main": "index.js" }`);
				write(
					"released/sharp/node_modules/sharp/index.js",
					`const sharp = () => ({});\nObject.assign(sharp, Object.fromEntries(${JSON.stringify(values)}.map((name) => [name, {}])));\nmodule.exports = sharp;\n`,
				);
				const file = join(directory, "src", "index.ts");
				expect(yield* importFiles(directory, [file], "node")).toStrictEqual([{ kind: "imported", file }]);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	// The runtime facades of the fixtures, generated and imported in Node against a stand-in for upstream that has
	// exactly the values their surface says Node can import by name. Frontend facades run in a browser: their own
	// tests import them there.
	for (const name of committed.filter(
		(fixture) => readJson(Recipe, join(fixtures, fixture, "recipe.json")).ui === undefined,
	)) {
		it.effect(`imports ${name}'s generated facade in Node`, () =>
			Effect.gen(function* () {
				const surface = readJson(Surface, join(fixtures, name, "surface.json"));
				const directory = join(root, "fixtures", name);
				rmSync(directory, { recursive: true, force: true });
				for (const [file, content] of yield* generate(
					surface,
					readJson(Recipe, join(fixtures, name, "recipe.json")),
				)) {
					if (file.startsWith("src/")) write(join("fixtures", name, file), content);
				}
				const upstream = join("fixtures", name, "node_modules", surface.package);
				write(
					join(upstream, "package.json"),
					JSON.stringify({ name: surface.package, type: "module", exports: "./index.js" }),
				);
				write(join(upstream, "index.js"), standIn(surface));
				const imported = yield* importFiles(directory, [join(directory, "src", "index.ts")], "node");
				expect(imported).toStrictEqual([{ kind: "imported", file: join(directory, "src", "index.ts") }]);
			}).pipe(Effect.provide(NodeServices.layer)),
		);
	}
});

describe("running a command", () => {
	const root = join(import.meta.dirname, "..", ".cache", "commands");
	// A command that exits with code 0 at once, leaving a worker in its process group with its output inherited, which
	// prints after 300 ms, as npm's and tsc's workers may after their main process exited. It writes the worker's pid.
	const exitingEarly = (name: string) => {
		const directory = join(root, name);
		rmSync(directory, { recursive: true, force: true });
		mkdirSync(directory, { recursive: true });
		const pidFile = join(directory, "worker.pid");
		const worker = `setTimeout(() => process.stdout.write("worker done\\n"), 300);`;
		writeFileSync(
			join(directory, "main.cjs"),
			[
				`const { spawn } = require("node:child_process");`,
				`const worker = spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { stdio: "inherit" });`,
				`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid));`,
				`process.stdout.write("main done\\n");`,
				"process.exit(0);",
				"",
			].join("\n"),
		);
		return { directory, pidFile, main: join(directory, "main.cjs") };
	};

	it.live("waits until an ordinary command's output ends: a worker's late output is kept", () =>
		Effect.gen(function* () {
			const { directory, main } = exitingEarly("ordinary");
			const result = yield* runCommand(process.execPath, [main], directory);
			expect(result).toStrictEqual({
				exitCode: 0,
				output: "main done\nworker done\n",
				stdout: "main done\nworker done\n",
			});
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live("keeps a command's stdout apart from its stderr, and gives it the variables it is passed", () =>
		Effect.gen(function* () {
			const directory = join(root, "streams");
			rmSync(directory, { recursive: true, force: true });
			mkdirSync(directory, { recursive: true });
			const script =
				'process.stderr.write("warning\\n"); process.stdout.write(`token ${process.env.STEP_TOKEN}\\n`);';
			const result = yield* runCommand(process.execPath, ["-e", script], directory, { STEP_TOKEN: "t1" });
			expect(result.output.split("\n").toSorted()).toStrictEqual(["", "token t1", "warning"]);
			expect(result.stdout).toBe("token t1\n");
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live("fails an ordinary command a signal ends at once, though a worker it started still holds its output", () =>
		Effect.gen(function* () {
			const directory = join(root, "signalled");
			rmSync(directory, { recursive: true, force: true });
			mkdirSync(directory, { recursive: true });
			const pidFile = join(directory, "worker.pid");
			// A worker with the output inherited that lives 3 s, then the command's own SIGTERM.
			writeFileSync(
				join(directory, "main.cjs"),
				[
					`const { spawn } = require("node:child_process");`,
					`const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: "inherit" });`,
					`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid));`,
					`process.kill(process.pid, "SIGTERM");`,
					"",
				].join("\n"),
			);
			const started = Date.now();
			const failed = yield* Effect.flip(runCommand(process.execPath, [join(directory, "main.cjs")], directory));
			expect(Date.now() - started).toBeLessThan(1_000);
			expect(failed._tag).toBe("CommandError");
			expect(failed.reason).toContain("SIGTERM");
			// The spawner ends the command's process group as the run's scope closes, so the worker went with it.
			yield* Effect.sleep("500 millis");
			expect(alive(pidFile)).toBe(false);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.live("ends a bounded command as it exits, and kills the worker its group still holds", () =>
		Effect.gen(function* () {
			const { directory, main, pidFile } = exitingEarly("bounded");
			const started = Date.now();
			const result = yield* runBounded(process.execPath, [main], directory, { deadline: "20 seconds" });
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(result).toStrictEqual({ kind: "exited", exitCode: 0, output: "main done\n", stdout: "main done\n" });
			yield* Effect.sleep("500 millis");
			expect(alive(pidFile)).toBe(false);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe("temporary paths", () => {
	// Under the engine's gitignored `.cache/`. A relative `TMPDIR`, as a runner may set it, is relative to the engine's
	// directory, and the probe and oxlint run in another.
	const root = join(import.meta.dirname, "..", ".cache", "relative-tmpdir");
	const write = (file: string, content: string) => {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), content);
	};
	const underRelativeTmpdir = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.acquireUseRelease(
			Effect.sync(() => {
				const saved = process.env["TMPDIR"];
				mkdirSync(join(root, "tmp"), { recursive: true });
				process.env["TMPDIR"] = relative(process.cwd(), join(root, "tmp"));
				expect(process.env["TMPDIR"]).toBe(join(".cache", "relative-tmpdir", "tmp"));
				return saved;
			}),
			() => effect,
			(saved) => Effect.sync(() => restore("TMPDIR", saved)),
		);

	it.effect("names the probe its results file as an absolute path under a relative TMPDIR", () =>
		Effect.gen(function* () {
			rmSync(join(root, "names"), { recursive: true, force: true });
			write(
				"names/node_modules/esm-lib/package.json",
				`{ "name": "esm-lib", "type": "module", "exports": "./index.js" }`,
			);
			write("names/node_modules/esm-lib/index.js", "export const a = 1;\nexport function b() {}\n");
			const names = yield* underRelativeTmpdir(moduleNames(join(root, "names"), "esm-lib", "node"));
			expect(names).toStrictEqual(Option.some(["a", "b"]));
			// The scope removed what it made under it.
			expect(readdirSync(join(root, "tmp"))).toStrictEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("names oxlint its config as an absolute path under a relative TMPDIR", () =>
		Effect.gen(function* () {
			rmSync(join(root, "lint"), { recursive: true, force: true });
			write("lint/planted.ts", PLANTED);
			const absolute = yield* idioms(join(root, "lint"), ["planted.ts"]);
			expect(absolute.filter((finding) => finding.startsWith("planted.ts:")).length).toBeGreaterThan(0);
			expect(yield* underRelativeTmpdir(idioms(join(root, "lint"), ["planted.ts"]))).toStrictEqual(absolute);
			expect(readdirSync(join(root, "tmp"))).toStrictEqual([]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe("what study runs", () => {
	const root = join(import.meta.dirname, "..");
	// A file's text with its comment markers and line breaks folded, so a sentence reads the same wherever it wraps.
	const prose = (file: string) =>
		readFileSync(join(root, file), "utf8")
			.replace(/\n\s*(?:\/\/|\*|\|)?\s*/g, " ")
			.replace(/\s+/g, " ");

	it("says it runs the target library's own code, only for a library one would install, and claims no containment", () => {
		const said = ["runs the target library's own code", "only on a library you would install", "not a sandbox"];
		const documents = ["README.md", "skills/effectify-engine/SKILL.md", "src/command.ts"];
		expect(documents.map((file) => [file, said.filter((sentence) => !prose(file).includes(sentence))])).toStrictEqual(
			documents.map((file) => [file, []]),
		);
		const containment = /does not trust|untrusted|outlives|not confine|contain(?:s|ed|ment)? (?:it|upstream|the)/;
		const claims = [...documents, "src/imports.ts"].map((file) => [file, containment.exec(prose(file))?.[0]]);
		expect(claims).toStrictEqual([...documents, "src/imports.ts"].map((file) => [file, undefined]));
	});
});

/** Sets the environment variable `name` back to `value`, or removes it when it had none. */
function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Whether the process whose pid `file` holds still runs; one that does is killed, so a failing test leaves none behind. */
function alive(file: string): boolean {
	if (!existsSync(file)) return false;
	const pid = Number(readFileSync(file, "utf8"));
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	process.kill(pid, "SIGKILL");
	return true;
}

/** A module standing in for upstream: each export the surface says Node can import by name, as a placeholder. */
function standIn(surface: Surface): string {
	const lines = surface.exports
		.filter((item) => item.erased === undefined)
		.map((item, index) => {
			const statics = item.kind === "class" ? Object.keys(item.statics ?? {}) : [];
			const value =
				item.kind === "class"
					? `class { ${statics.map((member) => `static ${JSON.stringify(member)}() {}`).join(" ")} }`
					: item.kind === "function"
						? "function () {}"
						: "{}";
			return `const value${index} = ${value};\nexport { value${index} as ${JSON.stringify(item.name)} };`;
		});
	return `${lines.join("\n")}\n`;
}

describe("an engine installed under a path with a space", () => {
	// A copy of the engine's sources under the gitignored `.cache/`, so `node_modules` resolves from the checkout.
	const spaced = join(import.meta.dirname, "..", ".cache", "with space");

	it("finds the runtimes it copies into a facade and the idioms plugin it hands oxlint", () => {
		rmSync(spaced, { recursive: true, force: true });
		cpSync(join(import.meta.dirname, "..", "src"), join(spaced, "src"), { recursive: true });
		mkdirSync(join(spaced, "planted"), { recursive: true });
		writeFileSync(join(spaced, "planted", "planted.ts"), "export const unnamed = Effect.fn(function* () {});\n");
		writeFileSync(join(spaced, "probe.ts"), SPACED_PROBE);
		const fixture = join(fixtures, "nodemailer");
		const output = execFileSync("node", [join(spaced, "probe.ts"), fixture, join(spaced, "planted")], {
			cwd: spaced,
			encoding: "utf8",
		});
		expect(JSON.parse(output)).toStrictEqual({
			runtime: true,
			plugin: true,
			idioms: ["planted.ts:1:24 effect-fn-name"],
		});
	});
});

/** Runs the copied engine: generates nodemailer's facade and lints a planted file with the idioms. */
const SPACED_PROBE = `import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { idioms } from "./src/diagnostics.ts";
import { generate } from "./src/generate.ts";
import { IDIOMS_PLUGIN } from "./src/idioms.ts";
import { Recipe } from "./src/recipe.ts";
import { Surface } from "./src/surface.ts";

const [fixture = "", planted = ""] = process.argv.slice(2);
const read = (file) => JSON.parse(readFileSync(join(fixture, file), "utf8"));
const program = Effect.gen(function* () {
	const files = yield* generate(Schema.decodeUnknownSync(Surface)(read("surface.json")), Schema.decodeUnknownSync(Recipe)(read("recipe.json")));
	const found = yield* idioms(planted, ["planted.ts"]);
	return {
		runtime: (files.get("src/internal/effectify.ts") ?? "").includes("export function effectify"),
		plugin: existsSync(IDIOMS_PLUGIN),
		idioms: found.map((finding) => finding.slice(0, finding.indexOf(": "))),
	};
});
console.log(JSON.stringify(await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)))));
`;

/** Sites of two Effect rules, one a facade's sources keep and tests do not, and code TypeScript 7.1 rejects. */
const PLANTED_RULES = `import { Effect } from "effect";
export const floating = Effect.gen(function* () {
	Effect.log("floating");
});
export const now = () => Date.now();
interface Acquired {
	readonly release: (options?: { keep?: boolean }) => void;
}
export const acquire = (): Acquired => ({ release: ({ keep } = {}) => void keep });
`;

/** One site of each idiom, sites each rule leaves alone, and the `idiom-allow` marker with and without a reason. */
const PLANTED = `import { Effect, Schema } from "effect";
export const arrow = () => Effect.gen(function* () {});
export function declared() {
	return Effect.gen(function* () {});
}
export class Service {
	method() {
		return Effect.gen(function* () {});
	}
}
export const unnamed = Effect.fn(function* () {});
export const named = Effect.fn("named")(function* () {});
export const piped = Effect.void.pipe(Effect.andThen(() => Effect.gen(function* () {})));
export const choose = (x: number) => {
	switch (x) {
		default:
			return x;
	}
};
export const Ids = Schema.Struct({ jobId: Schema.String, label: Schema.String, ownerKey: Schema.String.pipe(Schema.brand("OwnerKey")) });
export const hot = (x: { readonly _tag: string }) => {
	// idiom-allow match: a per-item hot path
	switch (x._tag) {
		default:
			return x;
	}
};
// idiom-allow effect-fn-arrow:
export const unexplained = () => Effect.gen(function* () {});
type Tagged = { readonly _tag: "A"; readonly type: "a"; readonly kind: "k"; readonly status: "s"; readonly state: "t"; readonly name: string };
export const tags = (value: Tagged, maybe: Tagged | undefined, response: { readonly status: number }) => {
	switch (value._tag) { default: }
	switch (maybe?._tag) { default: }
	switch (value["_tag"]) { default: }
	switch (value!._tag) { default: }
	switch (value._tag as "A") { default: }
	switch ((value as Tagged)._tag) { default: }
	switch (value.type) { default: }
	switch (value.kind) { default: }
	switch (value.status) { default: }
	switch (value.state) { default: }
	switch (maybe?.type) { default: }
	switch (value["kind"]) { default: }
	switch (response.status) { default: }
	switch (value.name) { default: }
	switch (value._tag.length) { default: }
	switch (true) { default: }
	switch ((<Tagged>value)._tag) { default: }
	switch (<"A">value._tag) { default: }
	switch ((<"A">value._tag)) { default: }
};
`;

describe("generate: what each method gives at run time, as its type says", () => {
	const signature = (fields: Partial<Signature>): Signature => ({
		parameters: [],
		trailingCallback: false,
		returns: "void",
		traits: ["sync"],
		...fields,
	});
	const method = (count: number) =>
		Object.fromEntries(Array.from({ length: count }, (_, index) => [`m${index}`, [signature({})]]));
	const surface = Schema.decodeUnknownSync(Surface)({
		package: "page-lib",
		version: "1.0.0",
		types: { from: "bundled", package: "page-lib", version: "1.0.0" },
		entry: "named",
		typeExports: ["HandleFor"],
		exports: [],
		handles: {
			Page: {
				name: "Page",
				typeRef: "Upstream.Page",
				methods: {
					// Puppeteer's `evaluateHandle`: a conditional of two handles, chosen by the call's type arguments.
					evaluateHandle: [
						signature({
							typeParameters: "T",
							returns: "Promise<HandleFor<T>>",
							resolves: "HandleFor<T>",
							handles: ["JSHandle", "ElementHandle"],
							traits: ["async"],
						}),
					],
					// A synchronous method whose handle may be absent.
					opener: [signature({ returns: "Page | null" })],
				},
				properties: {},
				events: [],
				releases: [],
			},
			JSHandle: {
				name: "JSHandle",
				typeRef: "Upstream.JSHandle",
				methods: { dispose: [signature({ returns: "Promise<void>", resolves: "void", traits: ["async"] })] },
				properties: {},
				events: [],
				releases: ["dispose"],
			},
			ElementHandle: {
				name: "ElementHandle",
				typeRef: "Upstream.ElementHandle",
				methods: {
					dispose: [signature({ returns: "Promise<void>", resolves: "void", traits: ["async"] })],
					...method(2),
				},
				properties: {},
				events: [],
				releases: ["dispose"],
			},
		},
	});
	const recipe = Schema.decodeUnknownSync(Recipe)({
		package: "page-lib",
		version: "1.0.0",
		types: { from: "bundled", package: "page-lib", version: "1.0.0" },
		name: "@effectified/page-lib",
		prefix: "PageLib",
		exports: [],
		handles: {
			Page: { events: [] },
			JSHandle: { release: "dispose", events: [] },
			ElementHandle: { release: "dispose", events: [] },
		},
		errors: [{ tag: "PageLibError", codes: [] }],
		services: [],
		methods: {},
		derived: ["Page.evaluateHandle"],
		testDependencies: {},
		decisions: [],
	});

	it.effect(
		"lists a conditional result's handles as a choice, the narrowest first, a synchronous handle that may be absent as returned, and checks both against the types",
		() =>
			Effect.gen(function* () {
				const source = (yield* generate(surface, recipe)).get("src/index.ts") ?? "";
				expect(source).toContain(`\t\t\treturns: { "opener": "Page" },`);
				expect(source).toContain(`\t\t\tchoices: { "evaluateHandle": ["ElementHandle", "JSHandle"] },`);
				expect(source).toContain(
					'\tEffectify.ExpectNone<Effectify.Disagreeing<{ readonly evaluateHandle: Effectify.LiftedResult<typeof instanceOfPage.evaluateHandle, Failure, Handles> }, "evaluateHandle", typeof kinds.Page.spec, Handles>>, // gives: Page, lifted',
				);
				expect(source).toContain(
					`\tEffectify.ExpectNone<Effectify.Disagreeing<Page, Exclude<PageMethods, "evaluateHandle"> | PageProperties, typeof kinds.Page.spec, Handles>>, // gives: Page`,
				);
			}).pipe(Effect.provide(NodeServices.layer)),
	);
});

describe("generate: classes made by statics, annotated exports, lifted methods", () => {
	const signature = (fields: Partial<Signature>): Signature => ({
		parameters: [],
		trailingCallback: false,
		returns: "void",
		traits: ["sync"],
		...fields,
	});
	const surface = Schema.decodeUnknownSync(Surface)({
		package: "runtime-lib",
		version: "1.0.0",
		types: { from: "bundled", package: "runtime-lib", version: "1.0.0" },
		entry: "named",
		typeExports: ["Options"],
		// `study` imported it in Node and marked each export Node cannot import by name `erased`.
		runtime: "imported",
		handles: {
			Runtime: {
				name: "Runtime",
				typeRef: "Upstream.Runtime",
				methods: {
					close: [signature({ returns: "Promise<void>", resolves: "void", traits: ["async"] })],
					pick: [
						signature({
							typeParameters: "K extends Hidden",
							parameters: [{ name: "key", type: "K", optional: false, rest: false }],
							returns: "Promise<K>",
							resolves: "K",
							traits: ["async"],
						}),
					],
				},
				properties: {},
				events: [],
				releases: ["close"],
			},
		},
		exports: [
			{
				kind: "class",
				name: "Runtime",
				handle: "Runtime",
				// Its constructor is private: the analyzer reads none, and the class is made by `create`.
				constructors: [],
				statics: {
					create: [
						signature({
							parameters: [{ name: "options", type: "Options", optional: true, rest: false }],
							returns: "Promise<Runtime>",
							resolves: "Runtime",
							handle: "Runtime",
							traits: ["async"],
						}),
					],
					version: [signature({ returns: "string" })],
				},
				error: false,
			},
			{
				kind: "class",
				name: "HttpError",
				handle: "HttpError",
				constructors: [],
				error: true,
				fields: [
					{ name: "body", type: "string | undefined", optional: true },
					{ name: "kind", type: '"client" | "server"', optional: false },
					{ name: "operation", type: "string", optional: false },
					{ name: "request", type: "Request", optional: false },
					{ name: "status", type: "number", optional: false },
					{ name: "syscall", type: "string", optional: false },
					{ name: "errno", type: "Errno", optional: false },
				],
			},
			{ kind: "value", name: "LIMIT", type: "100" },
			{ kind: "value", name: "Mode", type: "typeof Mode", erased: "declarations" },
			// A namespace its `.d.ts` re-exports from another package and its JavaScript does not (puppeteer's `Session`).
			{ kind: "value", name: "Session", type: "typeof Session", erased: "runtime" },
			// A function of a CommonJS module whose named exports Node cannot detect (sharp's `block`).
			{
				kind: "function",
				name: "block",
				signatures: [signature({ returns: "void" })],
				erased: "runtime",
			},
			{
				kind: "function",
				name: "format",
				signatures: [
					signature({
						parameters: [{ name: "value", type: "number", optional: false, rest: false }],
						returns: "string",
					}),
				],
			},
			{
				kind: "function",
				name: "fetchAll",
				signatures: [signature({ returns: "Promise<string>", resolves: "string", traits: ["async"] })],
			},
		],
	});
	const recipe = Schema.decodeUnknownSync(Recipe)({
		package: "runtime-lib",
		version: "1.0.0",
		types: { from: "bundled", package: "runtime-lib", version: "1.0.0" },
		name: "@effectified/runtime-lib",
		prefix: "RuntimeLib",
		exports: ["Runtime"],
		handles: { Runtime: { release: "close", events: [] } },
		errors: [
			{ tag: "HttpError", instanceOf: "HttpError", codes: [] },
			{ tag: "RuntimeLibError", codes: [] },
		],
		services: [],
		methods: {},
		derived: ["Runtime.pick"],
		testDependencies: {},
		decisions: [],
	});

	it.effect(
		"offers async statics under the class's name, no constructor, and lifts each generic method on its own marked line",
		() =>
			Effect.gen(function* () {
				const source = (yield* generate(surface, recipe)).get("src/index.ts") ?? "";
				expect(source).not.toContain("makeRuntime");
				expect(source).toContain("export const Runtime: StaticsRuntime = {");
				expect(source).toContain(
					`\tcreate: Effectify.entry<typeof Upstream.Runtime.create, Failure, Handles>(Upstream.Runtime.create.bind(Upstream.Runtime), "Runtime.create", kinds.Runtime, kinds, classify),`,
				);
				// A sync static that yields no handle is not offered, as the draft offers functions.
				expect(source).not.toContain("version:");
				expect(source).toContain(
					"const liftedRuntime_pick = () => Effectify.lifted<Failure, Handles, false, never, false>()(instanceOfRuntime.pick); // lifted: Runtime.pick",
				);
				expect(source).toContain("readonly pick: ReturnType<typeof liftedRuntime_pick>; // lifted: Runtime.pick");
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"carries an error class's own fields, its strings scrubbed of the call's secrets, its codes as they are, any other value Redacted",
		() =>
			Effect.gen(function* () {
				const source = (yield* generate(surface, recipe)).get("src/index.ts") ?? "";
				expect(source).toContain(`import { Redacted, Schema } from "effect";`);
				expect(source).toContain(
					`export class HttpError extends Schema.TaggedError<HttpError, { readonly brand: unique symbol }>()("HttpError", { ...Effectify.errorFields, body: Schema.optional(Schema.String), kind: Schema.Literals(["client", "server"]), upstreamOperation: Schema.String, request: Effectify.Sealed, status: Schema.Finite, syscall: Schema.String, errno: Schema.Unknown }) {}`,
				);
				expect(source).toContain("const classify: Effectify.Classify<Failure> = (operation, cause, secrets) => {");
				expect(source).toContain("\tconst fields = Effectify.describe(operation, cause, secrets);");
				expect(source).toContain(
					"\tif (cause instanceof Upstream.HttpError) return HttpError.make({ ...fields, body: Effectify.scrubbed(cause.body, secrets), kind: cause.kind, upstreamOperation: Effectify.scrubbed(cause.operation, secrets), request: Redacted.make(cause.request), status: cause.status, syscall: cause.syscall, errno: cause.errno }, Effectify.unchecked);",
				);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("gives an error with codes a reason union to catch by, and every error a Failure schema to match on", () =>
		Effect.gen(function* () {
			const coded = {
				...recipe,
				errors: [
					{ tag: "HttpError", instanceOf: "HttpError", codes: ["E_RATE"] },
					{ tag: "AuthError", codes: ["E_AUTH", "E_TOKEN"] },
					{ tag: "RuntimeLibError", codes: ["E_IO"] },
				],
			};
			const source = (yield* generate(surface, coded)).get("src/index.ts") ?? "";
			// An upstream class with codes is reached by instance too: it has a case for any other code.
			expect(source).toContain(`export const HttpErrorReason = Schema.TaggedUnion({ E_RATE: {}, Other: {} });`);
			expect(source).toContain(`export const AuthErrorReason = Schema.TaggedUnion({ E_AUTH: {}, E_TOKEN: {} });`);
			expect(source).toContain(
				`export const Failure = Schema.Union([HttpError, AuthError, RuntimeLibError]).pipe(Schema.toTaggedUnion("_tag"));`,
			);
			expect(source).toContain(`reason: { _tag: Effectify.codeIn(HttpErrorCodes, fields.code) ?? "Other" }`);
			expect(source).toContain("\tconst authErrorCode = Effectify.codeIn(AuthErrorCodes, fields.code);");
			expect(source).toContain(
				"\tif (authErrorCode !== undefined) return AuthError.make({ ...fields, reason: { _tag: authErrorCode } }, Effectify.unchecked);",
			);
			expect(source).toContain(
				`\treturn RuntimeLibError.make({ ...fields, reason: { _tag: Effectify.codeIn(RuntimeLibErrorCodes, fields.code) ?? "Other" } }, Effectify.unchecked);`,
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"names the case for any other code the first of Other, Unlisted, Unlisted2, ... that is no upstream code, and the facade type checks",
		() =>
			Effect.gen(function* () {
				const types = { from: "bundled", package: "fallback-lib", version: "1.0.0" } as const;
				const bare = yield* Schema.decodeEffect(Surface)({
					package: "fallback-lib",
					version: "1.0.0",
					types,
					entry: "named",
					exports: [],
					handles: {},
					typeExports: [],
					runtime: "imported",
				});
				const catchAll = yield* Schema.decodeEffect(Recipe)({
					package: "fallback-lib",
					version: "1.0.0",
					types,
					name: "@effectified/fallback-lib",
					prefix: "FallbackLib",
					exports: [],
					handles: {},
					errors: [],
					services: [],
					methods: {},
					derived: [],
					testDependencies: {},
					decisions: [],
				});
				const generated = (codes: ReadonlyArray<string>) =>
					generate(bare, { ...catchAll, errors: [{ tag: "FallbackLibError", codes }] });
				const fallbackOf = Effect.fn(function* (codes: ReadonlyArray<string>) {
					const source = (yield* generated(codes)).get("src/index.ts") ?? "";
					const cases = /FallbackLibErrorReason = Schema\.TaggedUnion\(\{ (.*) \}\);/.exec(source)?.[1];
					const fallback = /fields\.code\) \?\? "(\w+)"/.exec(source)?.[1];
					return { cases, fallback };
				});
				expect(yield* fallbackOf(["E_IO"])).toStrictEqual({ cases: "E_IO: {}, Other: {}", fallback: "Other" });
				expect(yield* fallbackOf(["Other"])).toStrictEqual({
					cases: "Other: {}, Unlisted: {}",
					fallback: "Unlisted",
				});
				// A BullMQ-like catch-all whose codes hold both names 0.4.0's first rule would have used.
				expect(yield* fallbackOf(["Other", "Unlisted"])).toStrictEqual({
					cases: "Other: {}, Unlisted: {}, Unlisted2: {}",
					fallback: "Unlisted2",
				});
				expect(yield* fallbackOf(["Unlisted2", "Other", "Unlisted"])).toStrictEqual({
					cases: "Unlisted2: {}, Other: {}, Unlisted: {}, Unlisted3: {}",
					fallback: "Unlisted3",
				});
				// The facade compiles with the compiler its users build with: no case named twice (TS1117).
				const project = join(import.meta.dirname, "..", ".cache", "fallback-reason");
				rmSync(project, { recursive: true, force: true });
				for (const [file, content] of yield* generated(["Other", "Unlisted"])) {
					if (!file.startsWith("src/") && file !== "tsconfig.json") continue;
					mkdirSync(dirname(join(project, file)), { recursive: true });
					writeFileSync(join(project, file), content);
				}
				mkdirSync(join(project, "node_modules", "fallback-lib"), { recursive: true });
				writeFileSync(
					join(project, "node_modules", "fallback-lib", "package.json"),
					`{ "name": "fallback-lib", "type": "module", "exports": { ".": { "types": "./index.d.ts", "default": "./index.js" } } }`,
				);
				writeFileSync(join(project, "node_modules", "fallback-lib", "index.d.ts"), "export {};\n");
				writeFileSync(join(project, "node_modules", "fallback-lib", "index.js"), "export {};\n");
				const compiled = spawnSync(
					process.execPath,
					[
						join(import.meta.dirname, "..", "node_modules", "typescript", "bin", "tsc"),
						"-p",
						project,
						"--pretty",
						"false",
					],
					{ encoding: "utf8" },
				);
				expect({ status: compiled.status, output: compiled.stdout + compiled.stderr }).toStrictEqual({
					status: 0,
					output: "",
				});
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.effect(
		"resolves a value that may be absent to an Option, takes the secrets the recipe names as Redacted, and checks each path",
		() =>
			Effect.gen(function* () {
				const lookups = yield* Schema.decodeUnknownEffect(Surface)({
					...surface,
					exports: [
						...surface.exports,
						{
							kind: "function",
							name: "lookup",
							signatures: [
								signature({
									parameters: [{ name: "options", type: "Options", optional: false, rest: false }],
									returns: "Promise<Runtime | undefined>",
									resolves: "Runtime | undefined",
									traits: ["async"],
								}),
							],
						},
					],
				});
				const decided = {
					...recipe,
					exports: ["Runtime", "lookup"],
					secrets: { lookup: ["0.token"], missing: ["0.x"] },
					untraced: ["lookup"],
				};
				const source = (yield* generate(lookups, decided)).get("src/index.ts") ?? "";
				expect(source).toContain(
					`export const lookup: Effectify.EffectFunction<typeof Upstream.lookup, Failure, Handles, true, Effectify.Redacting<readonly ["0", "token"]>> = Effectify.entry<typeof Upstream.lookup, Failure, Handles, true, Effectify.Redacting<readonly ["0", "token"]>>(Upstream.lookup, "lookup", kinds.Runtime, kinds, classify, { option: true, untraced: true, secrets: [["0", "token"]] });`,
				);
				expect(source).toContain(
					`\tEffectify.Expect<Effectify.ReachesString<Parameters<Effectify.Overloads<typeof Upstream.lookup>>, readonly ["0", "token"]>>, // secret: lookup 0.token`,
				);
				expect(source).toContain(
					"\tEffectify.Expect<false>, // secret: missing 0.x names no call or property the facade offers",
				);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"re-exports upstream's types, and the values that need no wrapping, unless the facade declares the name",
		() =>
			Effect.gen(function* () {
				const source = (yield* generate(surface, recipe)).get("src/index.ts") ?? "";
				expect(source).toContain(`export type * from "runtime-lib";`);
				// Not `fetchAll` (async, not offered), not `HttpError` (the facade's own error), and none Node cannot
				// import by name: `Mode` (a const enum), `Session` and `block` (absent from the module at run time).
				expect(source).toContain(`export { LIMIT, format } from "runtime-lib";`);
				expect(valueExports(surface, recipe)).toStrictEqual({ kind: "reexported", names: ["LIMIT", "format"] });
				expect(restudyNote(surface, recipe)).toStrictEqual(Option.none());
				// A surface studied before 0.4.0 tells nothing of the run time: no value, and a note on what `study` adds.
				const unprobed = { ...surface, runtime: undefined };
				expect((yield* generate(unprobed, recipe)).get("src/index.ts")).not.toMatch(
					/^export \{ [^}]+ \} from "runtime-lib";$/m,
				);
				expect(valueExports(unprobed, recipe)).toStrictEqual({ kind: "unprobed", withheld: ["LIMIT", "format"] });
				expect(restudyNote(unprobed, recipe)).toStrictEqual(
					Option.some(
						"runtime-lib's surface.json was studied before engine 0.4.0 and tells nothing of what Node can import from it by name, so the facade re-exports none of its 2 values that need no wrapping (LIMIT, format): `effectify study runtime-lib@1.0.0` finds which of them Node can import, and the facade re-exports those",
					),
				);
				// One whose package Node could not import: no value either, and nothing `study` would add.
				const unimportable = { ...surface, runtime: "unimportable" as const };
				expect(valueExports(unimportable, recipe)).toStrictEqual({ kind: "unimportable" });
				expect(restudyNote(unimportable, recipe)).toStrictEqual(Option.none());
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("exports each brand as a Schema, brands a property, a parameter and a result, and checks each place", () =>
		Effect.gen(function* () {
			const runtimes = yield* Schema.decodeUnknownEffect(Surface)({
				...surface,
				handles: {
					...surface.handles,
					Runtime: {
						...surface.handles["Runtime"],
						properties: { id: { type: "string | undefined" } },
						methods: {
							...surface.handles["Runtime"]?.methods,
							job: [
								signature({
									parameters: [{ name: "runtimeId", type: "string", optional: false, rest: false }],
									returns: "Promise<{ id: string }>",
									resolves: "{ id: string }",
									traits: ["async"],
								}),
							],
						},
					},
				},
			});
			const decided = {
				...recipe,
				brands: { RuntimeId: ["Runtime.id", "Runtime.job(0)", "Runtime.job().id", "Runtime.pick().x", "nowhere"] },
			};
			const source = (yield* generate(runtimes, decided)).get("src/index.ts") ?? "";
			expect(source).toContain(`export const RuntimeId = Schema.String.pipe(Schema.brand("RuntimeId"));`);
			expect(source).toContain(`export type RuntimeId = typeof RuntimeId.Type;`);
			expect(source).toContain(
				`, RuntimeOptional, RuntimeFacades, { readonly job: Effectify.Branding<readonly ["0"], RuntimeId> }>`,
			);
			expect(source).toContain(
				`\treadonly id: Effectify.Branded<Upstream.Runtime["id"], RuntimeId>; // brand: Runtime.id`,
			);
			expect(source).toContain(`\treadonly job: Effectify.ResolvingBranded<`);
			expect(source).toContain(
				`\tEffectify.Expect<Effectify.ReachesString<Upstream.Runtime["id"], readonly []>>, // brand: RuntimeId Runtime.id`,
			);
			expect(source).toContain(
				`\tEffectify.Expect<Effectify.ReachesString<Awaited<ReturnType<Effectify.Overloads<Upstream.Runtime["job"]>>>, readonly ["id"]>>, // brand: RuntimeId Runtime.job().id`,
			);
			// `pick` is generic and kept derived through a call: its result keeps its type parameters, so it takes no brand.
			expect(source).toContain(
				"\tEffectify.Expect<false>, // brand: RuntimeId Runtime.pick().x: a call typed by its written-out overloads takes no result brand",
			);
			expect(source).toContain("\tEffectify.Expect<false>, // brand: RuntimeId nowhere is no place");
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"borrows the handle a lookup resolves to: the recipe's lookups, else the methods named after their handle",
		() =>
			Effect.gen(function* () {
				const runtimes = yield* Schema.decodeUnknownEffect(Surface)({
					...surface,
					handles: {
						...surface.handles,
						Runtime: {
							...surface.handles["Runtime"],
							methods: {
								...surface.handles["Runtime"]?.methods,
								// Finds the runtime that exists, as puppeteer's `Target.page()` its page; `fork` makes one.
								runtime: [
									signature({
										returns: "Promise<Runtime | null>",
										resolves: "Runtime | null",
										traits: ["async"],
									}),
								],
								fork: [
									signature({
										returns: "Promise<Runtime>",
										resolves: "Runtime",
										handle: "Runtime",
										traits: ["async"],
									}),
								],
								// Synchronous, returning its own handle's type: the receiver itself (`this`), borrowed by the rule.
								parent: [signature({ returns: "Runtime", handle: "Runtime" })],
								shutdown: [signature({ returns: "Promise<void>", resolves: "void", traits: ["async"] })],
							},
							releases: ["close", "shutdown"],
						},
					},
				});
				const ruled = (yield* generate(runtimes, recipe)).get("src/index.ts") ?? "";
				expect(ruled).toContain(`type RuntimeBorrowed = "parent" | "runtime";`);
				expect(ruled).toContain(`\t\t\treturns: { "fork": "Runtime", "parent": "Runtime", "runtime": "Runtime" },`);
				expect(ruled).toContain(
					`\t\t\tborrowed: { "parent": true, "runtime": true } satisfies Record<RuntimeBorrowed, true>,`,
				);
				expect(ruled).toContain(", RuntimeOptional, RuntimeFacades, {}, RuntimeBorrowed>");
				// A borrowed facade offers none of the methods that release its handle, in its type and at run time.
				expect(ruled).toContain(`\t| readonly [Upstream.Runtime, Runtime, true, "close" | "shutdown"];`);
				expect(ruled).toContain(`\t\trelease: "close",\n\t\treleases: ["close", "shutdown"],`);
				// The recipe's list wins over the rule both ways: `fork` borrowed, `parent` and `runtime` owned.
				const decided =
					(yield* generate(runtimes, { ...recipe, borrowed: ["Runtime.fork"] })).get("src/index.ts") ?? "";
				expect(decided).toContain(`\t\t\tborrowed: { "fork": true } satisfies Record<RuntimeBorrowed, true>,`);
				const none = (yield* generate(runtimes, { ...recipe, borrowed: [] })).get("src/index.ts") ?? "";
				expect(none).not.toContain("RuntimeBorrowed");
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"owns the releasable handle a synchronous method makes, and borrows the receiver, a handle it holds and a lookup",
		() =>
			Effect.gen(function* () {
				const sessions = yield* Schema.decodeUnknownEffect(Surface)({
					...surface,
					handles: {
						...surface.handles,
						Runtime: {
							...surface.handles["Runtime"],
							methods: {
								...surface.handles["Runtime"]?.methods,
								// Makes a session: the caller owns it, so its facade keeps `end`.
								create: [signature({ returns: "Session", handle: "Session" })],
								// Finds the session that exists: a lookup by name.
								session: [signature({ returns: "Session", handle: "Session" })],
								with: [signature({ returns: "Runtime", handle: "Runtime" })],
							},
						},
						Session: {
							name: "Session",
							typeRef: "Upstream.Session",
							methods: {
								end: [signature({ returns: "Promise<void>", resolves: "void", traits: ["async"] })],
								// Returns the runtime the session holds as a property.
								owner: [signature({ returns: "Runtime", handle: "Runtime" })],
							},
							properties: { runtime: { type: "Runtime", handle: "Runtime" } },
							events: [],
							releases: ["end"],
						},
					},
				});
				const handles = { Runtime: { release: "close", events: [] }, Session: { release: "end", events: [] } };
				const ruled = (yield* generate(sessions, { ...recipe, handles })).get("src/index.ts") ?? "";
				expect(ruled).toContain(`type RuntimeBorrowed = "session" | "with";`);
				expect(ruled).toContain(`type SessionBorrowed = "owner";`);
				// An explicit list, empty too, wins over the rule: every synchronous handle is then owned.
				const listed = (yield* generate(sessions, { ...recipe, handles, borrowed: [] })).get("src/index.ts") ?? "";
				expect(listed).not.toContain("Borrowed =");
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("drafts the borrowed list from the rule, for a person to confirm", () =>
		Effect.gen(function* () {
			const sessions = yield* Schema.decodeUnknownEffect(Surface)({
				...surface,
				handles: {
					...surface.handles,
					Runtime: {
						...surface.handles["Runtime"],
						methods: {
							...surface.handles["Runtime"]?.methods,
							chain: [signature({ returns: "Runtime", handle: "Runtime" })],
							fork: [
								signature({
									returns: "Promise<Runtime>",
									resolves: "Runtime",
									handle: "Runtime",
									traits: ["async"],
								}),
							],
							runtime: [
								signature({
									returns: "Promise<Runtime>",
									resolves: "Runtime",
									handle: "Runtime",
									traits: ["async"],
								}),
							],
						},
					},
				},
			});
			const drafted = yield* draftRecipe(
				sessions,
				{ files: 0, errorClasses: [], codes: [], events: [] },
				"",
				recipe,
				false,
			);
			expect(drafted.borrowed).toStrictEqual(["Runtime.chain", "Runtime.runtime"]);
			expect(drafted.decisions.find((decision) => decision.id === "borrowed")?.why).toContain(
				"a synchronous method returning its own handle",
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("owns what a synchronous clone returns, and leaves the rule's guesses to a person", () =>
		Effect.gen(function* () {
			const copies = yield* Schema.decodeUnknownEffect(Surface)({
				...surface,
				handles: {
					...surface.handles,
					Runtime: {
						...surface.handles["Runtime"],
						methods: {
							...surface.handles["Runtime"]?.methods,
							// Each makes a new runtime of the same type: the caller owns it, release and all.
							clone: [signature({ returns: "Runtime", handle: "Runtime" })],
							copy: [signature({ returns: "Runtime", handle: "Runtime" })],
							duplicateWith: [signature({ returns: "Runtime", handle: "Runtime" })],
							// The receiver itself, as the rule reads a declared `this`.
							chain: [signature({ returns: "Runtime", handle: "Runtime" })],
						},
					},
				},
			});
			const drafted = yield* draftRecipe(
				copies,
				{ files: 0, errorClasses: [], codes: [], events: [] },
				"",
				recipe,
				false,
			);
			expect(drafted.borrowed).toStrictEqual(["Runtime.chain"]);
			const decision = drafted.decisions.find((candidate) => candidate.id === "borrowed");
			expect(decision?.by).toBe("engine");
			expect(decision?.why).toContain("for a person to confirm (the types cannot tell)");
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"drafts a release for a handle a property holds only by the engine's rule: named so, and callable with no argument",
		() =>
			Effect.gen(function* () {
				const held = yield* Schema.decodeUnknownEffect(Surface)({
					...surface,
					handles: {
						...surface.handles,
						Runtime: {
							...surface.handles["Runtime"],
							properties: {
								transport: { type: "Transport", handle: "Transport" },
								dispatcher: { type: "Dispatcher", handle: "Dispatcher" },
								animator: { type: "Animator", handle: "Animator" },
							},
						},
						// Nodemailer's `Mail.transporter`: its `close` shuts the pool its owner made.
						Transport: {
							name: "Transport",
							typeRef: "Upstream.Transport",
							methods: { close: [signature({})], send: [signature({})] },
							properties: {},
							events: [],
							releases: ["close"],
						},
						// MapLibre's `Style.dispatcher`: `remove` releases its workers, but the name also takes a node out of
						// its tree (postcss) or a child out of its namespace (protobuf.js): a person names it, the draft never.
						Dispatcher: {
							name: "Dispatcher",
							typeRef: "Upstream.Dispatcher",
							methods: { remove: [signature({})], broadcast: [signature({})] },
							properties: {},
							events: [],
							releases: [],
						},
						// Chart.js's `Animator.stop(chart)`, as a surface studied before the rule lists it: it stops one chart's
						// animations and takes the chart, which a scope's finalizer has none of.
						Animator: {
							name: "Animator",
							typeRef: "Upstream.Animator",
							methods: {
								stop: [
									signature({
										parameters: [{ name: "chart", type: "Chart", optional: false, rest: false }],
									}),
								],
							},
							properties: {},
							events: [],
							releases: ["stop"],
						},
					},
				});
				const drafted = yield* draftRecipe(
					held,
					{ files: 0, errorClasses: [], codes: [], events: [] },
					"",
					undefined,
					false,
				);
				expect(drafted.handles["Transport"]?.release).toBe("close");
				expect(drafted.decisions.find((decision) => decision.id === "handles.Transport.release")?.why).toContain(
					"Runtime.transport holds it",
				);
				expect(drafted.handles["Dispatcher"]?.release).toBeUndefined();
				expect(drafted.handles["Animator"]?.release).toBeUndefined();
				expect(drafted.decisions.find((decision) => decision.id === "handles.Animator.release")?.answer).toBe(
					"none",
				);
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"lifts the arrays of handles methods and properties give: an Effect's owned unless borrowed, written-out signatures too",
		() =>
			Effect.gen(function* () {
				const listing = yield* Schema.decodeUnknownEffect(Surface)({
					...surface,
					typeExports: [...surface.typeExports, "Page"],
					handles: {
						...surface.handles,
						Runtime: {
							...surface.handles["Runtime"],
							methods: {
								...surface.handles["Runtime"]?.methods,
								pages: [signature({ returns: "Promise<Page[]>", resolves: "Page[]", traits: ["async"] })],
								targets: [signature({ returns: "readonly Page[]" })],
								handles: [signature({ returns: "Array<Page>" })],
								// A generic method, written out from its declaration.
								select: [
									signature({
										typeParameters: "S extends string",
										parameters: [{ name: "selector", type: "S", optional: false, rest: false }],
										returns: "Promise<ReadonlyArray<Page>>",
										resolves: "ReadonlyArray<Page>",
										traits: ["async"],
									}),
								],
								// Not lists: an array of no handle, of a union, and one that may be absent.
								names: [signature({ returns: "string[]" })],
								mixed: [signature({ returns: "(Page | null)[]" })],
								maybe: [
									signature({
										returns: "Promise<Page[] | undefined>",
										resolves: "Page[] | undefined",
										traits: ["async"],
									}),
								],
							},
							properties: { open: { type: "readonly Page[]" }, label: { type: "string" } },
						},
						Page: {
							name: "Page",
							typeRef: "Upstream.Page",
							methods: { close: [signature({ returns: "Promise<void>", resolves: "void", traits: ["async"] })] },
							properties: {},
							events: [],
							releases: ["close"],
						},
					},
				});
				const handles = { Runtime: { release: "close", events: [] }, Page: { release: "close", events: [] } };
				const source = (yield* generate(listing, { ...recipe, handles, derived: [] })).get("src/index.ts") ?? "";
				expect(source).toContain(
					`\t\t\tlists: { "handles": "Page", "open": "Page", "pages": "Page", "select": "Page", "targets": "Page" },`,
				);
				expect(source).toContain(
					"\tselect<S extends string>(selector: S): Effectify.ResolvedList<ReadonlyArray<Upstream.Page>, Failure, Handles>; // explicit: Runtime.select",
				);
				// `pages` is named after its handle, a lookup: borrowed by the rule. `select` makes its pages (puppeteer's
				// `$$`): the caller's. A synchronous call's list and a property's are borrowed by the runtime, never listed.
				expect(source).toContain(`type RuntimeBorrowed = "pages";`);
				expect(source).toContain(`\t\t\tborrowed: { "pages": true } satisfies Record<RuntimeBorrowed, true>,`);
				// The recipe's list wins over the rule both ways: `select` borrowed, `pages` owned.
				const decided =
					(yield* generate(listing, { ...recipe, handles, derived: [], borrowed: ["Runtime.select"] })).get(
						"src/index.ts",
					) ?? "";
				expect(decided).toContain(`\t\t\tborrowed: { "select": true } satisfies Record<RuntimeBorrowed, true>,`);
				expect(decided).toContain(
					"\tselect<S extends string>(selector: S): Effectify.ResolvedList<ReadonlyArray<Upstream.Page>, Failure, Effectify.Borrowed<Handles>>; // explicit: Runtime.select",
				);
				// A list made of handles without a release has nothing to own: never borrowed.
				const unscoped =
					(yield* generate(listing, {
						...recipe,
						handles: { ...handles, Page: { events: [] } },
						derived: [],
					})).get("src/index.ts") ?? "";
				expect(unscoped).not.toContain("RuntimeBorrowed");
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("drafts a lookup's list as borrowed, and leaves a list an Effect makes to its caller", () =>
		Effect.gen(function* () {
			const listing = yield* Schema.decodeUnknownEffect(Surface)({
				...surface,
				handles: {
					...surface.handles,
					Runtime: {
						...surface.handles["Runtime"],
						methods: {
							...surface.handles["Runtime"]?.methods,
							open: [
								signature({ returns: "Promise<Page>", resolves: "Page", handle: "Page", traits: ["async"] }),
							],
							pages: [signature({ returns: "Promise<Page[]>", resolves: "Page[]", traits: ["async"] })],
							all: [signature({ returns: "Promise<Page[]>", resolves: "Page[]", traits: ["async"] })],
							// Synchronous: borrowed by the runtime whatever the recipe says, so never proposed.
							targets: [signature({ returns: "Page[]" })],
						},
					},
					Page: {
						name: "Page",
						typeRef: "Upstream.Page",
						methods: { close: [signature({ returns: "Promise<void>", resolves: "void", traits: ["async"] })] },
						properties: {},
						events: [],
						releases: ["close"],
					},
				},
			});
			const drafted = yield* draftRecipe(
				listing,
				{ files: 0, errorClasses: [], codes: [], events: [] },
				"",
				recipe,
				false,
			);
			expect(drafted.handles["Page"]?.release).toBe("close");
			expect(drafted.borrowed).toStrictEqual(["Runtime.pages"]);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("never wraps upstream's toJSON or toString: a facade serialises and prints as its handle's name", () =>
		Effect.gen(function* () {
			const serialising = yield* Schema.decodeUnknownEffect(Surface)({
				...surface,
				handles: {
					...surface.handles,
					Runtime: {
						...surface.handles["Runtime"],
						methods: {
							...surface.handles["Runtime"]?.methods,
							toJSON: [signature({ returns: "{ token: string }" })],
							toString: [signature({ returns: "string" })],
						},
						properties: { toJSON: { type: "unknown" }, label: { type: "string" } },
					},
				},
			});
			const source = (yield* generate(serialising, recipe)).get("src/index.ts") ?? "";
			expect(source).toContain(`type RuntimeMethods = "close" | "pick";`);
			expect(source).toContain(`type RuntimeProperties = "label";`);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect(
		"shows the secrets the recipe names inside arguments as Redacted in the properties handles read through",
		() =>
			Effect.gen(function* () {
				const kept = yield* Schema.decodeUnknownEffect(Surface)({
					...surface,
					handles: {
						...surface.handles,
						Runtime: { ...surface.handles["Runtime"], properties: { options: { type: "Options" } } },
					},
				});
				// A whole argument (`1`) names no path inside a property.
				const decided = { ...recipe, secrets: { "Runtime.create": ["0.auth.pass", "0.token", "1"] } };
				const source = (yield* generate(kept, decided)).get("src/index.ts") ?? "";
				expect(source).toContain(`type Concealed = readonly ["auth", "pass"] | readonly ["token"];`);
				expect(source).toContain(
					`const concealed: ReadonlyArray<Effectify.SecretPath> = [["auth", "pass"], ["token"]];`,
				);
				expect(source).toContain("\t\t\tconcealed,");
				expect(source).toContain(", RuntimeOptional, RuntimeFacades, {}, never, Concealed>");
			}).pipe(Effect.provide(NodeServices.layer)),
	);

	it.effect("conceals the secrets in what every method returns too, written-out signatures included", () =>
		Effect.gen(function* () {
			// No property: a method may still hand back what upstream kept of the call.
			const decided = { ...recipe, secrets: { "Runtime.create": ["0.auth.pass"] } };
			const lifted = (yield* generate(surface, decided)).get("src/index.ts") ?? "";
			expect(lifted).toContain(`type Concealed = readonly ["auth", "pass"];`);
			expect(lifted).toContain("\t\t\tconcealed,");
			expect(lifted).toContain(", RuntimeOptional, RuntimeFacades, {}, never, Concealed>");
			expect(lifted).toContain(
				"const liftedRuntime_pick = () => Effectify.lifted<Failure, Handles, false, Concealed, false>()(instanceOfRuntime.pick); // lifted: Runtime.pick",
			);
			const explicit = (yield* generate(surface, { ...decided, derived: [] })).get("src/index.ts") ?? "";
			expect(explicit).toContain(
				"\tpick<K extends Hidden>(key: K): Effectify.Resolved<K, Failure, never, Concealed>; // explicit: Runtime.pick",
			);
		}).pipe(Effect.provide(NodeServices.layer)),
	);

	it("finds a lifted method whose declaration cannot be emitted by its marked line", () => {
		const source = [
			"",
			"const liftedRuntime_pick = () => Effectify.lifted<Failure, Handles, false, never, false>()(instanceOfRuntime.pick); // lifted: Runtime.pick",
		].join("\n");
		const output = `src/index.ts(2,7): error TS2883: The inferred type of 'liftedRuntime_pick' cannot be named without a reference to 'Hidden' from '../node_modules/runtime-lib/dist/hidden.js'. This is likely not portable. A type annotation is necessary.`;
		expect(rejectedMarkers(output, () => source)).toStrictEqual([{ marker: "lifted", key: "Runtime.pick" }]);
	});
});

/**
 * Writes a generated facade's sources and tsconfigs to `project` beside a stand-in for upstream (`index.d.ts`,
 * `index.js`) and its `test/` files, then type checks it with the compiler its users build with and builds its
 * release: what each run printed, empty when it passed.
 */
function checkedFacade(
	project: string,
	files: ReadonlyMap<string, string>,
	upstream: { readonly name: string; readonly declarations: string; readonly module: string },
	tests: Readonly<Record<string, string>>,
): { readonly check: string; readonly build: string } {
	rmSync(project, { recursive: true, force: true });
	const put = (file: string, content: string) => {
		mkdirSync(dirname(join(project, file)), { recursive: true });
		writeFileSync(join(project, file), content);
	};
	for (const [file, content] of files) if (file.startsWith("src/") || file.startsWith("tsconfig")) put(file, content);
	for (const [file, content] of Object.entries(tests)) put(file, content);
	const lib = join("node_modules", upstream.name);
	put(
		join(lib, "package.json"),
		JSON.stringify({
			name: upstream.name,
			type: "module",
			exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
		}),
	);
	put(join(lib, "index.d.ts"), upstream.declarations);
	put(join(lib, "index.js"), upstream.module);
	const tsc = (config: string) => {
		const ran = spawnSync(
			process.execPath,
			[
				join(import.meta.dirname, "..", "node_modules", "typescript", "bin", "tsc"),
				"-p",
				join(project, config),
				"--pretty",
				"false",
			],
			{ encoding: "utf8" },
		);
		return `${ran.status === 0 ? "" : `exit ${ran.status}\n`}${ran.stdout}${ran.stderr}`;
	};
	return { check: tsc("tsconfig.json"), build: tsc("tsconfig.build.json") };
}

/** Runs `file` in Node, as a facade's user's process imports it: what it printed, and how it exited. */
function ranInNode(file: string): { readonly status: number | null; readonly output: string } {
	const ran = spawnSync(process.execPath, [file], { encoding: "utf8" });
	return { status: ran.status, output: ran.stdout + ran.stderr };
}

/**
 * The surface the analyzer reads from `declarations`, a package named `name` installed in a workspace under the
 * engine's `.cache/<directory>`, as `study` would have imported it.
 */
const analyzedLib = Effect.fn("analyzedLib")(function* (directory: string, name: string, declarations: string) {
	const workspace = join(import.meta.dirname, "..", ".cache", directory, "workspace");
	rmSync(workspace, { recursive: true, force: true });
	const put = (file: string, content: string) => {
		mkdirSync(dirname(join(workspace, file)), { recursive: true });
		writeFileSync(join(workspace, file), content);
	};
	put(`node_modules/${name}/package.json`, JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }));
	put(`node_modules/${name}/index.d.ts`, declarations);
	put(
		"tsconfig.json",
		JSON.stringify({
			compilerOptions: {
				strict: true,
				module: "nodenext",
				moduleResolution: "nodenext",
				target: "esnext",
				lib: ["esnext"],
				noEmit: true,
				skipLibCheck: true,
			},
			files: ["entry.ts"],
		}),
	);
	put("entry.ts", `export * as lib from ${JSON.stringify(name)};\n`);
	const types = { from: "bundled", package: name, version: "1.0.0" } as const;
	const analyzed = yield* analyze({
		target: { package: name, version: "1.0.0", repository: undefined, types },
		directory: workspace,
		tsconfig: join(workspace, "tsconfig.json"),
		entry: join(workspace, "entry.ts"),
		packageDirectory: join(workspace, "node_modules", name),
	});
	return { ...analyzed, runtime: "imported" as const };
});

/** The draft of `surface` without a scan, a README or an earlier recipe. */
const drafted = (surface: Surface) =>
	draftRecipe(surface, { files: 0, errorClasses: [], codes: [], events: [] }, "", undefined, false);

describe("draft: the releases it offers", () => {
	it.effect(
		"drafts no release of a node a property holds, nor a service of it: postcss's `remove` takes it out of its tree",
		() =>
			Effect.gen(function* () {
				// postcss's shape: `fromJSON` makes a node, and a warning holds the node it is about (`Warning.node`).
				const surface = yield* analyzedLib(
					"release-postcss",
					"css-lib",
					[
						"export declare class Node {",
						"\ttype: string;",
						"\tremove(): this;",
						"\tclone(): this;",
						"}",
						"export declare class Warning {",
						"\ttext: string;",
						"\tnode: Node;",
						"\tlocation(): string;",
						"}",
						"export declare function fromJSON(data: object): Node;",
						"export declare function lint(css: string): Warning;",
						"",
					].join("\n"),
				);
				expect(surface.handles["Warning"]?.properties["node"]?.handle).toBe("Node");
				expect(surface.handles["Node"]?.releases).toStrictEqual([]);
				const recipe = yield* drafted(surface);
				expect(recipe.handles["Node"]).toStrictEqual({ events: [] });
				expect(recipe.services).toStrictEqual([]);
				expect(recipe.decisions.find((decision) => decision.id === "handles.Node.release")?.answer).toBe("none");
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.effect(
		"offers only a release named so that takes no argument: protobuf.js's `remove(object)` and a `stop(chart)` are none",
		() =>
			Effect.gen(function* () {
				const surface = yield* analyzedLib(
					"release-protobuf",
					"proto-lib",
					[
						// protobuf.js's shape: a namespace's `remove` takes the child it removes, and a type holds its root.
						"export declare class Root {",
						"\tremove(object: Type): this;",
						"\tlookupType(path: string): Type;",
						"}",
						"export declare class Type {",
						"\tparent: Root;",
						"\tremove(object: Type): this;",
						"}",
						// Chart.js's shape: `stop(chart)` stops one chart's animations; nothing else releases it.
						"export declare class Animator {",
						"\tstop(chart: Root): void;",
						"}",
						// A release that reports through its callback, which the runtime gives it.
						"export declare class Server {",
						"\tclose(callback: (error?: Error) => void): void;",
						"}",
						"export declare function load(file: string): Promise<Root>;",
						"export declare function animator(): Animator;",
						"export declare function listen(): Server;",
						"",
					].join("\n"),
				);
				expect(surface.handles["Type"]?.properties["parent"]?.handle).toBe("Root");
				expect(
					Object.fromEntries(Object.entries(surface.handles).map(([name, handle]) => [name, handle.releases])),
				).toStrictEqual({ Animator: [], Root: [], Server: ["close"], Type: [] });
				const recipe = yield* drafted(surface);
				expect(recipe.handles["Root"]?.release).toBeUndefined();
				expect(recipe.handles["Type"]?.release).toBeUndefined();
				expect(recipe.handles["Animator"]?.release).toBeUndefined();
				expect(recipe.handles["Server"]?.release).toBe("close");
				expect(recipe.services.map((service) => service.handle)).toStrictEqual(["Server"]);
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	// cheerio's shape: `end()` takes no argument and gives the selection before the last traversal, another selection.
	const selections = {
		name: "select-lib",
		declarations: [
			"export declare class Selection<T> {",
			"\tfind(selector: string): Selection<T>;",
			"\tend(): Selection<unknown>;",
			"\tattr(name: string): string | undefined;",
			"}",
			"export interface Api {",
			"\troot(): Selection<string>;",
			"}",
			"export declare function load(html: string): Api;",
			"",
		].join("\n"),
		module: [
			"export class Selection {",
			"\tconstructor(nodes, previous) { this.nodes = nodes; this.previous = previous; }",
			"\tfind(selector) { return new Selection(this.nodes.flatMap((node) => node.children.filter((child) => child.tag === selector)), this); }",
			"\tend() { return this.previous ?? this; }",
			"\tattr(name) { return this.nodes[0]?.[name]; }",
			"}",
			'// `<main id="parent"><span id="child"></span></main>`, as a tree of nodes.',
			"export function load() {",
			'\tconst page = { tag: "root", children: [{ tag: "main", id: "parent", children: [{ tag: "span", id: "child", children: [] }] }] };',
			"\treturn { root: () => new Selection([page]) };",
			"}",
			"",
		].join("\n"),
	};

	it.effect(
		"offers a release that gives a handle by its class, as 0.3.0 did, and a borrowed selection keeps cheerio's `end()`",
		() =>
			Effect.gen(function* () {
				const surface = yield* analyzedLib("release-traversal", selections.name, selections.declarations);
				expect(surface.handles["Selection"]?.methods["end"]?.[0]?.handle).toBe("Selection");
				expect(surface.handles["Selection"]?.methods["end"]?.[0]?.receiver).toBeUndefined();
				// The types cannot tell cheerio's step back from zmq's `close(): Socket`: a release, as in 0.3.0.
				expect(surface.handles["Selection"]?.releases).toStrictEqual(["end"]);
				const recipe = yield* drafted(surface);
				expect(recipe.handles["Selection"]).toStrictEqual({ release: "end", events: [] });
				expect(recipe.decisions.find((decision) => decision.id === "handles.Selection.release")?.why).toBe(
					"its release methods are end; a borrowed Selection keeps end: each gives a handle named by its class, not `this`, which the types cannot tell from a step to another one",
				);
				const files = yield* generate(surface, recipe);
				const source = files.get("src/index.ts") ?? "";
				// A borrowed facade keeps it, in its type (the entry names no release to leave out) and at run time.
				expect(source).toContain("\t| readonly [Upstream.Selection<any>, Selection, true]\n");
				expect(source).toContain('\t\trelease: "end",\n\t\tkept: ["end"],');
				// Each step is borrowed (`find` returns its handle's type), and keeps `end`.
				const use = [
					'import { Effect } from "effect";',
					'import { load } from "../src/index.ts";',
					"const program = Effect.gen(function* () {",
					'\tconst $ = yield* load("<main id=\\"parent\\"><span id=\\"child\\"></span></main>");',
					'\tconsole.log(JSON.stringify($.root().find("main").find("span").end().attr("id")));',
					"});",
					"Effect.runPromise(program);",
					"",
				].join("\n");
				const project = join(import.meta.dirname, "..", ".cache", "release-traversal", "facade");
				expect(checkedFacade(project, files, selections, { "test/use.ts": use })).toStrictEqual({
					check: "",
					build: "",
				});
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({ status: 0, output: '"parent"\n' });
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.effect(
		"keeps a release that returns its receiver, though the checker prints `this` as the handle: Node's `Server.close(): this`",
		() =>
			Effect.gen(function* () {
				const surface = yield* analyzedLib(
					"release-receiver",
					"receiver-lib",
					[
						// Node's shape: an emitter's methods return `this`, and a server inherits them.
						"export declare class Emitter {",
						"\ton(event: string, listener: () => void): this;",
						"\tstop(): this;",
						"}",
						"export declare class Server extends Emitter {",
						"\tclose(): this;",
						"\tclient(): Promise<Server>;",
						"}",
						// chart.js's shape: a generic class, whose `this` the checker prints as `Chart<T>`.
						"export declare class Chart<T> {",
						"\tdata: T;",
						"\tstop(): this;",
						"\tdestroy(): void;",
						"}",
						"export declare function listen(): Server;",
						"export declare function chart(): Chart<string>;",
						"",
					].join("\n"),
				);
				const server = surface.handles["Server"];
				const generic = surface.handles["Chart"];
				expect([server?.methods["stop"]?.[0]?.returns, generic?.methods["stop"]?.[0]?.returns]).toStrictEqual([
					"Server",
					"Chart<T>",
				]);
				expect(
					[server?.methods["close"], server?.methods["stop"], server?.methods["on"], generic?.methods["stop"]].map(
						(signatures) => signatures?.[0]?.receiver,
					),
				).toStrictEqual([true, true, true, true]);
				// A promise of another server is no receiver.
				expect(server?.methods["client"]?.[0]?.receiver).toBeUndefined();
				expect([server?.releases, generic?.releases]).toStrictEqual([
					["close", "stop"],
					["stop", "destroy"],
				]);
				const recipe = yield* drafted(surface);
				expect([recipe.handles["Server"]?.release, recipe.handles["Chart"]?.release]).toStrictEqual([
					"close",
					"destroy",
				]);
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	// zmq@2.15.3's shape, as @types/zmq@0.0.25 declares it: a hand-written `.d.ts` names the class, not `this`, so
	// `close()`, which closes the socket and returns it, gives a `Socket` as cheerio's `end()` gives a selection.
	const sockets = {
		name: "socket-lib",
		declarations: [
			"export interface Socket {",
			"\tbindSync(address: string): Socket;",
			"\tclose(): Socket;",
			"}",
			"export declare function socket(type: string): Socket;",
			"export declare const closed: ReadonlyArray<string>;",
			"",
		].join("\n"),
		module: [
			"export const closed = [];",
			"export class Socket {",
			"\tconstructor(type) { this.type = type; }",
			"\tbindSync(address) { this.address = address; return this; }",
			"\tclose() { closed.push(this.type); return this; }",
			"}",
			"export function socket(type) { return new Socket(type); }",
			"",
		].join("\n"),
	};

	it.effect(
		"keeps a release that gives a handle by its class, which the types cannot tell from a step: zmq's `Socket.close(): Socket`",
		() =>
			Effect.gen(function* () {
				const surface = yield* analyzedLib("release-class", sockets.name, sockets.declarations);
				expect(surface.handles["Socket"]?.methods["close"]?.[0]?.handle).toBe("Socket");
				expect(surface.handles["Socket"]?.releases).toStrictEqual(["close"]);
				const recipe = yield* drafted(surface);
				expect(recipe.handles["Socket"]).toStrictEqual({ release: "close", events: [] });
				expect(recipe.services).toStrictEqual([{ name: "SocketLibSocket", handle: "Socket", acquire: "socket" }]);
				const files = yield* generate(surface, recipe);
				const source = files.get("src/index.ts") ?? "";
				expect(source).toContain("export class SocketLibSocket extends Context.Service<SocketLibSocket, Socket>()");
				expect(source).toContain("\t| readonly [Upstream.Socket, Socket, true];");
				expect(source).toContain('\t\trelease: "close",\n\t\tkept: ["close"],');
				// `socket()` acquires the socket in the caller's scope, whose closing closes it; the receiver `bindSync` gives
				// back is borrowed, and keeps `close`, as 0.3.0's facade had it.
				const use = [
					'import { Effect } from "effect";',
					'import { closed } from "socket-lib";',
					'import { socket } from "../src/index.ts";',
					"// @ts-expect-error acquiring a socket needs a Scope",
					'export const unscoped: Effect.Effect<unknown, unknown, never> = socket("sub");',
					"const program = Effect.gen(function* () {",
					"\tyield* Effect.scoped(",
					"\t\tEffect.gen(function* () {",
					'\t\t\tconst bound = (yield* socket("pub")).bindSync("tcp://127.0.0.1:5555");',
					"\t\t\tconst close: () => unknown = bound.close;",
					"\t\t\tconsole.log(JSON.stringify([typeof close, [...closed]]));",
					"\t\t}),",
					"\t);",
					"\tconsole.log(JSON.stringify(closed));",
					"});",
					"Effect.runPromise(program);",
					"",
				].join("\n");
				const project = join(import.meta.dirname, "..", ".cache", "release-class", "facade");
				expect(checkedFacade(project, files, sockets, { "test/use.ts": use })).toStrictEqual({
					check: "",
					build: "",
				});
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({
					status: 0,
					output: '["function",[]]\n["pub"]\n',
				});
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.effect(
		"hides from a borrowed facade a release that gives nothing back or its receiver: `close(): this`, `close(): void`",
		() =>
			Effect.gen(function* () {
				const servers = {
					name: "server-lib",
					declarations: [
						"export declare class Server {",
						"\tlisten(port: number): this;",
						"\tclose(): this;",
						"}",
						"export declare class Client {",
						"\tretry(): Client;",
						"\tclose(): void;",
						"}",
						"export declare function serve(): Server;",
						"export declare function connect(): Client;",
						"",
					].join("\n"),
					module: [
						"export class Server { listen() { return this; } close() { return this; } }",
						"export class Client { retry() { return this; } close() {} }",
						"export function serve() { return new Server(); }",
						"export function connect() { return new Client(); }",
						"",
					].join("\n"),
				};
				const surface = yield* analyzedLib("release-hidden", servers.name, servers.declarations);
				expect([surface.handles["Server"]?.releases, surface.handles["Client"]?.releases]).toStrictEqual([
					["close"],
					["close"],
				]);
				const recipe = yield* drafted(surface);
				expect([recipe.handles["Server"]?.release, recipe.handles["Client"]?.release]).toStrictEqual([
					"close",
					"close",
				]);
				const files = yield* generate(surface, recipe);
				const source = files.get("src/index.ts") ?? "";
				expect(source).toContain('\t| readonly [Upstream.Server, Server, true, "close"]');
				expect(source).toContain('\t| readonly [Upstream.Client, Client, true, "close"]');
				expect(source).not.toContain("kept:");
				const use = [
					'import { Effect } from "effect";',
					'import { connect, serve } from "../src/index.ts";',
					"const program = Effect.scoped(",
					"\tEffect.gen(function* () {",
					"\t\tconst server = (yield* serve()).listen(80);",
					"\t\tconst client = (yield* connect()).retry();",
					'\t\tconsole.log(JSON.stringify(["close" in server, "close" in client]));',
					"\t\t// @ts-expect-error a borrowed server has no release",
					"\t\treturn [server.close, client.close];",
					"\t}),",
					");",
					"Effect.runPromise(program);",
					"",
				].join("\n");
				const project = join(import.meta.dirname, "..", ".cache", "release-hidden", "facade");
				expect(checkedFacade(project, files, servers, { "test/use.ts": use })).toStrictEqual({
					check: "",
					build: "",
				});
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({ status: 0, output: "[false,false]\n" });
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);
});

describe("generate: a release method's calls that are no release", () => {
	it.effect(
		"runs `close(mode)`, an overload that steps to another handle, at every call, and the scope still closes the receiver",
		() =>
			Effect.gen(function* () {
				// `close()` releases the parent and returns it; its overload `close(mode)` makes a child from it instead.
				const parents = {
					name: "parent-lib",
					declarations: [
						"export declare class Child {",
						"\treadonly label: string;",
						"\ttouch(): string;",
						"}",
						"export declare class Parent {",
						"\tclose(): this;",
						"\tclose(mode: string): Child;",
						"}",
						"export declare function open(): Parent;",
						"export declare const closed: ReadonlyArray<string>;",
						"",
					].join("\n"),
					module: [
						"export const closed = [];",
						"let made = 0;",
						"export class Child { constructor(label) { this.label = label; } touch() { return this.label; } }",
						"export class Parent {",
						"\tclose(mode) {",
						'\t\tif (mode === undefined) { closed.push("parent"); return this; }',
						"\t\tmade++;",
						"\t\treturn new Child(`${mode} ${made}`);",
						"\t}",
						"}",
						"export function open() { return new Parent(); }",
						"",
					].join("\n"),
				};
				const surface = yield* analyzedLib("release-overload", parents.name, parents.declarations);
				expect(surface.handles["Parent"]?.releases).toStrictEqual(["close"]);
				const recipe = yield* drafted(surface);
				expect(recipe.handles["Parent"]?.release).toBe("close");
				const files = yield* generate(surface, recipe);
				const use = [
					'import { Effect } from "effect";',
					'import { closed } from "parent-lib";',
					'import { open } from "../src/index.ts";',
					"// The spec reads `close`'s first overload, `this`, so the facade wraps a child as a borrowed parent's facade.",
					"const label = (child: unknown) => (child as { readonly upstream: { readonly label: string } }).upstream.label;",
					"const program = Effect.gen(function* () {",
					"\tyield* Effect.scoped(",
					"\t\tEffect.gen(function* () {",
					"\t\t\tconst parent = yield* open();",
					'\t\t\tconst first: unknown = parent.close("traverse");',
					'\t\t\tconst second: unknown = parent.close("traverse");',
					"\t\t\tconsole.log(JSON.stringify([label(first), label(second), [...closed]]));",
					"\t\t}),",
					"\t);",
					"\tconsole.log(JSON.stringify(closed));",
					"});",
					"Effect.runPromise(program);",
					"",
				].join("\n");
				const project = join(import.meta.dirname, "..", ".cache", "release-overload", "facade");
				expect(checkedFacade(project, files, parents, { "test/use.ts": use })).toStrictEqual({
					check: "",
					build: "",
				});
				// Two children, one per call; the scope's finalizer called `close()` once.
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({
					status: 0,
					output: '["traverse 1","traverse 2",[]]\n["parent"]\n',
				});
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.effect(
		"runs cheerio's `end()` on a selection the caller owns at every call, each giving the selection before, and the scope still ends it",
		() =>
			Effect.gen(function* () {
				// cheerio's shape, with a selection the caller owns: `select` gives one made by two `find`s, acquired in the
				// caller's scope, whose release is `end()`.
				const selections = {
					name: "owned-select-lib",
					declarations: [
						"export declare class Selection<T> {",
						"\tfind(selector: string): Selection<T>;",
						"\tend(): Selection<unknown>;",
						"\tattr(name: string): string | undefined;",
						"}",
						"export declare function select(html: string, selector: string): Selection<string>;",
						"export declare const ended: ReadonlyArray<string | undefined>;",
						"",
					].join("\n"),
					module: [
						"export const ended = [];",
						"export class Selection {",
						"\tconstructor(nodes, previous) { this.nodes = nodes; this.previous = previous; }",
						"\tfind(selector) { return new Selection(this.nodes.flatMap((node) => node.children.filter((child) => child.tag === selector)), this); }",
						"\tend() { ended.push(this.nodes[0]?.id); return this.previous ?? new Selection([]); }",
						"\tattr(name) { return this.nodes[0]?.[name]; }",
						"}",
						'// `<main id="parent"><span id="child"></span></main>`, as a tree of nodes.',
						"export function select(html, selector) {",
						'\tconst page = { tag: "root", children: [{ tag: "main", id: "parent", children: [{ tag: "span", id: "child", children: [] }] }] };',
						'\treturn new Selection([page]).find("main").find(selector);',
						"}",
						"",
					].join("\n"),
				};
				const surface = yield* analyzedLib("release-owned-step", selections.name, selections.declarations);
				const recipe = yield* drafted(surface);
				expect(recipe.handles["Selection"]?.release).toBe("end");
				const files = yield* generate(surface, recipe);
				const use = [
					'import { Effect } from "effect";',
					'import { ended } from "owned-select-lib";',
					'import { select } from "../src/index.ts";',
					"const program = Effect.gen(function* () {",
					"\tyield* Effect.scoped(",
					"\t\tEffect.gen(function* () {",
					'\t\t\tconst span = yield* select("<main id=\\"parent\\"><span id=\\"child\\"></span></main>", "span");',
					'\t\t\tconst first: unknown = span.end().attr("id");',
					'\t\t\tconst second: unknown = span.end().attr("id");',
					"\t\t\tconsole.log(JSON.stringify([first, second, [...ended]]));",
					"\t\t}),",
					"\t);",
					"\tconsole.log(JSON.stringify(ended));",
					"});",
					"Effect.runPromise(program);",
					"",
				].join("\n");
				const project = join(import.meta.dirname, "..", ".cache", "release-owned-step", "facade");
				expect(checkedFacade(project, files, selections, { "test/use.ts": use })).toStrictEqual({
					check: "",
					build: "",
				});
				// Each `end()` stepped back to the `main` selection; the scope's finalizer then called `end()` once more.
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({
					status: 0,
					output: '["parent","parent",["child","child"]]\n["child","child","child"]\n',
				});
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);
});

describe("generate: a user's call of a release", () => {
	it.effect(
		"runs every `close(callback)` of a server subclassing Node's `net.Server`: each callback runs, the second with upstream's own error, and the scope closes it once more",
		() =>
			Effect.gen(function* () {
				// Node's `Server.close(callback?): this`, on a subclass of the real `net.Server` that counts its calls.
				const servers = {
					name: "net-server-lib",
					declarations: [
						"export declare class Server {",
						"\tlisten(port?: number, host?: string, callback?: () => void): this;",
						"\tclose(callback?: (error?: Error) => void): this;",
						"}",
						"export declare function serve(): Server;",
						"export declare const closes: ReadonlyArray<string>;",
						"",
					].join("\n"),
					module: [
						'import { Server as NetServer } from "node:net";',
						"export const closes = [];",
						"export class Server extends NetServer {",
						"\tclose(callback) {",
						'\t\tcloses.push(typeof callback === "function" ? "callback" : "none");',
						"\t\treturn super.close(callback);",
						"\t}",
						"}",
						"export function serve() { return new Server(); }",
						"",
					].join("\n"),
				};
				const surface = yield* analyzedLib("release-net-server", servers.name, servers.declarations);
				const recipe = yield* drafted(surface);
				expect(recipe.handles["Server"]?.release).toBe("close");
				const files = yield* generate(surface, recipe);
				const use = [
					'import { Effect } from "effect";',
					'import { closes } from "net-server-lib";',
					'import { serve } from "../src/index.ts";',
					"// What `close`'s callback got: no error, or upstream's own error code; `waited` when it never ran.",
					"const closing = (server: { close(callback?: (error?: Error) => void): unknown }) =>",
					"\tEffect.callback<string>((resume) => {",
					'\t\tserver.close((error) => resume(Effect.succeed((error as { code?: string } | undefined)?.code ?? "none")));',
					'\t}).pipe(Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed("waited") }));',
					"const program = Effect.gen(function* () {",
					"\tyield* Effect.scoped(",
					"\t\tEffect.gen(function* () {",
					"\t\t\tconst server = yield* serve();",
					'\t\t\tyield* Effect.callback<void>((resume) => void server.listen(0, "127.0.0.1", () => resume(Effect.void)));',
					"\t\t\tconst first = yield* closing(server);",
					"\t\t\tconst second = yield* closing(server);",
					"\t\t\tconsole.log(JSON.stringify([first, second]));",
					"\t\t}),",
					"\t);",
					"\t// Both calls reached upstream, and so did the scope's release as it closed, as Effect's `acquireRelease` does.",
					"\tconsole.log(JSON.stringify(closes));",
					"});",
					"Effect.runPromise(program);",
					"",
				].join("\n");
				const project = join(import.meta.dirname, "..", ".cache", "release-net-server", "facade");
				expect(checkedFacade(project, files, servers, { "test/use.ts": use })).toStrictEqual({
					check: "",
					build: "",
				});
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({
					status: 0,
					output: '["none","ERR_SERVER_NOT_RUNNING"]\n["callback","callback","none"]\n',
				});
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);
});

describe("generate: a union of handles", () => {
	// postcss's shape: sibling handle classes sharing a base handle, and a union alias of the siblings (`ChildNode`),
	// given alone, optional and as an array, by methods and a property.
	const lib = {
		name: "tree-lib",
		declarations: [
			"export declare class Node {",
			"\tname(): string;",
			"\tnext(): ChildNode | undefined;",
			"}",
			"export declare class Leaf extends Node {",
			"\ttext(): string;",
			"}",
			"export declare class Branch extends Node {",
			"\tnodes: ChildNode[];",
			"\tfirst(): ChildNode;",
			"\tchildren(): ChildNode[];",
			"\tappend(child: ChildNode): this;",
			"}",
			"export type ChildNode = Leaf | Branch;",
			"export declare function tree(): Branch;",
			"",
		].join("\n"),
		module: [
			"export class Node {",
			"\tname() { return this.constructor.name; }",
			"\tnext() { const siblings = this.parent?.nodes ?? []; return siblings[siblings.indexOf(this) + 1]; }",
			"}",
			'export class Leaf extends Node { text() { return "leaf"; } }',
			"export class Branch extends Node {",
			"\tnodes = [];",
			"\tfirst() { return this.nodes[0]; }",
			"\tchildren() { return [...this.nodes]; }",
			"\tappend(child) { child.parent = this; this.nodes.push(child); return this; }",
			"}",
			"// A branch with a leaf, followed by a leaf: its `next()` is that leaf.",
			"export function tree() { const inner = new Branch().append(new Leaf()); new Branch().append(inner).append(new Leaf()); return inner; }",
			"",
		].join("\n"),
	};
	// A user of the facade: each member typed as upstream's union (a facade would not compile here), and upstream's own
	// object at run time.
	const use = [
		'import { Effect } from "effect";',
		'import { Branch, Leaf, type ChildNode } from "tree-lib";',
		'import { tree } from "../src/index.ts";',
		"const program = Effect.gen(function* () {",
		"\tconst made = yield* tree();",
		"\t// A handle's facade is typed with its base handle's beside it, as a subtype's value is that handle's too.",
		'\tif (!("first" in made)) throw new Error("no branch");',
		"\tconst branch = made;",
		"\tconst first: ChildNode = branch.first();",
		"\tconst next: ChildNode | undefined = branch.next();",
		"\tconst children: ChildNode[] = branch.children();",
		"\tconst nodes: ChildNode[] = branch.nodes;",
		"\tconst raw = (node: ChildNode | undefined) => node instanceof Leaf || node instanceof Branch;",
		"\tconsole.log(JSON.stringify([raw(first), raw(next), children.every(raw), nodes === branch.upstream.nodes]));",
		"});",
		"Effect.runPromise(program);",
		"",
	].join("\n");

	it.effect(
		"gives a union of sibling handles raw, alone, optional and as an array, in its type and its spec, and the facade type checks",
		() =>
			Effect.gen(function* () {
				const root = join(import.meta.dirname, "..", ".cache", "handle-union");
				rmSync(root, { recursive: true, force: true });
				const workspace = join(root, "workspace");
				const put = (file: string, content: string) => {
					mkdirSync(dirname(join(workspace, file)), { recursive: true });
					writeFileSync(join(workspace, file), content);
				};
				put(
					"node_modules/tree-lib/package.json",
					JSON.stringify({ name: "tree-lib", version: "1.0.0", types: "index.d.ts" }),
				);
				put("node_modules/tree-lib/index.d.ts", lib.declarations);
				put(
					"tsconfig.json",
					JSON.stringify({
						compilerOptions: {
							strict: true,
							module: "nodenext",
							moduleResolution: "nodenext",
							target: "esnext",
							lib: ["esnext"],
							noEmit: true,
							skipLibCheck: true,
						},
						files: ["entry.ts"],
					}),
				);
				put("entry.ts", 'export * as lib from "tree-lib";\n');
				const types = { from: "bundled", package: "tree-lib", version: "1.0.0" } as const;
				const analyzed = yield* analyze({
					target: { package: "tree-lib", version: "1.0.0", repository: undefined, types },
					directory: workspace,
					tsconfig: join(workspace, "tsconfig.json"),
					entry: join(workspace, "entry.ts"),
					packageDirectory: join(workspace, "node_modules", "tree-lib"),
				});
				expect(Object.keys(analyzed.handles).sort()).toStrictEqual(["Branch", "Leaf", "Node"]);
				const surface = { ...analyzed, runtime: "imported" as const };
				const recipe = yield* draftRecipe(
					surface,
					{ files: 0, errorClasses: [], codes: [], events: [] },
					"",
					undefined,
					false,
				);
				const files = yield* generate(surface, recipe);
				const source = files.get("src/index.ts") ?? "";
				// The runtime spec names no handle for them: no `returns`, no `lists`.
				const branchSpec = /name: "Branch",\n\t\tspec: \{\n([^]*?)\n\t\t\}/.exec(source)?.[1] ?? "";
				expect(branchSpec).toContain('methods: ["append", "children", "first", "name", "next"]');
				expect(branchSpec).toContain('returns: { "append": "Branch" }');
				expect(branchSpec).not.toContain("lists:");
				expect(source).toContain("type CheckedGives = [");
				const project = join(root, "facade");
				expect(checkedFacade(project, files, lib, { "test/use.ts": use })).toStrictEqual({ check: "", build: "" });
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({
					status: 0,
					output: "[true,true,true,true]\n",
				});
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it("reads no handle in a union written out, generic arguments and all, as the types read none", () => {
		const handles = { Leaf: {}, Branch: {} };
		expect(presentHandle("Leaf<string> | Branch<number> | undefined", handles)).toBeUndefined();
		expect(presentHandle("Leaf<string> | null", handles)).toBe("Leaf");
		expect(listedHandle("Array<Leaf<string> | Branch<number>>", handles)).toBeUndefined();
		expect(listedHandle("Leaf<string> | Branch<number>[]", handles)).toBeUndefined();
		expect(listedHandle("readonly Leaf<string>[]", handles)).toBe("Leaf");
		expect(listedHandle("ReadonlyArray<Upstream.Branch<number>>", handles)).toBe("Branch");
	});
});

describe("generate: a member's value in its type as its spec gives it", () => {
	// Shapes of libraries 0.3.0 made that the gives check found: an inline union of a handle and its subclass, alone and
	// in a promise, in which the generator reads no handle; overloads that read a value and set it, the setter returning
	// the receiver (cheerio's `html`, `attr`); a result indexed by its type argument (ts-morph's `asKind`) and one a
	// conditional chooses.
	const lib = {
		name: "shape-lib",
		declarations: [
			"export interface KindMap {",
			"\tbase: Base;",
			"\tderived: Derived;",
			"}",
			"export declare class Base {",
			"\tname(): string;",
			"\tparent(): Base | Derived;",
			"\tload(): Promise<Base | Derived>;",
			"\thtml(): string | null;",
			"\thtml(value: string): this;",
			"\tattr(): Record<string, string>;",
			"\tattr(name: string, value: string): this;",
			"\tasKind<K extends keyof KindMap>(kind: K): KindMap[K] | undefined;",
			'\tnarrow<T extends "base" | "derived">(kind: T): T extends "base" ? Base : Base | Derived;',
			"}",
			"export declare class Derived extends Base {",
			"\textra(): number;",
			"}",
			"export declare function root(): Base;",
			"",
		].join("\n"),
		module: [
			"export class Base {",
			"\tattrs = {};",
			"\tmarkup = null;",
			"\tname() { return this.constructor.name; }",
			"\tparent() { return new Derived(); }",
			"\tasync load() { return new Derived(); }",
			"\thtml(value) { if (value === undefined) return this.markup; this.markup = value; return this; }",
			"\tattr(name, value) { if (name === undefined) return { ...this.attrs }; this.attrs[name] = value; return this; }",
			'\tasKind(kind) { return kind === "derived" ? new Derived() : undefined; }',
			'\tnarrow(kind) { return kind === "base" ? new Base() : new Derived(); }',
			"}",
			"export class Derived extends Base { extra() { return 1; } }",
			"export function root() { return new Base(); }",
			"",
		].join("\n"),
	};
	// A user of the facade: each value the spec gives as it is typed as upstream's (a facade would not compile in these
	// annotations) and upstream's own object at run time; a getter's value as it is, a setter's the receiver's facade.
	const use = [
		'import { Effect } from "effect";',
		'import { Base as UpstreamBase, Derived as UpstreamDerived } from "shape-lib";',
		'import { root } from "../src/index.ts";',
		"const program = Effect.gen(function* () {",
		"\tconst made = yield* root();",
		"\tconst parent: UpstreamBase | UpstreamDerived = made.parent();",
		"\tconst loaded: UpstreamBase | UpstreamDerived = yield* made.load();",
		'\tconst kind: UpstreamBase | UpstreamDerived | undefined = made.asKind("derived");',
		'\tconst narrowed: UpstreamBase | UpstreamDerived = made.narrow("derived");',
		"\tconst markup: string | null = made.html();",
		'\tconst set = made.html("<b>x</b>");',
		"\tconst attrs: Record<string, string> = made.attr();",
		'\tconst chained = made.attr("id", "x");',
		'\tconst raw = (value: object | undefined) => value instanceof UpstreamDerived && !("upstream" in value);',
		'\tconsole.log(JSON.stringify([[parent, loaded, kind, narrowed].map(raw), markup, set.upstream === made.upstream, set.html(), attrs, "upstream" in attrs, chained.attr(), chained.upstream === made.upstream]));',
		"});",
		"Effect.runPromise(program);",
		"",
	].join("\n");

	for (const [form, derived] of [
		["written out", []],
		["lifted", ["Base.asKind", "Base.narrow"]],
	] as const) {
		it.effect(
			`types each member as the runtime gives it, ${form}: a union or a generic result raw, a setter's receiver its facade`,
			() =>
				Effect.gen(function* () {
					const surface = yield* analyzedLib(`member-gives-${derived.length}`, lib.name, lib.declarations);
					const recipe = { ...(yield* drafted(surface)), derived: [...derived] };
					const files = yield* generate(surface, recipe);
					const source = files.get("src/index.ts") ?? "";
					const baseSpec = /name: "Base",\n\t\tspec: \{\n([^]*?)\n\t\t\}/.exec(source)?.[1] ?? "";
					expect(baseSpec).toContain('returns: { "attr": "Base", "html": "Base" }');
					expect(baseSpec).toContain('mixed: { "attr": true, "html": true }');
					expect(source).toContain('type BaseFacades = "attr" | "html";');
					const project = join(import.meta.dirname, "..", ".cache", `member-gives-${derived.length}`, "facade");
					expect(checkedFacade(project, files, lib, { "test/use.ts": use })).toStrictEqual({
						check: "",
						build: "",
					});
					expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({
						status: 0,
						output: '[[true,true,true,true],null,true,"<b>x</b>",{},false,{"id":"x"},true]\n',
					});
				}).pipe(Effect.provide(NodeServices.layer)),
			60_000,
		);
	}

	it.effect(
		"wraps a mixed result that has every required method of its handle, an optional one missing: a record or a string stays raw",
		() =>
			Effect.gen(function* () {
				// A handle with an optional method, which a widget upstream gives may lack, and overloads that give it or a
				// value that is none: a boolean, a record, a string.
				const widgets = {
					name: "widget-lib",
					declarations: [
						"export interface Widget {",
						"\tget(): string;",
						"\trefresh?(): Promise<void>;",
						"}",
						"export declare class Registry {",
						"\tfind(): boolean;",
						"\tfind(name: string): Widget;",
						"\tentries(): Record<string, string>;",
						"\tentries(name: string): Widget;",
						"\ttitle(): string;",
						"\ttitle(name: string): Widget;",
						"}",
						"export declare function open(): Registry;",
						"",
					].join("\n"),
					module: [
						"// Each widget has only `get()`: upstream leaves out the optional `refresh()`.",
						"const widget = (name) => ({ get: () => name });",
						"export class Registry {",
						"\tfind(name) { return name === undefined ? true : widget(name); }",
						'\tentries(name) { return name === undefined ? { a: "1" } : widget(name); }',
						'\ttitle(name) { return name === undefined ? "Registry" : widget(name); }',
						"}",
						"export function open() { return new Registry(); }",
						"",
					].join("\n"),
				};
				const surface = yield* analyzedLib("mixed-optional", widgets.name, widgets.declarations);
				expect(surface.handles["Widget"]?.optional).toStrictEqual(["refresh"]);
				const files = yield* generate(surface, yield* drafted(surface));
				const source = files.get("src/index.ts") ?? "";
				const registrySpec = /name: "Registry",\n\t\tspec: \{\n([^]*?)\n\t\t\}/.exec(source)?.[1] ?? "";
				expect(registrySpec).toContain('mixed: { "entries": true, "find": true, "title": true }');
				const widgetSpec = /name: "Widget",\n\t\tspec: \{\n([^]*?)\n\t\t\}/.exec(source)?.[1] ?? "";
				expect(widgetSpec).toContain(
					'required: ["get"] satisfies ReadonlyArray<Effectify.RequiredMethods<Pick<Upstream.Widget, WidgetMethods>>>,',
				);
				const use = [
					'import { Effect } from "effect";',
					'import { open } from "../src/index.ts";',
					"const program = Effect.gen(function* () {",
					"\tconst registry = yield* open();",
					'\tconst given = [registry.find("a"), registry.entries("b"), registry.title("c")];',
					"\tconst found: boolean = registry.find();",
					"\tconst entries: Record<string, string> = registry.entries();",
					"\tconst title: string = registry.title();",
					'\tconsole.log(JSON.stringify([given.map((widget) => [widget.get(), typeof widget.upstream]), found, entries, "upstream" in entries, title]));',
					"});",
					"Effect.runPromise(program);",
					"",
				].join("\n");
				const project = join(import.meta.dirname, "..", ".cache", "mixed-optional", "facade");
				expect(checkedFacade(project, files, widgets, { "test/use.ts": use })).toStrictEqual({
					check: "",
					build: "",
				});
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({
					status: 0,
					output: '[[["a","object"],["b","object"],["c","object"]],true,{"a":"1"},false,"Registry"]\n',
				});
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);
});

describe("generate: ts-morph's shapes, whose values no one wrapping fits", () => {
	// ts-morph's shapes: a property holding a compiler node whose type has the name of one of its own handles
	// (`compilerNode: ts.ClassDeclaration` on a `ClassDeclaration`), a method that gives one handle or a list of them
	// (`addExtends(text)`, `addExtends(texts)`), and one that gives a list of a handle or of a union with it
	// (`EnumDeclaration.addMembers`), an overloaded method that takes its own handle (`Directory.getRelativePathTo`,
	// whose facade type TypeScript once found circular); and commander's, a method that only throws (`Command.error()`).
	const lib = {
		name: "morph-lib",
		declarations: [
			"export declare namespace ts {",
			"\tinterface ClassDeclaration {",
			"\t\tkind: number;",
			"\t\tgetText(): string;",
			"\t}",
			"}",
			"export declare class Expression {",
			"\tgetText(): string;",
			"\trelativeTo(other: Expression): string;",
			"\trelativeTo(other: ClassDeclaration): string;",
			"}",
			"export declare class Comment {",
			"\tgetText(): string;",
			"}",
			"export declare class ClassDeclaration {",
			"\tcompilerNode: ts.ClassDeclaration;",
			"\tgetName(): string;",
			"\taddExtends(text: string): Expression;",
			"\taddExtends(texts: ReadonlyArray<string>): Expression[];",
			"\taddMembers(texts: ReadonlyArray<string>): Expression[];",
			"\taddMembers(texts: ReadonlyArray<string>, comments: boolean): (Comment | Expression)[];",
			"\tfail(message: string): never;",
			"\trelativeTo(text: string): string;",
			"\trelativeTo(other: Expression): string;",
			"\trelativeTo(other: ClassDeclaration): string;",
			"}",
			"export declare function parse(): ClassDeclaration;",
			"",
		].join("\n"),
		module: [
			"export class Expression { constructor(text) { this.text = text; } getText() { return this.text; } relativeTo() { return this.text; } }",
			"export class Comment { getText() { return '//'; } }",
			"export class ClassDeclaration {",
			"\tcompilerNode = { kind: 263, getText: () => 'class A {}' };",
			"\tgetName() { return 'A'; }",
			"\taddExtends(text) { return Array.isArray(text) ? text.map((one) => new Expression(one)) : new Expression(text); }",
			"\taddMembers(texts, comments) { return [...(comments ? [new Comment()] : []), ...texts.map((one) => new Expression(one))]; }",
			"\tfail(message) { throw new Error(message); }",
			"\trelativeTo(other) { return typeof other === 'string' ? other : other instanceof Expression ? other.getText() : other.getName(); }",
			"}",
			"export function parse() { return new ClassDeclaration(); }",
			"",
		].join("\n"),
	};
	// Each value typed as upstream's, upstream's own object at run time.
	const use = [
		'import { Effect } from "effect";',
		'import { Expression as UpstreamExpression, type ts } from "morph-lib";',
		'import { parse } from "../src/index.ts";',
		"const program = Effect.gen(function* () {",
		"\tconst declaration = yield* parse();",
		"\tconst node: ts.ClassDeclaration = declaration.compilerNode;",
		'\tconst one: UpstreamExpression = declaration.addExtends("B");',
		'\tconst many: Array<UpstreamExpression> = declaration.addExtends(["C", "D"]);',
		'\tconst members: Array<UpstreamExpression> = declaration.addMembers(["e"]);',
		'\tconst all = declaration.addMembers(["f"], true);',
		'\tconst relative: string = declaration.relativeTo(declaration) + declaration.relativeTo("/b");',
		'\tconst raw = (value: object) => !("upstream" in value);',
		"\tconsole.log(JSON.stringify([node.kind, raw(node), one instanceof UpstreamExpression, many.every((item) => item instanceof UpstreamExpression), members.every(raw), all.map((item) => item.getText()), relative]));",
		"});",
		"Effect.runPromise(program);",
		"",
	].join("\n");

	it.effect(
		"reads no handle in a type named as another, and gives a value raw where one wrapping fits no overload",
		() =>
			Effect.gen(function* () {
				const surface = yield* analyzedLib("morph-shapes", lib.name, lib.declarations);
				expect(surface.handles["ClassDeclaration"]?.properties["compilerNode"]).toStrictEqual({
					type: "ClassDeclaration",
				});
				const files = yield* generate(surface, yield* drafted(surface));
				const source = files.get("src/index.ts") ?? "";
				const spec = /name: "ClassDeclaration",\n\t\tspec: \{\n([^]*?)\n\t\t\}/.exec(source)?.[1] ?? "";
				expect(spec).toContain("returns: {},");
				expect(spec).not.toContain("lists:");
				expect(spec).toContain('properties: { "compilerNode": true }');
				const project = join(import.meta.dirname, "..", ".cache", "morph-shapes", "facade");
				expect(checkedFacade(project, files, lib, { "test/use.ts": use })).toStrictEqual({ check: "", build: "" });
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({
					status: 0,
					output: '[263,true,true,true,true,["//","f"],"A/b"]\n',
				});
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);
});

describe("generate: upstream exports named by strings", () => {
	// An ES2022 export named by a string (`export { x as "review-sentinel" }`): a value the facade re-exports, a type it
	// re-exports with all of upstream's, and a function the recipe offers, which no wrapper can be declared under.
	const types = { from: "bundled", package: "string-lib", version: "1.0.0" } as const;
	const upstream = {
		name: "string-lib",
		declarations: [
			"declare const sentinel: number;",
			"declare function fetchIt(): Promise<number>;",
			"interface Shape { readonly size: number }",
			'export { sentinel as "review-sentinel", fetchIt as "fetch-it" };',
			'export type { Shape as "review-shape" };',
			"export declare const plain: number;",
			"",
		].join("\n"),
		module:
			'const sentinel = 1;\nasync function fetchIt() { return 2; }\nexport { sentinel as "review-sentinel", fetchIt as "fetch-it" };\nexport const plain = 3;\n',
	};
	// A user of the facade: the string-named value and type, imported by their names.
	const use = [
		'import { "review-sentinel" as sentinel, plain } from "../src/index.ts";',
		'import type { "review-shape" as Shape } from "../src/index.ts";',
		"const shape: Shape = { size: sentinel + plain };",
		"console.log(JSON.stringify(shape));",
		"",
	].join("\n");

	it.effect(
		"re-exports a value named by a string by its string, leaves out an offered one, and the facade builds and imports",
		() =>
			Effect.gen(function* () {
				const surface = yield* Schema.decodeEffect(Surface)({
					package: "string-lib",
					version: "1.0.0",
					types,
					entry: "named",
					exports: [
						{ kind: "value", name: "review-sentinel", type: "number" },
						{ kind: "value", name: "plain", type: "number" },
						{
							kind: "function",
							name: "fetch-it",
							signatures: [{ ...signature("Promise<number>"), resolves: "number", traits: ["async"] }],
						},
					],
					handles: {},
					typeExports: ["review-shape"],
					runtime: "imported",
				});
				const recipe = yield* Schema.decodeEffect(Recipe)({
					package: "string-lib",
					version: "1.0.0",
					types,
					name: "@effectified/string-lib",
					prefix: "StringLib",
					exports: ["fetch-it"],
					handles: {},
					errors: [{ tag: "StringLibError", codes: [] }],
					services: [],
					methods: {},
					derived: [],
					testDependencies: {},
					decisions: [],
				});
				const files = yield* generate(surface, recipe);
				const project = join(import.meta.dirname, "..", ".cache", "string-names");
				expect(checkedFacade(project, files, upstream, { "test/use.ts": use })).toStrictEqual({
					check: "",
					build: "",
				});
				// The facade's source as its tests run it, and its release as its users import it.
				expect(ranInNode(join(project, "test", "use.ts"))).toStrictEqual({ status: 0, output: '{"size":4}\n' });
				writeFileSync(
					join(project, "use.mjs"),
					'import { "review-sentinel" as sentinel } from "./dist/index.js";\nconsole.log(sentinel);\n',
				);
				expect(ranInNode(join(project, "use.mjs"))).toStrictEqual({ status: 0, output: "1\n" });
				const source = files.get("src/index.ts") ?? "";
				expect(source).toContain('export { plain, "review-sentinel" } from "string-lib";');
				expect(source).not.toContain("fetch-it");
				expect(unwrappedNote(surface, recipe)).toStrictEqual(Option.some(expect.stringContaining('("fetch-it")')));
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.effect(
		'names a handle first reached through an export named by a string as `Upstream["<name>"]`, and the facade type checks',
		() =>
			Effect.gen(function* () {
				// `Conn` is no export: the analyzer names it by how it is reached, here first through `"open-conn"`.
				const root = join(import.meta.dirname, "..", ".cache", "string-reached");
				rmSync(root, { recursive: true, force: true });
				const lib = {
					name: "reach-lib",
					declarations: [
						"interface Conn { query(sql: string): Promise<number>; close(): Promise<void> }",
						"declare function open(): Conn;",
						'export { open as "open-conn", open };',
						"",
					].join("\n"),
					module: [
						"function open() { return { query: async (sql) => sql.length, close: async () => {} }; }",
						'export { open as "open-conn", open };',
						"",
					].join("\n"),
				};
				const workspace = join(root, "workspace");
				const put = (file: string, content: string) => {
					mkdirSync(dirname(join(workspace, file)), { recursive: true });
					writeFileSync(join(workspace, file), content);
				};
				put(
					"node_modules/reach-lib/package.json",
					JSON.stringify({ name: "reach-lib", version: "1.0.0", types: "index.d.ts" }),
				);
				put("node_modules/reach-lib/index.d.ts", lib.declarations);
				// The workspace `prepareWorkspace` writes: its tsconfig, and an entry that re-exports the package as `lib`.
				const tsconfig = {
					compilerOptions: {
						strict: true,
						module: "nodenext",
						moduleResolution: "nodenext",
						target: "esnext",
						lib: ["esnext"],
						noEmit: true,
						skipLibCheck: true,
					},
					files: ["entry.ts"],
				};
				put("tsconfig.json", JSON.stringify(tsconfig));
				put("entry.ts", 'export * as lib from "reach-lib";\n');
				const types = { from: "bundled", package: "reach-lib", version: "1.0.0" } as const;
				const analyzed = yield* analyze({
					target: { package: "reach-lib", version: "1.0.0", repository: undefined, types },
					directory: workspace,
					tsconfig: join(workspace, "tsconfig.json"),
					entry: join(workspace, "entry.ts"),
					packageDirectory: join(workspace, "node_modules", "reach-lib"),
				});
				expect(analyzed.handles["Conn"]?.typeRef).toBe('Awaited<ReturnType<typeof Upstream["open-conn"]>>');
				const surface = { ...analyzed, runtime: "imported" as const };
				const recipe = yield* draftRecipe(
					surface,
					{ files: 0, errorClasses: [], codes: [], events: [] },
					"",
					undefined,
					false,
				);
				expect(recipe.exports).toStrictEqual(["open"]);
				const files = yield* generate(surface, recipe);
				expect(checkedFacade(join(root, "facade"), files, lib, {})).toStrictEqual({ check: "", build: "" });
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);

	it.effect("drafts neither an offer nor an error of an export named by a string, and re-exports it as it is", () =>
		Effect.gen(function* () {
			const fetching = { ...signature("Promise<number>"), resolves: "number", traits: ["async" as const] };
			const surface = yield* Schema.decodeEffect(Surface)({
				package: "string-lib",
				version: "1.0.0",
				types,
				entry: "named",
				exports: [
					{ kind: "function", name: "fetch-it", signatures: [fetching] },
					{ kind: "function", name: "fetchPlain", signatures: [fetching] },
					{ kind: "class", name: "fail-error", handle: "fail-error", constructors: [], error: true },
					{ kind: "class", name: "PlainError", handle: "PlainError", constructors: [], error: true },
				],
				handles: {},
				typeExports: [],
				runtime: "imported",
			});
			const drafted = yield* draftRecipe(
				surface,
				{ files: 0, errorClasses: [], codes: [], events: [] },
				"",
				undefined,
				false,
			);
			expect(drafted.exports).toStrictEqual(["fetchPlain"]);
			expect(drafted.errors.map((error) => error.tag)).toStrictEqual(["PlainError", "StringLibError"]);
			// `PlainError` is the facade's own error; `fail-error` is re-exported as upstream's class, for `instanceof`, and
			// the async `fetch-it`, which needs wrapping, stays `Upstream["fetch-it"]`.
			expect(valueExports(surface, drafted)).toStrictEqual({ kind: "reexported", names: ["fail-error"] });
		}),
	);
});

describe("generate: codes that are keys of Object.prototype", () => {
	it.effect(
		"makes `__proto__` a case of the reason schema, which decodes it",
		() =>
			Effect.gen(function* () {
				const types = { from: "bundled", package: "proto-lib", version: "1.0.0" } as const;
				const surface = yield* Schema.decodeEffect(Surface)({
					package: "proto-lib",
					version: "1.0.0",
					types,
					entry: "named",
					exports: [],
					handles: {},
					typeExports: [],
					runtime: "imported",
				});
				const recipe = yield* Schema.decodeEffect(Recipe)({
					package: "proto-lib",
					version: "1.0.0",
					types,
					name: "@effectified/proto-lib",
					prefix: "ProtoLib",
					exports: [],
					handles: {},
					errors: [{ tag: "ProtoLibError", codes: ["__proto__", "constructor", "E_IO"] }],
					services: [],
					methods: {},
					derived: [],
					testDependencies: {},
					decisions: [],
				});
				const files = yield* generate(surface, recipe);
				// Each case decodes, `__proto__` and `constructor` too, and is an own case of the schema.
				const decode = [
					'import { Schema } from "effect";',
					'import { ProtoLibErrorReason } from "../src/index.ts";',
					"const decode = Schema.decodeUnknownSync(ProtoLibErrorReason);",
					'console.log(JSON.stringify(["__proto__", "constructor", "E_IO", "Other"].map((code) => decode({ _tag: code })._tag)));',
					'console.log(Object.keys(ProtoLibErrorReason.cases).join(","));',
					"",
				].join("\n");
				const project = join(import.meta.dirname, "..", ".cache", "proto-codes");
				const upstream = { name: "proto-lib", declarations: "export {};\n", module: "export {};\n" };
				expect(checkedFacade(project, files, upstream, { "test/decode.ts": decode })).toStrictEqual({
					check: "",
					build: "",
				});
				expect(ranInNode(join(project, "test", "decode.ts"))).toStrictEqual({
					status: 0,
					output: '["__proto__","constructor","E_IO","Other"]\n__proto__,constructor,E_IO,Other\n',
				});
				expect(files.get("src/index.ts")).toContain(
					'ProtoLibErrorReason = Schema.TaggedUnion({ ["__proto__"]: {}, constructor: {}, E_IO: {}, Other: {} });',
				);
			}).pipe(Effect.provide(NodeServices.layer)),
		60_000,
	);
});

describe("extractExamples", () => {
	const file = [
		`import { describe, expect, it } from "@effect/vitest";`,
		`import { Effect, Schema } from "effect";`,
		`import { SharpError, sharp } from "../src/index.ts";`,
		`import { chrome } from "./support/browser.ts";`,
		"",
		"// #region example: Resize an image",
		`const red = { create: { width: 4, height: 2, channels: 3, background: "#ff0000" } } as const;`,
		"// #endregion",
		"",
		`it.effect("resizes", () =>`,
		"\tEffect.gen(function* () {",
		"\t\t// #region example: Resize an image",
		"\t\tconst image = yield* sharp(red);",
		"\t\tconst png = yield* image.resize(2, 1).png().toBuffer();",
		"\t\t// #endregion",
		`\t\texpect(png.length).toBeGreaterThan(0);`,
		"\t}),",
		");",
	].join("\n");

	it("joins regions of one title, dedents them, and imports what they use, the facade by its name", () => {
		expect(extractExamples("test/facade.test.ts", file, "@effectified/sharp")).toStrictEqual([
			{
				title: "Resize an image",
				source: "test/facade.test.ts",
				code: [
					`import { sharp } from "@effectified/sharp";`,
					"",
					`const red = { create: { width: 4, height: 2, channels: 3, background: "#ff0000" } } as const;`,
					"",
					"const image = yield* sharp(red);",
					"const png = yield* image.resize(2, 1).png().toBuffer();",
					"",
				].join("\n"),
			},
		]);
	});

	it("shares a region opened for two examples, and imports nothing a comment only mentions", () => {
		const shared = [
			`import { Effect } from "effect";`,
			`import { make, XError } from "../src/index.ts";`,
			"// #region example: One",
			"// #region example: Two",
			"const options = { n: 1 };",
			"// #endregion",
			"// #region example: One",
			"const a = make(options); // fails with XError",
			"// #endregion",
			"// #region example: Two",
			"const b = Effect.succeed(options);",
			"// #endregion",
		].join("\n");
		expect(extractExamples("test/x.test.ts", shared, "@effectified/x").map((example) => example.code)).toStrictEqual([
			`import { make } from "@effectified/x";\n\nconst options = { n: 1 };\n\nconst a = make(options); // fails with XError\n`,
			`import { Effect } from "effect";\n\nconst options = { n: 1 };\n\nconst b = Effect.succeed(options);\n`,
		]);
	});

	it("finds nothing in a file without regions", () => {
		expect(
			extractExamples("test/x.test.ts", `import { Effect } from "effect";\nEffect.void;\n`, "@effectified/x"),
		).toStrictEqual([]);
	});
});
