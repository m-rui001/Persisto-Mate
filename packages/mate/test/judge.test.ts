/**
 * The judge's pure half: window selection, the delta ladder, opponent routing, and the due gate.
 *
 * The model call is not here on purpose — the semantics of a reading are what could go wrong quietly
 * (a negative answer dropped, a double-counted axis, a window that re-reads the same turns), and all of
 * that is arithmetic.
 */

import { describe, expect, it } from "vitest";
import {
	EMOTIONS,
	JUDGE_GAIN,
	JUDGE_MAX_TURNS,
	JUDGE_MIN_CONFIDENCE,
	JUDGE_SCALE,
	JUDGE_THINKING_CHARS,
	JUDGE_TURN_CHARS,
	judgeActivations,
	judgeDeltas,
	judgeDeltasFromScores,
	judgeDue,
	judgePrompt,
	judgeQuestions,
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

	it("puts the reasoning before the reply it produced, and labels it", () => {
		// A reader that cannot tell the two apart would rate the companion's private frustration as if
		// the user had said it out loud.
		const w = judgeWindow([
			{ role: "assistant", text: "好啊。", thinking: "他终于跑通了，我跟着松了一口。" },
			turn("user", "跑通了"),
		]);
		expect(judgeTranscript(w)).toBe(
			"Companion (thinking): 他终于跑通了，我跟着松了一口。\nCompanion: 好啊。\nUser: 跑通了",
		);
	});

	it("caps the reasoning on its own budget, and keeps a turn that has only reasoning to say", () => {
		const long = "x".repeat(JUDGE_THINKING_CHARS + 200);
		const capped = judgeWindow([{ role: "assistant", text: "", thinking: long }]);
		expect(capped).toHaveLength(1);
		expect(capped[0].thinking).toHaveLength(JUDGE_THINKING_CHARS);
		expect(capped[0].text).toBe("");
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
	it("routes a rise to its own channel at the positive gain (half the negative cap)", () => {
		// The 2:1 negativity asymmetry (Baumeister et al. 2001; Rozin & Royzman 2001): a rise of 2
		// rungs moves the kernel half as far as a fall of 2.
		expect(judgeActivations({ joy: 2 })).toEqual({ joy: JUDGE_GAIN / 2 });
		expect(judgeActivations({ joy: 1 }).joy).toBeCloseTo(JUDGE_GAIN / 4, 10);
	});

	it("routes a fall to the opponent channel at the full negative cap", () => {
		expect(oppositeEmotion("joy")).toBe("sadness");
		expect(oppositeEmotion("trust")).toBe("disgust");
		expect(oppositeEmotion("fear")).toBe("anger");
		expect(oppositeEmotion("surprise")).toBe("anticipation");
		expect(judgeActivations({ joy: -2 })).toEqual({ sadness: JUDGE_GAIN });
	});

	it("weighs a fall of 1 exactly twice a rise of 1", () => {
		// The asymmetry is the event's, not the channel's: joy -1 lands on sadness at 0.25, joy +1
		// lands on joy at 0.125.
		expect(judgeActivations({ joy: -1 })).toEqual({ sadness: JUDGE_GAIN / 2 });
	});

	it("attenuates a channel by the reader's confidence in it", () => {
		// Classical test theory's attenuation logic (Spearman 1904): unreliable testimony is discounted.
		expect(judgeActivations({ joy: 2 }, { joy: 0.5 })).toEqual({ joy: JUDGE_GAIN / 4 });
		expect(judgeActivations({ joy: -2 }, { joy: 0.5 })).toEqual({ sadness: JUDGE_GAIN / 2 });
		// No confidence reported (the chat tier): the reading arrives unattenuated.
		expect(judgeActivations({ joy: -2 }, {})).toEqual({ sadness: JUDGE_GAIN });
		// A degenerate confidence above 1 still cannot exceed the channel itself.
		expect(judgeActivations({ joy: -2 }, { joy: 9 })).toEqual({ sadness: 1 });
	});

	it("reads two answers on one axis as one axis, not twice the change", () => {
		// joy +1 (0.125 on joy) and sadness -1 (0.25 on joy, via the antipode) are the same statement;
		// summing would double it, so the larger wins.
		expect(judgeActivations({ joy: 1, sadness: -1 })).toEqual({ joy: JUDGE_GAIN / 2 });
	});

	it("says nothing when nothing moved", () => {
		expect(judgeActivations({})).toEqual({});
	});
});

describe("judge classifier questions", () => {
	it("asks one score question per channel on the five-rung ladder", () => {
		const q = judgeQuestions();
		expect(Object.keys(q)).toEqual([...EMOTIONS]);
		for (const e of EMOTIONS) {
			expect(q[e].type).toBe("score");
			expect(q[e].criteria).toHaveLength(5);
			// The middle rung is the "no change" anchor the answer is read against.
			expect(q[e].criteria[2]).toContain("0:");
			expect(q[e].instructions).toContain(e);
		}
	});

	it("keeps half-rung precision and centres on the ladder", () => {
		// An expectation of 3.4 rungs from the bottom is about +1.5 from the middle, not a rounding to +1.
		expect(judgeDeltasFromScores({ joy: { score: 3.4, confidence: 0.8 } })).toEqual({ joy: 1.5 });
		expect(judgeDeltasFromScores({ joy: { score: 3.1, confidence: 0.8 } })).toEqual({ joy: 1 });
		expect(judgeDeltasFromScores({ joy: { score: 0.75, confidence: 0.81 } })).toEqual({ joy: -1 });
		// The centre rung means unchanged, and so does a reading that only missed it by float noise.
		expect(judgeDeltasFromScores({ joy: { score: 2, confidence: 0.9 } })).toEqual({});
		expect(judgeDeltasFromScores({ joy: { score: 2 - 1e-7, confidence: 0.9 } })).toEqual({});
	});

	it("drops a flat distribution: a guess is not a reading", () => {
		expect(judgeDeltasFromScores({ joy: { score: 0, confidence: JUDGE_MIN_CONFIDENCE - 0.01 } })).toEqual({});
		expect(judgeDeltasFromScores({ joy: { score: 0, confidence: JUDGE_MIN_CONFIDENCE } })).toEqual({
			joy: -JUDGE_SCALE,
		});
		// A score outside the scale is clamped to the ladder rather than trusted.
		expect(judgeDeltasFromScores({ anger: { score: 4.9, confidence: 0.9 } })).toEqual({ anger: JUDGE_SCALE });
	});

	it("feeds the same activation path as the chat reader", () => {
		const deltas = judgeDeltasFromScores({ joy: { score: 4, confidence: 0.9 } });
		expect(judgeActivations(deltas)).toEqual({ joy: JUDGE_GAIN / 2 });
		// With the classifier's confidence reported, the same reading is attenuated by it.
		const scored = judgeDeltasFromScores({ sadness: { score: 0, confidence: 0.8 } });
		expect(judgeActivations(scored, { sadness: 0.8 })).toEqual({ joy: JUDGE_GAIN * 0.8 });
	});

	it("forces the companion's perspective in both question forms", () => {
		// The mirroring failure — a user's frustration read as the companion's anger — is the one
		// contamination an outside reader exists to prevent, so both instruments say it outright.
		for (const e of EMOTIONS) {
			expect(judgeQuestions()[e].instructions).toContain("belongs to");
		}
		expect(judgePrompt()).toContain("belongs to the user");
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

	it("waits for enough exchange, counted in the companion's own output", () => {
		// Time is not the gate: four hours of silence produced nothing to read, and four minutes of a
		// long reply is a stretch of exchange worth appraising.
		expect(judgeDue({ outputTokens: 100, thinkingTokens: 9_000, readsThinking: false, userTurns: 5 })).toBe(false);
		expect(judgeDue({ outputTokens: 599, thinkingTokens: 0, readsThinking: false, userTurns: 9 })).toBe(false);
		// ...and one new message must have arrived, so an overlapping window is not read twice.
		expect(judgeDue({ outputTokens: 5_000, thinkingTokens: 0, readsThinking: false, userTurns: 0 })).toBe(false);
		expect(judgeDue({ outputTokens: 600, thinkingTokens: 0, readsThinking: false, userTurns: 1 })).toBe(true);
		expect(
			judgeDue({
				outputTokens: 1,
				thinkingTokens: 1,
				readsThinking: false,
				userTurns: 1,
				minTokens: 0,
				minUserTurns: 1,
			}),
		).toBe(true);
	});

	it("gates a decision model on the thinking it also reads, an order of magnitude higher", () => {
		// The same stretch of exchange is several times the text for this reader, so the same reading is
		// taken after several times the tokens. Without the higher number the outside read would fire on
		// a long internal deliberation that produced nothing the user saw.
		expect(judgeDue({ outputTokens: 600, thinkingTokens: 0, readsThinking: true, userTurns: 3 })).toBe(false);
		expect(judgeDue({ outputTokens: 500, thinkingTokens: 5_499, readsThinking: true, userTurns: 3 })).toBe(false);
		expect(judgeDue({ outputTokens: 500, thinkingTokens: 5_500, readsThinking: true, userTurns: 3 })).toBe(true);
		// A reader that gets no thinking cannot be satisfied by thinking tokens.
		expect(judgeDue({ outputTokens: 100, thinkingTokens: 50_000, readsThinking: false, userTurns: 3 })).toBe(false);
	});
});
