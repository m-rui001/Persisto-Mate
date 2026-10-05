/**
 * Publish the standalone companion plugin (@earendil-works/pi-mate-companion) to both channels:
 *
 *   git — assemble the package (package.json + dist + README) into a temp dir that IS the package
 *         root (pi's git package source requires repo root = package root), commit it, and force-
 *         push it to github.com/m-rui001/pi-mate-companion. Users install with
 *         `pi install git:github.com/m-rui001/pi-mate-companion`.
 *   npm — `npm publish` the same assembled dir (requires npm auth; skipped with a hint when
 *         nobody is logged in).
 *
 * Usage: node scripts/publish-mate-extension.mjs [--git-only] [--npm-only] [--skip-git]
 * The version comes from the workspace (packages/mate-extension/package.json).
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const doGit = !args.includes("--npm-only");
const doNpm = !args.includes("--git-only");
const skipGit = args.includes("--skip-git");

const repoRoot = join(import.meta.dirname, "..");
const pkgRoot = join(repoRoot, "packages", "mate-extension");
const out = join(repoRoot, ".artifacts", "mate-extension-publish");

const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const version = pkg.version;
const gitRepo = "git@github.com:m-rui001/pi-mate-companion.git";
const ghRepo = "m-rui001/pi-mate-companion";

// --- assemble ---
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (!existsSync(join(pkgRoot, "dist", "index.js"))) {
	console.error("dist missing: run `npm run build:extension` first");
	process.exit(1);
}
cpSync(join(pkgRoot, "dist"), join(out, "dist"), { recursive: true });
if (existsSync(join(pkgRoot, "README.md"))) cpSync(join(pkgRoot, "README.md"), join(out, "README.md"));
// The published manifest drops the build script and pins only what the host provides as peers.
writeFileSync(
	join(out, "package.json"),
	`${JSON.stringify(
		{
			name: pkg.name,
			version,
			description: pkg.description,
			type: "module",
			license: pkg.license,
			main: "./dist/index.js",
			pi: pkg.pi,
			files: pkg.files,
			peerDependencies: pkg.peerDependencies,
		},
		null,
		"\t",
	)}\n`,
);
console.log(`assembled ${pkg.name}@${version} -> ${out}`);

const run = (cmd, cwd = out) => execSync(cmd, { cwd, stdio: "inherit", shell: true });

// --- git channel ---
if (doGit && !skipGit) {
	run(`git init -b main`);
	run(`git add -A`);
	// Local identity for a throwaway publish repo; the commit carries the monorepo's version only.
	run(`git -c user.name="Persisto Mate release" -c user.email="release@persisto.local" commit -m "pi-mate-companion ${version}" --allow-empty`);
	const haveRemote = execSync(`git remote`, { cwd: out, encoding: "utf8" }).includes("origin");
	if (!haveRemote) run(`git remote add origin ${gitRepo}`);
	const repoExists =
		execSync(`gh repo view ${ghRepo} --json name -q .name 2>nul || echo missing`, { shell: true, encoding: "utf8" }).trim() !==
		"missing";
	if (!repoExists) {
		console.log(`creating GitHub repo ${ghRepo}`);
		execSync(`gh repo create ${ghRepo} --public --description "Persisto Mate companion as an installable pi extension"`, {
			stdio: "inherit",
			shell: true,
		});
	}
	run(`git push --force origin main`);
	// Tag the published snapshot so the repo root also serves pinned installs.
	try {
		run(`git tag v${version}`);
		run(`git push --force origin v${version}`);
	} catch {
		// Tag already present: keep moving.
	}
	console.log(`git channel: pi install git:github.com/${ghRepo}`);
}

// --- npm channel ---
if (doNpm) {
	let who = "";
	try {
		who = execSync(`npm whoami`, { encoding: "utf8", shell: true }).trim();
	} catch {
		who = "";
	}
	if (!who) {
		console.log("npm channel skipped: not logged in (`npm login` first, then rerun with --git-only reversed)");
	} else {
		run(`npm publish --access public`);
		console.log(`npm channel: pi install npm:${pkg.name}`);
	}
}
