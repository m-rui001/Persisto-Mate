/**
 * The idle loop's habituation. `habituate()` has always RETURNED a trace; the bug was that the tick
 * dropped it, so every beat re-met every topic as brand new: the same impulse arriving again and
 * again at full strength ("第五次路过"), and `kernel.topicSaturation` — an input to boredom — reading
 * a store nothing ever wrote. These tests pin the write-back, the purity of the input state, and the
 * pruning that keeps the record from being a mean over dead entries.
 */

import { describe, expect, it } from "vitest";
import { birth } from "../src/birth.ts";
import { generateThoughts, habituate, type PreSendChecks, tick } from "../src/daemon.ts";
import { emptyMemory } from "../src/memory.ts";
import { HABITUATION_TAU } from "../src/params.ts";

const HOUR = 3_600_000;

function checks(now: number): PreSendChecks {
	return {
		hour: new Date(now).getUTCHours(),
		userActive: false,
		recentProactive: 0,
		topic: "",
		coldEnding: false,
	};
}

/** A companion alone for three hours: `missing_user` is guaranteed to generate a thought. */
function silenceState() {
	const now = 30 * HOUR;
	return { now, state: { ...birth({ seed: 7, born: 0 }), lastInteraction: now - 3 * HOUR } };
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

/**
 * The faint-pull gate and the voiced-topic saturation. A real impulse can be a smile, a note to
 * self, or "算了不说了" — only a conviction above the floor earns an interrupt, and a topic that was
 * just VOICED does not come straight back (the runtime marks its trace saturated; habituate()
 * consumes it).
 */
describe("daemon: interrupts are earned", () => {
	it("a faint pull stays inner life (think_only, reason faint-pull)", () => {
		const { now, state } = silenceState(); // 3h of silence: a real but weak pull
		const result = tick(state, now, checks(now), emptyMemory(), "en");
		expect(result.decision.action).toBe("think_only");
		if (result.decision.action === "think_only") expect(result.decision.reason).toBe("faint-pull");
		// The thought is still kept as inner life via its habituation trace.
		expect(Object.keys(result.state.habituation)).toHaveLength(1);
	});

	it("a strong pull earns the interrupt (reach_out)", () => {
		const { now } = silenceState();
		const loud = {
			...birth({ seed: 7, born: 0 }),
			character: { ...birth({ seed: 7, born: 0 }).character, impulsivity: 1 },
			personality: { ...birth({ seed: 7, born: 0 }).personality, e: 1 },
			drives: { ...birth({ seed: 7, born: 0 }).drives, curiosity: 0 },
			lastInteraction: now - 12 * HOUR,
		};
		const result = tick(loud, now, checks(now), emptyMemory(), "en");
		expect(result.decision.action).toBe("reach_out");
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
