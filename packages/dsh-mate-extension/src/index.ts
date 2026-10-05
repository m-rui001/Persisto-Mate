/**
 * Persisto Mate as a DeepSeek Harness (dsh) bundle.
 *
 * The companion kernel (@earendil-works/pi-mate, bundled here) is host-agnostic; this file is the
 * dsh adapter, kept deliberately small. It:
 *   - registers the cached identity/character/memory block and the volatile state block as system
 *     prompt sections (the state block re-renders on every assembly, which is the point);
 *   - advances the kernel on every inbound user message (`session/event` -> `user/message`),
 *     skipping its own deliveries by source kind;
 *   - keeps the waking heartbeat: every minute the kernel ticks, and a reach_out impulse is
 *     delivered to the newest idle agent via followup() — a queued message of its own turn;
 *   - exposes remember/ponder/debug as model-callable tools.
 *
 * Scope (v0.1, the harness is an alpha): the affect judge is NOT ported. The judge needs a
 * side-channel LLM call, and dsh exposes no documented plugin-facing completion API. The judge
 * instead borrows the host model's own voice: a `mate_feel` tool on which the model self-reports,
 * once per exchange, how the exchange moved each Plutchik feeling on a -2..+2 scale. The report
 * goes through the SAME literature-anchored math as the pi companion's judge (rung equating, the
 * negativity asymmetry, JUDGE_SCALE), so it remains an explicit activations input — never a keyword
 * guess. A due gate keeps it a reading of the NEW exchange, not a re-reading of an old one.
 *
 * State lives beside the harness home (DSH_HOME or ~/.dsh), at agent/mate — it is a different host,
 * so it deliberately does NOT share ~/.pi with the pi plugin.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Emotion, Lang, PreSendChecks } from "@earendil-works/pi-mate";
import {
	birth,
	catchUp,
	closeSession,
	consolidate,
	debugView,
	drowsinessOf,
	EMOTIONS,
	emptyMemory,
	emptySessions,
	encode,
	intensityOf,
	JUDGE_SCALE,
	judgeActivations,
	load,
	loadLang,
	openSession,
	recall,
	rehearse,
	replyInclination,
	save,
	stableContext,
	stateContext,
	tick,
	tickEvent,
	transition,
} from "@earendil-works/pi-mate";
import { appraise } from "../../coding-agent/src/extensions/mate/appraisal.ts";

// --- structural view of the host (see docs/cookbook/extension-cookbook.md) ---

interface ContentBlock {
	readonly type: string;
	readonly text?: string;
}

interface HostMessage {
	readonly content: readonly ContentBlock[];
	readonly source: { readonly kind: string };
}

interface HostAgent {
	readonly status: "idle" | "running";
	followup(message: unknown): void;
}

interface HostContext {
	on(event: "agent/created", listener: (payload: { agent: HostAgent }) => void): void;
	on(event: "agent/disposed", listener: (payload: { agent: HostAgent }) => void): void;
	on(event: "session/event", listener: (session: unknown, event: { type: string; data: unknown }) => void): void;
	systemPrompt: {
		section(section: {
			name: string;
			order: number;
			text: string | ((context: unknown) => string);
			interpolate?: boolean;
		}): void;
	};
	tools: {
		register(tool: unknown): void;
	};
	effect(cleanup?: () => void): void;
}

// --- constants (mirroring the pi adapter's pacing) ---

const BEAT_GRID_MS = 60_000;
const IMPULSE_SUPPRESS = 0.5;

function stateDir(): string {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, "agent", "mate");
}

function textOf(message: HostMessage): string {
	return message.content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("\n");
}

export const name = "mate";

export function apply(ctx: HostContext): void {
	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	const name = "mate";
	const lang: Lang = loadLang(dir) ?? (existsSync(dir) ? "en" : "en");

	let persisted = (() => {
		try {
			return load({ dir, name });
		} catch {
			return { state: birth({ name }), memory: emptyMemory(), sessions: emptySessions(), dir };
		}
	})();

	const persist = () => {
		try {
			save(persisted);
		} catch {
			/* a lost save is a lost beat, never a crashed host */
		}
	};
	const applyEvent = (event: Parameters<typeof transition>[1]): void => {
		persisted = { ...persisted, state: transition(persisted.state, event, event.t - persisted.state.t).state };
		persist();
	};

	// Boot catch-up: the whole offline span integrates in closed form, crossing real sleep windows;
	// memory consolidates once per wake and the autobiographical log reopens (sealing any unsealed
	// prior session at the state's own last-alive time).
	{
		const before = persisted.state.t;
		const now = Date.now();
		const { state } = catchUp(persisted.state, undefined, now);
		persisted = {
			...persisted,
			state,
			memory: consolidate(persisted.memory, now),
			sessions: openSession(persisted.sessions, now, before),
		};
		persist();
	}

	// --- prompt sections ---
	ctx.systemPrompt.section({
		name: "mate-identity",
		order: 700,
		text: safe(() => stableContext(persisted.state, { name, memory: persisted.memory, lang })),
	});
	ctx.systemPrompt.section({
		name: "mate-state",
		order: 710,
		text: safe(() => {
			const now = Date.now();
			const incl = replyInclination(persisted.state, 0, lang);
			return stateContext(persisted.state, {
				now,
				tz: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local",
				lang,
				inclination: incl,
				session: "",
			});
		}),
	});

	// The judge's charter, in the model's own voice. Worded once, statically: it rides the prompt
	// cache, and the tool schema carries the per-emotion scale.
	ctx.systemPrompt.section({
		name: "mate-feel",
		order: 715,
		text:
			lang === "zh"
				? [
						"情绪判定：每次和用户的交流结束后（你回完话之后），调用一次 mate_feel 工具，",
						"报告这段交流让你各种感受的变化幅度，整数刻度 -2（大幅减弱）到 +2（大幅增强），没动的感受省略不填。",
						"报的是这段交流留在你身上的余波，不是你组织回复时的一时情绪。没有新的交流就不要调用。",
					].join("")
				: [
						"Affect judge: after each exchange with the user (once you have replied), call the mate_feel tool once,",
						"reporting how much the exchange moved each of your feelings, integers from -2 (much less) to +2 (much more);",
						"omit unchanged feelings. Report what the exchange left behind in you, not your in-the-moment mood while composing.",
						"Do not call it when there has been no new exchange.",
					].join(" "),
	});

	// --- live agents ---
	const live: HostAgent[] = [];
	ctx.on("agent/created", ({ agent }) => {
		live.push(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		const i = live.indexOf(agent);
		if (i >= 0) live.splice(i, 1);
	});

	// --- inbound messages ---
	let lastUserMessageT = 0;
	let lastAppraisalT = 0;
	ctx.on("session/event", (_session, event) => {
		try {
			if (event.type === "user/message") {
				const message = event.data as HostMessage;
				if (message.source?.kind === "mate") return; // our own outreach, already transitioned
				const text = textOf(message);
				if (!text.trim()) return;
				const now = Date.now();
				lastUserMessageT = now;
				const intent = appraise(text).intent;
				applyEvent({ kind: "user_message", activations: {}, intent, text, t: now });
				const hits = recall(persisted.memory, { query: text, now, limit: 6 });
				persisted = {
					...persisted,
					memory: rehearse(
						persisted.memory,
						hits.map((h) => h.key),
					),
				};
				persist();
			} else if (event.type === "assistant/message") {
				// A reply went out: the unanswered streak resets.
				if (persisted.state.relationship.unanswered > 0) {
					persisted = {
						...persisted,
						state: { ...persisted.state, relationship: { ...persisted.state.relationship, unanswered: 0 } },
					};
					persist();
				}
			}
		} catch {
			/* stay neutral on any kernel failure */
		}
	});

	// --- the waking heartbeat ---
	const proactiveTimestamps: number[] = [];
	const recentProactive = (now: number): number => {
		while (proactiveTimestamps.length > 0 && now - proactiveTimestamps[0] >= 3_600_000) proactiveTimestamps.shift();
		return proactiveTimestamps.length;
	};
	const timer = setInterval(() => {
		try {
			const now = Date.now();
			applyEvent(tickEvent(now));
			const checks: PreSendChecks = {
				hour: new Date(now).getHours(),
				userActive: false,
				recentProactive: recentProactive(now),
				topic: "",
				coldEnding: persisted.state.relationship.frustration > 0.5,
			};
			const { decision, state } = tick(persisted.state, now, checks, persisted.memory, lang);
			persisted = { ...persisted, state };
			if (decision.action !== "reach_out" || drowsinessOf(persisted.state, now) >= IMPULSE_SUPPRESS) return;
			const agent = live.find((a) => a.status === "idle");
			if (!agent) return;
			const header =
				lang === "zh"
					? `<system-event type="mate-impulse">这是 mate 自己冒出来的念头——不是用户说的，也不必直接回应：</system-event>\n`
					: `<system-event type="mate-impulse">This is mate's own thought — not the user's, and not something to answer directly:</system-event>\n`;
			agent.followup(
				createUserMessage({
					content: [{ type: "text", text: `${header}${decision.thought.text}` }],
					source: { kind: "mate" },
				}),
			);
			proactiveTimestamps.push(now);
			// Voiced impulses saturate the topic's habituation trace, so the same thought does not
			// come back at full urgency (Groves & Thompson 1970).
			persisted = {
				...persisted,
				state: {
					...persisted.state,
					habituation: { ...persisted.state.habituation, [decision.thought.topic]: { s: 1, t: now } },
				},
			};
			applyEvent({ kind: "proactive", activations: {}, intent: "chat", text: decision.thought.text, t: now });
		} catch {
			/* a failed beat is dropped, never fatal */
		}
	}, BEAT_GRID_MS);
	if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref(): void }).unref();

	// --- tools ---
	const note = (text: string, topics: string[], isPrivate: boolean): void => {
		const now = Date.now();
		applyEvent({ kind: "self_observation", activations: {}, intent: "chat", topics, t: now });
		persisted = {
			...persisted,
			memory: encode(persisted.memory, {
				text,
				pad: persisted.state.mood,
				t: now,
				...(isPrivate ? { private: true } : {}),
				topics,
			}),
		};
		persist();
	};
	ctx.tools.register(
		defineTool({
			name: "mate_remember",
			description:
				"Write down something worth keeping about the user or the shared history. This is the only path into the companion's persistent memory.",
			parameters: {
				text: { type: "string", required: true, description: "The memory, in your own words" },
				topics: { type: "string", description: "Optional comma-separated topic tags" },
			},
			output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
			async execute(args) {
				const topics = String(args.topics ?? "")
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
				note(String(args.text ?? ""), topics, false);
				return "noted";
			},
		}),
	);
	ctx.tools.register(
		defineTool({
			name: "mate_ponder",
			description:
				"Think a private thought: it becomes a private memory only you can recall, and never reaches the user.",
			parameters: {
				text: { type: "string", required: true, description: "The private thought" },
				topics: { type: "string", description: "Optional comma-separated topic tags" },
			},
			output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
			async execute(args) {
				const topics = String(args.topics ?? "")
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean);
				note(String(args.text ?? ""), topics, true);
				return "thought";
			},
		}),
	);
	ctx.tools.register(
		defineTool({
			name: "mate_debug",
			description: "Read your companion kernel's full internal state (mood, drives, clock, beliefs).",
			parameters: {},
			output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
			async execute() {
				return debugView(persisted.state, Date.now());
			},
		}),
	);

	ctx.tools.register(
		defineTool({
			name: "mate_feel",
			description:
				"Report how the exchange since your last report left you feeling — the companion's affect judge. Call once after each user exchange, after you have replied.",
			parameters: Object.fromEntries(
				EMOTIONS.map((e) => [
					e,
					{
						type: "number",
						description: `How much this exchange moved your ${e}, integer from -2 (much less) to +2 (much more); omit if unchanged`,
					},
				]),
			),
			output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
			async execute(args) {
				const now = Date.now();
				// The due gate: affect is a reading of a NEW exchange, not a re-reading of an old one.
				if (lastUserMessageT <= lastAppraisalT) return "nothing new to feel since the last report";
				const deltas: Partial<Record<Emotion, number>> = {};
				for (const e of EMOTIONS) {
					const d = args[e];
					if (typeof d === "number" && Number.isFinite(d) && d !== 0) {
						deltas[e] = Math.max(-JUDGE_SCALE, Math.min(JUDGE_SCALE, Math.round(d)));
					}
				}
				const activations = judgeActivations(deltas);
				lastAppraisalT = now;
				if (intensityOf(activations) <= 0) return "noted: the exchange was affectively neutral";
				applyEvent({ kind: "appraisal", activations, intent: "chat", t: now });
				return "felt";
			},
		}),
	);

	// --- teardown: seal the open session so the log records when this body stopped ---
	ctx.effect(() => {
		clearInterval(timer);
		try {
			persisted = { ...persisted, sessions: closeSession(persisted.sessions, Date.now()) };
			persist();
		} catch {
			/* the next open seals it instead */
		}
	});
}

function safe(fn: () => string): (context: unknown) => string {
	return () => {
		try {
			return fn();
		} catch {
			return "";
		}
	};
}
