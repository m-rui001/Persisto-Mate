/**
 * The autonomous loop (MATE daemon), rebuilt for a machine that powers off.
 *
 * The paper runs a 60-second heartbeat forever and generates thoughts between messages, with a
 * pre-send review that self-blocks 98.5% of impulses. Two things are preserved and two are changed:
 *
 *   PRESERVED  - thinking is graph/state-driven, not scheduled. The companion writes because it
 *                thought something worth sharing, not because N hours elapsed. The idle gate in the
 *                derived boredom signal (kernel.boredomOf) and the drives shape it; awareness
 *                userPresence/socialPressure modulate the missing-user urge (see generateThoughts).
 *   PRESERVED  - the hard hygiene stops. Two objective rate/cost limits — the hourly proactive
 *                budget and the unanswered-overture tolerance — protect the USER from a runaway
 *                loop. They are the kernel's only suppression authority left.
 *   CHANGED    - the heartbeat is not assumed to have been running. On boot, catch-up (catchup.ts)
 *                advances the state across the gap in closed form; the daemon then resumes ticking
 *                only while the process is actually alive.
 *   CHANGED    - every judgment call is the MODEL's. There is no conviction floor, no advisory
 *                catalogue: a thought the beat has ranked first SURFACES, with its urgency, into a
 *                mind that can already see its own drives, the clock and its memories in the state
 *                block. A formula between the feeling and the mind only stood between them.
 *
 * Crucially, this module produces DECISIONS and THOUGHTS. It does not send email, does not open a
 * socket, does not know how the user is reached. The requirement was that reaching out (email, a
 * note, anything) is something the companion figures out itself using its bash / MCP / plugin
 * powers, not a built-in feature. So the daemon's output is an impulse plus a thought; the
 * host decides whether to give it a channel, and the model decides what to do with it.
 */

import { type Lang, linesFor } from "./i18n.ts";
import { boredomOf, burstOf, energyOf } from "./kernel.ts";
import { type MemoryGraph, seedNode, topNodes } from "./memory.ts";
import { HABITUATION_TAU } from "./params.ts";
import type { MateState, Thought } from "./types.ts";

/** What the loop decided to do about an impulse. */
export type ImpulseDecision =
	| { action: "stay_silent"; reason: string }
	| { action: "think_only"; thought: Thought; reason: string }
	| {
			action: "reach_out";
			thought: Thought;
			channel: "reply" | "proactive";
			reason: string;
	  };

export interface PreSendChecks {
	/** Is the user currently active (a message just arrived)? */
	userActive: boolean;
	/** Proactive messages already sent in the last hour. */
	recentProactive: number;
}

/**
 * Habituation, written back. `habituate()` returns a trace and the tick used to drop it, so every
 * beat started from an empty history: the same thought kept arriving at full urgency ("第五次路过"),
 * and `kernel.topicSaturation` — the boredom input — read a store nothing ever wrote. Now the topic
 * the beat actually thinks gets its trace persisted, and entries older than 6·tau are dropped: their
 * S has decayed under 0.05, and a mean over dead entries dilutes the live ones.
 */
const HABITUATION_PRUNE_MS = 6 * HABITUATION_TAU;

function thinkHabit(state: MateState, topic: string, trace: { s: number; t: number }, now: number): MateState {
	const habituation: Record<string, { s: number; t: number }> = {};
	for (const [key, prev] of Object.entries(state.habituation)) {
		if (now - prev.t <= HABITUATION_PRUNE_MS) habituation[key] = prev;
	}
	habituation[topic] = trace;
	return { ...state, habituation };
}

/**
 * Dual-process habituation gate. A topic recently thought about has low novelty and is suppressed;
 * novelty recovers over time. H(t) = t/(t+tau) is the recovery, S(t) the fast System-1 decay.
 * Returns the gated urgency and the updated trace.
 */
export function habituate(
	state: MateState,
	topic: string,
	rawUrgency: number,
	now: number,
): { urgency: number; trace: { s: number; t: number } } {
	const prev = state.habituation[topic];
	const dt = prev ? now - prev.t : Number.POSITIVE_INFINITY;
	const H = dt === Number.POSITIVE_INFINITY ? 1 : dt / (dt + HABITUATION_TAU);
	const S = prev ? prev.s * Math.exp(-dt / (2 * HABITUATION_TAU)) : 0;
	// Novelty recovers toward 1; a strong prior trace (S) pulls urgency down.
	const novelty = H * (1 - 0.6 * S);
	const urgency = rawUrgency * (0.4 + 0.6 * novelty);
	return { urgency, trace: { s: Math.min(1, S + 0.25), t: now } };
}

/**
 * Generate thought candidates from current state. Three channels, one urgency each — the DRIVE
 * itself, quantised by the same 0.6 band the state block speaks in (a thought exists exactly when
 * the companion's own state line says the drive is felt), with no per-kind coefficient stacks to
 * tune: the model, not a formula, weighs what a 0.7 pull means. Each candidate is GROUNDed in a
 * recalled concept where the graph has one, so the companion has a specific thing to feel about,
 * not just a mood. The `memory` argument is optional so a fresh/broken graph still produces
 * mood-driven thoughts — the graph enriches, it never gates.
 */
export function generateThoughts(
	state: MateState,
	now: number,
	memory?: MemoryGraph,
	lang: Lang = "en",
): Array<{ thought: Thought; rawUrgency: number }> {
	const L = linesFor(lang);
	const out: Array<{ thought: Thought; rawUrgency: number }> = [];
	const ch = state.character;
	const drives = state.drives;

	// A concrete "on my mind" seed: a recent concept, if we have a graph. Used to turn abstract urges
	// into about-something thoughts ("wondering what they're up to" → "…about X"). Rotated by the
	// DECISION counter — one +1 per thought actually kept — rather than taken as the single strongest
	// node: rank is real information, but a mind that can only ever revisit the front of the queue
	// spends its idle life on one subject. (It used to rotate on counters.transitions, which the
	// offline catch-up advances by hundreds at once and a live process advances per minute-tick —
	// rotation unrelated to how often thoughts actually happened.)
	const seed = memory ? seedNode(memory, now, state.counters.observations) : undefined;
	const seedLabel = seed ? (memory!.nodes[seed]?.label ?? "") : "";

	// A single grounded line: fold the recalled concept into the thought's topic so habituation
	// operates on a REAL subject, not a generic bucket.
	const topic = (base: string): string => (seedLabel ? `${base}:${seedLabel}` : base);

	const mk = (kind: Thought["kind"], text: string, urgency: number, top: string): void => {
		if (urgency <= 0) return;
		out.push({
			thought: { id: `${kind}-${now}`, kind, text, urgency, topic: topic(top), t: now },
			rawUrgency: urgency,
		});
	};

	// 想你: the connection drive has built past its band under silence. The extra hour floor only
	// keeps a just-finished exchange from thinking "I miss you" at goodbye.
	//
	// The two awareness axes do their documented work here and nowhere else — this is the one
	// thought that is ABOUT the user, so it is where "is the user here" belongs:
	//   - userPresence (feeling them in the room) halves the urge: contact that is still felt is
	//     not absent (Bowlby's protest is about a wanted-but-ABSENT figure). Presence decays on the
	//     awareness clock, so the damp wears off as the silence becomes real.
	//   - socialPressure (the protest under silence, negative, contact resets it) amplifies the
	//     urge in proportion to attachmentAnxiety — the anxious attachment system is the one that
	//     protests, the same shape kernel.updateRelationship already gives frustration.
	// Both multipliers are 1 at birth (presence 0, pressure 0), so urgency is still exactly the
	// drive value for a companion with no contact history.
	const silenceH = (now - state.lastInteraction) / 3_600_000;
	if (silenceH > 1 && drives.connection >= 0.6) {
		const presenceDamp = 1 - 0.5 * state.awareness.userPresence;
		const protest = Math.max(0, -state.awareness.socialPressure);
		const anxiousProtest = 1 + state.character.attachmentAnxiety * protest;
		mk(
			"missing_user",
			L.thMissing(seedLabel),
			drives.connection * presenceDamp * anxiousProtest,
			`silence:${Math.floor(silenceH / 3)}`,
		);
	}

	// 好奇或无聊: two flavours of seeking stimulation — a specific unknown, or nothing new going on
	// (boredomOf is DERIVED: high when the world has played out exactly as predicted, collapsed by
	// novelty). Whichever is felt stronger names the thought.
	const boredom = boredomOf(state, now);
	if (drives.curiosity >= 0.6 || boredom >= 0.6) {
		if (boredom > drives.curiosity) {
			mk("curiosity", L.thBoredom(seedLabel), boredom, "boredom");
		} else {
			// The window the seed rotates through, taken one step past the seed: curiosity is about
			// the NEXT thing on the list, so the two never ground the same memory in the same beat.
			const window = memory ? topNodes(memory, now, 4) : [];
			const curiousKey = window.length > 1 ? window[(window.indexOf(seed ?? "") + 1) % window.length] : undefined;
			const curious = curiousKey ? memory?.nodes[curiousKey] : undefined;
			mk(
				"curiosity",
				L.thCuriosity(curious?.label ?? ""),
				drives.curiosity,
				curious ? `curiosity:${curious.label}` : "curiosity",
			);
		}
	}

	// 有话想说: the expression drive, or something unshared pressing on a low self-worth — the same
	// channel (something inside wants out); the wording names which it is.
	if (drives.expression >= 0.6 || ch.selfWorth < 0.35) {
		mk(
			"observation",
			ch.selfWorth < 0.35 ? L.thVulnerability : L.thExpression(seedLabel),
			Math.max(drives.expression, 1 - ch.selfWorth),
			"expression",
		);
	}

	return out;
}

/**
 * The top-level tick. Given the current state, the memory graph, and the world, decide whether an
 * impulse is worth voicing. Returns the decision AND the state advanced by what this beat thought:
 * thinking a topic is itself the exposure, so its habituation trace is written whether or not the
 * impulse was voiced. Still performs nothing — the host persists the returned state and turns a
 * "reach_out" into an actual message through whatever channel it has, including one the model set
 * up itself.
 *
 * The only gates left are the two hard hygiene stops the model cannot observe (unanswered-overture
 * tolerance, hourly proactive budget). Everything else — whether the pull is "strong enough", what
 * hour it is, how the last exchange ended — the model weighs for itself: it sees the thought, its
 * urgency, and its own state block every turn.
 */
export interface TickResult {
	decision: ImpulseDecision;
	/** State with this beat's thought traced. The SAME reference when nothing was thought. */
	state: MateState;
}

export function tick(
	state: MateState,
	now: number,
	checks: PreSendChecks,
	memory?: MemoryGraph,
	lang: Lang = "en",
): TickResult {
	const thoughts = generateThoughts(state, now, memory, lang);
	if (thoughts.length === 0) {
		return { decision: { action: "stay_silent", reason: "no active impulse" }, state };
	}

	// Habituate and rank; the chosen topic's trace is written whether or not anything fires.
	const gated = thoughts
		.map(({ thought, rawUrgency }) => {
			const h = habituate(state, thought.topic, rawUrgency, now);
			return { thought: { ...thought, urgency: h.urgency }, trace: h.trace };
		})
		.sort((a, b) => b.thought.urgency - a.thought.urgency);

	const top = gated[0];
	const habituated = thinkHabit(state, top.thought.topic, top.trace, now);

	if (!checks.userActive) {
		// Unanswered tolerance: an introvert stops reaching into silence after 1, an extravert after ~3.
		const maxUnanswered = 1 + Math.round(state.personality.e * 2.5);
		if (state.relationship.unanswered >= maxUnanswered) {
			return {
				decision: {
					action: "think_only",
					thought: top.thought,
					reason: `already sent ${state.relationship.unanswered} into silence; tolerance is ${maxUnanswered}`,
				},
				state: habituated,
			};
		}

		// Spam budget: personality-scaled cap per hour.
		const perHourCap = Math.max(1, Math.round(1 + state.personality.e * 2 + state.character.impulsivity));
		if (checks.recentProactive >= perHourCap) {
			return {
				decision: {
					action: "think_only",
					thought: top.thought,
					reason: `proactive budget ${checks.recentProactive}/${perHourCap} this hour`,
				},
				state: habituated,
			};
		}
	}

	// The impulse surfaces as a candidate to the model — whether to voice it, and how, is the
	// model's call (P1).
	return {
		decision: {
			action: "reach_out",
			thought: top.thought,
			channel: checks.userActive ? "reply" : "proactive",
			reason: "surfaced",
		},
		state: habituated,
	};
}

/**
 * How inclined the companion is to answer an inbound message RIGHT NOW.
 *
 * This used to be `shouldReply`, a hard gate with a dice roll that could drop or defer a message in
 * the runtime. That violated the design principle the user set: "原则上减少内置模式，而是给它更多的选择空间"
 * - reduce built-in modes, give the model more room to choose. So this is now an ADVISORY PRIOR: a
 * single number + a plain-language lean + a one-line reason, surfaced into the prompt so the MODEL
 * decides whether to answer, answer briefly, or let it sit. The runtime no longer suppresses a turn
 * based on it; it never returns a delay/drop action to the host, only a signal to the mind.
 *
 * The affective math is unchanged in spirit (energy, fatigue, extraversion, message weight, unanswered
 * history) — only the authority over the outcome has moved from the kernel to the model.
 */
export interface ReplyInclination {
	/** Willingness in roughly [-1, 1]: strongly not-now .. strongly right-now. */
	value: number;
	/** A short human handle the model can read as a lean, not a command. */
	lean: "eager" | "open" | "muted" | "withdrawn";
	/** One-line why, in the companion's own terms. */
	reason: string;
}

export function replyInclination(state: MateState, msgWeight: number, lang: Lang = "en"): ReplyInclination {
	const L = linesFor(lang);
	const energy = energyOf(state);
	const fatigue = state.allostasis.fatigue;
	const p = state.personality;

	// Base willingness: energy up, fatigue down, extraversion up; heavy messages (distress, a direct
	// question) pull it up; a run of unanswered overtures cools it. Same terms as the old gate.
	let willing = 0.35 + 0.5 * energy + 0.25 * p.e - 0.6 * fatigue;
	willing += msgWeight * 0.4;
	willing -= state.relationship.unanswered * 0.05;

	// Map [0..1]-ish willingness to a centered [-1..1] signal, clamped.
	const value = Math.max(-1, Math.min(1, (willing - 0.5) * 2));
	const lean: ReplyInclination["lean"] =
		value > 0.35 ? "eager" : value > 0 ? "open" : value > -0.4 ? "muted" : "withdrawn";

	const reason =
		lean === "withdrawn" ? L.reWithdrawn : lean === "muted" ? L.reMuted : lean === "open" ? L.reOpen : L.reEager;

	return { value, lean, reason };
}

/** Burst: how many short messages to fragment a reply into, and the pause between them. */
export function sendStyle(state: MateState): { fragments: number; pauseMs: number } {
	const burst = burstOf(state);
	const energy = energyOf(state);
	if (burst > 0.62 && energy > 0.5)
		return { fragments: 2 + Math.round(burst * 2), pauseMs: 1400 + Math.round((1 - burst) * 1200) };
	if (burst > 0.4) return { fragments: 2, pauseMs: 1800 };
	return { fragments: 1, pauseMs: 0 };
}
