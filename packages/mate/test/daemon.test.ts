/**
 * The idle loop's habituation. `habituate()` has always RETURNED a trace; the bug was that the tick
 * dropped it, so every beat re-met every topic as brand new: the same impulse arriving again and
 * again at full strength ("第五次路过"), and `kernel.topicSaturation` — an input to boredom — reading
 * a store nothing ever wrote. These tests pin the write-back, the purity of the input state, and the
 * pruning that keeps the record from being a mean over dead entries.
 */

import { describe, expect, it } from "vitest";
import { birth } from "../src/birth.ts";
import { type PreSendChecks, tick } from "../src/daemon.ts";
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
