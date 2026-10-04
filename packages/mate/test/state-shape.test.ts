/**
 * The state file is exactly the shape the code uses.
 *
 * Every dead field this project has had arrived the same way: a structure was transcribed whole from
 * the model's description, and the fields nothing reads or writes stayed behind - seeded at birth,
 * carried by the load path's `{ ...fresh, ...raw }` spread, re-persisted on every save, and rendered as
 * if life had shaped them. The regression that matters is the carrying: a state.json written by an old
 * build must NOT resurrect deleted fields into the new one, or the removal never lands for anyone who
 * was already using the companion.
 */

import { describe, expect, it } from "vitest";
import { birth, sanitiseState } from "../src/birth.ts";

/** A file as a 1.0.x-era build wrote it: the extra character traits, the extra awareness axes, the
 * counters that were only ever initialised, and the write-only perceivedGap. */
function oldShapeFile(): Record<string, unknown> {
	const s = birth({ seed: 3, born: 1_700_000_000_000 });
	return {
		...s,
		perceivedGap: 416713.44,
		character: {
			...s.character,
			attachmentAvoidance: 0.4,
			humor: 0.5,
			growthOrientation: 0.6,
			playfulness: 0.5,
			tenderness: 0.5,
			independence: 0.5,
			needForClosure: 0.5,
			sensuality: 0.5,
			spirituality: 0.5,
			ambition: 0.5,
			frugality: 0.5,
			loyalty: 0.5,
		},
		awareness: { ...s.awareness, conversationWarmth: 0.77, temporalPhase: 0.5 },
		drives: { ...s.drives, boredom: 0.2, selfPreservation: 0.1 },
		counters: { ...s.counters, proactiveSent: 0, proactiveBlocked: 0, dreams: 0 },
	};
}

describe("state.json sheds the fields this version does not use", () => {
	const loaded = sanitiseState(oldShapeFile());

	it("drops the top-level write-only field", () => {
		expect(Object.keys(loaded).sort()).toEqual(Object.keys(birth()).sort());
		expect("perceivedGap" in loaded).toBe(false);
	});

	it("keeps only the character traits the kernel moves", () => {
		expect(Object.keys(loaded.character).sort()).toEqual(Object.keys(birth().character).sort());
	});

	it("keeps only the awareness axes a decision consults", () => {
		expect(Object.keys(loaded.awareness).sort()).toEqual(["socialPressure", "thoughtSaturation", "userPresence"]);
	});

	it("keeps only the counters that are actually written", () => {
		expect(Object.keys(loaded.counters).sort()).toEqual(["messages", "observations", "sleepCycles", "transitions"]);
	});

	it("keeps only the drives the kernel integrates", () => {
		expect(Object.keys(loaded.drives).sort()).toEqual(["connection", "curiosity", "expression", "growth", "rest"]);
	});

	it("repairs a file with nothing recognisable in it", () => {
		const fresh = sanitiseState({ counters: { messages: "many" }, drives: 7, character: "warm" });
		expect(fresh.counters.messages).toBe(0);
		expect(Object.keys(fresh.drives).sort()).toEqual(["connection", "curiosity", "expression", "growth", "rest"]);
		expect(Object.keys(fresh.character).sort()).toEqual(Object.keys(birth().character).sort());
	});

	it("keeps the values it does recognise", () => {
		const r = sanitiseState({ ...oldShapeFile(), drives: { connection: 0.9, curiosity: 0.1 } });
		expect(r.drives.connection).toBe(0.9);
		expect(r.drives.curiosity).toBe(0.1);
		// A drive the file does not carry still gets its birth value, not undefined.
		expect(r.drives.rest).toBe(birth().drives.rest);
	});
});
