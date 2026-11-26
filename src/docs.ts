// A facade's documentation, generated with it: examples taken from its passing tests, its API read from the surface
// and the recipe, a README, the skill an agent follows to use it (SKILL.md, shipped in the package), and docs.json,
// which effectified.dev renders as the facade's page. Like the rest of the facade, the same inputs write the same
// bytes, and nothing here is edited by hand: examples change in the tests, words in the recipe's `tagline`.

import { Effect, FileSystem, Path } from "effect";
import { callbackMethods, classified, wrappedMethods } from "./methods.ts";
import { demoUrl, description, facadeVersion, latestUrl, PACKAGES_REPOSITORY, type Recipe, releaseTag, releaseUrl, SITE, slug } from "./recipe.ts";
import type { Surface } from "./surface.ts";
import { boundElements, boundEvents, boundProperties, controlState } from "./ui-facade.ts";

/** One example: a region of a passing test or fixture, with the imports it uses, importing the facade by name. */
export interface Example {
	readonly title: string;
	/** The file it comes from, relative to the package. */
	readonly source: string;
	readonly code: string;
	/** The demo that runs it, for an example from a fixture of a frontend facade: `<demo>.html` of the built demo. */
	readonly demo?: string;
}

/** What the docs take from the package's tests: their examples, how many tests CI runs, and the demos. */
export interface TestDocs {
	readonly examples: ReadonlyArray<Example>;
	readonly tests: number;
	/** The fixtures of a frontend facade (`test/fixtures/<name>.html` and `.ts`): Effect UI apps, built as its demo. */
	readonly demos: ReadonlyArray<string>;
}

/** A facade's API as its users meet it: what it exports, its services, errors, handles, elements and mounts. */
export interface Api {
	readonly exports: ReadonlyArray<string>;
	readonly services: ReadonlyArray<{ readonly name: string; readonly handle: string; readonly acquire: string }>;
	readonly errors: ReadonlyArray<{ readonly tag: string; readonly instanceOf?: string; readonly codes: ReadonlyArray<string> }>;
	readonly handles: ReadonlyArray<{
		readonly name: string;
		readonly release?: string;
		readonly effects: ReadonlyArray<string>;
		readonly streams: ReadonlyArray<string>;
		readonly sync: ReadonlyArray<string>;
		readonly events: ReadonlyArray<string>;
	}>;
	readonly elements: ReadonlyArray<{
		readonly tag: string;
		readonly name: string;
		readonly description: string;
		readonly properties: ReadonlyArray<string>;
		readonly events: ReadonlyArray<string>;
		/** The state its `<Name>Changes` mount reports, for a form control. */
		readonly changes: ReadonlyArray<string>;
	}>;
	readonly mounts: ReadonlyArray<string>;
}

/** docs.json: everything effectified.dev shows on the facade's page. A stored format: `schema` moves when it changes. */
export interface Docs {
	readonly schema: 1;
	readonly name: string;
	readonly slug: string;
	readonly kind: "runtime" | "ui";
	readonly tagline?: string;
	readonly description: string;
	readonly upstream: { readonly package: string; readonly version: string; readonly npm: string };
	readonly version: string;
	readonly engine: string;
	readonly page: string;
	readonly source: string;
	readonly install: { readonly latest: string; readonly release: string; readonly tag: string; readonly effectUi?: string };
	/** The built demo of a frontend facade, attached to its release: a tarball of `<demo>.html` pages and their assets. */
	readonly demo?: { readonly url: string; readonly pages: ReadonlyArray<string> };
	readonly tests: number;
	readonly examples: ReadonlyArray<Example>;
	readonly api: Api;
}

/** The documentation files of a facade, by path relative to its package. */
export function docsFiles(surface: Surface, recipe: Recipe, tests: TestDocs, engine: string): ReadonlyMap<string, string> {
	const docs = docsOf(surface, recipe, tests, engine);
	return new Map([
		["README.md", readme(docs)],
		["SKILL.md", skill(docs)],
		["docs.json", `${JSON.stringify(docs, null, 2)}\n`],
	]);
}

/** Reads the examples and counts the tests of `packageDirectory/test`, importing the facade as `name`. */
export const readTestDocs = Effect.fn("readTestDocs")(function* (packageDirectory: string, name: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = path.join(packageDirectory, "test");
	if (!(yield* fs.exists(root))) return { examples: [], tests: 0, demos: [] } satisfies TestDocs;
	const all = (yield* fs.readDirectory(root, { recursive: true })).map((file) => file.split(path.sep).join("/")).sort();
	const demos = all.flatMap((file) => {
		const fixture = /^fixtures\/([\w-]+)\.html$/.exec(file)?.[1];
		return fixture !== undefined && all.includes(`fixtures/${fixture}.ts`) ? [fixture] : [];
	});
	const examples: Array<Example> = [];
	let tests = 0;
	for (const file of all.filter((candidate) => candidate.endsWith(".ts") && !candidate.startsWith("support/"))) {
		const text = yield* fs.readFileString(path.join(root, file));
		if (file.endsWith(".test.ts")) tests += text.match(TEST_CALL)?.length ?? 0;
		// The engine's own fixtures and smoke tests carry no examples: an example is code a person or agent chose.
		if (text.startsWith("// Generated by @effectified/engine")) continue;
		const demo = /^fixtures\/([\w-]+)\.ts$/.exec(file)?.[1];
		for (const example of extractExamples(`test/${file}`, text, name)) {
			examples.push(demo !== undefined && demos.includes(demo) ? { ...example, demo } : example);
		}
	}
	return { examples, tests, demos } satisfies TestDocs;
});

/** A test case: `it("...")`, `it.effect("...")`, `it.live("...")`. */
const TEST_CALL = /\bit(?:\.\w+)*\(\s*["'`]/g;

/**
 * The examples of one file: each `// #region example: <title>` to its `// #endregion`, regions of the same title
 * joined in order (a declaration above a test and the test's body), each dedented, after the file's imports the
 * example uses, the facade's own (`../src/index.ts`) imported by its name. Test tooling is never imported. Openers
 * on consecutive lines share one region: a declaration two examples need.
 */
export function extractExamples(source: string, text: string, name: string): ReadonlyArray<Example> {
	const regions = new Map<string, Array<string>>();
	let open: { readonly titles: Array<string>; readonly lines: Array<string> } | undefined;
	for (const line of text.split("\n")) {
		const start = REGION.exec(line);
		if (start !== null) {
			const title = start[1]?.trim() ?? "Example";
			if (open !== undefined && open.lines.length === 0) open.titles.push(title);
			else open = { titles: [title], lines: [] };
			continue;
		}
		if (open !== undefined && END_REGION.test(line)) {
			const chunk = dedent(open.lines);
			for (const title of open.titles) regions.set(title, [...(regions.get(title) ?? []), chunk]);
			open = undefined;
			continue;
		}
		open?.lines.push(line);
	}
	const imports = importsOf(text, name);
	return [...regions].map(([title, chunks]) => {
		const body = chunks.join("\n\n");
		// A name a comment mentions is not a use.
		const used = imports.flatMap((statement) => statement(body.replace(/\/\/.*$/gm, "")));
		return { title, source, code: `${used.length === 0 ? "" : `${used.join("\n")}\n\n`}${body}\n` };
	});
}

const REGION = /^\s*\/\/ #region example(?::\s*(.+))?\s*$/;
const END_REGION = /^\s*\/\/ #endregion\b/;

/** Removes the indentation every non-blank line shares, and blank lines at either end. */
function dedent(lines: ReadonlyArray<string>): string {
	const indents = lines.filter((line) => line.trim() !== "").map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
	const shared = indents.length === 0 ? 0 : Math.min(...indents);
	return lines
		.map((line) => line.slice(shared).trimEnd())
		.join("\n")
		.replace(/^\n+|\n+$/g, "");
}

/** Test tooling, never imported by an example. */
const TOOLING = new Set(["vitest", "@effect/vitest"]);

/**
 * The file's import statements, each as a function of an example's body to the statement importing what the body
 * uses (nothing when it uses none of it). A package imported for its side effect (a stylesheet) is always imported.
 * The facade's own module is imported by the facade's name; other relative imports (test support) are left out.
 */
function importsOf(text: string, name: string): ReadonlyArray<(body: string) => ReadonlyArray<string>> {
	const statements: Array<(body: string) => ReadonlyArray<string>> = [];
	for (const match of text.matchAll(IMPORT)) {
		const [, typeOnly, clause, from = ""] = match;
		if (TOOLING.has(from)) continue;
		const facade = /^(?:\.\.\/)+src\/index\.ts$/.test(from);
		if (from.startsWith(".") && !facade) continue;
		if (clause === undefined) {
			statements.push(() => [`import ${JSON.stringify(from)};`]);
			continue;
		}
		const specifier = JSON.stringify(facade ? name : from);
		const prefix = `import ${typeOnly === undefined ? "" : "type "}`;
		const namespace = /^\*\s+as\s+([\w$]+)$/.exec(clause.trim());
		if (namespace !== null) {
			statements.push((body) => (uses(body, namespace[1] ?? "") ? [`${prefix}${clause.trim()} from ${specifier};`] : []));
			continue;
		}
		const braces = /\{([\s\S]*)\}/.exec(clause);
		const defaultName = /^([\w$]+)/.exec(clause.trim())?.[1];
		const named = (braces?.[1] ?? "")
			.split(",")
			.map((part) => part.trim().replace(/\s+/g, " "))
			.filter((part) => part !== "");
		statements.push((body) => {
			const keptDefault = defaultName !== undefined && uses(body, defaultName) ? defaultName : undefined;
			const kept = named.filter((part) => uses(body, part.split(" as ").at(-1)?.replace(/^type /, "") ?? ""));
			if (keptDefault === undefined && kept.length === 0) return [];
			const list = [...(keptDefault === undefined ? [] : [keptDefault]), ...(kept.length === 0 ? [] : [`{ ${kept.join(", ")} }`])];
			return [`${prefix}${list.join(", ")} from ${specifier};`];
		});
	}
	return statements;
}

/** An import statement: `import [type] <clause> from "<module>";` over several lines or one, or `import "<module>";`. */
const IMPORT = /^import\s+(?:(type\s+)?([^;"']*?)\s+from\s+)?["']([^"']+)["'];?$/gm;

/** Whether `body` names `identifier` as a word. */
function uses(body: string, identifier: string): boolean {
	return identifier !== "" && new RegExp(String.raw`(?<![\w$.])${identifier.replace(/\$/g, "\\$")}(?![\w$])`).test(body);
}

/** The facade's docs, from its surface, recipe and tests. */
function docsOf(surface: Surface, recipe: Recipe, tests: TestDocs, engine: string): Docs {
	return {
		schema: 1,
		name: recipe.name,
		slug: slug(recipe),
		kind: recipe.ui === undefined ? "runtime" : "ui",
		...(recipe.tagline === undefined ? {} : { tagline: recipe.tagline }),
		description: description(recipe),
		upstream: { package: recipe.package, version: recipe.version, npm: `https://www.npmjs.com/package/${recipe.package}` },
		version: facadeVersion(recipe),
		engine,
		page: `${SITE}/${slug(recipe)}`,
		source: `https://github.com/${PACKAGES_REPOSITORY}/tree/main/targets/${recipe.package.replace(/^@/, "").replace("/", "__")}`,
		install: {
			latest: latestUrl(recipe),
			release: releaseUrl(recipe),
			tag: releaseTag(recipe),
			...(recipe.ui === undefined ? {} : { effectUi: `https://pkg.pr.new/Effect-TS/ui/@effect/ui@${recipe.ui.effectUi}` }),
		},
		...(recipe.ui === undefined || tests.demos.length === 0 ? {} : { demo: { url: demoUrl(recipe), pages: tests.demos } }),
		tests: tests.tests,
		examples: tests.examples,
		api: apiOf(surface, recipe),
	};
}

/** The facade's API, as the generator writes it. */
function apiOf(surface: Surface, recipe: Recipe): Api {
	// A frontend facade exports its bindings and mounts, listed as such; a runtime facade the exports it offers.
	const exported = recipe.ui === undefined ? surface.exports.filter((item) => recipe.exports.includes(item.name)) : [];
	return {
		exports: exported.map((item) => (item.name === "default" ? recipe.prefix.charAt(0).toLowerCase() + recipe.prefix.slice(1) : item.name)),
		services: recipe.services,
		errors: recipe.errors.map((error) => ({ tag: error.tag, ...(error.instanceOf === undefined ? {} : { instanceOf: error.instanceOf }), codes: error.codes })),
		handles: Object.entries(recipe.handles).flatMap(([name, handleRecipe]) => {
			const handle = surface.handles[name];
			if (handle === undefined) return [];
			const effects = [...classified(name, handle.methods, recipe, "async"), ...Object.keys(callbackMethods(name, handle.methods, recipe))].sort();
			const streams = classified(name, handle.methods, recipe, "stream");
			return [
				{
					name,
					...(handleRecipe.release === undefined ? {} : { release: handleRecipe.release }),
					effects,
					streams,
					sync: wrappedMethods(name, handle.methods, recipe).filter((method) => !effects.includes(method) && !streams.includes(method)),
					events: handleRecipe.events,
				},
			];
		}),
		elements: boundElements(surface, recipe).map((element) => {
			const properties = boundProperties(element, recipe);
			return {
				tag: element.tag,
				name: element.name,
				description: element.description,
				properties,
				events: boundEvents(element, recipe),
				changes: controlState(element, properties),
			};
		}),
		mounts: recipe.ui?.mounts ?? [],
	};
}

/** The commands that install the facade's newest release, and with a frontend facade Effect UI's snapshot. */
function installCommands(docs: Docs): ReadonlyArray<string> {
	const extra = docs.install.effectUi === undefined ? "" : ` ${docs.install.effectUi}`;
	return [
		`pnpm add ${docs.install.latest} effect${extra}`,
		`npm install --allow-remote=all ${docs.install.latest} effect${extra}`,
		`bun add ${docs.install.latest} effect${extra}`,
	];
}

/** The README: what the facade is, how to install it, its examples and its API. */
function readme(docs: Docs): string {
	return [
		`# ${docs.name}`,
		"",
		...(docs.tagline === undefined ? [] : [`> ${docs.tagline}`, ""]),
		`[${docs.upstream.package}](${docs.upstream.npm}) ${docs.kind === "ui" ? "for [Effect UI](https://ui.effect.website)" : "in [Effect](https://effect.website)"}, generated by the [effectified engine](https://github.com/effectified/engine) from its types, and tested against the real library. Docs, examples and the agent skill: ${docs.page}`,
		"",
		"## Install",
		"",
		"```sh",
		...installCommands(docs),
		"```",
		"",
		`\`${docs.install.latest}\` always installs the newest release. This one is ${docs.version}, for ${docs.upstream.package} ${docs.upstream.version}; to pin it, install ${docs.install.release}.${docs.kind === "ui" ? " Effect UI is in public preview: install its snapshot build, as above." : ""}`,
		"",
		...examplesMarkdown(docs, "##"),
		"## API",
		"",
		...apiMarkdown(docs),
		"## For agents",
		"",
		`\`SKILL.md\` in this package is the skill an agent follows to write Effect code with ${docs.upstream.package} through this facade: copy \`node_modules/${docs.name}/SKILL.md\` into your agent's skills (\`.claude/skills/${skillName(docs)}/SKILL.md\`, say).`,
		"",
	].join("\n");
}

/** The skill's name: `effectified-<slug>`, in the characters skill names allow. */
function skillName(docs: Docs): string {
	return `effectified-${docs.slug.replace(/[^a-z0-9-]/g, "-")}`;
}

/** SKILL.md: how an agent writes Effect code with the library through the facade. */
function skill(docs: Docs): string {
	const runtime = docs.kind === "runtime";
	return [
		"---",
		`name: ${skillName(docs)}`,
		`description: ${runtime ? `Write Effect code that uses ${docs.upstream.package} through ${docs.name}` : `Use ${docs.upstream.package} in Effect UI apps through ${docs.name}`}. Use when ${runtime ? `an Effect program needs ${docs.upstream.package}, or code calling ${docs.upstream.package} moves onto Effect` : `an Effect UI view renders ${docs.upstream.package}`}: what the facade offers, how its ${runtime ? "Effects, scopes and errors" : "bindings and mounts"} work, and tested examples.`,
		"---",
		"",
		`# ${docs.upstream.package} through ${docs.name}`,
		"",
		...(docs.tagline === undefined ? [] : [`${docs.tagline.charAt(0).toUpperCase()}${docs.tagline.slice(1)}.`, ""]),
		`${docs.description}. Generated from ${docs.upstream.package}'s own types (this copy: ${docs.version}, for ${docs.upstream.package} ${docs.upstream.version}), so its types are upstream's and a call the facade does not change behaves as upstream documents.`,
		"",
		"## Install",
		"",
		"```sh",
		installCommands(docs)[0] ?? "",
		"```",
		"",
		"## Rules",
		"",
		...(runtime ? runtimeRules(docs) : uiRules(docs)),
		"",
		...examplesMarkdown(docs, "##"),
		"## API",
		"",
		...apiMarkdown(docs),
		`More: ${docs.page}`,
		"",
	].join("\n");
}

/** How a runtime facade is used, with its own names. */
function runtimeRules(docs: Docs): ReadonlyArray<string> {
	const { api } = docs;
	const scoped = api.handles.filter((handle) => handle.release !== undefined);
	const emitters = api.handles.filter((handle) => handle.events.length > 0);
	const catchAll = api.errors.at(-1)?.tag;
	return [
		`- Import from \`${docs.name}\`, not from \`${docs.upstream.package}\`. ${docs.upstream.package}'s types are \`Upstream.<Type>\` (\`import { Upstream } from "${docs.name}"\`).`,
		"- An async call returns an `Effect`, run with `yield*` inside `Effect.gen`; an async iterable is a `Stream`; a handle a call returns is a facade too. A synchronous call stays synchronous (a builder chain stays a chain).",
		...(scoped.length === 0
			? []
			: [
					`- Scoped: acquiring ${scoped.map((handle) => `a \`${handle.name}\``).join(", ")} needs a \`Scope\` (\`Effect.scoped\`, or a layer), and closing the scope calls its release (${scoped.map((handle) => `\`${handle.name}.${handle.release}\``).join(", ")}). Never call the release yourself.`,
				]),
		...(api.services.length === 0
			? []
			: [
					`- Services: ${api.services.map((service) => `\`${service.name}\` (a \`${service.handle}\`)`).join(", ")}. Provide one at the program's edge with \`<Service>.layer(<acquiring Effect>)\` and read it with \`yield* <Service>\`.`,
				]),
		`- Failures are tagged: ${api.errors.length <= 1 ? `\`${catchAll ?? `${docs.slug}Error`}\`` : `${api.errors.slice(0, -1).map((error) => `\`${error.tag}\``).join(", ")}, and \`${catchAll}\` for any other failure`}. Handle one with \`Effect.catchTag("<Tag>", ...)\`; each carries \`operation\` (\`"<Handle>.<method>"\`), \`message\`, upstream's \`code\` when it has one, and \`cause\`.`,
		...(emitters.length === 0
			? []
			: [`- Events are Streams: \`events.<Handle>.<event>(handle)\` (${emitters.map((handle) => `\`events.${handle.name}\``).join(", ")}), listening for as long as the stream runs.`]),
		`- What the facade does not wrap stays reachable: \`.upstream\` on every facade, \`Upstream\` for the package. Use them rather than importing \`${docs.upstream.package}\` again.`,
	];
}

/** How a frontend facade is used, with its own names. */
function uiRules(docs: Docs): ReadonlyArray<string> {
	const { api } = docs;
	const first = api.elements[0];
	const control = api.elements.find((element) => element.changes.length > 0);
	return [
		`- Import from \`${docs.name}\`. It runs in [Effect UI](https://ui.effect.website) views (\`Html.component\`), installed from its snapshot build.`,
		...(first === undefined
			? []
			: [
					`- Elements are bindings: \`${first.name}(h)\` renders \`<${first.tag}>\`; set its properties as methods (\`${first.name}(h)${first.properties[0] === undefined ? "" : `.${first.properties[0]}(...)`}\`) and turn its custom events into messages with \`.on("<event>", (detail) => Message.X(...))\`. Importing a binding defines its element.`,
				]),
		...(control === undefined
			? []
			: [
					`- Form controls report their state through their changes mount, not native \`input\`/\`change\` (Effect UI types those \`never\` on custom elements): \`${control.name}(h).onMount(${control.name}Changes({}).pipe(Mount.map((state) => Message.X(state))))\`, with ${control.changes.map((key) => `\`${key}\``).join(", ")}.`,
					"- Set the Model from the event that says a change is done (an element that animates closed fires a request event, then a completion event): setting it on the request asks again.",
				]),
		...(api.mounts.length === 0
			? []
			: [
					`- Mounts: ${api.mounts.map((mount) => `\`${mount}Mount\``).join(", ")}. A mount keeps one ${docs.upstream.package} instance on the element it renders into: \`h.<tag>.onMount(<Name>Mount({ ...args }).pipe(Mount.map(...)))\`. New args update the live instance; leaving the view releases it.`,
				]),
		"- Never reach into the element or instance to change what the Model owns: render the Model, and let messages change it.",
	];
}

/** The examples as Markdown sections, under `level` headings. */
function examplesMarkdown(docs: Docs, level: string): ReadonlyArray<string> {
	if (docs.examples.length === 0) return [];
	return [
		`${level} Examples`,
		"",
		"Each is code from a test that passes in CI.",
		"",
		...docs.examples.flatMap((example) => [`${level}# ${example.title}`, "", "```ts", example.code.trimEnd(), "```", "", `From \`${example.source}\`.`, ""]),
	];
}

/** The API as Markdown. */
function apiMarkdown(docs: Docs): ReadonlyArray<string> {
	const { api } = docs;
	const code = (names: ReadonlyArray<string>) => (names.length === 0 ? "–" : names.map((name) => `\`${name}\``).join(", "));
	return [
		...(api.exports.length === 0 ? [] : [`Exports: ${code(api.exports)}.`, ""]),
		...(api.services.length === 0 ? [] : [`Services: ${api.services.map((service) => `\`${service.name}\` (a \`${service.handle}\`, from \`${service.acquire}\`)`).join(", ")}.`, ""]),
		...(api.errors.length === 0
			? []
			: [
					"| Error | From |",
					"|---|---|",
					...api.errors.map((error, index) => {
						const from = error.instanceOf !== undefined ? `\`${error.instanceOf}\`` : index === api.errors.length - 1 ? "any other failure" : "";
						return `| \`${error.tag}\` | ${[from, ...(error.codes.length === 0 ? [] : [`codes ${code(error.codes)}`])].filter((part) => part !== "").join(", ")} |`;
					}),
					"",
				]),
		...(api.handles.length === 0
			? []
			: [
					"| Handle | Effects | Streams | Events | Released by |",
					"|---|---|---|---|---|",
					...api.handles.map((handle) => `| \`${handle.name}\` | ${code(handle.effects)} | ${code(handle.streams)} | ${code(handle.events)} | ${handle.release === undefined ? "–" : `\`${handle.release}\``} |`),
					"",
				]),
		...(api.elements.length === 0
			? []
			: [
					"| Element | Binding | Properties | Events |",
					"|---|---|---|---|",
					...api.elements.map((element) => `| \`<${element.tag}>\` | \`${element.name}\`${element.changes.length === 0 ? "" : `, \`${element.name}Changes\``} | ${code(element.properties)} | ${code(element.events)} |`),
					"",
				]),
		...(api.mounts.length === 0 ? [] : [`Mounts: ${code(api.mounts.map((mount) => `${mount}Mount`))}.`, ""]),
	];
}
