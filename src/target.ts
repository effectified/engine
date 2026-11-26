// What to effectify: a GitHub repository URL or an npm package, resolved to one published version of one package and
// the package its types come from. A facade is built against published packages, so a repository is resolved to the
// package it publishes.

import { Effect, Schema } from "effect";
import { HttpClient } from "effect/http";

/** A target as the user names it. */
export type TargetInput =
	| { readonly kind: "npm"; readonly name: string; readonly version: string }
	| { readonly kind: "github"; readonly owner: string; readonly repo: string; readonly ref: string; readonly path: string };

/** A resolved target: the exact version to wrap and where its types are. */
export interface Target {
	readonly package: string;
	readonly version: string;
	readonly repository: string | undefined;
	readonly types: { readonly from: "bundled" | "definitely-typed"; readonly package: string; readonly version: string };
}

/** Resolution failed: the input names no published package, or nothing with types. */
export class TargetError extends Schema.TaggedError<TargetError>()("TargetError", {
	input: Schema.String,
	reason: Schema.String,
}) {}

/** Reads `https://github.com/o/r[/tree/ref/path]`, `github:o/r`, `name`, `name@version` or `@scope/name@version`. */
export function parseTarget(input: string): TargetInput {
	const github = /^(?:https?:\/\/github\.com\/|github:)([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(input);
	if (github !== null) {
		const [, owner = "", repo = "", ref = "HEAD", path = ""] = github;
		return { kind: "github", owner, repo, ref, path };
	}
	const at = input.lastIndexOf("@");
	return at > 0 ? { kind: "npm", name: input.slice(0, at), version: input.slice(at + 1) } : { kind: "npm", name: input, version: "latest" };
}

/** Resolves a target to an exact published version and its types. */
export const resolveTarget = Effect.fn("resolveTarget")(function* (input: string) {
	const parsed = parseTarget(input);
	const name = parsed.kind === "npm" ? parsed.name : yield* packageOfRepository(input, parsed);
	const version = parsed.kind === "npm" ? parsed.version : "latest";
	const manifest = yield* registry(input, `${name}/${version}`);
	const resolved = String(manifest["version"]);
	const types = hasTypes(manifest) ? { from: "bundled" as const, package: name, version: resolved } : yield* typesPackage(input, name, resolved);
	return { package: name, version: resolved, repository: repositoryUrl(manifest), types } satisfies Target;
});

/** The package a repository publishes: its root manifest's name, or for a monorepo the package named like the repo. */
const packageOfRepository = Effect.fn("packageOfRepository")(function* (
	input: string,
	github: Extract<TargetInput, { kind: "github" }>,
) {
	const path = github.path === "" ? "" : `${github.path}/`;
	const root = yield* fetchJson(input, `https://raw.githubusercontent.com/${github.owner}/${github.repo}/${github.ref}/${path}package.json`);
	const isWorkspaceRoot = root["private"] === true || root["workspaces"] !== undefined;
	if (!isWorkspaceRoot && typeof root["name"] === "string") return root["name"];
	// A monorepo root publishes nothing; its main package is usually published under the repository's name. It is
	// taken only when its manifest points back at this repository.
	const candidate = yield* registry(input, `${github.repo}/latest`).pipe(Effect.option);
	if (candidate._tag === "Some" && (repositoryUrl(candidate.value) ?? "").includes(`${github.owner}/${github.repo}`)) {
		return github.repo;
	}
	return yield* new TargetError({
		input,
		reason: "the repository root is a workspace; name the package directory (…/tree/<ref>/packages/<name>)",
	});
});

/** The DefinitelyTyped package of `name`, when the package ships no types of its own. */
const typesPackage = Effect.fn("typesPackage")(function* (input: string, name: string, version: string) {
	const typesName = `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;
	const manifest = yield* registry(input, `${typesName}/latest`).pipe(Effect.option);
	// No DefinitelyTyped package: the package's own `.d.ts` files beside its JavaScript (as @material/web ships them,
	// with no `types` field) are found by TypeScript itself.
	if (manifest._tag === "None") return { from: "bundled" as const, package: name, version };
	return { from: "definitely-typed" as const, package: typesName, version: String(manifest.value["version"]) };
});

function hasTypes(manifest: Record<string, unknown>): boolean {
	return manifest["types"] !== undefined || manifest["typings"] !== undefined || JSON.stringify(manifest["exports"] ?? {}).includes('"types"');
}

function repositoryUrl(manifest: Record<string, unknown>): string | undefined {
	const repository = manifest["repository"];
	if (typeof repository === "string") return repository;
	if (typeof repository === "object" && repository !== null && typeof (repository as { url?: unknown }).url === "string") {
		return (repository as { url: string }).url;
	}
	return undefined;
}

const registry = (input: string, path: string) => fetchJson(input, `https://registry.npmjs.org/${path.replace(/^@([^/]+)\//, "@$1%2f")}`);

/** GETs a JSON object; responses are a trust boundary, read as untyped records. */
const fetchJson = Effect.fn("fetchJson")(function* (input: string, url: string) {
	const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
	const body = yield* client.get(url).pipe(
		Effect.flatMap((response) => response.json),
		Effect.mapError((cause) => new TargetError({ input, reason: `GET ${url}: ${cause.message}` })),
	);
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return yield* new TargetError({ input, reason: `GET ${url}: not a JSON object` });
	}
	return body as Record<string, unknown>;
});
