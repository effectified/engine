// What the @effectified packages are on npm, and how npm comes to publish them with no token. A package is published by
// the workflow `release.yml` (TRUSTED_WORKFLOW) of its repository through npm's trusted publishing: npm takes the
// workflow's identity instead of a token, and attests each tarball's provenance. npm trusts a workflow only for a package
// that exists, so `bootstrap`, run once for each new package by a person signed in to npm, publishes a placeholder of
// each package npm has never seen and sets its trusted publisher. Here too: what the registry holds of a package
// (`published`), and the npm a step needs (`requireNpm`).

import { Config, Console, Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient } from "effect/http";
import { runAttached, runBounded, runCommand, temporaryDirectory } from "./command.ts";

/** What the registry holds of a package: nothing, npm having never seen it, or its versions. */
export type Published =
	| { readonly kind: "absent" }
	| { readonly kind: "present"; readonly versions: ReadonlyArray<string> };

/** A package `bootstrap` makes known to npm, and the repository whose `release.yml` is to publish it. */
export interface Publisher {
	readonly name: string;
	readonly repository: string;
}

/** What `bootstrap` did, or in a dry run checked: placeholders published, trusted publishers set. */
export interface Bootstrapped {
	readonly packages: number;
	readonly placeholders: number;
	readonly trusted: number;
}

/**
 * The workflow, in `.github/workflows/` of a package's repository, that npm trusts to publish it. npm binds the trust to
 * the file's name: a rename needs every package's trusted publisher set again.
 */
export const TRUSTED_WORKFLOW = "release.yml";

/** The engine's own package, published by the `release.yml` of its repository. */
export const ENGINE_PUBLISHER: Publisher = { name: "@effectified/engine", repository: "effectified/engine" };

/** The npm that publishes through a workflow's identity, with no token (trusted publishing came with 11.5.1). */
export const PUBLISHING_NPM = [11, 5, 1] as const;

/** The npm that sets a trusted publisher (`npm trust` came with 11.15.0). */
export const TRUSTING_NPM = [11, 15, 0] as const;

/** npm could not be asked, or failed at what a step asked of it. */
export class NpmError extends Schema.TaggedError<NpmError, { readonly brand: unique symbol }>()("NpmError", {
	reason: Schema.String,
}) {}

/** The versions of `name` on npm, or that npm has never seen it. */
export const published = Effect.fn("published")(function* (name: string) {
	const url = `${REGISTRY}/${name.replace("/", "%2f")}`;
	const failed = (reason: string) => new NpmError({ reason: `GET ${url}: ${reason}` });
	const client = yield* HttpClient.HttpClient;
	// The short form of a package's record: its versions without their READMEs.
	const response = yield* client
		.get(url, { accept: "application/vnd.npm.install-v1+json" })
		.pipe(Effect.mapError((cause) => failed(cause.message)));
	if (response.status === 404) return { kind: "absent" } satisfies Published;
	if (response.status !== 200) return yield* failed(`npm answered ${response.status}`);
	// Trust boundary: the registry's answer is wire input.
	const record = yield* response.json.pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(PackageRecord)),
		Effect.mapError((cause) => failed(cause.message)),
	);
	return { kind: "present", versions: Object.keys(record.versions) } satisfies Published;
});

const REGISTRY = "https://registry.npmjs.org";

/** A package's record on the registry, as far as `published` reads it. */
const PackageRecord = Schema.Struct({ versions: Schema.Record(Schema.String, Schema.Unknown) });

/** The version of the npm on the path, failing unless it is `least` or newer; `why` says what needs it. */
export const requireNpm = Effect.fn("requireNpm")(function* (
	least: readonly [number, number, number],
	why: string,
	cwd: string,
) {
	const found = (yield* runCommand("npm", ["--version"], cwd)).stdout.trim();
	if (!isAtLeast(found, least)) {
		return yield* new NpmError({ reason: `npm ${found} is too old: ${why} needs npm ${least.join(".")} or newer` });
	}
	return found;
});

/** Whether the version `found` (`11.6.2`) is `least` or newer; one that is no version is not. */
export function isAtLeast(found: string, least: ReadonlyArray<number>): boolean {
	const parts = found.split(".").map((part) => Number.parseInt(part, 10));
	for (const [index, wanted] of least.entries()) {
		const part = parts[index] ?? 0;
		// NaN, from no version, is neither: it is older.
		if (part !== wanted) return part > wanted;
	}
	return true;
}

/**
 * Makes `publishers`' packages known to npm, so that the `release.yml` of each one's repository publishes it from then
 * on with no token: a placeholder `0.0.0` (a manifest and a README, no code) of each package npm has never seen, and the
 * package's trusted publisher, that repository and TRUSTED_WORKFLOW. What is done already is skipped, so a run that
 * stopped is finished by the next. It needs a person signed in to npm with two-factor authentication, who approves the
 * first request in the browser; npm then offers to ask no more for five minutes, which is enough for every package. A
 * dry run needs no sign-in and changes nothing: npm checks each placeholder (`npm publish --dry-run`) and shows each
 * trusted publisher it would set (`npm trust --dry-run`).
 */
export const bootstrap = Effect.fn("bootstrap")(function* (
	publishers: ReadonlyArray<Publisher>,
	dryRun: boolean,
	cwd: string,
) {
	yield* requireNpm(TRUSTING_NPM, "setting a trusted publisher", cwd);
	if (!dryRun && (yield* runCommand("npm", ["whoami"], cwd)).exitCode !== 0) {
		return yield* new NpmError({ reason: "not signed in to npm: run `npm login`, then this step again" });
	}
	let placeholders = 0;
	let trusted = 0;
	for (const publisher of publishers) {
		if ((yield* published(publisher.name)).kind === "absent") {
			yield* publishPlaceholder(publisher, dryRun, cwd);
			placeholders++;
		}
		if (yield* trustPublisher(publisher, dryRun, cwd)) trusted++;
	}
	return { packages: publishers.length, placeholders, trusted } satisfies Bootstrapped;
});

/** Publishes the placeholder of `publisher`'s package, which makes its name known to npm. */
const publishPlaceholder = Effect.fn("publishPlaceholder")(function* (
	publisher: Publisher,
	dryRun: boolean,
	cwd: string,
) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const directory = yield* temporaryDirectory("npm-placeholder-");
	const manifest = {
		name: publisher.name,
		version: PLACEHOLDER,
		description: `Placeholder: ${publisher.name} is published from https://github.com/${publisher.repository}`,
		license: "MIT",
		// npm compares this with the repository of the workflow that publishes.
		repository: { type: "git", url: `git+https://github.com/${publisher.repository}.git` },
	};
	yield* fs.writeFileString(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	yield* fs.writeFileString(
		path.join(directory, "README.md"),
		`# ${publisher.name}\n\nThis version holds no code. It makes the name known to npm, so that the release workflow of https://github.com/${publisher.repository} can publish the package. Install a later version.\n`,
	);
	yield* npmAttached(
		["publish", directory, "--access", "public", "--ignore-scripts", ...(dryRun ? ["--dry-run"] : [])],
		`publish the placeholder of ${publisher.name}`,
		cwd,
	);
}, Effect.scoped);

/** A placeholder's version: below every real one, so it is never `latest` once a release exists. */
const PLACEHOLDER = "0.0.0";

/**
 * Sets the trusted publisher of `publisher`'s package unless npm has it; whether it set one (in a dry run: showed the
 * one it would set, since what npm holds can be read only signed in).
 */
const trustPublisher = Effect.fn("trustPublisher")(function* (publisher: Publisher, dryRun: boolean, cwd: string) {
	const trust = [
		"trust",
		"github",
		publisher.name,
		"--file",
		TRUSTED_WORKFLOW,
		"--repository",
		publisher.repository,
		"--allow-publish",
		"--yes",
	];
	if (dryRun) {
		yield* npmAttached([...trust, "--dry-run"], `show the trusted publisher of ${publisher.name}`, cwd);
		return true;
	}
	const publishers = yield* trustedPublishers(publisher.name, cwd);
	if (publishers.some((found) => found.file === TRUSTED_WORKFLOW && found.repository === publisher.repository)) {
		return false;
	}
	const [other] = publishers;
	if (other !== undefined) {
		return yield* new NpmError({
			reason: `${publisher.name} trusts ${other.repository ?? "another repository"} (${other.file ?? "another workflow"}) to publish it, and npm keeps one trusted publisher per package: revoke it (\`npm trust revoke ${publisher.name} --id ${other.id ?? "<id from npm trust list>"}\`), then run this step again`,
		});
	}
	yield* npmAttached(trust, `set the trusted publisher of ${publisher.name}`, cwd);
	// npm limits how fast trust is set: its documentation asks for two seconds between requests.
	yield* Effect.sleep("2 seconds");
	return true;
});

/**
 * The trusted publishers npm holds for `name`. `npm trust list --json` prints each as a JSON object after a blank line.
 * It runs within a deadline: in JSON mode npm holds back the page that approves a sign-in until it ends, so a request
 * waiting for that approval would wait unseen.
 */
const trustedPublishers = Effect.fn("trustedPublishers")(function* (name: string, cwd: string) {
	const listed = yield* runBounded("npm", ["trust", "list", name, "--json"], cwd, {
		deadline: TRUST_LIST_DEADLINE,
	}).pipe(
		Effect.catchTag("CommandDeadlineError", () =>
			Effect.fail(
				new NpmError({
					reason: `\`npm trust list ${name}\` did not answer within ${TRUST_LIST_DEADLINE}, perhaps waiting for a two-factor approval its JSON output hides: run \`npm trust list ${name}\` once, approve it, and run this step again within five minutes`,
				}),
			),
		),
	);
	if (listed.kind !== "exited" || listed.exitCode !== 0) {
		return yield* new NpmError({
			reason: `could not read the trusted publishers of ${name}: ${listed.output.trim()}`,
		});
	}
	// Trust boundary: npm's output, read as JSON.
	return yield* Effect.forEach(
		listed.stdout
			.split(/\n\s*\n/)
			.map((chunk) => chunk.trim())
			.filter((chunk) => chunk !== ""),
		(chunk) =>
			Schema.decodeEffect(Schema.fromJsonString(TrustedPublisher))(chunk).pipe(
				Effect.mapError(
					(cause) =>
						new NpmError({ reason: `npm trust list ${name} printed what is no publisher: ${cause.message}` }),
				),
			),
	);
});

const TRUST_LIST_DEADLINE = "60 seconds";

/** A trusted publisher as `npm trust list --json` prints it, as far as `bootstrap` reads it. */
const TrustedPublisher = Schema.Struct({
	id: Schema.optional(Schema.String),
	file: Schema.optional(Schema.String),
	repository: Schema.optional(Schema.String),
});

/** Runs npm attached to the terminal, where it may ask the person to approve; fails, naming `what`, when npm fails. */
const npmAttached = Effect.fn("npmAttached")(function* (args: ReadonlyArray<string>, what: string, cwd: string) {
	if ((yield* runAttached("npm", args, cwd)) !== 0) {
		return yield* new NpmError({
			reason: `npm could not ${what}; what was done before is kept: run this step again`,
		});
	}
});

/**
 * Why a release leaves out a package npm has never seen, and `step`, the command that makes it known to npm. A release
 * warns of it and fails nothing, so a merge before that step stays green.
 */
export function notBootstrapped(name: string, step: string): string {
	return `npm has never seen ${name}, and trusts a workflow to publish only a package it has: once, a person signed in to npm runs \`${step}\`; the next release then publishes it.`;
}

/** Prints a warning, as an annotation of the run when it runs in GitHub Actions. */
export const warning = Effect.fn("warning")(function* (message: string) {
	const actions = yield* Config.String("GITHUB_ACTIONS").pipe(Config.withDefault(""));
	yield* Console.log(actions === "true" ? `::warning title=npm::${message}` : `warning: ${message}`);
});
