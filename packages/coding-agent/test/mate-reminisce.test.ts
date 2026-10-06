/**
 * The `reminisce` tool. The transcripts it reads are shared with plain-pi sessions in the same
 * directory and are full of harness noise, so the tool must (a) only count sessions whose system
 * prompt carries the companion's `mate_core` section, (b) reduce entries to user/companion text with
 * local timestamps, and (c) answer by day and, on a second call, by hour. A torn final line (a
 * killed process mid-write) must not sink the rest of the file.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReminisceTool } from "../src/extensions/mate/reminisce-tool.ts";

// Fixed LOCAL times: 2026-10-04 14:05 and 15:02, one user/assistant exchange each.
const day = (h: number, m: number) => new Date(2026, 9, 4, h, m, 0).getTime();

function entry(type: string, timestamp: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ type, id: Math.random().toString(16).slice(2, 10), parentId: null, timestamp, ...extra });
}

function msg(role: string, text: string, at: number, extra: Record<string, unknown> = {}): string {
	return entry("message", new Date(at).toISOString(), {
		message: { role, content: [{ type: "text", text }], timestamp: at, ...extra },
	});
}

const iso = (at: number) => new Date(at).toISOString();

describe("reminisce tool", () => {
	let dir: string;
	const savedEnv = process.env.MATE_CODING_AGENT_DIR;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "mate-reminisce-"));
		// The dist build's APP_NAME is "mate", so getAgentDir() reads MATE_CODING_AGENT_DIR.
		process.env.MATE_CODING_AGENT_DIR = dir;
	});

	afterEach(() => {
		process.env.MATE_CODING_AGENT_DIR = savedEnv;
	});

	function seed(): void {
		mkdirSync(join(dir, "sessions"), { recursive: true });
		const mate = [
			entry("session", iso(day(14, 0)), { id: "s1", cwd: dir }),
			msg("system", "", day(14, 0), { sections: { preamble: "You are a companion", mate_core: "name: Mate" } }),
			msg("user", "今天进展很不顺。", day(14, 5)),
			msg("assistant", "我听着呢。说说看？", day(14, 6)),
			msg("user", "一个报错改了三个小时。", day(15, 2)),
			msg("assistant", "辛苦了。", day(15, 3)),
		].join("\n");
		// A plain-pi coding session: tool noise, no mate_core section.
		const plain = [
			entry("session", iso(day(16, 0)), { id: "s2", cwd: dir }),
			msg("user", "fix the bug", day(16, 1)),
			entry("message", iso(day(16, 2)), {
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "read" }],
					timestamp: day(16, 2),
				},
			}),
			msg("user", "thanks", day(16, 3)),
		].join("\n");
		// Ends with a torn line, as a killed process leaves behind.
		const torn = `${mate}\n{"type":"message","id":"xx","par`;
		writeFileSync(join(dir, "sessions", "a-mate.jsonl"), torn);
		writeFileSync(join(dir, "sessions", "b-plain.jsonl"), plain);
	}

	const tool = () => createReminisceTool(() => ({ language: "zh" }) as never);

	it("indexes only companion sessions, with a preview", async () => {
		seed();
		const res = await tool().execute("t1", {}, undefined as never, undefined as never, undefined as never);
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("1 段对话");
		expect(text).toContain("今天进展很不顺。");
		expect(text).not.toContain("fix the bug");
	});

	it("reads one day as dialogue, excluding plain-pi sessions and non-text parts", async () => {
		seed();
		const res = await tool().execute(
			"t1",
			{ date: "2026-10-04" },
			undefined as never,
			undefined as never,
			undefined as never,
		);
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("用户：今天进展很不顺。");
		expect(text).toContain("我：辛苦了。");
		expect(text).toContain("15时");
		expect(text).not.toContain("fix the bug");
	});

	it("zooms into one hour when asked", async () => {
		seed();
		const res = await tool().execute(
			"t1",
			{ date: "2026-10-04", hour: 14 },
			undefined as never,
			undefined as never,
			undefined as never,
		);
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("今天进展很不顺。");
		expect(text).not.toContain("一个报错改了三个小时。");
	});

	it("reports an empty day without error", async () => {
		seed();
		const res = await tool().execute(
			"t1",
			{ date: "2026-10-01" },
			undefined as never,
			undefined as never,
			undefined as never,
		);
		expect(res.isError).toBeUndefined();
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("没有找到对话");
	});

	it("rejects a malformed date", async () => {
		seed();
		const res = await tool().execute(
			"t1",
			{ date: "10月4日" },
			undefined as never,
			undefined as never,
			undefined as never,
		);
		expect(res.isError).toBe(true);
	});
});
