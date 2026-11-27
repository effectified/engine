# Rules for agents in the effectified engine

- This repository is the engine only. Facades, their recipes and tests, and the skills for making them live in effectified/packages; work on a facade happens there. To change the engine, follow `skills/effectify-engine/SKILL.md`.
- `test/fixtures/<name>/` are copies of facades from effectified/packages (surface, recipe, the `src/index.ts` they generate). Change them only with `pnpm test -u` after an intended generator change, never by hand.
- Effect 4 only, and only APIs you have read in `node_modules/effect/dist/*.d.ts`. TypeScript 7's API (`typescript/unstable/*`) is unstable: read its declarations.
- Install with `pnpm install --ignore-scripts`; dependencies are exact versions; nothing newer than the machine's release-age policy.
- Before you report: `pnpm check`, `pnpm test`, `pnpm build`, and for a generator or runtime change, every facade regenerated and tested with this checkout from a checkout of effectified/packages (see the skill).
- A new engine is released by raising `version` in `package.json` (and `ENGINE_VERSION` in `src/generate.ts`, written into every facade); after CI on main, `release.yml` publishes it on npm and makes its GitHub release. A release is never replaced. Never publish or run `npm trust` by hand but with `--dry-run`: `effectify bootstrap` is the owner's.
- Never commit unless asked; stage explicit paths.
