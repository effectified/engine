// The Effect-native standard a facade is held to, and the step that holds it: the Effect team's `@effect/tsgo` rules
// (presets correctness, antipattern, strict and effect-native, as errors), configured in the plugin block every
// generated tsconfig.json carries and run by the Effect-patched tsrs, and the idioms of `src/idioms.ts` run by oxlint.
// `reconcile` and `verify` fail on any error in a facade's sources and tests, so a regression of the generator or a
// hand-written test is named where it is.

import { Effect, Equal, FileSystem, Option, Path, Schema } from "effect";
import { runCommand, temporaryDirectory } from "./command.ts";
import { IDIOM_RULES, IDIOMS_PLUGIN } from "./idioms.ts";

/** Rules every file of a facade keeps: the presets correctness and antipattern, as errors. */
const EVERYWHERE = {
	anyUnknownInErrorContext: "error",
	classSelfMismatch: "error",
	duplicatePackage: "error",
	effectFnImplicitAny: "error",
	errorPayloadShadowsName: "error",
	// Effect's experimental and alpha APIs are taken (the owner's decision for effectified): no decision per use.
	experimentalApiUsage: "off",
	floatingEffect: "error",
	floatingEffectInVitest: "error",
	genericEffectServices: "error",
	missingEffectContext: "error",
	missingEffectError: "error",
	missingLayerContext: "error",
	missingReturnYieldStar: "error",
	missingStarInYieldEffectGen: "error",
	nonObjectEffectServiceType: "error",
	obsoleteMatchImport: "error",
	obsoleteSchemaImport: "error",
	outdatedApi: "error",
	overriddenSchemaConstructor: "error",
	promiseInEffectSuccess: "error",
	schemaClassMissingBrand: "error",
	schemaClassObjectLiteral: "error",
	schemaLiteralNonFinite: "error",
	schemaOpaqueInstanceMember: "error",
	unsafeEffectTypeAssertion: "error",
	// An unstable Effect module is a decision: each one a facade uses is listed in `allowedUnstableApis`.
	unstableApiUsage: "error",
	catchUnfailableEffect: "error",
	effectFnIife: "error",
	effectGenUsesAdapter: "error",
	effectInFailure: "error",
	effectInVoidSuccess: "error",
	effectTryWithoutCatch: "error",
	globalErrorInEffectCatch: "error",
	globalErrorInEffectFailure: "error",
	layerMergeAllWithDependencies: "error",
	lazyEffect: "error",
	lazyPromiseInEffectSync: "error",
	leakingRequirements: "error",
	multipleEffectProvide: "error",
	preferUnsafeConstructor: "error",
	returnEffectInGen: "error",
	runEffectInsideEffect: "error",
	schemaSyncInEffect: "error",
	scopeInLayerEffect: "error",
	tryCatchInEffectGen: "error",
	unknownInEffectCatch: "error",
} as const;

/**
 * Rules a facade's sources add: the rest of the presets strict and effect-native, and the style rules effectified
 * adopts. Off, with the reason: `missingPipeableSignature` flags every constructor and builder (a dual signature is
 * written by hand for an operation on its module's own type, and a facade writes none); `missedPipeableOpportunity`
 * is a call of readability per site.
 */
const SOURCES = {
	// A library leaves providing its layers to the application.
	strictEffectProvide: "error",
	abortControllerInEffect: "error",
	asyncFunction: "error",
	cryptoRandomUUID: "error",
	cryptoRandomUUIDInEffect: "error",
	extendsNativeError: "error",
	globalConsole: "error",
	globalConsoleInEffect: "error",
	globalDate: "error",
	globalDateInEffect: "error",
	globalFetch: "error",
	globalFetchInEffect: "error",
	globalJson: "error",
	globalJsonInEffect: "error",
	globalRandom: "error",
	globalRandomInEffect: "error",
	globalTimers: "error",
	globalTimersInEffect: "error",
	instanceOfSchema: "error",
	newPromise: "error",
	nodeBuiltinImport: "error",
	preferEffectArray: "error",
	preferEffectRecord: "error",
	preferEffectString: "error",
	processEnv: "error",
	processEnvInEffect: "error",
	promiseAllInEffect: "error",
	promiseRaceInEffect: "error",
	schemaSync: "error",
	acquireReleaseDisposable: "error",
	allOfMapToForEach: "error",
	catchAllTagDispatchToCatchTag: "error",
	catchAllToMapError: "error",
	catchChainToFirstSuccessOf: "error",
	catchConditionalRefailToCatchIf: "error",
	catchDieToOrDie: "error",
	catchIfTagToCatchTag: "error",
	catchRefailToTapError: "error",
	catchTagToCatchReason: "error",
	catchToIgnore: "error",
	catchToOrElseSucceed: "error",
	effectFnOpportunity: "error",
	effectMapFlatten: "error",
	effectMapVoid: "error",
	effectSleepZeroToYieldNow: "error",
	effectSucceedWithUndefined: "error",
	effectSucceedWithVoid: "error",
	failCauseToConstructor: "error",
	flatMapConditionalToFilterOrFail: "error",
	flatMapIdentityToFlatten: "error",
	flatMapIgnoredParamToAndThen: "error",
	flatMapMapToZipWith: "error",
	flatMapProvideServiceToProvideServiceEffect: "error",
	flatMapToMap: "error",
	flatMapToTap: "error",
	manualMetricTapToTrack: "error",
	mapConstToAs: "error",
	mapSomeCatchNoSuchElement: "error",
	mapSomeToAsSome: "error",
	matchBooleanToIsSuccess: "error",
	matchEffectToMapBoth: "error",
	matchEffectToMatch: "error",
	matchToResultOrOption: "error",
	multipleCatchTag: "error",
	onExitFailureToOnError: "error",
	optionMatchToFromOption: "error",
	preferSucceedSomeOrNone: "error",
	preferTypedSchemaDecoder: "error",
	provideLayerSucceedToProvideService: "error",
	raceFirstWithSleepToTimeout: "error",
	redundantMapError: "error",
	redundantOrDie: "error",
	redundantSchemaTagIdentifier: "error",
	resultMatchToFromResult: "error",
	runOfExitToRunExit: "error",
	schemaNumber: "error",
	schemaStructWithTag: "error",
	suspendFailToFailSync: "error",
	syncToSucceed: "error",
	timeoutCatchTagToTimeoutOrElse: "error",
	unnecessaryEffectGen: "error",
	unnecessaryFailYieldableError: "error",
	unnecessaryPipe: "error",
	unnecessaryPipeChain: "error",
	unnecessaryTypeofType: "error",
	deterministicKeys: "error",
	effectDoNotation: "error",
	forLoopPushToForEach: "error",
	mapMapErrorToMapBoth: "error",
	missingConcurrencyOption: "error",
	missingEffectServiceDependency: "error",
	nestedEffectGenYield: "error",
	newSchemaClass: "error",
	preferSchemaTaggedError: "error",
	preferSchemaTypeProperty: "error",
	provideMergeAllToArray: "error",
	schemaUnionOfLiterals: "error",
	serviceNotAsClass: "error",
	strictBooleanExpressions: "error",
	typeUnionToSchemaUnion: "error",
	unnecessaryArrowBlock: "error",
	yieldInCallArgument: "error",
	missingPipeableSignature: "off",
	missedPipeableOpportunity: "off",
} as const;

/**
 * Rules a facade's tests leave off: a test is an application's entry point, so it may provide layers one after
 * another and keep an `unknown` failure of the code it observes; the type-test rules repeat errors `@ts-expect-error`
 * lines assert; a helper may `yield* Effect.never`.
 */
const TESTS = {
	anyUnknownInErrorContext: "off",
	multipleEffectProvide: "off",
	missingEffectContext: "off",
	missingEffectError: "off",
	missingLayerContext: "off",
	missingReturnYieldStar: "off",
} as const;

/** The unstable modules a facade's tests use: `@effect/vitest`, Effect's test runner, is marked unstable. */
const TEST_UNSTABLE_APIS = ["@effect/vitest"];

/** The extensions of every TypeScript source tsrs checks: a facade's sources and tests in any of them meet the standard. */
const SOURCE_EXTENSIONS = ["ts", "tsx", "mts", "cts"];

/** Every TypeScript source under a directory of a package, as `FileSystem.glob` matches it. */
const sourcesUnder = (directory: string) => `${directory}/**/*.{${SOURCE_EXTENSIONS.join(",")}}`;

/**
 * The plugin block of every generated tsconfig.json: the Effect language service's rules as this standard sets
 * them. `tsc` ignores plugins; the Effect-patched tsrs (the `effectNative` step) and an editor with the Effect
 * language service read them. Override globs are relative to the tsconfig, one per extension.
 */
export const EFFECT_PLUGIN = {
	name: "@effect/language-service",
	diagnosticSeverity: EVERYWHERE,
	overrides: [
		{
			include: SOURCE_EXTENSIONS.map((extension) => `./src/**/*.${extension}`),
			options: { diagnosticSeverity: SOURCES },
		},
		{
			include: SOURCE_EXTENSIONS.map((extension) => `./test/**/*.${extension}`),
			options: { diagnosticSeverity: TESTS, allowedUnstableApis: TEST_UNSTABLE_APIS },
		},
	],
};

/** The facade did not hold to the standard: each finding as `<rules> file:line:column rule: message`. */
export class EffectNativeError extends Schema.TaggedError<EffectNativeError, { readonly brand: unique symbol }>()(
	"EffectNativeError",
	{
		findings: Schema.Array(Schema.String),
	},
) {}

/**
 * Holds a generated package to the Effect-native standard: the Effect rules its tsconfig.json carries, no rule turned
 * off in its sources or tests without a reason (`suppressionFindings`), and the idioms over its sources. Fails with
 * every finding; returns, as notes, what only TypeScript 7.1 rejects.
 */
export const effectNative = Effect.fn("effectNative")(function* (packageDirectory: string) {
	const fs = yield* FileSystem.FileSystem;
	const sources = yield* fs.glob(sourcesUnder("src"), { root: packageDirectory });
	const tests = yield* fs.glob(sourcesUnder("test"), { root: packageDirectory });
	const [rules, suppressed, idiomatic] = yield* Effect.all(
		[
			effectRules(packageDirectory),
			suppressions(packageDirectory, [...sources, ...tests]),
			idioms(packageDirectory, sources),
		],
		{ concurrency: 3 },
	);
	const findings = [
		...rules.findings.map((finding) => `effect ${finding}`),
		...suppressed.map((finding) => `effect ${finding}`),
		...idiomatic.map((finding) => `idioms ${finding}`),
	];
	if (findings.length > 0) return yield* EffectNativeError.make({ findings });
	return { notes: rules.notes };
});

/** Each directive of `files` (relative to the package) that turns an Effect rule off without a reason. */
const suppressions = Effect.fn("suppressions")(function* (packageDirectory: string, files: ReadonlyArray<string>) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const found = yield* Effect.forEach(files, (file) =>
		Effect.map(fs.readFileString(path.join(packageDirectory, file)), (text) => suppressionFindings(file, text)),
	);
	return found.flat();
});

/**
 * The `@effect-diagnostics` directives in a facade's file that would pass what the standard fails, each as a finding
 * `<file>:<line>:<column> suppression: ...`. The one form kept carries its reason at the site, as the idioms'
 * `idiom-allow` does: `@effect-diagnostics-next-line <rule>:off <reason>`, one rule named, off for the next line only,
 * with why after it in words inside its comment (tsrs reads the rule and skips the words; the end of a block comment,
 * code after it, or a string's closing quote is no reason). Refused: a directive for the rest of the file (`<rule>:off`, `*:off`, `<rule>:skip-file`), a rule lowered
 * to `warning` (a warning fails nothing), every rule (`*`), more than one rule, a rule's name with anything glued to it
 * (`-floatingEffect:off`, which tsrs reads as `floatingEffect:off`), and no reason. A directive is what tsrs reads as
 * one (`DIRECTIVE`, `RULE_LEVEL`, its own patterns), anywhere in the text, a string's too: a mention whose words name
 * no `<rule>:<level>` tsrs applies turns nothing off and is no finding.
 */
export function suppressionFindings(file: string, text: string): ReadonlyArray<string> {
	return text.split(/\r?\n/).flatMap((line, index) => {
		const directive = DIRECTIVE.exec(line);
		if (directive === null) return [];
		const [read, nextLine, words = ""] = directive;
		if (!appliesRule(words)) return [];
		if (
			nextLine !== undefined &&
			isKept(commented(line, directive.index, directive.index + read.length - words.length))
		)
			return [];
		return [
			`${file}:${index + 1}:${directive.index + 1} suppression: turns an Effect rule off without a reason at the site; write \`@effect-diagnostics-next-line <rule>:off <reason>\` above the line`,
		];
	});
}

/**
 * A directive as tsrs 7.1.0-beta.tsrs4 finds one, its own pattern (in its binary): its word, in these letters only,
 * then spaces (`-next-lines`, `-next-line,` or a no-break space start none), then the words it reads for rules, of
 * these characters only, up to the first other one (`.` or `(` ends them). tsrs reads one directive per line, the first
 * this matches: a second on the line turns nothing off. Its spaces also take `\n`, left out here: a line is read alone,
 * and tsrs reads no words past its end.
 */
const DIRECTIVE = /@effect-diagnostics(-next-line)?[\t\f\r ]+([0-9A-Za-z_:*-]+(?:[\t\f\r ]+[0-9A-Za-z_:*-]+)*)/;

/**
 * Each `<rule>:<level>` tsrs finds in a directive's words, its own pattern: wherever it starts in a word, so anything
 * before the rule's name is skipped (`-floatingEffect:off` turns floatingEffect off), and the whole level, hyphenated
 * once (`off-x` is a level it does not know, `skip-file-x` reads `skip-file`).
 */
const RULE_LEVEL = /([0-9A-Za-z_]+|\*):([0-9A-Za-z_]+(?:-[0-9A-Za-z_]+)?)/g;

/** The levels tsrs applies, in any case; a pair at any other level turns nothing off. */
const LEVELS: ReadonlySet<string> = new Set(["off", "error", "warning", "message", "suggestion", "skip-file"]);

/** Whether tsrs applies a `<rule>:<level>` of a directive's `words`: a directive whose words have none is a mention. */
function appliesRule(words: string): boolean {
	return Array.from(words.matchAll(RULE_LEVEL)).some(([, , level = ""]) => LEVELS.has(level.toLowerCase()));
}

/** Any `<rule>:<level>` in a reason, however it is glued to the text around it: tsrs may read it as a second one. */
const ANY_RULE_LEVEL = /[\w*]+:(?:off|error|warning|message|suggestion|skip-file)\b/i;

/**
 * A directive's words and what follows them inside its comment, from `words` (the index of its first word) on: to the
 * line's end in a line comment, else up to the first end of a block comment after them (code after it is no reason).
 * A directive outside any comment opened on its line (a block comment's later line, a string) is read as in a block
 * comment, the stricter reading.
 */
function commented(line: string, directive: number, words: number): string {
	if (inLineComment(line.slice(0, directive))) return line.slice(words);
	const end = line.indexOf("*/", words);
	return end === -1 ? line.slice(words) : line.slice(words, end);
}

/**
 * Whether the text before a directive on its line leaves it in a line comment: a `//` outside the block comments
 * before it (`/* see http://x` is a block comment still). Strings before it are not read.
 */
function inLineComment(before: string): boolean {
	let block = false;
	for (let at = 0; at < before.length - 1; at++) {
		const pair = before.slice(at, at + 2);
		if (block ? pair === "*/" : pair === "/*") {
			block = !block;
			at++;
		} else if (!block && pair === "//") return true;
	}
	return false;
}

/**
 * The form kept, from the first of a `@effect-diagnostics-next-line` directive's words to the end of its comment
 * (`commented`): one rule named as it is, turned off, then its reason.
 */
const KEPT_DIRECTIVE = /^\w+:off\s+(.*)$/;

/**
 * Whether a next-line directive, from its first word to the end of its comment, is the kept form: a reason in words,
 * naming no other rule.
 */
function isKept(words: string): boolean {
	const reason = KEPT_DIRECTIVE.exec(words)?.[1];
	return reason !== undefined && /[\p{L}\p{N}]/u.test(reason) && !ANY_RULE_LEVEL.test(reason);
}

/**
 * The build of tsrs (the oxc project's Rust port of the TypeScript 7 compiler) that runs the Effect rules: the
 * Effect-patched one `@effect/tsgo` ships for its version, run as `effect-tsgo <build>`. `pnpm check` names it too.
 */
const TSRS = "tsrs@7.1.0-beta.tsrs4";

/** What `effectRules` found: findings fail the package, notes are TypeScript 7.1's own errors, which fail nothing. */
export interface EffectRules {
	readonly findings: ReadonlyArray<string>;
	readonly notes: ReadonlyArray<string>;
}

/**
 * Runs the Effect rules of the package's tsconfig.json with tsrs, which type checks as TypeScript 7.1 does and reports
 * each rule as a diagnostic `TS377xxx`. An Effect error is a finding. TypeScript's own errors are notes: the facade's
 * users compile with TypeScript 7.0.2, whose verdict `reconcile` and `verify` take before this step. A diagnostic
 * about the whole program (a configuration tsrs cannot load) is a finding: then no rule ran. So is a file of the
 * package's `src/` or `test/` tsrs did not check (no rule ran there either), and a line of its output read as none of
 * its forms (a crash, say).
 */
export const effectRules = Effect.fn("effectRules")(function* (packageDirectory: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const project = path.join(packageDirectory, "tsconfig.json");
	// Trust boundary: a file. The rules tsrs runs are the ones this block names: without it tsrs finds nothing, and with
	// a block of the facade's own (a rule turned off) it passes what the standard fails. Either is no pass.
	const plugins = yield* fs.readFileString(project).pipe(
		Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Tsconfig))),
		Effect.map((tsconfig) => tsconfig.compilerOptions.plugins ?? []),
		Effect.option,
	);
	if (Option.isNone(plugins) || !Equal.equals(plugins.value, [EFFECT_PLUGIN]))
		return {
			findings: ["tsconfig.json's plugins are not the Effect plugin block the engine writes (EFFECT_PLUGIN)"],
			notes: [],
		} satisfies EffectRules;
	const tsgo = path.join(yield* packageRoot("@effect/tsgo"), "dist", "effect-tsgo.cjs");
	// `--noCheck false`: a tsconfig.json that skips checking (`noCheck`, in it or one it extends) runs no rule at all.
	const result = yield* runCommand(
		"node",
		[tsgo, TSRS, "--noEmit", "-p", project, "--pretty", "false", "--listFiles", "--noCheck", "false"],
		packageDirectory,
	);
	const { diagnostics, files, unread } = readTsrsOutput(result.output);
	// tsrs exits non-zero on an error: one it printed in no form read here would otherwise pass unseen.
	if (result.exitCode !== 0 && !diagnostics.some((diagnostic) => diagnostic.severity === "error"))
		return {
			findings: [`tsrs gave no diagnostic (exit ${result.exitCode}): ${result.output.trim().slice(0, 2000)}`],
			notes: [],
		} satisfies EffectRules;
	const findings: Array<string> = unread.map((line) => `tsrs printed a line read as no diagnostic: ${line}`);
	const notes: Array<string> = [];
	for (const diagnostic of diagnostics) {
		switch (diagnostic.kind) {
			case "effect":
				if (diagnostic.severity === "error")
					findings.push(`${diagnostic.at} ${diagnostic.rule}: ${diagnostic.message}`);
				break;
			case "typescript":
				notes.push(`${diagnostic.at} TS${diagnostic.code}: ${diagnostic.message}`);
				break;
			case "program":
				findings.push(`tsconfig.json TS${diagnostic.code}: ${diagnostic.message}`);
				break;
		}
	}
	findings.push(...(yield* unchecked(packageDirectory, files)), ...(yield* missingFiles(files)));
	return { findings, notes } satisfies EffectRules;
});

/** Each of the files tsrs listed that does not exist, as a finding: a line read as a path that is none (a crash's). */
export const missingFiles = Effect.fn("missingFiles")(function* (files: ReadonlyArray<string>) {
	const fs = yield* FileSystem.FileSystem;
	const missing: Array<string> = [];
	for (const file of files)
		if (!(yield* fs.exists(file))) missing.push(`${file}: tsrs listed a file that does not exist`);
	return missing;
});

/**
 * The files of a package's `src/` and `test/` that tsrs did not check, each as a finding: a tsconfig.json whose
 * `include` leaves one out would hide that file's findings. tsrs lists the files it checked as absolute paths, the
 * package's directory as given or with its links resolved.
 */
const unchecked = Effect.fn("unchecked")(function* (packageDirectory: string, checked: ReadonlyArray<string>) {
	const fs = yield* FileSystem.FileSystem;
	const directories = [packageDirectory, yield* fs.realPath(packageDirectory)];
	const files = [
		...(yield* fs.glob(sourcesUnder("src"), { root: packageDirectory })),
		...(yield* fs.glob(sourcesUnder("test"), { root: packageDirectory })),
	];
	return uncheckedFiles(files, checked, directories).map(
		(file) => `${file}: tsrs did not check it (tsconfig.json's include leaves it out)`,
	);
});

/**
 * The `files` (relative to the package) that `listed` (absolute) names under none of the package's `directories`,
 * compared with `/` for every separator: tsrs on Windows may list `C:/...` or `C:\...` whatever the directory says.
 */
export function uncheckedFiles(
	files: ReadonlyArray<string>,
	listed: ReadonlyArray<string>,
	directories: ReadonlyArray<string>,
): ReadonlyArray<string> {
	const slashed = (file: string) => file.replaceAll("\\", "/");
	const checked = new Set(listed.map(slashed));
	const roots = directories.map((directory) => slashed(directory).replace(/\/+$/, ""));
	return files.filter((file) => !roots.some((root) => checked.has(`${root}/${slashed(file)}`)));
}

/** A tsconfig.json as far as the Effect rules need it: its plugin blocks, compared with the engine's whole. */
const Tsconfig = Schema.Struct({
	compilerOptions: Schema.Struct({
		plugins: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	}),
});

/**
 * One diagnostic tsrs printed: an Effect rule's or TypeScript's own, at `file:line:column` as tsrs prints it (relative
 * to the directory it ran in), or one about the whole program.
 */
export type TsrsDiagnostic =
	| {
			readonly kind: "effect";
			readonly at: string;
			readonly severity: string;
			readonly rule: string;
			readonly message: string;
	  }
	| {
			readonly kind: "typescript";
			readonly at: string;
			readonly severity: string;
			readonly code: number;
			readonly message: string;
	  }
	| { readonly kind: "program"; readonly severity: string; readonly code: number; readonly message: string };

/** What `readTsrsOutput` read: the diagnostics, the files tsrs checked, and every line it could not read. */
export interface TsrsOutput {
	readonly diagnostics: ReadonlyArray<TsrsDiagnostic>;
	readonly files: ReadonlyArray<string>;
	readonly unread: ReadonlyArray<string>;
}

/** The line that starts a diagnostic: its place (absent for the whole program), severity, code and message. */
const DIAGNOSTIC_LINE = /^(?:(.+?)\((\d+),(\d+)\): )?(error|warning|suggestion|message) TS(\d+): (.*)$/;

/**
 * A file `--listFiles` lists: an absolute path, POSIX or Windows, ending in an extension tsrs reads (`.ts`, `.tsx`,
 * `.mts`, `.cts`, their JavaScript kin, `.json`; no `.ctsx` or `.mjsx`, which are none); `missingFiles` checks it exists.
 */
const LISTED_FILE = /^(?:\/|[A-Za-z]:[\\/])\S.*\.(?:[jt]sx?|[cm][jt]s|json)$/;

/** How an Effect rule's message ends: `effect(<rule>)`. */
const RULE = /\s*effect\((\w+)\)$/;

/**
 * Reads tsrs's `--pretty false --listFiles` output (`\n` or `\r\n` line ends): diagnostics, `file(line,column):
 * <severity> TS<code>: <message>` (without the place for one about the whole program), a TypeScript error continued
 * by the indented lines after it (TypeScript indents a message's chain), and an Effect rule's (`TS377xxx`) by every
 * line until its message ends with `effect(<rule>)`, which tsrs may put on a line of its own, unindented, and by none
 * after; then the files it checked, one absolute path a line (`LISTED_FILE`). Any other line is unread, never part of
 * a message, and so is every line after the file list begins that is no listed path: a crash printed after an error
 * must not pass as that error's words.
 */
export function readTsrsOutput(output: string): TsrsOutput {
	const started: Array<{ readonly match: RegExpExecArray; message: string }> = [];
	const files: Array<string> = [];
	const unread: Array<string> = [];
	for (const line of output.split(/\r?\n/)) {
		if (line.trim() === "") continue;
		const match = DIAGNOSTIC_LINE.exec(line);
		const last = started.at(-1);
		const listing = files.length > 0;
		const effect = last !== undefined && isEffectCode(Number(last.match[5]));
		const continues = last !== undefined && (effect ? !RULE.test(last.message) : /^\s/.test(line));
		if (listing) (LISTED_FILE.test(line.trimEnd()) ? files : unread).push(line.trimEnd());
		else if (match !== null) started.push({ match, message: match[6] ?? "" });
		else if (last !== undefined && continues) last.message += ` ${line.trim()}`;
		else if (LISTED_FILE.test(line.trimEnd())) files.push(line.trimEnd());
		else unread.push(line);
	}
	return { diagnostics: started.map(({ match, message }) => diagnosticOf(match, message)), files, unread };
}

/** Whether a diagnostic's code is an Effect rule's: `TS377xxx`. */
function isEffectCode(code: number): boolean {
	return code >= 377000 && code < 378000;
}

/** One diagnostic from its first line's match and its whole message. */
function diagnosticOf(match: RegExpExecArray, message: string): TsrsDiagnostic {
	const [, file, line, column, severity = ""] = match;
	const code = Number(match[5]);
	if (file === undefined) return { kind: "program", severity, code, message };
	const at = `${file}:${line}:${column}`;
	if (!isEffectCode(code)) return { kind: "typescript", at, severity, code, message };
	const rule = RULE.exec(message);
	return rule === null
		? { kind: "effect", at, severity, rule: `TS${code}`, message }
		: { kind: "effect", at, severity, rule: rule[1] ?? "", message: message.slice(0, rule.index) };
}

/** The oxlint configuration that runs only the idioms: no category of oxlint's own, every idiom rule an error. */
const IDIOMS_CONFIG = {
	categories: { correctness: "off" },
	jsPlugins: [IDIOMS_PLUGIN],
	rules: Object.fromEntries(IDIOM_RULES.map((rule) => [`idioms/${rule}`, "error"])),
};

/** One diagnostic of `oxlint --format=json`: its rule as `idioms(<rule>)`, and where (line and column 1-based). */
const LintDiagnostic = Schema.Struct({
	message: Schema.String,
	code: Schema.String,
	filename: Schema.String,
	labels: Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Finite, column: Schema.Finite }) })),
});

/** The JSON report of `oxlint --format=json`: its diagnostics and how many files it linted. */
const LintReport = Schema.Struct({ diagnostics: Schema.Array(LintDiagnostic), number_of_files: Schema.Finite });

/**
 * Runs the idioms of `src/idioms.ts` with oxlint on `files` (relative to `directory`): each finding. The files are
 * named one by one, since oxlint skips what a .gitignore around them ignores, even a directory named on its command
 * line. Its configuration is written to a temporary directory: one inside the package would be found by any oxlint run
 * around it.
 */
export const idioms = Effect.fn("idioms")(function* (directory: string, files: ReadonlyArray<string>) {
	if (files.length === 0) return [];
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const config = path.join(yield* temporaryDirectory(), "oxlint.json");
	yield* fs.writeFileString(config, `${JSON.stringify(IDIOMS_CONFIG, null, "\t")}\n`);
	const oxlint = path.join(yield* packageRoot("oxlint"), "bin", "oxlint");
	const result = yield* runCommand(
		"node",
		[oxlint, "-c", config, "--disable-nested-config", "--format=json", ...files],
		directory,
	);
	// Trust boundary: the tool's output, its JSON report between anything it logs.
	const json = result.output.slice(result.output.indexOf("{"), result.output.lastIndexOf("}") + 1);
	const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(LintReport))(json).pipe(Effect.option);
	if (Option.isNone(decoded))
		return [`gave no report (exit ${result.exitCode}): ${result.output.trim().slice(0, 2000)}`];
	const report = decoded.value;
	const skipped =
		report.number_of_files === files.length
			? []
			: [`linted ${report.number_of_files} of the ${files.length} files it was given`];
	const findings = report.diagnostics.map((diagnostic) => {
		const where = diagnostic.labels[0]?.span;
		const rule = /^idioms\((.+)\)$/.exec(diagnostic.code)?.[1] ?? diagnostic.code;
		return `${path.relative(directory, path.resolve(directory, diagnostic.filename))}:${where?.line ?? 0}:${where?.column ?? 0} ${rule}: ${diagnostic.message}`;
	});
	return [...skipped, ...findings];
}, Effect.scoped);

/** The directory of a package the engine depends on, as Node resolves it from the engine. */
const packageRoot = Effect.fn("packageRoot")(function* (name: string) {
	const path = yield* Path.Path;
	// A path, not the URL's `pathname`, which keeps `%20` for a space. Node resolved a `file:` URL, which converts.
	const file = yield* path.fromFileUrl(new URL(import.meta.resolve(`${name}/package.json`))).pipe(Effect.orDie);
	return path.dirname(file);
});
