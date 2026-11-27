// The runtime facades carry: what the types promise (checked by tsc) and what the objects do (run here).
import { type AddressInfo, connect, createServer, type Server, type Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect, isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
	type Brand,
	Cause,
	Context,
	Effect,
	Equal,
	Exit,
	Fiber,
	HashSet,
	Logger,
	Option,
	Redacted,
	Scheduler,
	Schema,
	Scope,
	Stream,
	Tracer,
} from "effect";
import {
	type Borrowed,
	type Classify,
	codeIn,
	describe as describeFailure,
	type Disagreeing,
	type EffectFunction,
	type Effectified,
	effectify,
	entry,
	errorFields,
	events,
	type Branded,
	type Branding,
	type Expect,
	type HandleKind,
	type Listed,
	type ReachesString,
	type Redacting,
	type Resolved,
	type ResolvedList,
	type ResolvingBranded,
	Sealed,
	type Secreted,
	scrubbed,
	unchecked,
} from "../src/runtime/effectify.ts";

class Connection {
	closed = false;
	async query(sql: string): Promise<number> {
		if (sql === "bad") throw Object.assign(new Error("syntax"), { code: "E_SYNTAX" });
		return sql.length;
	}
	async *rows(): AsyncIterable<number> {
		yield 1;
		yield 2;
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

class Client {
	last: Connection | undefined;
	label = "client";
	async connect(): Promise<Connection> {
		this.last = new Connection();
		return this.last;
	}
	send(message: string): Promise<string>;
	send(message: string, callback: (error: Error | null, reply: string) => void): void;
	send(message: string, callback?: (error: Error | null, reply: string) => void): Promise<string> | void {
		if (callback) return callback(null, message);
		return Promise.resolve(message.toUpperCase());
	}
	name(): string {
		return this.label;
	}
	/** Takes back an object it handed out, as upstream APIs do. */
	owns(connection: Connection): boolean {
		return connection === this.last;
	}
	async ping(connection: Connection): Promise<boolean> {
		return connection === this.last;
	}
	with(label: string): this {
		this.label = label;
		return this;
	}
}

class TestError extends Schema.TaggedError<TestError, { readonly brand: unique symbol }>()("TestError", {
	operation: Schema.String,
	code: Schema.optional(Schema.String),
}) {}

type Handles = readonly [Client, ClientFacade, false] | readonly [Connection, ConnectionFacade, true, "close"];
interface ClientFacade extends Effectified<Client, TestError, Handles> {}
interface ConnectionFacade extends Effectified<Connection, TestError, Handles> {}

const kinds: Record<string, HandleKind> = {
	Client: {
		name: "Client",
		spec: {
			methods: ["connect", "send", "name", "with", "owns", "ping"],
			async: { connect: true, send: true, ping: true },
			returns: { connect: "Connection", with: "Client" },
		},
	},
	Connection: {
		name: "Connection",
		spec: { methods: ["query", "rows", "close"], async: { query: true, close: true }, stream: { rows: true } },
		release: "close",
		releases: ["close"],
	},
};

const classify = (operation: string, cause: unknown) =>
	new TestError({ operation, code: (cause as { code?: string }).code ?? undefined });

const client = (upstream = new Client()) =>
	effectify(upstream, kinds["Client"]!, kinds, classify) as unknown as ClientFacade;

describe("types", () => {
	it("keeps the promise overload and drops the callback one", () => {
		expectTypeOf(client().send("x")).toEqualTypeOf<Effect.Effect<string, TestError>>();
		// Typed only, never run: the callback overload is not part of the facade.
		const callback = () =>
			// @ts-expect-error the callback overload is not part of the facade
			client().send("x", () => {});
		expect(callback).toBeTypeOf("function");
	});

	it("lifts handles, scoped when they release", () => {
		expectTypeOf(client().connect()).toEqualTypeOf<Effect.Effect<ConnectionFacade, TestError, Scope.Scope>>();
		expectTypeOf(client().with("b")).toEqualTypeOf<ClientFacade>();
		expectTypeOf(client().name()).toEqualTypeOf<string>();
	});

	it("keeps an optional method optional", () => {
		interface Provider {
			name(): string;
			refresh?(): Promise<number>;
		}
		type Facade = Effectified<Provider, TestError, never>;
		expectTypeOf<Facade["refresh"]>().toEqualTypeOf<(() => Effect.Effect<number, TestError>) | undefined>();
		expectTypeOf<Facade["name"]>().toEqualTypeOf<() => string>();
	});

	it.effect("runs a method that may return a promise as an Effect, whichever it returns", () =>
		Effect.gen(function* () {
			class Converter {
				convert(value: number): number | Promise<number> {
					return value > 0 ? value * 2 : Promise.resolve(-value);
				}
			}
			const facade = effectify(
				new Converter(),
				{ name: "Converter", spec: { methods: ["convert"], async: { convert: true } } },
				{},
				classify,
			) as unknown as Effectified<Converter, TestError, never>;
			expectTypeOf(facade.convert).returns.toEqualTypeOf<Effect.Effect<number, TestError>>();
			expect(yield* facade.convert(2)).toBe(4);
			expect(yield* facade.convert(-3)).toBe(3);
		}),
	);

	it("turns async iterables into streams", () => {
		expectTypeOf<ReturnType<ConnectionFacade["rows"]>>().toEqualTypeOf<Stream.Stream<number, TestError>>();
	});

	it.effect("types an export that only throws as an Effect that fails, as it runs, with or without handles", () =>
		Effect.gen(function* () {
			const fail = (): never => {
				throw Object.assign(new Error("always"), { code: "E_ALWAYS" });
			};
			expectTypeOf<EffectFunction<typeof fail, TestError, never>>().toEqualTypeOf<
				() => Effect.Effect<never, TestError>
			>();
			expectTypeOf<EffectFunction<typeof fail, TestError, Handles>>().toEqualTypeOf<
				() => Effect.Effect<never, TestError>
			>();
			// A method that only throws stays a synchronous call that throws: no facade of any handle.
			expectTypeOf<Effectified<{ boom(): never }, TestError, Handles>["boom"]>().toEqualTypeOf<() => never>();
			const facade = entry<typeof fail, TestError, never>(fail, "fail", undefined, {}, classify);
			expect(yield* Effect.flip(facade())).toStrictEqual(new TestError({ operation: "fail", code: "E_ALWAYS" }));
		}),
	);
});

describe("effectify", () => {
	it.effect("runs an async method as an Effect", () =>
		Effect.gen(function* () {
			expect(yield* client().send("hi")).toBe("HI");
		}),
	);

	it.effect("classifies a rejection with the operation and upstream code", () =>
		Effect.gen(function* () {
			const error = yield* Effect.scoped(
				Effect.flatMap(client().connect(), (connection) => connection.query("bad")),
			).pipe(Effect.flip);
			expect(error).toStrictEqual(new TestError({ operation: "Connection.query", code: "E_SYNTAX" }));
		}),
	);

	it.effect("releases a scoped handle when its scope closes", () =>
		Effect.gen(function* () {
			const upstream = new Client();
			const length = yield* Effect.scoped(Effect.flatMap(client(upstream).connect(), (c) => c.query("four")));
			expect(length).toBe(4);
			expect(upstream.last?.closed).toBe(true);
		}),
	);

	it.effect("streams an async iterable", () =>
		Effect.gen(function* () {
			const rows = yield* Effect.scoped(Effect.flatMap(client().connect(), (c) => Stream.runCollect(c.rows())));
			expect(rows).toStrictEqual([1, 2]);
		}),
	);

	it("keeps builders chainable and synchronous methods as they are", () => {
		const facade = client().with("renamed");
		expect(facade.name()).toBe("renamed");
		expect(facade.upstream).toBeInstanceOf(Client);
	});

	it.effect("hands upstream its own object when given a facade, and types the facade as accepted, borrowed too", () =>
		Effect.gen(function* () {
			const facade = client();
			const connection = yield* Effect.scoped(facade.connect());
			expectTypeOf(facade.owns)
				.parameter(0)
				.toEqualTypeOf<Connection | ConnectionFacade | Omit<ConnectionFacade, "close">>();
			expect(facade.owns(connection)).toBe(true);
			expect(yield* facade.ping(connection)).toBe(true);
			expect(facade.owns(new Connection())).toBe(false);
		}),
	);

	it.effect("is lazy: nothing runs until the Effect does", () =>
		Effect.gen(function* () {
			const upstream = new Client();
			const effect = client(upstream).connect();
			expect(upstream.last).toBeUndefined();
			yield* Effect.scoped(effect);
			expect(upstream.last).toBeDefined();
		}),
	);
});

describe("thenables", () => {
	/** An upstream whose async results are thenables as `Promise.resolve` reads them, not promises. */
	class Lookup {
		reads = 0;
		/** A result whose `then` throws as it is read. */
		broken(): PromiseLike<number> {
			return withThen({}, () => {
				this.reads += 1;
				throw Object.assign(new Error("unreadable"), { code: "E_THEN" });
			});
		}
		/** A function that is a thenable too. */
		callable(): PromiseLike<number> {
			return this.resolving(42);
		}
		/** A callable thenable of a value holding a secret. */
		options(): PromiseLike<{ readonly auth: { readonly pass: string } }> {
			return this.resolving({ auth: { pass: "hunter2" } });
		}
		/** A function whose `then` resolves to `value`. */
		private resolving<T>(value: T): PromiseLike<T> {
			return withThen(
				() => value,
				() => {
					this.reads += 1;
					return (resolve: (value: T) => void) => resolve(value);
				},
			);
		}
	}
	const methods: HandleKind["spec"] = {
		methods: ["broken", "callable", "options"],
		async: { broken: true, callable: true, options: true },
	};
	// Without a secret its results keep, and with one, whose results are concealed as they resolve.
	const plain = (upstream: Lookup) =>
		effectify(upstream, { name: "Lookup", spec: methods }, {}, classify) as unknown as Effectified<
			Lookup,
			TestError,
			never
		>;
	const concealing = (upstream: Lookup) =>
		effectify(
			upstream,
			{ name: "Lookup", spec: { ...methods, concealed: [["auth", "pass"]] } },
			{},
			classify,
		) as unknown as Effectified<
			Lookup,
			TestError,
			never,
			"broken" | "callable" | "options",
			never,
			never,
			never,
			"broken" | "callable" | "options",
			{},
			never,
			readonly ["auth", "pass"]
		>;
	const caught = <A, R>(effect: Effect.Effect<A, TestError, R>) =>
		Effect.catchTag(effect, "TestError", (error) => Effect.succeed(error));

	it.effect("fails an async method whose result's `then` throws as it is read, classified, read once", () =>
		Effect.gen(function* () {
			const upstream = new Lookup();
			const failed = new TestError({ operation: "Lookup.broken", code: "E_THEN" });
			expect(yield* caught(plain(upstream).broken())).toStrictEqual(failed);
			expect(yield* caught(concealing(upstream).broken())).toStrictEqual(failed);
			expect(upstream.reads).toBe(2);
		}),
	);

	it.effect(
		"resolves an async method's callable thenable, reading its `then` once, and conceals what it resolves to",
		() =>
			Effect.gen(function* () {
				const upstream = new Lookup();
				expect(yield* plain(upstream).callable()).toBe(42);
				expect(yield* concealing(upstream).callable()).toBe(42);
				const options = yield* concealing(upstream).options();
				expect(Redacted.isRedacted(options.auth.pass) && Redacted.value(options.auth.pass)).toBe("hunter2");
				expect(upstream.reads).toBe(3);
			}),
	);

	it.effect("does the same for an exported function", () =>
		Effect.gen(function* () {
			const upstream = new Lookup();
			const broken = entry<() => PromiseLike<number>, TestError, never>(
				() => upstream.broken(),
				"broken",
				undefined,
				{},
				classify,
			);
			expect(yield* caught(broken())).toStrictEqual(new TestError({ operation: "broken", code: "E_THEN" }));
			const callable = entry<() => PromiseLike<number>, TestError, never>(
				() => upstream.callable(),
				"callable",
				undefined,
				{},
				classify,
			);
			expect(yield* callable()).toBe(42);
			expect(upstream.reads).toBe(2);
		}),
	);

	/**
	 * An upstream whose work starts as its result is adopted, reading the theme then: a thenable's in its `then`, as
	 * postcss's `LazyResult` runs its plugins, and a native promise's in a microtask of its own.
	 */
	class Styles {
		theme = "red";
		lazy(): PromiseLike<string> {
			return withThen({}, () => (resolve: (value: string) => void) => resolve(this.theme));
		}
		eager(): Promise<string> {
			return Promise.resolve().then(() => this.theme);
		}
	}
	const styled = (upstream: Styles) =>
		effectify(
			upstream,
			{ name: "Styles", spec: { methods: ["lazy", "eager"], async: { lazy: true, eager: true } } },
			{},
			classify,
		) as unknown as Effectified<Styles, TestError, never>;
	const exported = (run: (styles: Styles) => PromiseLike<string>, styles: Styles) =>
		entry<() => PromiseLike<string>, TestError, never>(() => run(styles), "styles", undefined, {}, classify);
	// What a call gives when a microtask queued just before it switches the theme from red to blue.
	const themed = async (run: (styles: Styles) => PromiseLike<string>) => {
		const styles = new Styles();
		queueMicrotask(() => {
			styles.theme = "blue";
		});
		return run(styles);
	};
	for (const [form, result] of [
		["a thenable", (styles: Styles) => styles.lazy()],
		["a native promise", (styles: Styles) => styles.eager()],
	] as const) {
		it(`adopts ${form} an async method returns as \`await\` does, after the microtasks queued before the call`, async () => {
			const awaited = await themed(async (styles) => await result(styles));
			expect(awaited).toBe("blue");
			const method = (styles: Styles) =>
				Effect.runPromise(form === "a thenable" ? styled(styles).lazy() : styled(styles).eager());
			expect(await themed(method)).toBe(awaited);
		});

		it(`adopts ${form} an exported function returns as \`await\` does`, async () => {
			const awaited = await themed(async (styles) => await result(styles));
			expect(await themed((styles) => Effect.runPromise(exported(result, styles)()))).toBe(awaited);
		});
	}

	it.effect("calls a thenable's `then` as it was read, whatever its own `call`", () =>
		Effect.gen(function* () {
			const then = (resolve: (value: number) => void) => resolve(7);
			Object.defineProperty(then, "call", {
				value: () => {
					throw new Error("a shadowed call");
				},
			});
			const shadowed = entry<() => PromiseLike<number>, TestError, never>(
				() => withThen({}, () => then),
				"shadowed",
				undefined,
				{},
				classify,
			);
			expect(yield* shadowed()).toBe(7);
		}),
	);

	/** A native promise of 7 whose `constructor` getter throws when it is read a second time, and its reads. */
	const readOnce = () => {
		const promise = Promise.resolve(7);
		const counted = { reads: 0, promise };
		Object.defineProperty(promise, "constructor", {
			get: () => {
				counted.reads += 1;
				if (counted.reads > 1) throw new Error("constructor read twice");
				return Promise;
			},
		});
		return counted;
	};

	it("reads a native promise's constructor once when it is awaited", async () => {
		const awaited = readOnce();
		expect(await awaited.promise).toBe(7);
		expect(awaited.reads).toBe(1);
	});

	it.effect("reads a native promise's constructor once, as `await` does, through an export and a method", () =>
		Effect.gen(function* () {
			const exported = readOnce();
			const awaiting = entry<() => Promise<number>, TestError, never>(
				() => exported.promise,
				"awaiting",
				undefined,
				{},
				classify,
			);
			expect(yield* awaiting()).toBe(7);
			expect(exported.reads).toBe(1);
			const method = readOnce();
			const upstream = { read: () => method.promise };
			const facade = effectify(
				upstream,
				{ name: "Reader", spec: { methods: ["read"], async: { read: true } } },
				{},
				classify,
			) as unknown as Effectified<typeof upstream, TestError, never>;
			expect(yield* facade.read()).toBe(7);
			expect(method.reads).toBe(1);
		}),
	);

	it.effect("keeps a thenable's first settlement, as `await` does", () =>
		Effect.gen(function* () {
			const settling = (settle: (resolve: (value: number) => void, reject: (reason: unknown) => void) => void) =>
				entry<() => PromiseLike<number>, TestError, never>(
					() => withThen({}, () => settle),
					"settling",
					undefined,
					{},
					classify,
				)();
			expect(
				yield* settling((resolve) => {
					resolve(1);
					throw Object.assign(new Error("after"), { code: "E_AFTER" });
				}),
			).toBe(1);
			expect(
				yield* caught(
					settling((resolve, reject) => {
						reject(Object.assign(new Error("first"), { code: "E_FIRST" }));
						resolve(2);
					}),
				),
			).toStrictEqual(new TestError({ operation: "settling", code: "E_FIRST" }));
		}),
	);
});

/**
 * `target`, an object or a function, made a thenable as `Promise.resolve` reads one: its `then` is what `read` gives,
 * read each time through the getter.
 */
function withThen<T>(target: object, read: () => unknown): PromiseLike<T> {
	// oxlint-disable-next-line unicorn/no-thenable -- a thenable that is no promise is what the runtime is tested with
	const thenable = Object.defineProperty(target, "then", { get: read });
	// No `PromiseLike` to TypeScript (a getter's `then`, a function's), but a thenable to the Promise resolution procedure.
	return thenable as unknown as PromiseLike<T>;
}

/**
 * Each way an Effect acquires what one upstream call gives (`give`, run as upstream's method or function, given the
 * call's signal where it takes one): a method, one whose value may be absent, a list a method makes, a method reporting
 * through its callback (which takes no signal), and an exported function. `handles` is how many connections the call
 * gives, and `signalled` whether it takes a signal.
 */
const acquirers: ReadonlyArray<{
	readonly shape: string;
	readonly handles: number;
	readonly signalled: boolean;
	readonly acquire: (give: (signal?: AbortSignal) => unknown) => Effect.Effect<unknown, TestError, Scope.Scope>;
}> = [
	{
		shape: "a method",
		handles: 1,
		signalled: true,
		acquire: (give) => openerOf(give, { returns: { open: "Connection" }, signal: { open: { index: 0 } } }).open(),
	},
	{
		shape: "a method whose value may be absent",
		handles: 1,
		signalled: true,
		acquire: (give) =>
			openerOf(give, {
				returns: { open: "Connection" },
				option: { open: true },
				signal: { open: { index: 0 } },
			}).open(),
	},
	{
		shape: "a list a method makes",
		handles: 2,
		signalled: true,
		acquire: (give) => openerOf(give, { lists: { open: "Connection" }, signal: { open: { index: 0 } } }).open(),
	},
	{
		shape: "a method reporting through its callback",
		handles: 1,
		signalled: false,
		acquire: (give) =>
			openerOf((callback: (error: null, value: unknown) => void) => reportTo(callback, give()), {
				async: {},
				callback: { open: "node" },
				returns: { open: "Connection" },
			}).open(),
	},
	{
		shape: "an exported function",
		handles: 1,
		signalled: true,
		acquire: (give) =>
			entry<(signal?: AbortSignal) => unknown, TestError, never>(
				give,
				"open",
				kinds["Connection"],
				kinds,
				classify,
				{
					signal: { index: 0 },
				},
			)(),
	},
];

/** A facade whose method `open` is `open`, async unless `spec` says otherwise, with the other fields of `spec`. */
const openerOf = (open: (...args: Array<never>) => unknown, spec: Omit<Partial<HandleKind["spec"]>, "methods">) =>
	effectify(
		{ open },
		{ name: "Opener", spec: { methods: ["open"], async: { open: true }, ...spec } },
		kinds,
		classify,
	) as unknown as {
		readonly open: () => Effect.Effect<unknown, TestError, Scope.Scope>;
	};

/** Reports `value` to a node-style callback: at once, or once it resolves when it is a promise. */
function reportTo(callback: (error: null, value: unknown) => void, value: unknown): void {
	if (value instanceof Promise) value.then((resolved) => callback(null, resolved));
	else callback(null, value);
}

/** An upstream whose calls wait until their signal aborts, and record what they were given. */
class Fetcher {
	seen: Array<AbortSignal | undefined> = [];
	options: Array<Record<string, unknown> | undefined> = [];
	/** Takes its signal as a parameter. */
	wait(label: string, signal?: AbortSignal): Promise<string> {
		this.seen.push(signal);
		return untilAborted(signal, label);
	}
	/** Takes its signal in an options object. */
	request(url: string, options?: { readonly signal?: AbortSignal; readonly retries?: number }): Promise<string> {
		this.seen.push(options?.signal);
		this.options.push(options);
		return untilAborted(options?.signal, url);
	}
	async *pages(options?: { readonly signal?: AbortSignal }): AsyncIterable<number> {
		this.seen.push(options?.signal);
		for (let page = 1; ; page++) yield page;
	}
}

function untilAborted(signal: AbortSignal | undefined, value: string): Promise<string> {
	return new Promise((resolve, reject) => {
		if (value === "now") return resolve(value);
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

const fetcher = (upstream: Fetcher) =>
	effectify(
		upstream,
		{
			name: "Fetcher",
			spec: {
				methods: ["wait", "request", "pages"],
				async: { wait: true, request: true },
				stream: { pages: true },
				signal: {
					wait: { index: 1 },
					request: { index: 1, property: "signal" },
					pages: { index: 0, property: "signal" },
				},
			},
		},
		{},
		classify,
	) as unknown as Effectified<Fetcher, TestError, never>;

describe("interruption", () => {
	it.live("aborts the signal a method takes as a parameter when its fiber is interrupted", () =>
		Effect.gen(function* () {
			const upstream = new Fetcher();
			const fiber = yield* Effect.forkChild(fetcher(upstream).wait("slow"));
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(fiber);
			expect(upstream.seen[0]?.aborted).toBe(true);
		}),
	);

	it.live("puts the signal into an options object, keeping the caller's other options and signal", () =>
		Effect.gen(function* () {
			const upstream = new Fetcher();
			const own = new AbortController();
			const fiber = yield* Effect.forkChild(fetcher(upstream).request("slow", { retries: 2, signal: own.signal }));
			yield* Effect.yieldNow;
			expect(upstream.options[0]?.["retries"]).toBe(2);
			expect(upstream.seen[0]?.aborted).toBe(false);
			yield* Fiber.interrupt(fiber);
			expect(upstream.seen[0]?.aborted).toBe(true);
			expect(own.signal.aborted).toBe(false);
		}),
	);

	it.live("aborts when the caller's own signal aborts", () =>
		Effect.gen(function* () {
			const upstream = new Fetcher();
			const own = new AbortController();
			const fiber = yield* Effect.forkChild(Effect.exit(fetcher(upstream).wait("slow", own.signal)));
			yield* Effect.yieldNow;
			own.abort(new Error("caller"));
			const exit = yield* Fiber.join(fiber);
			expect(Exit.isFailure(exit)).toBe(true);
		}),
	);

	it.live("aborts a stream's signal when the stream ends early", () =>
		Effect.gen(function* () {
			const upstream = new Fetcher();
			expect(yield* Stream.runCollect(Stream.take(fetcher(upstream).pages(), 2))).toStrictEqual([1, 2]);
			expect(upstream.seen[0]?.aborted).toBe(true);
		}),
	);

	it.live("aborts an exported function's signal when its fiber is interrupted", () =>
		Effect.gen(function* () {
			const upstream = new Fetcher();
			const run = (label: string, signal?: AbortSignal) => upstream.wait(label, signal);
			const wait = entry<typeof run, TestError, never>(run, "wait", undefined, {}, classify, {
				signal: { index: 1 },
			});
			const fiber = yield* Effect.forkChild(wait("slow"));
			yield* Effect.yieldNow;
			yield* Fiber.interrupt(fiber);
			expect(upstream.seen[0]?.aborted).toBe(true);
		}),
	);

	it.live("runs an exported function that returns an async iterable as a Stream", () =>
		Effect.gen(function* () {
			const upstream = new Fetcher();
			const iterate = (options?: { readonly signal?: AbortSignal }) => upstream.pages(options);
			const pages = entry<typeof iterate, TestError, never>(iterate, "pages", undefined, {}, classify, {
				signal: { index: 0, property: "signal" },
				stream: true,
			});
			expectTypeOf(pages).returns.toEqualTypeOf<Stream.Stream<number, TestError>>();
			expect(yield* Stream.runCollect(Stream.take(pages(), 3))).toStrictEqual([1, 2, 3]);
			expect(upstream.seen[0]?.aborted).toBe(true);
		}),
	);

	// Each acquisition shape, interrupted while upstream runs: upstream ignores the abort and gives its handles 20ms after
	// it was called. As Effect's `acquireRelease` runs its acquire uninterruptibly and adds its release to the scope, and
	// as 0.3.0 did, the interruption waits for the call, then leaves what it gave to the scope: the interrupter resumes
	// once upstream settled, every handle still open, and the scope releases each once as it closes.
	for (const { shape, handles, signalled, acquire } of acquirers) {
		it.live(
			`waits for ${shape} interrupted while upstream runs, and leaves what it gave to the scope, which releases it once as it closes`,
			() =>
				Effect.gen(function* () {
					const { seen } = yield* interruptedWhileRunning(acquire, handles, "ignores");
					expect(seen).toStrictEqual({
						settled: true,
						aborted: signalled ? true : undefined,
						closes: Array.from({ length: handles }, () => 0),
						closesAfterScope: Array.from({ length: handles }, () => 1),
					});
				}),
		);
	}

	// A listener finishes opening after its acquisition was interrupted, and its `close()` waits for a peer connection to
	// drain, whose cleanup the caller registers in the scope only once the interruption returned. Left to the scope, as
	// Effect's `acquireRelease` and 0.3.0 leave it, the listener closes after the peer: the scope runs its finalizers in
	// reverse order. An interruption that released the listener itself would wait for the peer, which only the caller,
	// still waiting for the interruption, cleans up.
	it.live(
		"returns from an interrupted acquisition whose handle's release waits for what the caller cleans up after it, interrupted by Fiber.interrupt or an Effect.timeout",
		() =>
			Effect.gen(function* () {
				for (const interrupter of ["Fiber.interrupt", "Effect.timeout"] as const) {
					const events: Array<string> = [];
					const peer = new Peer(events);
					const listener = new DrainingListener(peer, events);
					let called = false;
					const opener = effectify(
						{
							// Ignores its signal, and gives the listener 20ms after it was called.
							listen: (_signal: AbortSignal) => {
								called = true;
								return sleep(20, listener);
							},
						},
						{
							name: "Opener",
							spec: {
								methods: ["listen"],
								async: { listen: true },
								returns: { listen: "Listener" },
								signal: { listen: { index: 0 } },
							},
						},
						drainingKinds,
						classify,
					) as unknown as { readonly listen: () => Effect.Effect<unknown, TestError, Scope.Scope> };
					const scope = yield* Scope.make();
					const acquiring = opener.listen().pipe(Scope.provide(scope));
					const interrupting =
						interrupter === "Fiber.interrupt"
							? Effect.gen(function* () {
									const fiber = yield* Effect.forkChild(acquiring, { startImmediately: true });
									yield* waitUntil(() => called);
									yield* Fiber.interrupt(fiber);
								})
							: Effect.asVoid(Effect.exit(Effect.timeout(acquiring, "5 millis")));
					// The caller, a fiber of its own, so the test sees whether it gets past the interruption.
					const caller = yield* Effect.forkChild(
						Effect.gen(function* () {
							yield* interrupting;
							events.push("interruption returned");
							// The peer's cleanup, registered after the listener's release: the scope runs it first.
							yield* Scope.addFinalizer(
								scope,
								Effect.sync(() => peer.drain()),
							);
						}),
					);
					const returned = Option.isSome(
						yield* Fiber.await(caller).pipe(Effect.timeout("1 second"), Effect.option),
					);
					// A caller stuck in the interruption is unblocked here, from outside.
					if (!returned) {
						events.push("drained from outside");
						peer.drain();
						yield* Fiber.await(caller);
					}
					yield* Scope.close(scope, Exit.void);
					expect({ interrupter, returned, events, closes: listener.closes }).toStrictEqual({
						interrupter,
						returned: true,
						events: ["interruption returned", "peer drained", "listener closed"],
						closes: 1,
					});
				}
			}),
	);

	it.live(
		"releases at once what an interrupted acquisition gives after another fiber closed its scope, as a finalizer added to a closed scope runs",
		() =>
			Effect.gen(function* () {
				const upstream = new SlowOpener();
				const scope = yield* Scope.make();
				const fiber = yield* Effect.forkChild(slowOpener(upstream).open().pipe(Scope.provide(scope)), {
					startImmediately: true,
				});
				yield* Effect.yieldNow;
				// The interrupter waits for the interrupted acquisition, whose call settles 20ms after its abort.
				const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
				yield* Effect.yieldNow;
				yield* Scope.close(scope, Exit.void);
				expect(upstream.opened).toHaveLength(0);
				yield* Fiber.join(interrupting);
				expect(upstream.opened.map((connection) => connection.closes)).toStrictEqual([1]);
			}),
	);

	// The same where upstream honours the abort, rejecting 5ms after it: the interruption completes promptly, once the
	// call settled, and releases nothing. A call reporting through its callback takes no signal it could honour.
	for (const { shape, handles, acquire } of acquirers.filter(({ signalled }) => signalled)) {
		it.live(
			`completes the interruption of ${shape} promptly when upstream honours the abort, releasing nothing`,
			() =>
				Effect.gen(function* () {
					const { seen, waited } = yield* interruptedWhileRunning(acquire, handles, "honours");
					const never = Array.from({ length: handles }, () => 0);
					expect({ ...seen, prompt: waited < 500 }).toStrictEqual({
						settled: true,
						aborted: true,
						closes: never,
						closesAfterScope: never,
						prompt: true,
					});
				}),
		);
	}

	it.live(
		"interrupts at once a call that gives no releasable handle, aborting its signal: a value, a borrowed handle, a kind with no release",
		() =>
			Effect.gen(function* () {
				const gives: ReadonlyArray<{ readonly gives: string } & Omit<Partial<HandleKind["spec"]>, "methods">> = [
					{ gives: "a value" },
					{ gives: "a borrowed handle", returns: { open: "Connection" }, borrowed: { open: true } },
					{ gives: "a kind with no release", returns: { open: "Client" } },
				];
				for (const { gives: label, ...spec } of gives) {
					const { seen } = yield* interruptedWhileRunning(
						(give) => openerOf(give, { signal: { open: { index: 0 } }, ...spec }).open(),
						1,
						"ignores",
					);
					// The interrupter resumed before upstream settled, and nothing was released after it did.
					expect({ label, ...seen }).toStrictEqual({
						label,
						settled: false,
						aborted: true,
						closes: [0],
						closesAfterScope: [0],
					});
				}
			}),
	);

	// The cases below interrupt an acquisition whose upstream call ignores the abort and resolves with its handles 20ms
	// later: the interrupter waits for the call, and finds what it gave left to the scope, which releases it as it closes.
	it.live(
		"leaves a handle its scope already acquired to that scope when an interrupted acquisition's call gives it",
		() =>
			Effect.gen(function* () {
				const shared = new CountedConnection();
				const scope = yield* Scope.make();
				yield* opening(shared).open().pipe(Scope.provide(scope));
				const fiber = yield* Effect.forkChild(
					slowOpener(new SlowOpener(() => shared))
						.open()
						.pipe(Scope.provide(scope)),
					{ startImmediately: true },
				);
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(fiber);
				// The call gave the handle as the interruption waited for it, but the scope holds it through the first acquisition.
				expect(shared.closes).toBe(0);
				yield* Scope.close(scope, Exit.void);
				expect(shared.closes).toBe(1);
			}),
	);

	it.live(
		"leaves each handle of an interrupted acquisition's list to the scope, one the scope already holds too, released once as it closes",
		() =>
			Effect.gen(function* () {
				const fresh = new CountedConnection();
				const taken = new CountedConnection();
				const made: Array<CountedConnection> = [fresh, taken];
				const scope = yield* Scope.make();
				// A live acquisition in the scope holds the list's second handle already.
				yield* opening(taken).open().pipe(Scope.provide(scope));
				const fiber = yield* Effect.forkChild(
					slowOpener(new SlowOpener(() => made.shift()!))
						.openAll()
						.pipe(Scope.provide(scope)),
					{ startImmediately: true },
				);
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(fiber);
				expect([fresh.closes, taken.closes]).toStrictEqual([0, 0]);
				yield* Scope.close(scope, Exit.void);
				expect([fresh.closes, taken.closes]).toStrictEqual([1, 1]);
			}),
	);

	it.live(
		"leaves an interrupted acquisition's handle to the scope, whose failed release is logged as any finalizer's, once however many acquisitions give the object",
		() => {
			const logged: Array<string> = [];
			const logger = Logger.make(({ logLevel, message }) => logged.push(`${logLevel}: ${String(message)}`));
			return Effect.gen(function* () {
				const flaky = new GatedConnection(1);
				flaky.gate.resolve();
				const scope = yield* Scope.make();
				const fiber = yield* Effect.forkChild(
					slowOpener(new SlowOpener(() => flaky))
						.open()
						.pipe(Scope.provide(scope)),
					{ startImmediately: true },
				);
				yield* Effect.yieldNow;
				yield* Fiber.interrupt(fiber);
				expect([flaky.closes, flaky.closed]).toStrictEqual([0, false]);
				// A later call hands the same object back in that scope: it shares the interrupted acquisition's finalizer.
				yield* opening(flaky).open().pipe(Scope.provide(scope));
				yield* Scope.close(scope, Exit.void);
				// The scope's one release failed, and was logged as the scope closed.
				expect([flaky.closes, flaky.closed]).toStrictEqual([1, false]);
				expect(logged).toStrictEqual(["Warn: Connection.close failed while its scope closed"]);
			}).pipe(Effect.provide(Logger.layer([logger])));
		},
	);

	it.live(
		"leaves an interrupted acquisition's handle whose release method cannot even be read to the scope, which logs it as it logs one that fails",
		() => {
			const logged: Array<string> = [];
			const logger = Logger.make(({ logLevel, message }) => logged.push(`${logLevel}: ${String(message)}`));
			return Effect.gen(function* () {
				const upstream = new SlowOpener(() => trapped("close"));
				const fiber = yield* Effect.forkChild(Effect.scoped(slowOpener(upstream).open()), {
					startImmediately: true,
				});
				yield* Effect.yieldNow;
				// The fiber's scope closes as the interrupted fiber ends, before the interrupter resumes.
				yield* Fiber.interrupt(fiber);
				expect(upstream.opened).toHaveLength(1);
				expect(logged).toStrictEqual(["Warn: Connection.close failed while its scope closed"]);
			}).pipe(Effect.provide(Logger.layer([logger])));
		},
	);

	// Each case below interrupts an acquisition as upstream's call returns, before the fiber's next step: upstream aborts
	// its caller as it gives its handles, a microtask does, or a timeout fires while the fiber yields to the scheduler.
	// Whatever upstream gave has an owner from the step that called it, the scope, interrupted or not: nothing is released
	// when the acquisition's Effect ends, and each handle once when its scope closes.
	it("releases once what upstream gives as it aborts its caller, as it is or through a resolved promise", async () => {
		const runs: Array<Run> = [];
		for (const { shape, handles, acquire } of acquirers) {
			for (const form of givenForms) {
				const caller = new AbortController();
				const run = giving({ shape, form }, handles, (value) => {
					caller.abort();
					return given(value, form);
				});
				// The fiber yields first, so the caller's abort reaches it while upstream runs.
				const exit = await Effect.runPromiseExit(
					Effect.andThen(Effect.yieldNow, Effect.scoped(ending(run, acquire(run.give)))),
					{
						signal: caller.signal,
					},
				);
				resumed(run);
				expect({ shape, form, interrupted: Exit.hasInterrupts(exit) }).toStrictEqual({
					shape,
					form,
					interrupted: true,
				});
				runs.push(run);
			}
		}
		expect(await releasedOnce(runs)).toStrictEqual([]);
	});

	it("releases once what upstream gives when a microtask aborts its caller, at any operation budget of the default scheduler", async () => {
		const runs: Array<Run> = [];
		for (const { shape, handles, acquire } of acquirers) {
			for (const form of givenForms) {
				for (const hops of [0, 1]) {
					for (const budget of budgets) {
						const caller = new AbortController();
						const run = giving({ shape, form, hops, budget }, handles, (value) => {
							abortAfter(caller, hops);
							return given(value, form);
						});
						await Effect.runPromiseExit(
							Effect.scoped(ending(run, acquire(run.give))).pipe(
								Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
							),
							{ signal: caller.signal },
						);
						resumed(run);
						runs.push(run);
					}
				}
			}
		}
		expect(await releasedOnce(runs)).toStrictEqual([]);
	});

	it.live(
		"releases once what a slow acquisition gives after an Effect.timeout around it fired, at any operation budget",
		() =>
			Effect.gen(function* () {
				const runs: Array<Run> = [];
				for (const { shape, handles, acquire } of acquirers) {
					for (const budget of [...budgets.slice(0, 12), 2048]) {
						// Upstream works synchronously past the timeout, then settles later: the timeout fires as soon as the fiber
						// yields, which at a small budget is right after the call.
						const run = giving({ shape, budget }, handles, (value) => {
							busy(10);
							return sleep(10, value);
						});
						const exit = yield* Effect.exit(
							Effect.scoped(Effect.timeout(ending(run, acquire(run.give)), "5 millis")).pipe(
								Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
							),
						);
						resumed(run);
						expect({ shape, budget, failed: Exit.isFailure(exit) }).toStrictEqual({
							shape,
							budget,
							failed: true,
						});
						runs.push(run);
					}
				}
				expect(yield* Effect.promise(() => releasedOnce(runs))).toStrictEqual([]);
			}),
	);

	it("fails a call whose promise rejects while the fiber yields to the scheduler, leaving no rejection unhandled", async () => {
		const unhandled: Array<unknown> = [];
		const record = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", record);
		try {
			for (const budget of budgets) {
				const refused = openerOf(() => Promise.reject(Object.assign(new Error("refused"), { code: "E_REFUSED" })), {
					returns: { open: "Connection" },
				});
				const error = await Effect.runPromise(
					Effect.flip(Effect.asVoid(Effect.scoped(refused.open()))).pipe(
						Effect.provideService(Scheduler.MaxOpsBeforeYield, budget),
					),
				);
				expect({ budget, error }).toStrictEqual({
					budget,
					error: new TestError({ operation: "Opener.open", code: "E_REFUSED" }),
				});
			}
			// Node reports a rejection unhandled once the microtasks of its task ran.
			await sleep(5);
		} finally {
			process.off("unhandledRejection", record);
		}
		expect(unhandled).toStrictEqual([]);
	});
});

/** How an upstream call gives its value: as it is, or through a promise already resolved. */
const givenForms = ["as it is", "through a resolved promise"] as const;

/** `value` as an upstream call gives it in `form`. */
const given = (value: unknown, form: (typeof givenForms)[number]) =>
	form === "as it is" ? value : Promise.resolve(value);

/** Operation budgets of Effect's default scheduler: every count of steps before a fiber yields up to 24, and the default. */
const budgets = [...Array.from({ length: 24 }, (_, index) => index + 1), 2048];

/**
 * One acquisition of a test: what its upstream call made, whether that call ran, the call, and how often each
 * connection was released when the acquisition's Effect ended inside its scope (`ended`, by `ending`) and once that
 * scope closed (`resumed`).
 */
interface Run {
	readonly label: Readonly<Record<string, unknown>>;
	readonly made: ReadonlyArray<CountedConnection>;
	readonly give: (signal?: AbortSignal) => unknown;
	gave: boolean;
	ended?: ReadonlyArray<number>;
	resumed?: ReadonlyArray<number>;
}

/** `acquisition`, recording how often each connection of `run` was released as it ended, inside its scope. */
function ending<A, E, R>(run: Run, acquisition: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
	return Effect.onExit(acquisition, () =>
		Effect.sync(() => {
			run.ended = run.made.map((connection) => connection.closes);
		}),
	);
}

/** Records how often each connection of `run` was released once its scope closed, before anything else runs. */
function resumed(run: Run): void {
	run.resumed = run.made.map((connection) => connection.closes);
}

/**
 * A run whose call makes `handles` connections and gives them, one alone or more as a list, as `deliver` does with
 * them and the call's signal.
 */
function giving(
	label: Readonly<Record<string, unknown>>,
	handles: number,
	deliver: (value: unknown, signal?: AbortSignal) => unknown,
): Run {
	const made = Array.from({ length: handles }, () => new CountedConnection());
	const run: Run = {
		label,
		made,
		gave: false,
		give: (signal) => {
			run.gave = true;
			return deliver(handles === 1 ? made[0] : made, signal);
		},
	};
	return run;
}

/**
 * An upstream call that records its signal and whether it settled: ignoring the signal's abort, it gives its value 20ms
 * after it was called (`ignores`); honouring it, it rejects 5ms after the abort, and gives its value after a second
 * without one (`honours`).
 */
class LateUpstream {
	signal: AbortSignal | undefined;
	settled = false;
	readonly mode: "ignores" | "honours";
	constructor(mode: "ignores" | "honours") {
		this.mode = mode;
	}
	/** The call, as `giving` delivers its value. */
	readonly deliver = (value: unknown, signal?: AbortSignal): Promise<unknown> =>
		new Promise((resolve, reject) => {
			this.signal = signal;
			const after = (millis: number, settle: () => void) =>
				setTimeout(() => {
					this.settled = true;
					settle();
				}, millis);
			if (this.mode === "ignores") {
				after(20, () => resolve(value));
				return;
			}
			const fallback = after(1000, () => resolve(value));
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(fallback);
					after(5, () => reject(signal.reason));
				},
				{ once: true },
			);
		});
}

/**
 * Interrupts `acquire`'s call of an upstream in `mode` (`LateUpstream`) while upstream runs, then closes the scope it
 * acquired in and waits until upstream settled: whether upstream had settled and its signal aborted when the
 * interrupter resumed, how often each connection it made was released then and in the end, and how long the
 * interruption took.
 */
const interruptedWhileRunning = (
	acquire: (give: (signal?: AbortSignal) => unknown) => Effect.Effect<unknown, TestError, Scope.Scope>,
	handles: number,
	mode: "ignores" | "honours",
) =>
	Effect.gen(function* () {
		const upstream = new LateUpstream(mode);
		const run = giving({ mode }, handles, upstream.deliver);
		const scope = yield* Scope.make();
		const fiber = yield* Effect.forkChild(acquire(run.give).pipe(Scope.provide(scope)), { startImmediately: true });
		expect(yield* waitUntil(() => run.gave)).toBe(true);
		const started = performance.now();
		yield* Fiber.interrupt(fiber);
		const waited = performance.now() - started;
		const closes = () => run.made.map((connection) => connection.closes);
		const resumed = { settled: upstream.settled, aborted: upstream.signal?.aborted, closes: closes() };
		yield* Scope.close(scope, Exit.void);
		expect(yield* waitUntil(() => upstream.settled, 1500)).toBe(true);
		yield* Effect.sleep("5 millis");
		return { seen: { ...resumed, closesAfterScope: closes() }, waited };
	});

/** Aborts `controller` after `hops` more microtasks. */
function abortAfter(controller: AbortController, hops: number): void {
	queueMicrotask(() => (hops === 0 ? controller.abort() : abortAfter(controller, hops - 1)));
}

/** Blocks the thread for `millis`, as upstream's synchronous work does. */
function busy(millis: number): void {
	const until = performance.now() + millis;
	while (performance.now() < until) {
		// Upstream's synchronous work.
	}
}

/**
 * The runs whose connections were released before their acquisition's Effect ended inside its scope (`ended`; none
 * recorded where the acquisition never started), or not exactly once (none where the call never ran) once that scope
 * closed (`resumed`) or again a little later, with how often each was at each of those moments.
 */
async function releasedOnce(runs: ReadonlyArray<Run>): Promise<Array<Record<string, unknown>>> {
	await sleep(10);
	return runs
		.filter((run) => {
			const none = run.made.map(() => 0);
			const once = run.made.map(() => (run.gave ? 1 : 0));
			const later = run.made.map((connection) => connection.closes);
			return (
				!isDeepStrictEqual(run.ended ?? none, none) ||
				!isDeepStrictEqual(run.resumed, once) ||
				!isDeepStrictEqual(later, once)
			);
		})
		.map((run) => ({
			...run.label,
			ended: run.ended,
			resumed: run.resumed,
			later: run.made.map((connection) => connection.closes),
		}));
}

/** A connection whose member `name` throws when read, as a getter of upstream's may. */
function trapped(name: string): CountedConnection {
	const connection = new CountedConnection();
	Object.defineProperty(connection, name, {
		get: () => {
			throw new Error(`reading ${name} failed`);
		},
	});
	return connection;
}

/** A peer connection a `DrainingListener`'s release waits for: `drain` ends it. Each step is recorded in `events`. */
class Peer {
	readonly drained = Promise.withResolvers<void>();
	readonly events: Array<string>;
	constructor(events: Array<string>) {
		this.events = events;
	}
	drain(): void {
		this.events.push("peer drained");
		this.drained.resolve();
	}
}

/** A listener whose `close()` resolves once its peer drained, as a server's close waits for its connections. */
class DrainingListener {
	closes = 0;
	readonly peer: Peer;
	readonly events: Array<string>;
	constructor(peer: Peer, events: Array<string>) {
		this.peer = peer;
		this.events = events;
	}
	async close(): Promise<void> {
		await this.peer.drained.promise;
		this.closes++;
		this.events.push("listener closed");
	}
}

const drainingKinds: Record<string, HandleKind> = {
	Listener: { name: "Listener", spec: { methods: ["close"], async: { close: true } }, release: "close" },
};

describe("acquisition", () => {
	it.effect("registers a handle's release before wrapping it: a wrap that throws still releases the handle", () =>
		Effect.gen(function* () {
			const asynchronous = trapped("query");
			const opener = effectify(
				{ open: async () => asynchronous },
				{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: "Connection" } } },
				kinds,
				classify,
			) as unknown as { readonly open: () => Effect.Effect<ConnectionFacade, TestError, Scope.Scope> };
			expect(Exit.isFailure(yield* Effect.exit(Effect.scoped(opener.open())))).toBe(true);
			expect(asynchronous.closes).toBe(1);
			// The synchronous path, an exported function that makes the handle as it returns.
			const synchronous = trapped("query");
			const make = () => synchronous;
			const made = entry<typeof make, TestError, Handles>(make, "make", kinds["Connection"], kinds, classify);
			expect(Exit.isFailure(yield* Effect.exit(Effect.scoped(made())))).toBe(true);
			expect(synchronous.closes).toBe(1);
			// A list: every handle's release is registered before any is wrapped.
			const listed = [new CountedConnection(), trapped("query")];
			const lister = effectify(
				{ all: async () => listed },
				{ name: "Lister", spec: { methods: ["all"], async: { all: true }, lists: { all: "Connection" } } },
				kinds,
				classify,
			) as unknown as { readonly all: () => Effect.Effect<ReadonlyArray<ConnectionFacade>, TestError, Scope.Scope> };
			expect(Exit.isFailure(yield* Effect.exit(Effect.scoped(lister.all())))).toBe(true);
			expect(listed.map((connection) => connection.closes)).toStrictEqual([1, 1]);
		}),
	);

	it.effect(
		"releases each acquired handle once, one a list holds twice too, and one the caller released through its facade again",
		() =>
			Effect.gen(function* () {
				const lister = (listed: ReadonlyArray<CountedConnection>) =>
					effectify(
						{ all: async () => listed },
						{ name: "Lister", spec: { methods: ["all"], async: { all: true }, lists: { all: "Connection" } } },
						kinds,
						classify,
					) as unknown as {
						readonly all: () => Effect.Effect<ReadonlyArray<ConnectionFacade>, TestError, Scope.Scope>;
					};
				const shared = new CountedConnection();
				yield* Effect.scoped(lister([shared, shared]).all());
				expect(shared.closes).toBe(1);
				// Released through its facade while the scope is open: the scope still releases it as it closes, as Effect's
				// `acquireRelease` does, once however many entries of the list hold it.
				const released = [new CountedConnection(), new CountedConnection(), new CountedConnection()];
				yield* Effect.scoped(
					Effect.flatMap(lister([released[0]!, released[1]!, released[0]!, released[2]!]).all(), (facades) =>
						Effect.andThen(facades[2]!.close(), facades[1]!.close()),
					),
				);
				expect(released.map((connection) => connection.closes)).toStrictEqual([2, 2, 1]);
				// One handle, made by an async method, released through its facade, and by its scope.
				const opened = new CountedConnection();
				const opener = effectify(
					{ open: async () => opened },
					{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: "Connection" } } },
					kinds,
					classify,
				) as unknown as { readonly open: () => Effect.Effect<ConnectionFacade, TestError, Scope.Scope> };
				yield* Effect.scoped(Effect.flatMap(opener.open(), (connection) => connection.close()));
				expect(opened.closes).toBe(2);
			}),
	);

	it.effect("releases a handle whose release through its facade failed as its scope closes", () =>
		Effect.gen(function* () {
			const flaky = new FlakyConnection();
			const closed = yield* Effect.scoped(
				Effect.flatMap(opening(flaky).open(), (connection) => Effect.exit(connection.close())),
			);
			expect(Exit.isFailure(closed)).toBe(true);
			// The facade's release failed, the scope's finalizer released it, and that release succeeded.
			expect([flaky.attempts, flaky.closed]).toStrictEqual([2, true]);
		}),
	);

	it.effect("releases one upstream object once in a scope, however many calls hand it back", () =>
		Effect.gen(function* () {
			const acquiredTwice = new CountedConnection();
			yield* Effect.scoped(Effect.andThen(opening(acquiredTwice).open(), opening(acquiredTwice).open()));
			expect(acquiredTwice.closes).toBe(1);
			// Released through one acquisition's facade: the scope releases it once more, for both acquisitions.
			const shared = new CountedConnection();
			yield* Effect.scoped(
				Effect.flatMap(Effect.all([opening(shared).open(), opening(shared).open()]), ([first]) => first.close()),
			);
			expect(shared.closes).toBe(2);
		}),
	);

	it.effect(
		"releases an object a call acquires as a releasable kind after a choice gave it as a kind with no release",
		() =>
			Effect.gen(function* () {
				// The choice takes the first kind whose methods the object has: a snapshot, which has no release.
				const choosing: Record<string, HandleKind> = {
					...kinds,
					Snapshot: {
						name: "Snapshot",
						spec: { methods: ["query", "rows"], async: { query: true }, stream: { rows: true } },
					},
					Peeker: {
						name: "Peeker",
						spec: {
							methods: ["peek", "open"],
							async: { peek: true, open: true },
							choices: { peek: ["Snapshot", "Connection"] },
							returns: { open: "Connection" },
						},
					},
				};
				const connection = new CountedConnection();
				const peeker = effectify(
					{ peek: async () => connection, open: async () => connection },
					choosing["Peeker"]!,
					choosing,
					classify,
				) as unknown as {
					readonly peek: () => Effect.Effect<unknown, TestError, Scope.Scope>;
					readonly open: () => Effect.Effect<ConnectionFacade, TestError, Scope.Scope>;
				};
				yield* Effect.scoped(Effect.andThen(peeker.peek(), peeker.open()));
				expect(connection.closes).toBe(1);
			}),
	);
});

/** A facade whose async `open` hands out `connection`, the caller's: acquired in its scope. */
function opening(connection: Connection) {
	return effectify(
		{ open: async () => connection },
		{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: "Connection" } } },
		kinds,
		classify,
	) as unknown as { readonly open: () => Effect.Effect<ConnectionFacade, TestError, Scope.Scope> };
}

/** A connection whose first release fails and whose next one succeeds. */
class FlakyConnection extends Connection {
	attempts = 0;
	override async close(): Promise<void> {
		this.attempts++;
		if (this.attempts === 1) throw new Error("busy");
		await super.close();
	}
}

/** A connection that counts how often it is released. */
class CountedConnection extends Connection {
	closes = 0;
	override async close(): Promise<void> {
		this.closes++;
		await super.close();
	}
}

/**
 * A connection whose release, once started, waits until the test opens its gate, and whose first `failures` releases
 * then fail; `closes` counts every attempt.
 */
class GatedConnection extends CountedConnection {
	readonly started = Promise.withResolvers<void>();
	readonly gate = Promise.withResolvers<void>();
	readonly failures: number;
	constructor(failures = 0) {
		super();
		this.failures = failures;
	}
	override async close(): Promise<void> {
		this.started.resolve();
		await this.gate.promise;
		if (this.closes < this.failures) {
			this.closes++;
			throw new Error("busy");
		}
		await super.close();
	}
}

/**
 * A handle with a release of each form a release takes: `close` returns, `end` resolves, `stop` reports through its
 * callback. Its first `failures` releases fail; each that succeeds says which call it was.
 */
class Valve {
	calls = 0;
	shut = false;
	readonly failures: number;
	constructor(failures = 0) {
		this.failures = failures;
	}
	close(): string {
		this.calls++;
		if (this.calls <= this.failures) throw new Error(`busy ${this.calls}`);
		this.shut = true;
		return `shut by call ${this.calls}`;
	}
	async end(): Promise<string> {
		return this.close();
	}
	stop(callback: (error: Error | null, result?: string) => void): void {
		// Called without a callback (a finalizer that ignores the release's form), it throws at once, not later in its
		// timer, where the throw would be uncaught.
		if (typeof callback !== "function") throw new TypeError("stop needs a callback");
		setTimeout(() => {
			let result: string;
			try {
				result = this.close();
			} catch (error) {
				return callback(error as Error);
			}
			callback(null, result);
		}, 1);
	}
}

/** A facade of a `Valve`, typed loosely: each kind below offers one of these, its release. */
interface ValveFacade {
	readonly close: () => string;
	readonly end: () => Effect.Effect<string, TestError>;
	readonly stop: () => Effect.Effect<string, TestError>;
}

const valveKinds: Record<string, HandleKind> = {
	SyncValve: { name: "SyncValve", spec: { methods: ["close"], async: {} }, release: "close" },
	PromiseValve: { name: "PromiseValve", spec: { methods: ["end"], async: { end: true } }, release: "end" },
	CallbackValve: {
		name: "CallbackValve",
		spec: { methods: ["stop"], async: {}, callback: { stop: "node" } },
		release: "stop",
	},
};

/** A facade whose async `open` hands out `valve` as a handle of `kind`, the caller's: acquired in its scope. */
const valveOpening = (valve: Valve, kind: string) =>
	effectify(
		{ open: async () => valve },
		{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: kind } } },
		valveKinds,
		classify,
	) as unknown as { readonly open: () => Effect.Effect<ValveFacade, TestError, Scope.Scope> };

/** Each form a release takes, called through a facade as an Effect of its result. */
const releaseForms = [
	{
		form: "synchronous",
		kind: "SyncValve",
		// A synchronous release throws the facade's error, classified.
		release: (valve: ValveFacade) =>
			Effect.try({
				try: () => valve.close(),
				catch: (thrown) =>
					thrown instanceof TestError ? thrown : new TestError({ operation: "not the facade's error" }),
			}),
	},
	{ form: "promise", kind: "PromiseValve", release: (valve: ValveFacade) => valve.end() },
	{ form: "callback", kind: "CallbackValve", release: (valve: ValveFacade) => valve.stop() },
] as const;

describe("the scope's release and a user's, in every form", () => {
	for (const { form, kind, release } of releaseForms) {
		it.live(`releases in its ${form} form as the scope closes, after a user's call of it failed`, () =>
			Effect.gen(function* () {
				const valve = new Valve(1);
				const released = yield* Effect.scoped(
					Effect.flatMap(valveOpening(valve, kind).open(), (facade) => Effect.exit(release(facade))),
				);
				expect(Exit.isFailure(released)).toBe(true);
				// The scope's finalizer released it in its form (a callback release is given one), and succeeded.
				expect([valve.calls, valve.shut]).toStrictEqual([2, true]);
			}),
		);

		it.live(
			`runs every repeated ${form} release, through any facade, each giving its own value; the scope's finalizer then releases once more`,
			() =>
				Effect.gen(function* () {
					const valve = new Valve();
					const results = yield* Effect.scoped(
						Effect.flatMap(
							Effect.all([valveOpening(valve, kind).open(), valveOpening(valve, kind).open()]),
							([first, second]) => Effect.all([release(first), release(first), release(second)]),
						),
					).pipe(Effect.timeout("1 second"));
					expect(results).toStrictEqual(["shut by call 1", "shut by call 2", "shut by call 3"]);
					// One finalizer for the two acquisitions of the valve.
					expect(valve.calls).toBe(4);
				}),
		);
	}

	it.live(
		"runs a release called while another runs now without waiting for it, and the scope's finalizer releases once more",
		() =>
			Effect.gen(function* () {
				for (const { kind, release } of releaseForms.slice(1)) {
					const valve = new Valve();
					const results = yield* Effect.scoped(
						Effect.flatMap(valveOpening(valve, kind).open(), (facade) =>
							Effect.all([release(facade), release(facade)], { concurrency: "unbounded" }),
						),
					).pipe(Effect.timeout("1 second"));
					expect([results, valve.calls]).toStrictEqual([["shut by call 1", "shut by call 2"], 3]);
					const flaky = new Valve(1);
					const settled = yield* Effect.scoped(
						Effect.flatMap(valveOpening(flaky, kind).open(), (facade) =>
							Effect.all([Effect.exit(release(facade)), release(facade)], { concurrency: "unbounded" }),
						),
					).pipe(Effect.timeout("1 second"));
					expect([Exit.isFailure(settled[0]), settled[1], flaky.calls]).toStrictEqual([true, "shut by call 2", 3]);
				}
			}),
	);

	it.live(
		"runs a release after the scope released the handle, its value showing what upstream kept of a secret concealed",
		() =>
			Effect.gen(function* () {
				// A release whose result holds a secret upstream kept, as a facade's release shows it: `Redacted`.
				const keeper = { calls: 0, end: async () => ({ calls: ++keeper.calls, auth: { pass: "hunter22" } }) };
				const kept: Record<string, HandleKind> = {
					Keeper: {
						name: "Keeper",
						spec: { methods: ["end"], async: { end: true }, concealed: [["auth", "pass"]] },
						release: "end",
					},
				};
				const opener = effectify(
					{ open: async () => keeper },
					{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: "Keeper" } } },
					kept,
					classify,
				) as unknown as {
					readonly open: () => Effect.Effect<
						{
							readonly end: () => Effect.Effect<
								{ readonly calls: number; readonly auth: { readonly pass: unknown } },
								TestError
							>;
						},
						TestError,
						Scope.Scope
					>;
				};
				// The scope's finalizer released it; the facade outlives the scope, and its call reaches upstream.
				const facade = yield* Effect.scoped(opener.open());
				const again = yield* facade.end();
				expect([keeper.calls, again.calls]).toStrictEqual([2, 2]);
				expect(Redacted.isRedacted(again.auth.pass)).toBe(true);
			}),
	);
});

/**
 * A handle whose primary release is `close` and which `disconnect` also lets go of without closing it, as puppeteer's
 * `Browser` and bullmq's `Queue` do: each says which of its calls it was.
 */
class Session {
	closes = 0;
	disconnects = 0;
	async close(): Promise<string> {
		this.closes++;
		return `closed by call ${this.closes}`;
	}
	async disconnect(): Promise<string> {
		this.disconnects++;
		return `disconnected by call ${this.disconnects}`;
	}
}

/** A facade of a `Session`, typed loosely. */
interface SessionFacade {
	readonly close: () => Effect.Effect<string, TestError>;
	readonly disconnect: () => Effect.Effect<string, TestError>;
}

const sessionKinds: Record<string, HandleKind> = {
	Session: {
		name: "Session",
		spec: { methods: ["close", "disconnect"], async: { close: true, disconnect: true } },
		release: "close",
		releases: ["close", "disconnect"],
	},
};

/** A facade whose async `open` hands out `session`, the caller's: acquired in its scope. */
const sessionOpening = (session: Session) =>
	effectify(
		{ open: async () => session },
		{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: "Session" } } },
		sessionKinds,
		classify,
	) as unknown as { readonly open: () => Effect.Effect<SessionFacade, TestError, Scope.Scope> };

describe("release methods besides the primary release", () => {
	it.effect("leaves the handle to the scope after `disconnect`: the scope's finalizer still closes it", () =>
		Effect.gen(function* () {
			const session = new Session();
			yield* Effect.scoped(Effect.flatMap(sessionOpening(session).open(), (facade) => facade.disconnect()));
			expect([session.disconnects, session.closes]).toStrictEqual([1, 1]);
		}),
	);

	it.effect("runs `close` after `disconnect`, and the scope's finalizer then closes the handle once more", () =>
		Effect.gen(function* () {
			const session = new Session();
			const results = yield* Effect.scoped(
				Effect.flatMap(sessionOpening(session).open(), (facade) =>
					Effect.all([facade.disconnect(), facade.close()]),
				),
			);
			expect(results).toStrictEqual(["disconnected by call 1", "closed by call 1"]);
			expect([session.disconnects, session.closes]).toStrictEqual([1, 2]);
		}),
	);

	it.effect("runs `disconnect` after `close` on its own, and the scope's finalizer still calls `close`", () =>
		Effect.gen(function* () {
			const session = new Session();
			const results = yield* Effect.scoped(
				Effect.flatMap(sessionOpening(session).open(), (facade) =>
					Effect.all([facade.close(), facade.disconnect()]),
				),
			);
			expect(results).toStrictEqual(["closed by call 1", "disconnected by call 1"]);
			expect([session.disconnects, session.closes]).toStrictEqual([1, 2]);
		}),
	);

	it.effect(
		"runs every call of each release method, through any facade of the object, each giving its own value",
		() =>
			Effect.gen(function* () {
				const session = new Session();
				const results = yield* Effect.scoped(
					Effect.flatMap(
						Effect.all([sessionOpening(session).open(), sessionOpening(session).open()]),
						([first, second]) =>
							Effect.all([first.disconnect(), second.disconnect(), first.close(), second.close()]),
					),
				);
				expect(results).toStrictEqual([
					"disconnected by call 1",
					"disconnected by call 2",
					"closed by call 1",
					"closed by call 2",
				]);
				// And the scope's finalizer, one for both acquisitions, closed it once more.
				expect([session.disconnects, session.closes]).toStrictEqual([2, 3]);
			}),
	);
});

/**
 * A handle whose `close()` releases it and returns it, as Node's `Server.close(): this`, while `close(mode)` steps to a
 * new handle made from it; `end()` steps back to the handle it was made from, as cheerio's selection does, and
 * `finish()` does the same through a promise, once `gate` opens. Each counts its calls that release or step back.
 */
class Branch {
	closes = 0;
	ends = 0;
	readonly previous: Branch | undefined;
	readonly started = Promise.withResolvers<void>();
	readonly gate = Promise.withResolvers<void>();
	constructor(previous?: Branch) {
		this.previous = previous;
	}
	close(): this;
	close(mode: string): Branch;
	close(mode?: string): this | Branch {
		if (mode !== undefined) return new Branch(this);
		this.closes++;
		return this;
	}
	end(): Branch {
		this.ends++;
		return this.previous ?? new Branch();
	}
	async finish(): Promise<Branch> {
		this.started.resolve();
		await this.gate.promise;
		return this.end();
	}
}

/** A facade of a `Branch`, typed loosely: each kind below offers one of these, its release. */
interface BranchFacade {
	readonly upstream: Branch;
	readonly close: (mode?: string) => BranchFacade;
	readonly end: () => BranchFacade;
	readonly finish: () => Effect.Effect<BranchFacade, TestError>;
}

// Each kind releases a branch with one method, which may also step to another branch: the result a borrowed branch.
const branchKinds: Record<string, HandleKind> = {
	Closing: {
		name: "Closing",
		spec: { methods: ["close"], async: {}, returns: { close: "Closing" }, borrowed: { close: true } },
		release: "close",
	},
	Ending: {
		name: "Ending",
		spec: { methods: ["end"], async: {}, returns: { end: "Ending" }, borrowed: { end: true } },
		release: "end",
	},
	Finishing: {
		name: "Finishing",
		spec: {
			methods: ["finish"],
			async: { finish: true },
			returns: { finish: "Finishing" },
			borrowed: { finish: true },
		},
		release: "finish",
	},
};

/** A facade whose async `open` hands out `branch` as a handle of `kind`, the caller's: acquired in its scope. */
const branchOpening = (branch: Branch, kind: string) =>
	effectify(
		{ open: async () => branch },
		{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: kind } } },
		branchKinds,
		classify,
	) as unknown as { readonly open: () => Effect.Effect<BranchFacade, TestError, Scope.Scope> };

describe("a release method's call that may step to another handle", () => {
	it.effect("runs a call with an argument as it is, and the scope still releases: `close(mode)` steps elsewhere", () =>
		Effect.gen(function* () {
			const branch = new Branch();
			const children = yield* Effect.scoped(
				Effect.map(branchOpening(branch, "Closing").open(), (facade) => [
					facade.close("traverse").upstream,
					facade.close("traverse").upstream,
				]),
			);
			// Two calls, two handles, each made from the branch; and the scope's finalizer called `close()` once.
			expect(children[0]).not.toBe(children[1]);
			expect(children.map((child) => child.previous)).toStrictEqual([branch, branch]);
			expect(branch.closes).toBe(1);
		}),
	);

	it.effect("runs each `close()` that gives its receiver, and the scope's finalizer closes it once more", () =>
		Effect.gen(function* () {
			const branch = new Branch();
			const given = yield* Effect.scoped(
				Effect.map(branchOpening(branch, "Closing").open(), (facade) => [
					facade.close().upstream,
					facade.close().upstream,
				]),
			);
			expect(given).toStrictEqual([branch, branch]);
			expect(branch.closes).toBe(3);
		}),
	);

	it.effect(
		"runs a call in the release's form that steps to another handle each time, and the scope still releases",
		() =>
			Effect.gen(function* () {
				const previous = new Branch();
				const branch = new Branch(previous);
				const synchronous = yield* Effect.scoped(
					Effect.map(branchOpening(branch, "Ending").open(), (facade) => [
						facade.end().upstream,
						facade.end().upstream,
					]),
				);
				// cheerio's `end()`: the selection before, at every call, and the scope's finalizer still ends the selection.
				expect(synchronous).toStrictEqual([previous, previous]);
				expect(branch.ends).toBe(3);
				const later = new Branch(previous);
				later.gate.resolve();
				const promised = yield* Effect.scoped(
					Effect.flatMap(branchOpening(later, "Finishing").open(), (facade) =>
						Effect.all([facade.finish(), facade.finish()]),
					),
				);
				expect(promised.map((facade) => facade.upstream)).toStrictEqual([previous, previous]);
				expect(later.ends).toBe(3);
			}),
	);

	it.live("runs the scope's release while a step through the release method still runs, without waiting for it", () =>
		Effect.gen(function* () {
			const previous = new Branch();
			const branch = new Branch(previous);
			const scope = yield* Scope.make();
			const facade = yield* Scope.provide(scope)(branchOpening(branch, "Finishing").open());
			// The step waits for its gate; the scope closes meanwhile, and its finalizer calls `finish()` at once, which
			// waits for the same gate.
			const stepping = yield* Effect.forkDetach(facade.finish());
			yield* Effect.promise(() => branch.started.promise);
			const closing = yield* Effect.forkDetach(Scope.close(scope, Exit.void));
			yield* Effect.sleep("10 millis");
			expect(branch.ends).toBe(0);
			branch.gate.resolve();
			const stepped = yield* Fiber.join(stepping);
			yield* Fiber.join(closing).pipe(Effect.timeout("1 second"));
			expect(stepped.upstream).toBe(previous);
			expect(branch.ends).toBe(2);
		}),
	);
});

/** A listener whose `close()` releases it and resolves to it, as `close(): Promise<this>` declares. */
class Listener {
	closes = 0;
	async close(): Promise<this> {
		this.closes++;
		return this;
	}
}

/** A facade of a `Listener`, typed loosely: `close` resolves to the listener's facade, borrowed. */
interface ListenerFacade {
	readonly upstream: Listener;
	readonly close: () => Effect.Effect<ListenerFacade, TestError>;
}

// `close()` gives its receiver, as the generator reads `this`: a borrowed facade of it.
const listenerKinds: Record<string, HandleKind> = {
	Listener: {
		name: "Listener",
		spec: { methods: ["close"], async: { close: true }, returns: { close: "Listener" }, borrowed: { close: true } },
		release: "close",
	},
};

describe("a user's call of a release, which always reaches upstream", () => {
	it.effect(
		"runs a user's `close()` at every call, through any facade, and the scope's finalizer then releases once more",
		() =>
			Effect.gen(function* () {
				const closedTwice = new CountedConnection();
				yield* Effect.scoped(
					Effect.flatMap(opening(closedTwice).open(), (connection) =>
						Effect.andThen(connection.close(), connection.close()),
					),
				);
				// Both calls reached upstream, as in 0.3.0 and as the library itself does, and so did the scope's release.
				expect(closedTwice.closes).toBe(3);
				const shared = new CountedConnection();
				yield* Effect.scoped(
					Effect.flatMap(Effect.all([opening(shared).open(), opening(shared).open()]), ([first, second]) =>
						Effect.andThen(first.close(), second.close()),
					),
				);
				expect(shared.closes).toBe(3);
			}),
	);

	it.effect(
		"reaches upstream from an escaped facade's `close(): Promise<this>` after its scope closed, and gives a facade",
		() =>
			Effect.gen(function* () {
				const listener = new Listener();
				const opener = effectify(
					{ open: async () => listener },
					{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: "Listener" } } },
					listenerKinds,
					classify,
				) as unknown as { readonly open: () => Effect.Effect<ListenerFacade, TestError, Scope.Scope> };
				// The scope's finalizer closed the listener; the facade outlives the scope.
				const facade = yield* Effect.scoped(opener.open());
				expect(listener.closes).toBe(1);
				const closed = yield* facade.close();
				// This call's own value, wrapped by this call: the listener's facade, never upstream's object.
				expect(closed).not.toBe(listener);
				expect(closed.upstream).toBe(listener);
				expect(listener.closes).toBe(2);
			}),
	);

	it.live("runs the scope's release while a user's release is in flight, without waiting for it", () =>
		Effect.gen(function* () {
			const gated = new GatedConnection();
			const scope = yield* Scope.make();
			const facade = yield* opening(gated).open().pipe(Scope.provide(scope));
			const closing = yield* Effect.forkDetach(facade.close());
			yield* Effect.promise(() => gated.started.promise);
			const ending = yield* Effect.forkDetach(Scope.close(scope, Exit.void));
			yield* Effect.sleep("10 millis");
			// Both calls wait for the gate: the scope's started without waiting for the user's.
			expect(gated.closes).toBe(0);
			gated.gate.resolve();
			yield* Fiber.join(closing);
			yield* Fiber.join(ending).pipe(Effect.timeout("1 second"));
			expect(gated.closes).toBe(2);
		}),
	);

	it.live(
		"leaves the handle to the scope's finalizer when a user's release is interrupted before upstream reported",
		() =>
			Effect.gen(function* () {
				const gated = new GatedConnection();
				const scope = yield* Scope.make();
				const facade = yield* opening(gated).open().pipe(Scope.provide(scope));
				const closing = yield* Effect.forkDetach(facade.close());
				yield* Effect.promise(() => gated.started.promise);
				yield* Fiber.interrupt(closing);
				gated.gate.resolve();
				yield* Scope.close(scope, Exit.void).pipe(Effect.timeout("1 second"));
				// The interrupted call's upstream promise went on and closed it once; the finalizer closed it again.
				expect(gated.closes).toBe(2);
			}),
	);
});

/**
 * A TCP server as a library wraps one: `shutdown()` stops listening and resolves once every open connection has ended,
 * and resolves at once when the server no longer listens. (Node's own `close(callback)` on a stopped server reports
 * only once the connections end too.)
 */
class Serving {
	readonly server: Server;
	shutdowns = 0;
	constructor(server: Server) {
		this.server = server;
	}
	shutdown(): Promise<void> {
		this.shutdowns++;
		if (!this.server.listening) return Promise.resolve();
		return new Promise((resolve) => this.server.close(() => resolve()));
	}
}

/** A listener that can listen again after it closed, as Node's `Server` can. */
class Restartable {
	listening = false;
	closes = 0;
	listen(): void {
		this.listening = true;
	}
	async close(): Promise<void> {
		this.closes++;
		this.listening = false;
	}
}

const scopedKinds: Record<string, HandleKind> = {
	Serving: { name: "Serving", spec: { methods: ["shutdown"], async: { shutdown: true } }, release: "shutdown" },
	Socket: { name: "Socket", spec: { methods: ["destroy"], async: {} }, release: "destroy" },
	Restartable: {
		name: "Restartable",
		spec: { methods: ["listen", "close"], async: { close: true } },
		release: "close",
	},
};

/** Marks the fibers `Stepper` holds: an acquisition's, whose interruption hands what its call gave to the scope. */
const Held = Context.Reference<boolean>("test/Held", { defaultValue: () => false });

/**
 * A scheduler that, while `holding`, pauses every fiber marked `Held` before each of its operations: the fiber yields,
 * and its next step waits in `held` until the test runs it (`step`) or lets it run on (`release`). Every other fiber
 * runs as Effect's default scheduler runs it.
 */
class Stepper implements Scheduler.Scheduler {
	readonly executionMode = "async";
	readonly base = new Scheduler.MixedScheduler();
	readonly held: Array<() => void> = [];
	holding = false;
	// Set when a held fiber is told to yield: the task it schedules right after is its next step.
	yielding = false;
	shouldYield(fiber: Fiber.Fiber<unknown, unknown>): boolean {
		if (!this.holding || !fiber.getRef(Held)) return this.base.shouldYield(fiber);
		this.yielding = true;
		return true;
	}
	makeDispatcher(): Scheduler.SchedulerDispatcher {
		const base = this.base.makeDispatcher();
		return {
			scheduleTask: (task, priority) => {
				if (!this.yielding) return base.scheduleTask(task, priority);
				this.yielding = false;
				this.held.push(task);
			},
			flush: () => base.flush(),
		};
	}
	/** Runs the held fiber's next operation; false when it has none waiting. */
	step(): boolean {
		const task = this.held.shift();
		task?.();
		return task !== undefined;
	}
	release(): void {
		this.holding = false;
		for (let task = this.held.shift(); task !== undefined; task = this.held.shift()) task();
	}
}

/** Waits, a millisecond at a time and for at most `limit` of them, until `ready` holds; whether it does. */
const waitUntil = (ready: () => boolean, limit = 200) =>
	Effect.gen(function* () {
		for (let waited = 0; waited < limit && !ready(); waited++) yield* Effect.sleep("1 millis");
		return ready();
	});

describe("the scope's release, whatever a user's call of it did", () => {
	it.live(
		"closes the scope while a user's release waits for what a later finalizer releases: a TCP server's shutdown and its client",
		() =>
			Effect.gen(function* () {
				const server = createServer();
				const accepted = new Set<Socket>();
				server.on("connection", (socket) => accepted.add(socket));
				yield* Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
				const { port } = server.address() as AddressInfo;
				const serving = new Serving(server);
				const clients: Array<Socket> = [];
				const opener = effectify(
					{
						connect: () =>
							new Promise<Socket>((resolve) => {
								const client = connect(port, "127.0.0.1", () => resolve(client));
								clients.push(client);
							}),
						serve: async () => serving,
					},
					{
						name: "Opener",
						spec: {
							methods: ["connect", "serve"],
							async: { connect: true, serve: true },
							returns: { connect: "Socket", serve: "Serving" },
						},
					},
					scopedKinds,
					classify,
				) as unknown as {
					readonly connect: () => Effect.Effect<unknown, TestError, Scope.Scope>;
					readonly serve: () => Effect.Effect<
						{ readonly shutdown: () => Effect.Effect<void, TestError> },
						TestError,
						Scope.Scope
					>;
				};
				const scope = yield* Scope.make();
				// The client is acquired first, so its finalizer runs last: the server's runs while the connection is open.
				yield* opener.connect().pipe(Scope.provide(scope));
				// Accepted, so the server waits for it as it shuts down: a connection still in the backlog is reset instead.
				expect(yield* waitUntil(() => accepted.size === 1)).toBe(true);
				const facade = yield* opener.serve().pipe(Scope.provide(scope));
				// The user's shutdown stops listening, then waits for the connection, which only the client's finalizer ends.
				const shutdown = yield* Effect.forkDetach(Effect.exit(facade.shutdown()));
				yield* waitUntil(() => !server.listening);
				const closing = yield* Effect.forkDetach(Scope.close(scope, Exit.void));
				const closed = yield* Fiber.await(closing).pipe(Effect.timeout("3 seconds"), Effect.option);
				// Whatever happened, nothing stays open: a scope that hung is unblocked here.
				for (const socket of [...clients, ...accepted]) socket.destroy();
				const shut = yield* Fiber.join(shutdown).pipe(Effect.timeout("3 seconds"));
				expect(Option.map(closed, Exit.isSuccess)).toStrictEqual(Option.some(true));
				expect(Exit.isSuccess(shut)).toBe(true);
				// The scope's shutdown was a second call, which found the server no longer listening.
				expect(serving.shutdowns).toBe(2);
			}),
	);

	it.effect("releases a handle the user released and started again as its scope closes", () =>
		Effect.gen(function* () {
			const restartable = new Restartable();
			const opener = effectify(
				{ open: async () => restartable },
				{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: "Restartable" } } },
				scopedKinds,
				classify,
			) as unknown as {
				readonly open: () => Effect.Effect<
					{ readonly listen: () => void; readonly close: () => Effect.Effect<void, TestError> },
					TestError,
					Scope.Scope
				>;
			};
			yield* Effect.scoped(
				Effect.flatMap(opener.open(), (facade) =>
					Effect.andThen(
						facade.close(),
						Effect.sync(() => facade.listen()),
					),
				),
			);
			expect([restartable.listening, restartable.closes]).toStrictEqual([false, 2]);
		}),
	);

	it.live(
		"releases an object once when an interrupted acquisition pauses at any step of handing it to the scope while a live acquisition takes it and another fiber closes the scope",
		() => {
			const stepper = new Stepper();
			return Effect.gen(function* () {
				for (let pause = 0; ; pause++) {
					const connection = new CountedConnection();
					const gate = Promise.withResolvers<void>();
					const signals: Array<AbortSignal> = [];
					const opener = effectify(
						{
							open: (signal: AbortSignal) => {
								signals.push(signal);
								return gate.promise.then(() => connection);
							},
						},
						{
							name: "Opener",
							spec: {
								methods: ["open"],
								async: { open: true },
								returns: { open: "Connection" },
								signal: { open: { index: 0 } },
							},
						},
						kinds,
						classify,
					) as unknown as { readonly open: () => Effect.Effect<ConnectionFacade, TestError, Scope.Scope> };
					const scope = yield* Scope.make();
					// The acquisition is marked `Held`: interrupted, it waits for its call and then hands what it gave to the scope.
					const acquiring = yield* Effect.forkChild(
						opener.open().pipe(Scope.provide(scope), Effect.provideService(Held, true)),
						{
							startImmediately: true,
						},
					);
					// The interrupter waits for the interrupted acquisition: a fiber of its own, joined at the end.
					const interrupting = yield* Effect.forkChild(Fiber.interrupt(acquiring));
					expect(yield* waitUntil(() => signals[0]?.aborted === true)).toBe(true);
					stepper.holding = true;
					gate.resolve();
					// The connection arrives; the interrupted acquisition takes `pause` steps towards handing it to the scope, and pauses.
					expect(yield* waitUntil(() => stepper.held.length > 0)).toBe(true);
					let steps = 0;
					while (steps < pause && stepper.step()) {
						steps++;
						// A step that left the fiber waiting on upstream's promise: it is held again as that settles.
						if (stepper.held.length === 0) yield* waitUntil(() => stepper.held.length > 0, 5);
					}
					const finished = stepper.held.length === 0;
					// Meanwhile a live acquisition takes the same object in the scope, which another fiber then closes.
					yield* opening(connection).open().pipe(Scope.provide(scope));
					const closing = yield* Effect.forkDetach(Scope.close(scope, Exit.void));
					yield* Effect.sleep("2 millis");
					stepper.release();
					yield* Fiber.join(closing).pipe(Effect.timeout("1 second"));
					yield* Fiber.join(interrupting).pipe(Effect.timeout("1 second"));
					expect({ pause, closes: connection.closes }).toStrictEqual({ pause, closes: 1 });
					// The interrupted acquisition ended before it reached this pause: no later pause is new.
					if (finished) break;
				}
			}).pipe(Effect.provideService(Scheduler.Scheduler, stepper));
		},
	);
});

/** An upstream whose calls see their signal abort, ignore it, and resolve with fresh connections 20ms later. */
class SlowOpener {
	readonly opened: Array<CountedConnection> = [];
	readonly make: () => CountedConnection;
	constructor(make: () => CountedConnection = () => new CountedConnection()) {
		this.make = make;
	}
	open(signal?: AbortSignal): Promise<CountedConnection> {
		return this.later(signal, () => this.opening());
	}
	/** Two fresh connections in one list, as puppeteer's `$$` makes a handle per element. */
	openAll(signal?: AbortSignal): Promise<Array<CountedConnection>> {
		return this.later(signal, () => [this.opening(), this.opening()]);
	}
	opening(): CountedConnection {
		const connection = this.make();
		this.opened.push(connection);
		return connection;
	}
	later<T>(signal: AbortSignal | undefined, value: () => T): Promise<T> {
		return new Promise((resolve) => {
			const settle = () => setTimeout(() => resolve(value()), 20);
			// Without an abort it resolves after a second, so a facade that does not abort fails its assertions, not the
			// timeout.
			const fallback = setTimeout(settle, 1000);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(fallback);
					settle();
				},
				{ once: true },
			);
		});
	}
}

type SlowOpenerFacade = Effectified<SlowOpener, TestError, Handles, "open" | "openAll">;

const slowOpener = (upstream: SlowOpener) =>
	effectify(
		upstream,
		{
			name: "SlowOpener",
			spec: {
				methods: ["open", "openAll"],
				async: { open: true, openAll: true },
				returns: { open: "Connection" },
				lists: { openAll: "Connection" },
				signal: { open: { index: 0 }, openAll: { index: 0 } },
			},
		},
		kinds,
		classify,
	) as unknown as SlowOpenerFacade;

/** An upstream with callback-only methods: one reporting error first, one called when done, one taking a handler. */
class Terminal {
	written: Array<string> = [];
	handler: ((key: string) => boolean) | undefined;
	write(data: string, callback?: () => void): void {
		setTimeout(() => {
			this.written.push(data);
			callback?.();
		}, 1);
	}
	read(path: string, callback: (error: Error | null, data: string) => void): void {
		setTimeout(
			() =>
				path === "missing"
					? callback(Object.assign(new Error("no such file"), { code: "ENOENT" }), "")
					: callback(null, `<${path}>`),
			1,
		);
	}
	attachKeyHandler(handler: (key: string) => boolean): void {
		this.handler = handler;
	}
}

type TerminalMethods = "write" | "read" | "attachKeyHandler";
interface TerminalFacade extends Effectified<Terminal, TestError, never, TerminalMethods, never, "write" | "read"> {}

const terminal = (upstream = new Terminal()) =>
	effectify(
		upstream,
		{
			name: "Terminal",
			spec: { methods: ["write", "read", "attachKeyHandler"], async: {}, callback: { write: "done", read: "node" } },
		},
		{},
		classify,
	) as unknown as TerminalFacade;

describe("callbacks", () => {
	it("types a reporting callback's method as an Effect of what it reports, and a handler as upstream types it", () => {
		expectTypeOf(terminal().write).toEqualTypeOf<(data: string) => Effect.Effect<void, TestError>>();
		expectTypeOf(terminal().read).toEqualTypeOf<(path: string) => Effect.Effect<string, TestError>>();
		expectTypeOf(terminal().attachKeyHandler).toEqualTypeOf<(handler: (key: string) => boolean) => void>();
	});

	it.live("completes a `done` method when upstream calls back", () =>
		Effect.gen(function* () {
			const upstream = new Terminal();
			yield* terminal(upstream).write("hello");
			expect(upstream.written).toStrictEqual(["hello"]);
		}),
	);

	it.live("succeeds a `node` method with the value after the error, and fails with its error classified", () =>
		Effect.gen(function* () {
			expect(yield* terminal().read("a.txt")).toBe("<a.txt>");
			const error = yield* Effect.flip(terminal().read("missing"));
			expect(error).toMatchObject({ _tag: "TestError", operation: "Terminal.read", code: "ENOENT" });
		}),
	);

	it("passes a handler through", () => {
		const upstream = new Terminal();
		terminal(upstream).attachKeyHandler((key) => key === "q");
		expect(upstream.handler?.("q")).toBe(true);
	});
});

/** A tracer that records the name of every span it starts, in order. */
const recording = () => {
	const names: Array<string> = [];
	const tracer = Tracer.make({
		span(options) {
			names.push(options.name);
			return Tracer.nativeTracer.span(options);
		},
	});
	return { names, tracer };
};

describe("tracing", () => {
	it.effect("runs every Effect of a facade in a span named <Handle>.<method>, and its release in one too", () =>
		Effect.gen(function* () {
			const { names, tracer } = recording();
			yield* Effect.scoped(
				Effect.flatMap(client().connect(), (connection) =>
					Effect.andThen(connection.query("four"), Stream.runDrain(connection.rows())),
				),
			).pipe(Effect.withTracer(tracer));
			expect(names).toStrictEqual(["Client.connect", "Connection.query", "Connection.rows", "Connection.close"]);
		}),
	);

	it.effect("records the method's call as a stack frame of its failure", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.scoped(
				Effect.flatMap(client().connect(), (connection) => connection.query("bad")),
			).pipe(Effect.exit);
			expect(
				Exit.isFailure(exit) &&
					JSON.stringify(exit.cause.reasons.flatMap((reason) => [...reason.annotations.keys()])),
			).toContain("StackTrace");
		}),
	);

	it.effect("leaves a method the spec marks untraced without a span", () =>
		Effect.gen(function* () {
			const { names, tracer } = recording();
			const facade = effectify(
				new Connection(),
				{ name: "Connection", spec: { methods: ["query"], async: { query: true }, untraced: { query: true } } },
				{},
				classify,
			) as unknown as ConnectionFacade;
			expect(yield* facade.query("abc").pipe(Effect.withTracer(tracer))).toBe(3);
			expect(names).toStrictEqual([]);
		}),
	);

	it.effect("traces an exported function under its operation", () =>
		Effect.gen(function* () {
			const { names, tracer } = recording();
			const twice = (value: number) => Promise.resolve(value * 2);
			const facade = entry<typeof twice, TestError, never>(twice, "twice", undefined, {}, classify);
			expect(yield* facade(21).pipe(Effect.withTracer(tracer))).toBe(42);
			expect(names).toStrictEqual(["twice"]);
		}),
	);
});

describe("releases", () => {
	it.effect("logs a release that fails as a warning and still closes the scope", () =>
		Effect.gen(function* () {
			const logged: Array<string> = [];
			const logger = Logger.make(({ logLevel, message }) => logged.push(`${logLevel}: ${String(message)}`));
			class Broken extends Connection {
				override async close(): Promise<void> {
					throw new Error("already gone");
				}
			}
			const opener = { open: async () => new Broken() };
			const facade = effectify(
				opener,
				{ name: "Opener", spec: { methods: ["open"], async: { open: true }, returns: { open: "Connection" } } },
				kinds,
				classify,
			) as unknown as {
				readonly open: () => Effect.Effect<ConnectionFacade, TestError, Scope.Scope>;
			};
			expect(
				yield* Effect.scoped(Effect.flatMap(facade.open(), (connection) => connection.query("ok"))).pipe(
					Effect.provide(Logger.layer([logger])),
				),
			).toBe(2);
			expect(logged.join("\n")).toContain("Connection.close failed while its scope closed");
		}),
	);
});

/** An upstream whose lookups may find nothing, one of them a releasable handle. */
class Registry {
	readonly opened: Array<Connection> = [];
	async find(name: string): Promise<string | undefined> {
		return name === "known" ? "found" : undefined;
	}
	async connection(name: string): Promise<Connection | null> {
		if (name !== "known") return null;
		const connection = new Connection();
		this.opened.push(connection);
		return connection;
	}
}

type RegistryHandles = Handles | readonly [Registry, RegistryFacade, false];
interface RegistryFacade extends Effectified<
	Registry,
	TestError,
	RegistryHandles,
	"find" | "connection",
	never,
	never,
	"find" | "connection"
> {}

const registry = (upstream = new Registry()) =>
	effectify(
		upstream,
		{
			name: "Registry",
			spec: {
				methods: ["find", "connection"],
				async: { find: true, connection: true },
				option: { find: true, connection: true },
				returns: { connection: "Connection" },
			},
		},
		kinds,
		classify,
	) as unknown as RegistryFacade;

describe("options", () => {
	it("types a result that may be absent as an Option, of the facade for a handle, scoped when it releases", () => {
		expectTypeOf(registry().find).returns.toEqualTypeOf<Effect.Effect<Option.Option<string>, TestError>>();
		expectTypeOf(registry().connection).returns.toEqualTypeOf<
			Effect.Effect<Option.Option<ConnectionFacade>, TestError, Scope.Scope>
		>();
	});

	it.effect(
		"succeeds with None for an absent value and Some of the facade for a present one, acquiring only that",
		() =>
			Effect.gen(function* () {
				const upstream = new Registry();
				expect(yield* registry(upstream).find("missing")).toStrictEqual(Option.none());
				expect(yield* registry(upstream).find("known")).toStrictEqual(Option.some("found"));
				expect(yield* Effect.scoped(registry(upstream).connection("missing"))).toStrictEqual(Option.none());
				const length = yield* Effect.scoped(
					Effect.flatMap(registry(upstream).connection("known"), (found) =>
						Option.isSome(found) ? found.value.query("abc") : Effect.succeed(0),
					),
				);
				expect(length).toBe(3);
				expect(upstream.opened.map((connection) => connection.closed)).toStrictEqual([true]);
			}),
	);

	it.effect("types a synchronous export whose value may be absent as an Effect of an Option, as it runs", () =>
		Effect.gen(function* () {
			const lookup = (name: string): Connection | null => (name === "known" ? new Connection() : null);
			const find = entry<typeof lookup, TestError, Handles, true>(
				lookup,
				"find",
				kinds["Connection"],
				kinds,
				classify,
				{
					option: true,
				},
			);
			expectTypeOf(find).returns.toEqualTypeOf<
				Effect.Effect<Option.Option<ConnectionFacade>, TestError, Scope.Scope>
			>();
			expect(yield* Effect.scoped(find("missing"))).toStrictEqual(Option.none());
			expect(Option.isSome(yield* Effect.scoped(find("known")))).toBe(true);
		}),
	);
});

/**
 * An upstream that makes a connection and hands out the one it holds, the way puppeteer's `Target.page()` returns the
 * page it caches, `Frame.page()` its page and `Page.tracing` its tracing: a lookup, a synchronous call, a property.
 */
class Pool {
	readonly held = new CountedConnection();
	readonly connection: Connection = this.held;
	async open(): Promise<Connection> {
		return this.held;
	}
	async current(): Promise<Connection | null> {
		return this.held;
	}
	peek(): Connection {
		return this.held;
	}
	owns(connection: Connection): boolean {
		return connection === this.held;
	}
}

type PoolFacade = Effectified<
	Pool,
	TestError,
	Handles,
	"open" | "current" | "peek" | "owns",
	"connection",
	never,
	"current",
	"open" | "current" | "peek" | "owns" | "connection",
	{},
	"current" | "peek"
>;

/** A connection as its borrower holds it: without `close`, which is its owner's. */
type BorrowedConnection = Omit<ConnectionFacade, "close">;

describe("lookups", () => {
	const pool = (upstream: Pool) =>
		effectify(
			upstream,
			{
				name: "Pool",
				spec: {
					methods: ["open", "current", "peek", "owns"],
					async: { open: true, current: true },
					option: { current: true },
					returns: { open: "Connection", current: "Connection", peek: "Connection" },
					borrowed: { current: true, peek: true },
					properties: { connection: "Connection" },
				},
			},
			kinds,
			classify,
		) as unknown as PoolFacade;

	it.effect("wraps a handle a method borrows without acquiring it, and the owner's scope releases it once", () =>
		Effect.gen(function* () {
			const upstream = new Pool();
			const facade = pool(upstream);
			expectTypeOf(facade.current).returns.toEqualTypeOf<
				Effect.Effect<Option.Option<BorrowedConnection>, TestError>
			>();
			expectTypeOf(facade.open).returns.toEqualTypeOf<Effect.Effect<ConnectionFacade, TestError, Scope.Scope>>();
			yield* Effect.scoped(
				Effect.gen(function* () {
					yield* facade.open();
					const found = yield* Effect.scoped(facade.current());
					expect(Option.isSome(found)).toBe(true);
					// Leaving the lookup's own scope leaves the connection to its owner.
					expect(upstream.held.closes).toBe(0);
				}),
			);
			expect(upstream.held.closes).toBe(1);
		}),
	);

	it.effect("offers no release on a handle it did not acquire: a lookup's, a synchronous call's, a property's", () =>
		Effect.gen(function* () {
			const upstream = new Pool();
			const facade = pool(upstream);
			expectTypeOf(facade.peek()).toEqualTypeOf<BorrowedConnection>();
			expectTypeOf(facade.connection).toEqualTypeOf<BorrowedConnection>();
			const found = Option.getOrThrow(yield* facade.current());
			for (const borrowed of [found, facade.peek(), facade.connection]) {
				expect("close" in borrowed).toBe(false);
				expect(yield* borrowed.query("abc")).toBe(3);
				// A borrowed facade is still a facade: upstream takes its own object back.
				expect(facade.owns(borrowed)).toBe(true);
			}
			// Typed only, never run: the release is the owner's.
			const release = () =>
				// @ts-expect-error a borrowed facade offers no release
				found.close();
			expect(release).toBeTypeOf("function");
			expect(upstream.held.closes).toBe(0);
		}),
	);

	it.effect(
		"keeps on a borrowed facade a release that gives a handle by its class (`kept`): zmq's `Socket.close(): Socket`",
		() =>
			Effect.gen(function* () {
				// A hand-written `.d.ts` names the class, not `this`: the types cannot tell this release from a step.
				class Socket {
					closes = 0;
					bindSync(_address: string): Socket {
						return this;
					}
					close(): Socket {
						this.closes++;
						return this;
					}
				}
				// No release methods to leave out: a borrowed facade is the whole facade.
				type SocketHandles = readonly [Socket, SocketFacade, true];
				type SocketMethods = "bindSync" | "close";
				interface SocketFacade extends Effectified<
					Socket,
					TestError,
					SocketHandles,
					SocketMethods,
					never,
					never,
					never,
					SocketMethods,
					{},
					SocketMethods
				> {}
				const sockets: Record<string, HandleKind> = {
					Socket: {
						name: "Socket",
						spec: {
							methods: ["bindSync", "close"],
							async: {},
							returns: { bindSync: "Socket", close: "Socket" },
							borrowed: { bindSync: true, close: true },
						},
						release: "close",
						kept: ["close"],
					},
				};
				const upstream = new Socket();
				const owned = effectify(upstream, sockets["Socket"]!, sockets, classify) as unknown as SocketFacade;
				const bound = owned.bindSync("tcp://127.0.0.1:5555");
				expectTypeOf(bound).toEqualTypeOf<SocketFacade>();
				expect("close" in bound).toBe(true);
				expect(bound.close().upstream).toBe(upstream);
				expect(upstream.closes).toBe(1);
			}),
	);

	it.effect(
		"lifts an array of handles into borrowed facades: a borrowed Effect's (a lookup), a synchronous call's, a property's",
		() =>
			Effect.gen(function* () {
				// Puppeteer's `browser.pages()`: the pages the browser holds, some of them scoped by their owners.
				class Book {
					readonly held = [new CountedConnection(), new CountedConnection()];
					readonly connections: ReadonlyArray<Connection> = this.held;
					async pages(): Promise<Array<Connection>> {
						return this.held;
					}
					list(): ReadonlyArray<Connection> {
						return this.held;
					}
				}
				const upstream = new Book();
				const facade = effectify(
					upstream,
					{
						name: "Book",
						spec: {
							methods: ["pages", "list"],
							async: { pages: true },
							properties: { connections: true },
							lists: { pages: "Connection", list: "Connection", connections: "Connection" },
							borrowed: { pages: true },
						},
					},
					kinds,
					classify,
				) as unknown as Effectified<
					Book,
					TestError,
					Handles,
					"pages" | "list",
					"connections",
					never,
					never,
					"pages" | "list" | "connections",
					{},
					"pages"
				>;
				expectTypeOf(facade.pages).returns.toEqualTypeOf<
					Effect.Effect<ReadonlyArray<BorrowedConnection>, TestError>
				>();
				expectTypeOf(facade.list()).toEqualTypeOf<ReadonlyArray<BorrowedConnection>>();
				expectTypeOf(facade.connections).toEqualTypeOf<ReadonlyArray<BorrowedConnection>>();
				for (const listed of [yield* facade.pages(), facade.list(), facade.connections]) {
					expect(listed).toHaveLength(2);
					for (const [index, borrowed] of listed.entries()) {
						expect("close" in borrowed).toBe(false);
						expect(borrowed.upstream).toBe(upstream.held[index]);
						expect(yield* borrowed.query("abc")).toBe(3);
					}
				}
				expect(upstream.held.map((connection) => connection.closes)).toStrictEqual([0, 0]);
			}),
	);

	it.effect(
		"acquires each handle of a list an Effect makes in the caller's scope, and releases each as it closes",
		() =>
			Effect.gen(function* () {
				// Puppeteer's `page.$$(selector)`: a new handle per element, each the caller's to dispose, as `$` makes one.
				class Grid {
					readonly made: Array<CountedConnection> = [];
					async all(count: number): Promise<Array<Connection>> {
						const connections = Array.from({ length: count }, () => new CountedConnection());
						this.made.push(...connections);
						return connections;
					}
				}
				const upstream = new Grid();
				const facade = effectify(
					upstream,
					{ name: "Grid", spec: { methods: ["all"], async: { all: true }, lists: { all: "Connection" } } },
					kinds,
					classify,
				) as unknown as Effectified<Grid, TestError, Handles, "all">;
				expectTypeOf(facade.all).returns.toEqualTypeOf<
					Effect.Effect<ReadonlyArray<ConnectionFacade>, TestError, Scope.Scope>
				>();
				yield* Effect.scoped(
					Effect.gen(function* () {
						const listed = yield* facade.all(2);
						expect(listed.map((owned) => owned.upstream)).toStrictEqual(upstream.made);
						// The caller's: each facade keeps its release, and the open scope has released none.
						for (const owned of listed) expect("close" in owned).toBe(true);
						expect(upstream.made.map((connection) => connection.closes)).toStrictEqual([0, 0]);
					}),
				);
				expect(upstream.made.map((connection) => connection.closes)).toStrictEqual([1, 1]);
			}),
	);

	it("lifts an array of handles only as itself: not one that may be absent, of a union, a tuple or no handle", () => {
		expectTypeOf<Listed<Array<Connection>, Handles>>().toEqualTypeOf<ReadonlyArray<BorrowedConnection>>();
		expectTypeOf<Listed<ReadonlyArray<Connection>, Handles>>().toEqualTypeOf<ReadonlyArray<BorrowedConnection>>();
		// An Effect's list is the caller's, in a scope when its handle is scoped; a borrowed call's is not.
		expectTypeOf<ResolvedList<Array<Connection>, TestError, Handles>>().toEqualTypeOf<
			Effect.Effect<ReadonlyArray<ConnectionFacade>, TestError, Scope.Scope>
		>();
		expectTypeOf<ResolvedList<Array<Client>, TestError, Handles>>().toEqualTypeOf<
			Effect.Effect<ReadonlyArray<ClientFacade>, TestError>
		>();
		expectTypeOf<ResolvedList<Array<Connection>, TestError, Borrowed<Handles>>>().toEqualTypeOf<
			Effect.Effect<ReadonlyArray<BorrowedConnection>, TestError>
		>();
		expectTypeOf<Listed<Array<Connection> | undefined, Handles>>().toEqualTypeOf<never>();
		expectTypeOf<Listed<Array<Connection | null>, Handles>>().toEqualTypeOf<never>();
		expectTypeOf<Listed<readonly [Connection, Connection], Handles>>().toEqualTypeOf<never>();
		expectTypeOf<Listed<Array<string>, Handles>>().toEqualTypeOf<never>();
		expectTypeOf<Listed<Array<any>, Handles>>().toEqualTypeOf<never>();
	});
});

/** An upstream taking secrets in an options object, the way a transport takes its credentials. */
class Mailer {
	readonly seen: Array<unknown> = [];
	async login(
		options:
			| { readonly host: string; readonly auth?: { readonly user: string; readonly pass?: string | undefined } }
			| string,
	): Promise<string> {
		this.seen.push(options);
		return typeof options === "string" ? options : `${options.auth?.user}:${options.auth?.pass}@${options.host}`;
	}
}

type MailerFacade = Effectified<
	Mailer,
	TestError,
	never,
	"login",
	never,
	never,
	never,
	"login",
	{ readonly login: Redacting<readonly ["0", "auth", "pass"]> }
>;

/** A handle of any value in a page, and of a DOM node, which has its methods and more: puppeteer's `JSHandle`, `ElementHandle`. */
class ValueHandle {
	disposals = 0;
	async dispose(): Promise<void> {
		this.disposals++;
	}
	asElement(): NodeHandle | null {
		return null;
	}
}

class NodeHandle extends ValueHandle {
	async click(): Promise<string> {
		return "clicked";
	}
	override asElement(): NodeHandle | null {
		return this;
	}
}

/** A page that makes a handle of the node or value asked for, as `evaluateHandle` by its function's result. */
class Realm {
	async handle(node: boolean): Promise<ValueHandle> {
		return node ? new NodeHandle() : new ValueHandle();
	}
	/** Gives back the handle it is given, as `toElement` gives back its receiver. */
	async view(handle: ValueHandle): Promise<ValueHandle> {
		return handle;
	}
}

/** A facade of either handle, as the runtime makes it: its upstream, `click` only for a node, `dispose` only when owned. */
interface PageHandleFacade {
	readonly upstream: ValueHandle;
	readonly asElement: () => PageHandleFacade | null;
}

const realmKinds: Record<string, HandleKind> = {
	Value: {
		name: "Value",
		spec: {
			methods: ["dispose", "asElement"],
			async: { dispose: true },
			returns: { asElement: "Node" },
			borrowed: { asElement: true },
		},
		release: "dispose",
	},
	Node: {
		name: "Node",
		spec: {
			methods: ["dispose", "asElement", "click"],
			async: { dispose: true, click: true },
			returns: { asElement: "Node" },
			borrowed: { asElement: true },
		},
		release: "dispose",
	},
	Realm: {
		name: "Realm",
		spec: {
			methods: ["handle", "view"],
			async: { handle: true, view: true },
			choices: { handle: ["Node", "Value"], view: ["Node", "Value"] },
			borrowed: { view: true },
		},
	},
};

const realm = () =>
	effectify(new Realm(), realmKinds["Realm"]!, realmKinds, classify) as unknown as {
		readonly handle: (node: boolean) => Effect.Effect<PageHandleFacade, TestError, Scope.Scope>;
		readonly view: (handle: PageHandleFacade) => Effect.Effect<PageHandleFacade, TestError>;
	};

describe("handles a conditional type chooses between, and handles that may be absent", () => {
	it.effect(
		"wraps each value a choice gives as the first kind whose methods it has, owned or borrowed as one handle is",
		() =>
			Effect.gen(function* () {
				const facade = realm();
				const made = yield* Effect.scoped(
					Effect.gen(function* () {
						const node = yield* facade.handle(true);
						const value = yield* facade.handle(false);
						// The node's facade has a node's methods; each is the caller's, released when its scope closes.
						expect(
							[node.upstream, value.upstream].map((upstream) => upstream instanceof ValueHandle),
						).toStrictEqual([true, true]);
						expect(["click" in node, "click" in value]).toStrictEqual([true, false]);
						expect(["dispose" in node, "dispose" in value]).toStrictEqual([true, true]);
						// A borrowed choice (the receiver given back): the same kind, without its release.
						const viewed = yield* facade.view(node);
						expect([viewed.upstream === node.upstream, "click" in viewed, "dispose" in viewed]).toStrictEqual([
							true,
							true,
							false,
						]);
						return [node.upstream, value.upstream];
					}),
				);
				expect(made.map((handle) => handle.disposals)).toStrictEqual([1, 1]);
			}),
	);

	it.effect("gives a synchronous method's handle that may be absent as its facade, or the absence", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const facade = realm();
				const node = yield* facade.handle(true);
				const value = yield* facade.handle(false);
				const viewed = node.asElement();
				expect([viewed?.upstream === node.upstream, viewed !== null && "dispose" in viewed]).toStrictEqual([
					true,
					false,
				]);
				expect(value.asElement()).toBeNull();
			}),
		),
	);

	it("names each member whose type gives other than its spec makes it give: raw, owned or borrowed, a Stream", () => {
		const async = { connect: true } as const;
		const returns = { connect: "Connection" } as const;
		expectTypeOf<
			Disagreeing<ClientFacade, "connect" | "name", { async: typeof async; returns: typeof returns }, Handles>
		>().toEqualTypeOf<never>();
		// The runtime would return the connection raw, or borrowed: the type says the caller's facade.
		expectTypeOf<
			Disagreeing<ClientFacade, "connect" | "name", { async: typeof async }, Handles>
		>().toEqualTypeOf<"connect">();
		expectTypeOf<
			Disagreeing<
				ClientFacade,
				"connect",
				{ async: typeof async; returns: typeof returns; borrowed: typeof async },
				Handles
			>
		>().toEqualTypeOf<"connect">();
		// A handle that is never released has one facade, owned or borrowed alike.
		expectTypeOf<
			Disagreeing<ClientFacade, "with", { returns: { with: "Client" } }, Handles>
		>().toEqualTypeOf<never>();
		expectTypeOf<Disagreeing<ClientFacade, "with", {}, Handles>>().toEqualTypeOf<"with">();
		expectTypeOf<Disagreeing<ConnectionFacade, "rows", { stream: { rows: true } }, Handles>>().toEqualTypeOf<never>();
		expectTypeOf<Disagreeing<ConnectionFacade, "rows", { async: { rows: true } }, Handles>>().toEqualTypeOf<"rows">();
		// A property read through: raw, or a handle's borrowed facade.
		type Labelled = Effectified<Client, TestError, Handles, "name", "label" | "last">;
		expectTypeOf<
			Disagreeing<Labelled, "label" | "last", { properties: { label: true; last: true } }, Handles>
		>().toEqualTypeOf<never>();
		expectTypeOf<
			Disagreeing<Labelled, "label" | "last", { properties: { label: true; last: string } }, Handles>
		>().toEqualTypeOf<"last">();
	});

	it("types a handle that may be absent as its facade or the absence, and every overload of an async method as an Effect", () => {
		expectTypeOf<Resolved<Connection | null, TestError, Handles>>().toEqualTypeOf<
			Effect.Effect<ConnectionFacade | null, TestError, Scope.Scope>
		>();
		// As puppeteer's `ScreenRecording.pipe`: one overload resolves, the other returns its destination; the runtime
		// runs both as an Effect.
		class Recorder {
			pipe(destination: string): Promise<void>;
			pipe<T extends object>(destination: T): T;
			pipe(destination: unknown): unknown {
				return typeof destination === "string" ? Promise.resolve() : destination;
			}
		}
		type RecorderFacade = Effectified<Recorder, TestError, never, "pipe">;
		expectTypeOf<
			Disagreeing<RecorderFacade, "pipe", { async: { pipe: true } }, never, "pipe">
		>().toEqualTypeOf<never>();
	});
});

describe("a union of handles", () => {
	// postcss's shape: sibling handles (`AtRule`, `Rule`, `Declaration`, `Comment`) that share a base handle (`Node`), and
	// a union alias of the siblings (`ChildNode`).
	class Base {
		parent: Branch | undefined;
		name(): string {
			return this.constructor.name;
		}
		next(): Child | undefined {
			const siblings = this.parent?.nodes ?? [];
			return siblings[siblings.findIndex((sibling: Base) => sibling === this) + 1];
		}
	}
	class Leaf extends Base {
		text(): string {
			return "leaf";
		}
	}
	class Branch extends Base {
		nodes: Array<Child> = [];
		first(): Child {
			return this.nodes[0] ?? new Leaf();
		}
		children(): Array<Child> {
			return [...this.nodes];
		}
		/** A leaf or any node: a union one of whose members every member is, as puppeteer's `HandleFor<T>` may be. */
		nearest(): Leaf | Base {
			return this.nodes[0] ?? this;
		}
		append(child: Child): this {
			child.parent = this;
			this.nodes.push(child);
			return this;
		}
	}
	type Child = Leaf | Branch;
	type TreeHandles =
		| readonly [Base, BaseFacade, false]
		| readonly [Leaf, LeafFacade, false]
		| readonly [Branch, BranchFacade, false];
	interface BaseFacade extends Effectified<Base, TestError, TreeHandles, "name" | "next"> {}
	interface LeafFacade extends Effectified<Leaf, TestError, TreeHandles, "name" | "next" | "text"> {}
	interface BranchFacade extends Effectified<
		Branch,
		TestError,
		TreeHandles,
		"append" | "children" | "first" | "name" | "nearest" | "next",
		"nodes"
	> {}
	// The spec the generator writes: a union names no one handle, so `first`, `next`, `children` and `nodes` give theirs
	// raw; `append` gives the receiver and `nearest` the base handle every member of its union is.
	const spec = {
		methods: ["append", "children", "first", "name", "nearest", "next"],
		async: {},
		returns: { append: "Branch", nearest: "Base" },
		borrowed: { append: true },
		properties: { nodes: true },
	} as const satisfies HandleKind["spec"];
	const treeKinds: Record<string, HandleKind> = {
		Base: { name: "Base", spec: { methods: ["name", "next"], async: {} } },
		Leaf: { name: "Leaf", spec: { methods: ["name", "next", "text"], async: {} } },
		Branch: { name: "Branch", spec },
	};

	it("types a union of sibling handles raw, alone, optional and as an array, as the runtime gives it", () => {
		expectTypeOf<ReturnType<BranchFacade["first"]>>().toEqualTypeOf<Child>();
		expectTypeOf<ReturnType<BranchFacade["next"]>>().toEqualTypeOf<Child | undefined>();
		expectTypeOf<ReturnType<BranchFacade["children"]>>().toEqualTypeOf<Array<Child>>();
		expectTypeOf<BranchFacade["nodes"]>().toEqualTypeOf<Array<Child>>();
		// A union one of whose members every member is stays that member's handle.
		expectTypeOf<ReturnType<BranchFacade["nearest"]>>().toEqualTypeOf<BaseFacade>();
		expectTypeOf<
			Disagreeing<
				BranchFacade,
				"append" | "children" | "first" | "nearest" | "next" | "nodes",
				typeof spec,
				TreeHandles
			>
		>().toEqualTypeOf<never>();
	});

	it("types a union as the handle one of its members is and every member is, as puppeteer's `HandleFor<T>` may be", () => {
		// As puppeteer's `JSHandle<any>` entry: `Clickable<string> | Held<null>` has no member every member is, but each
		// is a `Held`, and `Held<null>` is one itself.
		class Held<T> {
			value: T;
			constructor(value: T) {
				this.value = value;
			}
			read(): T {
				return this.value;
			}
		}
		class Clickable<T> extends Held<T> {
			click(): void {}
		}
		class Picker {
			pick(): Clickable<string> | Held<null> {
				return new Held(null);
			}
		}
		type PickHandles =
			| readonly [Held<any>, HeldFacade, false]
			| readonly [Clickable<any>, ClickableFacade, false]
			| readonly [Picker, PickerFacade, false];
		interface HeldFacade extends Effectified<Held<any>, TestError, PickHandles, "read"> {}
		interface ClickableFacade extends Effectified<Clickable<any>, TestError, PickHandles, "click" | "read"> {}
		interface PickerFacade extends Effectified<Picker, TestError, PickHandles, "pick"> {}
		expectTypeOf<ReturnType<PickerFacade["pick"]>>().toEqualTypeOf<HeldFacade>();
	});

	it("gives each of them upstream's own object at run time", () => {
		const inner = new Branch().append(new Leaf());
		const outer = new Branch().append(inner).append(new Leaf());
		const facade = effectify(inner, treeKinds["Branch"]!, treeKinds, classify) as unknown as BranchFacade;
		expect(facade.first()).toBe(inner.nodes[0]);
		expect(facade.next()).toBe(outer.nodes[1]);
		expect(facade.children().map((child, index) => child === inner.nodes[index])).toStrictEqual([true]);
		expect(facade.nodes).toBe(inner.nodes);
		expect(facade.nearest().upstream).toBe(inner.nodes[0]);
	});

	it("types a member its spec gives as it is as upstream types it, a handle in its value too (`G`)", () => {
		// The generator reads no handle in an inline `Leaf | Base`: without `nearest` in `returns`, its value is raw at run
		// time, and so in its type, though the types alone would read a `Base` in it.
		interface RawFacade extends Effectified<
			Branch,
			TestError,
			TreeHandles,
			"append" | "children" | "first" | "name" | "nearest" | "next",
			"nodes",
			never,
			never,
			"append"
		> {}
		const raw = { ...spec, returns: { append: "Branch" } } as const satisfies HandleKind["spec"];
		expectTypeOf<ReturnType<RawFacade["nearest"]>>().toEqualTypeOf<Leaf | Base>();
		expectTypeOf<ReturnType<RawFacade["append"]>>().toEqualTypeOf<BaseFacade | BranchFacade>();
		expectTypeOf<
			Disagreeing<RawFacade, "append" | "nearest" | "nodes", typeof raw, TreeHandles>
		>().toEqualTypeOf<never>();
		const inner = new Branch().append(new Leaf());
		const facade = effectify(inner, { name: "Branch", spec: raw }, treeKinds, classify) as unknown as RawFacade;
		expect(facade.nearest()).toBe(inner.nodes[0]);
	});
});

describe("a method whose overloads give its handle or another value", () => {
	// Cheerio's shape: `html()` reads the markup and `html(value)` sets it and returns the receiver; `attr()` reads a
	// record, which is no selection.
	class Selection {
		markup: string | null = null;
		attrs: Record<string, string> = {};
		html(): string | null;
		html(value: string): this;
		html(value?: string): string | null | this {
			if (value === undefined) return this.markup;
			this.markup = value;
			return this;
		}
		attr(): Record<string, string>;
		attr(name: string, value: string): this;
		attr(name?: string, value?: string): Record<string, string> | this {
			if (name === undefined || value === undefined) return { ...this.attrs };
			this.attrs[name] = value;
			return this;
		}
	}
	// A pool whose `open()` reads its defaults, a plain object, and `open(name)` makes a connection the caller owns.
	class Connection {
		closes = 0;
		async close(): Promise<void> {
			this.closes += 1;
		}
	}
	class Pool {
		made: Array<Connection> = [];
		open(): Promise<{ readonly name: string }>;
		open(name: string): Promise<Connection>;
		async open(name?: string): Promise<{ readonly name: string } | Connection> {
			if (name === undefined) return { name: "default" };
			const made = new Connection();
			this.made.push(made);
			return made;
		}
	}
	type MixedHandles =
		| readonly [Selection, SelectionFacade, false]
		| readonly [Pool, PoolFacade, false]
		| readonly [Connection, ConnectionFacade, true, "close"];
	interface SelectionFacade extends Effectified<
		Selection,
		TestError,
		MixedHandles,
		"attr" | "html",
		"markup",
		never,
		never,
		"attr" | "html",
		{},
		"attr" | "html"
	> {}
	interface PoolFacade extends Effectified<Pool, TestError, MixedHandles, "open", never, never, never, "open"> {}
	interface ConnectionFacade extends Effectified<Connection, TestError, MixedHandles, "close"> {}
	const selectionSpec = {
		methods: ["attr", "html"],
		async: {},
		returns: { attr: "Selection", html: "Selection" },
		mixed: { attr: true, html: true },
		borrowed: { attr: true, html: true },
		properties: { markup: true },
	} as const satisfies HandleKind["spec"];
	const poolSpec = {
		methods: ["open"],
		async: { open: true },
		returns: { open: "Connection" },
		mixed: { open: true },
	} as const satisfies HandleKind["spec"];
	const mixedKinds: Record<string, HandleKind> = {
		Selection: { name: "Selection", spec: selectionSpec },
		Pool: { name: "Pool", spec: poolSpec },
		Connection: { name: "Connection", spec: { methods: ["close"], async: { close: true } }, release: "close" },
	};

	it("types each overload by its own result, and the check takes either word for each", () => {
		const selection = effectify(
			new Selection(),
			mixedKinds["Selection"]!,
			mixedKinds,
			classify,
		) as unknown as SelectionFacade;
		expectTypeOf(selection.html()).toEqualTypeOf<string | null>();
		expectTypeOf(selection.html("<b>x</b>")).toEqualTypeOf<SelectionFacade>();
		expectTypeOf(selection.attr()).toEqualTypeOf<Record<string, string>>();
		const pool = effectify(new Pool(), mixedKinds["Pool"]!, mixedKinds, classify) as unknown as PoolFacade;
		expectTypeOf(pool.open()).toEqualTypeOf<Effect.Effect<{ readonly name: string }, TestError>>();
		expectTypeOf(pool.open("a")).toEqualTypeOf<Effect.Effect<ConnectionFacade, TestError, Scope.Scope>>();
		expectTypeOf<
			Disagreeing<SelectionFacade, "attr" | "html" | "markup", typeof selectionSpec, MixedHandles, "attr" | "html">
		>().toEqualTypeOf<never>();
		expectTypeOf<Disagreeing<PoolFacade, "open", typeof poolSpec, MixedHandles, "open">>().toEqualTypeOf<never>();
		// Without `mixed`, an overload that gives a string disagrees with a spec that wraps every result.
		const wrapsAll = { ...selectionSpec, mixed: {} } as const satisfies HandleKind["spec"];
		expectTypeOf<
			Disagreeing<SelectionFacade, "attr" | "html", typeof wrapsAll, MixedHandles, "attr" | "html">
		>().toEqualTypeOf<"attr" | "html">();
	});

	it("wraps a synchronous result that is the handle, and gives any other value as it is", () => {
		const selection = new Selection();
		const facade = effectify(selection, mixedKinds["Selection"]!, mixedKinds, classify) as unknown as SelectionFacade;
		expect(facade.html()).toBeNull();
		const set = facade.html("<b>x</b>");
		expect(set.upstream).toBe(selection);
		expect(set.html()).toBe("<b>x</b>");
		const attrs = facade.attr();
		expect(attrs).toStrictEqual({});
		expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
		expect(facade.attr("id", "x").upstream).toBe(selection);
		expect(facade.attr()).toStrictEqual({ id: "x" });
	});

	it.effect("acquires only a result that is the handle: a value beside it gets no finalizer", () =>
		Effect.gen(function* () {
			const pool = new Pool();
			const facade = effectify(pool, mixedKinds["Pool"]!, mixedKinds, classify) as unknown as PoolFacade;
			const defaults = yield* Effect.scoped(
				Effect.gen(function* () {
					const read = yield* facade.open();
					const connection = yield* facade.open("a");
					expect(connection.upstream).toBe(pool.made[0]);
					return read;
				}),
			);
			expect(defaults).toStrictEqual({ name: "default" });
			expect(pool.made.map((connection) => connection.closes)).toStrictEqual([1]);
		}),
	);
});

describe("secrets", () => {
	it("types a secret the recipe names as its own type or Redacted, and checks the path reaches a string", () => {
		type Login = Parameters<MailerFacade["login"]>[0];
		expectTypeOf<Extract<Login, object>["auth"]>().toEqualTypeOf<
			{ readonly user: string; readonly pass?: string | Redacted.Redacted<string> | undefined } | undefined
		>();
		expectTypeOf<Extract<Login, string>>().toEqualTypeOf<string>();
		expectTypeOf<Secreted<{ readonly a: number }, readonly ["b"]>>().toEqualTypeOf<{ readonly a: number }>();
		type Reached = Expect<ReachesString<Parameters<Mailer["login"]>, readonly ["0", "auth", "pass"]>>;
		expectTypeOf<Reached>().toEqualTypeOf<true>();
		expectTypeOf<
			ReachesString<Parameters<Mailer["login"]>, readonly ["0", "auth", "password"]>
		>().toEqualTypeOf<false>();
	});

	it.effect(
		"reveals a Redacted secret for upstream, copying the objects on its path, and passes a plain one as it is",
		() =>
			Effect.gen(function* () {
				const upstream = new Mailer();
				const facade = effectify(
					upstream,
					{
						name: "Mailer",
						spec: { methods: ["login"], async: { login: true }, secrets: { login: [["0", "auth", "pass"]] } },
					},
					{},
					classify,
				) as unknown as MailerFacade;
				const options = { host: "smtp", auth: { user: "me", pass: Redacted.make("hunter2") } };
				expect(yield* facade.login(options)).toBe("me:hunter2@smtp");
				expect(Redacted.isRedacted(options.auth.pass)).toBe(true);
				expect(yield* facade.login({ host: "smtp", auth: { user: "me", pass: "plain" } })).toBe("me:plain@smtp");
				expect(yield* facade.login("smtp://url")).toBe("smtp://url");
				expect(String(options.auth.pass)).not.toContain("hunter2");
			}),
	);

	it("shows a secret upstream keeps in a property as Redacted, and prints a facade without upstream's state", () => {
		class Transport {
			readonly options: { readonly host: string; readonly auth: { readonly user: string; readonly pass: string } };
			constructor(options: Transport["options"]) {
				this.options = options;
			}
		}
		// What upstream kept of the call that revealed the secret to it.
		const upstream = new Transport({ host: "smtp", auth: { user: "me", pass: "hunter2" } });
		const facade = effectify(
			upstream,
			{
				name: "Transport",
				spec: { methods: [], async: {}, properties: { options: true }, concealed: [["auth", "pass"]] },
			},
			{},
			classify,
		) as unknown as Effectified<
			Transport,
			TestError,
			never,
			never,
			"options",
			never,
			never,
			"options",
			{},
			never,
			readonly ["auth", "pass"]
		>;
		expectTypeOf(facade.options.auth.pass).toEqualTypeOf<Redacted.Redacted<string>>();
		expectTypeOf(facade.options.host).toEqualTypeOf<string>();
		expect(Redacted.value(facade.options.auth.pass)).toBe("hunter2");
		expect(facade.options.host).toBe("smtp");
		expect(upstream.options.auth.pass).toBe("hunter2");
		expect(inspect(facade, { depth: 10 })).not.toContain("hunter2");
		expect(JSON.stringify(facade)).not.toContain("hunter2");
		expect(facade.upstream).toBe(upstream);
	});

	it.effect("shows a kept secret as Redacted at any depth below a property, and in what a method returns", () =>
		Effect.gen(function* () {
			interface Options {
				readonly host: string;
				readonly auth: { readonly user: string; readonly pass: string };
			}
			class Pooled {
				readonly pool: { readonly size: number; readonly options: Options };
				constructor(options: Options) {
					this.pool = { size: 2, options };
				}
				getOptions(): Options {
					return this.pool.options;
				}
				async fetchAll(): Promise<{ readonly all: ReadonlyArray<Options> }> {
					return { all: [this.pool.options, this.pool.options] };
				}
			}
			const upstream = new Pooled({ host: "smtp", auth: { user: "me", pass: "hunter2" } });
			const facade = effectify(
				upstream,
				{
					name: "Pooled",
					spec: {
						methods: ["getOptions", "fetchAll"],
						async: { fetchAll: true },
						properties: { pool: true },
						concealed: [["auth", "pass"]],
					},
				},
				{},
				classify,
			) as unknown as Effectified<
				Pooled,
				TestError,
				never,
				"getOptions" | "fetchAll",
				"pool",
				never,
				never,
				"getOptions" | "fetchAll" | "pool",
				{},
				never,
				readonly ["auth", "pass"]
			>;
			expectTypeOf(facade.pool.options.auth.pass).toEqualTypeOf<Redacted.Redacted<string>>();
			expectTypeOf(facade.pool.size).toEqualTypeOf<number>();
			expectTypeOf(facade.getOptions().auth.pass).toEqualTypeOf<Redacted.Redacted<string>>();
			const fetched = yield* facade.fetchAll();
			expectTypeOf(fetched.all[0]?.auth.pass).toEqualTypeOf<Redacted.Redacted<string> | undefined>();
			for (const pass of [
				facade.pool.options.auth.pass,
				facade.getOptions().auth.pass,
				...fetched.all.map((options) => options.auth.pass),
			]) {
				expect(Redacted.isRedacted(pass) && Redacted.value(pass)).toBe("hunter2");
			}
			expect(facade.pool.options.host).toBe("smtp");
			expect(facade.pool.size).toBe(2);
			expect(inspect([facade.pool, facade.getOptions(), fetched], { depth: 10 })).not.toContain("hunter2");
			expect(upstream.pool.options.auth.pass).toBe("hunter2");
		}),
	);

	it("serialises, inspects and prints as its handle's name, whatever upstream's own toJSON and toString show", () => {
		class Account {
			readonly password = "hunter2";
			toJSON(): { readonly password: string } {
				return { password: this.password };
			}
			toString(): string {
				return this.password;
			}
			label(): string {
				return "account";
			}
		}
		// The spec lists `toJSON` and `toString` as a method like any other: the facade's own still win.
		const facade = effectify(
			new Account(),
			{ name: "Account", spec: { methods: ["label", "toJSON", "toString"], async: {} } },
			{},
			classify,
		) as unknown as Effectified<Account, TestError, never, "label">;
		const some = Option.some(facade);
		for (const shown of [
			JSON.stringify(facade),
			inspect(facade, { depth: 10 }),
			String(facade),
			`${facade}`,
			JSON.stringify(some),
			inspect(some, { depth: 10 }),
			String(some),
		]) {
			expect(shown).not.toContain("hunter2");
			expect(shown).toContain("Account");
		}
		expect(JSON.stringify(facade)).toBe(`{"_id":"Account"}`);
		expect(facade.label()).toBe("account");
	});

	it.effect(
		"scrubs a secret it revealed from the message and string fields of every failure of the call and of the handles it made, and keeps upstream's failure only as a Redacted cause",
		() =>
			Effect.gen(function* () {
				const passes: Array<string> = [];
				// An SMTP server that echoes the password in its 535 reply, as a misconfigured relay may.
				const smtp = vault((pass) => {
					const failure = new SmtpError(
						`Invalid login: 535 ${pass} rejected`,
						`535 5.7.8 ${pass} rejected`,
						pass,
						{
							cause: new Error(`AUTH PLAIN failed for ${pass}`),
						},
					);
					// Undeclared state of upstream's failure, in shapes no scrub of strings reaches.
					return Object.assign(failure, { bytes: Buffer.from(pass), session: { pass } });
				}, passes);
				const failures = [
					yield* Effect.flip(
						Effect.flatMap(
							smtp.connect({ host: "smtp", auth: { user: "me", pass: Redacted.make("hunter2") } }),
							(made) => made.verify(),
						),
					),
					// A secret the caller gave as a plain string sits where the recipe names one: it is scrubbed too.
					yield* Effect.flip(
						Effect.flatMap(smtp.connect({ host: "smtp", auth: { user: "me", pass: "hunter2" } }), (made) =>
							made.verify(),
						),
					),
					yield* Effect.flip(smtp.reject({ host: "smtp", auth: { user: "me", pass: Redacted.make("hunter2") } })),
				];
				for (const error of failures) {
					expect(Redacted.isRedacted(error.cause)).toBe(true);
					const upstream = Redacted.value(error.cause);
					// Reached on purpose, upstream's failure is its own object, never a copy.
					expect(upstream).toBeInstanceOf(SmtpError);
					expect((upstream as SmtpError).response).toContain("hunter2");
					const encoded = yield* Schema.encodeEffect(VaultFailure)(error);
					for (const shown of [
						error.message,
						error.response,
						error.detail,
						String(error),
						String(error.cause),
						inspect(error, { depth: 10 }),
						Cause.pretty(Cause.fail(error)),
						JSON.stringify(error),
						JSON.stringify(encoded),
					]) {
						expect(shown).not.toContain("hunter2");
						expect(shown).not.toContain(Buffer.from("hunter2").toString("hex").slice(0, 8));
					}
					expect(error.message).toContain("<redacted>");
					expect(error.response).toContain("<redacted>");
				}
				expect(passes).toStrictEqual(["hunter2", "hunter2", "hunter2"]);
			}),
	);

	it.effect(
		"encodes a failure to canonical JSON with its cause as a marker, whatever upstream failed with, and decodes it back",
		() =>
			Effect.gen(function* () {
				const json = Schema.toCodecJson(VaultFailure);
				const login = { host: "smtp", auth: { user: "me", pass: "hunter2" } };
				const failures = [
					// A plain object, as an upstream may reject with: a credential and nested state.
					yield* Effect.flip(
						vault((pass) => ({ code: "EAUTH", credential: pass, session: { pass, user: "me" } })).reject(login),
					),
					// A real Error of upstream's, with its declared fields.
					yield* Effect.flip(
						vault((pass) => new SmtpError(`Invalid login ${pass}`, `535 ${pass}`, pass)).reject(login),
					),
				];
				for (const error of failures) {
					const encoded = yield* Schema.encodeEffect(json)(error);
					expect(encoded).toMatchObject({ _tag: "VaultFailure", cause: "<redacted>" });
					for (const shown of [
						JSON.stringify(encoded),
						Cause.pretty(Cause.fail(error)),
						JSON.stringify(error),
						inspect(error, { depth: 10 }),
					])
						expect(shown).not.toContain("hunter2");
					// What travels is the marker: the value never leaves the process it failed in.
					const decoded = yield* Schema.decodeEffect(json)(encoded);
					expect(Redacted.isRedacted(decoded.cause) && Redacted.value(decoded.cause)).toBe("<redacted>");
				}
				expect(yield* Schema.encodeEffect(Schema.toCodecJson(Sealed))(Redacted.make({ pass: "hunter2" }))).toBe(
					"<redacted>",
				);
			}),
	);

	it("classifies what a synchronous method throws as it classifies an async failure", () => {
		// A synchronous call given a secret, whose upstream throws a failure echoing it.
		class Signer {
			sign(options: { readonly key: string }): string {
				throw new SmtpError(`bad key ${options.key}`, `535 ${options.key}`, options.key, {
					cause: new Error(options.key),
				});
			}
		}
		const facade = effectify(
			new Signer(),
			{ name: "Signer", spec: { methods: ["sign"], async: {}, secrets: { sign: [["0", "key"]] } } },
			{},
			classifyVault,
		) as unknown as Effectified<
			Signer,
			VaultFailure,
			never,
			"sign",
			never,
			never,
			never,
			"sign",
			{ readonly sign: Redacting<readonly ["0", "key"]> }
		>;
		const thrown = (() => {
			try {
				return facade.sign({ key: Redacted.make("hunter2") });
			} catch (error) {
				return error;
			}
		})();
		expect(thrown).toBeInstanceOf(VaultFailure);
		const failure = thrown as VaultFailure;
		expect([failure.operation, failure.message, failure.response, failure.detail]).toStrictEqual([
			"Signer.sign",
			"bad key <redacted>",
			"535 <redacted>",
			"<redacted>",
		]);
		expect(Redacted.value(failure.cause)).toBeInstanceOf(SmtpError);
		for (const shown of [String(failure), inspect(failure, { depth: 10 }), Cause.pretty(Cause.fail(failure))])
			expect(shown).not.toContain("hunter2");
	});

	it.effect("fails a stream whose call throws as it starts with a classified failure, never a defect", () =>
		Effect.gen(function* () {
			class Feed {
				lines(options: { readonly key: string }): AsyncIterable<string> {
					throw new SmtpError(`bad key ${options.key}`, "535", "x");
				}
			}
			const facade = effectify(
				new Feed(),
				{
					name: "Feed",
					spec: { methods: ["lines"], async: {}, stream: { lines: true }, secrets: { lines: [["0", "key"]] } },
				},
				{},
				classifyVault,
			) as unknown as Effectified<
				Feed,
				VaultFailure,
				never,
				"lines",
				never,
				never,
				never,
				"lines",
				{ readonly lines: Redacting<readonly ["0", "key"]> }
			>;
			const failure = yield* Effect.flip(Stream.runCollect(facade.lines({ key: Redacted.make("hunter2") })));
			expect(failure).toBeInstanceOf(VaultFailure);
			expect([failure.operation, failure.message]).toStrictEqual(["Feed.lines", "bad key <redacted>"]);
		}),
	);

	it.effect(
		"classifies every failure of a stream's iterator with the call's secrets: making it, each step, a step it cannot read, and its return",
		() =>
			Effect.gen(function* () {
				const leak = (key: string) => new SmtpError(`bad key ${key}`, "535", "x");
				// Each iterable upstream returns fails at one point of its iteration, echoing the secret it was given.
				const iterables: Record<string, (key: string) => AsyncIterable<string>> = {
					made: (key) => ({
						[Symbol.asyncIterator]: () => {
							throw leak(key);
						},
					}),
					thrown: (key) => ({
						[Symbol.asyncIterator]: () => ({
							next: () => {
								throw leak(key);
							},
						}),
					}),
					rejected: (key) => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(leak(key)) }) }),
					unreadable: (key) => ({
						[Symbol.asyncIterator]: () => ({
							next: () =>
								Promise.resolve({
									get done(): boolean {
										throw leak(key);
									},
									value: "x",
								}),
						}),
					}),
					// An iterator whose `return` getter throws: read as the stream starts, so it fails, whether or not the
					// stream ends early.
					unreadableReturn: (key) => ({
						[Symbol.asyncIterator]: () => ({
							next: () => Promise.resolve({ done: true, value: undefined }),
							get return(): () => Promise<IteratorResult<string>> {
								throw leak(key);
							},
						}),
					}),
				};
				for (const [point, iterable] of Object.entries(iterables)) {
					const exit = yield* Effect.exit(
						Stream.runCollect(feed(iterable).lines({ key: Redacted.make("hunter2") })),
					);
					expect([
						point,
						Exit.isFailure(exit) && Cause.hasFails(exit.cause) && !Cause.hasDies(exit.cause),
					]).toStrictEqual([point, true]);
					const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
					expect(failure).toBeInstanceOf(VaultFailure);
					expect(failure instanceof VaultFailure && failure.message).toBe("bad key <redacted>");
					expect(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "").not.toContain("hunter2");
				}
				// A `return()` that fails as the stream ends early: nothing to fail with, but no secret in what it dies of.
				const returning = (key: string): AsyncIterable<string> => ({
					[Symbol.asyncIterator]: () => ({
						next: () => Promise.resolve({ done: false, value: "line" }),
						return: () => Promise.reject(leak(key)),
					}),
				});
				const ended = yield* Effect.exit(
					Stream.runCollect(Stream.take(feed(returning).lines({ key: Redacted.make("hunter2") }), 1)),
				);
				expect(Exit.isFailure(ended) ? Cause.pretty(ended.cause) : "").not.toContain("hunter2");
			}),
	);

	it.effect("reads each secret once, at the call: the value it scrubs is the value upstream was given", () =>
		Effect.gen(function* () {
			const passes: Array<string> = [];
			const smtp = vault((pass) => new SmtpError(`bad password ${pass}`, `535 ${pass}`, pass), passes);
			let reads = 0;
			const auth = {
				user: "me",
				// A getter that answers differently on every read: only the first value reaches upstream.
				get pass(): string {
					reads++;
					return reads === 1 ? "first-secret" : `later-secret-${reads}`;
				},
			};
			const error = yield* Effect.flip(smtp.reject({ host: "smtp", auth }));
			expect(reads).toBe(1);
			expect(passes).toStrictEqual(["first-secret"]);
			expect(error.message).toBe("bad password <redacted>");
			expect(error.response).toBe("535 <redacted>");
		}),
	);

	it.effect("reads nothing of upstream's failure but its message, its code and the fields its error declares", () =>
		Effect.gen(function* () {
			// An own getter that throws a secret-bearing error: never read, so no defect carries it.
			const trapped = vault((pass) =>
				Object.defineProperty(new SmtpError(`refused ${pass}`, "535", "x"), "transcript", {
					enumerable: true,
					get: () => {
						throw new Error(`transcript of ${pass}`);
					},
				}),
			);
			const exit = yield* Effect.exit(trapped.reject({ host: "smtp", auth: { user: "me", pass: "hunter2" } }));
			expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
			expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).not.toContain("hunter2");
			// A declared field behind a private field: read from upstream's own object, whose getter works on it.
			const declared = yield* Effect.flip(
				vault((pass) => new SmtpError("refused", "535", `detail with ${pass}`)).reject({
					host: "smtp",
					auth: { user: "me", pass: "hunter2" },
				}),
			);
			expect(declared.detail).toBe("detail with <redacted>");
			// A declared field whose getter throws: classified as a failure that could not be read, never a defect.
			class Throwing extends SmtpError {
				override get detail(): string {
					throw new Error("detail of hunter2");
				}
			}
			const unreadable = yield* Effect.exit(
				vault(() => new Throwing("refused", "535", "x")).reject({
					host: "smtp",
					auth: { user: "me", pass: "hunter2" },
				}),
			);
			expect(Exit.isFailure(unreadable) && Cause.hasFails(unreadable.cause)).toBe(true);
			expect(Exit.isFailure(unreadable) && Cause.pretty(unreadable.cause)).not.toContain("hunter2");
			// A cause chain deeper than the stack: never walked.
			let deep: Error = new Error("bottom hunter2");
			for (let depth = 0; depth < 100_000; depth++) deep = new Error("level", { cause: deep });
			const chained = yield* Effect.exit(
				vault(() => deep).reject({ host: "smtp", auth: { user: "me", pass: "hunter2" } }),
			);
			expect(Exit.isFailure(chained) && Cause.hasFails(chained.cause)).toBe(true);
		}),
	);

	it.effect("copies a code verbatim, and scrubs no secret shorter than four characters", () =>
		Effect.gen(function* () {
			const coded = (pass: string) =>
				vault((given) => Object.assign(new Error(`Invalid login: EAUTH for ${given}`), { code: "EAUTH" })).reject({
					host: "smtp",
					auth: { user: "me", pass },
				});
			const short = yield* Effect.flip(coded("A"));
			expect(short.code).toBe("EAUTH");
			expect(short.message).toBe("Invalid login: EAUTH for A");
			const long = yield* Effect.flip(coded("AUTH"));
			expect(long.code).toBe("EAUTH");
			expect(long.message).toBe("Invalid login: E<redacted> for <redacted>");
			// A secret inside another is scrubbed with it, the longest first.
			expect(scrubbed("token hunter2-and-more, hunter2", ["hunter2", "hunter2-and-more"])).toBe(
				"token <redacted>, <redacted>",
			);
		}),
	);
});

/** An upstream failure the way an SMTP client makes one: a reply it echoes, and a field behind a private one. */
class SmtpError extends Error {
	readonly response: string;
	readonly #detail: string;
	constructor(message: string, response: string, detail: string, options?: ErrorOptions) {
		super(message, options);
		this.response = response;
		this.#detail = detail;
	}
	get detail(): string {
		return this.#detail;
	}
}

class VaultFailure extends Schema.TaggedError<VaultFailure, { readonly brand: unique symbol }>()("VaultFailure", {
	...errorFields,
	response: Schema.optional(Schema.String),
	detail: Schema.optional(Schema.String),
}) {}

/** What the generator writes for `SmtpError`: its declared string fields scrubbed of the call's secrets. */
const classifyVault: Classify<VaultFailure> = (operation, cause, secrets) =>
	cause instanceof SmtpError
		? VaultFailure.make(
				{
					...describeFailure(operation, cause, secrets),
					response: scrubbed(cause.response, secrets),
					detail: scrubbed(cause.detail, secrets),
				},
				unchecked,
			)
		: VaultFailure.make(describeFailure(operation, cause, secrets), unchecked);

/** A facade of an upstream whose `lines` streams the iterable `iterable` makes of the secret the call is given. */
function feed(iterable: (key: string) => AsyncIterable<string>) {
	class Feed {
		lines(options: { readonly key: string }): AsyncIterable<string> {
			return iterable(options.key);
		}
	}
	return effectify(
		new Feed(),
		{
			name: "Feed",
			spec: { methods: ["lines"], async: {}, stream: { lines: true }, secrets: { lines: [["0", "key"]] } },
		},
		{},
		classifyVault,
	) as unknown as Effectified<
		Feed,
		VaultFailure,
		never,
		"lines",
		never,
		never,
		never,
		"lines",
		{ readonly lines: Redacting<readonly ["0", "key"]> }
	>;
}

interface Login {
	readonly host: string;
	readonly auth: { readonly user: string; readonly pass: string };
}

/**
 * A client that takes a password in its options and fails with `failure(password)`: `connect` makes a handle whose
 * `verify` fails, `reject` fails at once. Each password upstream receives is pushed to `passes`.
 */
function vault(failure: (pass: string) => unknown, passes: Array<string> = []) {
	class Smtp {
		readonly options: Login;
		constructor(options: Login) {
			this.options = options;
		}
		async verify(): Promise<true> {
			throw failure(this.options.auth.pass);
		}
	}
	type SmtpFacade = Effectified<Smtp, VaultFailure, never, "verify">;
	const smtpKinds: Record<string, HandleKind> = {
		Smtp: { name: "Smtp", spec: { methods: ["verify"], async: { verify: true } } },
	};
	const made = (options: Login) => {
		passes.push(options.auth.pass);
		return new Smtp(options);
	};
	const rejected = async (options: Login): Promise<never> => {
		passes.push(options.auth.pass);
		throw failure(options.auth.pass);
	};
	const secrets = { secrets: [["0", "auth", "pass"]] };
	return {
		connect: entry<
			typeof made,
			VaultFailure,
			readonly [Smtp, SmtpFacade, false],
			false,
			Redacting<readonly ["0", "auth", "pass"]>
		>(made, "connect", smtpKinds["Smtp"], smtpKinds, classifyVault, secrets),
		reject: entry<typeof rejected, VaultFailure, never, false, Redacting<readonly ["0", "auth", "pass"]>>(
			rejected,
			"reject",
			undefined,
			{},
			classifyVault,
			secrets,
		),
	};
}

describe("secrets in results", () => {
	const holder = (result: () => unknown) =>
		effectify(
			{ read: result },
			{ name: "Holder", spec: { methods: ["read"], async: {}, concealed: [["auth", "pass"]] } },
			{},
			classify,
		) as unknown as { readonly read: () => unknown };

	it("conceals a cyclic result in one walk: the cycle kept in the copy, the secret Redacted wherever it is", () => {
		const kept: Record<string, unknown> = { auth: { user: "me", pass: "hunter2" } };
		kept["self"] = kept;
		const shown = holder(() => kept).read() as { readonly self: typeof shown; readonly auth: { pass: unknown } };
		expect(shown).not.toBe(kept);
		expect(shown.self).toBe(shown);
		expect(Redacted.isRedacted(shown.self.auth.pass)).toBe(true);
		expect(inspect(shown, { depth: 10 })).not.toContain("hunter2");
		expect(kept["auth"]).toStrictEqual({ user: "me", pass: "hunter2" });
	});

	it("copies a shared graph once per object, its sharing kept", () => {
		const bottom = { auth: { pass: "hunter2" } };
		let top: Record<string, unknown> = bottom;
		for (let level = 0; level < 16; level++) top = { left: top, right: top };
		const shown = holder(() => top).read();
		const seen = new Set<unknown>();
		const visit = (value: unknown): void => {
			if (typeof value !== "object" || value === null || Redacted.isRedacted(value) || seen.has(value)) return;
			seen.add(value);
			for (const field of Object.values(value)) visit(field);
		};
		visit(shown);
		// 16 levels, the bottom and its `auth`: one copy each.
		expect(seen.size).toBe(18);
		const left = (shown as { readonly left: unknown; readonly right: unknown }).left;
		expect(left).toBe((shown as { readonly right: unknown }).right);
	});

	it("keeps the holes of a sparse array as holes, its length too", () => {
		// Holes at 0, 2 and 3: only index 1 is set.
		const kept: Array<unknown> = [];
		kept[1] = { auth: { user: "me", pass: "hunter2" } };
		kept.length = 4;
		const shown = holder(() => kept).read() as ReadonlyArray<
			{ readonly auth: { readonly pass: unknown } } | undefined
		>;
		expect(shown).not.toBe(kept);
		expect(shown).toHaveLength(4);
		expect([0 in shown, 1 in shown, 2 in shown, 3 in shown]).toStrictEqual([false, true, false, false]);
		expect(Redacted.isRedacted(shown[1]?.auth.pass)).toBe(true);
		expect(inspect(shown, { depth: 10 })).not.toContain("hunter2");
	});

	it("keeps any value but a plain object or array as it is, and Redacted at a secret's path", () => {
		class Session {
			readonly pass = "hunter2";
		}
		const bytes = Buffer.from("hunter2");
		const values = {
			date: new Date(0),
			map: new Map([["pass", "hunter2"]]),
			set: new Set(["hunter2"]),
			pattern: /hunter2/,
			typed: new Uint8Array(bytes),
			session: new Session(),
			bytes,
		};
		const shown = holder(() => ({ auth: { pass: bytes }, values })).read() as {
			readonly auth: { readonly pass: unknown };
			readonly values: typeof values;
		};
		expect(Redacted.isRedacted(shown.auth.pass) && Redacted.value(shown.auth.pass)).toBe(bytes);
		for (const key of Object.keys(values) as ReadonlyArray<keyof typeof values>)
			expect(shown.values[key]).toBe(values[key]);
	});
});

describe("identity", () => {
	it.effect("makes two facades of one upstream object equal and hash alike, and others not", () =>
		Effect.gen(function* () {
			const upstream = new Client();
			const [a, b, other] = [client(upstream), client(upstream), client()];
			expect(Equal.equals(a, b)).toBe(true);
			expect(Equal.equals(a, other)).toBe(false);
			expect(HashSet.size(HashSet.make(a, b, other))).toBe(2);
		}),
	);
});

describe("errors", () => {
	it("describes a failure with its code only when upstream gave a string one, and its cause as Redacted", () => {
		const cause = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
		const described = describeFailure("Mail.verify", cause, []);
		expect({ ...described, cause: undefined }).toStrictEqual({
			operation: "Mail.verify",
			message: "refused",
			code: "ECONNREFUSED",
			cause: undefined,
		});
		expect(Redacted.value(described.cause)).toBe(cause);
		const status = describeFailure("Mail.verify", 404, []);
		expect(Object.keys(status)).toStrictEqual(["operation", "message", "cause"]);
		expect([status.message, Redacted.value(status.cause)]).toStrictEqual(["404", 404]);
	});

	it("finds a code among an error's reasons", () => {
		expectTypeOf(codeIn(["EAUTH", "ETLS"], "EAUTH")).toEqualTypeOf<"EAUTH" | "ETLS" | undefined>();
		expect(codeIn(["EAUTH", "ETLS"], "EAUTH")).toBe("EAUTH");
		expect(codeIn(["EAUTH", "ETLS"], "EPIPE")).toBeUndefined();
	});
});

/** An emitter that emits once per call of `tick`, with a listener count. */
class Ticker {
	listeners: Array<(value: number) => void> = [];
	on(_event: "tick", listener: (value: number) => void): this {
		this.listeners.push(listener);
		return this;
	}
	off(_event: "tick", listener: (value: number) => void): this {
		this.listeners = this.listeners.filter((other) => other !== listener);
		return this;
	}
	tick(value: number): void {
		for (const listener of this.listeners) listener(value);
	}
}

describe("events", () => {
	it.live("streams emissions under a span while the stream runs, and keeps only the newest of a bounded buffer", () =>
		Effect.gen(function* () {
			const { names, tracer } = recording();
			const ticker = new Ticker();
			const fiber = yield* Effect.forkChild(
				events<[number]>(ticker, "tick", "Ticker.events.tick", { bufferSize: 2 }).pipe(
					Stream.take(2),
					Stream.runCollect,
					Effect.withTracer(tracer),
				),
				{
					startImmediately: true,
				},
			);
			yield* Effect.yieldNow;
			expect(ticker.listeners.length).toBe(1);
			for (const value of [1, 2, 3, 4]) ticker.tick(value);
			expect(yield* Fiber.join(fiber)).toStrictEqual([[3], [4]]);
			expect(ticker.listeners.length).toBe(0);
			expect(names).toStrictEqual(["Ticker.events.tick"]);
		}),
	);
});

/** An upstream with ids of one kind of thing, in a property, a parameter and a result. */
class Jobs {
	readonly id: string | undefined = "queue-1";
	async get(jobId: string): Promise<{ readonly jobId: string; readonly data: number }> {
		return { jobId, data: jobId.length };
	}
}

const JobId = Schema.String.pipe(Schema.brand("JobId"));
type JobId = typeof JobId.Type;

describe("brands", () => {
	it("brands a property, a parameter and a field of a result, for types only", () => {
		type Facade = Effectified<
			Jobs,
			TestError,
			never,
			"get",
			never,
			never,
			never,
			"get",
			{ readonly get: Branding<readonly ["0"], JobId> }
		>;
		expectTypeOf<Branded<Jobs["id"], JobId>>().toEqualTypeOf<JobId | undefined>();
		expectTypeOf<Parameters<Facade["get"]>>().toEqualTypeOf<[jobId: string & Brand.Brand<"JobId">]>();
		type Resolving = ResolvingBranded<Facade["get"], Branding<readonly ["jobId"], JobId>>;
		expectTypeOf<Effect.Success<ReturnType<Resolving>>>().toEqualTypeOf<{
			readonly jobId: JobId;
			readonly data: number;
		}>();
		// Typed only, never called: a plain string is no JobId, the brand made from one is.
		const call = (facade: Facade) => [
			// @ts-expect-error a plain string is no JobId
			facade.get("job-1"),
			facade.get(JobId.make("job-1")),
		];
		expect(call).toBeTypeOf("function");
	});
});
