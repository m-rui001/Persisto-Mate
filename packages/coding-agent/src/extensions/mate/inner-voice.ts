/**
 * The model's inner voice: the two standalone calls the heartbeat makes — an idle thought and a
 * dream. Both are SMALL self-contained calls (guidance + state hints, no conversation history), so
 * they are cheap by construction, and both write NOTHING into the session transcript: a thought
 * that appended itself to the history would balloon the prefix twenty times a day. Their products
 * live where inner life lives — the observations ring, the habituation store, a private memory.
 */

import type { Emotion, Lang, MateState, MemoryGraph } from "@earendil-works/pi-mate";
import { companionGuidance, HABITUATION_TAU, linesFor, topNodes } from "@earendil-works/pi-mate";
import type { ExtensionContext } from "../../core/extensions/types.ts";

/** How long an inner-voice call may take before it is dropped — these are background musings. */
const TIMEOUT_MS = 30_000;

/** A short thought, never an essay: the ring renders 90 chars and the cadence is frequent. */
const MAX_THOUGHT_CHARS = 240;

/**
 * How wide the hint pool rotates, and how many hints a call gets. The old top-3 could be owned
 * outright by one strong thread — a store where the same two or three subjects hold the top seats
 * made "rotation" moot because the LLM hint path never rotated at all. A wider window plus rotation
 * gives the model's own sampling somewhere to go. Sampling breadth, not a dynamics constant.
 */
const HINT_WINDOW = 8;
const HINT_COUNT = 3;

/**
 * The hint pool for an inner-voice call. Rotated by `state.counters.observations` — the decision
 * counter, which advances once per thought actually KEPT, so consecutive thoughts enter the pool at
 * different seats instead of always reading the same front (the kernel's seed rotation uses it too).
 *
 * Two channels of the echo loop are cut here, because both fed the machine's own output back as the
 * next thought's input — the user's memory.json shows the result ("第二次冒出来" → ponder → memory →
 * hint → "第三次冒头"):
 *   - the observations ring is NOT a hint (the state block already carries the last thought for
 *     continuity); a dream still gets it via `withObservations`, because a dream is exactly where
 *     the day's residues belong;
 *   - a private note written inside one habituation window IS the previous thought — the response
 *     was emitted (Groves & Thompson 1970) — so it cools off before it may hint again. Older
 *     private notes and non-private memories hint normally.
 */
export function hintsOf(
	memory: MemoryGraph,
	state: MateState,
	exclude: string[] = [],
	withObservations = false,
): string[] {
	const pool = topNodes(memory, state.t, HINT_WINDOW);
	const start = pool.length > 0 ? state.counters.observations % pool.length : 0;
	const rotated = [...pool.slice(start), ...pool.slice(0, start)];
	const labels = rotated
		.map((key) => memory.nodes[key])
		.filter((n) => n?.label && !(n.private && state.t - n.t < HABITUATION_TAU))
		.slice(0, HINT_COUNT)
		.map((n) => n.label);
	const obs = withObservations ? state.observations.slice(-2).filter((o) => !exclude.includes(o)) : [];
	return [...labels, ...obs];
}

/**
 * One idle thought. The model decides WHAT to think about (the hints are offers, not orders) and
 * tags the subjects, so the habituation store keeps learning what has been circling. `exclude`
 * carries the impulse just voiced to the user: serving it straight back as a hint is how the same
 * sentence used to come back as the next impulse.
 */
export async function authorThought(
	ctx: ExtensionContext,
	lang: Lang,
	state: MateState,
	memory: MemoryGraph,
	exclude: string[] = [],
): Promise<{ text: string; topics: string[] } | null> {
	const model = ctx.model;
	if (!model) return null;
	const L = linesFor(lang);
	const hints = hintsOf(memory, state, exclude);
	const user = [L.thoughtInstruction, hints.length ? `${L.thoughtHints}: ${hints.join(" | ")}` : ""]
		.filter(Boolean)
		.join("\n");
	const reply = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: companionGuidance(lang),
			messages: [{ role: "user", content: user, timestamp: Date.now() }],
		},
		{ timeoutMs: TIMEOUT_MS },
	);
	if (reply.stopReason !== "stop" && reply.stopReason !== "length") return null;
	const text = replyText(reply.content).trim().slice(0, MAX_THOUGHT_CHARS);
	if (!text) return null;
	const topics = [...text.matchAll(/#([^\s#,，。]+)/g)].map((m) => m[1]).slice(0, 2);
	return {
		text: text
			.replace(/#[^\s#,，。]+/g, "")
			.replace(/\s+/g, " ")
			.trim(),
		topics,
	};
}

/**
 * One dream, from the day's real residues. The same call carries the affect reading — REM
 * reprocesses the day at low noradrenaline, so the night's dreams and the night's emotional
 * accounting are one act, not two.
 */
export async function authorDream(
	ctx: ExtensionContext,
	lang: Lang,
	state: MateState,
	memory: MemoryGraph,
): Promise<{ text: string; deltas: Partial<Record<Emotion, number>> } | null> {
	const model = ctx.model;
	if (!model) return null;
	const L = linesFor(lang);
	// A dream wants the day's residues, the observation ring included (see hintsOf).
	const fragments = hintsOf(memory, state, [], true);
	if (fragments.length === 0) return null;
	const user = [L.dreamInstruction, "", `${L.dreamFragments}:`, ...fragments.map((f) => `- ${f}`)].join("\n");
	const reply = await ctx.modelRegistry.complete(
		model,
		{
			systemPrompt: companionGuidance(lang),
			messages: [{ role: "user", content: user, timestamp: Date.now() }],
		},
		{ timeoutMs: TIMEOUT_MS },
	);
	if (reply.stopReason !== "stop" && reply.stopReason !== "length") return null;
	const text = replyText(reply.content).trim();
	if (!text) return null;
	const parsed = parseDream(text);
	return { text: parsed.dream || text, deltas: parsed.deltas };
}

/** The dream answer is one JSON object; a model that answered in prose still dreamed — no deltas. */
function parseDream(text: string): { dream: string; deltas: Partial<Record<Emotion, number>> } {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return { dream: text, deltas: {} };
	try {
		const parsed = JSON.parse(text.slice(start, end + 1)) as {
			dream?: unknown;
			deltas?: Record<string, unknown>;
		};
		const dream = typeof parsed.dream === "string" ? parsed.dream : text;
		const deltas: Partial<Record<Emotion, number>> = {};
		for (const [k, v] of Object.entries(parsed.deltas ?? {})) {
			if (typeof v === "number" && Number.isFinite(v)) deltas[k as Emotion] = Math.max(-2, Math.min(2, v));
		}
		return { dream, deltas };
	} catch {
		return { dream: text, deltas: {} };
	}
}

function replyText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
		.join(" ");
}
