/**
 * Kernel parameters.
 *
 * Every rate here is anchored to a published model of human affect, not to taste; the citation for
 * each block is on the block. Where the literature gives an ORDERING or a mechanism but no number
 * for a companion's timescale, the constant is chosen on the human-timescale rule (emotional change
 * at human speed) and the citation says what it anchors.
 *
 * There are no hardcoded behavioral thresholds: every decision threshold is computed from
 * personality and character. The constants here are physiological rates (decay constants, coupling
 * strengths), not behavioral cutoffs.
 */

import type { Drives, Emotion } from "./types.ts";

/**
 * Per-emotion decay rate, 1/ms.
 *
 * Verduyn & Lavrijsen (2015) measured how long 27 emotions actually last: sadness lingers up to 240x
 * longer than the briefest (surprise, shame, disgust, fear), because its events are important and get
 * replayed. The ordering below follows that measurement — surprise fastest, sadness slowest — while
 * the absolute constants compress the ratio so a companion's day stays responsive; the replay half of
 * their mechanism is implemented directly instead (rumination stretches the sadness clock, see
 * kernel.triggerEmotions).
 */
export const EMOTION_DECAY: Record<Emotion, number> = {
	joy: 1 / (45 * 60_000),
	trust: 1 / (180 * 60_000),
	fear: 1 / (25 * 60_000),
	surprise: 1 / (8 * 60_000),
	sadness: 1 / (150 * 60_000),
	disgust: 1 / (60 * 60_000),
	anger: 1 / (35 * 60_000),
	anticipation: 1 / (30 * 60_000),
};

/**
 * Plutchik -> PAD projection. Rows: [pleasure, arousal, dominance] per unit intensity.
 *
 * PAD is the published three-dimensional representation of affective state (Mehrabian 1996; Russell &
 * Mehrabian 1977 gave P/A/D coordinates for the emotion terms). The signs and rough placements of the
 * eight channels follow that mapping — joy/trust positive in P, fear/anger high in A with opposite D,
 * sadness low in both P and A — with values rounded to one decimal.
 */
export const EMOTION_PAD: Record<Emotion, [number, number, number]> = {
	joy: [0.9, 0.45, 0.35],
	trust: [0.55, -0.1, 0.2],
	fear: [-0.85, 0.8, -0.6],
	surprise: [0.05, 0.75, -0.25],
	sadness: [-0.8, -0.35, -0.45],
	disgust: [-0.75, 0.25, 0.15],
	anger: [-0.7, 0.75, 0.55],
	anticipation: [0.3, 0.45, 0.2],
};

/** Plutchik dyads: pairs that compose into a named complex emotion. */
export const DYADS: ReadonlyArray<{ name: string; a: Emotion; b: Emotion; min: number }> = [
	{ name: "love", a: "joy", b: "trust", min: 0.45 },
	{ name: "submission", a: "trust", b: "fear", min: 0.45 },
	{ name: "awe", a: "fear", b: "surprise", min: 0.45 },
	{ name: "disapproval", a: "surprise", b: "sadness", min: 0.45 },
	{ name: "remorse", a: "sadness", b: "disgust", min: 0.45 },
	{ name: "contempt", a: "disgust", b: "anger", min: 0.45 },
	{ name: "aggressiveness", a: "anger", b: "anticipation", min: 0.45 },
	{ name: "optimism", a: "anticipation", b: "joy", min: 0.45 },
];

/**
 * Ornstein-Uhlenbeck mood parameters (Eq. 1 step 5).
 *
 * The two-timescale architecture — brief emotions vs a slow mood that outlives them — is the standard
 * layered model (Gebhard 2005's ALMA runs it in PAD space; Davidson 1998's affective chronometry is
 * the empirical base), and mean reversion toward an equilibrium set by recent input and personality
 * is how daily-affect dynamics are fitted (Bisconti, Bergeman & Boker 2004's damped oscillator).
 */
export const MOOD = {
	/**
	 * Pull toward the emotion-derived centre. Human mood does NOT whiplash message to message: an
	 * acute feeling lands in seconds, but the mood it feeds integrates over roughly an hour, so the
	 * companion's baseline lags its flashes instead of echoing them.
	 */
	alpha: 1 / (45 * 60_000),
	/** Pull toward the personality default. */
	beta: 1 / (90 * 60_000),
	/** Stochastic term, per sqrt(ms). */
	sigma: 0.00004,
};

/**
 * Opponent-process (Solomon & Corbit 1974) coupling. The B-process is recruited by the A-process with
 * a slow rise, decays on its own slower clock, and its subtraction re-emerges on the wheel antipode
 * (see kernel.netEmotions) — that transfer is what makes the theory's hedonic aftereffect (the
 * come-down after the peak) visible in a non-negative vector.
 */
export const OPPONENT = {
	/** B-process rise rate from the A-process. */
	ka: 0.35,
	/** B-process own decay, 1/ms. */
	kb: 1 / (75 * 60_000),
	/** How much of the B-process is subtracted from the net feeling. */
	gain: 0.6,
};

/**
 * Drive dynamics, 1/ms. Connection accelerates when attachmentAnxiety > 0.4.
 *
 * These are homeostatic reservoirs: exponential approach toward saturation while unmet, decay when
 * satisfied. `rest` is the wake half of Borbély's (1982) two-process sleep model (Process S builds
 * with time awake, dissipates during sleep — sleepTransition is the dissipating half); the social
 * drives follow the same homeostatic form the boredom literature uses for information intake
 * (Yu, Chang & Kanai 2019).
 */
export const DRIVE_RISE: Record<keyof Drives, number> = {
	connection: 1 / (5 * 3_600_000),
	curiosity: 1 / (9 * 3_600_000),
	expression: 1 / (3 * 3_600_000),
	growth: 1 / (24 * 3_600_000),
	rest: 1 / (12 * 3_600_000),
};

/**
 * SPARK (MATE section 3.9): the cognitive autopoietic loop.
 *
 * Beliefs modulate perception and perception updates beliefs. The paper's Eq. 24 biases the perceived
 * valence of an event by `valence × strength × 0.15 × dsanity`, where strength is the geometric mean
 * of confidence (vmPFC analog) and centrality (ACC analog), and dsanity is the runaway damper —
 * production telemetry over 910 events showed a mean modulation of +0.000355 with zero runaways, so
 * the small gain and the damper are load-bearing, not decorative.
 */
export const SPARK = {
	/** Eq. 24 gain on the perceived-valence bias. */
	modulation: 0.15,
	/** dsanity = 1 − rigidity × damper, bounded to [1 − damper, 1]. Rigidity is mean belief confidence. */
	damper: 0.8,
	/**
	 * Asymmetric evidence learning rates (Lefebvre et al. 2022: confirmation bias during reinforced
	 * self-learning is a normative feature of the loop, not a bug — but it must be damped, which
	 * dsanity does). Confirming evidence moves confidence twice as fast as disconfirming evidence.
	 * Paced on HUMAN attitude change: a belief is an opinion formed over weeks of consistent
	 * experience, not an afternoon — a dozen warm messages should move it a little, a month should
	 * move it a lot.
	 */
	etaConfirm: 0.05,
	etaViolate: 0.025,
	/** How fast a belief's evaluative orientation drifts toward the evidence it keeps seeing. */
	etaValence: 0.04,
	/** Confidence never leaves [floor, 1 − floor]: a belief is never certain, never impossible. */
	confidenceFloor: 0.05,
	/** Evidence events for centrality to reach 1 − 1/e. A one-off remark is not a belief; neither is
	 * one intense conversation — recurring subjects over days earn centrality. */
	centralityTau: 30,
	/** Belief store cap. Overflow drops the weakest non-seed belief (confidence × centrality). */
	maxBeliefs: 40,
	/** Precariousness: without evidence a belief's confidence relaxes toward the floor on this clock. */
	decayTau: 30 * 86_400_000,
	/** Neutral evidence (|perceived valence| below this) updates nothing. */
	evidenceDeadZone: 0.1,
	/** Topic-belief seeds start this sure and this oriented; they must earn the rest. */
	topicSeedConfidence: 0.2,
};

/**
 * Boredom (derived, not a stored drive).
 *
 * The literature agrees boredom is not a discharging reservoir: Schmidhuber (1991) formalises it as
 * learning progress → 0 — nothing new to compress; Darling (2023, Synthese) as prediction error
 * persistently low under predictive processing; Gomez-Ramirez & Costa (2017) as the
 * exploitation/exploration switch; Yu, Chang & Kanai (2019) as a homeostatic motive over information
 * intake. The derived signal therefore multiplies a predictability term (low recent surprise, stale
 * topics) by an idle gate (the one homeostatic ingredient, Yu et al.) and a personality modulation.
 */
export const BOREDOM = {
	/** Surprise EMA time constant, ms. */
	surpriseTau: 6 * 3_600_000,
	/** A surprise EMA of this much counts as fully unpredictable (surprise is a PAD norm, ~[0, 2]). */
	surpriseScale: 0.5,
	/** Predictability = surpriseWeight × (1 − surprise norm) + topicWeight × topic saturation. */
	surpriseWeight: 0.6,
	topicWeight: 0.4,
	/** Idle-gate ramp, ms: the homeostatic information-deprivation component (Yu et al. 2019). */
	idleTau: 2 * 3_600_000,
};

/** Drive saturation decay while satisfied, 1/ms. */
export const DRIVE_FALL = 1 / (40 * 60_000);

/** Awareness axis decay rates, 1/ms. */
export const AWARENESS_DECAY = {
	userPresence: 1 / (3 * 3_600_000),
	socialPressure: 1 / (8 * 3_600_000),
	thoughtSaturation: 1 / (6 * 3_600_000),
};

/** Lindblad dephasing rate for the density matrix off-diagonals, 1/ms. */
export const DECOHERENCE = 1 / (20 * 60_000);

/** Hamiltonian diagonal energies per emotion (arbitrary units, relative). */
export const HAMILTONIAN: Record<Emotion, number> = {
	joy: 0.9,
	trust: 0.6,
	fear: -0.7,
	surprise: 0.3,
	sadness: -0.6,
	disgust: -0.4,
	anger: -0.5,
	anticipation: 0.4,
};

/**
 * Off-diagonal coupling of the emotional Hamiltonian (MATE section 3.1, "relationship-modulated
 * coupling").
 *
 * A DIAGONAL Hamiltonian can never produce an order effect: diagonal unitaries are phase rotations
 * and phases add commutatively, so U_A U_B = U_B U_A exactly. The paper's headline result - warmth
 * then hostility != hostility then warmth, ||dPAD|| = 0.48, classical gives 0 - REQUIRES off-diagonal
 * coupling so that [H_A, H_B] != 0. The coupling is laid out on Plutchik's wheel: adjacent emotions
 * couple positively, opposite emotions negatively, via K_ij = cos(2*pi*(i-j)/8). WHEEL_COUPLING is
 * the base strength g0; the effective g is scaled up by relationship trust (a trusted bond entangles
 * emotions more strongly, so ambivalence persists longer - the paper's decoherence/coupling story).
 */
export const WHEEL_COUPLING = 0.4;

/** How strongly triggered intensity raises an emotion's own diagonal energy. */
export const HAMILTONIAN_INTENSITY = 1.6;

/**
 * Base unitary rotation angle per emotional event, radians.
 *
 * This is the CRITICAL difference from a dt-scaled phase: the kick is a fixed rotation applied once
 * per emotional event (scaled by its intensity), NOT proportional to the time since the last one.
 * That is what makes the order effect appear even for two near-simultaneous messages - it is a
 * property of the SEQUENCE of rotations, not of elapsed time. pi/3 gives Rabi-like population
 * transfer large enough to read on PAD without scrambling the state.
 */
export const KICK_ANGLE = Math.PI / 3;

/** Character micro-nudge bound per message (paper: 0.001-0.005). */
export const NUDGE_MAX = 0.005;

/** Effort model coefficients (Eq. 2). */
export const EFFORT_W = {
	arousal: 0.4,
	comfort: -0.35,
	conscientiousness: 0.12,
	extraversion: 0.08,
	reflectiveness: 0.06,
	selfEfficacy: 0.04,
	bias: 0.28,
	noise: 0.06,
};

/** Token ceilings per effort band. Kept tight: this is the main cost lever. */
export const TOKEN_CEILING: Record<string, number> = {
	autopilot: 40,
	brief: 220,
	normal: 700,
	engaged: 2000,
};

/** Intent scaling on the ceiling. */
export const INTENT_SCALE: Record<string, number> = {
	chat: 0.6,
	question: 1.0,
	task: 1.6,
};

/** Communication energy weights (Eq. 12). */
export const ENERGY_W = { arousal: 0.5, extraversion: 0.2, pleasure: 0.15, attachment: 0.15, depth: 0.08 };

/** Send-style burst weights (Eq. 14). */
export const BURST_W = { extraversion: 0.3, reflectiveness: 0.25, arousal: 0.2, trust: 0.15, directness: 0.1 };

/** Meta-emotion depth damping: I_d = 0.3^d. */
export const META_EMOTION_DAMPING = 0.3;

/** Sleep window, local hours [start, end). Consolidation runs once per crossed window. */
export const SLEEP_WINDOW: [number, number] = [1, 5];

/** Heartbeat interval, ms. Live loop only; offline catch-up ignores it entirely. */
export const HEARTBEAT_MS = 60_000;

/** Maximum subjective-time warp factors (Eq. 13). */
export const TEMPORAL_WARP = { anxiety: 1.5, tolerance: 0.4, pleasure: 0.3, neuroticism: 0.5 };

/** Bound on trust drop per single event, as a fraction of current trust. */
export const TRUST_DROP_CAP = 0.12;

/** Cusp catastrophe thresholds. */
export const CUSP = { dominanceMax: -0.35, arousalMin: 0.6 };

/** Self-observation ring buffer size. Older observations are consolidated, not kept verbatim. */
export const MAX_OBSERVATIONS = 64;

/**
 * Habituation effective time constant, ms.
 *
 * Dual-process habituation (Groves & Thompson 1970): response strength falls with repeated
 * stimulation and recovers spontaneously with time. daemon.habituate is the implementation — a
 * saturation trace S per topic with spontaneous recovery H(t) — and topicSaturation reads the same
 * traces for the boredom signal.
 */
export const HABITUATION_TAU = 4 * 3_600_000;
