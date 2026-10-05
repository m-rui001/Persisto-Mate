/**
 * Build the standalone companion plugin from the monorepo's single source of truth
 * (packages/coding-agent/src/extensions/mate). The kernel (@earendil-works/pi-mate) is bundled in
 * via the workspace link (run `npm run build -w @earendil-works/pi-mate` first), so the package has
 * zero runtime dependencies; the host-provided modules (pi-coding-agent, pi-agent-core, pi-tui,
 * typebox) stay external — every pi host provides them to its extensions (virtual modules / loader
 * aliases), and they are declared as peerDependencies.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");
const entry = join(repoRoot, "packages", "coding-agent", "src", "extensions", "mate", "index.ts");
const kernelDist = join(repoRoot, "packages", "mate", "dist", "index.js");
const outdir = join(pkgRoot, "dist");

if (!existsSync(kernelDist)) {
	console.error("kernel dist missing: run `npm run build -w @earendil-works/pi-mate` first");
	process.exit(1);
}
if (!existsSync(entry)) {
	console.error(`extension entry missing: ${entry}`);
	process.exit(1);
}

const cmd = [
	"bun build",
	JSON.stringify(entry.replaceAll("\\", "/")),
	"--outdir", JSON.stringify(outdir.replaceAll("\\", "/")),
	"--target", "node",
	"--format", "esm",
	"--external", "@earendil-works/pi-coding-agent",
	"--external", "@earendil-works/pi-agent-core",
	"--external", "@earendil-works/pi-tui",
	"--external", "typebox",
].join(" ");

execSync(cmd, { stdio: "inherit", shell: true });
console.log(`built into ${outdir}`);
