// The settable properties of a web-component library's elements as its own types declare them: each tag's
// `HTMLElementTagNameMap` entry, read with TypeScript 7's checker. A manifest lists what one class declares, and few
// tools record what it inherits through mixins (Material's `disabled`); the types have it all, and say which
// properties are getters only. Tags upstream's types do not name keep the manifest's list.

import { Effect, FileSystem, Path } from "effect";
import { SyntaxKind } from "typescript/unstable/ast";
import { API, type Checker, SignatureKind, SymbolFlags, type Symbol as TsSymbol, type Type, type TypeReference } from "typescript/unstable/sync";
import type { Documented, Element } from "./elements.ts";
import type { Workspace } from "./workspace.ts";

/**
 * The elements with their properties read from upstream's types where `HTMLElementTagNameMap` names their tag, less
 * the members the manifest knows as the element's own state (no attribute, no description); a member the manifest
 * does not know (inherited through a mixin it did not record) stays. When the types cannot be read, the elements
 * stay as the manifest gave them.
 */
export const typedElements = Effect.fn("typedElements")(function* (workspace: Workspace, elements: ReadonlyArray<Element>, documented: Documented) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const entry = path.join(workspace.directory, "elements.ts");
	const tsconfig = path.join(workspace.directory, "tsconfig.elements.json");
	// An element's map entry is declared by the module that defines it: the program imports every one.
	const definitions = [...new Set(elements.map((element) => element.definition))];
	yield* fs.writeFileString(entry, `${definitions.map((definition) => `import ${JSON.stringify(definition)};`).join("\n")}\nexport {};\n`);
	// Trust boundary: the workspace's tsconfig is the engine's own file, read as untyped JSON.
	const base: { readonly compilerOptions?: unknown } = JSON.parse(yield* fs.readFileString(workspace.tsconfig));
	yield* fs.writeFileString(tsconfig, `${JSON.stringify({ compilerOptions: base.compilerOptions, files: ["elements.ts"] }, null, 2)}\n`);
	const typed = yield* Effect.acquireUseRelease(
		Effect.try(() => new API({ cwd: workspace.directory })),
		(api) => Effect.try(() => readProperties(api, tsconfig, entry, elements, `/node_modules/${workspace.target.package}/`)),
		(api) => Effect.sync(() => api.close()),
	).pipe(Effect.orElseSucceed(() => new Map<string, ReadonlyArray<string>>()));
	return elements.map((element) => {
		const properties = typed.get(element.tag);
		const known = documented.get(element.tag);
		return properties === undefined ? element : { ...element, properties: properties.filter((property) => known?.get(property) !== false) };
	});
});

function readProperties(api: API, tsconfig: string, entry: string, elements: ReadonlyArray<Element>, own: string): ReadonlyMap<string, ReadonlyArray<string>> {
	const project = api.updateSnapshot({ openProjects: [tsconfig] }).getProjects()[0];
	const file = project?.program.getSourceFile(entry);
	if (project === undefined || file === undefined) return new Map();
	const checker = project.checker;
	const declared = (name: string) => {
		const symbol = checker.resolveName(name, SymbolFlags.Interface, file);
		return symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
	};
	const tagMap = declared("HTMLElementTagNameMap");
	const htmlElement = declared("HTMLElement");
	if (tagMap === undefined || htmlElement === undefined) return new Map();
	const inherited = new Set(checker.getPropertiesOfType(htmlElement).map((property) => property.name));
	const found = new Map<string, ReadonlyArray<string>>();
	for (const element of elements) {
		const entrySymbol = checker.getPropertyOfType(tagMap, element.tag);
		const type = entrySymbol === undefined ? undefined : checker.getTypeOfSymbol(entrySymbol);
		if (type === undefined) continue;
		found.set(
			element.tag,
			checker
				.getPropertiesOfType(type)
				// The library's own: what its elements inherit from their framework (Lit's `hasUpdated`) is not their API.
				.filter((property) => !inherited.has(property.name) && property.declarations.some((declaration) => declaration.path.includes(own)) && settable(checker, property))
				.map((property) => property.name)
				.sort(),
		);
	}
	return found;
}

/** A public, writable field or accessor holding data: no method, no function, no node, nothing private. */
function settable(checker: Checker, property: TsSymbol): boolean {
	const name = property.name;
	if (name.startsWith("_") || name.startsWith("#") || name.startsWith("__@")) return false;
	if ((property.flags & SymbolFlags.Method) !== 0) return false;
	if ((property.flags & SymbolFlags.GetAccessor) !== 0 && (property.flags & SymbolFlags.SetAccessor) === 0) return false;
	// Upstream's own word that a public member is not its API.
	if (checker.getJsDocTagsOfSymbol(property).some((tag) => ["internal", "private", "ignore"].includes(tag.name))) return false;
	for (const declaration of property.declarations) {
		// A resolved declaration is a class member or a signature; only members carry `modifiers`.
		const node = declaration.resolve() as { readonly modifiers?: ReadonlyArray<{ readonly kind: SyntaxKind }> } | undefined;
		const modifiers = node?.modifiers ?? [];
		if (modifiers.some((modifier) => [SyntaxKind.ReadonlyKeyword, SyntaxKind.PrivateKeyword, SyntaxKind.ProtectedKeyword, SyntaxKind.StaticKeyword].includes(modifier.kind))) {
			return false;
		}
	}
	const type = checker.getTypeOfSymbol(property);
	if (type === undefined) return false;
	return checker.getSignaturesOfType(checker.getNonNullableType(type) ?? type, SignatureKind.Call).length === 0 && !holdsNode(checker, type, 0);
}

/** Whether a value of `type` is, or holds, a DOM node (another element, a list's items): the view owns those. */
function holdsNode(checker: Checker, type: Type, depth: number): boolean {
	if (depth > 3) return false;
	if (type.isUnionType()) return (type.getTypes() ?? []).some((member) => holdsNode(checker, member, depth + 1));
	if (checker.getPropertyOfType(type, "nodeType") !== undefined) return true;
	return type.isTypeReference() && checker.getTypeArguments(type as TypeReference).some((argument) => holdsNode(checker, argument, depth + 1));
}
