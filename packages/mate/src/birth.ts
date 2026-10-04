/**
 * Birth: create the initial state for a new companion.
 *
 * Personality (OCEAN) is the seed - nature. It is drawn around 0.5 with sd 0.15 so no two
 * companions start identical, then clamped. Character (the traits the kernel reads and moves) starts
 * near neutral and is shaped entirely by experience - nurture. Everything else starts at rest.
 */

import { fromEmotions, identity } from "./quantum.ts";
import { clamp01, drawMany } from "./rng.ts";
import { sanitiseBeliefs, seedBeliefStore } from "./spark.ts";
import type { Awareness, Character, Drives, MateState, Personality, Relationship } from "./types.ts";

const NEUTRAL_CHARACTER: Character = {
	selfWorth: 0.55,
	selfEfficacy: 0.5,
	optimismBias: 0.05,
	trustBaseline: 0.5,
	attachmentAnxiety: 0.35,
	reflectiveness: 0.5,
	directness: 0.5,
	depthPreference: 0.5,
	warmth: 0.55,
	vitality: 0.55,
	curiosity: 0.6,
	tolerance: 0.5,
	impulsivity: 0.4,
	rumination: 0.4,
	vulnerability: 0.45,
	assertiveness: 0.45,
	empathy: 0.6,
};

/** Draw a Big Five personality around 0.5 with sd ~0.15, in [0.05, 0.95]. */
export function drawPersonality(seed: number): { personality: Personality; seed: number } {
	const { values, seed: s2 } = drawMany(seed, 5);
	// Irwin-Hall-ish: average two uniforms for a soft triangular distribution, then scale.
	const tri = (i: number) => clamp01(0.5 + (values[i] - 0.5) * 0.6);
	return {
		personality: { o: tri(0), c: tri(1), e: tri(2), a: tri(3), n: tri(4) },
		seed: s2,
	};
}

export interface BirthOptions {
	/** Optional fixed personality; omit to draw one from the seed. */
	personality?: Personality;
	/** Optional character overrides on top of the neutral seed. */
	character?: Partial<Character>;
	/** Explicit seed; defaults to a hash of the birth time. */
	seed?: number;
	born?: number;
	name?: string;
}

/** Create a fresh state at rest. */
export function birth(opts: BirthOptions = {}): MateState {
	const born = opts.born ?? Date.now();
	const baseSeed = opts.seed ?? hashString(`mate:${born}:${Math.floor(born / 1000)}`);
	const { personality, seed } = opts.personality
		? { personality: opts.personality, seed: baseSeed }
		: drawPersonality(baseSeed);

	const emotions = { joy: 0, trust: 0, fear: 0, surprise: 0, sadness: 0, disgust: 0, anger: 0, anticipation: 0 };
	const awareness: Awareness = {
		userPresence: 0,
		socialPressure: 0,
		thoughtSaturation: 0,
	};
	const relationship: Relationship = {
		trust: personality.a * 0.5 + 0.25,
		attachment: 0,
		respect: 0.4,
		frustration: 0,
		familiarity: 0,
		unanswered: 0,
	};
	const drives: Drives = {
		connection: 0.2,
		curiosity: 0.4,
		expression: 0.15,
		growth: 0.3,
		rest: 0.1,
	};

	const rho = Object.values(emotions).every((v) => v === 0) ? identity() : fromEmotions(emotions, seed);

	return {
		version: 1,
		t: born,
		lastInteraction: born,
		lastHeartbeat: born,
		born,
		emotions,
		opponent: { ...emotions },
		mood: { p: 0.1, a: 0, d: 0 },
		personality,
		character: { ...NEUTRAL_CHARACTER, ...opts.character },
		relationship,
		drives,
		beliefs: seedBeliefStore(),
		awareness,
		allostasis: { fatigue: 0, load: 0, baselineShift: { p: 0, a: 0, d: 0 } },
		rho,
		habituation: {},
		observations: [],
		counters: {
			messages: 0,
			transitions: 0,
			sleepCycles: 0,
			observations: 0,
		},
		catastrophe: false,
		surpriseEma: 0,
		seed,
	};
}

/** FNV-1a 32-bit string hash. Deterministic across runs and platforms. */
export function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h | 0;
}

/**
 * Validate and repair a state loaded from disk. Corrupt or partial state must never crash boot:
 * fall back to the nearest valid value, or to a fresh birth if it is hopeless.
 *
 * Every level is picked key-by-key and never spread over the raw file, because a state.json written
 * by an older build carries fields this version deleted — `perceivedGap`, the 13 unread character
 * traits, the two dead drives, three counters that were only ever initialised. A spread resurrects
 * them, they get re-persisted on the next write, and every Object.entries-driven render shows them as
 * if they were still part of the self. Listing the keys here makes this file the single definition of
 * what a state is.
 */
function sanitiseCharacter(raw: unknown, fresh: Character): Character {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Character, unknown>>;
	const out: Character = { ...fresh };
	for (const k of Object.keys(fresh) as (keyof Character)[]) {
		const v = r[k];
		out[k] = typeof v === "number" && Number.isFinite(v) ? v : fresh[k];
	}
	return out;
}

export function sanitiseState(raw: unknown, opts: BirthOptions = {}): MateState {
	if (!raw || typeof raw !== "object") return birth(opts);
	const r = raw as Partial<MateState>;
	const fresh = birth({ ...opts, born: typeof r.born === "number" ? r.born : Date.now() });
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

	const state: MateState = {
		// No spread of the raw file anywhere at this level: a top-level `...r` would carry back every
		// field this version deleted (perceivedGap) and re-persist it. The key list below IS the format.
		version: num(r.version, fresh.version),
		t: num(r.t, fresh.t),
		lastInteraction: num(r.lastInteraction, fresh.lastInteraction),
		lastHeartbeat: num(r.lastHeartbeat, fresh.lastHeartbeat),
		born: num(r.born, fresh.born),
		emotions: { ...fresh.emotions, ...(r.emotions ?? {}) },
		opponent: { ...fresh.opponent, ...(r.opponent ?? {}) },
		mood: { ...fresh.mood, ...(r.mood ?? {}) },
		personality: { ...fresh.personality, ...(r.personality ?? {}) },
		character: sanitiseCharacter(r.character, fresh.character),
		relationship: { ...fresh.relationship, ...(r.relationship ?? {}) },
		// Drives are picked key-by-key, never spread: a state.json written by an older build carries
		// removed drive fields (boredom, selfPreservation), and a spread would resurrect them as stale
		// keys that every Object.entries-driven render would then display.
		drives: {
			connection: num(r.drives?.connection, fresh.drives.connection),
			curiosity: num(r.drives?.curiosity, fresh.drives.curiosity),
			expression: num(r.drives?.expression, fresh.drives.expression),
			growth: num(r.drives?.growth, fresh.drives.growth),
			rest: num(r.drives?.rest, fresh.drives.rest),
		},
		beliefs: sanitiseBeliefs(r.beliefs),
		awareness: {
			userPresence: num(r.awareness?.userPresence, fresh.awareness.userPresence),
			socialPressure: num(r.awareness?.socialPressure, fresh.awareness.socialPressure),
			thoughtSaturation: num(r.awareness?.thoughtSaturation, fresh.awareness.thoughtSaturation),
		},
		allostasis: { ...fresh.allostasis, ...(r.allostasis ?? {}) },
		// rho keeps whatever the file held; the quantum module repairs Hermiticity, trace and positivity
		// on load (see store.ts).
		rho: Array.isArray(r.rho) ? r.rho : fresh.rho,
		habituation: r.habituation && typeof r.habituation === "object" ? r.habituation : {},
		observations: Array.isArray(r.observations) ? r.observations.filter((x) => typeof x === "string") : [],
		counters: {
			messages: num(r.counters?.messages, 0),
			transitions: num(r.counters?.transitions, 0),
			sleepCycles: num(r.counters?.sleepCycles, 0),
			observations: num(r.counters?.observations, 0),
		},
		catastrophe: typeof r.catastrophe === "boolean" ? r.catastrophe : false,
		surpriseEma: num(r.surpriseEma, 0),
		seed: num(r.seed, fresh.seed),
	};
	// rho is repaired by the quantum module on load.
	return state;
}
