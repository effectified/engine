# effectified engine

Give it a library, get it back in [Effect](https://effect.website): every async call an `Effect`, every async iterable a `Stream`, every resource scoped, every failure a tagged error. Then keep it in step with upstream, every day, by itself.

```sh
pnpm install --ignore-scripts
node src/bin.ts make https://github.com/taskforcesh/bullmq     # or an npm name: bullmq, bullmq@6.7.10
```

```
bullmq@6.7.10: 114 exports, 27 handles, 647 methods (528 async), types bundled
recipe @effectified/bullmq:
  exports  QueueEvents, FlowProducer, Queue, Worker
  handles  QueueEvents(close), FlowProducer(close)[2 events], Queue(close)[8 events], Worker(close)[15 events], Job
  errors   ConnectionClosedError, DelayedError, RateLimitError, ..., BullmqError
  services BullmqQueueEvents <- QueueEvents, BullmqFlowProducer <- FlowProducer, BullmqQueue <- Queue, BullmqWorker <- Worker
generated into targets/bullmq/package; type checks after 1 round(s)
```

```ts
import { Effect, Stream } from "effect";
import { events, makeQueue, makeWorker } from "@effectified/bullmq";

const program = Effect.scoped(
	Effect.gen(function* () {
		const queue = yield* makeQueue("emails", { connection });                   // closed with the scope
		const worker = yield* makeWorker("emails", send, { connection });
		yield* queue.add("welcome", { to: "ada@example.com" });                       // Effect<Job, BullmqError | ...>
		yield* events.Worker.completed(worker).pipe(Stream.take(1), Stream.runDrain); // the worker's events as a Stream
	}),
);
```

## How it works

| Step | What | With |
|---|---|---|
| **study** | Resolves a GitHub URL or npm name to a published version, installs it (scripts off), and reads its **surface**: exports, the objects it hands out (handles) reached from them, every overload, what each returns (promise, iterable, handle, builder), properties, event names, generic signatures with their type parameters. Then scans its JavaScript for the error classes it throws, its error codes and the events it emits. | TypeScript 7's native checker through its API (`typescript/unstable/sync`); ast-grep |
| **draft** | Writes `recipe.json`: every decision the types cannot make (which exports to offer, each handle's release method, which events become Streams, the error mapping, the services), each with its reason and who decided it. A redraft keeps what agents and people decided. | the package README, the scan |
| **generate** | Writes the facade package. Its types are **derived** from upstream's (`Effectified<Upstream.Page, ...>` keeps every overload, drops callback overloads, lifts handles, scopes releasable ones); generic methods and exports are written out from upstream's own declarations so their type parameters survive. Every handle's spec `satisfies` what upstream's types say, so a facade that no longer matches upstream does not compile and names what moved. | a self-contained runtime (`src/runtime/effectify.ts`) copied into each facade |
| **reconcile** | Type checks with TypeScript 7 and turns what the compiler says into recipe overrides, until the package compiles: the facade's types are the compiler's, and the runtime follows them. | `tsc` (native) |
| **plan** | Splits the judgment work (review the recipe, test each handle, settle overrides, write the docs) into units with self-contained briefs, file boundaries, dependencies and acceptance commands, for coding agents fanned out by **T3 Code**. | `skills/effectify-t3` |
| **sync** | Every day (`.github/workflows/sync.yml`): a newer upstream version is studied, its **drift** written (`DRIFT.md`: added, removed, changed, breaking or not), the recipe redrafted, the facade regenerated, type checked and tested, and a pull request opened. | `drift`, `sync` |
| **usages** | Lists where an application uses a library, as a checklist for moving it onto the facade. | ast-grep |

Every step is a command: `study`, `draft`, `generate`, `reconcile`, `verify`, `test`, `plan`, `drift`, `sync`, `usages`, `release`; `make` runs the first five.

## Targets

Five famous libraries without Effect support (none on npm, none in Effect itself, none in alchemy-run/distilled), effectified by the engine and tested against the real thing. Each lives in `targets/<name>/`: `surface.json`, `scan.json`, `recipe.json`, and the generated `package/` with its behaviour tests.

| Library | Weekly downloads | Exercises | Facade | Tests (real library) |
|---|---|---|---|---|
| [nodemailer](https://nodemailer.com) | 40M | factory → scoped transport, error codes (`EAUTH`, `ECONNECTION`) | `@effectified/nodemailer` | 3, JSON transport and a refused SMTP port |
| [simple-git](https://github.com/steveukx/git-js) | 15M | 70 chainable thenable methods, generics kept (`log<T = DefaultLogFields>`), error hierarchy from types | `@effectified/simple-git` | 2, git in a temp repository |
| [sharp](https://sharp.pixelplumbing.com) | 169M | a builder that is also a Node stream, native code | `@effectified/sharp` | 2, images in memory |
| [puppeteer-core](https://pptr.dev) | 35M | 16 handles, scoped browser and pages, error hierarchy (`TimeoutError`), 39 generic methods kept | `@effectified/puppeteer-core` | 3, a local Chrome |
| [bullmq](https://bullmq.io) | 14M | classes with generic overloaded constructors, events as Streams, four services | `@effectified/bullmq` | 2, Redis |

## For agents

`skills/` holds the skills an agent follows, written for T3 Code as the orchestrator:

| Skill | For |
|---|---|
| [`effectify`](skills/effectify/SKILL.md) | The entry point: a GitHub URL or npm name to a tested facade |
| [`effectify-t3`](skills/effectify-t3/SKILL.md) | Orchestrating it in T3 Code: the plan's units as delegates in worktrees, merged in order |
| [`effectify-recipe`](skills/effectify-recipe/SKILL.md) | Reviewing and deciding a recipe |
| [`effectify-tests`](skills/effectify-tests/SKILL.md) | Behaviour tests against the real library and local services |
| [`effectify-sync`](skills/effectify-sync/SKILL.md) | Following upstream releases |
| [`effectify-migrate`](skills/effectify-migrate/SKILL.md) | Moving an application onto a facade |
| [`effectify-engine`](skills/effectify-engine/SKILL.md) | Improving the engine when a target exposes a gap |

## Known limits

- A generic method whose exact signature names a type upstream does not export keeps the derived type, where its type parameters become their constraints (`recipe.derived` lists them).
- Event payloads are `ReadonlyArray<unknown>` (the listener's arguments); typed payloads are next.
- Callback-only APIs (no promise overload) are left out of the facade; `.upstream` reaches them.
- Facades are released on GitHub, not npm: `node src/bin.ts release <name>` publishes `<name>-v<version>` from this repository (a facade's version is its upstream's).

## Develop

```sh
pnpm check   # TypeScript 7
pnpm test    # the runtime's type rules and behaviour, the engine's parts, and every target regenerated byte for byte
```

Node 24 or later. Built on Effect 4. Not an official Effect project. MIT.
