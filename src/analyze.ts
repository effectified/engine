// The analyzer: reads an installed package's types with TypeScript 7's checker (the native compiler, through its
// sync API) and returns its surface. It starts at the package's entry, and follows every call's result to the objects
// the library hands out (handles), up to a depth, so a facade covers what a program can reach from the entry.

import { Effect, Schema } from "effect";
import { SyntaxKind } from "typescript/unstable/ast";
import {
	API,
	type Checker,
	type Emitter,
	NodeBuilderFlags,
	SignatureKind,
	SymbolFlags,
	type Signature as TsSignature,
	type Symbol as TsSymbol,
	type Type,
	type TypeReference,
} from "typescript/unstable/sync";
import type { Export, Handle, Signature, Surface, Trait } from "./surface.ts";
import type { Workspace } from "./workspace.ts";

/** Reading the types failed. */
export class AnalyzeError extends Schema.TaggedError<AnalyzeError>()("AnalyzeError", {
	target: Schema.String,
	reason: Schema.String,
}) {}

/** Reads the surface of an installed target. The native checker runs for the duration of the call. */
export const analyze = Effect.fn("analyze")(function* (workspace: Workspace) {
	const label = `${workspace.target.package}@${workspace.target.version}`;
	const fail = (cause: unknown) => new AnalyzeError({ target: label, reason: (cause instanceof Error ? cause.message : String(cause)).split("\n")[0] ?? "" });
	return yield* Effect.acquireUseRelease(
		Effect.try({ try: () => new API({ cwd: workspace.directory }), catch: fail }),
		(api) => Effect.try({ try: () => read(api, workspace), catch: fail }),
		(api) => Effect.sync(() => api.close()),
	);
});

/**
 * `TypeFormatFlags.NoTruncation` (the API exports no `TypeFormatFlags`; its bit is the same as `NodeBuilderFlags`'):
 * a truncated type prints `...`, which no generated signature can compile.
 */
const NO_TRUNCATION = NodeBuilderFlags.NoTruncation;

/** How deep the analyzer follows results from the entry; deeper objects stay upstream objects in the facade. */
const MAX_DEPTH = 4;

/** Method names that release what they are called on. */
const RELEASE_NAMES = new Set(["close", "quit", "disconnect", "destroy", "end", "dispose", "stop", "shutdown", "release", "terminate"]);

function read(api: API, workspace: Workspace): Surface {
	const project = api.updateSnapshot({ openProjects: [workspace.tsconfig] }).getProjects()[0];
	if (project === undefined) throw new Error(`no project for ${workspace.tsconfig}`);
	const checker = project.checker;
	const file = project.program.getSourceFile(workspace.entry);
	if (file === undefined) throw new Error(`the entry ${workspace.entry} is not in the program`);
	const local = checker.getSymbolAtPosition(workspace.entry, file.text.indexOf("lib"));
	if (local === undefined) throw new Error("the entry's `lib` has no symbol");
	// getAliasedSymbol is only defined on aliases: the native checker panics on any other symbol.
	const moduleSymbol = (local.flags & SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(local) : local;
	const moduleExports = checker.getExportsOfModule(moduleSymbol);
	const typeExports = moduleExports.filter((symbol) => (symbol.flags & SymbolFlags.Value) === 0).map((symbol) => symbol.name);
	const exported = new Set(moduleExports.map((symbol) => symbol.name));
	const namespaceType = checker.getTypeOfSymbol(local);
	if (namespaceType === undefined) throw new Error("the entry's `lib` has no type");

	// A package that re-exports another (puppeteer re-exports puppeteer-core) owns the packages its exports are
	// declared in: their declarations are the library's API too.
	const owned = new Set([workspace.target.package, workspace.target.types.package]);
	for (const symbol of moduleExports) {
		const declared = (symbol.flags & SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
		for (const declaration of declared.declarations) {
			const name = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(declaration.path)?.[1];
			if (name !== undefined && !name.startsWith("@types/node") && name !== "typescript") owned.add(name);
		}
	}
	const reader = new SurfaceReader(checker, project.emitter, [...owned], exported);
	const exports: Array<Export> = [];
	for (const symbol of checker.getPropertiesOfType(namespaceType)) {
		const item = reader.readExport(symbol);
		if (item !== undefined) exports.push(item);
	}
	reader.drain();
	const callableDefault = exports.some((item) => item.name === "default" && item.kind === "function");
	return {
		package: workspace.target.package,
		version: workspace.target.version,
		types: workspace.target.types,
		entry: callableDefault && !exports.some((item) => item.kind === "function" && item.name !== "default") ? "callable" : "named",
		exports: exports.filter((item) => !(item.name === "default" && item.kind === "value")),
		handles: Object.fromEntries(reader.handles),
		typeExports,
	};
}

/** Reads exports and the handles reachable from them, breadth first. */
class SurfaceReader {
	readonly handles = new Map<string, Handle>();
	private readonly queue: Array<{ readonly type: Type; readonly name: string; readonly typeRef: string; readonly depth: number }> = [];
	private readonly checker: Checker;
	private readonly emitter: Emitter;
	/** `/node_modules/<package>/` of each package whose declarations are the library's API. */
	private readonly roots: ReadonlyArray<string>;
	private readonly exported: ReadonlySet<string>;

	constructor(checker: Checker, emitter: Emitter, owned: ReadonlyArray<string>, exported: ReadonlySet<string>) {
		this.checker = checker;
		this.emitter = emitter;
		this.roots = owned.map((name) => `/node_modules/${name}/`);
		this.exported = exported;
	}

	/** One value export: a function, a class (its instances are a handle), or any other value. */
	readExport(symbol: TsSymbol): Export | undefined {
		const type = this.checker.getTypeOfSymbol(symbol);
		if (type === undefined) return undefined;
		const reference = `typeof Upstream.${symbol.name}`;
		// A value both callable and constructible (sharp) is used as a factory: it is read as a function.
		const calls = this.checker.getSignaturesOfType(type, SignatureKind.Call);
		if (calls.length > 0) {
			return { kind: "function", name: symbol.name, signatures: calls.map((signature) => this.readSignature(signature, reference, 0)) };
		}
		const constructors = this.checker.getSignaturesOfType(type, SignatureKind.Construct);
		if (constructors.length > 0) {
			const instance = this.checker.getReturnTypeOfSignature(constructors[0] as TsSignature);
			const error = instance !== undefined && this.isError(instance);
			const handle = instance === undefined || error ? undefined : this.handleOf(instance, `InstanceType<${reference}>`, 0);
			const base = instance === undefined ? undefined : this.baseClass(instance);
			return {
				kind: "class",
				name: symbol.name,
				handle: handle ?? symbol.name,
				constructors: constructors.map((signature) => this.readSignature(signature, reference, 0)),
				error,
				...(base === undefined ? {} : { base }),
			};
		}
		return { kind: "value", name: symbol.name, type: this.print(type).slice(0, 200) };
	}

	/** Reads every queued handle, which may queue more, down to MAX_DEPTH. */
	drain(): void {
		for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
			if (this.handles.has(next.name)) continue;
			// Reserve the name first: a handle's methods may return the handle itself.
			this.handles.set(next.name, { name: next.name, typeRef: next.typeRef, methods: {}, properties: {}, events: [], releases: [] });
			this.handles.set(next.name, this.readHandle(next.type, next.name, next.typeRef, next.depth));
		}
	}

	private readHandle(type: Type, name: string, typeRef: string, depth: number): Handle {
		const methods: Record<string, ReadonlyArray<Signature>> = {};
		const properties: Record<string, { readonly type: string; readonly handle?: string }> = {};
		let events: ReadonlyArray<string> = [];
		for (const property of this.checker.getPropertiesOfType(type)) {
			if (property.name.startsWith("_") || property.name.startsWith("#") || property.name.startsWith("__@")) continue;
			// Members a handle inherits from outside the target (Node's streams, EventEmitter) are not the library's API,
			// and neither are its private and protected ones (the checker lists them as properties too).
			if (!this.isTargetDeclaration(property) || !this.isPublic(property)) continue;
			const propertyType = this.checker.getTypeOfSymbol(property);
			if (propertyType === undefined) continue;
			const signatures = this.checker.getSignaturesOfType(propertyType, SignatureKind.Call);
			const via = `${typeRef}[${JSON.stringify(property.name)}]`;
			if (signatures.length === 0) {
				const handle = this.handleOf(propertyType, via, depth + 1);
				properties[property.name] = { type: this.print(propertyType).slice(0, 300), ...(handle === undefined ? {} : { handle }) };
				continue;
			}
			methods[property.name] = signatures.map((signature) => this.readSignature(signature, via, depth + 1));
			if (property.name === "on") events = this.eventNames(signatures);
		}
		return { name, typeRef, methods, properties, events, releases: Object.keys(methods).filter((method) => RELEASE_NAMES.has(method)) };
	}

	/** A signature with its traits; a handle it produces is queued for reading. */
	private readSignature(signature: TsSignature, via: string, depth: number): Signature {
		const checker = this.checker;
		const declared = signature.getParameters();
		const parameters = declared.map((parameter, index) => {
			const type = checker.getTypeOfSymbol(parameter);
			// Optionality is on the declaration (`?`, a default value), not on the parameter's symbol.
			const node = parameter.valueDeclaration?.resolve() as { readonly questionToken?: unknown; readonly initializer?: unknown } | undefined;
			return {
				name: parameter.name,
				type: type === undefined ? "unknown" : this.print(type),
				optional: node?.questionToken !== undefined || node?.initializer !== undefined || (parameter.flags & SymbolFlags.Optional) !== 0,
				rest: signature.hasRestParameter && index === declared.length - 1,
			};
		});
		const typeParameters = signature.getTypeParameters().length === 0 ? undefined : this.typeParameterList(signature);
		const returnType = checker.getReturnTypeOfSignature(signature);
		const returns = returnType === undefined ? "unknown" : this.print(returnType);
		const traits: Array<Trait> = [];
		if (parameters.some((parameter) => parameter.type.includes("AbortSignal"))) traits.push("signal");
		const resolved = returnType === undefined ? undefined : this.promised(returnType);
		const produced = resolved ?? returnType;
		const handle = produced === undefined ? undefined : this.handleOf(produced, `Awaited<ReturnType<${via}>>`, depth);
		// A promise first; then a handle, even an iterable one (sharp's `Sharp` is a Duplex); then an iterable.
		if (resolved !== undefined) traits.push("async");
		else if (returns === "this") traits.push("returns-this");
		else if (handle === undefined && returnType !== undefined && this.isAsyncIterable(returnType)) traits.push("stream");
		else if (returns === "void" && this.lastIsFunction(signature)) traits.push("callback");
		else traits.push("sync");
		return {
			...(typeParameters === undefined ? {} : { typeParameters }),
			parameters,
			trailingCallback: this.lastIsFunction(signature),
			returns,
			...(resolved === undefined ? {} : { resolves: this.print(resolved) }),
			...(handle === undefined ? {} : { handle }),
			traits,
		};
	}

	/**
	 * The type a promise resolves to, or undefined when `type` is no promise. Any thenable counts: libraries return
	 * chainable promises (simple-git's `Response<T>` is `SimpleGit & Promise<T>`), read through their `then`.
	 */
	private promised(type: Type): Type | undefined {
		const symbol = type.getSymbol();
		if ((symbol?.name === "Promise" || symbol?.name === "PromiseLike") && type.isTypeReference()) {
			return this.checker.getTypeArguments(type as TypeReference)[0];
		}
		const then = this.checker.getPropertyOfType(type, "then");
		const thenType = then === undefined ? undefined : this.checker.getTypeOfSymbol(then);
		const thenSignature = thenType === undefined ? undefined : this.checker.getSignaturesOfType(thenType, SignatureKind.Call)[0];
		const onFulfilled = thenSignature?.getParameters()[0];
		const onFulfilledType = onFulfilled === undefined ? undefined : this.checker.getTypeOfSymbol(onFulfilled);
		if (onFulfilledType === undefined) return undefined;
		const callback = this.checker.getSignaturesOfType(this.checker.getNonNullableType(onFulfilledType) ?? onFulfilledType, SignatureKind.Call)[0];
		const value = callback?.getParameters()[0];
		return value === undefined ? undefined : this.checker.getTypeOfSymbol(value);
	}

	/**
	 * A type as text, untruncated. A type upstream does not export prints as `import("<path>")`: the path is made
	 * package-relative, so a surface names no directory of the machine that read it and drift compares like for like.
	 */
	private print(type: Type): string {
		return this.checker.typeToString(type, undefined, NO_TRUNCATION).replace(/import\("[^"]*\/node_modules\//g, 'import("');
	}

	/**
	 * A generic signature's type parameter list as upstream declares it, defaults and constraints included: TypeScript 7
	 * prints the signature's declaration (`<T = DefaultLogFields>(options?: ...): ...`), and the list is its prefix.
	 */
	private typeParameterList(signature: TsSignature): string | undefined {
		let printed = "";
		try {
			const node = this.checker.signatureToSignatureDeclaration(signature, SyntaxKind.MethodSignature, undefined, NodeBuilderFlags.NoTruncation);
			printed = node === undefined ? "" : this.emitter.printNode(node).replace(/\s+/g, " ").trim();
		} catch {
			// The unstable API's client fails to decode some printed nodes ("Offset is outside the bounds of the
			// DataView"): the signature then keeps no list, and the facade keeps the method on its derived types.
			return undefined;
		}
		if (!printed.startsWith("<")) return undefined;
		let depth = 0;
		for (let index = 0; index < printed.length; index++) {
			const char = printed[index];
			if (char === "<") depth++;
			else if (char === ">" && printed[index - 1] !== "=") depth--;
			if (depth === 0) return printed.slice(1, index);
		}
		return undefined;
	}

	private isAsyncIterable(type: Type): boolean {
		return this.checker.getPropertiesOfType(type).some((property) => property.name.includes("asyncIterator"));
	}

	private isError(type: Type): boolean {
		const names = new Set(this.checker.getPropertiesOfType(type).map((property) => property.name));
		return names.has("message") && names.has("name") && names.has("stack");
	}

	private lastIsFunction(signature: TsSignature): boolean {
		const last = signature.getParameters().at(-1);
		const type = last === undefined ? undefined : this.checker.getTypeOfSymbol(last);
		return type !== undefined && this.checker.getSignaturesOfType(this.checker.getNonNullableType(type) ?? type, SignatureKind.Call).length > 0;
	}

	/**
	 * The handle `type` is, queued for reading: an object type declared by the target with at least one method. An
	 * exported type is named `Upstream.<Name>`; any other is named by how it is reached (`via`).
	 */
	private handleOf(type: Type, via: string, depth: number): string | undefined {
		const symbol = type.getSymbol();
		if (symbol === undefined || depth > MAX_DEPTH || !this.isTargetDeclaration(symbol)) return undefined;
		if ((symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) === 0) return undefined;
		if (this.isError(type)) return undefined;
		const hasMethod = this.checker
			.getPropertiesOfType(type)
			.some((property) => this.checker.getSignaturesOfType(this.checker.getTypeOfSymbol(property) ?? type, SignatureKind.Call).length > 0);
		if (!hasMethod) return undefined;
		const typeRef = this.exported.has(symbol.name) ? `Upstream.${symbol.name}${this.anyArguments(type)}` : via;
		this.enqueue(type, symbol.name, typeRef, depth);
		return symbol.name;
	}

	/** `<any, ...>` for a generic type named without its arguments, so `Upstream.Name<...>` is always a valid type. */
	private anyArguments(type: Type): string {
		const declared = type.getSymbol();
		const declaredType = declared === undefined ? undefined : this.checker.getDeclaredTypeOfSymbol(declared);
		const parameters = declaredType !== undefined && declaredType.isClassOrInterface() ? declaredType.getTypeParameters() : [];
		return parameters.length === 0 ? "" : `<${parameters.map(() => "any").join(", ")}>`;
	}

	private enqueue(type: Type, name: string, typeRef: string, depth: number): void {
		if (!this.handles.has(name)) this.queue.push({ type, name, typeRef, depth });
	}

	/** The class `instance` extends, when the target declares it: the hierarchy of its errors, read from its types. */
	private baseClass(instance: Type): string | undefined {
		const declared = instance.getSymbol();
		const type = declared === undefined ? undefined : this.checker.getDeclaredTypeOfSymbol(declared);
		const base = type !== undefined && type.isClassOrInterface() ? this.checker.getBaseTypes(type)[0]?.getSymbol() : undefined;
		return base !== undefined && this.isTargetDeclaration(base) ? base.name : undefined;
	}

	private isPublic(symbol: TsSymbol): boolean {
		return symbol.declarations.every((declaration) => {
			// A resolved declaration is a class member or a signature; only members carry `modifiers`.
			const node = declaration.resolve() as { readonly modifiers?: ReadonlyArray<{ readonly kind: SyntaxKind }> } | undefined;
			return !(node?.modifiers ?? []).some((modifier) => modifier.kind === SyntaxKind.PrivateKeyword || modifier.kind === SyntaxKind.ProtectedKeyword);
		});
	}

	private isTargetDeclaration(symbol: TsSymbol): boolean {
		return symbol.declarations.some((declaration) => this.roots.some((root) => declaration.path.includes(root)));
	}

	/** The event names an emitter's `on` names in its types: literal names, unions of them, or the keys of a listener map. */
	private eventNames(signatures: ReadonlyArray<TsSignature>): ReadonlyArray<string> {
		const names = new Set<string>();
		for (const signature of signatures) {
			const first = signature.getParameters()[0];
			const type = first === undefined ? undefined : this.checker.getTypeOfSymbol(first);
			if (type !== undefined) for (const name of this.literalNames(type, 0)) names.add(name);
		}
		return [...names].sort();
	}

	private literalNames(type: Type, depth: number): ReadonlyArray<string> {
		if (depth > 3) return [];
		if (type.isStringLiteralType()) return [String(type.value)];
		if (type.isUnionType()) return (type.getTypes() ?? []).flatMap((member) => this.literalNames(member, depth + 1));
		if (type.isTypeParameter()) {
			const constraint = this.checker.getConstraintOfTypeParameter(type);
			return constraint === undefined ? [] : this.literalNames(constraint, depth + 1);
		}
		if (type.isIndexType()) {
			return this.checker
				.getPropertiesOfType(type.getTarget())
				.map((property) => property.name)
				.filter((name) => !name.startsWith("__@"));
		}
		return [];
	}
}
