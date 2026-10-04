/**
 * The judge: an outside read of a stretch of exchange, made by a small cheap model.
 *
 * Why a second reader at all. Affect reaches the kernel by two paths, and they cover each other's
 * blind spot:
 *
 *   - `feel` (the tool): the companion reports what it felt about ONE message. Precise, first-person,
 *     and it costs an interrupted turn every time — which is exactly why a model skips it, so long
 *     quiet stretches integrate with no affect at all and the drift goes unrecorded.
 *   - the judge: something outside the conversation reads the last N turns and says what moved. It
 *     cannot be skipped, it runs while the companion is idle, and it never interrupts a reply.
 *
 * Three decisions in here, each of which is the whole design:
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
 *   3. THE JUDGE MAY NOT OUT-SHOUT THE COMPANION. JUDGE_GAIN caps the strongest possible reading at
 *      half a channel. A model that felt something about a message writes it up to 1.0 itself; a
 *      background reader that could write bigger numbers would be an outside opinion about your own
 *      feelings winning over the person having them.
 *
 * The model call itself is NOT here: this module is pure (window selection, question authoring, answer
 * parsing, delta arithmetic) so the semantics are unit-testable without a network. The extension host
 * does the calling; see packages/coding-agent/src/extensions/mate/judge-run.ts.
 */

import { EMOTIONS, type Emotion, type EmotionVector } from "./types.ts";

/** A turn of dialogue as the judge sees it. Role is deliberately coarse: the judge reads who spoke,
 * not the harness's message taxonomy. */
export interface JudgeTurn {
	role: "user" | "assistant";
	text: string;
}

/** How many recent turns a judge window may hold, and how much of each one. Small context is the
 * point of using a cheap model; a long transcript also makes the -2..+2 judgement about the whole
 * stretch instead of about what just happened. */
export const JUDGE_MAX_TURNS = 10;
export const JUDGE_TURN_CHARS = 320;

/** The judge answers one comparative question per channel on this ladder. */
export const JUDGE_SCALE = 2;

/** A full-scale reading (+2 or -2 on one channel) becomes this much activation: half of what the
 * companion may report for itself, so the outside read colours the state without overruling it. */
export const JUDGE_GAIN = 0.5;

/** Restraint, not cost: one reading per exchange is enough, and repeated readings of overlapping
 * windows would count the same event twice. */
export const JUDGE_COOLDOWN_MS = 10 * 60_000;

/** Below this much new conversation there is nothing to read, and the window would be mostly the
 * previous, already-judged stretch. */
export const JUDGE_MIN_USER_TURNS = 3;

/** Plutchik's antipode: the wheel order in EMOTIONS puts opposites exactly 4 apart. */
export function oppositeEmotion(e: Emotion): Emotion {
	return EMOTIONS[(EMOTIONS.indexOf(e) + 4) % EMOTIONS.length];
}

/** The last `limit` turns, each truncated to one line's worth of text, empties dropped. */
export function judgeWindow(turns: JudgeTurn[], limit: number = JUDGE_MAX_TURNS): JudgeTurn[] {
	const cleaned = turns
		.map((t) => ({ role: t.role, text: t.text.replace(/\s+/g, " ").trim().slice(0, JUDGE_TURN_CHARS) }))
		.filter((t) => t.text.length > 0);
	return cleaned.slice(-limit);
}

/** The window as the judge reads it. Speaker labels, newest last, no timestamps: the question is what
 * moved over this stretch, and the clock is already handled by the kernel's integration. */
export function judgeTranscript(window: JudgeTurn[]): string {
	return window.map((t) => `${t.role === "user" ? "User" : "Companion"}: ${t.text}`).join("\n");
}

/** The anchors the reading is asked in. Five rungs: short enough that a small model can hold all of
 * them in mind, long enough that "a little" and "clearly" are different answers. */
const CRITERIA = [
	"-2: clearly fell across this exchange",
	"-1: fell a little",
	"0: unchanged, or never came up",
	"+1: rose a little",
	"+2: clearly rose across this exchange",
];

/** The same reading asked of a plain chat model, in one shot: small classifiers are not always
 * configured, and a short JSON answer is well within any cheap model's ability. The transcript is
 * appended by the caller. */
export function judgePrompt(): string {
	return [
		"You read a dialogue between a User and a Companion and report how the Companion's feelings moved.",
		"",
		`For each emotion below, answer with an integer from -${JUDGE_SCALE} to +${JUDGE_SCALE}:`,
		CRITERIA.join("\n"),
		"",
		"Answer only about the COMPANION, from the companion's side of the exchange. Judge change, not",
		"absolute strength: what was not touched by this exchange is 0.",
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
 * Deltas -> kernel activations, with falls routed to the opponent channel (see header note 2).
 *
 * Two readings on one axis are the SAME axis: joy +1 and sadness -1 both mean "more joy", so they take
 * the larger of the two rather than summing. Without that, agreeing with yourself about a change would
 * double the size of it.
 */
export function judgeActivations(deltas: Partial<Record<Emotion, number>>): Partial<EmotionVector> {
	const out: Partial<EmotionVector> = {};
	for (const [channel, d] of Object.entries(deltas) as Array<[Emotion, number]>) {
		const target = d > 0 ? channel : oppositeEmotion(channel);
		const magnitude = (Math.abs(d) / JUDGE_SCALE) * JUDGE_GAIN;
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
	now: number;
	/** When the last reading was taken (0 if never). */
	lastAt: number;
	/** User turns since then. */
	userTurns: number;
	cooldownMs?: number;
	minUserTurns?: number;
}

/** Is there enough new conversation, and has enough time passed, for a reading to say anything? */
export function judgeDue(opts: JudgeDueOptions): boolean {
	const cooldown = opts.cooldownMs ?? JUDGE_COOLDOWN_MS;
	const minTurns = opts.minUserTurns ?? JUDGE_MIN_USER_TURNS;
	return opts.now - opts.lastAt >= cooldown && opts.userTurns >= minTurns;
}
