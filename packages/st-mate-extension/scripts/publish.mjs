/**
 * Publish the SillyTavern extension repo: assemble (manifest + bundled index.js + README) and
 * force-push to github.com/m-rui001/mate-sillytavern (repo root = extension root, which is what
 * ST's "Install extension" expects). Create the repo if missing.
 *
 * Usage: node scripts/publish.mjs
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(import.meta.dirname);
const repoRoot = join(pkgRoot, "..", "..");
const out = join(repoRoot, ".artifacts", "st-extension-publish");
const ghRepo = "m-rui001/mate-sillytavern";

if (!existsSync(join(out, "index.js"))) {
	console.error("bundle missing: run the package build first");
	process.exit(1);
}

const run = (cmd, cwd = out) => execSync(cmd, { cwd, stdio: "inherit", shell: true });

run(`git init -b main`);
run(`git add -A`);
run(`git -c user.name="Persisto Mate release" -c user.email="release@persisto.local" commit -m "Persisto Mate for SillyTavern" --allow-empty`);
const haveRemote = execSync(`git remote`, { cwd: out, encoding: "utf8" }).includes("origin");
if (!haveRemote) run(`git remote add origin git@github.com:${ghRepo}.git`);
const repoExists =
	execSync(`gh repo view ${ghRepo} --json name -q .name 2>nul || echo missing`, { shell: true, encoding: "utf8" }).trim() !==
	"missing";
if (!repoExists) {
	console.log(`creating GitHub repo ${ghRepo}`);
	execSync(
		`gh repo create ${ghRepo} --public --description "Persisto Mate companion as a SillyTavern extension: its own mood, body clock, memory and feelings"`,
		{ stdio: "inherit", shell: true },
	);
}
const version = JSON.parse(await import("node:fs").then((m) => m.readFileSync(join(out, "manifest.json"), "utf8"))).version;
run(`git tag -f v${version}`);
run(`git push --force origin main`);
run(`git push --force origin v${version}`);
console.log(`published: install via ST -> https://github.com/${ghRepo}`);
