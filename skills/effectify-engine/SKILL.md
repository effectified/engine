---
name: effectify-engine
description: Improve the effectified engine itself. Use when a target exposes an engine gap (a facade type wrong for every user, a reconcile that cannot settle, an analyzer that misreads a library), or when adding a capability to the analyzer, scanner, recipe, generator or runtime.
---

# Improve the engine

Every target is a test of the engine: `targets/` holds five real libraries (nodemailer, simple-git, sharp, puppeteer-core, bullmq), each with its surface, recipe, generated facade and behaviour tests. A gap one target exposes is fixed in the engine, never in a target's generated code, and the other targets prove the fix breaks nothing.

## Where things are

| Concern | File | Notes |
|---|---|---|
| Resolve a GitHub URL or npm name | `src/target.ts` | published packages only; monorepos resolve to the package named like the repo |
| Install a target | `src/workspace.ts` | `.cache/workspaces/<name>@<version>`, scripts off, absolute paths (the native checker needs them) |
| Read the types | `src/analyze.ts` | TypeScript 7's sync API (`typescript/unstable/sync`): exports, handles reached from them, overloads, traits, properties, events, generic signatures printed with their type parameters |
| Read the source | `src/scan.ts` | ast-grep over the package's JavaScript: error classes, thrown classes, error codes, emitted events |
| Decisions | `src/recipe.ts` | the Recipe schema and the draft; a redraft keeps `agent` and `person` decisions |
| The facade | `src/generate.ts` | deterministic text; generic methods and exports written out from upstream's declarations |
| Agreement with the compiler | `src/pipeline.ts` (`reconcile`) | reads tsc's diagnostics into recipe overrides until the package compiles |
| The facade's runtime | `src/runtime/effectify.ts` | copied verbatim into every facade; its types (`Effectified`, `Overloads`, `AsyncSpec`) derive the facade from upstream |
| Upstream changes | `src/drift.ts`, `sync` in `src/pipeline.ts` | |
| Orchestration | `src/plan.ts` | units for T3 Code (`effectify-t3`) |

## Rules the engine keeps

- The facade's types are the compiler's: where the analyzer and upstream's types disagree, `reconcile` records an override and the runtime follows the types. Never make the runtime guess at run time what the types decided.
- Generated output is deterministic: the golden test regenerates every target's `src/index.ts` from its committed surface and recipe and compares bytes. A change to the generator changes the committed targets in the same commit (`node src/bin.ts reconcile <name>` for each).
- Every handle spec `satisfies` what upstream's types say (`AsyncSpec`, `StreamSpec`, the method and property lists), so drift is a compile error, not a run-time surprise.
- Use only Effect 4 APIs you have read in `node_modules/effect/dist/*.d.ts`; TypeScript 7's API is `unstable`: check `node_modules/typescript/dist/api/sync/api.d.ts`, and guard what can panic (`getAliasedSymbol` on a non-alias, printing some nodes).
- No install scripts, exact versions, and nothing newer than the machine's release-age policy.

## A fix, step by step

1. Reproduce on the target that showed it (`node src/bin.ts make <name>`), and reduce it to a unit test where you can (`test/engine.test.ts`, `test/runtime.test.ts`: the runtime's type rules are tested with `expectTypeOf` and `@ts-expect-error`).
2. Fix the engine.
3. Regenerate and test every target: `for t in $(ls targets); do node src/bin.ts reconcile $t && node src/bin.ts test $t; done` with the services up (Redis on `REDIS_URL`, Chrome on `CHROME_BIN`).
4. `pnpm check && pnpm test`, and commit the engine change with the regenerated targets.
