/**
 * The judge's pure half: window selection, the delta ladder, opponent routing, and the due gate.
 *
 * The model call is not here on purpose — the semantics of a reading are what could go wrong quietly
 * (a negative answer dropped, a double-counted axis, a window that re-reads the same turns), and all of
 * that is arithmetic.
 */

import { describe, expect, it } from "vitest";
import {
	JUDGE_GAIN,
	JUDGE_MAX_TURNS,
	JUDGE_TURN_CHARS,
	judgeActivations,
	judgeDeltas,
	judgeDue,
	judgePrompt,
	judgeTranscript,
	judgeWindow,
	oppositeEmotion,
	parseJudgeReply,
} from "../src/index.ts";

const turn = (role: "user" | "assistant", text: string) => ({ role, text });

describe("judge window", () => {
	it("keeps the newest turns and drops the empty ones", () => {
		const many = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? "assistant" : "user", `line ${i}`));
		const w = judgeWindow([...many, turn("user", "   ")]);
		expect(w).toHaveLength(JUDGE_MAX_TURNS);
		expect(w.at(-1)?.text).toBe("line 19");
		expect(w.some((t) => t.text === "")).toBe(false);
	});

	it("collapses whitespace and caps each turn", () => {
		const w = judgeWindow([turn("user", "a\n\n   b".padEnd(JUDGE_TURN_CHARS + 50, "x"))]);
		expect(w[0].text.startsWith("a b")).toBe(true);
		expect(w[0].text.length).toBe(JUDGE_TURN_CHARS);
	});

	it("labels speakers and says nothing about timestamps", () => {
		const t = judgeTranscript([turn("user", "hi"), turn("assistant", "hello")]);
		expect(t).toBe("User: hi\nCompanion: hello");
	});
});

describe("judge deltas", () => {
	it("clamps to the ladder, rounds, and drops non-answers", () => {
		expect(judgeDeltas({ joy: 9, sadness: -1.6, anger: "2", trust: "nonsense", fear: undefined })).toEqual({
			joy: 2,
			sadness: -2,
			anger: 2,
		});
	});

	it("treats 0 as no change and leaves it out", () => {
		expect(judgeDeltas({ joy: 0, surprise: -0.2 })).toEqual({});
	});

	it("parses a JSON object out of prose, and nothing out of noise", () => {
		expect(parseJudgeReply('Sure!\n{"joy": 1, "anger": -2}\nHope that helps')).toEqual({ joy: 1, anger: -2 });
		expect(parseJudgeReply("no numbers here")).toEqual({});
		expect(parseJudgeReply("{oops")).toEqual({});
	});
});

describe("judge activations", () => {
	it("routes a rise to its own channel at the capped gain", () => {
		expect(judgeActivations({ joy: 2 })).toEqual({ joy: JUDGE_GAIN });
		expect(judgeActivations({ joy: 1 }).joy).toBeCloseTo(JUDGE_GAIN / 2, 10);
	});

	it("routes a fall to the opponent channel instead of dropping it", () => {
		expect(oppositeEmotion("joy")).toBe("sadness");
		expect(oppositeEmotion("trust")).toBe("disgust");
		expect(oppositeEmotion("fear")).toBe("anger");
		expect(oppositeEmotion("surprise")).toBe("anticipation");
		expect(judgeActivations({ joy: -2 })).toEqual({ sadness: JUDGE_GAIN });
	});

	it("reads two answers on one axis as one axis, not twice the change", () => {
		// joy +1 and sadness -1 are the same statement; summing would double it.
		expect(judgeActivations({ joy: 1, sadness: -1 })).toEqual({ joy: JUDGE_GAIN / 2 });
	});

	it("says nothing when nothing moved", () => {
		expect(judgeActivations({})).toEqual({});
	});
});

describe("judge prompt and due gate", () => {
	it("asks for every channel by name and sets the ladder", () => {
		const p = judgePrompt();
		for (const e of ["joy", "trust", "fear", "surprise", "sadness", "disgust", "anger", "anticipation"]) {
			expect(p).toContain(`"${e}"`);
		}
		expect(p).toContain("-2:");
		expect(p).toContain("+2:");
	});

	it("waits for both the cooldown and enough conversation", () => {
		const now = 1_000_000_000_000;
		expect(judgeDue({ now, lastAt: now, userTurns: 5 })).toBe(false); // one was just taken
		expect(judgeDue({ now, lastAt: now - 60_000, userTurns: 9 })).toBe(false);
		expect(judgeDue({ now, lastAt: now - 11 * 60_000, userTurns: 2 })).toBe(false);
		expect(judgeDue({ now, lastAt: now - 11 * 60_000, userTurns: 3 })).toBe(true);
		expect(judgeDue({ now, lastAt: 0, userTurns: 3, cooldownMs: 0 })).toBe(true);
	});
});
