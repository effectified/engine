// The work plan an orchestrator (T3 Code) fans out to coding agents once the engine has done its mechanical part:
// independent units, each with a brief a delegate can act on alone, the files it may touch, what it waits for, and
// the commands that prove it done. The engine decides what is mechanical; the plan is everything that needs judgment.

import type { Recipe } from "./recipe.ts";
import type { Surface } from "./surface.ts";

/** One unit of work for one delegate. */
export interface WorkUnit {
	readonly id: string;
	readonly title: string;
	/** The delegate's brief: self-contained, it is all the delegate knows. */
	readonly brief: string;
	/** Paths (relative to the engine repository) the unit may change; units touching disjoint paths run in parallel. */
	readonly touches: ReadonlyArray<string>;
	readonly dependsOn: ReadonlyArray<string>;
	/** Commands that must pass, from the engine repository's root. */
	readonly acceptance: ReadonlyArray<string>;
}

/** A target's plan. */
export interface Plan {
	readonly target: string;
	readonly facade: string;
	readonly units: ReadonlyArray<WorkUnit>;
}

/** How many elements one test unit covers at most. */
const ELEMENTS_PER_UNIT = 12;

/** How many methods one test unit covers at most; a handle with more is split, so units stay a few hours of work. */
const METHODS_PER_UNIT = 30;

/** Plans the judgment work on a studied and reconciled target. */
export function plan(surface: Surface, recipe: Recipe, directory: string): Plan {
	const target = `${recipe.package}@${recipe.version}`;
	const pkg = `${directory}/package`;
	const check = [`pnpm effectify reconcile ${recipe.package}`, `pnpm effectify test ${recipe.package}`];
	const toReview = recipe.decisions.filter((decision) => decision.by === "engine");
	const units: Array<WorkUnit> = [
		{
			id: "recipe",
			title: `Review the recipe of ${recipe.name}`,
			brief: [
				`Review every decision the engine drafted in ${directory}/recipe.json for ${target} (${toReview.length} by the engine).`,
				"For each: read the upstream README and types in the cached workspace, then keep the answer (set `by` to `agent`) or change it",
				"(and say why). Check especially: which exports to offer, each handle's release method (a wrong one leaks or double-closes),",
				"which events are worth Streams, and the error mapping (subclasses before their bases; codes on the catch-all).",
				"Do not edit package/src: run the acceptance commands, which regenerate it.",
				"Follow skills/effectify-recipe/SKILL.md.",
			].join(" "),
			touches: [`${directory}/recipe.json`],
			dependsOn: [],
			acceptance: check,
		},
	];

	// A frontend facade's elements are tested in groups, each in a real Effect UI app in Chrome.
	const elements = (surface.elements ?? []).filter((element) => recipe.methods[element.tag] !== "exclude");
	for (let start = 0; start < elements.length; start += ELEMENTS_PER_UNIT) {
		const slice = elements.slice(start, start + ELEMENTS_PER_UNIT);
		const part = elements.length > ELEMENTS_PER_UNIT ? `-${start / ELEMENTS_PER_UNIT + 1}` : "";
		const file = `${pkg}/test/elements${part}.test.ts`;
		units.push({
			id: `test-elements${part}`,
			title: `Test ${recipe.name}'s elements${part === "" ? "" : ` (part ${part.slice(1)})`}`,
			brief: [
				`Write behaviour tests in ${file}, with their fixtures in ${pkg}/test/fixtures/elements${part}*.{html,ts}, for these`,
				`elements of ${target}: ${slice.map((element) => `<${element.tag}>`).join(", ")}. Each fixture is an Effect UI component`,
				"using the bindings (properties set from its Model, custom events and changes mounts mapped to Messages); each test opens",
				"it with test/support/browser.ts's `fixture` and drives it in Chrome like a user (click, type, keys), asserting the Model",
				"(printed by the fixture) and the element's state, with no page errors. Follow test/form.test.ts in the Web Awesome target",
				"and skills/effectify-ui/SKILL.md. A binding that cannot express what the element needs is reported, not patched.",
			].join(" "),
			touches: [file, `${pkg}/test/fixtures/elements${part}`],
			dependsOn: ["recipe"],
			acceptance: check,
		});
	}

	for (const name of Object.keys(recipe.handles)) {
		const handle = surface.handles[name];
		if (handle === undefined) continue;
		const methods = Object.keys(handle.methods)
			.filter((method) => recipe.methods[`${name}.${method}`] !== "exclude")
			.sort();
		for (let start = 0; start < methods.length; start += METHODS_PER_UNIT) {
			const slice = methods.slice(start, start + METHODS_PER_UNIT);
			const part = methods.length > METHODS_PER_UNIT ? `-${start / METHODS_PER_UNIT + 1}` : "";
			const file = `${pkg}/test/${name.toLowerCase()}${part}.test.ts`;
			units.push({
				id: `test-${name}${part}`,
				title: `Test ${recipe.name}'s ${name}${part === "" ? "" : ` (part ${part.slice(1)})`}`,
				brief: [
					`Write behaviour tests in ${file} for these methods of the ${name} facade of ${target}: ${slice.join(", ")}.`,
					"Run them against the real library (a local service in Docker or a temporary directory, never a paid or remote API),",
					"through the facade's Effects: success values, one failure per error tag the method can produce, scopes closing what",
					`they acquired${recipe.handles[name]?.release === undefined ? "" : ` (${name} is released by ${recipe.handles[name]?.release})`}.`,
					"A test that cannot run without a service is skipped when its environment variable is missing, never faked.",
					"When a method behaves differently from its facade type, do not patch package/src: record the method in recipe.json",
					"(`methods` override or `exclude`, with a decision saying why) and report it.",
					"Follow skills/effectify-tests/SKILL.md.",
				].join(" "),
				touches: [file],
				dependsOn: ["recipe"],
				acceptance: check,
			});
		}
	}

	const derived = [...recipe.derived, ...Object.keys(recipe.methods)];
	if (derived.length > 0) {
		units.push({
			id: "derived",
			title: `Settle ${derived.length} methods the compiler overrode or kept derived`,
			brief: [
				`In ${directory}/recipe.json, \`methods\` and \`derived\` list methods of ${target} where upstream's types and the analyzer`,
				`disagree, or whose generic signature names types upstream does not export: ${derived.slice(0, 40).join(", ")}.`,
				"For each, decide whether the facade's type is right as it is, should be excluded, or needs an engine change",
				"(then open an issue on effectified/engine with a minimal reproduction instead of editing generated code).",
				"Follow skills/effectify-recipe/SKILL.md.",
			].join(" "),
			touches: [`${directory}/recipe.json`],
			dependsOn: ["recipe"],
			acceptance: check,
		});
	}

	units.push({
		id: "docs",
		title: `Document ${recipe.name}`,
		brief: [
			`Write ${directory}/USAGE.md: how to install ${recipe.name} from its GitHub release, one example per service and`,
			"per main handle, and how failures map to tagged errors, every example taken from a passing test.",
			"Follow skills/effectify/SKILL.md (Documentation).",
		].join(" "),
		touches: [`${directory}/USAGE.md`],
		dependsOn: units.filter((unit) => unit.id.startsWith("test-")).map((unit) => unit.id),
		acceptance: [`pnpm effectify test ${recipe.package}`],
	});
	return { target, facade: recipe.name, units };
}

/** The plan as Markdown, for a person or an orchestrator's thread. */
export function planMarkdown(result: Plan): string {
	return [
		`# Plan: ${result.facade} (${result.target})`,
		"",
		`${result.units.length} units. Units whose \`touches\` do not overlap run in parallel once their dependencies are done.`,
		"",
		...result.units.flatMap((unit) => [
			`## ${unit.id}: ${unit.title}`,
			"",
			unit.brief,
			"",
			`- touches: ${unit.touches.map((path) => `\`${path}\``).join(", ")}`,
			`- depends on: ${unit.dependsOn.length === 0 ? "nothing" : unit.dependsOn.join(", ")}`,
			`- acceptance: ${unit.acceptance.map((command) => `\`${command}\``).join(", ")}`,
			"",
		]),
	].join("\n");
}
