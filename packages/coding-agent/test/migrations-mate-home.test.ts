/**
 * The legacy-home migration. The fork used to own ~/.mate/agent; it now reads and writes the
 * standard ~/.pi/agent. The merge must never overwrite anything the .pi home already holds, and
 * must leave conflicts behind instead of destroying them.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyMateHome } from "../src/migrations.ts";

let base: string;
let target: string;
let prevAgentDir: string | undefined;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "mate-home-"));
	target = join(base, "pi-agent");
	mkdirSync(target, { recursive: true });
	prevAgentDir = process.env.MATE_CODING_AGENT_DIR;
	process.env.MATE_CODING_AGENT_DIR = target;
});

afterEach(() => {
	if (prevAgentDir === undefined) delete process.env.MATE_CODING_AGENT_DIR;
	else process.env.MATE_CODING_AGENT_DIR = prevAgentDir;
	rmSync(base, { recursive: true, force: true });
});

describe("migrateLegacyMateHome", () => {
	it("moves a clean legacy home whole and removes it", () => {
		const legacy = join(base, "mate-home");
		mkdirSync(join(legacy, "agent", "mate"), { recursive: true });
		mkdirSync(join(legacy, "agent", "sessions"), { recursive: true });
		writeFileSync(join(legacy, "agent", "mate", "state.json"), "{}");
		writeFileSync(join(legacy, "agent", "sessions", "s1.jsonl"), "{}\n");
		writeFileSync(join(legacy, "agent", "models.json"), "{}");

		expect(migrateLegacyMateHome(legacy)).toBe(true);
		expect(existsSync(join(target, "mate", "state.json"))).toBe(true);
		expect(existsSync(join(target, "sessions", "s1.jsonl"))).toBe(true);
		expect(existsSync(join(target, "models.json"))).toBe(true);
		expect(existsSync(legacy)).toBe(false);
	});

	it(".pi wins on conflicts: existing target files stay, conflicting files are left behind", () => {
		const legacy = join(base, "mate-home");
		mkdirSync(join(legacy, "agent", "mate"), { recursive: true });
		writeFileSync(join(legacy, "agent", "models.json"), '{"legacy": true}');
		writeFileSync(join(legacy, "agent", "mate", "state.json"), '{"legacy": true}');
		writeFileSync(join(legacy, "agent", "mate", "memory.json"), '{"legacy": true}');
		writeFileSync(join(target, "models.json"), '{"pi": true}');
		mkdirSync(join(target, "mate"), { recursive: true });
		writeFileSync(join(target, "mate", "state.json"), '{"pi": true}');

		expect(migrateLegacyMateHome(legacy)).toBe(true);
		// The .pi home's own models.json and state.json were not touched.
		expect(JSON.parse(readFileSync(join(target, "models.json"), "utf8"))).toEqual({ pi: true });
		expect(readFileSync(join(target, "mate", "state.json"), "utf8")).toBe('{"pi": true}');
		// The non-conflicting memory.json moved in.
		expect(readFileSync(join(target, "mate", "memory.json"), "utf8")).toBe('{"legacy": true}');
		// The conflicting models.json survives under the legacy home for a manual merge.
		expect(existsSync(legacy)).toBe(true);
		expect(readFileSync(join(legacy, "agent", "models.json"), "utf8")).toBe('{"legacy": true}');
	});

	it("is a no-op without a legacy home", () => {
		expect(migrateLegacyMateHome(join(base, "nope"))).toBe(false);
	});
});
