/**
 * Bundle the SillyTavern extension: the kernel (@earendil-works/pi-mate, pure modules only) and the
 * shared structural intake (appraisal.ts) are BUNDLED; the SillyTavern host modules are imported in
 * source as bare "st/*" specifiers (so st-host.d.ts can type them) and the plugin below rewrites
 * them to the RELATIVE runtime paths a third-party extension sees inside SillyTavern
 * (public/scripts/extensions/third-party/<name>/index.js), marking them external — esbuild keeps
 * external specifiers verbatim.
 *
 * Output: .artifacts/st-extension-publish/ — exactly what the published git repo contains.
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(import.meta.dirname);
const repoRoot = join(pkgRoot, "..", "..");
const out = join(repoRoot, ".artifacts", "st-extension-publish");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const hostPaths = {
	"st/extensions": "../../../extensions.js",
	"st/script": "../../../../script.js",
	"st/slash-commands": "../../../slash-commands.js",
	"st/slash-commands/SlashCommandParser": "../../../slash-commands/SlashCommandParser.js",
	"st/slash-commands/SlashCommand": "../../../slash-commands/SlashCommand.js",
};

const stHost = {
	name: "st-host",
	setup(build) {
		build.onResolve({ filter: /^st\// }, (args) => ({ path: hostPaths[args.path], external: true }));
	},
};

await build({
	entryPoints: [join(pkgRoot, "src", "index.ts")],
	outfile: join(out, "index.js"),
	bundle: true,
	format: "esm",
	target: "es2022",
	platform: "browser",
	minify: true,
	plugins: [stHost],
});

// The manifest rides the package version (lockstep with the monorepo), not a hand-edited number.
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(pkgRoot, "manifest.json"), "utf8"));
manifest.version = pkg.version;
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
cpSync(join(pkgRoot, "LICENSE"), join(out, "LICENSE"));
cpSync(join(pkgRoot, "README.md"), join(out, "README.md"));
console.log(`assembled -> ${out}`);
