/**
 * PULSE - the emotional kernel (MATE Eq. 1).
 *
 * transition : State x Event x dt -> State
 *
 * Ten deterministic steps, zero LLM calls, sub-millisecond. The state is treated as immutable:
 * every function here copies what it returns. That is what makes the kernel replayable, which is
 * what makes offline catch-up (see catchup.ts) sound.
 */

import { topicMatchesText } from "./memory.ts";
import {
	AWARENESS_DECAY,
	BOREDOM,
	BURST_W,
	CUSP,
	DRIVE_FALL,
	DRIVE_RISE,
	DYADS,
	EFFORT_W,
	EMOTION_DECAY,
	EMOTION_PAD,
	ENERGY_W,
	HABITUATION_TAU,
	INTENT_SCALE,
	KICK_ANGLE,
	MAX_OBSERVATIONS,
	META_EMOTION_DAMPING,
	MOOD,
	NUDGE_MAX,
	OPPONENT,
	TEMPORAL_WARP,
	TOKEN_CEILING,
	TRUST_DROP_CAP,
} from "./params.ts";
import {
	applyKick,
	buildHamiltonian,
	clone,
	decohere,
	evolveUnitary,
	fromEmotions,
	hermitise,
	injectCoherence,
	normalise,
	trace,
	unitaryFromH,
} from "./quantum.ts";
import { clamp, clamp01, clampPad, drawNormal, nextRandom } from "./rng.ts";
import { applyBeliefEvidence, beliefLens, decayBeliefs, seedBeliefsFor } from "./spark.ts";
import {
	type Awareness,
	type Character,
	type Drives,
	type EffortBand,
	EMOTIONS,
	type EmotionVector,
	type MateEvent,
	type MateState,
	type PAD,
	type Relationship,
	type TransitionResult,
} from "./types.ts";

/** Sum of emotion magnitudes: the event's affective intensity I_emo. */
export function intensityOf(activations: Partial<EmotionVector>): number {
	let s = 0;
	for (const e of EMOTIONS) s += Math.abs(activations[e] ?? 0);
	return s;
}

/** Zero activations. */
export function emptyEmotions(): EmotionVector {
	return { joy: 0, trust: 0, fear: 0, surprise: 0, sadness: 0, disgust: 0, anger: 0, anticipation: 0 };
}

function copyEmotions(v: EmotionVector): EmotionVector {
	return { ...v };
}

/** Step 1 - trigger: add event activations, capped at 1.
 *
 * The decay rate for sadness is modulated by the character's rumination: Verduyn & Lavrijsen (2015)
 * measured emotion durations across 27 emotions and found sadness lingers up to 240x longer than the
 * briefest ones (surprise, shame, disgust), with the two mechanisms behind the difference being how
 * important the event was and how much people REPLAY it. Replay is what this companion's rumination
 * trait measures, so it stretches the sadness clock — a ruminating companion stays sad longer than a
 * same-event one does not, without any new trigger. The ordering of the other channels follows the
 * same measurement.
 */
function triggerEmotions(
	emotions: EmotionVector,
	activations: Partial<EmotionVector>,
	dt: number,
	rumination: number,
): EmotionVector {
	const next = copyEmotions(emotions);
	// Step 2 folded in: decay by exp(-lambda*dt) before adding the new activation, so a single
	// call handles both continuous time and the event.
	for (const e of EMOTIONS) {
		const lambda = e === "sadness" ? EMOTION_DECAY[e] * (1 - 0.5 * rumination) : EMOTION_DECAY[e];
		next[e] *= Math.exp(-lambda * dt);
		const a = activations[e];
		if (a) next[e] = clamp01(next[e] + a);
	}
	return next;
}

/** Step 3 - dyad detection. Returns the names of composed complex emotions. */
export function detectDyads(emotions: EmotionVector): string[] {
	const found: string[] = [];
	for (const d of DYADS) {
		if (emotions[d.a] >= d.min && emotions[d.b] >= d.min) found.push(d.name);
	}
	return found;
}

/** Step 4 - PAD centre: emotions project onto Pleasure-Arousal-Dominance (classical, diagonal). */
export function padCentre(emotions: Partial<EmotionVector>): PAD {
	let p = 0;
	let a = 0;
	let d = 0;
	let w = 0;
	for (const e of EMOTIONS) {
		const i = emotions[e] ?? 0;
		if (i <= 0) continue;
		const proj = EMOTION_PAD[e];
		p += proj[0] * i;
		a += proj[1] * i;
		d += proj[2] * i;
		w += i;
	}
	if (w <= 0) return { p: 0, a: 0, d: 0 };
	return { p: p / w, a: a / w, d: d / w };
}

/**
 * Quantum PAD: the full expectation value <A> = Tr(rho A), where rho is the density matrix and A is
 * the PAD observable.
 *
 * With A's diagonal holding each emotion's projection X_i and off-diagonal A_ij = X_i X_j (how much
 * two emotions reinforce or compete on that axis), the trace splits into two terms:
 *   diagonal (classical):  sum_i rho_ii X_i          -- the population-weighted projection
 *   off-diagonal (quant):  sum_{i<j} 2 Re(rho_ij) X_i X_j   -- the interference / superposition term
 *
 * Both come from rho. That matters: the per-event unitary kick ROTATES POPULATIONS (a non-diagonal U
 * moves weight between diagonal entries), so the order effect shows up directly in the diagonal term,
 * not just in the coherence. Warmth-then-hostility and hostility-then-warmth leave genuinely different
 * diagonals AND different coherences. The paper reports ||dPAD||=0.48 for a strong pair; a classical
 * vector is commutative and gives exactly zero.
 *
 * `emotions` is used only as a fallback when rho carries no signal (Tr ~ 0), so a degenerate matrix
 * still yields the classical projection rather than NaN.
 */
export function padCentreFromRho(
	emotions: EmotionVector,
	rho: import("./types.ts").DensityMatrixState,
	gain = 2.2,
): PAD {
	const N = EMOTIONS.length;
	const tr = trace(rho);
	const useRho = Number.isFinite(tr) && tr > 1e-9;
	// Diagonal (classical) term.
	const base = useRho ? { p: 0, a: 0, d: 0 } : padCentre(emotions);
	if (useRho) {
		for (let i = 0; i < N; i++) {
			const w = rho[i][i][0] / tr;
			const proj = EMOTION_PAD[EMOTIONS[i]];
			base.p += w * proj[0];
			base.a += w * proj[1];
			base.d += w * proj[2];
		}
	}
	// Off-diagonal (interference) term.
	let dp = 0;
	let da = 0;
	let dd = 0;
	for (let i = 0; i < N; i++) {
		for (let j = i + 1; j < N; j++) {
			const re = useRho ? rho[i][j][0] / tr : rho[i][j][0];
			if (re === 0) continue;
			const pi = EMOTION_PAD[EMOTIONS[i]];
			const pj = EMOTION_PAD[EMOTIONS[j]];
			dp += 2 * re * (pi[0] * pj[0]);
			da += 2 * re * (pi[1] * pj[1]);
			dd += 2 * re * (pi[2] * pj[2]);
		}
	}
	return {
		p: clampPad(base.p + clamp(dp * gain, -0.5, 0.5)),
		a: clampPad(base.a + clamp(da * gain, -0.5, 0.5)),
		d: clampPad(base.d + clamp(dd * gain, -0.5, 0.5)),
	};
}

/** Personality's default PAD - the home the O-U process pulls toward. */
export function personalityBaseline(state: MateState): PAD {
	const { o, e, n } = state.personality;
	const shift = state.allostasis.baselineShift;
	return {
		p: clampPad(0.15 * (e - 0.5) + 0.2 * (1 - n) - 0.1 + 0.3 * state.character.optimismBias + shift.p),
		a: clampPad(0.2 * (e - 0.5) - 0.1 * (o - 0.5) + shift.a),
		d: clampPad(0.15 * (state.character.assertiveness - 0.5) * 2 + 0.1 * (1 - n) + shift.d),
	};
}

/**
 * Step 5 - mood update, Ornstein-Uhlenbeck.
 *
 *   dM = alpha (E_centre - M) dt + beta (P_default - M) dt + sigma dW
 *
 * Integrated exactly over dt rather than with an Euler step (see catchup.ts for why):
 * with kappa = alpha + beta and theta = (alpha*E + beta*P)/kappa,
 *   M(dt) = theta + (M0 - theta) * exp(-kappa*dt)
 * This is stable for arbitrarily large dt, which is the whole point.
 */
export function updateMood(
	mood: PAD,
	centre: PAD,
	baseline: PAD,
	dt: number,
	seed: number,
): { mood: PAD; seed: number } {
	const kappa = MOOD.alpha + MOOD.beta;
	const decay = Math.exp(-kappa * dt);
	// Exact O-U stochastic increment: Var = sigma^2/(2 kappa) * (1 - exp(-2 kappa dt)).
	// This SATURATES at the stationary variance sigma^2/(2 kappa) as dt grows, which is what makes
	// a one-week jump statistically identical to 10,080 sixty-second ticks. The naive sigma*sqrt(dt)
	// grows without bound and would let a long offline gap inject an absurd mood swing.
	const stationaryVar = (MOOD.sigma * MOOD.sigma) / (2 * kappa);
	const noiseAmp = Math.sqrt(stationaryVar * (1 - decay * decay));
	let s = seed;
	const out = {} as PAD;
	for (const k of ["p", "a", "d"] as const) {
		const theta = (MOOD.alpha * centre[k] + MOOD.beta * baseline[k]) / kappa;
		const n = drawNormal(s, noiseAmp);
		s = n.seed;
		// Clamp to 3 sd so a pathological draw cannot escape [-1,1] after the mean-reversion term.
		const bounded = clamp(n.value, -3 * noiseAmp - 1e-9, 3 * noiseAmp + 1e-9);
		out[k] = clampPad(theta + (mood[k] - theta) * decay + bounded);
	}
	return { mood: out, seed: s };
}

/**
 * How much one verdict of the judge counts for the relationship. An appraisal event stands for a whole
 * stretch of exchange (the messages since the last verdict), so it moves trust/attachment/familiarity
 * at the scale of about ten warm contacts, not one. The judge is rate-limited by its own cooldown, so
 * this cannot compound into a fast lane past weeks of ordinary conversation.
 */
const APPRAISAL_REL_WEIGHT = 10;

/**
 * Step 6 - relationship update.
 *
 * The functional shapes are the attachment literature's: trust builds slowly and by consistency,
 * not by single episodes (Rempel, Holmes & Zanna 1985's stages; the baseline pull models that a
 * relationship relaxes toward what repeated experience has made of it), frustration is the anxious
 * attachment system's protest when contact is wanted and absent (Bowlby 1969; Ainsworth et al.
 * 1978), and familiarity accrues with mere repeated contact.
 */
function updateRelationship(
	rel: Relationship,
	character: Character,
	centre: PAD,
	event: MateEvent,
	dt: number,
): Relationship {
	const i = intensityOf(event.activations);
	const next: Relationship = { ...rel };

	// Trust drifts toward the character baseline at a slow exponential rate, then is perturbed
	// by the event's valence. The drop is capped per event.
	const baseline = character.trustBaseline;
	next.trust = next.trust + (baseline - next.trust) * (1 - Math.exp(-dt / (30 * 86_400_000)));
	// Contact grows the relationship. An APPRAISAL — the judge's verdict on a whole stretch of exchange
	// — grows it once for the whole stretch it stands for, not once per message, because by then the
	// messages themselves are already counted.
	if (event.kind === "user_message" || event.kind === "appraisal") {
		const w = event.kind === "appraisal" ? APPRAISAL_REL_WEIGHT : 1;
		// Warmth earns trust slowly, and the more trust there already is, the smaller the next
		// increment: an afternoon of chat moves it a little; weeks of consistency move it a lot.
		const delta = 0.004 * centre.p * i * (1 - 0.5 * next.trust) * w;
		next.trust = clamp01(
			delta < 0 ? Math.max(next.trust + delta, next.trust * (1 - TRUST_DROP_CAP)) : next.trust + delta,
		);
		// Attachment grows with repeated positive contact, Hebbian-style.
		next.attachment = clamp01(next.attachment + (0.004 * Math.max(0, centre.p) * i + 0.0006) * w);
		next.familiarity = clamp01(next.familiarity + 0.002 * w);
		// Respect responds to depth and to being taken seriously (task intent).
		next.respect = clamp01(
			next.respect + (event.intent === "task" ? 0.003 : 0.001) * Math.max(0, centre.p + 0.3) * w,
		);
	}

	// Frustration: rises when we want contact and get none, falls on warm exchange.
	const want = character.attachmentAnxiety * (1 - next.attachment);
	next.frustration = clamp01(
		next.frustration + (dt / (2 * 3_600_000)) * want * 0.5 - (centre.p > 0.3 && i > 0.4 ? 0.05 : 0),
	);

	// Unanswered messages decay slowly - we do not hold a grudge forever.
	if (event.kind === "user_message" && next.unanswered > 0) next.unanswered = Math.max(0, next.unanswered - 1);
	return next;
}

/** Step 7 - cusp catastrophe: a phase transition when dominance collapses under high arousal. */
function checkCusp(state: MateState, mood: PAD): boolean {
	if (state.catastrophe) {
		// Released once arousal falls back below the fold.
		return mood.a >= CUSP.arousalMin * 0.6 && mood.d <= CUSP.dominanceMax;
	}
	return mood.d <= CUSP.dominanceMax && mood.a >= CUSP.arousalMin;
}

/**
 * Step 8 - character micro-nudge.
 *
 * Chronic affect shifts disposition: sustained negative affect is what the negative-affectivity
 * trait IS (Watson & Clark 1984), and traits do move over the lifespan under accumulated experience
 * (Roberts & Mroczek 2008). The kernel applies that at companion timescale — trait drift is the
 * shadow of the affect that keeps recurring.
 *
 * delta = delta_base * I_emo * r, with r = 1 + (1 - trust). Early interactions therefore carry
 * up to 1.9x the weight of established ones: a critical-period effect.
 *
 * Updates are pushed through a logistic saturation so traits compress near their bounds and never
 * actually reach 0 or 1 - after 1000 positive messages self_worth settles near 0.91, not 1.0.
 */
function softUpdate(trait: number, delta: number, lo = 0, hi = 1): number {
	const span = hi - lo;
	const x = (trait - lo) / span; // 0..1
	// Full delta at centre, tapering to zero at both ends.
	const gate = 4 * x * (1 - x);
	return clamp(trait + delta * gate, lo, hi);
}

/**
 * The traits `nudgeCharacter` actually moves. This list is the single source of truth for what
 * "character" means in the projections (see context.topTraits): the trait block in the stable prefix
 * exists to show what experience has SHAPED, and rendering a trait nothing ever writes shows a
 * constant dressed up as a personality. The other traits in `Character` are fixed parameters — they
 * modulate the kernel (tolerance stretches perceived silence, impulsivity scales the proactive
 * budget) but never drift, and their effects are already visible in the numbers those systems emit.
 */
export const DRIFTING_TRAITS: ReadonlyArray<keyof Character> = [
	"selfWorth",
	"selfEfficacy",
	"warmth",
	"trustBaseline",
	"attachmentAnxiety",
	"vulnerability",
	"rumination",
	"vitality",
	"directness",
	"empathy",
	"curiosity",
];

function nudgeCharacter(character: Character, centre: PAD, event: MateEvent, rel: Relationship): Character {
	const next: Character = { ...character };
	if (event.kind !== "user_message" && event.kind !== "proactive" && event.kind !== "appraisal") return next;

	const iemo = Math.min(intensityOf(event.activations), 2);
	if (iemo <= 0.02) return next; // a neutral greeting produces zero drift
	const r = 1 + (1 - rel.trust);
	const scale = NUDGE_MAX * iemo * r;
	const pos = clampPad(centre.p);

	next.selfWorth = softUpdate(next.selfWorth, scale * 0.5 * pos);
	next.selfEfficacy = softUpdate(next.selfEfficacy, scale * 0.35 * (event.intent === "task" ? pos + 0.3 : pos));
	next.warmth = softUpdate(next.warmth, scale * 0.3 * pos);
	next.trustBaseline = softUpdate(next.trustBaseline, scale * 0.2 * pos);
	next.attachmentAnxiety = softUpdate(next.attachmentAnxiety, -scale * 0.25 * pos);
	next.vulnerability = softUpdate(next.vulnerability, scale * 0.2 * (pos < 0 ? -pos * 0.5 : -0.2));
	next.rumination = softUpdate(next.rumination, scale * 0.15 * (pos < 0 ? 1 : -0.5));
	next.vitality = softUpdate(next.vitality, scale * 0.2 * pos);
	next.directness = softUpdate(next.directness, scale * 0.1 * (rel.trust - 0.5) * 2);
	next.empathy = softUpdate(next.empathy, scale * 0.15 * Math.abs(pos));
	next.curiosity = softUpdate(next.curiosity, scale * 0.1 * (event.activations.surprise ?? 0));
	next.optimismBias = softUpdate(next.optimismBias, scale * 0.2 * pos, -0.3, 0.3);
	return next;
}

/** Step 9 - opponent process: the B-state counter-swing (Solomon & Corbit). */
function updateOpponent(opponent: EmotionVector, emotions: EmotionVector, dt: number): EmotionVector {
	const next = copyEmotions(opponent);
	const decay = Math.exp(-OPPONENT.kb * dt);
	for (const e of EMOTIONS) {
		// B rises proportionally to the A-process, and decays on its own slow clock.
		next[e] = clamp01(next[e] * decay + OPPONENT.ka * emotions[e] * (1 - Math.exp(-dt / (30 * 60_000))));
	}
	return next;
}

/** Net felt emotion after the opponent-process counter-swing (Solomon & Corbit 1974).
 *
 * The B-process attenuates its own channel — repeated joy lands with less force, the tolerance half
 * of the theory — and because the B-process outlasts the A-process, whatever it subtracts re-emerges
 * on the channel's wheel antipode: the come-down after a burst of joy is a low-grade sadness, the
 * residue of sustained grief is relief. The subtraction therefore never vanishes; it flips to the
 * antipode, the same geometry the judge uses to route a negative reading. Without the transfer the
 * opponent would model tolerance only; with it, the theory's signature hedonic aftereffect appears.
 */
export function netEmotions(emotions: EmotionVector, opponent: EmotionVector): EmotionVector {
	const out = emptyEmotions();
	for (let i = 0; i < EMOTIONS.length; i++) {
		const e = EMOTIONS[i];
		const net = emotions[e] - OPPONENT.gain * opponent[e];
		out[e] += Math.max(0, net);
		// A net pushed below zero IS the aftereffect: it re-enters as the antipode rather than being
		// clamped away, so the state stays non-negative without discarding the feeling.
		if (net < 0) out[EMOTIONS[(i + 4) % EMOTIONS.length]] += -net;
	}
	for (const e of EMOTIONS) out[e] = clamp01(out[e]);
	return out;
}

/** Drives: rise while unmet, fall when satisfied. Connection accelerates under anxious attachment. */
export function updateDrives(
	drives: Drives,
	character: Character,
	dt: number,
	satisfied: Partial<Record<keyof Drives, number>>,
): Drives {
	const next: Drives = { ...drives };
	const anxious = character.attachmentAnxiety > 0.4 ? 1 + (character.attachmentAnxiety - 0.4) * 2 : 1;
	for (const k of Object.keys(DRIVE_RISE) as Array<keyof Drives>) {
		const rate = DRIVE_RISE[k] * (k === "connection" ? anxious : 1);
		const rise = (1 - next[k]) * (1 - Math.exp(-rate * dt));
		const fall = (satisfied[k] ?? 0) * (1 - Math.exp(-DRIVE_FALL * dt));
		next[k] = clamp01(next[k] + rise - fall);
	}
	return next;
}

/** Awareness field update. social_pressure goes negative under prolonged silence = impulse to reach out. */
export function updateAwareness(aw: Awareness, state: MateState, dt: number, contact: boolean): Awareness {
	const next: Awareness = { ...aw };
	const n = state.personality.n;
	const o = state.personality.o;

	// user_presence decays; neuroticism slows the decay (anxious personalities feel absence acutely).
	const presenceRate = AWARENESS_DECAY.userPresence * (1 - 0.4 * n);
	if (contact) next.userPresence = clamp01(Math.max(next.userPresence, 0.9));
	else next.userPresence = clamp01(next.userPresence * Math.exp(-presenceRate * dt));

	// social_pressure: released by TIME. Prolonged silence pushes it negative -> impulse to initiate.
	// This is the mechanism that makes proactive contact emergent rather than scheduled.
	// Written as an exponential approach toward a character-derived asymptote so it is
	// subdivision-invariant: one long jump and many short ticks land on the same value.
	if (contact) {
		next.socialPressure = clampPad(next.socialPressure * 0.4 + 0.5);
	} else {
		const asymptote = -(0.4 + 0.4 * (1 - state.character.tolerance));
		const k = 1 - Math.exp(-AWARENESS_DECAY.socialPressure * dt);
		next.socialPressure = clampPad(next.socialPressure + (asymptote - next.socialPressure) * k);
	}

	// thought_saturation: openness tolerates repetition longer.
	next.thoughtSaturation = clamp01(
		next.thoughtSaturation * Math.exp(-(AWARENESS_DECAY.thoughtSaturation * (1 + 0.6 * o)) * dt),
	);
	return next;
}

/**
 * Subjective time (Eq. 13).
 *
 *   t_perceived = t_actual * (1 + anxiety*1.5) * (1 - tolerance*0.4) * (1 - p*0.3) * (1 + N*0.5)
 *
 * Emotion distorts prospective duration in measured directions: high-arousal negative states
 * overestimate it, positive states compress it (Droit-Volet & Meck 2007). The same six hours of
 * silence feel like 16.4h to an anxiously attached character and 4.9h to a secure one. This is what
 * makes "you were gone forever" an honest report rather than a script.
 */
export function perceivedDuration(state: MateState, actualMs: number): number {
	const w = TEMPORAL_WARP;
	const anxiety = state.character.attachmentAnxiety;
	return (
		actualMs *
		(1 + anxiety * w.anxiety) *
		(1 - state.character.tolerance * w.tolerance) *
		(1 - clampPad(state.mood.p) * w.pleasure) *
		(1 + state.personality.n * w.neuroticism)
	);
}

/** Temporal mood label, from the subjective gap. */
export function temporalMood(perceivedMs: number): "just_now" | "recent" | "a_while" | "long" | "eternity" {
	const m = perceivedMs / 60_000;
	if (m < 5) return "just_now";
	if (m < 60) return "recent";
	if (m < 360) return "a_while";
	if (m < 1440) return "long";
	return "eternity";
}

/** Effort model (Eq. 2) -> band -> token ceiling. This is the primary cost lever. */
export function effortOf(
	state: MateState,
	seed: number,
	intent: MateEvent["intent"],
): { band: EffortBand; ceiling: number; effort: number; seed: number } {
	const w = EFFORT_W;
	// Fatigue-adjusted arousal.
	const aeff = clampPad(state.mood.a * (1 - 0.6 * state.allostasis.fatigue));
	const comfort = (state.relationship.trust + state.relationship.attachment) / 2;
	const noise = drawNormal(seed, w.noise);
	let effort =
		w.arousal * aeff +
		w.comfort * comfort +
		w.conscientiousness * state.personality.c +
		w.extraversion * state.personality.e +
		w.reflectiveness * state.character.reflectiveness +
		w.selfEfficacy * state.character.selfEfficacy +
		w.bias +
		noise.value;

	// Nonlinear collapse: below 0.25 self_worth, effort falls off a cliff.
	if (state.character.selfWorth < 0.25) effort *= 0.4 + state.character.selfWorth * 2;
	effort = clamp01((effort + 1) / 2);

	let band: EffortBand;
	if (effort < 0.28) band = "autopilot";
	else if (effort < 0.48) band = "brief";
	else if (effort < 0.68) band = "normal";
	else band = "engaged";

	const ceiling = Math.round(TOKEN_CEILING[band] * (INTENT_SCALE[intent] ?? 1));
	return { band, ceiling, effort, seed: noise.seed };
}

/** Communication energy (Eq. 12): decides whether one message or several. */
export function energyOf(state: MateState): number {
	const w = ENERGY_W;
	return clamp01(
		w.arousal * ((state.mood.a + 1) / 2) +
			w.extraversion * state.personality.e +
			w.pleasure * ((state.mood.p + 1) / 2) +
			w.attachment * state.relationship.attachment +
			w.depth * state.character.depthPreference,
	);
}

/** Send style (Eq. 14): high burst fragments into rapid short messages. */
export function burstOf(state: MateState): number {
	const w = BURST_W;
	return clamp01(
		w.extraversion * state.personality.e +
			w.reflectiveness * (1 - state.character.reflectiveness) +
			w.arousal * Math.abs(state.mood.a) +
			w.trust * state.relationship.trust +
			w.directness * state.character.directness,
	);
}

/**
 * Mean saturation of the recent topic-habituation traces, time-decayed. A topic thought about over
 * and over saturates (predictable); a fresh topic reads 0. Empty history reads 0 — a new companion
 * has no stale topics yet.
 */
export function topicSaturation(state: MateState, now: number): number {
	const entries = Object.values(state.habituation);
	if (entries.length === 0) return 0;
	let sum = 0;
	for (const h of entries) {
		const age = Math.max(0, now - h.t);
		sum += clamp01(h.s * Math.exp(-age / (2 * HABITUATION_TAU)));
	}
	return clamp01(sum / entries.length);
}

/**
 * Predictability: how much of the recent past has played out exactly as expected. Two signal
 * sources, per the boredom literature: low recent surprise (Schmidhuber's "nothing new to compress";
 * Darling's persistently-low prediction error) and saturated topic habituation (same subjects
 * circling). SPARK meshes with this automatically — confirmed beliefs mean unsurprising events, so a
 * well-predicted world is a boring world without any extra wiring.
 */
export function predictabilityOf(state: MateState, now: number): number {
	const surpriseNorm = clamp01(state.surpriseEma / BOREDOM.surpriseScale);
	return clamp01(BOREDOM.surpriseWeight * (1 - surpriseNorm) + BOREDOM.topicWeight * topicSaturation(state, now));
}

/**
 * Boredom, DERIVED (see the Drives docstring in types.ts for why it is not a stored drive):
 *
 *   boredom = predictability × (1 − thoughtSaturation) × (0.4 + 0.6·extraversion) × idleGate
 *
 * The idle gate is the single homeostatic ingredient (Yu et al. 2019's information-intake deficit):
 * it ramps with silence and drops on contact. Genuine novelty suppresses boredom through the
 * surprise term instead — a mundane "ok" relieves almost nothing, which is exactly the behaviour the
 * old `satisfied.boredom` contact hack got wrong. `now` is injectable so the kernel stays pure.
 */
export function boredomOf(state: MateState, now: number): number {
	const silence = Math.max(0, now - state.lastInteraction);
	const idleGate = 1 - Math.exp(-silence / BOREDOM.idleTau);
	const predictability = predictabilityOf(state, now);
	return clamp01(
		predictability * (1 - state.awareness.thoughtSaturation) * (0.4 + 0.6 * state.personality.e) * idleGate,
	);
}

/** Drive-delta notice threshold: theta_notice = 0.20 - N*0.10. */
export function noticeThreshold(neuroticism: number): number {
	return 0.2 - neuroticism * 0.1;
}

/** Meta-emotion: intensity of an emotion about an emotion, damped by depth I_d = 0.3^d. */
export function metaEmotionIntensity(base: number, depth: number): number {
	return clamp01(base * META_EMOTION_DAMPING ** depth);
}

/**
 * Allostatic load: fatigue accumulates with cognitive work and sustained arousal, recovers in
 * quiet and after sleep. Allostasis itself — stability through change, with chronic conditions
 * shifting the set point rather than just the reading — is Sterling & Eyer (1988) / McEwen & Stellar
 * (1993); the baselineShift term is that set-point movement, the hedonic-adaptation result (Frederick
 * & Loewenstein 1999) applied to the companion's mood baseline.
 *
 * Every term is an analytic exponential approach, not a linear accumulator. That is deliberate: it
 * makes fatigue subdivision-invariant, so catch-up's single big jump lands on exactly the value a
 * continuously-running heartbeat would have produced. A `rate * dt` accumulator would drift with
 * the number of steps and silently break reproducibility on long gaps.
 */
export function updateAllostasis(state: MateState, dt: number, work: number): MateState["allostasis"] {
	const a = { ...state.allostasis, baselineShift: { ...state.allostasis.baselineShift } };
	// Load: exponential decay plus this event's impulse.
	a.load = clamp01(a.load * Math.exp(-dt / (2 * 3_600_000)) + work);
	// Fatigue approaches a target set by current load and sustained arousal, on a ~6h clock.
	const arousalLoad = Math.max(0, state.mood.a) * 0.5;
	const target = clamp01(a.load * 0.6 + arousalLoad * 0.4);
	const k = 1 - Math.exp(-dt / (6 * 3_600_000));
	a.fatigue = clamp01(a.fatigue + (target - a.fatigue) * k);
	// Baseline drifts very slowly toward the recent average mood: allostasis is what makes
	// a chronically stressed companion stay stressed, and a well-treated one stay warm.
	const kb = 1 - Math.exp(-dt / (14 * 86_400_000));
	a.baselineShift.p = clampPad(a.baselineShift.p + (state.mood.p * 0.25 - a.baselineShift.p) * kb);
	a.baselineShift.a = clampPad(a.baselineShift.a + (state.mood.a * 0.15 - a.baselineShift.a) * kb);
	a.baselineShift.d = clampPad(a.baselineShift.d + (state.mood.d * 0.15 - a.baselineShift.d) * kb);
	return a;
}

/** Push a self-observation onto the bounded ring buffer. */
export function addObservation(state: MateState, text: string): string[] {
	const obs = [...state.observations, text];
	while (obs.length > MAX_OBSERVATIONS) obs.shift();
	return obs;
}

/**
 * The kernel. Steps 1-10 of Eq. 1.
 *
 * `dt` is the time since `state.t`. It may be milliseconds or weeks: every time-dependent term
 * here is written in closed exponential form, so a single call over a large dt is correct and
 * cheap. That is the property catchup.ts exploits.
 */
export function transition(state: MateState, event: MateEvent, dtOverride?: number): TransitionResult {
	const dt = Math.max(0, dtOverride ?? event.t - state.t);
	// The narrowed contact kind, for the SPARK block; null for ticks/sleep/wake/self-observation.
	// `appraisal` counts as contact: it carries affect, so it kicks the state, moves the relationship
	// and bears belief evidence. It is NOT presence — nobody just showed up, so the awareness terms
	// (which model "the user is here right now") stay off, and no drive is satisfied by it.
	const contactKind: "user_message" | "proactive" | "appraisal" | null =
		event.kind === "user_message" || event.kind === "proactive" || event.kind === "appraisal" ? event.kind : null;
	const contact = contactKind !== null;
	const presence = event.kind === "user_message" || event.kind === "proactive";

	// Self-prediction (Friston): forward-simulate before we move, so we can measure surprise after.
	const predictedCentre = padCentreFromRho(state.emotions, state.rho);

	// 1 + 2: decay then trigger.
	const emotions = triggerEmotions(state.emotions, event.activations, dt, state.character.rumination);

	// 3: dyads.
	const dyads = detectDyads(emotions);

	// Opponent process (step 9), computed early because the classical net emotions seed the matrix.
	const opponent = updateOpponent(state.opponent, emotions, dt);
	const net = netEmotions(emotions, opponent);

	// Density matrix, computed BEFORE the PAD centre so that superposition and order effects can
	// actually influence mood. Order of operations matters and is deliberate:
	//   (a) FREE evolution: diagonal unitary precession over dt plus Lindblad dephasing. Both are
	//       elementwise (O(64)) and run on every transition, including catch-up ticks. The dephasing
	//       rate is modulated by the PREVIOUS mood's arousal (not this step's), which breaks the
	//       rho <-> mood circularity and is physically apt: how fast you commit reflects the arousal
	//       you brought INTO the event.
	//   (b) the diagonal relaxes toward the classical net-emotion distribution, so the matrix tracks
	//       magnitude while the coherences carry history the vector cannot express.
	//   (c) fresh coherence is injected for a contact event, so two co-active emotions enter genuine
	//       superposition (a classical vector cannot represent this).
	//   (d) THE KICK, applied LAST: a NON-diagonal Hamiltonian built from this event's activations
	//       rotates the whole state by a fixed angle (KICK_ANGLE, intensity-scaled, NOT dt-scaled) via
	//       rho -> U rho U^dagger. It must come after the diagonal/coherence are set, because a unitary
	//       ROTATES POPULATIONS - if it ran first, step (b) would overwrite the very transfer that
	//       carries the order effect. Because U depends on WHICH emotions this event triggered, and
	//       non-diagonal matrices do not commute, warmth-then-hostility != hostility-then-warmth in the
	//       diagonal as well as the off-diagonal. That is the paper's order effect (||dPAD||=0.48); a
	//       diagonal H could never produce it, and neither could kicking before the populations settle.
	let seed = state.seed;
	const intensities = EMOTIONS.map((e) => net[e]);
	const arousalMod = 0.6 + Math.max(0, state.mood.a) * 1.2;
	let rho = decohere(evolveUnitary(clone(state.rho), dt, intensities), dt, arousalMod);
	// (b) diagonal relaxation toward net.
	const totalEmotion = EMOTIONS.reduce((a, e) => a + net[e], 0);
	if (totalEmotion > 0) {
		const k = 1 - Math.exp(-dt / (30 * 60_000));
		for (let i = 0; i < EMOTIONS.length; i++) {
			const target = net[EMOTIONS[i]] / totalEmotion;
			rho[i][i][0] += (target - rho[i][i][0]) * k;
		}
	}
	if (contact) {
		const iemo = Math.min(intensityOf(event.activations), 2);
		// (c) fresh coherence between co-active emotions.
		const strength = clamp01(iemo / 1.5);
		rho = injectCoherence(rho, net, seed, strength);
		// (d) THE KICK: fixed-angle unitary rotation under a non-diagonal H. Per-EVENT, not dt-scaled,
		// so two messages one second apart get the same order effect as two a day apart.
		const theta = KICK_ANGLE * clamp01(iemo / 2);
		if (theta > 1e-6) {
			const H = buildHamiltonian(event.activations, state.personality.o, state.relationship.trust);
			applyKick(rho, unitaryFromH(H, theta));
		}
	}
	hermitise(rho);
	normalise(rho);

	// 4: PAD centre as a quantum expectation value Tr(rho A). The diagonal term is the classical
	// projection; the off-diagonal term is the interference that carries the order effect. This is
	// what makes the density matrix functional rather than decorative.
	let centre = padCentreFromRho(net, rho);

	// SPARK (section 3.9): beliefs modulate perception, and the coloured perception feeds back as
	// evidence. The lens biases the event's valence by Eq. 24, applied in the CONFIRMATORY direction:
	// evidence that agrees with the belief's orientation is amplified, conflicting evidence is
	// dampened (the literal multiplication in the paper would amplify disconfirming evidence, which
	// contradicts both the confirmation-bias framing and the loop's stability). The shift lands on
	// the PAD centre that drives mood and relationship (perception as experienced), and the perceived
	// value is what the beliefs then learn from — that circularity is the autopoietic loop, bounded
	// by dsanity. Precariousness runs on every transition: confidence relaxes toward the floor
	// without evidence.
	let beliefs = decayBeliefs(state.beliefs, dt);
	// Topics arrive two ways, both deliberate: model-named topics ride remember/ponder events
	// (event.topics) and crystallise into new beliefs; on contact events, existing topic beliefs bear
	// evidence when their subject literally appears in the message text — topic matching is a
	// word/substring check (see memory.topicMatchesText), no tokeniser involved. Seed beliefs always
	// bear on contact (they are priors about the interlocutor and the world, not about a subject).
	// The overall cap keeps one event from spraying the store.
	const eventTopics = (event.topics ?? []).slice(0, 4);
	if (contactKind !== null || eventTopics.length > 0) {
		const evidence = padCentre(event.activations).p;
		const text = event.text;
		const touched =
			contactKind !== null && text
				? Object.values(beliefs)
						.filter((b) => topicMatchesText(b.key, text))
						.map((b) => b.key)
				: [];
		const topics = [...new Set([...touched, ...eventTopics])].slice(0, 4);
		const seedKeys = contactKind !== null ? seedBeliefsFor(contactKind) : [];
		const applying = Object.values(beliefs).filter((b) => seedKeys.includes(b.key) || topics.includes(b.key));
		const lens = beliefLens(beliefs, applying);
		const perceived = lens ? clampPad(evidence * (1 + Math.sign(evidence) * lens.bias)) : evidence;
		if (lens) centre = { ...centre, p: clampPad(centre.p + (perceived - evidence)) };
		beliefs = applyBeliefEvidence(beliefs, { perceived, topics }, event.t);
	}

	// 5: mood, O-U, exact integration.
	const moodRes = updateMood(state.mood, centre, personalityBaseline(state), dt, seed);
	const mood = moodRes.mood;
	seed = moodRes.seed;

	// 6: relationship.
	const relationship = updateRelationship(state.relationship, state.character, centre, event, dt);

	// 8: character micro-nudge (before the cusp check so the check sees the new traits).
	const character = nudgeCharacter(state.character, centre, event, relationship);

	// Drives + awareness + allostasis: the continuous background physiology.
	const satisfied: Partial<Record<keyof Drives, number>> = {};
	if (event.kind === "user_message") {
		satisfied.connection = 0.8;
		satisfied.expression = 0.4;
	} else if (event.kind === "proactive") {
		satisfied.expression = 0.9;
		satisfied.connection = 0.25;
	} else if (event.kind === "sleep") {
		satisfied.rest = 1;
		satisfied.growth = 0.3;
	}
	const drives = updateDrives(state.drives, character, dt, satisfied);
	const awareness = updateAwareness(state.awareness, { ...state, character }, dt, presence);

	const work = contact ? 0.15 + Math.min(intensityOf(event.activations), 1.5) * 0.1 : 0;
	const allostasis = updateAllostasis({ ...state, mood, character }, dt, work);

	// 7: cusp catastrophe.
	const preState: MateState = {
		...state,
		mood,
		character,
		relationship,
		drives,
		beliefs,
		awareness,
		allostasis,
		opponent,
		rho,
		seed,
	};
	const catastrophe = checkCusp(state, mood);
	if (catastrophe && !state.catastrophe) {
		// Phase transition: a sharp dominance collapse. Bounded, so it cannot run away.
		mood.d = clampPad(mood.d - 0.25);
		mood.a = clampPad(mood.a * 0.7);
	}

	// Surprise: how far the actual centre moved from what we predicted.
	const surprise = Math.hypot(
		centre.p - predictedCentre.p,
		centre.a - predictedCentre.a,
		centre.d - predictedCentre.d,
	);

	// Surprise EMA, exact closed form so catch-up stays subdivision-invariant. This is the raw
	// material of the derived boredom signal: recent events playing out as predicted (low EMA) is
	// precisely what "nothing new to compress" means in Schmidhuber's formalism.
	const surpriseDecay = Math.exp(-dt / BOREDOM.surpriseTau);
	const surpriseEma = state.surpriseEma * surpriseDecay + surprise * (1 - surpriseDecay);

	const counters = { ...state.counters };
	counters.transitions += 1;
	if (event.kind === "user_message") counters.messages += 1;

	let observations = state.observations;
	if (event.kind === "self_observation" && event.text) {
		observations = addObservation(state, event.text);
		counters.observations += 1;
	}

	// Advance the seed with one cheap draw so repeated identical events still diverge slightly.
	const r = nextRandom(seed);
	seed = r.seed;

	const nextState: MateState = {
		...preState,
		version: state.version,
		t: event.t,
		lastInteraction: contact ? event.t : state.lastInteraction,
		lastHeartbeat: event.t,
		emotions,
		opponent,
		mood,
		character,
		relationship,
		drives,
		awareness,
		allostasis,
		rho,
		observations,
		counters,
		catastrophe,
		surpriseEma,
		seed,
	};

	const eff = effortOf(nextState, seed, event.intent);
	nextState.seed = eff.seed;

	return { state: nextState, effort: eff.band, tokenCeiling: eff.ceiling, dyads, surprise };
}

/**
 * Sleep consolidation's affective half: mood recovers toward baseline, fatigue resets.
 *
 * The paper runs this nightly at 1-5 AM on a box that never powers off. Here it is also called
 * retroactively by the catch-up engine for every sleep window crossed while the machine was off,
 * so a companion that slept through three nights wakes having actually processed them.
 */
export function sleepTransition(state: MateState, t: number): MateState {
	const baseline = personalityBaseline(state);
	const emotions = emptyEmotions();
	// Emotions are dampened, not erased: residue of the day survives into the next morning.
	for (const e of EMOTIONS) emotions[e] = state.emotions[e] * 0.25;
	const mood: PAD = {
		p: clampPad(state.mood.p + (baseline.p - state.mood.p) * 0.7),
		a: clampPad(state.mood.a + (baseline.a - state.mood.a) * 0.8),
		d: clampPad(state.mood.d + (baseline.d - state.mood.d) * 0.6),
	};
	return {
		...state,
		emotions,
		mood,
		allostasis: { ...state.allostasis, fatigue: clamp01(state.allostasis.fatigue * 0.15), load: 0 },
		drives: {
			...state.drives,
			rest: 0,
			connection: clamp01(state.drives.connection * 0.85),
		},
		opponent: emptyEmotions(),
		catastrophe: false,
		t,
		lastHeartbeat: t,
		counters: { ...state.counters, sleepCycles: state.counters.sleepCycles + 1 },
		rho: fromEmotions(emotions, state.seed),
	};
}
