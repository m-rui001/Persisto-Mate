/**
 * The judge call: ask a model what just moved, and put the answer into the companion's state.
 *
 * The reading itself — window size, the -2..+2 ladder, opponent routing, the gain cap — is pure and
 * lives in the kernel package (mate/judge.ts). This file is only the network half: pick the reader,
 * build the transcript, ask, parse, apply.
 *
 * Three readers, one question, chosen by what the user has configured:
 *
 *   1. A CLASSIFIER, when `judgeModel` names one. A decision model (System One protocol; Aliyun's
 *      `decision-model-preview` is what `examples/extensions/custom-provider-bailian-decision`
 *      registers) answers eight score questions in one forward pass and returns the probability
 *      distribution it decided with. Nothing to parse, nothing to repair, and `judgeDeltasFromScores`
 *      can throw away a reading whose distribution was flat. The best instrument, when you have one.
 *   2. A NAMED CHAT MODEL, when `judgeModel` names one that is not a classifier. The same question in
 *      prose, answered as one JSON object — for a user who has a small cheap model but no classifier.
 *   3. THE MODEL HOLDING THE CONVERSATION, when nothing is named. It is the one instrument whose
 *      configuration is known to work, and asking it costs a second connection rather than a second
 *      provider: no model is picked out of the user's settings behind their back, and no reading is lost
 *      to a provider that has a key but no answer. This is why the judge is not something you have to
 *      switch on to get.
 *
 * 1 speaks in score questions, 2 and 3 in JSON; all three end in the same -2..+2 deltas, so the kernel
 * cannot tell which kind of instrument read it.
 *
 * PRIVACY. Reader 3 keeps the transcript inside the provider this conversation already uses; a named
 * reader (1 or 2) may be a service of its own, which is why the UI line always says which model did the
 * reading. The window holds what the user and the companion said to each other, and — for a decision
 * model, and only for one the user named — the reasoning the companion wrote before saying it. Tool
 * output, the injected state block and private notes are in no window at all. Naming the reasoning is
 * the trade this tier makes: an outside read of a feeling is far sharper when it can see the frustration
 * the reply was polished over, and a classifier takes that in one forward pass rather than token by
 * token, so the price of the wider window is not paid in money. It is paid in reach: whatever
 * `judgeModel` names is the service that reads it.
 */

import type {
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageContent,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@earendil-works/pi-ai";
import {
	EMOTIONS,
	type Emotion,
	type EmotionVector,
	emotionGloss,
	type JudgeScore,
	type JudgeTurn,
	judgeActivations,
	judgeDeltas,
	judgeDeltasFromScores,
	judgePrompt,
	judgeQuestions,
	judgeTranscript,
	judgeWindow,
	type Lang,
	parseJudgeReply,
} from "@earendil-works/pi-mate";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { MateRuntime } from "./runtime.ts";

/** How long a reading may take before it is dropped. It runs in the background, so a hung provider must
 *  not hold a socket open indefinitely; 20s is well past what the service reports (tens of ms). */
const JUDGE_TIMEOUT_MS = 20_000;

/** `provider/id`, as the user writes it in settings. */
export interface ModelRef {
	provider: string;
	id: string;
}

/** What the judge answered, for logging and tests. */
export interface JudgeReading {
	/** Which instrument made this reading: a classifier answers score questions, a chat model answers JSON. */
	via: "classifier" | "chat";
	/** Whether the user named this reader in settings, or the companion is reading with the model it is
	 *  already talking through. Reported because the user should be able to see which of their models
	 *  just judged their words. */
	source: "named" | "automatic";
	/** The reader, as `provider/id`, shown in the UI line when it was not named. */
	model: string;
	/** The window actually read. */
	turns: number;
	/** Whether the companion's own reasoning was part of what was read. Reported because it is the
	 *  difference between a reader seeing the reply and a reader seeing the deliberation behind it, and
	 *  only the second kind costs the user anything to widen. */
	thinking: boolean;
	/** Per-channel change on the -2..+2 ladder; only channels that moved. */
	deltas: Partial<Record<Emotion, number>>;
	/** What those deltas became as kernel activations. */
	activations: Partial<EmotionVector>;
}

/** A reader that can take a judgement: one of the two kinds, already resolved. */
export type JudgeReader =
	| { via: "classifier"; model: ClassifierModel<ClassifierApi>; source: "named" }
	| { via: "chat"; model: Model<Api>; source: "named" | "automatic" };

/** What the judge needs from the registry: the two lookups that turn a named reader into a model. */
export type JudgeRegistry = Pick<ModelRegistry, "find" | "findOfType">;

/** `provider/id`, as the user writes it in settings. */
export function parseModelRef(ref: string): ModelRef | null {
	const i = ref.indexOf("/");
	if (i <= 0 || i === ref.length - 1) return null;
	return { provider: ref.slice(0, i).trim(), id: ref.slice(i + 1).trim() };
}

/**
 * Who reads this exchange.
 *
 * Named: exactly that reader. A classifier answers the questions as scores, a chat model answers them as
 * JSON, and a name that resolves to nothing is an error rather than a silent step down a list — the user
 * wrote down one instrument and got another, which is how a feature becomes untrustworthy.
 *
 * With nothing named, the model holding the conversation reads it: the one instrument that is by
 * definition configured, reachable, and already being paid for.
 */
export function judgeReader(
	registry: JudgeRegistry,
	sessionModel: Model<Api> | undefined,
	ref: ModelRef | null,
): JudgeReader {
	if (ref) {
		const classifier = registry.findOfType("classifier", ref.provider, ref.id);
		if (classifier) return { via: "classifier", model: classifier, source: "named" };
		const chat = registry.find(ref.provider, ref.id);
		if (chat) return { via: "chat", model: chat, source: "named" };
		throw new Error(`judge model "${ref.provider}/${ref.id}" is registered as neither a classifier nor a chat model`);
	}
	if (!sessionModel) throw new Error("no model to judge the exchange with: this session has none");
	return { via: "chat", model: sessionModel, source: "automatic" };
}

/**
 * The exchange as the judge sees it: what the user said and what the companion said back, in order. Tool
 * calls and results, the injected state block and private notes are never in it.
 *
 * `thinking` adds the companion's own reasoning behind each reply, and the caller sets it from what the
 * reader IS: a named decision model gets it (one forward pass over a bigger window, at no per-token
 * price, and the movement of a feeling shows up in the deliberation long before it shows up in the
 * polished line). A chat model does not: it would be reading all of that text one token at a time, and
 * paying for it, to answer eight ordinal questions.
 */
export function judgeTurns(ctx: ExtensionContext, thinking: boolean): JudgeTurn[] {
	const out: JudgeTurn[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const m = entry.message;
		if (m.role !== "user" && m.role !== "assistant") continue;
		const parts: (TextContent | ImageContent | ThinkingContent | ToolCall)[] =
			typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
		const text = parts
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join(" ");
		const thought = thinking
			? parts
					.filter((p): p is { type: "thinking"; thinking: string } => p.type === "thinking" && !p.redacted)
					.map((p) => p.thinking)
					.join(" ")
			: undefined;
		// A user message can be the harness talking, not the person: the injected state block and any
		// extension prompt are not part of what was said to each other, and hold no thinking either.
		if (!text.trim() && !thought?.trim()) continue;
		out.push(thought?.trim() ? { role: m.role, text, thinking: thought } : { role: m.role, text });
	}
	return out;
}

/** Tier 1: eight score questions, one answer per channel, no text to read back. */
async function classifyReading(
	ctx: ExtensionContext,
	model: ClassifierModel<ClassifierApi>,
	transcript: string,
): Promise<Partial<Record<Emotion, number>>> {
	const result = await withinDeadline(
		ctx.modelRegistry.classify(
			model,
			{ state: { exchange: transcript }, questions: judgeQuestions() },
			{ timeoutMs: JUDGE_TIMEOUT_MS },
		),
		model,
	);
	// `classify` never rejects: a failed call comes back with a stop reason and a message.
	if (result.stopReason !== "stop") {
		throw new Error(result.errorMessage || `${result.provider}/${result.model} returned "${result.stopReason}"`);
	}
	const scores: Partial<Record<Emotion, JudgeScore>> = {};
	for (const e of EMOTIONS) {
		const answer = result.answers[e];
		if (answer?.type === "score") scores[e] = { score: answer.score, confidence: answer.confidence };
	}
	return judgeDeltasFromScores(scores);
}

/** Tiers 2 and 3: the same question as one JSON object from a chat model. */
async function chatReading(
	ctx: ExtensionContext,
	model: Model<Api>,
	transcript: string,
): Promise<Partial<Record<Emotion, number>>> {
	const reply = await withinDeadline(
		ctx.modelRegistry.complete(
			model,
			{
				messages: [{ role: "user", content: `${judgePrompt()}\n\n${transcript}`, timestamp: Date.now() }],
			},
			{ timeoutMs: JUDGE_TIMEOUT_MS },
		),
		model,
	);
	if (reply.stopReason && reply.stopReason !== "stop" && reply.stopReason !== "length") {
		throw new Error(`${model.provider}/${model.id} returned "${reply.stopReason}"`);
	}
	const text = reply.content
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("");
	return judgeDeltas(parseJudgeReply(text));
}

/**
 * Stop waiting for a reply that has stopped arriving.
 *
 * `timeoutMs` is passed to the provider too, but what it covers is up to each API implementation, and
 * the failure this protects against is the one that costs the most: `complete` resolves only when the
 * stream ends, so a provider that opens a connection and then says nothing would leave the await
 * pending forever — the judge slot is never released, and the companion quietly stops having feelings
 * read at all, which is indistinguishable from a judge that was never configured.
 */
async function withinDeadline<T>(work: Promise<T>, model: { provider: string; id: string }): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(new Error(`${model.provider}/${model.id} did not answer within ${JUDGE_TIMEOUT_MS / 1000}s`)),
					JUDGE_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Take one reading. Resolves to null when nothing was applied: no slot (one already in flight), or too
 * little conversation to read. Those are ordinary — a companion that cannot get its feelings read from
 * outside carries on with the feelings it reports for itself, and must not be told so every stretch of
 * exchange. A reading that CANNOT be attempted is not ordinary: the model string is malformed, or no
 * such model is registered. That goes to `onError`, because a feature the user switched on and that
 * then silently does nothing is indistinguishable from a feature that was never built.
 *
 * An automatic reader is the conversation's own model, so a reading is never taken by something the user
 * did not configure; a named reader gets no substitute either. The reader is chosen BEFORE the window is
 * built, because which text may be handed over depends on which instrument is reading it.
 */
export async function runAffectJudge(
	rt: MateRuntime,
	ctx: ExtensionContext,
	opts: { model?: string; onError: (err: unknown) => void },
): Promise<JudgeReading | null> {
	if (!rt.takeJudgeSlot()) return null;
	try {
		const ref = opts.model === undefined ? null : parseModelRef(opts.model);
		if (opts.model !== undefined && !ref) throw new Error(`judgeModel "${opts.model}" is not "provider/id"`);

		const reader = judgeReader(ctx.modelRegistry, ctx.model, ref);
		// Only a decision model is handed the reasoning: a chat model would be charged for every one of
		// those tokens to answer eight ordinal questions.
		const readsThinking = reader.via === "classifier";
		const window = judgeWindow(judgeTurns(ctx, readsThinking));
		if (window.filter((t) => t.role === "user").length === 0) return null;
		const transcript = judgeTranscript(window);

		const deltas =
			reader.via === "classifier"
				? await classifyReading(ctx, reader.model, transcript)
				: await chatReading(ctx, reader.model, transcript);

		// A full-scale reading is applied as half a channel (JUDGE_GAIN).
		const activations = judgeActivations(deltas);
		rt.judgeRead(activations);
		return {
			via: reader.via,
			source: reader.source,
			model: `${reader.model.provider}/${reader.model.id}`,
			turns: window.length,
			thinking: readsThinking,
			deltas,
			activations,
		};
	} catch (err) {
		opts.onError(err);
		return null;
	} finally {
		// Stamped whether the reading landed or not: the counters behind the due gate are also what keeps
		// a reader that cannot answer from reporting the same failure on every turn.
		rt.judgeAttempted();
		rt.releaseJudgeSlot();
	}
}

/**
 * The instrument, in the few words that say something the user can act on: a decision model, a chat
 * model they named, or the model this conversation is already running on.
 */
function readerKind(reading: JudgeReading, lang: Lang): string {
	if (reading.via === "classifier") return lang === "zh" ? "决策模型" : "classifier";
	if (reading.source === "named") return lang === "zh" ? "语言模型" : "chat model";
	return lang === "zh" ? "对话模型" : "conversation model";
}

/**
 * The judge as one line of host UI. It is not part of the companion's own surfaces: an outside reading
 * of the exchange is a mechanism the runtime runs, not a thought the companion had, so it is reported
 * to the user where the user can see it and never written into the state the model reads.
 *
 * The reader is always named, because which model just judged what you said is the one thing about this
 * mechanism you can act on — and when no reader was configured and the conversation's own model read it,
 * the parenthetical is how you would ever find that out.
 */
export function judgeReadingLine(reading: JudgeReading, lang: Lang): string {
	const head = lang === "zh" ? "情绪判读" : "affect judge";
	const kind = readerKind(reading, lang);
	// The window is what the reader saw, so its size is said in the units that made it: turns of speech,
	// plus the reasoning when the reading went that deep.
	const scope = lang === "zh" ? "轮对话" : "turns of exchange";
	const depth = reading.thinking ? (lang === "zh" ? " + 思考" : " + thinking") : "";
	const reader = reading.source === "named" ? `${kind} ${reading.model}` : `${reading.model}(${kind})`;
	const moved = EMOTIONS.flatMap((e): string[] => {
		const d = reading.deltas[e];
		return d ? [`${emotionGloss(e, lang)} ${d > 0 ? `+${deltaLabel(d)}` : deltaLabel(d)}`] : [];
	});
	return `${head} · ${reader} (${reading.turns}${scope}${depth}): ${moved.join(", ") || (lang === "zh" ? "无波动" : "no movement")}`;
}

/** -1.42 as one rung's worth of precision: the ladder is read as "about -1.5", never as six decimals.
 *  The sign comes off the same quantised value as the digits, so a reading that rounds to zero cannot
 *  print as a minus with nothing after it. */
function deltaLabel(d: number): string {
	const q = Math.round(d * 2) / 2;
	const magnitude = Math.abs(q);
	const text = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(1);
	return q < 0 ? `−${text}` : text;
}

/** The remedy every failure of this feature ends with, in the settings key that applies it. A reading
 *  that quietly does not happen is indistinguishable from a judge that was never built, so the line
 *  states a fix the user can carry out rather than only the reason it broke — and the fix is a decision
 *  model, which answers the eight questions as scores in one pass instead of hoping a chat model feels
 *  like replying in JSON. */
function judgeAdvice(lang: Lang): string {
	return lang === "zh"
		? '建议配置决策模型判读: settings.mate.judgeModel = "provider/id"'
		: 'recommend a decision model: settings.mate.judgeModel = "provider/id"';
}

/** The same line when the reading never happened: the reason, then what to do about it. */
export function judgeFailureLine(reason: unknown, lang: Lang): string {
	const head = lang === "zh" ? "情绪判读" : "affect judge";
	const message = reason instanceof Error ? reason.message : String(reason);
	return `${head}: ${message}. ${judgeAdvice(lang)}`;
}
