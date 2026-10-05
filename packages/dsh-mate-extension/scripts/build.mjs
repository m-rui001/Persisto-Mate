/**
 * Build the dsh bundle from the monorepo's single source of truth. The kernel (@earendil-works/pi-mate,
 * run `npm run build -w @earendil-works/pi-mate` first) is bundled in, so the package has zero runtime
 * dependencies beyond the two dsh modules the host provides (declared as peerDependencies and kept
 * external — see src/dsh-host.d.ts for why their types are declared, not installed).
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");
const entry = join(pkgRoot, "src", "index.ts");
const kernelDist = join(repoRoot, "packages", "mate", "dist", "index.js");
const outdir = join(pkgRoot, "dist");

if (!existsSync(kernelDist)) {
	console.error("kernel dist missing: run `npm run build -w @earendil-works/pi-mate` first");
	process.exit(1);
}
if (!existsSync(entry)) {
	console.error(`plugin entry missing: ${entry}`);
	process.exit(1);
}

const cmd = [
	"bun build",
	JSON.stringify(entry.replaceAll("\\", "/")),
	"--outdir", JSON.stringify(outdir.replaceAll("\\", "/")),
	"--target", "node",
	"--format", "esm",
	"--external", "@deepseek-ai/dsh-llm",
	"--external", "@deepseek-ai/dsh-tools",
].join(" ");

execSync(cmd, { stdio: "inherit", shell: true });
console.log(`built into ${outdir}`);
