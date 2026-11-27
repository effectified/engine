// A target installed where the analyzer can read it: one cached directory per package version, holding the package,
// its types, a tsconfig and an entry file that re-exports the package as `lib`. Install scripts never run.

import { Effect, FileSystem, Path, Schema } from "effect";
import { runCommand } from "./command.ts";
import { TOOLCHAIN } from "./generate.ts";
import type { Target } from "./target.ts";

/** An installed target. */
export interface Workspace {
	readonly target: Target;
	readonly directory: string;
	readonly tsconfig: string;
	readonly entry: string;
	/** The installed package's own directory, whose JavaScript the scanner reads. */
	readonly packageDirectory: string;
}

/** Installing a target failed. */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError, { readonly brand: unique symbol }>()(
	"WorkspaceError",
	{
		target: Schema.String,
		reason: Schema.String,
	},
) {}

const TSCONFIG = {
	compilerOptions: {
		strict: true,
		module: "nodenext",
		moduleResolution: "nodenext",
		target: "esnext",
		lib: ["esnext", "dom"],
		noEmit: true,
		skipLibCheck: true,
	},
	files: ["entry.ts"],
};

/** Installs `target` under `cache` (once per version) and returns where it is. */
export const prepareWorkspace = Effect.fn("prepareWorkspace")(function* (target: Target, cache: string) {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const label = `${target.package}@${target.version}`;
	// The native checker reads absolute paths only.
	const directory = path.resolve(cache, "workspaces", label.replace("/", "__"));
	const workspace: Workspace = {
		target,
		directory,
		tsconfig: path.join(directory, "tsconfig.json"),
		entry: path.join(directory, "entry.ts"),
		packageDirectory: path.join(directory, "node_modules", target.package),
	};
	const fail = (reason: string) => new WorkspaceError({ target: label, reason });
	if (
		yield* fs
			.exists(path.join(workspace.packageDirectory, "package.json"))
			.pipe(Effect.mapError((e) => fail(e.message)))
	) {
		return workspace;
	}
	// Node's types are pinned here, as a facade builds with them: found instead wherever the cache sits, they would
	// differ between machines and checkouts (or be missing, every Buffer `any`), and so would the surface.
	const dependencies: Record<string, string> = {
		"@types/node": TOOLCHAIN["@types/node"],
		[target.package]: target.version,
	};
	if (target.types.from === "definitely-typed") dependencies[target.types.package] = target.types.version;
	yield* Effect.all([
		fs.makeDirectory(directory, { recursive: true }),
		fs.writeFileString(
			path.join(directory, "package.json"),
			`${JSON.stringify({ name: "effectify-workspace", private: true, type: "module", dependencies }, null, 2)}\n`,
		),
		fs.writeFileString(workspace.tsconfig, `${JSON.stringify(TSCONFIG, null, 2)}\n`),
		fs.writeFileString(workspace.entry, `export * as lib from ${JSON.stringify(target.package)};\n`),
	]).pipe(Effect.mapError((e) => fail(e.message)));
	const install = yield* runCommand(
		"npm",
		["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
		directory,
	).pipe(Effect.mapError((e) => fail(e.reason)));
	if (install.exitCode !== 0)
		return yield* fail(
			`npm install exited with ${install.exitCode}: ${install.output.trim().split("\n").slice(-10).join("\n")}`,
		);
	return workspace;
});
