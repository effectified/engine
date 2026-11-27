// Releases the engine: `release.yml` runs it after CI passed on a push to main. The version in package.json is published
// on npm when npm lacks it, through the workflow's identity (npm's trusted publishing: no token, and a provenance
// attestation that names the commit), and its GitHub release `v<version>` is made when it is missing, with the tarball
// attached, which effectified/packages installs by URL until it moves to npm. Each half is done only when it is missing,
// so a run that stopped half way is finished by the next, and a release is never replaced. npm never having seen the
// engine is no failure: a warning names the one-time step that makes it known (`effectify bootstrap --engine`), and the
// GitHub release is still made. `node scripts/release.ts --dry-run` builds and packs, lets npm check the tarball, and
// makes nothing.

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { runCommand, temporaryDirectory } from "../src/command.ts";
import { ENGINE_VERSION } from "../src/generate.ts";
import { ENGINE_PUBLISHER, notBootstrapped, PUBLISHING_NPM, published, requireNpm, warning } from "../src/npm.ts";

/** A step of the release failed: the tool's own words, or a version that disagrees with itself. */
class ReleaseError extends Schema.TaggedError<ReleaseError, { readonly brand: unique symbol }>()("ReleaseError", {
	step: Schema.String,
	reason: Schema.String,
}) {}

/** Publishes the engine's version where npm or the GitHub releases lack it; a dry run publishes nothing. */
const release = Effect.fn("release")(function* (dryRun: boolean) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const root = path.resolve(import.meta.dirname, "..");
	const version = yield* packageVersion(path.join(root, "package.json"));
	if (version !== ENGINE_VERSION) {
		return yield* new ReleaseError({
			step: "version",
			reason: `package.json says ${version}, ENGINE_VERSION in src/generate.ts says ${ENGINE_VERSION}: raise both`,
		});
	}
	const tag = `v${version}`;
	const npm = yield* published(ENGINE_PUBLISHER.name);
	const onNpm = npm.kind === "present" && npm.versions.includes(version);
	const onGitHub =
		(yield* runCommand("gh", ["release", "view", tag, "--repo", ENGINE_PUBLISHER.repository], root)).exitCode === 0;
	if (onNpm && onGitHub)
		return yield* Console.log(`${ENGINE_PUBLISHER.name} ${version} is on npm and released on GitHub`);

	const head = (yield* step("git", ["rev-parse", "HEAD"], root)).stdout.trim();
	const packed = yield* temporaryDirectory("effectified-engine-");
	yield* step("pnpm", ["build"], root);
	yield* step("pnpm", ["pack", "--pack-destination", packed], root);
	const tarball = path.join(packed, `effectified-engine-${version}.tgz`);

	if (onNpm) yield* Console.log(`${ENGINE_PUBLISHER.name} ${version} is on npm already`);
	else if (npm.kind === "absent" && !dryRun)
		yield* warning(
			`${notBootstrapped(ENGINE_PUBLISHER.name, "pnpm effectify bootstrap --engine")} Only the GitHub release is made.`,
		);
	else {
		if (!dryRun) yield* requireNpm(PUBLISHING_NPM, "publishing through the workflow's identity, with no token", root);
		const publishing = yield* step(
			"npm",
			[
				"publish",
				tarball,
				"--access",
				"public",
				"--ignore-scripts",
				// npm publishes a prerelease only under a tag of its own, so that `latest` stays a release.
				...(version.includes("-") ? ["--tag", "next"] : []),
				...(dryRun ? ["--dry-run"] : []),
			],
			packed,
		);
		yield* Console.log(
			dryRun
				? `npm's dry run passed:\n${publishing.output.trim()}`
				: `published ${ENGINE_PUBLISHER.name} ${version} on npm`,
		);
	}
	if (dryRun || onGitHub) return;

	const notes = path.join(packed, "NOTES.md");
	const changelog = yield* fs.readFileString(path.join(root, "CHANGELOG.md"));
	const url = `https://github.com/${ENGINE_PUBLISHER.repository}/releases/download/${tag}/effectified-engine-${version}.tgz`;
	yield* fs.writeFileString(
		notes,
		[
			`${ENGINE_PUBLISHER.name} ${version}, built from ${head}.`,
			"",
			"```sh",
			// On npm now, unless npm has never seen the engine.
			...(npm.kind === "present" ? [`pnpm add -D ${ENGINE_PUBLISHER.name}@${version}`] : []),
			`pnpm add -D ${url}`,
			"```",
			"",
			...changelogSection(changelog, version),
		].join("\n"),
	);
	yield* step(
		"gh",
		[
			"release",
			"create",
			tag,
			"--repo",
			ENGINE_PUBLISHER.repository,
			"--target",
			head,
			...(version.includes("-") ? ["--prerelease"] : []),
			"--title",
			`${ENGINE_PUBLISHER.name} ${version}`,
			"--notes-file",
			notes,
			tarball,
		],
		root,
	);
	yield* Console.log(`made the GitHub release ${tag}: ${url}`);
}, Effect.scoped);

/** Trust boundary: package.json is a file, read through a Schema. */
const packageVersion = Effect.fn("packageVersion")(function* (file: string) {
	const fs = yield* FileSystem.FileSystem;
	const manifest = yield* fs
		.readFileString(file)
		.pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.String })))));
	return manifest.version;
});

/** Runs a step of the release: what it printed, or a failure with the tool's last words. */
const step = Effect.fn("step")(function* (command: string, args: ReadonlyArray<string>, cwd: string) {
	const result = yield* runCommand(command, args, cwd);
	if (result.exitCode !== 0) {
		return yield* new ReleaseError({
			step: [command, ...args.slice(0, 1)].join(" "),
			reason: result.output.trim().split("\n").slice(-40).join("\n"),
		});
	}
	return result;
});

/** The section of CHANGELOG.md for `version`, without its heading, when it has one. */
function changelogSection(changelog: string, version: string): ReadonlyArray<string> {
	const lines = changelog.split("\n");
	const start = lines.indexOf(`## ${version}`);
	if (start === -1) return [];
	const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
	return lines.slice(start + 1, end === -1 ? undefined : end);
}

const dryRun = Flag.Boolean("dry-run").pipe(
	Flag.withDescription("Build and pack, let npm check the tarball, and publish nothing"),
	Flag.withDefault(false),
);

Command.make("release", { dryRun }, ({ dryRun }) => release(dryRun)).pipe(
	Command.withDescription("Publish the engine's version on npm and make its GitHub release, where either is missing"),
	Command.run({ version: ENGINE_VERSION }),
	// A tagged error's reason is a field, which the default report leaves out.
	Effect.tapErrorTag("ReleaseError", (error) => Console.error(`release failed: ${error.step}: ${error.reason}`)),
	Effect.tapErrorTag("NpmError", (error) => Console.error(`release failed: ${error.reason}`)),
	Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
	NodeRuntime.runMain,
);
