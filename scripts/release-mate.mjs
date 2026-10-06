#!/usr/bin/env node
/**
 * One-version release for Persisto Mate: one command ships the kernel to all four hosts.
 *
 *   node scripts/release-mate.mjs patch|minor [--skip-binaries] [--skip-push]
 *
 * Why this exists: the kernel (@earendil-works/pi-mate) is bundled into every host at build time
 * (the binary, the pi plugin, the dsh bundle, the SillyTavern extension all build from
 * packages/mate/dist), and the hosts' install mechanisms resolve no plugin dependencies — so a
 * kernel change always means rebuilding and republishing every host. The part that was manual is
 * the versioning: dsh/st kept their own version lines, and the build/publish steps were run by
 * hand one package at a time. This script makes "one version" literal:
 *
 *   1. cut the [Unreleased] changelog sections into a dated X.Y.Z section
 *   2. bump all published workspace packages in lockstep (npm run version:<bump>)
 *      and move the private dsh/st hosts onto the SAME version
 *   3. regen npm-shrinkwrap.json + install-lock, run the full check
 *   4. commit the bump, tag vX.Y.Z-mate, push main + tag
 *   5. build the platform binaries and publish the GitHub release with them
 *   6. build and publish the three extension hosts (git channel; npm when authed)
 *   7. apply the keep-one-old-release policy
 *
 * The tag goes on the bump commit, per the fork's release convention (.pi/skills/release.md).
 * Binaries are built AFTER the push so the archives correspond to the tagged commit.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const bump = process.argv[2];
const skipBinaries = process.argv.includes("--skip-binaries");
const skipPush = process.argv.includes("--skip-push");

if (bump !== "patch" && bump !== "minor") {
	console.error("usage: node scripts/release-mate.mjs <patch|minor> [--skip-binaries] [--skip-push]");
	process.exit(1);
}

const repoRoot = join(import.meta.dirname, "..");
// npm/npx are .cmd shims on Windows and need a shell; git/gh/bash are real executables and must
// run WITHOUT one — shell mode does not quote args, so a multi-word commit message would shatter
// into pathspecs.
const SHELL_CMDS = new Set(["npm", "npx"]);
const run = (cmd, args, opts = {}) => {
	console.log(`\n$ ${cmd} ${args.join(" ")}`);
	const shell = opts.shell ?? (SHELL_CMDS.has(cmd) && process.platform === "win32");
	return execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit", ...opts, shell });
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// --- 0. preconditions ------------------------------------------------------

if (readJson(join(repoRoot, "packages", "mate", "package.json")).version === undefined) {
	throw new Error("packages/mate not readable");
}
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" })
	.split("\n")
	.filter((l) => l.trim() && !l.startsWith("??"));
if (dirty.length > 0) {
	console.error(`worktree has uncommitted tracked changes:\n${dirty.join("\n")}`);
	console.error("land the feature commit(s) first (fork release convention).");
	process.exit(1);
}

const oldVersion = readJson(join(repoRoot, "packages", "mate", "package.json")).version;
const [maj, min, pat] = oldVersion.split(".").map(Number);
const newVersion =
	bump === "patch" ? `${maj}.${min}.${pat + 1}` : `${maj}.${min + 1}.0`;
const tag = `v${newVersion}-mate`;
const today = new Date().toISOString().slice(0, 10);
console.log(`release ${oldVersion} -> ${newVersion} (${tag})`);

// --- 1. cut the changelog sections ------------------------------------------

// Only the two packages that carry entries; a fresh [Unreleased] is left behind for the next cycle.
for (const pkg of ["mate", "coding-agent"]) {
	const path = join(repoRoot, "packages", pkg, "CHANGELOG.md");
	const text = readFileSync(path, "utf8");
	const start = text.indexOf("## [Unreleased]");
	const next = text.indexOf("\n## [", start);
	if (start < 0) throw new Error(`${path}: no [Unreleased] section`);
	const section = text.slice(start + "## [Unreleased]".length, next < 0 ? text.length : next).trim();
	if (!section) {
		console.log(`${pkg}: [Unreleased] is empty, nothing to cut`);
		continue;
	}
	const cut = `${text.slice(0, start)}## [${newVersion}] - ${today}\n\n${section}\n\n## [Unreleased]\n${next < 0 ? "" : text.slice(next)}`;
	writeFileSync(path, cut);
	console.log(`${pkg}: cut [${newVersion}] - ${today}`);
}

// --- 2. lockstep bump -------------------------------------------------------

// Stale binary archives carry a package.json at the OLD version and are picked up by the
// workspace scan, which then fails the lockstep check. build-binaries.sh recreates the dir.
rmSync(join(repoRoot, "packages", "coding-agent", "binaries"), { recursive: true, force: true });
run("npm", ["run", `version:${bump}`]);
// The private hosts share the release version too: their package.json version is what the
// publish scripts stamp into the assembled manifests.
for (const pkg of ["dsh-mate-extension", "st-mate-extension"]) {
	const path = join(repoRoot, "packages", pkg, "package.json");
	const data = readJson(path);
	data.version = newVersion;
	// 2-space JSON, trailing newline — these files are hand-managed, keep the diff minimal.
	writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);
	console.log(`${pkg}: version -> ${newVersion}`);
}
run("node", ["scripts/generate-coding-agent-shrinkwrap.mjs"]);
run("node", ["scripts/generate-coding-agent-install-lock.mjs"]);

// --- 3. check ---------------------------------------------------------------

run("npm", ["run", "check"], { env: { ...process.env, PI_ALLOW_LOCKFILE_CHANGE: "1" } });

// --- 4. commit + tag + push -------------------------------------------------

const changed = execFileSync("git", ["diff", "--name-only"], { cwd: repoRoot, encoding: "utf8" })
	.split("\n")
	.filter(Boolean);
if (changed.length === 0) throw new Error("bump produced no changes");
run("git", ["add", ...changed]);
run("git", [
	"commit",
	"-m",
	`chore: bump packages to ${newVersion} for the ${tag} release`,
]);
run("git", ["tag", tag]);
if (!skipPush) run("git", ["push", "origin", "main", tag]);

// --- 5. binaries + GitHub release -------------------------------------------

const archivesDir = join(repoRoot, "packages", "coding-agent", "binaries");
if (!skipBinaries) {
	run("bash", ["./scripts/build-binaries.sh", "--offline-model-data"]);
	const archives = existsSync(archivesDir)
		? ["mate-darwin-arm64.tar.gz", "mate-darwin-x64.tar.gz", "mate-linux-arm64.tar.gz", "mate-linux-x64.tar.gz", "mate-windows-arm64.zip", "mate-windows-x64.zip"]
				.map((a) => join(archivesDir, a))
				.filter((p) => existsSync(p))
		: [];
	if (archives.length === 0) throw new Error("no binary archives were built");
	const notesPath = join(repoRoot, ".artifacts", `release-notes-${tag}.md`);
	writeFileSync(
		notesPath,
		`Persisto Mate ${newVersion}\n\nSee the package changelogs: packages/mate/CHANGELOG.md, packages/coding-agent/CHANGELOG.md.\n`,
	);
	run("gh", ["release", "create", tag, "--title", `Persisto Mate ${newVersion}`, "--notes-file", notesPath, ...archives]);
}

// --- 6. the three extension hosts -------------------------------------------

// Each publish script assembles its own package (package.json + dist + README) and ships it to
// the git channel its host installs from; the npm channel runs when npm auth is present.
run("npm", ["run", "build:extension"]);
run("node", ["scripts/publish-mate-extension.mjs"]);
run("npm", ["--prefix", "packages/dsh-mate-extension", "run", "build"]);
run("node", ["scripts/publish-dsh-extension.mjs"], {
	env: { ...process.env, NPM_USERCONFIG_PUBLISH: process.env.NPM_USERCONFIG_PUBLISH ?? "C:/Users/hp/AppData/Local/Temp/npmrc-tmp" },
});
run("npm", ["--prefix", "packages/st-mate-extension", "run", "build"]);
run("node", ["packages/st-mate-extension/scripts/publish.mjs"]);

// --- 7. keep one old release -------------------------------------------------

if (!skipPush) {
	const releases = execFileSync("gh", ["release", "list", "--limit", "50"], { cwd: repoRoot, encoding: "utf8", shell: true })
		.split("\n")
		.map((l) => l.split("\t")[1]?.trim())
		.filter((t) => t && t.endsWith("-mate") && t !== tag);
	// Newest first per gh's default ordering; keep the first old one, delete the rest.
	for (const old of releases.slice(1)) {
		run("gh", ["release", "delete", old, "--yes"]);
		console.log(`deleted old release ${old}`);
	}
}

rmSync(join(repoRoot, ".artifacts", `release-notes-${tag}.md`), { force: true });
console.log(`\nrelease ${tag} complete.`);
