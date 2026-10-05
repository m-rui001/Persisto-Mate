/**
 * Publish the DeepSeek Harness bundle (@m-rui/dsh-mate-companion) to both channels:
 *
 *   git — assemble the package (package.json + dist + cordis.patch.yml + README) into a temp dir that
 *         IS the package root, commit it, and force-push it to github.com/m-rui001/dsh-mate-companion.
 *         Users install with `dsh plugin --profile <p> add github:m-rui001/dsh-mate-companion`.
 *   npm — `npm publish --access public` the same assembled dir (requires npm auth).
 *
 * The published manifest re-adds the two dsh peerDependencies that the workspace copy must omit
 * (npm's arborist crashes resolving registry peers with `*` inside this monorepo), and marks the
 * workspace copy private since the assembled package is what ships.
 *
 * Usage: node scripts/publish-dsh-extension.mjs [--git-only] [--npm-only]
 * The version comes from the workspace (packages/dsh-mate-extension/package.json).
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const doGit = !args.includes("--npm-only");
const doNpm = !args.includes("--git-only");

const repoRoot = join(import.meta.dirname, "..");
const pkgRoot = join(repoRoot, "packages", "dsh-mate-extension");
const out = join(repoRoot, ".artifacts", "dsh-extension-publish");

const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const version = pkg.version;
const gitRepo = "git@github.com:m-rui001/dsh-mate-companion.git";
const ghRepo = "m-rui001/dsh-mate-companion";

// --- assemble ---
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
if (!existsSync(join(pkgRoot, "dist", "index.js"))) {
	console.error("dist missing: run the package build first");
	process.exit(1);
}
cpSync(join(pkgRoot, "dist"), join(out, "dist"), { recursive: true });
cpSync(join(pkgRoot, "cordis.patch.yml"), join(out, "cordis.patch.yml"));
cpSync(join(pkgRoot, "README.md"), join(out, "README.md"));
writeFileSync(
	join(out, "package.json"),
	`${JSON.stringify(
		{
			name: pkg.name,
			version,
			description: pkg.description,
			type: pkg.type,
			license: pkg.license,
			main: pkg.main,
			files: pkg.files,
			dsh: pkg.dsh,
			peerDependencies: {
				"@deepseek-ai/dsh-llm": "*",
				"@deepseek-ai/dsh-tools": "*",
			},
		},
		null,
		"\t",
	)}\n`,
);
console.log(`assembled ${pkg.name}@${version} -> ${out}`);

const run = (cmd, cwd = out) => execSync(cmd, { cwd, stdio: "inherit", shell: true });

// --- git channel ---
if (doGit) {
	run(`git init -b main`);
	run(`git add -A`);
	run(`git -c user.name="Persisto Mate release" -c user.email="release@persisto.local" commit -m "dsh-mate-companion ${version}" --allow-empty`);
	const haveRemote = execSync(`git remote`, { cwd: out, encoding: "utf8" }).includes("origin");
	if (!haveRemote) run(`git remote add origin ${gitRepo}`);
	const repoExists =
		execSync(`gh repo view ${ghRepo} --json name -q .name 2>nul || echo missing`, { shell: true, encoding: "utf8" }).trim() !==
		"missing";
	if (!repoExists) {
		console.log(`creating GitHub repo ${ghRepo}`);
		execSync(
			`gh repo create ${ghRepo} --public --description "Persisto Mate companion as a DeepSeek Harness (dsh) bundle"`,
			{ stdio: "inherit", shell: true },
		);
	}
	run(`git tag -f v${version}`);
	run(`git push --force origin main`);
	run(`git push --force origin v${version}`);
	console.log(`git channel done: dsh plugin add github:${ghRepo}`);
}

// --- npm channel ---
if (doNpm) {
	const userconfig = process.env.NPM_USERCONFIG_PUBLISH || "C:/Users/hp/AppData/Local/Temp/npmrc-tmp";
	run(`npm whoami --userconfig "${userconfig}"`);
	run(`npm publish --access public --userconfig "${userconfig}"`);
	console.log(`npm channel done: dsh plugin add ${pkg.name}`);
}
