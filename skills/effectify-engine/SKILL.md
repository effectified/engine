---
name: effectify-engine
description: Improve the effectified engine itself. Use when a facade exposes an engine gap (a facade type wrong for every user, a reconcile that cannot settle, an analyzer that misreads a library), or when adding a capability to the analyzer, scanner, recipe, generator or runtime.
---

# Improve the engine

Every facade in effectified/packages is a test of the engine: real libraries, each with its surface, recipe, generated package and behaviour tests. A gap one facade exposes is fixed here, never in a facade's generated code, and the other facades prove the fix breaks nothing.

## Where things are

| Concern | File | Notes |
|---|---|---|
| Resolve a GitHub URL or npm name | `src/target.ts` | published packages only; monorepos resolve to the package named like the repo |
| Install a target | `src/workspace.ts` | `.cache/workspaces/<name>@<version>`, scripts off, absolute paths (the native checker needs them) |
| Read the types | `src/analyze.ts` | TypeScript 7's sync API (`typescript/unstable/sync`): exports, handles reached from them, overloads, traits, properties, events, generic signatures printed with their type parameters |
| Read the source | `src/scan.ts` | ast-grep over the package's JavaScript: error classes, thrown classes, error codes, emitted events |
| Web components | `src/elements.ts`, `src/element-types.ts` | the Custom Elements Manifest through superclasses and mixins; properties from `HTMLElementTagNameMap` |
| Decisions | `src/recipe.ts` | the Recipe schema and the draft; a redraft keeps `agent` and `person` decisions; where facades are released (`PACKAGES_REPOSITORY`) |
| The facade | `src/generate.ts`, `src/ui-facade.ts` | deterministic text; generic methods and exports written out from upstream's declarations |
| Agreement with the compiler | `src/pipeline.ts` (`reconcile`) | reads tsc's diagnostics into recipe overrides until the package compiles |
| The facade's runtime | `src/runtime/effectify.ts`, `src/runtime/ui.ts` | copied verbatim into every facade (shipped as source in the release); its types derive the facade from upstream |
| Upstream changes | `src/drift.ts`, `sync` in `src/pipeline.ts` | |
| Docs | `src/docs.ts` | README, SKILL.md and docs.json from the surface, the recipe and the tests' example regions; docs.json is a stored format read by effectified.dev (`schema`) |
| Orchestration | `src/plan.ts` | units for T3 Code (`effectify-t3` in effectified/packages) |

## Rules the engine keeps

- The facade's types are the compiler's: where the analyzer and upstream's types disagree, `reconcile` records an override and the runtime follows the types. Never make the runtime guess at run time what the types decided.
- Generated output is deterministic: `test/engine.test.ts` regenerates the `src/index.ts` of every fixture in `test/fixtures` and compares bytes; effectified/packages' CI does the same for every facade it keeps.
- Every handle spec `satisfies` what upstream's types say (`AsyncSpec`, `StreamSpec`, the method and property lists), so drift is a compile error, not a run-time surprise.
- Use only Effect 4 APIs you have read in `node_modules/effect/dist/*.d.ts`; TypeScript 7's API is `unstable`: check `node_modules/typescript/dist/api/sync/api.d.ts`, and guard what can panic (`getAliasedSymbol` on a non-alias, printing some nodes).
- No install scripts, exact versions, and nothing newer than the machine's release-age policy.

## A fix, step by step

1. Reproduce on the facade that showed it, from a checkout of effectified/packages next to this one: `node ../engine/src/bin.ts reconcile <name>` runs this checkout's engine on that repository's `targets/`. Reduce it to a unit test where you can (`test/engine.test.ts`, `test/runtime.test.ts`: the runtime's type rules are tested with `expectTypeOf` and `@ts-expect-error`).
2. Fix the engine.
3. Regenerate and test every facade with this checkout, from the packages checkout: `for t in $(ls targets); do node ../engine/src/bin.ts reconcile $t && node ../engine/src/bin.ts test $t; done` with the services up (Redis on `REDIS_URL`, Chrome on `CHROME_BIN`). `git diff targets` there is what the change does to every facade.
4. Here: `pnpm test -u` if the fixtures changed as intended, then `pnpm check && pnpm test && pnpm build`. Raise the version (`package.json`, `ENGINE_VERSION`) when facades change, and commit.
5. Once the engine is released, in effectified/packages: move `@effectified/engine` to the new release, commit the regenerated facades with it (a changed released facade also gets a new `recipe.revision`), and open one pull request.
