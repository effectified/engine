# effectified engine

Give it a library, get it back in [Effect](https://effect.website): every async call an `Effect`, every async iterable a `Stream`, every resource scoped, every failure a tagged error. Then keep it in step with upstream, every day, by itself.

This repository is the engine. The facades it makes, and the recipes, tests and decisions people and agents add to them, live in **[effectified/packages](https://github.com/effectified/packages)**: that is where a library is added, synced and released.

```sh
# in a checkout of effectified/packages, which pins the engine
pnpm install --ignore-scripts
pnpm effectify make https://github.com/taskforcesh/bullmq     # or an npm name: bullmq, bullmq@6.7.10
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
| **plan** | Splits the judgment work (review the recipe, test each handle, settle overrides, write the docs) into units with self-contained briefs, file boundaries, dependencies and acceptance commands, for coding agents fanned out by **T3 Code**. | `skills/effectify-t3` in effectified/packages |
| **sync** | Every day (effectified/packages' `sync.yml`): a newer upstream version is studied, its **drift** written (`DRIFT.md`: added, removed, changed, breaking or not), the recipe redrafted, the facade regenerated, type checked and tested, and a pull request opened. | `drift`, `sync` |
| **docs** | With every generate: the facade's README, its agent skill (`SKILL.md`, shipped in the package) and `docs.json`, which effectified.dev renders as its page. Examples are regions of its passing tests (`// #region example: <title>`); a frontend facade's fixtures are also built into a live demo, attached to its release. | `src/docs.ts` |
| **usages** | Lists where an application uses a library, as a checklist for moving it onto the facade. | ast-grep |

Every step is a command: `study`, `draft`, `generate`, `reconcile`, `verify`, `test`, `plan`, `drift`, `sync`, `usages`, `release`; `make` runs the first five.

## Install

Released on GitHub as `v<version>`, never replaced:

```sh
pnpm add -D https://github.com/effectified/engine/releases/download/v0.3.0/effectified-engine-0.3.0.tgz
```

The package carries the `effectify` command, built to JavaScript, and the runtimes it copies into every facade (`src/runtime`). After CI passes on `main`, `release.yml` releases the version in `package.json` if it is not released yet.

## Facades and skills

The facades (15 so far: nodemailer, simple-git, sharp, puppeteer-core, bullmq, and ten frontend libraries on Effect UI) and the skills agents follow to make and keep them (`effectify`, `effectify-t3`, `effectify-recipe`, `effectify-tests`, `effectify-ui`, `effectify-sync`, `effectify-migrate`) are in [effectified/packages](https://github.com/effectified/packages). This repository keeps [`skills/effectify-engine`](skills/effectify-engine/SKILL.md): improving the engine when a facade exposes a gap.

## Known limits

- A web component's properties are read from upstream's types (`HTMLElementTagNameMap`), inherited ones included (Material's `disabled`): public, writable, not methods, functions or DOM nodes, not `@internal`; a member the manifest knows as the element's own state (no attribute, no description) is left out. A tag the types do not name keeps the manifest's list.
- A facade declares the packages its emitted declarations name (`recipe.typeDependencies`, written by `reconcile`), so a strict install resolves them.
- Interrupting a call aborts the `AbortSignal` upstream takes, as a parameter or as the `signal` field of an options object (combined with one the caller passes); a `Stream` aborts its signal when it ends. A call that takes no signal cannot be cancelled upstream: interrupting it stops waiting for it.
- A facade handed back to upstream is unwrapped (`setFocus(editor)`, `connect(transport)`), and parameter types accept it.
- A class whose constructor is private or that is abstract is made by its static factories, offered under the class's name (`ModelRuntime.create(...)`) when they are async or make a wrapped handle.
- A tagged error carries the fields its upstream class declares (`status`, `body`, a numeric `code`), each with a Schema that follows its type; anything but strings, numbers, booleans and string literals is `Unknown`.
- Every export is annotated with a type that names `typeof Upstream.X`, so its declaration never spells a type upstream does not export. A lifted method whose type cannot be named that way keeps its derived type (`recipe.unlifted`), and loses its type parameters.
- Synchronous methods stay synchronous: one that throws throws. A function-valued field is read as a method (an optional one stays a property).

- A generic method whose signature names a type upstream does not export is typed through a call (`Effectify.lifted`), which keeps its type parameters: puppeteer's `page.$eval("input#name", (input) => input.value)` is an `Effect<string>`. When TypeScript cannot infer through the call (type parameters whose defaults depend on each other, `recipe.unlifted`), the method keeps the derived type, its type parameters as their constraints. An overloaded generic method keeps its written-out overloads, or the derived type.
- Event payloads are typed when the emitter keys its listeners by name (`on<U extends keyof Listeners>(event: U, listener: Listeners[U])`, as bullmq and puppeteer do): `events.Worker.completed(worker)` is a `Stream` of `[job, result, previous]`. Other emitters give `ReadonlyArray<unknown>`.
- A method without a promise overload whose trailing callback reports its result is an `Effect` too: the analyzer reads the callback's shape (`node`: an error first, then the value; `done`: a parameterless `callback`, `done` or `next`), and the facade completes when upstream calls back (nodemailer's `Transport.send`). Any other callback is an argument like the rest (a key handler), and the method keeps upstream's type.
- Facades are released on GitHub, not npm, as `<name>-v<version>` of effectified/packages (a facade's version is its upstream's, `+<revision>` for a later facade of the same upstream). After CI passes there, `effectify release` releases every facade whose version is not released yet; `release <name>` releases one by hand.

## Develop

```sh
pnpm check   # TypeScript 7
pnpm test    # the runtime's type rules and behaviour, the engine's parts, and the generator against test/fixtures
pnpm build   # dist/, what the release runs
```

`test/fixtures` holds the surface, recipe and generated `src/index.ts` of eight facades from effectified/packages. A change to the generator that changes them is either a bug or intended: then `pnpm test -u` rewrites them, and the facades are regenerated in effectified/packages when it moves to the new engine (see `skills/effectify-engine`).

Node 24 or later. Built on Effect 4. Not an official Effect project. MIT.
