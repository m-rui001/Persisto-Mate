/**
 * SPARK - the cognitive autopoietic loop (MATE section 3.9).
 *
 * A persistent belief structure that closes two loops: beliefs modulate how incoming evidence is
 * perceived, and perceived evidence updates the beliefs. It is "autopoietic" because the beliefs are
 * generated from the system's own activity and then reshape the input that generates the next ones.
 *
 * The paper's Eq. 24 biases a perceived value by `valence × strength × 0.15 × dsanity`:
 *   - valence   in [-1,1]: the belief's evaluative orientation (what it expects the world to be like);
 *   - strength  in [0,1]:  geometric mean of confidence (a Bayesian-ish posterior, vmPFC analog) and
 *                          centrality (evidence count saturating, ACC analog);
 *   - dsanity   in [0.2,1]: the runaway damper, 1 − rigidity × 0.8, where rigidity tracks how closed
 *                          the belief system has become. Production telemetry in the paper (910
 *                          events) showed a mean modulation of +0.000355 and zero runaways — the
 *                          small gain and the damper are what keep the loop stable.
 *
 * Evidence updates use asymmetric learning rates (confirming evidence moves confidence twice as fast
 * as disconfirming evidence — Lefebvre et al. 2022 treat confirmation bias during reinforced
 * self-learning as a normative feature of the loop, not a defect; the dsanity damper is the
 * counterweight). Seed beliefs follow Young's schema-therapy triad used by the paper: how others are,
 * how the world is. The self-domain already lives in the character traits, so it is not duplicated
 * here. Topic beliefs crystallise from subjects the model itself names (the `topics` tags on
 * remember/ponder) or that literally recur in message text, with low initial confidence, and must
 * earn influence — a one-off remark has negligible strength and is pruned first.
 *
 * Everything here is pure and deterministic: no clocks, no randomness, bounded stores, and confidence
 * decays in closed form (precariousness — beliefs require evidence to persist, so a companion left
 * alone slowly reverts toward its birth priors).
 */

import { SPARK } from "./params.ts";
import { clamp01, clampPad } from "./rng.ts";
import type { Belief } from "./types.ts";

/** Birth priors (the paper's core-belief seeds start at confidence 0.5, slightly positive valence). */
export const SEED_BELIEFS: ReadonlyArray<{ key: string; label: string; valence: number }> = [
	{ key: "othersTrustworthy", label: "others are trustworthy", valence: 0.2 },
	{ key: "worldSafety", label: "the world is mostly benign", valence: 0.2 },
];

const SEED_KEYS = new Set(SEED_BELIEFS.map((b) => b.key));

/** Fresh belief store at birth. */
export function seedBeliefStore(): Record<string, Belief> {
	const beliefs: Record<string, Belief> = {};
	for (const s of SEED_BELIEFS) {
		beliefs[s.key] = { key: s.key, label: s.label, valence: s.valence, confidence: 0.5, count: 0, t: 0 };
	}
	return beliefs;
}

/** Centrality (ACC analog): evidence count saturating on a smooth curve, in [0,1]. */
export function centralityOf(b: Belief): number {
	return 1 - Math.exp(-b.count / SPARK.centralityTau);
}

/** Strength (Eq. 24): geometric mean of confidence and centrality. */
export function strengthOf(b: Belief): number {
	return Math.sqrt(clamp01(b.confidence) * centralityOf(b));
}

/** Rigidity: how closed the whole belief system has become (mean confidence). */
export function rigidityOf(beliefs: Record<string, Belief>): number {
	const all = Object.values(beliefs);
	if (all.length === 0) return 0;
	return all.reduce((a, b) => a + b.confidence, 0) / all.length;
}

/** The runaway damper (Eq. 24's dsanity): high rigidity weakens the loop, so it can never run away. */
export function dsanityOf(beliefs: Record<string, Belief>): number {
	return 1 - SPARK.damper * clamp01(rigidityOf(beliefs));
}

export interface BeliefLens {
	/** Confidence-weighted valence the applying beliefs expected for this event, in [-1,1]. */
	predicted: number;
	/** Eq. 24 aggregate bias on perceived valence: predicted × strength × modulation × dsanity. */
	bias: number;
}

/**
 * Aggregate the applying beliefs into one perceptual lens. `applying` is the (possibly empty) set of
 * beliefs that bear on this event; an empty set yields null and perception passes through unbiassed.
 */
export function beliefLens(beliefs: Record<string, Belief>, applying: Belief[]): BeliefLens | null {
	if (applying.length === 0) return null;
	let wSum = 0;
	let wVal = 0;
	let sSum = 0;
	for (const b of applying) {
		const w = strengthOf(b);
		wSum += w;
		wVal += w * b.valence;
		sSum += w;
	}
	if (wSum <= 1e-9) return null;
	const predicted = wVal / wSum;
	const meanStrength = sSum / applying.length;
	const bias = predicted * meanStrength * SPARK.modulation * dsanityOf(beliefs);
	return { predicted, bias };
}

export interface BeliefEvidence {
	/** Perceived valence of the event, AFTER the belief lens (the autopoietic closure: beliefs colour
	 * perception, and the coloured perception is what feeds back as evidence). */
	perceived: number;
	/** Topic keys this event touched: existing beliefs matched from the message text, or model-named
	 * topics from remember/ponder events; drives topic beliefs. */
	topics: string[];
}

/**
 * Feed one piece of evidence to the belief store. Pure: returns a new record. Neutral evidence
 * (|perceived| below the dead zone) updates confidence and valence of nothing — it still refreshes
 * nothing else, so a stream of "ok" messages neither confirms nor erodes the beliefs.
 *
 * New topic beliefs are created with low confidence; overflow prunes the weakest non-seed belief by
 * influence (confidence × centrality), ties broken by key, so the store is bounded and deterministic.
 */
export function applyBeliefEvidence(
	beliefs: Record<string, Belief>,
	evidence: BeliefEvidence,
	t: number,
): Record<string, Belief> {
	const next: Record<string, Belief> = {};
	for (const [k, b] of Object.entries(beliefs)) next[k] = { ...b };

	if (Math.abs(evidence.perceived) >= SPARK.evidenceDeadZone) {
		const applying = new Set(evidence.topics);
		for (const b of Object.values(next)) {
			if (SEED_KEYS.has(b.key) || applying.has(b.key)) {
				const agrees = Math.sign(evidence.perceived) === Math.sign(b.valence);
				const eta = agrees ? SPARK.etaConfirm : SPARK.etaViolate;
				b.confidence = clampConfidence(
					agrees ? b.confidence + eta * (1 - b.confidence) : b.confidence - eta * b.confidence,
				);
				b.valence = clampPad(b.valence + (evidence.perceived - b.valence) * SPARK.etaValence);
				b.count += 1;
				b.t = t;
			}
		}
	}

	// Crystallisation: a topic the companion keeps meeting becomes a belief about itself, starting
	// weak. Only the first topics per event are admitted, so a rambling message cannot spray the
	// store. A belief says what the world is EXPECTED to be like, so a topic met with no valence at
	// all has nothing to believe yet: neutral evidence creates no belief, it only marks the topic as
	// seen once real evidence arrives. `label` is omitted when it would repeat `key` — the display
	// layer already falls back to the key, and storing both doubles every topic belief's storage for
	// a string the reader can already see.
	for (const topic of evidence.topics) {
		if (next[topic]) continue;
		if (Math.abs(evidence.perceived) < SPARK.evidenceDeadZone) continue;
		next[topic] = {
			key: topic,
			valence: clampPad(evidence.perceived),
			confidence: SPARK.topicSeedConfidence,
			count: 1,
			t,
		};
	}

	return prune(next);
}

/** Precariousness: confidence relaxes toward the floor without evidence, in exact closed form. */
export function decayBeliefs(beliefs: Record<string, Belief>, dt: number): Record<string, Belief> {
	if (dt <= 0) return beliefs;
	const decay = Math.exp(-dt / SPARK.decayTau);
	const next: Record<string, Belief> = {};
	let changed = false;
	for (const [k, b] of Object.entries(beliefs)) {
		const confidence = SPARK.confidenceFloor + (b.confidence - SPARK.confidenceFloor) * decay;
		if (confidence !== b.confidence) changed = true;
		next[k] = { ...b, confidence };
	}
	return changed ? next : beliefs;
}

/** Drop the weakest non-seed beliefs beyond the cap. Influence = confidence × centrality. */
function prune(beliefs: Record<string, Belief>): Record<string, Belief> {
	const entries = Object.values(beliefs);
	if (entries.length <= SPARK.maxBeliefs) return beliefs;
	const ranked = entries
		.filter((b) => !SEED_KEYS.has(b.key))
		.sort((a, b) => a.confidence * centralityOf(a) - b.confidence * centralityOf(b) || (a.key < b.key ? -1 : 1));
	const excess = entries.length - SPARK.maxBeliefs;
	for (let i = 0; i < excess && i < ranked.length; i++) delete beliefs[ranked[i].key];
	return beliefs;
}

/** Which seed beliefs bear on an event kind. Others: user messages (how this person treats us).
 * World: everything that happens, including what we ourselves put out. An appraisal is the judge's
 * read of a whole stretch of exchange, so it bears on both, exactly as a message does. */
export function seedBeliefsFor(kind: "user_message" | "proactive" | "appraisal"): string[] {
	return kind === "proactive" ? ["worldSafety"] : ["othersTrustworthy", "worldSafety"];
}

/** Repair a store loaded from disk; anything malformed falls back to the seed set rather than boot. */
export function sanitiseBeliefs(raw: unknown): Record<string, Belief> {
	const out = seedBeliefStore();
	if (!raw || typeof raw !== "object") return out;
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!v || typeof v !== "object") continue;
		const b = v as Partial<Belief>;
		if (typeof b.valence !== "number" || typeof b.confidence !== "number") continue;
		out[k] = {
			key: typeof b.key === "string" ? b.key : k,
			...(typeof b.label === "string" && b.label !== k ? { label: b.label } : {}),
			valence: clampPad(b.valence),
			confidence: clampConfidence(b.confidence),
			count: typeof b.count === "number" && Number.isFinite(b.count) ? Math.max(0, Math.floor(b.count)) : 0,
			t: typeof b.t === "number" && Number.isFinite(b.t) ? b.t : 0,
		};
	}
	return prune(out);
}

function clampConfidence(x: number): number {
	if (x < SPARK.confidenceFloor) return SPARK.confidenceFloor;
	if (x > 1 - SPARK.confidenceFloor) return 1 - SPARK.confidenceFloor;
	return x;
}
