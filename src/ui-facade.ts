// The frontend facade: a library made native to Effect UI. A web-component library gets one `Html.customElement`
// binding per element, its properties and events typed by upstream's declarations; an imperative library (a chart,
// an editor, a map) gets mounts (`instanceMount`), written by agents under src/mounts. Its tests run a real Effect UI
// app in Chrome: a generated harness serves fixtures with Vite and drives them through @effectified/puppeteer-core.

import { EFFECT_PLUGIN } from "./diagnostics.ts";
import type { Element } from "./elements.ts";
import { description, effectUiUrl, facadeRepository, type Recipe } from "./recipe.ts";
import type { Surface } from "./surface.ts";

/**
 * Pinned versions a frontend facade builds and tests with. The browser harness drives Chrome through a released
 * puppeteer-core facade; the release it names stays in place when facades move, so its URL is changed only for a
 * newer facade.
 */
const UI_TOOLCHAIN = {
	effect: "4.1.5",
	typescript: "7.0.2",
	"@types/node": "26.6.7",
	vitest: "5.1.1",
	"@effect/vitest": "4.1.5",
	vite: "8.3.8",
	"@effectified/puppeteer-core":
		"https://github.com/effectified/engine/releases/download/puppeteer-core-v25.19.0+2/effectified-puppeteer-core-25.19.0+2.tgz",
} as const;

/** The files of a frontend facade at `version` (its `facadeVersion`), by path relative to the package, given the runtime's source. */
export function uiFiles(
	surface: Surface,
	recipe: Recipe,
	version: string,
	header: (what: string) => string,
	runtime: string,
): ReadonlyMap<string, string> {
	const ui = recipe.ui;
	if (ui === undefined) return new Map();
	const elements = boundElements(surface, recipe);
	const files = new Map<string, string>([
		["package.json", packageJson(recipe, version, ui.effectUi, elements)],
		["tsconfig.json", TSCONFIG],
		["tsconfig.build.json", TSCONFIG_BUILD],
		["src/internal/ui.ts", `${header("the Effect UI runtime of @effectified/engine, copied verbatim")}${runtime}`],
		["src/index.ts", indexSource(elements, ui.mounts, header)],
		["test/support/browser.ts", `${header("the browser harness of frontend facades")}${HARNESS}`],
		["test/support/demo.ts", `${header("the demo builder of frontend facades")}${DEMO}`],
	]);
	for (const element of elements) files.set(`src/elements/${element.name}.ts`, elementSource(element, recipe, header));
	if (elements.length > 0) {
		files.set("test/fixtures/elements.html", FIXTURE_HTML("elements"));
		files.set("test/fixtures/elements.ts", elementsFixture(elements, header));
		files.set("test/elements.generated.test.ts", elementsTest(elements, header));
	}
	return files;
}

/**
 * DOM events every element has (lib.dom's HTMLElementEventMap). A binding leaves them out: Effect UI's host reads
 * their payload from the element itself (`input` and `change` give `{ value }`), where a declared custom event would
 * hand the handler only its `detail`, which a native event does not have.
 */
const DOM_EVENTS = new Set(
	(
		"abort animationcancel animationend animationiteration animationstart auxclick beforeinput beforetoggle blur cancel canplay " +
		"canplaythrough change click close compositionend compositionstart compositionupdate contextmenu copy cuechange cut dblclick " +
		"drag dragend dragenter dragleave dragover dragstart drop durationchange emptied ended error focus focusin focusout formdata " +
		"gotpointercapture input invalid keydown keypress keyup load loadeddata loadedmetadata loadstart lostpointercapture mousedown " +
		"mouseenter mouseleave mousemove mouseout mouseover mouseup paste pause play playing pointercancel pointerdown pointerenter " +
		"pointerleave pointermove pointerout pointerover pointerup progress ratechange reset resize scroll scrollend " +
		"securitypolicyviolation seeked seeking select selectionchange selectstart slotchange stalled submit suspend timeupdate toggle " +
		"touchcancel touchend touchmove touchstart transitioncancel transitionend transitionrun transitionstart volumechange waiting wheel"
	).split(" "),
);

/**
 * One element's binding: its definition imported, every settable property and custom event typed by upstream. The
 * binding's type is written out: inferred, its declaration would expand each property's type, which may name a
 * type upstream does not export (Web Awesome's `Validator`), and no `.d.ts` could be emitted for it.
 */
function elementSource(element: Element, recipe: Recipe, header: (what: string) => string): string {
	const untyped = recipe.derived.includes(element.tag);
	const properties = boundProperties(element, recipe);
	const events = boundEvents(element, recipe);
	const tag = JSON.stringify(element.tag);
	const propertyType = (property: string) => `Of[${JSON.stringify(property)}]`;
	const eventType = (event: string) => `DetailOf<${JSON.stringify(event)}>`;
	return [
		header(`the Effect UI binding of <${element.tag}>`).trimEnd(),
		`import ${JSON.stringify(element.definition)};`,
		`import { Html } from "@effect/ui/html";`,
		`import type { Schema } from "effect";`,
		`import { ${[
			...(events.length > 0 ? ["type DetailOf"] : []),
			...(changesSource(element, properties).length > 0 ? ["changesMount"] : []),
			"typed",
		].join(", ")} } from "../internal/ui.ts";`,
		"",
		untyped
			? "// Upstream's types do not name this element in HTMLElementTagNameMap: its properties are typed unknown."
			: `/** The upstream element's type, which types the binding's properties. */`,
		untyped
			? "type Of = Record<string, unknown>;"
			: `type Of = HTMLElementTagNameMap[${tag}]; // element: ${element.tag}`,
		"",
		`/** The properties a view sets on \`<${element.tag}>\`, as upstream types them. */`,
		`type Properties = {${properties.length === 0 ? "};" : ""}`,
		...(properties.length === 0
			? []
			: [
					...properties.map(
						(property) =>
							`\treadonly ${memberName(property)}: Schema.declare<${propertyType(property)}>; // property: ${element.tag}.${property}`,
					),
					"};",
				]),
		"",
		`/** The custom events of \`<${element.tag}>\`, each its \`detail\`. */`,
		`type Events = {${events.length === 0 ? "};" : ""}`,
		...(events.length === 0
			? []
			: [...events.map((event) => `\treadonly ${memberName(event)}: Schema.declare<${eventType(event)}>;`), "};"]),
		"",
		`/** \`<${element.tag}>\`${element.description === "" ? "" : `: ${element.description.replace(/\*\//g, "* /")}`} */`,
		`export const ${element.name}: Html.CustomElementBinding<${tag}, Properties, Events> = Html.customElement({`,
		`\ttag: ${tag},`,
		`\tproperties: {${properties.length === 0 ? "}," : ""}`,
		...(properties.length === 0
			? []
			: [
					...properties.map(
						(property) =>
							`\t\t${memberName(property)}: typed<${propertyType(property)}>(), // property: ${element.tag}.${property}`,
					),
					"\t},",
				]),
		`\tevents: {${events.length === 0 ? "}," : ""}`,
		...(events.length === 0
			? []
			: [...events.map((event) => `\t\t${memberName(event)}: typed<${eventType(event)}>(),`), "\t},"]),
		"});",
		...changesSource(element, properties),
		"",
	].join("\n");
}

/** The elements a frontend facade binds: those of the surface the recipe does not exclude. */
export function boundElements(surface: Surface, recipe: Recipe): ReadonlyArray<Element> {
	return (surface.elements ?? []).filter((element) => recipe.methods[element.tag] !== "exclude");
}

/** The properties an element's binding sets: the element's own, less the recipe's `<tag>.<property>` excludes. */
export function boundProperties(element: Element, recipe: Recipe): ReadonlyArray<string> {
	return element.properties.filter((property) => recipe.methods[`${element.tag}.${property}`] !== "exclude");
}

/** The custom events an element's binding carries: not DOM events, less the recipe's `<tag>@<event>` excludes. */
export function boundEvents(element: Element, recipe: Recipe): ReadonlyArray<string> {
	// `<tag>@<event>`: an event and a property may share a name (`md-dialog`'s `open`).
	return element.events.filter(
		(event) => !DOM_EVENTS.has(event) && recipe.methods[`${element.tag}@${event}`] !== "exclude",
	);
}

/** The state a form control's changes mount reports; none when the element is no form control. */
export function controlState(element: Element, properties: ReadonlyArray<string>): ReadonlyArray<string> {
	if (!element.events.some((event) => event === "input" || event === "change")) return [];
	return CONTROL_STATE.filter((key) => properties.includes(key));
}

/** The state a changes mount reports, when the element has it as a property. */
const CONTROL_STATE = ["value", "checked", "indeterminate", "selected", "open", "valueAsNumber"];

/**
 * For a form control (an element firing native `input` or `change`), a mount reporting its state on each: Effect
 * UI's payload for these events does not carry a custom element's state.
 */
function changesSource(element: Element, properties: ReadonlyArray<string>): ReadonlyArray<string> {
	const state = controlState(element, properties);
	if (state.length === 0) return [];
	return [
		"",
		`/** \`<${element.tag}>\`'s ${state.map((key) => `\`${key}\``).join(" and ")} each time it fires \`input\` or \`change\`: \`${element.name}(h).onMount(${element.name}Changes({}).pipe(Mount.map(...)))\`. */`,
		`export const ${element.name}Changes = changesMount<Of, ${state.map((key) => JSON.stringify(key)).join(" | ")}>(${JSON.stringify(`${element.name}Changes`)}, [${state.map((key) => JSON.stringify(key)).join(", ")}]);`,
	];
}

function indexSource(
	elements: ReadonlyArray<Element>,
	mounts: ReadonlyArray<string>,
	header: (what: string) => string,
): string {
	return [
		header("the index of the Effect UI facade").trimEnd(),
		...elements.map((element) => `export * from "./elements/${element.name}.ts";`),
		...mounts.map((mount) => `export * from "./mounts/${mount}.ts";`),
		`export { changesMount, type DetailOf, type InstanceSpec, instanceMount, typed } from "./internal/ui.ts";`,
		"",
	].join("\n");
}

/** A fixture that renders every element once in an Effect UI app, each marked `data-effectified`. */
function elementsFixture(elements: ReadonlyArray<Element>, header: (what: string) => string): string {
	return [
		header("a fixture rendering every element in an Effect UI app").trimEnd(),
		`import { UiSchema } from "@effect/ui";`,
		`import { BrowserHost, Html } from "@effect/ui/html";`,
		`import { Effect, Layer, Schema } from "effect";`,
		`import * as Facade from "../../src/index.ts";`,
		"",
		"const Message = UiSchema.TaggedEnum({ Rendered: {} });",
		"",
		'const Elements = Html.component({ name: "Elements", model: Schema.Struct({ rendered: Schema.Boolean }), message: Message }).make({',
		"\tinit: () => ({ rendered: true }),",
		"\tupdate: { Rendered: ($) => $.evolve({ rendered: () => true }) },",
		"\tview: (h) =>",
		"\t\th.div.children(",
		...elements.map(
			(element) => `\t\t\tFacade.${element.name}(h).attr("data-effectified", ${JSON.stringify(element.tag)}),`,
		),
		"\t\t),",
		"});",
		"",
		`Layer.launch(BrowserHost.mount(Elements, {}, document.getElementById("root")!)).pipe(Effect.runFork);`,
		"",
	].join("\n");
}

function elementsTest(elements: ReadonlyArray<Element>, header: (what: string) => string): string {
	return [
		header("the smoke test of every element; behaviour tests are written next to it").trimEnd(),
		`import { describe, expect, it } from "@effect/vitest";`,
		`import { Effect, Schema } from "effect";`,
		`import { chrome, fixture } from "./support/browser.ts";`,
		"",
		`const tags = ${JSON.stringify(elements.map((element) => element.tag))};`,
		"",
		"/** What the page reports of each rendered element, as JSON: the page's result crosses the browser boundary as data. */",
		"const Rendered = Schema.fromJsonString(Schema.Array(Schema.Struct({ tag: Schema.String, defined: Schema.Boolean })));",
		"",
		`describe.skipIf(chrome === undefined)("elements", () => {`,
		`\tit.effect("renders every element through Effect UI, each one defined by its upstream module", () =>`,
		"\t\tEffect.scoped(",
		"\t\t\tEffect.gen(function* () {",
		`\t\t\t\tconst { page } = yield* fixture("elements");`,
		'\t\t\t\tyield* page.waitForFunction((count) => document.querySelectorAll("[data-effectified]").length === count, {}, tags.length);',
		"\t\t\t\tconst rendered = yield* Schema.decodeUnknownEffect(Rendered)(",
		"\t\t\t\t\tyield* page.evaluate(() =>",
		"\t\t\t\t\t\t// Runs in the page: it serializes what it found for the decoder above.",
		"\t\t\t\t\t\tJSON.stringify(",
		'\t\t\t\t\t\t\t[...document.querySelectorAll("[data-effectified]")].map((node) => ({ tag: node.localName, defined: customElements.get(node.localName) !== undefined })),',
		"\t\t\t\t\t\t),",
		"\t\t\t\t\t),",
		"\t\t\t\t);",
		"\t\t\t\texpect(rendered.map((element) => element.tag).sort()).toStrictEqual([...tags].sort());",
		"\t\t\t\texpect(rendered.filter((element) => !element.defined).map((element) => element.tag)).toStrictEqual([]);",
		"\t\t\t}),",
		"\t\t),",
		"\t);",
		"});",
		"",
	].join("\n");
}

const FIXTURE_HTML = (name: string) =>
	`<!doctype html>\n<!-- Generated by @effectified/engine: the page of the fixture ${name}.ts. -->\n<html lang="en">\n\t<head>\n\t\t<link rel="icon" href="data:," />\n\t</head>\n\t<body>\n\t\t<div id="root"></div>\n\t\t<script type="module" src="./${name}.ts"></script>\n\t</body>\n</html>\n`;

/**
 * The demo: every fixture page (`test/fixtures/<name>.html`, an Effect UI app the tests drive) built by Vite into a
 * static site with relative paths, which effectified.dev embeds on the facade's page. `effectify release` attaches
 * it to the release; `npm run demo -- <directory>` builds it by hand.
 */
const DEMO = `import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
const pages = readdirSync(fixtures).filter((file) => file.endsWith(".html"));
const outDir = resolve(process.argv[2] ?? "demo");

await build({
	root: fixtures,
	base: "./",
	logLevel: "warn",
	build: {
		outDir,
		emptyOutDir: true,
		rollupOptions: { input: Object.fromEntries(pages.map((page) => [page.slice(0, -".html".length), join(fixtures, page)])) },
	},
});

// Files a page names by URL rather than imports (a video) are copied as they are.
for (const file of readdirSync(fixtures).filter((name) => !/\\.(ts|html)$/.test(name))) copyFileSync(join(fixtures, file), join(outDir, file));

// The fixtures are test pages: a neutral stylesheet frames them for a reader, leaving the components' own styles be.
writeFileSync(join(outDir, "demo.css"), \`:root { color-scheme: light; font: 14px/1.5 system-ui, sans-serif; color: #18181b; background: #fafafa; }
body { margin: 0; padding: 20px; }
#root > * { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
button { font: inherit; padding: 6px 12px; border: 1px solid #d4d4d8; border-radius: 6px; background: #fff; cursor: pointer; }
button:hover { border-color: #a1a1aa; }
output#state { display: block; max-width: 100%; overflow-x: auto; padding: 8px 10px; border-radius: 6px; background: #18181b; color: #a7f3d0; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; }
output#state::before { content: "Model  "; color: #71717a; }
\`);
for (const page of pages) {
	const file = join(outDir, page);
	writeFileSync(file, readFileSync(file, "utf8").replace("</head>", '\\t<link rel="stylesheet" href="./demo.css" />\\n\\t</head>'));
}
`;

/** The harness: Vite serves test/fixtures, and Chrome opens one through the effectified puppeteer facade. */
const HARNESS = `import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launch } from "@effectified/puppeteer-core";
import { Effect } from "effect";
import { createServer } from "vite";

/** The Chrome the tests drive: CHROME_BIN, else the default macOS install; undefined skips them. */
export const chrome = [process.env["CHROME_BIN"], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(
	(path): path is string => path !== undefined && path !== "" && existsSync(path),
);

const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));

/**
 * Serves test/fixtures with Vite and opens \`<name>.html\` in Chrome, both closed with the scope. \`errors\` collects
 * the page's uncaught errors and console errors, for a test to assert there are none.
 */
export const fixture = Effect.fn("fixture")(function* (name: string) {
	const server = yield* Effect.acquireRelease(
		Effect.promise(async () => {
			const server = await createServer({ root: fixtures, logLevel: "error", server: { port: 0, strictPort: false } });
			await server.listen();
			return server;
		}),
		(server) => Effect.promise(() => server.close()),
	);
	const origin = server.resolvedUrls?.local[0] ?? "http://localhost:5173/";
	const browser = yield* launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
	const page = yield* browser.newPage();
	const errors: Array<string> = [];
	page.upstream.on("pageerror", (error) => errors.push(String(error)));
	page.upstream.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	yield* page.goto(new URL(\`\${name}.html\`, origin).href);
	return { page, errors };
});
`;

function packageJson(recipe: Recipe, version: string, effectUi: string, elements: ReadonlyArray<Element>): string {
	const dependencies: Record<string, string> = {
		...recipe.typeDependencies,
		[recipe.package]: recipe.version,
		...recipe.ui?.dependencies,
	};
	if (recipe.types.from === "definitely-typed") dependencies[recipe.types.package] = recipe.types.version;
	return `${JSON.stringify(
		{
			name: recipe.name,
			version,
			description: description(recipe),
			type: "module",
			license: "MIT",
			repository: facadeRepository(recipe),
			// `./elements/*` only for a facade with element bindings: a wildcard no file matches promises entry points
			// the release lacks (chart.js and CodeMirror offer mounts only).
			exports: {
				".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
				...(elements.length === 0
					? {}
					: { "./elements/*": { types: "./dist/elements/*.d.ts", import: "./dist/elements/*.js" } }),
			},
			files: ["dist", "README.md", "SKILL.md"],
			sideEffects: elements.length === 0 ? ["./dist/index.js"] : ["./dist/elements/*.js", "./dist/index.js"],
			scripts: {
				build: "tsc -p tsconfig.build.json",
				check: "tsc -p tsconfig.json",
				test: "vitest --run --passWithNoTests --testTimeout=60000",
				demo: "node test/support/demo.ts",
			},
			dependencies,
			peerDependencies: { "@effect/ui": "*", effect: `~${UI_TOOLCHAIN.effect}` },
			devDependencies: Object.fromEntries(
				Object.entries({
					"@effect/ui": effectUiUrl(effectUi),
					"@effect/vitest": UI_TOOLCHAIN["@effect/vitest"],
					"@effectified/puppeteer-core": UI_TOOLCHAIN["@effectified/puppeteer-core"],
					"@types/node": UI_TOOLCHAIN["@types/node"],
					effect: UI_TOOLCHAIN.effect,
					typescript: UI_TOOLCHAIN.typescript,
					vite: UI_TOOLCHAIN.vite,
					vitest: UI_TOOLCHAIN.vitest,
					...recipe.testDependencies,
				}).sort(([a], [b]) => a.localeCompare(b)),
			),
			effectified: { upstream: `${recipe.package}@${recipe.version}`, effectUi },
		},
		null,
		2,
	)}\n`;
}

const TSCONFIG = `${JSON.stringify(
	{
		compilerOptions: {
			target: "es2024",
			module: "nodenext",
			moduleResolution: "nodenext",
			lib: ["es2024", "esnext.disposable", "dom", "dom.iterable"],
			types: ["node"],
			strict: true,
			noUncheckedIndexedAccess: true,
			verbatimModuleSyntax: true,
			erasableSyntaxOnly: true,
			allowImportingTsExtensions: true,
			rewriteRelativeImportExtensions: true,
			skipLibCheck: true,
			// A mount imports its library's stylesheet for its side effect (xterm.css): the bundler handles it.
			noUncheckedSideEffectImports: false,
			noEmit: true,
			plugins: [EFFECT_PLUGIN],
		},
		include: ["src", "test"],
	},
	null,
	2,
)}\n`;

const TSCONFIG_BUILD = `${JSON.stringify(
	{
		extends: "./tsconfig.json",
		compilerOptions: { noEmit: false, outDir: "dist", rootDir: "src", declaration: true },
		include: ["src"],
	},
	null,
	2,
)}\n`;

function memberName(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}
