/**
 * The judge call: ask a cheap model what just moved, and put the answer into the companion's state.
 *
 * The reading itself — window size, the -2..+2 question, opponent routing, the gain cap — is pure and
 * lives in the kernel package (mate/judge.ts). This file is only the network half: resolve the model,
 * build the transcript, ask, parse, apply.
 *
 * Two things worth being explicit about:
 *
 *   - PRIVACY. A judge reading sends the last few turns of the exchange to a model outside this
 *     conversation. That is why the judge is OFF until the user names a model for it
 *     (`settings.mate.judgeModel`), and why the window holds only what the user and the companion said
 *     to each other: no tool output, no injected state block, no private notes, no thinking.
 *
 *   - WHY `complete()` AND NOT `classify()`. pi has a first-class classifier path
 *     (`modelRegistry.classify` with score questions, for providers like typesafe's JEV), and it is the
 *     better instrument: constrained decoding, per-answer confidence, no JSON to repair. But a
 *     classifier model has to be registered by an extension, none ships in the catalog here, and I am
 *     not writing an untested second path to look thorough. So there is one path, it works with any
 *     cheap chat model the user can name in `models.json`, and the answer is parsed by
 *     `parseJudgeReply`. Swapping it for `classify()` later is a change in this file only.
 */

import {
	EMOTIONS,
	type Emotion,
	type EmotionVector,
	emotionGloss,
	judgeActivations,
	judgeDeltas,
	judgePrompt,
	judgeTranscript,
	judgeWindow,
	type Lang,
	parseJudgeReply,
} from "@earendil-works/pi-mate";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { MateRuntime } from "./runtime.ts";

/** What the judge answered, for logging and tests. */
export interface JudgeReading {
	/** The window actually read. */
	turns: number;
	/** Per-channel change on the -2..+2 ladder; only channels that moved. */
	deltas: Partial<Record<Emotion, number>>;
	/** What those deltas became as kernel activations. */
	activations: Partial<EmotionVector>;
}

/** `provider/id`, as the user writes it in settings. */
export function parseModelRef(ref: string): { provider: string; id: string } | null {
	const i = ref.indexOf("/");
	if (i <= 0 || i === ref.length - 1) return null;
	return { provider: ref.slice(0, i).trim(), id: ref.slice(i + 1).trim() };
}

/**
 * The exchange as the judge sees it: what the user said and what the companion said back, in order.
 * Anything that is not plain speech — tool calls and results, injected state, private notes, model
 * thinking — is left in the session file, where it never leaves the machine.
 */
export function judgeTurns(ctx: ExtensionContext): Array<{ role: "user" | "assistant"; text: string }> {
	const out: Array<{ role: "user" | "assistant"; text: string }> = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text =
			typeof m.content === "string"
				? m.content
				: m.content
						.filter((p): p is { type: "text"; text: string } => p.type === "text")
						.map((p) => p.text)
						.join(" ");
		// A user message can be the harness talking, not the person: the injected state block and any
		// extension prompt are not part of what was said to each other.
		if (!text.trim()) continue;
		out.push({ role: m.role, text });
	}
	return out;
}

/**
 * Take one reading. Resolves to null when nothing was applied: no slot (one already in flight), too
 * little conversation, or the model answered in prose instead of numbers. Those are ordinary — a
 * companion that cannot get its feelings read from outside carries on with the feelings it reports
 * for itself, and must not be told otherwise every ten minutes. A reading that CANNOT be attempted is
 * not ordinary: the model string is malformed or no such model is registered. That goes to `onError`,
 * because a feature the user switched on and that then silently does nothing is indistinguishable
 * from a feature that was never built.
 */
export async function runAffectJudge(
	rt: MateRuntime,
	ctx: ExtensionContext,
	opts: { model: string; onError: (err: unknown) => void },
): Promise<JudgeReading | null> {
	if (!rt.takeJudgeSlot()) return null;
	try {
		const ref = parseModelRef(opts.model);
		if (!ref) throw new Error(`judgeModel "${opts.model}" is not "provider/id"`);
		const model = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!model) throw new Error(`judge model "${opts.model}" is not registered`);

		const window = judgeWindow(judgeTurns(ctx));
		if (window.filter((t) => t.role === "user").length === 0) return null;

		const reply = await ctx.modelRegistry.complete(model, {
			messages: [{ role: "user", content: `${judgePrompt()}\n\n${judgeTranscript(window)}`, timestamp: Date.now() }],
		});
		const text = reply.content
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join("");
		const deltas = judgeDeltas(parseJudgeReply(text));
		const activations = judgeActivations(deltas);
		rt.judgeRead(activations);
		return { turns: window.length, deltas, activations };
	} catch (err) {
		opts.onError(err);
		return null;
	} finally {
		rt.releaseJudgeSlot();
	}
}

/**
 * The judge as one line of host UI. It is not part of the companion's own surfaces: an outside reading
 * of the exchange is a mechanism the runtime runs, not a thought the companion had, so it is reported
 * to the user where the user can see it and never written into the state the model reads.
 */
export function judgeReadingLine(reading: JudgeReading, lang: Lang): string {
	const head = lang === "zh" ? "情绪判读" : "affect judge";
	const moved = EMOTIONS.flatMap((e): string[] => {
		const d = reading.deltas[e];
		return d ? [`${emotionGloss(e, lang)} ${d > 0 ? `+${d}` : d}`] : [];
	});
	return `${head} (${reading.turns}): ${moved.join(", ") || (lang === "zh" ? "无波动" : "no movement")}`;
}

/** The same line when the reading never happened: the reason, not a stack trace. */
export function judgeFailureLine(reason: unknown, lang: Lang): string {
	const head = lang === "zh" ? "情绪判读" : "affect judge";
	return `${head}: ${reason instanceof Error ? reason.message : String(reason)}`;
}
