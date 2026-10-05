/**
 * The idle-thought hint pool. The user's own memory.json showed the loop this pins shut: the top
 * activation seats were held by one thread's family, the LLM hint path never rotated, and the
 * machine's own sentences echoed back as hints ("第二次冒出来" → ponder → memory → hint → "第三次
 * 冒头"). hintsOf must rotate on the decision counter, and must not hint from the echo channels.
 */

import { birth, emptyMemory, encode, HABITUATION_TAU, type MateState, type MemoryGraph } from "@earendil-works/pi-mate";
import { describe, expect, it } from "vitest";
import { hintsOf } from "../src/extensions/mate/inner-voice.ts";

const HOUR = 3_600_000;

function fixture(): { memory: MemoryGraph; state: MateState } {
	const memory = emptyMemory();
	const now = 100 * HOUR;
	// Six same-strength memories: activation ranking is then settled by recency, and the pool is
	// wider than the hint count, so rotation has somewhere to go.
	const labels = ["alpha memory", "beta memory", "gamma memory", "delta memory", "epsilon memory", "zeta memory"];
	let m = memory;
	for (let i = 0; i < labels.length; i++) {
		m = encode(m, {
			text: labels[i],
			pad: { p: 0, a: 0, d: 0 },
			t: now - (labels.length - i) * HOUR,
			importance: 0.5,
		});
	}
	const state = { ...birth({ seed: 5, born: 0 }), t: now };
	return { memory: m, state };
}

describe("idle-thought hint pool", () => {
	it("rotates with the decision counter instead of always reading the front", () => {
		const { memory, state } = fixture();
		const early = hintsOf(memory, { ...state, counters: { ...state.counters, observations: 0 } });
		const later = hintsOf(memory, { ...state, counters: { ...state.counters, observations: 3 } });
		expect(early).toHaveLength(3);
		expect(later).toHaveLength(3);
		// Same pool, different seats: at least the first hint moves.
		expect(later[0]).not.toBe(early[0]);
	});

	it("does not serve the observations ring back as a hint (the echo channel)", () => {
		const { memory, state } = fixture();
		const echoed = hintsOf(memory, {
			...state,
			observations: ["第四次冒头了。今天该说的都已经出口，剩下的只是惯性转圈。"],
		});
		expect(echoed.some((h) => h.includes("第四次冒头"))).toBe(false);
		// Dreams still get the day's residues — that is what a dream is made of.
		const dream = hintsOf(memory, { ...state, observations: ["第四次冒头了。"] }, [], true);
		expect(dream.some((h) => h.includes("第四次冒头"))).toBe(true);
	});

	it("a private note written inside one habituation window does not hint again", () => {
		const { memory: fresh, state } = fixture();
		// The echo memory: a private ponder of the thought that just happened.
		const withEcho = encode(fresh, {
			text: "这念头第三次冒头，先压住。",
			pad: { p: 0, a: 0, d: 0 },
			t: state.t,
			private: true,
			importance: 1,
		});
		const hints = hintsOf(withEcho, state);
		expect(hints.some((h) => h.includes("第三次冒头"))).toBe(false);
		// The same note, old enough to have cooled off, hints normally again.
		const cooled = encode(fresh, {
			text: "这念头第三次冒头，先压住。",
			pad: { p: 0, a: 0, d: 0 },
			t: state.t - HABITUATION_TAU - 1,
			private: true,
			importance: 1,
		});
		const later = hintsOf(cooled, { ...state, t: state.t });
		expect(later.some((h) => h.includes("第三次冒头"))).toBe(true);
	});
});
