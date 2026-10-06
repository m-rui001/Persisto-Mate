/**
 * The idle loop after the simplification: three thought channels (想你 / 好奇或无聊 / 有话想说),
 * urgency taken straight from the drive, and NO conviction floor — the only gates left in tick()
 * are the two hard hygiene stops (unanswered-overture tolerance, hourly proactive budget). The
 * habituation write-back pins survive from the original bug (the tick dropping the trace, so every
 * beat re-met every topic as brand new).
 */

import { describe, expect, it } from "vitest";
import { birth } from "../src/birth.ts";
import { generateThoughts, habituate, type PreSendChecks, tick } from "../src/daemon.ts";
import { emptyMemory } from "../src/memory.ts";
import { HABITUATION_TAU } from "../src/params.ts";
import type { MateState } from "../src/types.ts";

const HOUR = 3_600_000;

function checks(now: number, overrides: Partial<PreSendChecks> = {}): PreSendChecks {
	void now;
	return { userActive: false, recentProactive: 0, ...overrides };
}

/** Alone for three hours with the connection drive already past its band. */
function silenceState(): { now: number; state: MateState } {
	const now = 30 * HOUR;
	const base = birth({ seed: 7, born: 0 });
	return {
		now,
		state: {
			...base,
			lastInteraction: now - 3 * HOUR,
			drives: { ...base.drives, connection: 0.9 },
		},
	};
}

/** The chosen thought, when the beat thought anything at all. */
function chosen(result: ReturnType<typeof tick>) {
	if (result.decision.action === "stay_silent") throw new Error("expected a thought");
	return result.decision.thought;
}

describe("daemon: tick persists the habituation of what it thought", () => {
	it("writes one trace for the chosen topic and leaves the input state alone", () => {
		const { now, state } = silenceState();
		const result = tick(state, now, checks(now), emptyMemory(), "en");
		const topic = chosen(result).topic;

		expect(Object.keys(result.state.habituation)).toEqual([topic]);
		expect(result.state.habituation[topic]).toEqual({ s: 0.25, t: now });
		// Pure in, new object out — the host decides whether to keep it.
		expect(state.habituation).toEqual({});
	});

	it("a repeat of the same topic arrives with less urgency than the first time", () => {
		const { now, state } = silenceState();
		const first = tick(state, now, checks(now), emptyMemory(), "en");
		const second = tick(first.state, now + HOUR, checks(now + HOUR), emptyMemory(), "en");
		const a = chosen(first);
		const b = chosen(second);

		// Same silence bucket, so the same topic string — the case the bug lived in.
		expect(b.topic).toBe(a.topic);
		expect(b.urgency).toBeLessThan(a.urgency);
		// The trace deepens (S decays a little over one hour, then +0.25) and its clock moves.
		const trace = second.state.habituation[a.topic];
		expect(trace.t).toBe(now + HOUR);
		expect(trace.s).toBeGreaterThan(0.25);
	});

	it("drops traces older than 6 tau instead of averaging them forever", () => {
		const { now, state } = silenceState();
		const lived = {
			...state,
			habituation: { ancient: { s: 1, t: now - 7 * HABITUATION_TAU } },
		};
		const result = tick(lived, now, checks(now), emptyMemory(), "en");
		chosen(result);
		expect(result.state.habituation.ancient).toBeUndefined();
	});
});

describe("daemon: thoughts come straight from the drives", () => {
	it("urgency IS the drive value, not a coefficient stack", () => {
		const { now, state } = silenceState();
		const thoughts = generateThoughts(state, now, emptyMemory(), "en");
		const missing = thoughts.find((t) => t.thought.kind === "missing_user");
		expect(missing).toBeDefined();
		expect(missing!.rawUrgency).toBe(0.9);
	});

	it("felt presence damps the missing-user urge; the anxious protest amplifies it", () => {
		const { now, state } = silenceState();
		// Still feeling the user in the room halves the urge: contact that is felt is not absent.
		const present = { ...state, awareness: { ...state.awareness, userPresence: 0.9 } };
		const damped = generateThoughts(present, now, emptyMemory(), "en").find((t) => t.thought.kind === "missing_user");
		expect(damped!.rawUrgency).toBeCloseTo(0.9 * (1 - 0.5 * 0.9), 10);
		// The protest under silence (negative socialPressure) amplifies it, scaled by the anxious
		// attachment it belongs to.
		const protesting = {
			...state,
			character: { ...state.character, attachmentAnxiety: 0.5 },
			awareness: { ...state.awareness, socialPressure: -0.8 },
		};
		const amplified = generateThoughts(protesting, now, emptyMemory(), "en").find(
			(t) => t.thought.kind === "missing_user",
		);
		expect(amplified!.rawUrgency).toBeCloseTo(0.9 * (1 + 0.5 * 0.8), 10);
		// A secure body under the same protest is barely moved.
		const secure = {
			...state,
			character: { ...state.character, attachmentAnxiety: 0 },
			awareness: { ...state.awareness, socialPressure: -0.8 },
		};
		const flat = generateThoughts(secure, now, emptyMemory(), "en").find((t) => t.thought.kind === "missing_user");
		expect(flat!.rawUrgency).toBe(0.9);
	});

	it("a thought exists exactly when the drive is past the 0.6 band", () => {
		const now = 30 * HOUR;
		const base = birth({ seed: 7, born: 0 });
		const quiet = {
			...base,
			lastInteraction: now - 3 * HOUR,
			drives: { ...base.drives, connection: 0.5, curiosity: 0.5 },
		};
		expect(generateThoughts(quiet, now, emptyMemory(), "en")).toHaveLength(0);
	});

	it("no floor: even a modest pull surfaces (the model decides, not a formula)", () => {
		const { now, state } = silenceState();
		const result = tick(state, now, checks(now), emptyMemory(), "en");
		expect(result.decision.action).toBe("reach_out");
		if (result.decision.action === "reach_out") expect(result.decision.reason).toBe("surfaced");
	});
});

describe("daemon: the two hard hygiene stops", () => {
	it("stops reaching into silence past the unanswered tolerance", () => {
		const { now, state } = silenceState();
		const ignored = { ...state, relationship: { ...state.relationship, unanswered: 3 } };
		const result = tick(ignored, now, checks(now), emptyMemory(), "en");
		expect(result.decision.action).toBe("think_only");
		if (result.decision.action === "think_only") {
			expect(result.decision.reason).toContain("tolerance");
		}
		// The thought is still kept as inner life via its habituation trace.
		expect(Object.keys(result.state.habituation)).toHaveLength(1);
	});

	it("stops at the hourly proactive budget", () => {
		const { now, state } = silenceState();
		const result = tick(state, now, checks(now, { recentProactive: 9 }), emptyMemory(), "en");
		expect(result.decision.action).toBe("think_only");
		if (result.decision.action === "think_only") {
			expect(result.decision.reason).toContain("budget");
		}
	});

	it("an active conversation is never rate-gated", () => {
		const { now, state } = silenceState();
		const ignored = { ...state, relationship: { ...state.relationship, unanswered: 9 } };
		const result = tick(ignored, now, checks(now, { userActive: true, recentProactive: 9 }), emptyMemory(), "en");
		expect(result.decision.action).toBe("reach_out");
		if (result.decision.action === "reach_out") expect(result.decision.channel).toBe("reply");
	});

	it("a voiced (saturated) topic comes back at well under half strength", () => {
		const { now, state } = silenceState();
		// The beat one hour ago chose a topic; markVoiced() then wrote its trace saturated (s=1).
		const t0 = now - HOUR;
		const topic = chosen(tick(state, t0, checks(t0), emptyMemory(), "en")).topic;
		const raw = generateThoughts(state, t0, emptyMemory(), "en").find((t) => t.thought.topic === topic);
		expect(raw).toBeDefined();
		// Same topic, same raw pull: the saturated trace must cut the urgency to a fraction of the
		// fresh-topic run.
		const plain = habituate(state, topic, raw!.rawUrgency, t0);
		const again = habituate(
			{ ...state, habituation: { [topic]: { s: 1, t: t0 - HOUR } } },
			topic,
			raw!.rawUrgency,
			t0,
		);
		expect(again.urgency).toBeLessThan(plain.urgency * 0.6);
	});
});
