// The runtime facades carry: what the types promise (checked by tsc) and what the objects do (run here).
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Exit, Schema, Scope, Stream } from "effect";
import { type Effectified, effectify, type HandleKind } from "../src/runtime/effectify.ts";

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
		spec: { methods: ["connect", "send", "name", "with"], async: { connect: true, send: true }, returns: { connect: "Connection", with: "Client" } },
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
