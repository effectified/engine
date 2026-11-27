// cheerio in the regression corpus, run as one of its facade's tests: a traversal that steps back with `end()`, to the
// selection before the last `find`. `end()` takes no argument and gives another selection, so it is no release: a
// borrowed selection keeps it (0.3.0's facade gave it; a facade that read it as the selection's release left it out).
import { Config, Console, Effect } from "effect";
import { load } from "../src/index.ts";

const program = Effect.gen(function* () {
	const $ = yield* load('<main id="parent"><span id="child">text</span></main>');
	// `unknown`: 0.3.0's facade typed what `attr(name)` reads as the selection, though it gave the string.
	const id: unknown = $.root().find("main").find("span").end().attr("id");
	if (id !== "parent") return yield* Effect.die(`end() gave the selection of ${String(id)}, not of its parent`);
	yield* Console.log(id);
	// The corpus's evidence that the program ran to its end (`USE_FINISHED` and `TOKEN_VARIABLE` in scripts/corpus.ts):
	// its last act, with the token the corpus made for this run.
	const token = yield* Config.NonEmptyString("EFFECTIFY_CORPUS_TOKEN");
	yield* Console.log(`corpus: finished ${token}`);
});

Effect.runPromise(program);
