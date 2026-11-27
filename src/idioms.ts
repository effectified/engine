// The idioms of the Effect-native standard (skills/effectify-engine/SKILL.md, "The standard") that a syntax rule can
// see, as an oxlint JS plugin (ESLint's rule API); `effectNative` runs them on every facade's sources. A site that must
// break a rule says why in the comment lines right above it: `// idiom-allow <rule>: <why>`; the rule reads that marker
// itself, so the reason is required and an unused marker costs nothing. The plugin has no imports and is built with the
// engine (`dist/idioms.js`): oxlint loads it through Node, which strips no types under node_modules.

/** A node of oxlint's ESTree AST, read only through the fields these rules need. */
interface Node {
	readonly type: string;
	readonly parent: Node | null;
	readonly loc: { readonly start: { readonly line: number } };
	readonly [field: string]: unknown;
}

/** What a rule's visitor is given: oxlint's ESLint-compatible context, as far as these rules use it. */
interface Context {
	readonly sourceCode: { readonly lines: ReadonlyArray<string> };
	report(diagnostic: { readonly node: Node; readonly message: string }): void;
}

/** One rule: its description, and the visitor that finds its sites. */
interface Rule {
	readonly meta: { readonly type: "suggestion"; readonly docs: { readonly description: string } };
	readonly create: (context: Context) => Record<string, (node: Node) => void>;
}

/**
 * This module's file, for oxlint's `jsPlugins`: the source in a checkout, the build in a release. Node's own path of
 * the module, not its URL's `pathname`, which keeps `%20` for a space.
 */
export const IDIOMS_PLUGIN = import.meta.filename;

const EFFECT_FN =
	"A function that returns Effect.gen is Effect.fn('<Module>.<name>')(function* (...) { ... }): a span and a stack frame per call. A per-item hot path uses Effect.fnUntraced.";

const SCHEMAS_OF_IDS = new Set(["String", "Number", "NonEmptyString", "Finite", "Int"]);

/** The idiom rules, by name: the name is also what `idiom-allow` names, and oxlint's rule is `idioms/<name>`. */
const rules: Record<string, Rule> = {
	// A function declaration or a method that returns Effect.gen is Effect.fn.
	"effect-fn": rule(
		"A function or method that returns Effect.gen is Effect.fn.",
		"effect-fn",
		EFFECT_FN,
		(report) => ({
			ReturnStatement(node) {
				if (!isEffectGen(node.argument)) return;
				const owner = enclosingFunction(node);
				if (owner?.type === "FunctionDeclaration") report(owner);
				else if (owner?.type === "FunctionExpression" && isMethod(owner.parent)) report(owner.parent);
			},
		}),
	),
	// An arrow bound to a name or a property that returns Effect.gen is Effect.fn. An arrow anywhere inside a call's
	// arguments (a combinator's callback, a service built inline) is left alone.
	"effect-fn-arrow": rule(
		"An arrow function that returns Effect.gen is Effect.fn.",
		"effect-fn-arrow",
		EFFECT_FN,
		(report) => ({
			ArrowFunctionExpression(node) {
				if (insideCallArguments(node)) return;
				if (isEffectGen(node.body) || returnsEffectGen(node)) report(node);
			},
		}),
	),
	// Effect.fn takes the span name first.
	"effect-fn-name": rule(
		"Effect.fn names its span.",
		"effect-fn-name",
		"Name the span: Effect.fn('<Module>.<name>')(function* (...) { ... }). Untraced on purpose: Effect.fnUntraced.",
		(report) => ({
			CallExpression(node) {
				// Trust boundary: oxlint's AST, whose `arguments` of a call is a node list.
				const [first] = node.arguments as ReadonlyArray<Node>;
				if (isMember(node.callee, "Effect", "fn") && first?.type === "FunctionExpression") report(node);
			},
		}),
	),
	// A choice over a tagged union is Match, or the union schema's own .match. A syntax rule sees no types, so it takes
	// such a choice by how one is written: a switch on a read of `_tag`, Effect's tag, a name no ordinary field has. A
	// switch on any other field is left alone: it is as often no choice over a union (an HTTP response's numeric
	// `status`), and a syntax rule cannot tell which.
	match: rule(
		"A choice over a tagged union is Match.",
		"match",
		"Choose with Match (Match.valueTags, Match.tagsExhaustive, Match.value(...).pipe(Match.tag(...), Match.exhaustive)) or the union schema's .match. On a per-item hot path: // idiom-allow match: <why>.",
		(report) => ({
			SwitchStatement(node) {
				if (readsTag(node.discriminant as Node)) report(node);
			},
		}),
	),
	// A schema field named for an id or a key is a branded schema.
	"branded-id": rule(
		"An id or key field is a branded schema.",
		"branded-id",
		"An id or key is a branded schema (Schema.String.pipe(Schema.brand('<Name>')), or the owner's exported one), so ids of different things cannot mix.",
		(report) => ({
			Property(node) {
				const key = node.key as Node;
				if (node.method === true || node.shorthand === true || key.type !== "Identifier") return;
				if (!/^[A-Za-z]*(Id|Key)$/.test(key.name as string)) return;
				const value = node.value as Node;
				if (isMember(value, "Schema", undefined) && SCHEMAS_OF_IDS.has((value.property as Node).name as string))
					report(node);
			},
		}),
	),
};

/** The idiom rules as an oxlint plugin named `idioms`. */
export default { meta: { name: "idioms" }, rules };

/** The names of the idiom rules. */
export const IDIOM_RULES: ReadonlyArray<string> = Object.keys(rules);

/** A rule whose visitor reports through `report`, which skips a site with `idiom-allow <name>: <why>` above it. */
function rule(
	description: string,
	name: string,
	message: string,
	visit: (report: (node: Node) => void) => Record<string, (node: Node) => void>,
): Rule {
	return {
		meta: { type: "suggestion", docs: { description } },
		create: (context) =>
			visit((node) => {
				if (!allowed(context.sourceCode.lines, node.loc.start.line, name)) context.report({ node, message });
			}),
	};
}

/** Whether the comment lines right above line `line` (1-based) hold `idiom-allow <name>: <a reason>`. */
function allowed(lines: ReadonlyArray<string>, line: number, name: string): boolean {
	const marker = new RegExp(`\\bidiom-allow ${name}: \\S`);
	for (let index = line - 2; index >= 0; index--) {
		const text = (lines[index] ?? "").trim();
		if (!(text.startsWith("//") || text.startsWith("/*") || text.startsWith("*"))) return false;
		if (marker.test(text)) return true;
	}
	return false;
}

/** Whether `node` is a call of `Effect.gen`. */
function isEffectGen(node: unknown): boolean {
	const call = node as Node | null | undefined;
	return call?.type === "CallExpression" && isMember(call.callee, "Effect", "gen");
}

/**
 * Whether `node` reads an object's `_tag` (`value._tag`, `value?._tag`, `value["_tag"]`, `value!._tag`,
 * `value._tag as Tag`, `<Tag>value._tag`), seen through optional chaining and TypeScript's non-null and type
 * assertions, the angle-bracket form too.
 */
function readsTag(node: Node): boolean {
	const read = unwrapped(node);
	if (read.type !== "MemberExpression") return false;
	const property = read.property as Node;
	const name = read.computed === true ? (property.type === "Literal" ? property.value : undefined) : property.name;
	return name === "_tag";
}

/** The expressions TypeScript and optional chaining wrap a member read in, unwrapped. */
const WRAPPERS = new Set([
	"ChainExpression",
	"TSNonNullExpression",
	"TSAsExpression",
	"TSTypeAssertion",
	"TSSatisfiesExpression",
	"ParenthesizedExpression",
]);

/** `node` without the wrappers of `WRAPPERS` around it. */
function unwrapped(node: Node): Node {
	let current = node;
	while (WRAPPERS.has(current.type)) current = current.expression as Node;
	return current;
}

/** Whether `node` is `<object>.<property>` (any property when `property` is undefined). */
function isMember(node: unknown, object: string, property: string | undefined): boolean {
	const member = node as Node;
	if (member.type !== "MemberExpression" || member.computed === true) return false;
	const target = member.object as Node;
	const name = member.property as Node;
	return target.type === "Identifier" && target.name === object && (property === undefined || name.name === property);
}

/** The nearest function around `node`: a declaration, an expression or an arrow. */
function enclosingFunction(node: Node): Node | undefined {
	for (let current = node.parent; current !== null; current = current.parent) {
		if (
			current.type === "FunctionDeclaration" ||
			current.type === "FunctionExpression" ||
			current.type === "ArrowFunctionExpression"
		)
			return current;
	}
	return undefined;
}

/** Whether `node` is a class method or an object method (not a getter, setter or constructor). */
function isMethod(node: Node | null): node is Node {
	if (node?.type === "MethodDefinition") return node.kind === "method";
	return node?.type === "Property" && node.method === true;
}

/** Whether `arrow`'s block body returns Effect.gen itself, not from a function nested in it. */
function returnsEffectGen(arrow: Node): boolean {
	const body = arrow.body as Node;
	if (body.type !== "BlockStatement") return false;
	let found = false;
	const visit = (node: Node): void => {
		if (found) return;
		if (node.type === "ReturnStatement" && isEffectGen(node.argument)) {
			found = true;
			return;
		}
		for (const [field, value] of Object.entries(node)) {
			if (field === "parent") continue;
			for (const child of Array.isArray(value) ? value : [value]) {
				// Trust boundary: oxlint's AST, whose fields hold nodes, node lists and plain values.
				const next = child as Node | null;
				if (next === null || typeof next !== "object" || typeof next.type !== "string") continue;
				if (next.type === "FunctionExpression" || next.type === "ArrowFunctionExpression") continue;
				visit(next);
			}
		}
	};
	visit(body);
	return found;
}

/** Whether `node` lies anywhere inside the arguments of a call or a `new`. */
function insideCallArguments(node: Node): boolean {
	for (let child = node, parent = node.parent; parent !== null; child = parent, parent = parent.parent) {
		const isCall = parent.type === "CallExpression" || parent.type === "NewExpression";
		if (isCall && (parent.arguments as ReadonlyArray<Node>).includes(child)) return true;
	}
	return false;
}
