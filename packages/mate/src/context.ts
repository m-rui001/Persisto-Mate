/**
 * Context assembly (MATE step 5): what the LLM is shown of its own inner life.
 *
 * There are TWO surfaces, split on purpose (P5 — prompt caching; P2 — the old single 73-token
 * projection was an information bottleneck that starved the mind):
 *
 *   - `stableContext`: identity, personality, core character, and the memory-graph summary. This
 *     changes slowly (personality is fixed per message and drifts weekly; character is nurture, not
 *     mood; the graph summary is top-by-strength so it edits rarely), so it rides a CACHED system
 *     prompt section and is paid for once, not per turn.
 *
 *   - `stateContext`: the VOLATILE per-turn delta — the clock, mood, emotions, drives, relationship,
 *     impulse, the reply inclination, and the specific memories this message recalls. Small and
 *     always-fresh, so it rides the ephemeral `context` tail and never bloats the cache.
 *
 * Because the heavy stuff is now cached, the volatile tail is FREE to be richer than the old
 * ~73-token budget: it can actually describe the state (P2) without every token being re-paid on
 * every message forever. Quantise + name-don't-number still apply — the block is felt, not narrated.
 * Private thoughts never render their text in either projection; only belief strengths surface.
 *
 * LANGUAGE: both surfaces take `lang`, which changes LABELS ONLY. Thresholds, ordering, values and the
 * whole affective computation are language-independent, so a Chinese companion feels precisely what the
 * English one feels. This matters more than it sounds: the projection is the mind's mirror, and a
 * mirror in English produces an inner voice in English (see i18n.ts for the reasoning).
 */

import type { ReplyInclination } from "./daemon.ts";
import {
	beliefGloss,
	emotionGloss,
	feelGloss,
	fmtDur,
	kv,
	type Lang,
	leanGloss,
	linesFor,
	moodGloss,
	traitGloss,
} from "./i18n.ts";
import {
	boredomOf,
	burstOf,
	DRIFTING_TRAITS,
	drowsinessOf,
	energyOf,
	netEmotions,
	noticeThreshold,
	perceivedDuration,
	temporalMood,
} from "./kernel.ts";
import { type MemoryGraph, summary as memorySummary, type RecallHit } from "./memory.ts";
import { strengthOf } from "./spark.ts";
import { EMOTIONS, type MateState, type PAD } from "./types.ts";

export interface ContextOptions {
	/** Local wall clock for the turn, epoch ms. */
	now?: number;
	/** Timezone label, e.g. "Asia/Shanghai". */
	tz?: string;
	/** Include the catch-up gap note (set after a powered-off boot). */
	gapLabel?: string;
	/** Advisory reply inclination for THIS inbound message (P1: a signal to the model, not a gate). */
	inclination?: ReplyInclination;
	/** Specific memories this message recalls (P4), surfaced in the volatile tail. */
	recall?: RecallHit[];
	/** One-line notices about meta-actions the user just performed (e.g. ran /tree). Rendered once,
	 * then gone — they describe what happened, not a lasting state. */
	notes?: string[];
	/** A one-line open/close summary for THIS body (see session.ts): when it woke, how often today. */
	session?: string;
	/** Max characters for the whole block; the projector trims lowest-signal channels first. */
	maxChars?: number;
	/** Prompt language for the labels (default "en"). Never affects a number or an ordering. */
	lang?: Lang;
}

/** Options for the stable, cacheable prefix. */
export interface StableContextOptions {
	/** Display name. The kernel does not store the name (a host concern), so it is passed in. */
	name?: string;
	/** The memory store to summarise; omit for a companion with no memories. */
	memory?: MemoryGraph;
	/** Cap on memories shown in the summary. */
	memoryNodes?: number;
	/** Max characters for the whole block. */
	maxChars?: number;
	/** Prompt language for the labels (default "en"). */
	lang?: Lang;
}

/** Lookup form of kernel.DRIFTING_TRAITS, so the per-trait filter stays a set probe. */
const DRIFTING_TRAIT_SET: ReadonlySet<string> = new Set(DRIFTING_TRAITS);

/** Round to 2 decimals and drop trailing zero, e.g. 0.40 -> ".4". */
function q(x: number): string {
	const r = Math.round(x * 100) / 100;
	return r.toFixed(2).replace(/^0/, "").replace(/0$/, "").replace(/\.$/, "") || "0";
}

/**
 * The emotions as FELT: raw activation minus the opponent-process counter-swing. This is what mood
 * is computed from (kernel.padCentreFromRho takes the net vector), so displaying anything else puts
 * the state block at odds with itself — the mind reads "悲伤.96" next to a flat mood and cannot tell
 * which one is lying. The raw A-process is a mechanism; the net is the experience.
 */
function feltEmotions(state: MateState): Record<string, number> {
	return netEmotions(state.emotions, state.opponent);
}

/** Top-N non-trivial channels, as bare names sorted by magnitude. Name-don't-number: a float like
 * "悲伤.96" tells the model nothing it can act on (the user's critique), so the model-facing block
 * carries the names and their ORDER, and the values live behind /debug. */
function topChannels(values: Record<string, number> | object, floor: number, n: number, lang: Lang): string {
	return Object.entries(values as Record<string, number>)
		.filter(([, v]) => typeof v === "number" && v >= floor)
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k]) => emotionGloss(k, lang))
		.join(" ");
}

/**
 * The drives as a short clause per drive past its band; a drive inside its band is omitted entirely.
 * The user's critique, in full: a float like 烦0.78 is meaningless to the model, and so is a channel
 * sitting in its normal range — so normal is SILENCE, and deviation is words.
 *
 * The band line is 0.6, the urge threshold daemon.generateThoughts already gates expression and
 * boredom with; no new constant is introduced. Rest is tiered by the sleep gate (drowsinessOf) rather
 * than the reservoir, because drowsiness is what a body actually feels: halfway to the gate is "getting
 * drowsy", at the gate is sleep winning. Boredom is derived at `now` (see boredomOf).
 */
function drivesClause(state: MateState, now: number, lang: Lang): string {
	const L = linesFor(lang);
	const d = state.drives;
	const parts: string[] = [];
	if (d.connection >= 0.6) parts.push(L.driveMissing);
	if (d.curiosity >= 0.6) parts.push(L.driveCurious);
	if (d.expression >= 0.6) parts.push(L.driveExpressive);
	if (d.growth >= 0.6) parts.push(L.driveGrowing);
	if (boredomOf(state, now) >= 0.6) parts.push(L.driveBored);
	const drowsy = drowsinessOf(state, now);
	if (drowsy >= 1) parts.push(L.driveSleepGate);
	else if (drowsy >= 0.5) parts.push(L.driveDrowsy);
	return parts.join(L.sep);
}

/** The mood branch this state sits in; the WORD is chosen per language from the branch. */
function moodKey(m: PAD): string {
	const { p, a } = m;
	if (p > 0.4 && a > 0.3) return "buoyant";
	if (p > 0.4) return "warm";
	if (p > 0.1) return "settled";
	if (p > -0.2 && a > 0.4) return "wired";
	if (p > -0.2) return "flat";
	if (a > 0.4) return "agitated";
	if (a < -0.2) return "low";
	return "heavy";
}

/** One-word mood gloss, so the LLM has a handle it can speak to without doing arithmetic. */
function moodWord(m: PAD, lang: Lang): string {
	return moodGloss(moodKey(m), lang);
}

/**
 * Core character traits, rendered as name.value with a floor so only the pronounced ones show.
 *
 * Only DRIFTING_TRAITS are rendered: a trait nothing ever writes is a constant, and a constant in the
 * "who I am" block reads as something experience shaped when it never moved. The fixed traits still
 * do their work (tolerance stretches perceived silence, impulsivity scales the proactive budget) —
 * their effects appear in the numbers those systems emit, not as a second personality layer here.
 */
function topTraits(
	ch: MateState["character"],
	floor = 0.55,
	n = 8,
	lang: Lang = "en",
	drifting: ReadonlySet<string> = DRIFTING_TRAIT_SET,
): string {
	return (
		Object.entries(ch)
			.filter(([k, v]) => drifting.has(k) && typeof v === "number" && (v >= floor || v <= 1 - floor))
			.sort((a, b) => Math.abs(b[1] - 0.5) - Math.abs(a[1] - 0.5))
			.slice(0, n)
			.map(([k, v]) => `${traitGloss(k, lang)} ${q(v)}`)
			// Chinese separates with a space: an ASCII comma between CJK labels costs a token and reads as noise.
			.join(lang === "zh" ? " " : ", ")
	);
}

/**
 * Top SPARK beliefs by strength, as "label.confidence" tokens. Only beliefs with real evidence
 * strength render: a fresh companion's seed beliefs sit at strength 0 and stay invisible until
 * experience firms them up.
 */
function topBeliefs(state: MateState, n: number, lang: Lang): string {
	return Object.values(state.beliefs)
		.map((b) => ({ b, s: strengthOf(b) }))
		.filter(({ s }) => s >= 0.15)
		.sort((x, y) => y.s - x.s || (x.b.key < y.b.key ? -1 : 1))
		.slice(0, n)
		.map(({ b }) => `${beliefGloss(b, lang)} ${q(b.confidence)}`)
		.join(lang === "zh" ? " " : ", ");
}

/** Stored drives plus the DERIVED boredom signal, so the projection renders the full motivational
 * picture. Boredom is computed at `now` — during a long silence it climbs even though the stored
 * drives only move when the kernel transitions. */
function drivesForDisplay(state: MateState, now: number): Record<string, number> {
	return { ...state.drives, boredom: boredomOf(state, now) };
}

/**
 * The STABLE, cacheable prefix: who I am (identity + personality + core character) plus the slow
 * memory-graph summary. Emits ONLY content that changes on the timescale of days, so prompt caching
 * holds across long stretches of conversation (P5). The volatile per-turn delta is NOT here; that
 * rides `stateContext`.
 *
 * The caller wraps this in a cached system-prompt section, which supplies the <mate_core> tags — the
 * block does not wrap itself, so the model sees one tag, not two. Everything here is deliberately
 * day-scale: a counter that moves on every message belongs to the volatile tail, because one number
 * that changes per turn would re-emit the whole prefix every turn.
 */
export function stableContext(state: MateState, opts: StableContextOptions = {}): string {
	const p = state.personality;
	const lang: Lang = opts.lang ?? "en";
	const L = linesFor(lang);
	const lines: string[] = [];

	// Identity: name + how long this self has existed (continuity of being). The message count is
	// NOT here — it is per-turn volatile and rides the <mate> block instead (see stateContext).
	const days = Math.max(0, Math.floor((state.t - state.born) / 86_400_000));
	lines.push(L.identity(opts.name ?? "mate", days));

	// Personality (Big Five): fixed per message, drifts only weekly → cacheable.
	lines.push(kv(L.nature, `O${q(p.o)} C${q(p.c)} E${q(p.e)} A${q(p.a)} N${q(p.n)}`, lang));

	// Character (SOUL): the nurture layer, only the pronounced traits.
	const traits = topTraits(state.character, 0.55, 8, lang);
	if (traits) lines.push(kv(L.character, traits, lang));

	// SPARK beliefs (section 3.9): the persistent evaluative layer. Slow-moving by construction, so
	// it belongs in the cached prefix.
	const beliefs = topBeliefs(state, 3, lang);
	if (beliefs) lines.push(kv(L.beliefs, beliefs, lang));

	// Baseline disposition: the slow PAD set-point the mood oscillates around.
	const b = state.allostasis.baselineShift;
	lines.push(kv(L.baseline, `${q(b.p)},${q(b.a)},${q(b.d)}`, lang));

	// Memory summary: the memories the model chose to keep, top by strength. Changes slowly.
	if (opts.memory) {
		const summary = memorySummary(opts.memory, {
			nodes: opts.memoryNodes ?? 12,
			lang,
		});
		if (summary) lines.push(summary);
	}

	const body = lines.join("\n");
	const max = opts.maxChars ?? 2400;
	return body.length <= max ? body : `${body.slice(0, max - 2)}…`;
}

/**
 * The VOLATILE per-turn delta. Richer than the old ~73-token budget now that the heavy content is
 * cached (P2): the mind can actually see its own state each turn. Still quantised and terse, because
 * this rides every LLM call in a run — it is felt, not narrated. The model turns it into behaviour;
 * it is never read back verbatim.
 */
export function stateContext(state: MateState, opts: ContextOptions = {}): string {
	const now = opts.now ?? state.t;
	const lang: Lang = opts.lang ?? "en";
	const L = linesFor(lang);
	const gap = now - state.lastInteraction;
	const perceived = perceivedDuration(state, gap);
	const temporal = feelGloss(temporalMood(perceived), lang);
	const tz = opts.tz;
	const clock = new Date(now);
	const hhmm = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;

	const emo = topChannels(feltEmotions(state), 0.1, 5, lang);

	const lines: string[] = [];
	// Whose state this is. The block is prepended to the newest message, so this attribution has to
	// live HERE, at the point of misreading — a companion that read its own rest drive as the user's
	// sleepiness and said goodnight to them is the failure this line exists for.
	lines.push(L.stateHeader);

	// Time metadata: the user explicitly wants the companion to see time. Kept to one line.
	const timeBits = [L.now(hhmm)];
	if (tz) timeBits.push(tz);
	timeBits.push(L.silent(fmtDur(gap, lang), temporal));
	if (opts.gapLabel) timeBits.push(L.wokeAfter(opts.gapLabel));
	lines.push(kv(L.time, timeBits.join(L.sep), lang));

	// Open/close awareness: when THIS body was woken, how often today, when it last closed (session.ts).
	// Distinct from the message gap above — this is PROCESS lifetime, not conversation silence.
	if (opts.session) lines.push(kv(L.body, opts.session, lang));

	// Mood: the word, then the felt channels as bare names. The PAD triple and the per-channel
	// magnitudes are /debug material — the model feels the word and reads the rank order.
	lines.push(`${kv(L.mood, moodWord(state.mood, lang), lang)}${emo ? ` | ${emo}` : ""}`);

	// Drives: a clause per drive past its band, silence for the rest (see drivesClause).
	const drives = drivesClause(state, now, lang);
	if (drives) lines.push(kv(L.drives, drives, lang));

	// Relationship + self. These are the slow anchors and keep their numbers; only frustration is
	// tiered, because it is the one channel here that swings within a conversation (its display floor
	// 0.2 and the cold-ending gate 0.5 are this codebase's own thresholds).
	const rel = state.relationship;
	lines.push(
		kv(
			L.us,
			[
				kv(L.trust, q(rel.trust), lang),
				kv(L.close, q(rel.attachment), lang),
				kv(L.respect, q(rel.respect), lang),
				rel.frustration >= 0.5 ? L.frustHigh : rel.frustration > 0.2 ? L.frustSome : "",
				rel.unanswered ? L.ignored(rel.unanswered) : "",
			]
				.filter(Boolean)
				.join(" "),
			lang,
		),
	);
	const ch = state.character;
	lines.push(
		kv(
			L.self,
			[
				kv(L.said, q(state.counters.messages), lang),
				kv(L.worth, q(ch.selfWorth), lang),
				kv(L.ease, q(ch.selfEfficacy), lang),
				kv(L.anxious, q(ch.attachmentAnxiety), lang),
				kv(L.tired, q(state.allostasis.fatigue), lang),
			].join(" "),
			lang,
		),
	);

	// Communication energy, tiered: only the deviations speak. Low energy mutes the voice; a burst
	// past sendStyle's fragmenting threshold (0.62) wants several short messages. Mid energy, and the
	// coherence/entropy diagnostics of the density matrix, say nothing the model can act on and are
	// left to /debug.
	const comm = [energyOf(state) < 0.3 ? L.energyLow : "", burstOf(state) >= 0.62 ? L.burstHigh : ""]
		.filter(Boolean)
		.join(L.sep);
	if (comm) lines.push(kv(L.impulse, comm, lang));

	// P1: the reply inclination is a SIGNAL the model reads and may overrule — not a decision made for it.
	if (opts.inclination) {
		const inc = opts.inclination;
		lines.push(kv(L.inclination, L.inclinationLine(leanGloss(inc.lean, lang), inc.reason), lang));
	}

	// P4: specific memories this message stirred, surfaced ephemerally (the summary lives in the cache).
	if (opts.recall?.length) {
		const hits = opts.recall
			.slice(0, 5)
			.map((h) => h.label)
			.join(L.sep);
		lines.push(kv(L.recalled, hits, lang));
	}

	// Meta-actions the user just performed on the harness (rewound, switched, ran a command). The
	// model sees WHAT happened; the guidance explains what it means, once.
	for (const note of opts.notes ?? []) lines.push(note);

	// The single most recent self-observation, if any: continuity of inner life across turns.
	const lastObs = state.observations[state.observations.length - 1];
	if (lastObs) lines.push(kv(L.lastThought, truncate(lastObs, 90), lang));

	const body = `<mate>\n${lines.join("\n")}\n</mate>`;
	const max = opts.maxChars ?? 1400;
	return body.length <= max ? body : `${body.slice(0, max - 12)}\n…\n</mate>`;
}

/**
 * A smaller projection meant for background/autonomous runs where we still want affect but every
 * token counts even more. Roughly half the size of stateContext, and tiered the same way: words for
 * what deviates, silence for what sits in band.
 */
export function minimalContext(state: MateState, opts: ContextOptions = {}): string {
	const lang: Lang = opts.lang ?? "en";
	const L = linesFor(lang);
	const now = opts.now ?? state.t;
	const temporal = feelGloss(temporalMood(perceivedDuration(state, now - state.lastInteraction)), lang);
	const emo = topChannels(feltEmotions(state), 0.15, 3, lang);
	const drives = drivesClause(state, now, lang);
	const low = energyOf(state) < 0.3 ? ` ${L.energyLow}` : "";
	const lines = [
		`${moodWord(state.mood, lang)}${emo ? ` ${emo}` : ""}`,
		drives ? `${L.drivesBare} ${drives}` : "",
		`${L.miniSilent(temporal)}${low}`,
	].filter(Boolean);
	return `<mate>${lines.join(" | ")}</mate>`;
}

/** Notice threshold for drive-delta self-observations, exposed for the daemon. */
export function driveNoticeThreshold(state: MateState): number {
	return noticeThreshold(state.personality.n);
}

/**
 * What the PUBLIC tier may reveal. This is the whitelist the status command and the transcript render
 * through; anything not named here is not user-visible by construction. Moods, drives and relationship
 * numbers are honest signals — the companion is open about how it feels. Deliberately NOT exposed:
 * character trait internals beyond a couple, the density matrix, the observations ring, the belief
 * store beyond the projected strengths, and the content of private thoughts.
 *
 * Emotions here are the FELT (net) values, the same ones mood is computed from and the same ones the
 * mind sees in its own state block: one number per feeling across every surface, or the companion
 * quotes one figure and feels another.
 */
export function publicView(state: MateState): Record<string, unknown> {
	const r2 = (x: number) => Math.round(x * 100) / 100;
	return {
		mood: { p: r2(state.mood.p), a: r2(state.mood.a), d: r2(state.mood.d) },
		emotions: Object.fromEntries(Object.entries(feltEmotions(state)).map(([k, v]) => [k, r2(v)])),
		drives: Object.fromEntries(
			Object.entries({ ...state.drives, boredom: boredomOf(state, state.t) }).map(([k, v]) => [k, r2(v)]),
		),
		relationship: { trust: r2(state.relationship.trust), attachment: r2(state.relationship.attachment) },
		time: { t: state.t, lastInteraction: state.lastInteraction, born: state.born },
	};
}

/**
 * The developer view (/debug): every number the model-facing block tiers away. This is the one
 * surface where the floats are the point — the drives with boredom, the felt emotions, the whole
 * relationship tensor, the awareness field, the habituation traces — so the user can see exactly
 * what the machine sees. Deliberately a separate surface from the model's block: the model reads
 * words; the developer reads numbers.
 */
export function debugView(state: MateState, now: number): string {
	const fmt = (rec: Record<string, number>) =>
		Object.entries(rec)
			.sort((a, b) => b[1] - a[1])
			.map(([k, v]) => `${k} ${q(v)}`)
			.join(", ");
	const rel = state.relationship;
	const allostasis = state.allostasis;
	const habit = Object.entries(state.habituation)
		.sort((a, b) => b[1].t - a[1].t)
		.map(([k, v]) => `${k} s${v.s.toFixed(2)}`)
		.join(", ");
	const lines = [
		`state.t: ${new Date(state.t).toISOString()} (now ${new Date(now).toISOString()})`,
		`mood: ${q(state.mood.p)}, ${q(state.mood.a)}, ${q(state.mood.d)} | surpriseEma ${q(state.surpriseEma)}${state.catastrophe ? " | CUSP" : ""}`,
		`emotions: ${fmt(feltEmotions(state))}`,
		`drives: ${fmt(drivesForDisplay(state, now))}`,
		`relationship: trust ${q(rel.trust)}, attachment ${q(rel.attachment)}, respect ${q(rel.respect)}, frustration ${q(rel.frustration)}, familiarity ${q(rel.familiarity)}, unanswered ${rel.unanswered}`,
		`awareness: ${fmt({ ...state.awareness })}`,
		`allostasis: fatigue ${q(allostasis.fatigue)}, load ${q(allostasis.load)}, baseline ${q(allostasis.baselineShift.p)}, ${q(allostasis.baselineShift.a)}, ${q(allostasis.baselineShift.d)}`,
		habit ? `habituation: ${habit}` : "",
		`counters: ${Object.entries(state.counters)
			.map(([k, v]) => `${k} ${v}`)
			.join(", ")}`,
		`observations: ${state.observations.length} kept, last: ${state.observations.at(-1) ?? "none"}`,
	].filter(Boolean);
	return lines.join("\n");
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/** Emotion channels, exported for the daemon's thinking loop. */
export { EMOTIONS };
