# Rules for agents in the effectified engine

- Start with `skills/effectify/SKILL.md`; when you orchestrate in T3 Code, `skills/effectify-t3/SKILL.md`; to change the engine, `skills/effectify-engine/SKILL.md`.
- Never edit generated code: `targets/*/package/src/`, `targets/*/package/package.json`, `tsconfig*.json`, `README.md` there. Change `recipe.json` or the engine, then `node src/bin.ts reconcile <name>`.
- Tests in `targets/*/package/test/` run the real library and local services (Docker, a temp directory, `CHROME_BIN`), never mocks of the library and never paid or remote APIs.
- Effect 4 only, and only APIs you have read in `node_modules/effect/dist/*.d.ts`. TypeScript 7's API (`typescript/unstable/*`) is unstable: read its declarations.
- Install with `pnpm install --ignore-scripts`; dependencies are exact versions; nothing newer than the machine's release-age policy.
- Before you report: `pnpm check`, `pnpm test`, and for every target you touched `node src/bin.ts reconcile <name>` and `node src/bin.ts test <name>` with its services up.
- Never commit unless asked; stage explicit paths.
