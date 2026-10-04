/**
 * WHEN a reading is due: what the companion has said, not what time it is.
 *
 * The trigger used to be a ten-minute cooldown, which measured nothing about the exchange — four hours of
 * silence produced one reading and four minutes of long replies produced none. The counters now count the
 * reply tokens the user actually received, plus the thinking tokens behind them when the reader is a
 * decision model (the one that is handed that text and charged nothing per token), plus the new user turns
 * that keep an overlapping window from being appraised twice. These tests pin that gate on the runtime,
 * because the numbers behind it are the runtime's own state.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MateRuntime } from "../src/extensions/mate/runtime.ts";

const dirs: string[] = [];

/** A companion with no history, in a throwaway state directory. */
function fresh(): MateRuntime {
	const dir = mkdtempSync(join(tmpdir(), "mate-judge-trigger-"));
	dirs.push(dir);
	return new MateRuntime({ dir, name: "test", lang: "en", onError: () => {} });
}

afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("judge due gate", () => {
	it("opens on exchange volume, not on the clock", () => {
		const rt = fresh();
		expect(rt.judgeDue(false)).toBe(false); // nothing said yet
		rt.onUserMessage("同一个报错我改了三个小时");
		rt.noteRunOutput(300, 900);
		// The chat reader is not handed the thinking, so 900 tokens of deliberation buy it nothing.
		expect(rt.judgeDue(false)).toBe(false);
		rt.onUserMessage("跑通了");
		rt.noteRunOutput(300, 0);
		expect(rt.judgeDue(false)).toBe(true); // 600 reply tokens across two new turns
	});

	it("counts thinking for a decision model, and needs ten times the exchange", () => {
		const rt = fresh();
		rt.onUserMessage("a");
		rt.onUserMessage("b");
		rt.noteRunOutput(700, 1_000);
		// Same counters, two readers: the chat tier is already due, the classifier tier is not.
		expect(rt.judgeDue(false)).toBe(true);
		expect(rt.judgeDue(true)).toBe(false);
		rt.noteRunOutput(0, 4_300);
		expect(rt.judgeDue(true)).toBe(true);
	});

	it("needs a new user turn, so the same exchange is not read twice", () => {
		const rt = fresh();
		rt.onUserMessage("first");
		rt.onUserMessage("second");
		rt.noteRunOutput(5_000, 0);
		expect(rt.judgeDue(false)).toBe(true);
		rt.judgeAttempted();
		// A long reply to the same message must not buy another reading of the same window.
		rt.noteRunOutput(5_000, 5_000);
		expect(rt.judgeDue(false)).toBe(false);
		expect(rt.judgeDue(true)).toBe(false);
		rt.onUserMessage("third");
		expect(rt.judgeDue(false)).toBe(true);
	});

	it("stamps an attempted reading that failed, so a broken reader warns once per stretch", () => {
		const rt = fresh();
		rt.onUserMessage("a");
		rt.onUserMessage("b");
		rt.noteRunOutput(1_000, 8_000);
		expect(rt.judgeDue(true)).toBe(true);
		// runAffectJudge stamps this in its `finally`, success or not.
		rt.judgeAttempted();
		expect(rt.judgeDue(false)).toBe(false);
		expect(rt.judgeDue(true)).toBe(false);
	});
});
