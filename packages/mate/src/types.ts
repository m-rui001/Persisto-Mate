/**
 * MATE kernel types.
 *
 * Reference: Lobozov, S. "MATE: A Deterministic Affective Middleware for LLM-Based Companions
 * with Emergent Character and Persistent Internal State", v8, Zenodo 20400530 (CC-BY-4.0).
 *
 * The kernel is a pure function transition(state, event, dt) -> state with zero LLM calls.
 * Every value below is bounded: emotions in [0,1], PAD components in [-1,1], traits in [0,1].
 */

/** The 8 Plutchik primary emotions, in the fixed order used by the density matrix. */
export const EMOTIONS = ["joy", "trust", "fear", "surprise", "sadness", "disgust", "anger", "anticipation"] as const;

export type Emotion = (typeof EMOTIONS)[number];
export type EmotionVector = Record<Emotion, number>;

/** Pleasure-Arousal-Dominance, each component in [-1, +1]. */
export interface PAD {
	p: number;
	a: number;
	d: number;
}

/** Big Five personality, each dimension in [0, 1]. Fixed per message; drifts weekly only. */
export interface Personality {
	o: number; // openness
	c: number; // conscientiousness
	e: number; // extraversion
	a: number; // agreeableness
	n: number; // neuroticism
}

/**
 * The character system (SOUL). All traits in [0,1] except optimismBias in [-0.3,+0.3].
 * Traits are the slowly-moving layer: personality is nature, character is nurture.
 *
 * This list is exactly the set of traits the kernel READS or WRITES, and it used to be 30 long. The
 * paper names thirty; thirteen of them (humor, loyalty, ambition, playfulness, tenderness, frugality,
 * …) arrived here as a birth default, a Chinese gloss and a prompt slot that nothing ever read or
 * wrote — a constant dressed up as nurture. Deleting them is the rule this codebase should apply to
 * every field: a trait earns its place by having a read or a write.
 */
export interface Character {
	selfWorth: number;
	selfEfficacy: number;
	optimismBias: number;
	trustBaseline: number;
	attachmentAnxiety: number;
	reflectiveness: number;
	directness: number;
	depthPreference: number;
	warmth: number;
	vitality: number;
	curiosity: number;
	tolerance: number; // patience with silence
	impulsivity: number;
	rumination: number;
	vulnerability: number;
	assertiveness: number;
	empathy: number;
}

export type TraitName = keyof Character;

/** Relationship tensor toward the single interlocutor. */
export interface Relationship {
	trust: number;
	attachment: number;
	respect: number;
	frustration: number;
	familiarity: number;
	unanswered: number; // consecutive messages we chose not to answer
}

/**
 * Homeostatic drives. Rise when unmet, decay when satisfied. All in [0,1].
 *
 * Boredom is deliberately NOT stored here. The literature is consistent that boredom should not be
 * modelled as a homeostatic drive that accumulates and is discharged by contact (Schmidhuber's
 * learning-progress formalism, Darling's predictive-processing account, Yu et al.'s information-intake
 * homeostasis all point the same way): it is a DERIVED signal — predictability high, nothing new to
 * compress — computed by `boredomOf()` in kernel.ts from the surprise EMA, topic habituation,
 * thought saturation, extraversion and an idle gate. A mundane message then relieves nothing, while
 * genuine novelty collapses it instantly.
 */
export interface Drives {
	connection: number;
	curiosity: number;
	expression: number;
	growth: number;
	rest: number;
}

/**
 * A SPARK belief (MATE section 3.9, the cognitive autopoietic loop).
 *
 * Beliefs are persistent evaluative structures the system builds from its own experience. Two loops
 * close through them: beliefs modulate how incoming evidence is perceived (Eq. 24 in params.SPARK),
 * and perceived evidence updates the beliefs — so the system's own activity reshapes the input that
 * generates the next state. All fields are bounded and every update is deterministic.
 */
export interface Belief {
	/** Stable key. Seed beliefs use fixed names; topic beliefs use model-named topic strings. */
	key: string;
	/**
	 * Display form, when it differs from `key`. Topic beliefs are named BY the model, so their key is
	 * already readable and storing it twice only doubles the record; the display layer falls back to
	 * `key` when this is absent (see i18n.beliefGloss). Seed beliefs carry a fixed phrase.
	 */
	label?: string;
	/** Evaluative orientation in [-1, 1]: what the belief expects the world to be like. */
	valence: number;
	/** Subjective certainty in [0.05, 0.95]: a Bayesian-ish posterior, never allowed to saturate. */
	confidence: number;
	/** Evidence events seen. Drives centrality (a one-off remark is not a belief). */
	count: number;
	/** Last evidence, epoch ms. Drives the precariousness decay (beliefs fade without evidence). */
	t: number;
}

/**
 * The awareness field (Global Workspace analog): the three axes something else in the kernel reads.
 * A fifth (conversation_warmth) and a sixth (temporal_phase, with a learn function that had no caller)
 * were transcribed from the model description and maintained forever by nobody downstream — a number in
 * state.json that no decision consults is scenery, not a state variable.
 */
export interface Awareness {
	userPresence: number; // [0,1]
	socialPressure: number; // [-1,1]  negative = impulse to reach out
	thoughtSaturation: number; // [0,1]
}

/** Allostatic mood regulation state. */
export interface Allostasis {
	fatigue: number; // [0,1]
	load: number; // [0,1] recent cognitive load
	baselineShift: PAD; // slow-moving personal baseline
}

/** Opponent-process B-state (Solomon & Corbit) per emotion. */
export type OpponentVector = Record<Emotion, number>;

/** A complex cell [re, im]. The density matrix is an 8x8 grid of these. */
export type ComplexCell = [number, number];
/** 8x8 complex Hermitian density matrix, row-major. */
export type DensityMatrixState = ComplexCell[][];

/**
 * The complete affective state. Immutable by convention: the kernel returns a new object.
 * `t` is wall-clock epoch ms; `lastInteraction` drives every time-based computation.
 */
export interface MateState {
	version: number;
	t: number;
	lastInteraction: number;
	lastHeartbeat: number;
	born: number;
	emotions: EmotionVector;
	opponent: OpponentVector;
	mood: PAD;
	personality: Personality;
	character: Character;
	relationship: Relationship;
	drives: Drives;
	/** SPARK belief store, bounded by params.SPARK.maxBeliefs (see spark.ts). */
	beliefs: Record<string, Belief>;
	awareness: Awareness;
	allostasis: Allostasis;
	/** 8x8 complex Hermitian density matrix, row-major, [re, im] pairs. */
	rho: DensityMatrixState;
	/** Dual-process habituation: per-topic System-1 novelty trace. */
	habituation: Record<string, { s: number; t: number }>;
	/** Accumulated self-observations (bounded). */
	observations: string[];
	/** Monotonic counters, for telemetry. A counter earns its place by being read: the ones that were
	 * only ever initialised (proactiveSent, proactiveBlocked, dreams) are gone, because a number in
	 * state.json that nothing ever writes is a statistic the companion is lying about. */
	counters: {
		messages: number;
		transitions: number;
		sleepCycles: number;
		observations: number;
	};
	/** Cusp catastrophe flag: set when a phase transition has occurred and not yet released. */
	catastrophe: boolean;
	/**
	 * Exponential moving average of the transition surprise (the Friston self-prediction error),
	 * updated in exact closed form so catch-up remains subdivision-invariant. Low values mean recent
	 * events have been playing out exactly as predicted — the raw material of boredom.
	 */
	surpriseEma: number;
	/** Seeded PRNG state, so a replay of the same events is bit-identical. */
	seed: number;
}

/** Intent classification from intake. */
export type Intent = "chat" | "question" | "task";

/** An external event fed to the kernel. */
export interface MateEvent {
	/**
	 * `appraisal` is the periodic verdict of the cheap judge model on the stretch of exchange since
	 * the last one: affect about what passed between us, arriving after the fact. It moves feeling,
	 * the relationship, character and beliefs the way contact does, and it satisfies no drive and
	 * counts no message — nothing new happened, only what it meant was decided.
	 */
	kind: "user_message" | "proactive" | "self_observation" | "appraisal" | "sleep" | "wake" | "tick";
	/**
	 * Plutchik activations in [0,1] — the only LLM-influenced input, and deliberately never a guess.
	 * Intake applies contact events with an empty vector; affect arrives only from the periodic judge
	 * (see kernel.ts, `appraisal` events). There is no separate intensity field: the kernel measures a
	 * felt event by this vector (`intensityOf`), so a second number could only ever disagree with it.
	 */
	activations: Partial<EmotionVector>;
	intent: Intent;
	/**
	 * Text, for the observations ring and for SPARK topic-belief matching. Never used by the kernel's
	 * affective math itself, and never auto-encoded into memory — memory entries are model-authored
	 * (see memory.ts).
	 */
	text?: string;
	/**
	 * Model-named topic tags riding remember/ponder events (short subject strings like 面试 or work).
	 * They crystallise SPARK topic beliefs; evidence for existing topic beliefs on contact events is
	 * matched from the message text instead (see kernel.ts).
	 */
	topics?: string[];
	t: number;
}

/** The result of a transition: new state plus cheap diagnostics. */
export interface TransitionResult {
	state: MateState;
	/** Effort band, Eq. 2. Drives the response token ceiling. */
	effort: EffortBand;
	/** Token ceiling implied by effort and intent. */
	tokenCeiling: number;
	/** Whether a dyad (complex emotion) was detected. */
	dyads: string[];
	/** Surprise from self-prediction (Friston): |predicted - actual| PAD norm. */
	surprise: number;
}

export type EffortBand = "autopilot" | "brief" | "normal" | "engaged";

/** A thought produced by the autonomous thinking loop. */
export interface Thought {
	id: string;
	kind: "curiosity" | "missing_user" | "pattern" | "promise" | "vulnerability" | "observation";
	text: string;
	urgency: number;
	topic: string;
	t: number;
}
