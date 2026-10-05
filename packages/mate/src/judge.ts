/**
 * The judge: an outside read of a stretch of exchange, taken by a model that is not writing the reply.
 *
 * This is THE path a message's emotional impact takes into the kernel. Intake applies no affect of its
 * own (appraisal.ts reads only what a message asks for): a substring table deciding that 哈哈 is joy
 * would manufacture a feeling about a sentence the reply is being written over, and a first-person tool
 * for reporting feelings was tried and removed — it duplicated this reader, it cost an interrupted turn
 * every time it was used, and a model that skipped it left whole quiet stretches integrating with no
 * affect at all. An outside reader has none of those failure modes: it cannot be skipped, it runs while
 * the companion is idle, and it never interrupts a reply.
 *
 * Five decisions in here, each of which is the whole design:
 *
 *   1. DELTAS, NOT LEVELS. Asked "how much sadness is in this exchange (0..1)" a small model invents a
 *      number: absolute affect estimation requires an anchor it does not have. Asked "did sadness rise
 *      or fall over these turns, on a ladder of -2 -1 0 +1 +2" it answers a comparative question it can
 *      actually answer, and the scale is short enough that the anchors mean something. So the judge is
 *      a differential sensor, and `transition()` integrates it — the same way the kernel already
 *      integrates everything else: the reading is a kick, the mood is the accumulated state.
 *
 *   2. A NEGATIVE READ IS NOT THROWN AWAY. "Joy fell by 2" is a real event, and Plutchik's wheel (see
 *      types.ts: EMOTIONS is the wheel order) puts sadness directly opposite joy. So a fall on one
 *      channel is applied as a rise on its antipode — the same opponent pair the kernel's own
 *      opponent-process step uses. Nothing has to be clamped away, and the affect vector stays
 *      non-negative, which every consumer of it assumes.
 *
 *   3. THE READING MAY NOT OUT-SHOUT THE PERSON HAVING IT. JUDGE_GAIN caps the strongest possible
 *      reading at half a channel. The kernel treats a reading as ONE event's felt intensity; half a
 *      channel is an episode, not a peak experience — the episode band is the one EMOTION_DECAY
 *      already encodes from Verduyn & Lavrijsen (2015)'s measured durations. A background reader that
 *      could write bigger numbers than a lived event would be an outside opinion winning over the
 *      person having the feeling.
 *
 *   4. THE MAGNITUDE MAPPING IS ANCHORED, NOT FELT. Three published results fix how a reading's rungs
 *      become activations:
 *        - The -2..+2 ladder is a comparative instrument: judges answer "did it rise or fall"
 *          reliably where absolute estimation fails (Thurstone 1927, the law of comparative
 *          judgment; Likert 1932 for equally-weighted rungs on a latent continuum). The rung index
 *          is therefore read as an equal-interval count — |d|/2 ∈ {0.25, 0.5, 0.75, 1} of full scale.
 *        - Negative readings weigh twice positive ones. "Bad is stronger than good" is one of the
 *          most replicated asymmetries in affective psychology (Baumeister et al. 2001; Rozin &
 *          Royzman 2001's review places the ratio near 2:1), so a fall of +2 rungs moves the kernel
 *          twice as far as a rise of 2. JUDGE_GAIN stays the NEGATIVE cap; positive readings take
 *          half of it.
 *        - A channel's activation is attenuated by the reader's confidence in it, the attenuation
 *          logic of classical test theory (Spearman 1904): unreliable testimony is discounted, not
 *          trusted at face value. The chat tier reports no confidence, so its readings arrive
 *          unattenuated and the due gate carries the reliability burden instead.
 *
 *   5. THE USER'S FEELINGS ARE NOT THE COMPANION'S. The reader sits outside the exchange, which makes
 *      mirroring the easiest error to make: a user's frustration read as the companion's anger is
 *      exactly the contamination this instrument exists to prevent. Both question forms therefore
 *      force the perspective explicitly: a feeling the USER expressed moves the companion's channel
 *      only if the transcript shows the companion itself was moved.
 *
 * The model call itself is NOT here: this module is pure (window selection, question authoring, answer
 * parsing, delta arithmetic) so the semantics are unit-testable without a network. The extension host
 * does the calling; see packages/coding-agent/src/extensions/mate/judge-run.ts. It asks the reader the
 * user named — a classifier (`judgeQuestions`, answered as structured scores) or a chat model
 * (`judgePrompt`, answered as one JSON object) — and otherwise the model holding the conversation. Both
 * kinds end in the same -2..+2 deltas, so the kernel cannot tell which instrument read it.
 */

import { EMOTIONS, type Emotion, type EmotionVector } from "./types.ts";

/**
 * A turn of dialogue as the judge sees it. Role is deliberately coarse: the judge reads who spoke, not
 * the harness's message taxonomy.
 *
 * `thinking` is the companion's own reasoning behind what it said, and it is here ONLY for a reader the
 * user pointed the judge at by name: a decision model answers eight ordinal questions in one pass, so a
 * window several times the size of the spoken one costs it almost nothing, and the reasoning carries
 * affective movement the polished reply never shows. A general chat model reads the same window token by
 * token, which is why that tier gets the spoken exchange and nothing else.
 */
export interface JudgeTurn {
	role: "user" | "assistant";
	text: string;
	thinking?: string;
}

/** How many recent turns a judge window may hold, and how much of each one. A short window keeps the
 *  judgement about what just happened instead of about the whole transcript, and a small context is what
 *  lets any model at all — including a decision classifier — answer the comparative question reliably. */
export const JUDGE_MAX_TURNS = 10;
export const JUDGE_TURN_CHARS = 320;
/** The reasoning gets more room than the reply because it is where the movement happens: it is written
 *  before the companion decides what to say, and it is not shaped for the reader. */
export const JUDGE_THINKING_CHARS = 900;

/** The judge answers one comparative question per channel on this ladder. */
export const JUDGE_SCALE = 2;

/** A full-scale NEGATIVE reading becomes this much activation: half a channel. See header note 3/4:
 *  an outside read colours the state without overruling it, and a reading is one event's felt
 *  intensity — an episode, not a peak (the episode band EMOTION_DECAY encodes from Verduyn &
 *  Lavrijsen 2015). */
export const JUDGE_GAIN = 0.5;

/** Negative readings weigh this many times positive ones. Bad is stronger than good (Baumeister,
 * Bratslavsky, Finkenauer & Vohs 2001; the review in Rozin & Royzman 2001 places the ratio near 2:1),
 * so a fall of 2 rungs moves the kernel twice as far as a rise of 2. Positive readings take
 * JUDGE_GAIN divided by this; the negative cap itself stays JUDGE_GAIN. */
export const JUDGE_NEGATIVITY_BIAS = 2;

/** A reading is due once the companion has put this many reply tokens on screen since the last one:
 *  about two or three ordinary exchanges. Restraint, not cost — one reading per stretch of exchange is
 *  enough, and repeated readings of overlapping windows would count the same event twice. */
export const JUDGE_MIN_OUTPUT_TOKENS = 600;

/** The decision-model gate, an order of magnitude higher, because that window carries the thinking too:
 *  the same stretch of exchange is several times the text, so the same reading is taken after several
 *  times the tokens. Counting thinking against the chat-model number would have the outside read fire on
 *  a long internal deliberation that produced nothing the user saw. */
export const JUDGE_MIN_CLASSIFIER_TOKENS = 6_000;

/** At least this many things the user newly said since the last reading. The volume gate above is what
 *  makes a reading worth taking; this is the OVERLAP guard — with nothing new in it, the window would be
 *  the same already-judged stretch and the same event would count twice. */
export const JUDGE_MIN_USER_TURNS = 1;

/** Plutchik's antipode: the wheel order in EMOTIONS puts opposites exactly 4 apart. */
export function oppositeEmotion(e: Emotion): Emotion {
	return EMOTIONS[(EMOTIONS.indexOf(e) + 4) % EMOTIONS.length];
}

/** The last `limit` turns, each truncated to one line's worth of text, empties dropped. */
export function judgeWindow(turns: JudgeTurn[], limit: number = JUDGE_MAX_TURNS): JudgeTurn[] {
	const cleaned = turns
		.map((t) => {
			const text = t.text.replace(/\s+/g, " ").trim().slice(0, JUDGE_TURN_CHARS);
			const thinking = t.thinking?.replace(/\s+/g, " ").trim().slice(0, JUDGE_THINKING_CHARS);
			return thinking ? { role: t.role, text, thinking } : { role: t.role, text };
		})
		.filter((t) => t.text.length > 0 || (t.thinking?.length ?? 0) > 0);
	return cleaned.slice(-limit);
}

/** The window as the judge reads it. Speaker labels, newest last, no timestamps: the question is what
 *  moved over this stretch, and the clock is already handled by the kernel's integration. Thinking is
 *  labelled as such, because a reader that cannot tell the inner note from the spoken one will rate the
 *  companion's frustrations as if the user had heard them. */
export function judgeTranscript(window: JudgeTurn[]): string {
	return window
		.flatMap((t) => {
			const who = t.role === "user" ? "User" : "Companion";
			const lines: string[] = [];
			if (t.thinking) lines.push(`${who} (thinking): ${t.thinking}`);
			lines.push(`${who}: ${t.text}`);
			return lines;
		})
		.join("\n");
}

/** The anchors the reading is asked in. Five rungs: short enough that a small model can hold all of
 * them in mind, long enough that "a little" and "clearly" are different answers. Shared by both
 * readers: the classifier question lists them as its scale, the chat prompt prints them as its legend. */
const CRITERIA = [
	"-2: clearly fell across this exchange",
	"-1: fell a little",
	"0: unchanged, or never came up",
	"+1: rose a little",
	"+2: clearly rose across this exchange",
];

/** The rung that means "nothing moved". A classifier scores on the level INDEX, so the answer is read
 * relative to this, not relative to zero. */
const JUDGE_CENTRE = (CRITERIA.length - 1) / 2;

/** One score question per channel, in the shape a System One classifier takes: an ordinal scale
 *  described rung by rung, answered as the probability-weighted index. The emotion name goes into the
 *  instruction because the classifier otherwise sees a bare key. */
export function judgeQuestions(): Record<string, { type: "score"; instructions: string; criteria: string[] }> {
	const out: Record<string, { type: "score"; instructions: string; criteria: string[] }> = {};
	for (const e of EMOTIONS) {
		out[e] = {
			type: "score",
			instructions:
				`Across this exchange, how did the COMPANION'S ${e} change? Judge the change from the start of ` +
				"the exchange to the end, not the level at the end. A feeling the USER expressed belongs to " +
				"the user, not the companion: it moves this score only if the transcript shows the companion " +
				"itself was moved (reacted, pulled back, or said so). Something this exchange never touched is 0.",
			criteria: CRITERIA,
		};
	}
	return out;
}

/** One channel's classifier answer: the expected rung plus how sure the model is about it. */
export interface JudgeScore {
	score: number;
	confidence: number;
}

/** Below this, the distribution is close to flat and the answer is a guess. Five rungs at total
 *  indifference put the top level at 0.2, so this drops only readings that carry no information — the
 *  failure mode of the keyword table this replaced, except confident. */
export const JUDGE_MIN_CONFIDENCE = 0.25;

/** Classifier answers -> the same -2..+2 deltas the chat reader produces, so one activation path serves
 *  both. The expectation is read to half a rung: a distribution split between "-2" and "-1" is a reading
 *  of about -1.5, which is real information, while the difference between -1.4 and -1.6 is the model's
 *  own rounding. Quantising also makes an answer of "essentially the centre" exactly 0, so it drops out
 *  instead of arriving as a delta of -0.0000001. Channels with nothing to say are absent. */
export function judgeDeltasFromScores(scores: Partial<Record<Emotion, JudgeScore>>): Partial<Record<Emotion, number>> {
	const out: Partial<Record<Emotion, number>> = {};
	for (const e of EMOTIONS) {
		const answer = scores[e];
		if (!answer || !Number.isFinite(answer.score) || answer.confidence < JUDGE_MIN_CONFIDENCE) continue;
		const raw = Math.max(-JUDGE_SCALE, Math.min(JUDGE_SCALE, answer.score - JUDGE_CENTRE));
		const d = Math.round(raw * 2) / 2;
		if (d !== 0) out[e] = d;
	}
	return out;
}

/** The same reading asked of a plain chat model, in one shot: small classifiers are not always
 * configured, and a short JSON answer is well within any cheap model's ability. The transcript is
 * appended by the caller. */
export function judgePrompt(): string {
	return [
		"You read a dialogue between a User and a Companion and report how the Companion's feelings moved.",
		"",
		"First read the USER's tone across this exchange - but report nothing about it. Then answer only",
		"about the COMPANION, from the companion's side: a feeling the user expressed belongs to the user,",
		"and moves the companion's channel only if the exchange shows the companion itself was moved.",
		"",
		`For each emotion below, answer with an integer from -${JUDGE_SCALE} to +${JUDGE_SCALE}:`,
		CRITERIA.join("\n"),
		"",
		"Judge change, not absolute strength: what was not touched by this exchange is 0.",
		"Reply with exactly one JSON object and nothing else, with these keys:",
		EMOTIONS.map((e) => `"${e}": 0`).join(", "),
	].join("\n");
}

/** One number per channel, out of range clamped, non-answers treated as "no change". */
export function judgeDeltas(raw: Partial<Record<Emotion, unknown>>): Partial<Record<Emotion, number>> {
	const out: Partial<Record<Emotion, number>> = {};
	for (const e of EMOTIONS) {
		const v = raw[e];
		const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
		if (!Number.isFinite(n)) continue;
		const d = Math.max(-JUDGE_SCALE, Math.min(JUDGE_SCALE, Math.round(n)));
		if (d !== 0) out[e] = d;
	}
	return out;
}

/**
 * Deltas -> kernel activations, with three published anchors (header note 4):
 * falls route to the opponent channel (note 2), a fall weighs JUDGE_NEGATIVITY_BIAS times a rise
 * (Baumeister et al. 2001; Rozin & Royzman 2001), and a per-channel confidence attenuates the
 * activation (Spearman 1904's attenuation logic: unreliable testimony is discounted).
 *
 * Two readings on one axis are the SAME axis: joy +1 and sadness -1 both mean "more joy", so they take
 * the larger of the two rather than summing. Without that, agreeing with yourself about a change would
 * double the size of it.
 */
export function judgeActivations(
	deltas: Partial<Record<Emotion, number>>,
	confidences?: Partial<Record<Emotion, number>>,
): Partial<EmotionVector> {
	const out: Partial<EmotionVector> = {};
	for (const [channel, d] of Object.entries(deltas) as Array<[Emotion, number]>) {
		const target = d > 0 ? channel : oppositeEmotion(channel);
		// What carries the asymmetry is the FALL itself (a negative event), wherever the antipode
		// routing then puts the activation.
		const gain = d > 0 ? JUDGE_GAIN / JUDGE_NEGATIVITY_BIAS : JUDGE_GAIN;
		const confidence = confidences?.[channel];
		const magnitude = Math.min(1, (Math.abs(d) / JUDGE_SCALE) * gain * (confidence ?? 1));
		if (magnitude > (out[target] ?? 0)) out[target] = magnitude;
	}
	return out;
}

/** Parse the chat-model reply: the first JSON object in the text, since small models like to wrap it. */
export function parseJudgeReply(text: string): Partial<Record<Emotion, unknown>> {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	return parsed as Partial<Record<Emotion, unknown>>;
}

export interface JudgeDueOptions {
	/** Reply tokens the companion has emitted since the last reading. Measured on what it OUTPUT rather
	 *  than on wall-clock time or on what the user typed: a user's message length is nothing you can
	 *  predict, and ten minutes of silence is not a conversation that has said anything. */
	outputTokens: number;
	/** Thinking tokens over the same stretch. Only counted when the reader will get thinking in its
	 *  window, which is the decision-model tier. */
	thinkingTokens: number;
	/** Whether the reader that would be asked reads the companion's reasoning too. */
	readsThinking: boolean;
	/** User turns since then. */
	userTurns: number;
	minTokens?: number;
	minUserTurns?: number;
}

/**
 * Is there enough new exchange for a reading to say anything?
 *
 * Two gates, guarding different things. The token count is the VOLUME gate: it is what makes a reading
 * worth taking, and it replaces a cooldown because a companion talked to for four hours should be read
 * more often than one left quiet for four hours. Which tokens count, and how many are needed, follows
 * the window the reader will get — a decision model is handed the reasoning as well and is charged for
 * none of it, so its gate is thinking plus reply at ten times the number. The turn count is the OVERLAP
 * gate: the window is the last N turns, so without it a long reply to the same message would be
 * appraised again on the next turn, and the same event would count twice.
 */
export function judgeDue(opts: JudgeDueOptions): boolean {
	const total = opts.readsThinking ? opts.outputTokens + opts.thinkingTokens : opts.outputTokens;
	const minTokens = opts.minTokens ?? (opts.readsThinking ? JUDGE_MIN_CLASSIFIER_TOKENS : JUDGE_MIN_OUTPUT_TOKENS);
	const minTurns = opts.minUserTurns ?? JUDGE_MIN_USER_TURNS;
	return total >= minTokens && opts.userTurns >= minTurns;
}
