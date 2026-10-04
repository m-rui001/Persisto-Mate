/**
 * SPARK (the cognitive autopoietic loop) and the derived boredom signal.
 *
 * The invariants that matter:
 *   - The loop CANNOT run away: the Eq. 24 bias is bounded by the modulation gain, and the dsanity
 *     damper weakens the loop as the belief system rigidifies (paper telemetry: 910 events, 0
 *     runaways).
 *   - Evidence learning is asymmetric (confirmation bias per Lefebvre et al. 2022) but confidence is
 *     caged in [floor, 1 − floor] — a belief is never certain, never impossible.
 *   - Beliefs are precarious: without evidence they relax toward the floor in closed form, which is
 *     subdivision-invariant (asserted via catchUp's verifySubdivisionInvariance in kernel.test.ts).
 *   - Boredom is DERIVED (kernel.boredomOf): zero right after contact, high after long silence in a
 *     predictable world, and suppressed by genuine novelty (surprise) — never a discharging reservoir.
 */

import { describe, expect, it } from "vitest";
import { birth, sanitiseState } from "../src/birth.ts";
import { catchUp } from "../src/catchup.ts";
import { boredomOf, transition } from "../src/kernel.ts";
import { SPARK } from "../src/params.ts";
import { applyBeliefEvidence, beliefLens, centralityOf, dsanityOf, seedBeliefStore, strengthOf } from "../src/spark.ts";

const HOUR = 3_600_000;

/** One warm contact event with a distinct topic word. */
function warmEvent(t: number, text?: string, topics?: string[]) {
	return {
		kind: "user_message" as const,
		activations: { joy: 0.8, trust: 0.6 },
		intent: "chat" as const,
		text,
		topics,
		t,
	};
}

/** One hostile contact event. */
function hostileEvent(t: number) {
	return {
		kind: "user_message" as const,
		activations: { anger: 0.7, fear: 0.5 },
		intent: "chat" as const,
		t,
	};
}

describe("SPARK: belief evidence updates", () => {
	it("moves confidence faster for confirming than for violating evidence (asymmetric learning)", () => {
		const confirmed = applyBeliefEvidence(seedBeliefStore(), { perceived: 0.6, topics: [] }, 1);
		const violated = applyBeliefEvidence(seedBeliefStore(), { perceived: -0.6, topics: [] }, 1);
		const gainConfirmed = confirmed.othersTrustworthy.confidence - 0.5;
		const lossViolated = 0.5 - violated.othersTrustworthy.confidence;
		expect(gainConfirmed).toBeGreaterThan(lossViolated);
	});

	it("cages confidence: it never passes the certainty ceiling no matter how much evidence confirms it", () => {
		let beliefs = seedBeliefStore();
		for (let i = 0; i < 200; i++) beliefs = applyBeliefEvidence(beliefs, { perceived: 0.9, topics: [] }, i);
		expect(beliefs.othersTrustworthy.confidence).toBeLessThanOrEqual(1 - SPARK.confidenceFloor);
		expect(beliefs.othersTrustworthy.confidence).toBeGreaterThan(0.9);
	});

	it("drifts a belief's valence toward the evidence it keeps seeing", () => {
		let beliefs = seedBeliefStore();
		for (let i = 0; i < 30; i++) beliefs = applyBeliefEvidence(beliefs, { perceived: -0.8, topics: [] }, i);
		expect(beliefs.othersTrustworthy.valence).toBeLessThan(0);
	});

	it("ignores neutral evidence entirely (dead zone)", () => {
		const beliefs = applyBeliefEvidence(seedBeliefStore(), { perceived: 0.05, topics: [] }, 5);
		expect(beliefs.othersTrustworthy).toEqual(seedBeliefStore().othersTrustworthy);
	});
});

describe("SPARK: perception modulation (Eq. 24)", () => {
	it("biases perceived valence toward the belief, both directions, never flipping the sign", () => {
		const beliefs = seedBeliefStore();
		// Give the seeds some evidence so they have strength (count 0 → centrality 0 → no bias).
		const warmed = applyBeliefEvidence(beliefs, { perceived: 0.5, topics: [] }, 1);
		const applying = Object.values(warmed).filter((b) => b.key.startsWith("others") || b.key.startsWith("world"));
		const lens = beliefLens(warmed, applying);
		expect(lens).not.toBeNull();
		// The kernel applies the lens in the CONFIRMATORY direction (see the SPARK block in
		// transition): evidence agreeing with the belief's orientation is amplified, conflicting
		// evidence is dampened — the belief never flips the evidence's sign.
		const positive = 0.6 * (1 + Math.sign(0.6) * lens!.bias);
		const negative = -0.6 * (1 + Math.sign(-0.6) * lens!.bias);
		expect(positive).toBeGreaterThan(0.6); // confirming evidence is amplified
		expect(negative).toBeGreaterThan(-0.6); // disconfirming evidence is dampened
		expect(negative).toBeLessThan(0); // ...but never inverted
		expect(Math.sign(positive)).toBe(1);
	});

	it("cannot run away: the bias is capped by the modulation gain even for a maximally rigid system", () => {
		// Every belief maximally confident and maximally central: rigidity 1 → dsanity hits its floor
		// (1 − damper). Even then the bias stays a small fraction of the valence.
		const beliefs = seedBeliefStore();
		for (const b of Object.values(beliefs)) {
			b.confidence = 1;
			b.count = 100_000;
		}
		expect(dsanityOf(beliefs)).toBeCloseTo(1 - SPARK.damper, 10);
		const applying = Object.values(beliefs);
		const lens = beliefLens(beliefs, applying)!;
		expect(Math.abs(lens.bias)).toBeLessThan(SPARK.modulation);
	});

	it("gives a one-off topic no influence (centrality starts at zero)", () => {
		const beliefs = seedBeliefStore();
		const fresh = { key: "coffee", label: "coffee", valence: 0.8, confidence: 0.5, count: 0, t: 0 };
		expect(centralityOf(fresh)).toBe(0);
		expect(strengthOf(fresh)).toBe(0);
		expect(beliefLens(beliefs, [fresh])).toBeNull();
	});
});

describe("SPARK: the loop through the kernel", () => {
	it("revises beliefs: warmth orients othersTrustworthy positive, hostility flips it and then confirms the flip", () => {
		let s = birth({ seed: 5, born: 0 });
		for (let i = 0; i < 10; i++) s = transition(s, warmEvent((i + 1) * HOUR), HOUR).state;
		expect(s.beliefs.othersTrustworthy.valence).toBeGreaterThan(0.24);
		let h = birth({ seed: 5, born: 0 });
		for (let i = 0; i < 10; i++) h = transition(h, hostileEvent((i + 1) * HOUR), HOUR).state;
		// Belief revision: the orientation itself turns negative under sustained hostility...
		expect(h.beliefs.othersTrustworthy.valence).toBeLessThan(0);
		// ...and once flipped, the loop CONFIRMS the cynical belief (confidence dips, then recovers
		// above birth level) — that is autopoiesis working, not a bug: certainty tracks the
		// orientation, it does not defend the birth prior.
		expect(h.beliefs.othersTrustworthy.confidence).toBeGreaterThan(0.5);
	});

	it("crystallises topic beliefs from model-named topics, not from raw message words", () => {
		let s = birth({ seed: 6, born: 0 });
		// Message text alone no longer sprays the belief store: the tokeniser era is gone, and a
		// rambling message cannot invent beliefs for its own fragments.
		s = transition(s, warmEvent(HOUR, "今天天气很好我们一起去散步吧"), HOUR).state;
		const afterText = Object.keys(s.beliefs).filter((k) => k !== "othersTrustworthy" && k !== "worldSafety");
		expect(afterText).toEqual([]);

		// Topics arrive NAMED — the topics tags on remember/ponder — and crystallise as weak beliefs.
		s = transition(s, warmEvent(s.t + HOUR, "聊到了下周的面试", ["面试"]), HOUR).state;
		const topicKeys = Object.keys(s.beliefs).filter((k) => k !== "othersTrustworthy" && k !== "worldSafety");
		expect(topicKeys).toEqual(["面试"]);
		expect(s.beliefs.面试.confidence).toBe(SPARK.topicSeedConfidence);
	});

	it("feeds evidence to a topic belief when its subject appears in the message text", () => {
		let s = birth({ seed: 6, born: 0 });
		s = transition(s, warmEvent(HOUR, undefined, ["面试"]), HOUR).state;
		const before = s.beliefs.面试;
		expect(before).toBeDefined();
		// A hostile message that literally touches the subject (word/substring match, no tokeniser)
		// feeds the belief negative evidence: its valence turns toward the experience.
		s = transition(
			s,
			{
				kind: "user_message",
				activations: { anger: 0.7, fear: 0.5 },
				intent: "chat",
				text: "面试搞砸了，别提了",
				t: s.t + HOUR,
			},
			HOUR,
		).state;
		const after = s.beliefs.面试;
		expect(after.valence).toBeLessThan(before.valence);
		expect(after.count).toBeGreaterThan(before.count);
	});

	it("keeps beliefs precarious: without evidence they relax toward the floor across a gap", () => {
		let s = birth({ seed: 7, born: 0 });
		for (let i = 0; i < 5; i++) s = transition(s, warmEvent((i + 1) * HOUR), HOUR).state;
		const confident = s.beliefs.othersTrustworthy.confidence;
		const after = catchUp(s, undefined, s.t + 60 * 86_400_000).state; // two months of silence
		expect(after.beliefs.othersTrustworthy.confidence).toBeLessThan(confident);
		expect(after.beliefs.othersTrustworthy.confidence).toBeGreaterThanOrEqual(SPARK.confidenceFloor);
	});
});

describe("derived boredom (kernel.boredomOf)", () => {
	it("is zero right after contact and after pure novelty; the idle gate is only a gate", () => {
		let s = birth({ seed: 11, born: 0 });
		s = transition(s, warmEvent(s.t + HOUR), HOUR).state;
		expect(boredomOf(s, s.t)).toBe(0);
	});

	it("climbs with silence in a predictable world", () => {
		const s = birth({ seed: 12, born: 0 });
		const after = catchUp(s, undefined, s.t + 24 * HOUR).state;
		const b = boredomOf(after, after.t);
		expect(b).toBeGreaterThan(0.2);
		expect(b).toBeLessThanOrEqual(1);
	});

	it("is suppressed by genuine novelty — a surprising message drops it below the unsurprising path", () => {
		// Path A: twelve hours of nothing.
		let a = birth({ seed: 13, born: 0 });
		a = catchUp(a, undefined, a.t + 12 * HOUR).state;
		// Path B: six hours of nothing, one startling message, six more hours of nothing — the SAME
		// wall-clock total, but the surprise EMA is still elevated and boredom must be lower.
		let b = birth({ seed: 13, born: 0 });
		b = catchUp(b, undefined, b.t + 6 * HOUR).state;
		b = transition(
			b,
			{ kind: "user_message", activations: { surprise: 1, fear: 0.8 }, intent: "chat", t: b.t + HOUR },
			HOUR,
		).state;
		b = catchUp(b, undefined, b.t + 5 * HOUR).state;
		expect(boredomOf(b, a.t)).toBeLessThan(boredomOf(a, a.t));
	});
});

describe("state migration", () => {
	it("strips removed drive fields from old state.json instead of resurrecting them", () => {
		const old = {
			version: 1,
			t: 1000,
			born: 0,
			drives: {
				connection: 0.5,
				curiosity: 0.4,
				expression: 0.3,
				growth: 0.2,
				rest: 0.1,
				boredom: 0.9,
				selfPreservation: 0.8,
			},
		};
		const state = sanitiseState(old);
		expect(Object.keys(state.drives).sort()).toEqual(["connection", "curiosity", "expression", "growth", "rest"]);
		expect("boredom" in state.drives).toBe(false);
		expect("selfPreservation" in state.drives).toBe(false);
		expect(state.drives.connection).toBe(0.5);
	});

	it("repairs a broken belief store back to the seed set instead of crashing", () => {
		const state = sanitiseState({ version: 1, t: 0, beliefs: { junk: { valence: "no", confidence: null } } });
		expect(Object.keys(state.beliefs).sort()).toEqual(["othersTrustworthy", "worldSafety"]);
	});
});
