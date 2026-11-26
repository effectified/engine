// The runtime facades carry: what the types promise (checked by tsc) and what the objects do (run here).
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect";
import { type Effectified, effectify, entry, type HandleKind } from "../src/runtime/effectify.ts";

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

class TestError extends Schema.TaggedError<TestError>()("TestError", {
	operation: Schema.String,
	code: Schema.optional(Schema.String),
}) {}

type Handles = readonly [Client, ClientFacade, false] | readonly [Connection, ConnectionFacade, true];
interface ClientFacade extends Effectified<Client, TestError, Handles> {}
interface ConnectionFacade extends Effectified<Connection, TestError, Handles> {}

const kinds: Record<string, HandleKind> = {
	Client: {
		name: "Client",
		spec: { methods: ["connect", "send", "name", "with", "owns", "ping"], async: { connect: true, send: true, ping: true }, returns: { connect: "Connection", with: "Client" } },
	},
	Connection: {
		name: "Connection",
		spec: { methods: ["query", "rows", "close"], async: { query: true, close: true }, stream: { rows: true } },
		release: "close",
	},
};

const classify = (operation: string, cause: unknown) =>
	new TestError({ operation, code: (cause as { code?: string }).code ?? undefined });

const client = (upstream = new Client()) =>
	effectify(upstream, kinds["Client"]!, kinds, classify) as unknown as ClientFacade;

describe("types", () => {
	it("keeps the promise overload and drops the callback one", () => {
		expectTypeOf(client().send("x")).toEqualTypeOf<Effect.Effect<string, TestError>>();
		// @ts-expect-error the callback overload is not part of the facade
		client().send("x", () => {});
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

	it("turns async iterables into streams", () => {
		expectTypeOf<ReturnType<ConnectionFacade["rows"]>>().toEqualTypeOf<Stream.Stream<number, TestError>>();
	});
});

describe("effectify", () => {
	it.effect("runs an async method as an Effect", () =>
		Effect.gen(function* () {
			expect(yield* client().send("hi")).toBe("HI");
		}),
	);

	it.effect("classifies a rejection with the operation and upstream code", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.scoped(
				Effect.flatMap(client().connect(), (connection) => connection.query("bad")),
			).pipe(Effect.exit);
			expect(exit).toStrictEqual(Exit.fail(new TestError({ operation: "Connection.query", code: "E_SYNTAX" })));
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
			const rows = yield* Effect.scoped(
				Effect.flatMap(client().connect(), (c) => Stream.runCollect(c.rows())),
			);
			expect(rows).toStrictEqual([1, 2]);
		}),
	);

	it("keeps builders chainable and synchronous methods as they are", () => {
		const facade = client().with("renamed");
		expect(facade.name()).toBe("renamed");
		expect(facade.upstream).toBeInstanceOf(Client);
	});

	it.effect("hands upstream its own object when given a facade, and types the facade as accepted", () =>
		Effect.gen(function* () {
			const facade = client();
			const connection = yield* Effect.scoped(facade.connect());
			expectTypeOf(facade.owns).parameter(0).toEqualTypeOf<Connection | ConnectionFacade>();
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
				signal: { wait: { index: 1 }, request: { index: 1, property: "signal" }, pages: { index: 0, property: "signal" } },
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
			const wait = entry<typeof run, TestError, never>(run, "wait", undefined, {}, classify, { signal: { index: 1 } });
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
});

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
		setTimeout(() => (path === "missing" ? callback(Object.assign(new Error("no such file"), { code: "ENOENT" }), "") : callback(null, `<${path}>`)), 1);
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
		{ name: "Terminal", spec: { methods: ["write", "read", "attachKeyHandler"], async: {}, callback: { write: "done", read: "node" } } },
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
