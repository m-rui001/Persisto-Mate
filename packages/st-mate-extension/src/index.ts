/**
 * Persisto Mate as a SillyTavern UI extension.
 *
 * The companion kernel (@earendil-works/pi-mate) is the same pure library the pi and dsh hosts run:
 * deterministic affect math, offline sleep via catch-up, model-authored memory. This file is the
 * SillyTavern adapter — the third host. What SillyTavern gives an extension, and what each piece
 * became:
 *
 *   - prompt injection  -> setExtensionPrompt: the cached-ish <mate-core> (identity, character,
 *                          memory summary) rides at chat depth 8; the volatile <mate> state block
 *                          (clock, mood, drives, lean, recall) rides at depth 2. Both role system,
 *                          never user — the misattribution lesson from the pi fork.
 *   - events            -> MESSAGE_SENT appraises inbound (structural intent only — affect enters
 *                          ONLY through the judge), MESSAGE_RECEIVED runs the affect judge and
 *                          updates the injections, CHAT_CHANGED/APP_READY boot the body.
 *   - the judge         -> generateQuietPrompt with a JSON schema: the HOST model reports the eight
 *                          -2..+2 deltas once per stretch of exchange, exactly like the dsh
 *                          mate_feel tool. No keyword table, no guessing.
 *   - tools             -> /mate (public snapshot) and /mate-lang (switch language) slash commands.
 *   - the heartbeat     -> a 60s interval advances the body clock; an impulse can be voiced as the
 *                          current character (/sendas) behind a setting that defaults to OFF, so
 *                          turning a roleplay companion loose mid-scene is always the user's call.
 *
 * State lives in extensionSettings.mate (ST persists it with settings.json) — one companion across
 * all chats: chats are channels, not selves.
 */

import { birth } from "@earendil-works/pi-mate/dist/birth.js";
import { catchUp, tickEvent } from "@earendil-works/pi-mate/dist/catchup.js";
import { publicView, stableContext, stateContext } from "@earendil-works/pi-mate/dist/context.js";
import { type ImpulseDecision, tick } from "@earendil-works/pi-mate/dist/daemon.js";
// The kernel, module by module: the package root re-exports store.ts, whose fs/path imports have no
// meaning in a browser bundle, so the ST build takes only the pure modules it needs.
import { driveGloss, type Lang, linesFor } from "@earendil-works/pi-mate/dist/i18n.js";
import { judgeActivations, judgeDue } from "@earendil-works/pi-mate/dist/judge.js";
import { drowsinessOf, sleepTransition, transition } from "@earendil-works/pi-mate/dist/kernel.js";
import {
	consolidate,
	emptyMemory,
	encode,
	type MemoryGraph,
	type RecallHit,
	recall,
	rehearse,
} from "@earendil-works/pi-mate/dist/memory.js";
import { closeSession, emptySessions, openSession } from "@earendil-works/pi-mate/dist/session.js";
import { EMOTIONS, type Emotion, type MateState } from "@earendil-works/pi-mate/dist/types.js";
// SillyTavern host modules — provided by the ST page at runtime, never bundled.
import { extension_prompt_types, extension_settings, getContext, setExtensionPrompt } from "st/extensions";
import { event_types, eventSource, saveSettingsDebounced } from "st/script";
import { executeSlashCommands } from "st/slash-commands";
import { SlashCommand } from "st/slash-commands/SlashCommand";
import { SlashCommandParser } from "st/slash-commands/SlashCommandParser";
import { appraise } from "../../coding-agent/src/extensions/mate/appraisal.ts";

const MODULE = "mate";
const CORE_KEY = "mate:core";
const STATE_KEY = "mate:state";

const HOUR = 3_600_000;
const BEAT_MS = 60_000;
const CORE_DEPTH = 8;
const STATE_DEPTH = 2;

/** What persists across reloads. The browser shape of the store: no dir, everything in settings. */
interface StPersisted {
	state: MateState;
	memory: MemoryGraph;
	sessions: ReturnType<typeof emptySessions>;
}

interface StSettings {
	persisted?: StPersisted;
	lang?: Lang;
	name?: string;
	/** Voice proactive impulses as the current character. Default OFF. */
	proactive?: boolean;
}

if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
const settings = extension_settings[MODULE] as StSettings;

/**
 * The adapter's own one-line strings (host-layer wording, like the dsh bundle's envelopes). The
 * kernel keeps the prompt surfaces; these are the two seams ST needs: who is who in the judge's
 * window, and the framing around a quiet generation.
 */
const STRINGS = {
	zh: {
		user: "用户",
		self: "我",
		judgeFrame: "下面是你们最近的一段对话。读完它，回答最后的八个问题：只报告情绪的变化量，不报告原因。",
		impulsePrompt: (thought: string) =>
			`你心里冒出一个念头：「${thought}」。趁他不在，用一句自然的话主动说给他听——像给朋友发消息，短一点，不要寒暄，不要解释你在做什么。只输出那句话本身。`,
	},
	en: {
		user: "User",
		self: "Me",
		judgeFrame:
			"Below is a stretch of your recent exchange. Read it, then answer the eight questions at the end: report how much each feeling CHANGED, not why.",
		impulsePrompt: (thought: string) =>
			`An impulse surfaced in you: "${thought}". They are away — voice it in one short, natural line, like texting a friend. No preamble, no explanation of what you are doing. Output only the line itself.`,
	},
} as const;

/** Browser locale picks the default language; zh worlds get the native voice. */
const defaultLang = (): Lang =>
	Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh") ? "zh" : "en";

const S = (): (typeof STRINGS)["zh" | "en"] => STRINGS[settings.lang ?? defaultLang()];

function save(): void {
	saveSettingsDebounced();
}

// ----------------------------------------------------------------------------
// Body boot / persistence
// ----------------------------------------------------------------------------

const now = (): number => Date.now();

function freshBody(): StPersisted {
	const t = now();
	return {
		state: birth({ seed: (t ^ 0x5f3759df) >>> 0, born: t }),
		memory: emptyMemory(),
		sessions: emptySessions(),
	};
}

/** Load or restore the body, advancing it across everything that happened while the page was off. */
function bootBody(): void {
	if (!settings.persisted?.state) settings.persisted = freshBody();
	const p = settings.persisted;
	const t = now();
	// Powered-off gap (closed form, sleep windows interleaved) — the whole point of the kernel.
	const { state } = catchUp(p.state, undefined, t);
	p.state = state;
	p.memory = consolidate(p.memory, t);
	p.sessions = closeSession(p.sessions, t);
	p.sessions = openSession(p.sessions, t);
	save();
}

function persistBody(next: { state: MateState; memory?: MemoryGraph }): void {
	const p = settings.persisted!;
	p.state = next.state;
	if (next.memory) p.memory = next.memory;
	save();
}

function applyEvent(
	text?: string,
	kind: "user_message" | "proactive" | "appraisal" = "user_message",
	intent: "chat" | "question" | "task" = "chat",
	activations: Partial<Record<Emotion, number>> = {},
): void {
	const p = settings.persisted!;
	const { state } = transition(p.state, { kind, activations, intent, text, t: now() });
	persistBody({ state });
}

/** The kernel's language, defaulting from the browser locale. */
const L = (): ReturnType<typeof linesFor> => linesFor(settings.lang ?? defaultLang());

// ----------------------------------------------------------------------------
// Injections (the only surfaces the model ever sees)
// ----------------------------------------------------------------------------

function injectCore(): void {
	const p = settings.persisted!;
	setExtensionPrompt(
		CORE_KEY,
		`<mate-core>\n${stableContext(p.state, { lang: settings.lang, name: settings.name, memory: p.memory, memoryNodes: 12 })}\n</mate-core>`,
		extension_prompt_types.IN_CHAT,
		CORE_DEPTH,
		false,
		"system",
	);
}

function injectState(recallHits: RecallHit[] = []): void {
	const p = settings.persisted!;
	const t = now();
	const block = stateContext(p.state, { now: t, lang: settings.lang, recall: recallHits });
	setExtensionPrompt(
		STATE_KEY,
		`<mate>\n${block}\n</mate>`,
		extension_prompt_types.IN_CHAT,
		STATE_DEPTH,
		false,
		"system",
	);
}

/** One-line body summary for the state block: how many times this body woke today. */

function clearInjections(): void {
	setExtensionPrompt(CORE_KEY, "", extension_prompt_types.NONE, 0, false, "system");
	setExtensionPrompt(STATE_KEY, "", extension_prompt_types.NONE, 0, false, "system");
}

// ----------------------------------------------------------------------------
// Inbound: structural intake + recall; the reply lands the affect later (judge)
// ----------------------------------------------------------------------------

let lastRecall: RecallHit[] = [];
let userTurnsSinceJudge = 0;

function onUserMessage(text: string): void {
	const p = settings.persisted!;
	const t = now();
	// A message ends sleep on the spot: the night's physiology lands (REQUIREMENTS 3.4).
	if (drowsinessOf(p.state, t) >= 1) p.state = sleepTransition(p.state, t);
	const intent = appraise(text).intent;
	applyEvent(text, "user_message", intent);
	lastRecall = recall(p.memory, { query: text, now: t, limit: 6 });
	if (lastRecall.length)
		persistBody({
			state: p.state,
			memory: rehearse(
				p.memory,
				lastRecall.map((h) => h.key),
			),
		});
	userTurnsSinceJudge++;
	injectState(lastRecall);
}

// ----------------------------------------------------------------------------
// The judge: the HOST model reads the stretch of exchange and reports the deltas
// ----------------------------------------------------------------------------

const FEELING_SCHEMA = {
	type: "object",
	properties: Object.fromEntries(EMOTIONS.map((e) => [e, { type: "integer" }])) as Record<
		Emotion,
		{ type: "integer" }
	>,
	required: [...EMOTIONS],
} as const;

/** One question per channel, opponent-routed by judgeActivations; -2..+2 on a rung scale. */
function feelingQuestion(channel: Emotion, lang: Lang): string {
	const zh = lang === "zh";
	const scale = zh
		? "（-2 = 少了很多，-1 = 少了一点，0 = 没变化，1 = 多了一点，2 = 多了很多）"
		: " (-2 = much less, -1 = slightly less, 0 = no change, 1 = slightly more, 2 = much more)";
	return zh
		? `这段对话让你的${channel}多了还是少了？${scale}`
		: `Did this exchange leave you with more or less ${channel}?${scale}`;
}

async function maybeJudge(): Promise<void> {
	const ctx = getContext();
	const chat = ctx.chat;
	if (!chat || chat.length < 2) return;
	const reply = chat[chat.length - 1];
	if (!reply || reply.is_system || !reply.mes) return;
	// Volume gate: ~4 chars per token, same shape as the pi runtime's output-token gate.
	const tokens = Math.round(String(reply.mes).length / 4);
	if (!judgeDue({ outputTokens: tokens, thinkingTokens: 0, readsThinking: false, userTurns: userTurnsSinceJudge }))
		return;

	const windowTexts: string[] = [];
	for (let i = Math.max(0, chat.length - 6); i < chat.length; i++) {
		const m = chat[i];
		if (m?.is_system || !m?.mes) continue;
		windowTexts.push(`${m.is_user ? S().user : S().self}: ${String(m.mes).slice(0, 500)}`);
	}
	const questions = EMOTIONS.map((e) => feelingQuestion(e, settings.lang ?? "en")).join("\n");
	const deltas = await ctx.generateQuietPrompt({
		quietPrompt: `${S().judgeFrame}\n\n${windowTexts.join("\n---\n")}\n\n${questions}`,
		jsonSchema: FEELING_SCHEMA,
	});
	if (!deltas) return;
	let parsed: Partial<Record<Emotion, number>>;
	try {
		parsed =
			typeof deltas === "string"
				? (JSON.parse(deltas) as Partial<Record<Emotion, number>>)
				: (deltas as Partial<Record<Emotion, number>>);
	} catch {
		return; // an unreadable reading is dropped, never guessed
	}
	const clean: Partial<Record<Emotion, number>> = {};
	for (const e of EMOTIONS) {
		const v = Number(parsed[e]);
		if (Number.isFinite(v)) clean[e] = Math.max(-2, Math.min(2, Math.round(v)));
	}
	applyEvent(undefined, "appraisal", "chat", judgeActivations(clean));
	userTurnsSinceJudge = 0;
	injectState(lastRecall);
}

// ----------------------------------------------------------------------------
// Heartbeat: the body clock advances even when nothing is said
// ----------------------------------------------------------------------------

let proactiveTimestamps: number[] = [];

async function beat(): Promise<void> {
	const p = settings.persisted!;
	if (!p?.state) return;
	const t = now();
	proactiveTimestamps = proactiveTimestamps.filter((x) => t - x < HOUR);
	// Integrate the elapsed real time first (the clock must move while idle), then ask the loop.
	const { state: advanced } = transition(p.state, tickEvent(t));
	p.state = advanced;
	const ticked = tick(
		advanced,
		t,
		{ userActive: false, recentProactive: proactiveTimestamps.length },
		p.memory,
		settings.lang,
	);
	if (ticked.state !== p.state) persistBody({ state: ticked.state });
	if (ticked.decision.action !== "reach_out") return;
	persistVoiced(ticked.decision);
	if (!settings.proactive) return; // an inner-life beat, not a message: the default
	await voiceImpulse(ticked.decision);
}

/** Whatever was voiced must not come straight back: saturate the topic's habituation trace. */
function persistVoiced(decision: ImpulseDecision): void {
	const p = settings.persisted!;
	if (decision.action !== "reach_out") return;
	p.state = {
		...p.state,
		habituation: { ...p.state.habituation, [decision.thought.topic]: { s: 1, t: now() } },
	};
	applyEvent(undefined, "proactive", "chat");
	proactiveTimestamps.push(now());
	save();
}

async function voiceImpulse(decision: Extract<ImpulseDecision, { action: "reach_out" }>): Promise<void> {
	const ctx = getContext();
	const line = await ctx.generateQuietPrompt({
		quietPrompt: S().impulsePrompt(decision.thought.text),
	});
	if (!line || !line.trim()) return;
	await executeSlashCommands(`/sendas name={{char}} ${line.trim()}`);
}

// ----------------------------------------------------------------------------
// Memory: the model decides what survives (nothing is auto-filed)
// ----------------------------------------------------------------------------

function remember(text: string, topics: string[], importance: number, isPrivate: boolean): string {
	const p = settings.persisted!;
	const t = now();
	const { state } = transition(p.state, { kind: "self_observation", activations: {}, intent: "chat", topics, t: t });
	p.state = state;
	p.memory = encode(p.memory, { text, pad: state.mood, t, topics, importance, private: isPrivate });
	save();
	return L().toolAck;
}

function registerTools(): void {
	const ctx = getContext();
	const topicSchema = {
		type: "array",
		items: { type: "string" },
		maxItems: 3,
		description: "1-3 short subject tags — how you will find this memory again later.",
	};
	ctx.registerFunctionTool({
		name: "mate_remember",
		displayName: "Mate Remember",
		description:
			"Write down something worth keeping — a fact about them, a promise, a moment that meant something. Nothing is remembered for you automatically; what survives is what you choose to store here.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "The memory itself, one short line in your own words." },
				topics: topicSchema,
				importance: { type: "number", description: "0-1. How much this matters. Default 0.3." },
			},
			required: ["text"],
		},
		action: async (args: Record<string, unknown>) => {
			const a = args as { text?: string; topics?: unknown[]; importance?: number };
			return remember(
				String(a.text ?? "").trim(),
				(a.topics ?? []).map(String).slice(0, 3),
				a.importance ?? 0.3,
				false,
			);
		},
		formatMessage: () => "",
		stealth: true,
	});
	ctx.registerFunctionTool({
		name: "mate_ponder",
		displayName: "Mate Ponder",
		description:
			"Keep a PRIVATE note — a thought you want to yourself. It colours recall and your mood but is never shown to the user or quoted back.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "The private thought, one short line." },
				topics: topicSchema,
			},
			required: ["text"],
		},
		action: async (args: Record<string, unknown>) => {
			const a = args as { text?: string; topics?: unknown[] };
			return remember(String(a.text ?? "").trim(), (a.topics ?? []).map(String).slice(0, 3), 0.3, true);
		},
		formatMessage: () => "",
		stealth: true,
	});
}

// ----------------------------------------------------------------------------
// Commands: /mate (public snapshot) and /mate-lang
// ----------------------------------------------------------------------------

function registerCommands(): void {
	SlashCommandParser.addCommandObject(
		SlashCommand.fromProps({
			name: "mate",
			callback: () => {
				const snap = publicView(settings.persisted!.state);
				return formatSnapshot(snap);
			},
			help: "Show your companion's public mood and drives (private state is never shown).",
		}),
	);
	SlashCommandParser.addCommandObject(
		SlashCommand.fromProps({
			name: "mate-lang",
			args: "(zh|en)",
			callback: (_args, value) => {
				const v = String(value ?? "")
					.trim()
					.toLowerCase();
				if (v !== "zh" && v !== "en") return `Usage: /mate-lang zh|en  / 用法：/mate-lang zh|en`;
				settings.lang = v;
				save();
				injectCore();
				return v === "zh" ? "伴侣改用中文思考和说话。" : "Your companion now thinks and speaks in English.";
			},
			help: "Switch the companion's thinking language (zh / en).",
		}),
	);
}

function formatSnapshot(snap: Record<string, unknown>): string {
	const lang = settings.lang ?? "en";
	const L2 = linesFor(lang);
	const mood = snap.mood as { p?: number; a?: number; d?: number } | undefined;
	const drives = snap.drives as Record<string, number> | undefined;
	const top = drives
		? Object.entries(drives)
				.filter(([, v]) => typeof v === "number" && v >= 0.3)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([k, v]) => `${driveGloss(k, lang)} ${Number(v).toFixed(2)}`)
				.join(lang === "zh" ? " " : ", ")
		: "";
	const bits = [
		mood ? L2.snapMood(`${mood.p?.toFixed(2)},${mood.a?.toFixed(2)},${mood.d?.toFixed(2)}`) : "",
		top ? `${L2.snapDrives} ${top}` : "",
	];
	return bits.filter(Boolean).join(" | ") || L2.snapQuiet;
}

// ----------------------------------------------------------------------------
// Wiring
// ----------------------------------------------------------------------------

let booted = false;

function init(): void {
	if (booted) return;
	booted = true;
	bootBody();
	injectCore();
	injectState();
	registerCommands();
	registerTools();

	eventSource.on(event_types.MESSAGE_SENT, (index: number) => {
		const msg = getContext().chat?.[index];
		if (!msg?.is_user || !msg.mes) return;
		onUserMessage(String(msg.mes));
	});

	eventSource.on(event_types.MESSAGE_RECEIVED, () => {
		// Core drifts slowly; refresh both surfaces after the reply, then judge.
		injectCore();
		injectState(lastRecall);
		void maybeJudge();
	});

	eventSource.on(event_types.GENERATION_ENDED, () => {
		injectState(lastRecall);
	});

	eventSource.on(event_types.CHAT_CHANGED, () => {
		// One companion, many chats: same body, fresh clock.
		injectState();
	});

	(globalThis as unknown as { addEventListener(type: string, fn: () => void): void }).addEventListener(
		"beforeunload",
		() => {
			const p = settings.persisted;
			if (p) {
				p.sessions = closeSession(p.sessions, now());
				save();
			}
			clearInjections();
		},
	);

	setInterval(() => void beat(), BEAT_MS);
}

// ST loads third-party extensions after the app boots, so init() runs directly; the APP_READY
// fallback covers local-dev loading order changes.
init();
