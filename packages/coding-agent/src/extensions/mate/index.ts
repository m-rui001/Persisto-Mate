/**
 * The MATE companion extension: the wiring between the affective kernel (packages/mate) and pi's
 * extension host. This is where the product requirements become behaviour:
 *
 *   - Boot catch-up: on session_start we advance the persisted state across the powered-off gap, so a
 *     companion that was off for three days wakes having actually lived through them. We also log WHEN
 *     this body opened, and seal that on session_shutdown — it knows its own comings and goings.
 *   - It may or may not reply, now or later — but the CHOICE IS ITS OWN (P1: fewer built-in modes).
 *     The kernel no longer gates inbound messages. Every message reaches the model; the runtime only
 *     surfaces an ADVISORY lean ("eager / open / muted / withdrawn") and the specific memories the
 *     message stirred, in the context block. The model reads that and decides whether to answer,
 *     answer briefly, or let it sit — exactly like a person, not a filter.
 *   - It may reach out on its own: a heartbeat produces an IMPULSE (a thought grounded in memory, P4).
 *     We surface it and let the model decide whether and HOW to express it — including via a channel it
 *     discovered for itself, or by looking at the screen. Reaching out is deliberately NOT built in.
 *   - It sees metadata like time: the volatile state block carries the clock, the silence gap and how
 *     long it felt, and this body's open/close history.
 *   - It has eyes: a `look` tool lets it take a screenshot and SEE what the user is doing. Open by
 *     default per the give-it-real-access principle — the model decides when looking is warranted;
 *     nothing gates it.
 *   - It owns its memory: nothing is recorded automatically. The `remember` tool stores a memory the
 *     model decided to keep (tagged with topics so it can be found again), and the `ponder` tool keeps
 *     a private one — they colour recall but are never rendered to the user. The user's inbound words
 *     are never auto-filed as memory before the model has even replied.
 *   - Token economy (P2+P5): the big STABLE content — identity, character, and the memory-graph summary
 *     — rides a CACHED system-prompt section (before_agent_start) and is paid for once. Only the small
 *     VOLATILE delta (clock, mood, drives, lean, recall) rides the ephemeral `context` tail, so it can
 *     be rich without re-paying on every cached prefix.
 *   - It THINKS in the language you pick. `/language` (or the first-run picker) sets the companion's
 *     render language, persisted in the state dir, and every prompt-visible surface — the cached
 *     guidance, the projections, the kernel's thoughts, impulses, advisories — is authored in it (see
 *     packages/mate/src/i18n.ts for why a Chinese prompt, not an English one plus "please think in
 *     Chinese", is what actually holds). Switching costs one prompt-cache miss, then holds again.
 *
 * Nothing here may throw into pi's event loop; every handler is defensive and degrades to a no-op.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	companionSection,
	debugView,
	driveGloss,
	type ImpulseDecision,
	LANG_NAMES,
	type Lang,
	linesFor,
	type Thought,
} from "@earendil-works/pi-mate";
import type {
	CacheWarmingDecisionEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.ts";
import { AlarmManager, createAlarmTool } from "./alarm-tool.ts";
import { authorDream, authorThought } from "./inner-voice.ts";
import { judgeFailureLine, judgeReadingLine, parseModelRef, runAffectJudge } from "./judge-run.ts";
import { createLookTool } from "./look-tool.ts";
import { createPonderTool } from "./ponder-tool.ts";
import { createRememberTool } from "./remember-tool.ts";
import { createReminisceTool } from "./reminisce-tool.ts";
import { getRuntime } from "./runtime.ts";

/**
 * Parse a `/language` argument. Only unambiguous tokens are accepted; anything else returns undefined
 * so the command can show the picker instead of silently switching to English on a typo.
 */
function parseLangArg(arg: string): Lang | undefined {
	const s = arg.trim().toLowerCase();
	if (!s) return undefined;
	if (s === "zh" || s === "cn" || s === "chinese" || s === "中文" || s === "汉语" || s.startsWith("zh-")) return "zh";
	if (s === "en" || s === "english" || s === "英文" || s === "英语" || s.startsWith("en-")) return "en";
	return undefined;
}

/** The picker options, in the language they mean: each row names itself in its own tongue. */
const LANG_CHOICES: Array<{ label: string; lang: Lang }> = [
	{ label: "中文 — 用中文思考和说话", lang: "zh" },
	{ label: "English — think and speak in English", lang: "en" },
];

/** The user-visible notice after a switch, in the language just chosen. */
function switchedNote(lang: Lang): string {
	return lang === "zh" ? "伴侣改用中文思考和说话。" : "Your companion now thinks and speaks in English.";
}

/**
 * First-run onboarding: the startup surface teaches the few commands that matter, in the language
 * just chosen. Deliberately short — the changelog no longer prints at boot, and this is everything a
 * new user needs to find the rest.
 */
const TUTORIAL: Record<Lang, string> = {
	en: [
		"Quick start:",
		"- Just type to talk. /model or /login picks the model; /language switches language.",
		"- /mate shows its current state, /debug every internal number.",
		"- Release notes live in /changelog.",
	].join("\n"),
	zh: [
		"快速上手：",
		"- 直接打字聊天；/model 或 /login 配模型，/language 切换语言。",
		"- /mate 看它此刻的状态，/debug 看完整内部数值。",
		"- 更新日志在 /changelog。",
	].join("\n"),
};

export interface MateExtensionOptions {
	/** State directory override (defaults to getAgentDir()/mate). */
	dir?: string;
	/** Companion name for the birth seed. */
	name?: string;
}

export function createMateExtension(options: MateExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const rt = getRuntime({ dir: options.dir, name: options.name, onError: () => {} });

		// Live session context, refreshed on each event, used for idle checks and mode.
		let liveCtx: ExtensionContext | undefined;
		// Full volatile state is injected once per run; later LLM calls in the same run skip it.
		let injectedFullThisRun = false;

		// ---------------------------------------------------------------------
		// Tools
		// ---------------------------------------------------------------------
		pi.registerTool(createPonderTool(() => rt));
		pi.registerTool(createRememberTool(() => rt));
		pi.registerTool(createLookTool());
		pi.registerTool(createReminisceTool(() => rt));
		// The companion's own clock: alarms survive restarts and wake it on schedule.
		const alarmManager = new AlarmManager(rt.stateDir, (alarm) => {
			const L = linesFor(rt.language);
			rt.wakeFromSleep();
			injectedFullThisRun = false;
			pi.sendMessage(
				{ customType: "mate-alarm", content: L.alarmFired(alarm.label || alarm.id), display: false },
				{ triggerTurn: true },
			);
		});
		pi.registerTool(createAlarmTool(() => rt, alarmManager));

		// ---------------------------------------------------------------------
		// Boot: catch up across the powered-off gap + log this open, then beat while idle.
		// First run: ask which language this companion should think in, if the terminal can ask.
		// ---------------------------------------------------------------------
		pi.on("session_start", async (_event, ctx) => {
			liveCtx = ctx;
			injectedFullThisRun = false;
			try {
				rt.wake();
			} catch {
				// wake() is already defensive; never let a boot issue surface.
			}
			// Only when NOTHING was ever chosen — not on every English boot. Headless modes (json/print)
			// have no dialog; they keep the English default and the user can set /language later.
			if (!rt.languageChosen && ctx.hasUI) {
				try {
					const choice = await ctx.ui.select(
						"伴侣用什么语言思考？ / What language should your companion think in?",
						[...LANG_CHOICES.map((c) => c.label)],
					);
					const picked = LANG_CHOICES.find((c) => c.label === choice);
					// Escaping the dialog is a decision too: default to English so the picker never repeats.
					rt.setLanguage(picked?.lang ?? "en");
				} catch {
					// A failed dialog must not block boot.
				}
			}
			// A brand-new companion gets the short tutorial instead of a changelog dump (which no longer
			// prints at boot). Only when nothing has ever been said: not on every boot of an existing one.
			if (rt.state.counters.messages === 0 && ctx.hasUI) {
				ctx.ui.notify(TUTORIAL[rt.language], "info");
			}
			// Re-arm persisted alarms; the manager fires them through the callback above.
			alarmManager.scheduleNext();
			rt.startHeartbeat({
				onImpulse: (decision, thought) => onImpulse(decision, thought),
				authorThought: (state, memory, exclude) => {
					// The impulse just voiced must not come straight back as the next thought's hint.
					return authorThought(liveCtx!, rt.language, state, memory, exclude ?? []);
				},
				authorDream: (state, memory) => authorDream(liveCtx!, rt.language, state, memory),
				onSleepEnter: () => {
					// The visible farewell: drowsiness won, the model says goodnight, then it sleeps.
					const L = linesFor(rt.language);
					injectedFullThisRun = false;
					pi.sendMessage(
						{ customType: "mate-sleep", content: L.sleepFarewell, display: false },
						{ triggerTurn: true },
					);
				},
			});
		});

		// ---------------------------------------------------------------------
		// Cached prefix: two stable sections, split by how often they change.
		//
		//   companion - the guidance. Static per language, so it is emitted once and never re-sent.
		//   mate_core - identity, character, beliefs, memory summary. Slow-drift, still cacheable.
		//
		// They were ONE section glued together, which meant the whole block was rewritten whenever
		// either half changed - and the core half carried a per-message counter, so it changed every
		// turn. The user's complaint was that the guidance paragraph kept reappearing in the
		// transcript: this split plus the counter's move to the volatile tail is what stops it (P5).
		// ---------------------------------------------------------------------
		pi.on("before_agent_start", (event) => {
			try {
				const core = rt.stableContext();
				// companionSection() is guidance + the thinking-language declaration, in the chosen
				// language. English keeps the previous guidance wording verbatim; the new one-paragraph
				// declaration at its end is the only delta, so the first boot after upgrade takes one
				// cache miss, then holds. A language switch rewrites this whole section: one miss, then
				// holds again (P5).
				event.systemPromptOptions.sections = {
					...event.systemPromptOptions.sections,
					companion: companionSection(rt.language),
					mate_core: core,
				};
			} catch {
				// If sections are frozen for some reason, skip guidance; the state block still rides.
			}
		});

		// ---------------------------------------------------------------------
		// Volatile state, injected ephemerally per run (never persisted).
		//
		// Injected ONCE per run, on the first LLM call, as a hidden custom message AFTER the newest
		// turn. Custom messages reach the model wrapped in the harness's <system-event> envelope
		// ("a harness event, not the user"), and that envelope is the point: prepending the block
		// INTO the user's message text taught the model that the user speaks in <mate> logs — it
		// answered to "you sent me a <mate>..." instead of feeling its own state. As a separate
		// message the state can never be misattributed, and it still rides the uncached tail, so it
		// is paid exactly once per run either way. Later calls in the same run (tool-loop
		// continuations) skip injection: the model already has the state.
		// ---------------------------------------------------------------------
		pi.on("context", (event) => {
			try {
				if (injectedFullThisRun) return; // already carrying state for this run
				const block = rt.context(Date.now(), { minimal: false });
				// Only mark the run as served when a block actually exists — otherwise a failed/empty
				// projection would suppress injection for every later call in the same run too.
				if (!block) return;
				const stateMessage = {
					role: "custom",
					customType: "mate-state",
					content: block,
					display: false,
					timestamp: Date.now(),
				} as AgentMessage;
				injectedFullThisRun = true;
				return { messages: [...event.messages, stateMessage] };
			} catch {
				return;
			}
		});

		// ---------------------------------------------------------------------
		// Run lifecycle: track streaming, reset the full-context flag, settle.
		// ---------------------------------------------------------------------
		pi.on("agent_start", (_event, ctx) => {
			liveCtx = ctx;
			injectedFullThisRun = false;
			rt.setStreaming(true);
		});

		pi.on("agent_end", (event) => {
			// The judge trigger is measured in what the companion produced, not in minutes: a body that
			// has said 600 tokens since the last reading has lived through something worth reading.
			const tokens = runTokens(event.messages);
			rt.noteRunOutput(tokens.reply, tokens.thinking);
			// The thought-cadence floor is measured from the last model call's end.
			rt.noteCallEnd();
		});

		pi.on("agent_settled", (_event, ctx) => {
			rt.setStreaming(false);
			try {
				rt.onTurnSettled();
			} catch {
				// Defensive: settling must never throw.
			}
			maybeJudge(ctx);
		});

		// Closing: seal WHEN this body went to sleep, so it remembers its own comings and goings.
		pi.on("session_shutdown", () => {
			rt.setStreaming(false);
			rt.stopHeartbeat();
			try {
				rt.sleep();
			} catch {
				// Defensive: a failed close just leaves the mark for the next wake to seal.
			}
		});

		// ---------------------------------------------------------------------
		// Inbound (P1): let the message THROUGH. Move the state, surface a lean.
		// No suppression here — the model decides how to respond using the state block.
		// ---------------------------------------------------------------------
		pi.on("input", (event) => {
			try {
				const text = event.text ?? "";
				// Slash commands are meta-actions, not conversation: note that they happened so the model
				// can see what the user did to its environment, and otherwise leave them alone.
				if (text.trimStart().startsWith("/")) {
					const name = text.trimStart().slice(1).split(/\s+/)[0];
					if (name) rt.noteCommand(`/${name}`);
					return;
				}
				if (!text.trim()) return;
				// Only appraise interactive/RPC chat. Extension-driven prompts pass untouched.
				if (event.source !== "interactive" && event.source !== "rpc") return;

				// Move the affective state, recall (P4), compute the advisory lean.
				// The result is stashed for the `context` handler; we still let the turn continue.
				rt.onUserMessage(text);
				return { action: "continue" };
			} catch {
				// On any failure, behave like a normal assistant: never strand the user.
				return { action: "continue" };
			}
		});

		// ---------------------------------------------------------------------
		// Meta-visibility (P1): the user may rewind, fork, switch or otherwise drive the harness
		// with slash commands — that is THEIR toolset, and consistency comes from memory + mood,
		// not from hiding the tools. The model only needs to SEE what was done, so every built-in
		// command surfaces here as one generic note (commands routed through prompt() arrive via
		// `input` instead — no double notes).
		// ---------------------------------------------------------------------
		pi.on("slash_command", (event) => {
			try {
				rt.noteCommand(event.command, event.args);
			} catch {
				// Noting must never disturb the command itself.
			}
		});

		// Second-step selections are the generic "outcome" of a command: every blocking UI prompt
		// (ctx.ui.select/confirm/input/editor, any extension command's follow-up dialog) reports
		// what the user picked via ui_prompt_end, so the model sees the CHOICE, not just the command.
		pi.on("ui_prompt_end", (event) => {
			if (!event.outcome) return;
			try {
				rt.notePicked(event.outcome);
			} catch {
				// Noting must never disturb the prompt itself.
			}
		});

		// ---------------------------------------------------------------------
		// Cache warmth follows the body clock: while the companion sleeps there is no conversation
		// to keep warm, so every probe would be spent lighting an empty room. "stop" holds until the
		// next real request — waking resets it. Extensions loaded after this one may override.
		// ---------------------------------------------------------------------
		pi.on("cache_warming_decision", (_event): CacheWarmingDecisionEventResult => {
			if (rt.isAsleep()) return { action: "stop" };
			return {};
		});

		// ---------------------------------------------------------------------
		// The affect judge: a model reads the last few turns from outside and reports what moved.
		//
		// The reader is the one the user configured (see ./judge-run.ts `judgeReader`): a decision model or
		// a chat model named in settings
		//   { "mate": { "judgeModel": "provider/id" } }
		// and otherwise the model this conversation is already running on. It is due once the companion has
		// put JUDGE_MIN_OUTPUT_TOKENS of reply on screen since the last reading — or, for a named decision
		// model, JUDGE_MIN_CLASSIFIER_TOKENS of reply plus the reasoning it also reads — with at least a
		// new user turn in the window so the same exchange is not appraised twice. Two triggers check
		// that: the moment the companion files a memory (it has just shown the exchange mattered to it),
		// and the end of each run. The window, the -2..+2 question and the opponent routing are in
		// mate/judge.ts.
		// ---------------------------------------------------------------------
		pi.on("tool_result", (event, ctx) => {
			if (event.toolName !== "remember") return;
			maybeJudge(ctx);
		});

		/** The configured judge model, if any. Read every time: settings change without a restart. */
		function judgeModel(): string | undefined {
			const s = pi.getSettings() as { mate?: { judgeModel?: unknown } } | undefined;
			const m = s?.mate?.judgeModel;
			return typeof m === "string" && m.trim() ? m.trim() : undefined;
		}

		/** Reply tokens the user actually received, and the thinking tokens behind them, counted the way the
		 *  provider reported them. Kept apart because the two readers are gated differently: a decision
		 *  model is handed the reasoning too, a chat model is not. */
		function runTokens(messages: AgentMessage[]): { reply: number; thinking: number } {
			let reply = 0;
			let thinking = 0;
			for (const m of messages) {
				if (m.role !== "assistant") continue;
				const reasoning = m.usage.reasoning ?? 0;
				thinking += Math.max(0, reasoning);
				reply += Math.max(0, m.usage.output - reasoning);
			}
			return { reply, thinking };
		}

		/** Whether the reader that WOULD be asked gets the reasoning in its window: only a named decision
		 *  model, which answers eight ordinal questions in one pass instead of reading token by token. */
		function judgeReadsThinking(ctx: ExtensionContext): boolean {
			const model = judgeModel();
			const ref = model === undefined ? null : parseModelRef(model);
			if (!ref) return false;
			return ctx.modelRegistry.findOfType("classifier", ref.provider, ref.id) !== undefined;
		}

		function maybeJudge(ctx: ExtensionContext): void {
			const readsThinking = judgeReadsThinking(ctx);
			if (!rt.judgeDue(readsThinking)) return;
			// Fire and forget: a reading must never delay the reply it is reading about. runAffectJudge
			// holds its own slot, so a beat and a `remember` cannot start two.
			void runAffectJudge(rt, ctx, {
				model: judgeModel(),
				// The ways this feature fails quietly are the ones the user cannot see from the
				// conversation: a model string that resolves to nothing, and a provider that answers with
				// an error. Both are worth one line, and only one line per stretch of exchange.
				onError: (err) => ctx.ui.notify(judgeFailureLine(err, rt.language), "warning"),
			}).then((reading) => {
				if (reading) ctx.ui.notify(judgeReadingLine(reading, rt.language), "info");
			});
		}

		// ---------------------------------------------------------------------
		// /mate: a public, user-safe view. Private thoughts are never shown.
		// ---------------------------------------------------------------------
		pi.registerCommand("mate", {
			description: "Show your companion's public mood and drives (private thoughts are never shown)",
			handler: async (_args, ctx) => {
				try {
					const snap = rt.publicSnapshot();
					ctx.ui.notify(formatSnapshot(snap, rt.language), "info");
				} catch {
					ctx.ui.notify("companion state unavailable", "warning");
				}
			},
		});

		// ---------------------------------------------------------------------
		// /debug: the developer view. Every number the model-facing state block
		// tiers away — drives, felt emotions, habituation, counters — in one dump.
		// The model reads words; this is where the floats live for the human.
		// ---------------------------------------------------------------------
		pi.registerCommand("debug", {
			description: "Dump the companion's full internal state (all numbers, developer view)",
			handler: async (_args, ctx) => {
				try {
					ctx.ui.notify(debugView(rt.state, Date.now()), "info");
				} catch {
					ctx.ui.notify("companion state unavailable", "warning");
				}
			},
		});

		// ---------------------------------------------------------------------
		// /language: what language this companion thinks in. Persisted in the state dir, so it

		// ---------------------------------------------------------------------
		// /language: what language this companion thinks in. Persisted in the state dir, so it
		// survives power-off. No built-in /language exists, so there is no command collision; if a
		// third-party extension registers one too, pi renames ours (language:N), never the reverse.
		// ---------------------------------------------------------------------
		pi.registerCommand("language", {
			description: "Pick the language your companion thinks and speaks in (中文 / English)",
			handler: async (args, ctx) => {
				let next = parseLangArg(args ?? "");
				if (!next && ctx.hasUI) {
					const choice = await ctx.ui.select(
						"语言 / Language",
						LANG_CHOICES.map((c) => c.label),
					);
					next = LANG_CHOICES.find((c) => c.label === choice)?.lang;
				}
				if (!next) {
					// Headless with no argument: just report the current setting.
					ctx.ui.notify(`language: ${LANG_NAMES[rt.language]}  (/language zh | en)`, "info");
					return;
				}
				rt.setLanguage(next);
				ctx.ui.notify(switchedNote(next), "info");
			},
		});

		// ---------------------------------------------------------------------
		// Helpers
		// ---------------------------------------------------------------------

		/**
		 * The heartbeat decided something wants saying. We OFFER the impulse to the model — the
		 * thought and nothing else — and let it choose whether and how to express it: through a
		 * reply, a self-discovered channel, a `look`, or not at all. We do NOT send a message on our
		 * own; that is the whole point of the "discover it yourself" requirement (P1).
		 */
		function onImpulse(decision: ImpulseDecision, thought: Thought): void {
			if (decision.action !== "reach_out") return;
			try {
				// Do not talk over a running turn; the next beat will try again.
				if (liveCtx && !liveCtx.isIdle()) return;

				// The impulse is the companion's own inner voice, so it arrives in ITS language.
				const L = linesFor(rt.language);
				const content = [L.impulseSurfaced(thought.text), "", L.impulseDecide, L.impulseBody].join("\n");

				rt.recordProactive();
				rt.noteProactiveSent();
				injectedFullThisRun = false; // the proactive turn should get a full state block
				pi.sendMessage({ customType: "mate-impulse", content, display: false }, { triggerTurn: true });
			} catch {
				// Proactive outreach is best-effort; never disrupt an active session on failure.
			}
		}
	};
}

/** Render the public snapshot as a short, human line for /mate, in the companion's language. */
function formatSnapshot(snap: Record<string, unknown>, lang: Lang = "en"): string {
	const L = linesFor(lang);
	const mood = snap.mood as { p?: number; a?: number; d?: number } | undefined;
	const rel = snap.relationship as { trust?: number; attachment?: number } | undefined;
	const drives = snap.drives as Record<string, number> | undefined;
	const top = drives
		? Object.entries(drives)
				.filter(([, v]) => typeof v === "number" && v >= 0.3)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([k, v]) => `${driveGloss(k, lang)} ${(v as number).toFixed(2)}`)
				.join(lang === "zh" ? " " : ", ")
		: "";
	const bits = [
		mood ? L.snapMood(`${mood.p?.toFixed(2)},${mood.a?.toFixed(2)},${mood.d?.toFixed(2)}`) : "",
		rel ? `${L.snapTrust(rel.trust?.toFixed(2) ?? "")} ${L.snapClose(rel.attachment?.toFixed(2) ?? "")}` : "",
		top ? `${L.snapDrives} ${top}` : "",
	].filter(Boolean);
	return bits.length ? bits.join(" | ") : L.snapQuiet;
}

export default createMateExtension();
