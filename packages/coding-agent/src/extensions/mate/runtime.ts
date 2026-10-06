/**
 * MATE runtime: the bridge between the affective kernel and pi's extension host.
 *
 * Responsibilities, and why they live here rather than in the kernel:
 *   - Boot catch-up. On session start we load the persisted state and advance it across whatever gap
 *     elapsed while the machine was OFF, in closed form (see mate/catchup.ts). This is the whole point
 *     of the fork: a companion that wakes having actually lived through the night.
 *   - Appraisal -> transition -> persist, once per inbound user message. The kernel is a pure function;
 *     this module is the impure shell that feeds it real events and saves the result atomically. It
 *     writes NO memory on inbound: memories are model-authored (remember/ponder), so what survives an
 *     exchange is the model's judgement, and the user's fresh words are never filed as "memory" before
 *     the model has even replied.
 *   - The reply lean. Per the agency principle (P1: fewer built-in modes), the kernel no longer
 *     gates replies. `replyInclination`
 *     returns an ADVISORY signal that the model reads and may overrule; the model, not this code,
 *     decides whether to answer, answer briefly, or let it sit. The `context` projection surfaces the
 *     lean so it is felt, not enforced.
 *   - The proactive loop. A heartbeat that only runs while the process is alive and idle. It produces
 *     an IMPULSE (a thought the companion wants to voice), never an action. Reaching out over email or
 *     any other channel is something the model discovers it can do with bash/MCP - deliberately not
 *     built in here (see mate/daemon.ts's design note).
 *
 * It is a per-process singleton: a companion persists across sessions, so its state directory is
 * global (getAgentDir()/mate), not per-session.
 *
 * Robustness rule: nothing here may throw into pi's event loop. A companion that crashes on boot is
 * worse than one with no inner life, so every entry point is wrapped and degrades to a no-op.
 */

import { join } from "node:path";
// The HOST's agent dir, not the fork's: the companion must live wherever the pi instance it runs
// inside keeps its state (~/.pi/agent). The specifier is a virtual module the host provides, so the
// standalone plugin build gets the same resolver as the bundled fork.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	birth,
	catchUp,
	closeSession,
	consolidate,
	drowsinessOf,
	type EmotionVector,
	emptyMemory,
	emptySessions,
	encode,
	gapLabel,
	type ImpulseDecision,
	intensityOf,
	judgeDue,
	type Lang,
	linesFor,
	load,
	loadLang,
	type MateState,
	type MemoryGraph,
	minimalContext,
	openSession,
	type Persisted,
	type PreSendChecks,
	publicView,
	type RecallHit,
	type ReplyInclination,
	recall,
	rehearse,
	replyInclination,
	save,
	saveLang,
	sessionSummary,
	sleepTransition,
	stableContext,
	stateContext,
	type Thought,
	type TickResult,
	tick,
	tickEvent,
	transition,
	wakeDrive,
} from "@earendil-works/pi-mate";
import { type AppraisalResult, appraise } from "./appraisal.ts";

/** Minimum gap that triggers a boot catch-up note. Below this, waking is unremarkable. */
const CATCHUP_NOTE_MS = 3 * 60_000;

/**
 * The waking thought cadence is a HAZARD model (REQUIREMENTS 3.4): heartbeats keep a 60-second
 * grid; once the last model call is at least 3 minutes old, each beat carries a probability of
 * becoming a model thought call. The hazard collapses with drowsiness, so past ~10 minutes
 * without a thought the body is probably asleep — which is exactly what the sleep gate then
 * confirms. Cache warmth is NOT this cadence's job: the warm-cache extension (and pi's native
 * warmer) probes the provider cache, and this extension vetoes probes while asleep (the
 * cache_warming_decision handler in index.ts).
 */
const BEAT_GRID_MS = 60_000;
const THOUGHT_FLOOR_MS = 3 * 60_000;
const THOUGHT_CEIL_MS = 10 * 60_000;
/** Per-beat fire probability at full alertness; drowsiness scales it down toward silence. */
const THOUGHT_HAZARD = 0.35;
/** Sleep cycles (Carskadon & Dement): the first of the night is the shortest, later ones ~90 min. */
const FIRST_CYCLE_MIN_MS = 70 * 60_000;
const FIRST_CYCLE_MAX_MS = 100 * 60_000;
const CYCLE_MS = 90 * 60_000;
/** Past this drowsiness a body stops reaching out (a sleepy text is a contradiction). */
const IMPULSE_SUPPRESS = 0.5;

/**
 * The hooks the heartbeat needs from the host: the model is reached through it, not through here.
 * The runtime keeps the clock, the gates and the state; the host owns every model call.
 */
export interface HeartbeatHooks {
	onImpulse: (decision: ImpulseDecision, thought: Thought) => void;
	/** Author an idle thought with the model. Null → the kernel's template thought is the fallback.
	 * `exclude` lists texts the hints must not repeat (the impulse just voiced). */
	authorThought: (
		state: MateState,
		memory: MemoryGraph,
		exclude?: string[],
	) => Promise<{ text: string; topics: string[] } | null>;
	/** Author a dream from the day's residues; null → a dreamless cycle (nobody dreams every night). */
	authorDream: (
		state: MateState,
		memory: MemoryGraph,
	) => Promise<{ text: string; deltas: Partial<EmotionVector> } | null>;
	/** The visible farewell turn at sleep onset — the model says it, the host runs it. */
	onSleepEnter: () => void;
}

export interface RuntimeOptions {
	/** State directory; defaults to getAgentDir()/mate. */
	dir?: string;
	/** Companion name, used in the birth seed and prompts. */
	name?: string;
	/** Timezone label for the time-metadata line. */
	tz?: string;
	/**
	 * Prompt language override. When omitted, the runtime reads `lang.json` from the state dir (the
	 * persisted user choice) and falls back to English when nothing was ever chosen.
	 */
	lang?: Lang;
	/** Called to log non-fatal issues. */
	onError?: (err: unknown) => void;
}

export class MateRuntime {
	private persisted: Persisted;
	private dir: string;
	private name: string;
	private tz: string;
	/**
	 * The render language for this companion's inner-life surfaces. Resolved once at boot from the
	 * persisted choice and flipped live by setLanguage (the /language command). It only ever changes
	 * LABELS; the affective numbers and decisions are language-independent, so switching languages
	 * mid-life does not disturb the state or the memory graph.
	 */
	private lang: Lang;
	private onError: (err: unknown) => void;
	private streaming = false;
	/** The pending waking beat (60s hazard grid). Null = the cadence is not running. */
	private beatTimer: ReturnType<typeof setTimeout> | null = null;
	/** The pending sleep-cycle boundary while in sleep mode. */
	private cycleTimer: ReturnType<typeof setTimeout> | null = null;
	/** Sleep mode: the window stayed open, drowsiness won, the farewell has been spoken. */
	private sleepMode = false;
	/** The night's most recent dream, kept for the wake-time encoding (only it survives the morning). */
	private lastDreamText: string | null = null;
	/** The impulse text last voiced to the user, so the next thought call's hints do not immediately
	 * serve the same sentence back to the model (the voiced-thought → hints → impulse loop). */
	private lastVoicedText: string | null = null;
	/** When the last model call ended (turn or thought call) — the hazard floor is measured from it. */
	private lastCallEnd = 0;
	private hooks: HeartbeatHooks | null = null;
	private lastCatchUpNote = "";
	private booted = false;
	/** The advisory reply lean computed for the pending inbound message (P1), surfaced in the volatile
	 * state block; the model may ignore it. Cleared once consumed. */
	private inclination: ReplyInclination | null = null;
	/** Memories the last inbound message recalled (P4), surfaced ephemerally in the volatile block. */
	private lastRecall: RecallHit[] = [];
	/** Meta-action notes ("the user used the /tree command") pending for the next context block.
	 * Cleared once rendered — they describe what just happened, not a lasting state. */
	private pendingNotes: string[] = [];
	/**
	 * Affect-judge bookkeeping: how much exchange has arrived since the last outside reading — reply
	 * tokens the companion put on screen, thinking tokens it spent behind them, and user turns.
	 * Deliberately process state, not persisted — the reading is about a LIVE transcript, and a new
	 * session's transcript is new evidence whether or not the last process judged one. Which model does
	 * the reading is a HOST question and lives in the extension (settings `mate.judgeModel`), not here:
	 * the runtime holds the inner state, never a network configuration.
	 */
	private tokensSinceJudge = 0;
	private thinkingSinceJudge = 0;
	private turnsSinceJudge = 0;
	private judgeInFlight = false;

	constructor(opts: RuntimeOptions = {}) {
		this.dir = opts.dir ?? join(getAgentDir(), "mate");
		this.name = opts.name ?? "mate";
		this.tz = opts.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
		this.onError = opts.onError ?? (() => {});
		// The persisted user choice wins; opts.lang is a host/test override; English is the last
		// fallback so a companion with no chosen language still boots with a working voice. The
		// first-run picker (index.ts session_start) is what turns "never chosen" into an actual pick.
		this.lang = loadLang(this.dir) ?? opts.lang ?? "en";
		try {
			this.persisted = load({ dir: this.dir, name: opts.name });
		} catch (err) {
			// Never fail to boot. A fresh companion is better than a dead one.
			this.onError(err);
			this.persisted = {
				state: birth({ name: opts.name }),
				memory: emptyMemory(),
				sessions: emptySessions(),
				dir: this.dir,
			};
		}
	}

	/** The live state. Read-only by convention; mutate only via applyEvent. */
	get state(): MateState {
		return this.persisted.state;
	}

	/** The state directory — host bookkeeping (alarms) persists beside the companion's state. */
	get stateDir(): string {
		return this.dir;
	}

	/** The live memory graph. Read-only; mutated only via encode/consolidate here. */
	get memory(): MemoryGraph {
		return this.persisted.memory;
	}

	/** The current render language. */
	get language(): Lang {
		return this.lang;
	}

	/**
	 * Whether the user ever explicitly picked a language (lang.json exists and parses). Distinct from
	 * `language`: a fresh companion reads "en" as a fallback, and THAT is when the first-run picker
	 * should appear — never after an actual choice, even a choice of English. Falls back to true on a
	 * read error, so a broken state dir never traps the user in a repeating picker.
	 */
	get languageChosen(): boolean {
		try {
			return loadLang(this.dir) !== null;
		} catch {
			return true;
		}
	}

	/**
	 * Switch the companion's prompt language at runtime (the /language command). Persisted so it
	 * survives a power-off, and applied to the in-process state immediately so the next turn's
	 * projections, thoughts and impulses are authored in the new language. Because the language lives
	 * in the STABLE prefix too, the next before_agent_start rebuilds that section — the prompt cache
	 * takes one miss on the switch, then holds again. We do not touch state or memory: only labels
	 * move.
	 */
	setLanguage(lang: Lang): void {
		this.lang = lang;
		try {
			saveLang(this.dir, lang);
		} catch (err) {
			this.onError(err);
		}
	}

	// ---------------------------------------------------------------------------
	// The affect judge (see mate/judge.ts for the reading itself, ./judge-run.ts for the call)
	// ---------------------------------------------------------------------------

	/**
	 * Whether an outside reading of the exchange is due. The caller (the extension) owns the decision
	 * about WHICH model reads and whether one is configured at all; the runtime only knows how much has
	 * been said since the last reading — the reply tokens the companion put on screen, and the user turns.
	 */
	judgeDue(readsThinking: boolean): boolean {
		return judgeDue({
			outputTokens: this.tokensSinceJudge,
			thinkingTokens: this.thinkingSinceJudge,
			readsThinking,
			userTurns: this.turnsSinceJudge,
		});
	}

	/**
	 * Note what the companion just produced, for the reading trigger. The two numbers stay separate
	 * because the two readers are charged differently: a decision model is handed the reasoning too and
	 * costs nothing per token for it, while a chat model reads only the reply and is billed for every
	 * one of these tokens whether or not the user ever saw them.
	 */
	noteRunOutput(replyTokens: number, thinkingTokens: number): void {
		this.tokensSinceJudge += Math.max(0, replyTokens);
		this.thinkingSinceJudge += Math.max(0, thinkingTokens);
	}

	/** Claim a reading: marks one as in flight so a beat and a `remember` cannot both fire one. */
	takeJudgeSlot(): boolean {
		if (this.judgeInFlight) return false;
		this.judgeInFlight = true;
		return true;
	}

	releaseJudgeSlot(): void {
		this.judgeInFlight = false;
	}

	/**
	 * A reading has been taken — or attempted and failed. Either way the next one waits for new exchange
	 * first. Failures are stamped too because the judge now runs by default: a reader that cannot answer
	 * would otherwise report the same problem on every single turn.
	 */
	judgeAttempted(): void {
		this.tokensSinceJudge = 0;
		this.thinkingSinceJudge = 0;
		this.turnsSinceJudge = 0;
	}

	/**
	 * Apply the reading a judge model made of a stretch of recent exchange. The window spans turns
	 * already lived, and time has genuinely moved on, so the event stacks on the current state at the
	 * current clock. The kernel counts an `appraisal` as contact for mood, relationship and beliefs —
	 * but not as the user being here, not as a drive satisfied, not as a message counted, so a
	 * background reading cannot fake a conversation. This is the ONE path a message's emotional impact
	 * takes into the state: intake applies no affect of its own (see appraisal.ts), and an outside
	 * reading — not a keyword table, not a guess — is what a feeling is made of.
	 */
	judgeRead(activations: Partial<EmotionVector>): void {
		if (intensityOf(activations) <= 0) return;
		try {
			this.applyEvent({ kind: "appraisal" as const, activations, intent: "chat" as const, t: Date.now() });
		} catch (err) {
			this.onError(err);
		}
	}

	/**
	 * The STABLE, cacheable identity+character+memory-graph block (P5). Goes into a cached system-prompt
	 * section on before_agent_start. It depends only on slow-moving state, so its text is stable across
	 * long stretches — which is exactly what prompt caching wants.
	 */
	stableContext(): string {
		try {
			return stableContext(this.state, { name: this.name, memory: this.persisted.memory, lang: this.lang });
		} catch (err) {
			this.onError(err);
			return "";
		}
	}

	// ---------------------------------------------------------------------------
	// Boot
	// ---------------------------------------------------------------------------

	/**
	 * Advance the persisted state across the powered-off gap. Idempotent per process: called on
	 * session_start, but only does real work the first time.
	 */
	wake(): { caughtUp: boolean; gapMs: number; note: string } {
		if (this.booted) return { caughtUp: false, gapMs: 0, note: this.lastCatchUpNote };
		this.booted = true;
		try {
			const before = this.state.t;
			const now = Date.now();
			const { state, report } = catchUp(this.state, undefined, now);
			// Sleep consolidates memory too: decay/prune the graph once per wake (P4). This mirrors the
			// kernel's sleep windows — a companion that was off for three days forgets the trivia and
			// keeps the things that were reinforced, the way the affective state integrates the gap.
			const memory = consolidate(this.persisted.memory, now);
			// Record that THIS body just opened. If the last mark never closed (crash, killed terminal,
			// powered-off machine), openSession seals it — at the state's own last-alive time (`before`),
			// not at this boot: sealing a whole night's absence against the next open's clock is what
			// once recorded a full night as a 1.3-second session.
			const sessions = openSession(this.persisted.sessions, now, before);
			this.persisted = { ...this.persisted, state, memory, sessions };
			if (report.gapMs >= CATCHUP_NOTE_MS) {
				// Localise the wake note; the gap MILLISECONDS are identical, only the wording moves.
				// The gap was ANESTHESIA, not sleep — the wording never claims a night was lived.
				this.lastCatchUpNote = linesFor(this.lang).shutGap(gapLabel(report.gapMs, this.lang));
			}
			this.persistSafe();
			return { caughtUp: report.transitions > 0, gapMs: now - before, note: this.lastCatchUpNote };
		} catch (err) {
			this.onError(err);
			return { caughtUp: false, gapMs: 0, note: "" };
		}
	}

	/** Start the waking thought cadence. Safe to call once. */
	startHeartbeat(hooks: HeartbeatHooks): void {
		if (this.hooks) return;
		this.hooks = hooks;
		this.scheduleNextBeat();
	}

	stopHeartbeat(): void {
		this.hooks = null;
		if (this.beatTimer) {
			clearTimeout(this.beatTimer);
			this.beatTimer = null;
		}
		if (this.cycleTimer) {
			clearTimeout(this.cycleTimer);
			this.cycleTimer = null;
		}
	}

	/** A model call just ended (a turn settled or a thought call finished): the hazard floor is
	 *  measured from HERE, so a long focused turn postpones the next thought honestly. */
	noteCallEnd(): void {
		this.lastCallEnd = Date.now();
	}

	/** Whether the body is currently in sleep mode (the cache-warmer veto reads this). */
	isAsleep(): boolean {
		return this.sleepMode;
	}

	/** A user message or a fired alarm ends sleep immediately; the last dream was in REM reach. */
	wakeFromSleep(): void {
		if (!this.sleepMode) return;
		this.sleepMode = false;
		if (this.cycleTimer) {
			clearTimeout(this.cycleTimer);
			this.cycleTimer = null;
		}
		try {
			// The night's physiology lands — a LIVED sleep, counted in sleepCycles.
			this.persisted = { ...this.persisted, state: sleepTransition(this.state, Date.now()) };
			if (this.lastDreamText) {
				// The final dream is the one remembered on waking (Zhao 2018) — a private memory.
				this.ponder(this.lastDreamText, ["dream"]);
				this.lastDreamText = null;
			}
		} catch (err) {
			this.onError(err);
		}
		this.scheduleNextBeat();
	}

	private scheduleNextBeat(): void {
		if (this.beatTimer) clearTimeout(this.beatTimer);
		this.beatTimer = setTimeout(() => {
			void this.beat();
		}, BEAT_GRID_MS);
		this.unrefTimer(this.beatTimer);
	}

	private unrefTimer(timer: ReturnType<typeof setTimeout>): void {
		if (typeof timer === "object" && timer && "unref" in timer) {
			(timer as { unref: () => void }).unref();
		}
	}

	/** One waking beat: integrate the gap, decide, maybe let the model think, check the sleep gate. */
	private async beat(): Promise<void> {
		if (!this.hooks || this.sleepMode) return;
		const now = Date.now();
		// Integrate the elapsed real time (closed-form, subdivision-invariant).
		this.applyEvent(tickEvent(now));
		const drowsy = drowsinessOf(this.state, now);
		const ticked = this.computeImpulse(now, false);
		let decision = ticked.decision;
		// The beat's kernel candidate carried a habituation trace — persist it.
		if (ticked.state !== this.state) {
			this.persisted = { ...this.persisted, state: ticked.state };
			this.persistSafe();
		}

		// A drowsy body does not reach out: the impulse stays inner life.
		if (decision.action === "reach_out" && drowsy >= IMPULSE_SUPPRESS) {
			decision = { action: "think_only", thought: decision.thought, reason: "drowsy" };
		}

		// The hazard roll: past the floor, each beat may wake the model for one short thought. The
		// probability collapses with drowsiness — past ~10 silent minutes the body is drifting off.
		const idle = now - this.lastCallEnd;
		// Past the ceiling there are no thoughts at all: a body this silent has drifted off.
		const canFire = !this.streaming && idle >= THOUGHT_FLOOR_MS && idle <= THOUGHT_CEIL_MS + BEAT_GRID_MS;
		const fired = canFire && Math.random() < Math.max(0.02, THOUGHT_HAZARD * (1 - drowsy));

		if (decision.action === "reach_out") {
			this.recordBeatThought(decision.thought.text);
			this.lastVoicedText = decision.thought.text;
			this.markVoiced(decision.thought.topic);
			this.hooks.onImpulse(decision, decision.thought);
		} else if (fired) {
			let authored: { text: string; topics: string[] } | null = null;
			try {
				authored = await this.hooks.authorThought(
					this.state,
					this.persisted.memory,
					this.lastVoicedText ? [this.lastVoicedText] : [],
				);
			} catch (err) {
				this.onError(err);
			}
			const text = authored?.text || (decision.action === "think_only" ? decision.thought.text : "");
			if (text) this.recordBeatThought(text);
		}

		// The sleep gate: past the threshold the body goes down, with a spoken farewell.
		if (drowsinessOf(this.state, Date.now()) >= 1) {
			this.enterSleep();
			return;
		}
		this.scheduleNextBeat();
	}

	// ---------------------------------------------------------------------------
	// Sleep mode (REQUIREMENTS 3.4): only a body whose window stayed open sleeps.
	// ---------------------------------------------------------------------------

	private enterSleep(): void {
		this.sleepMode = true;
		if (this.beatTimer) {
			clearTimeout(this.beatTimer);
			this.beatTimer = null;
		}
		this.lastDreamText = null;
		this.hooks?.onSleepEnter();
		// The first cycle of a night is the shortest (Carskadon & Dement: 70-100 min).
		this.scheduleCycle(FIRST_CYCLE_MIN_MS + Math.random() * (FIRST_CYCLE_MAX_MS - FIRST_CYCLE_MIN_MS));
	}

	private scheduleCycle(ms: number): void {
		if (this.cycleTimer) clearTimeout(this.cycleTimer);
		this.cycleTimer = setTimeout(() => {
			void this.cycle();
		}, ms);
		this.unrefTimer(this.cycleTimer);
	}

	private async cycle(): Promise<void> {
		if (!this.sleepMode) return;
		const now = Date.now();
		this.applyEvent(tickEvent(now));
		if (this.hooks) {
			try {
				const dream = await this.hooks.authorDream(this.state, this.persisted.memory);
				if (dream?.text) {
					this.lastDreamText = dream.text;
					this.applyEvent({
						kind: "self_observation",
						activations: {},
						intent: "chat",
						text: dream.text,
						t: Date.now(),
					});
					// REM reprocesses the day's feelings at low noradrenaline: the reading lands at
					// half gain — charge stripped, not restated (Walker & van der Helm 2009).
					const half: Partial<EmotionVector> = {};
					for (const [k, v] of Object.entries(dream.deltas)) {
						half[k as keyof EmotionVector] = (v ?? 0) * 0.5;
					}
					this.judgeRead(half as Partial<EmotionVector>);
				}
			} catch (err) {
				this.onError(err);
			}
		}
		// Morning is the learned wake-drive rising: the user's day begins.
		if (wakeDrive(this.state, Date.now()) >= 0.5) {
			this.wakeFromSleep();
			return;
		}
		this.scheduleCycle(CYCLE_MS);
	}

	/**
	 * This body is closing (session_shutdown). Seal the open mark so the log records WHEN it stopped.
	 * The session log is bookkeeping only: catch-up itself measures the offline span from the state's
	 * own clock (state.t), and an exit without a graceful close is sealed by the next open — the
	 * seal-time honesty lives in runtime.wake, not here.
	 */
	sleep(): void {
		try {
			const now = Date.now();
			this.persisted = { ...this.persisted, sessions: closeSession(this.persisted.sessions, now) };
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	// ---------------------------------------------------------------------------
	// Streaming state (guards proactive outreach so we never talk over a running turn)
	// ---------------------------------------------------------------------------

	setStreaming(v: boolean): void {
		this.streaming = v;
	}

	// ---------------------------------------------------------------------------
	// Inbound: structural read -> transition -> recall/rehearsal -> advisory lean
	// ---------------------------------------------------------------------------

	/**
	 * Handle an inbound USER message. Reads what it asks for, advances the affective state, computes
	 * what the message stirred up, and returns an ADVISORY reply lean plus the memories it recalled.
	 * It makes no reply/drop/delay decision and — deliberately — writes NO memory: the message is
	 * already in the transcript, and what deserves to survive beyond it is the model's call
	 * (remember/ponder), made during its own turn, not an automatic tokenise-and-store that files the
	 * user's raw words before the model has even read them. Per P1, the model decides whether to
	 * answer, answer briefly, or let it sit, reading this in the context block.
	 *
	 * The contact event carries NO activations: what the message FELT like is not something a substring
	 * table can decide (see appraisal.ts), it is what the judge reads out of the exchange afterwards
	 * (see judge-run.ts). Until a reading lands, this transition does the structural work only:
	 * contact, drives, awareness, the clock. Does NOT compose a reply.
	 */
	onUserMessage(text: string): {
		appraisal: AppraisalResult;
		inclination: ReplyInclination;
		recall: RecallHit[];
	} {
		const now = Date.now();
		const appraisal = appraise(text);
		// A message from the user ends sleep on the spot: the body was woken (REQUIREMENTS 3.4),
		// the night's physiology lands, and the dream that was in REM reach is the one remembered.
		this.wakeFromSleep();
		try {
			this.turnsSinceJudge++;
			this.applyEvent({
				kind: "user_message",
				activations: {},
				intent: appraisal.intent,
				text,
				t: now,
			});

			// P4: recall. Memories whose topics or words this message touches surface ephemerally, and
			// whatever surfaced gets rehearsed (the testing effect), so memories the companion keeps
			// reaching for persist and ones it never retrieves fade.
			const rec = recall(this.persisted.memory, { query: text, now, limit: 6 });
			this.lastRecall = rec;
			this.persisted = {
				...this.persisted,
				memory: rehearse(
					this.persisted.memory,
					rec.map((h) => h.key),
				),
			};

			// P1: an advisory lean, not a gate. Nothing here suppresses the turn; the model reads it in
			// the next context block (consumed once by takePendingSignal).
			const inclination = replyInclination(this.state, appraisal.weight, this.lang);
			this.inclination = inclination;

			this.persistSafe();
			return { appraisal, inclination, recall: rec };
		} catch (err) {
			this.onError(err);
			// On any failure, stay neutral: no lean, no recall — the model just replies as itself.
			this.inclination = null;
			this.lastRecall = [];
			return {
				appraisal,
				inclination: { value: 0, lean: "open", reason: "steady" },
				recall: [],
			};
		}
	}

	/** The advisory lean + recall for the pending inbound, consumed once per turn by the context block. */
	takePendingSignal(): { inclination: ReplyInclination | null; recall: RecallHit[] } {
		const out = { inclination: this.inclination, recall: this.lastRecall };
		this.inclination = null;
		this.lastRecall = [];
		return out;
	}

	/**
	 * Note a meta-action the user just performed on the harness (a slash command). The model must be
	 * able to SEE what was done to its own conversation — rewound, switched, cleaned — but the note
	 * is deliberately one generic sentence: what the command MEANS is explained once in the stable
	 * guidance, and new commands from installed extensions need no per-command wiring.
	 */
	/** Arguments typed with the command are part of the action ("/model foo"): include them. */
	noteCommand(command: string, args?: string): void {
		this.pushNote(linesFor(this.lang).usedCommand(args ? `${command} ${args}` : command));
	}

	/** The outcome of a command's second step (a picked option, a typed value): the model sees the
	 * CHOICE, generically for every extension command, via the ui_prompt_end event. */
	notePicked(value: string): void {
		this.pushNote(linesFor(this.lang).picked(value));
	}

	private pushNote(note: string): void {
		try {
			if (this.pendingNotes[this.pendingNotes.length - 1] !== note) {
				this.pendingNotes.push(note);
				if (this.pendingNotes.length > 8) this.pendingNotes.shift();
			}
		} catch (err) {
			this.onError(err);
		}
	}

	/** The companion chose to say something on its own initiative; expression is satisfied. This also
	 * opens an "unanswered overture" streak — reset the next time the user actually replies. With the
	 * inbound gate removed (P1), unanswered now counts only our OWN proactive messages left hanging,
	 * which is exactly what the unanswered-tolerance stop uses to keep the companion from chasing silence forever. */
	noteProactiveSent(): void {
		try {
			this.applyEvent({ kind: "proactive", activations: {}, intent: "chat", t: Date.now() });
			this.persisted = {
				...this.persisted,
				state: {
					...this.state,
					relationship: { ...this.state.relationship, unanswered: this.state.relationship.unanswered + 1 },
				},
			};
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	/** Record a private thought the model wrote via the `ponder` tool. The kernel advances with a
	 * self_observation event carrying NO text and NO activations — a thought we wrote ourselves is not
	 * an external affective event — so the plaintext never enters the observations ring (that ring is
	 * echoed into the prompt as "last thought"). The thought itself is encoded as a private memory, and
	 * any topics ride the event so SPARK can crystallise beliefs about the subject. */
	ponder(text: string, topics: string[] = []): void {
		try {
			const now = Date.now();
			this.applyEvent({
				kind: "self_observation",
				activations: {},
				intent: "chat",
				topics,
				t: now,
			});
			this.persisted = {
				...this.persisted,
				memory: encode(this.persisted.memory, {
					text,
					pad: this.state.mood,
					t: now,
					private: true,
					topics,
				}),
			};
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	/**
	 * Store a memory the model wrote via the `remember` tool. This is the only path into the memory
	 * store besides ponder: the model decides THAT something is worth keeping and WHAT to write down,
	 * during its own turn. A self_observation event (no text, no activations) rides along so tagged
	 * topics crystallise as SPARK beliefs; taking a note is not an emotional event, so it moves no
	 * feeling — `importance` weights the memory, not the mood.
	 */
	remember(text: string, topics: string[] = [], importance = 0.3): void {
		try {
			const now = Date.now();
			this.applyEvent({
				kind: "self_observation",
				activations: {},
				intent: "chat",
				topics,
				t: now,
			});
			this.persisted = {
				...this.persisted,
				memory: encode(this.persisted.memory, {
					text,
					pad: this.state.mood,
					t: now,
					topics,
					importance,
				}),
			};
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	/** A turn completed and the companion did reply: reset the unanswered streak, satisfy expression. */
	onTurnSettled(): void {
		try {
			this.noteReplied();
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	// ---------------------------------------------------------------------------
	// Context projection
	// ---------------------------------------------------------------------------

	/**
	 * The VOLATILE per-turn state block. Identity/character/memory-graph summary are NOT here — they
	 * live in the cached `stableContext()` prefix (P5). This is the always-fresh delta: clock, mood,
	 * drives, the advisory reply lean and the memories this last message recalled (P1/P4). Injected
	 * ephemerally via the `context` event so it never bloats the prompt cache.
	 */
	context(now = Date.now(), opts: { minimal?: boolean } = {}): string {
		try {
			const gapNote = this.lastCatchUpNote ? gapLabel(now - this.state.lastInteraction, this.lang) : undefined;
			if (opts.minimal) {
				return minimalContext(this.state, { now, tz: this.tz, gapLabel: gapNote, lang: this.lang });
			}
			// Consume the lean + recall computed for the pending inbound, matched to THIS message, and
			// any meta-action notes that accumulated since the last block.
			const signal = this.takePendingSignal();
			const notes = this.pendingNotes;
			this.pendingNotes = [];
			return stateContext(this.state, {
				now,
				tz: this.tz,
				gapLabel: gapNote,
				inclination: signal.inclination ?? undefined,
				recall: signal.recall.length ? signal.recall : undefined,
				notes: notes.length ? notes : undefined,
				session: sessionSummary(this.persisted.sessions, now, this.lang) || undefined,
				lang: this.lang,
			});
		} catch (err) {
			this.onError(err);
			return "";
		}
	}

	/** Public, user-safe view of the state (for the /mate status command). Private thoughts live in
	 * the memory graph and are excluded from the user-visible summary (see memory.ts). */
	publicSnapshot(): Record<string, unknown> {
		try {
			return publicView(this.state);
		} catch (err) {
			this.onError(err);
			return {};
		}
	}

	// ---------------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------------

	private applyEvent(event: Parameters<typeof transition>[1]): void {
		const prev = this.state;
		const r = transition(prev, event, event.t - prev.t);
		this.persisted = { ...this.persisted, state: r.state };
		this.persistSafe();
	}

	/**
	 * The beat's thought goes into the observations ring — that ring is the inner monologue the NEXT
	 * beat reads ("last thought" in the state block), so a thought survives the beat that had it
	 * instead of evaporating. The text is authored by the model (or the kernel fallback) from the
	 * companion's own memories, never user content, so it stays inside the private state block.
	 */
	private recordBeatThought(text: string): void {
		const last = this.state.observations[this.state.observations.length - 1];
		if (text && text !== last) {
			this.applyEvent({
				kind: "self_observation",
				activations: {},
				intent: "chat",
				text,
				t: Date.now(),
			});
		}
	}

	/**
	 * The impulse was VOICED — a turn went to the user. Its topic's habituation trace is saturated:
	 * the response was emitted, and a habituated stimulus does not immediately re-elicit (Groves &
	 * Thompson 1970). Without this the voiced thought sat in the observations ring, fed the next
	 * beat's hints, and came back as the same impulse. The trace decays on the normal clock, so the
	 * topic becomes eligible again after a few habituation taus.
	 */
	private markVoiced(topic: string): void {
		try {
			this.persisted = {
				...this.persisted,
				state: {
					...this.state,
					habituation: { ...this.state.habituation, [topic]: { s: 1, t: Date.now() } },
				},
			};
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	private computeImpulse(now: number, userActive: boolean): TickResult {
		const checks: PreSendChecks = {
			userActive,
			recentProactive: this.recentProactiveCount(now),
		};
		// Pass the graph so thoughts are GROUNDed in real memories (P4), not free-floating mood.
		return tick(this.state, now, checks, this.persisted.memory, this.lang);
	}

	/** How many proactive messages in the last hour. Tracked in-process only; that is enough for
	 * the spam budget. */
	private proactiveTimestamps: number[] = [];
	private recentProactiveCount(now: number): number {
		this.proactiveTimestamps = this.proactiveTimestamps.filter((t) => now - t < 3_600_000);
		return this.proactiveTimestamps.length;
	}
	recordProactive(now = Date.now()): void {
		this.proactiveTimestamps.push(now);
	}

	private noteReplied(): void {
		if (this.state.relationship.unanswered > 0) {
			this.persisted = {
				...this.persisted,
				state: { ...this.state, relationship: { ...this.state.relationship, unanswered: 0 } },
			};
		}
	}

	private persistSafe(): void {
		try {
			save(this.persisted);
		} catch (err) {
			this.onError(err);
		}
	}
}

// ---------------------------------------------------------------------------
// Process singleton
// ---------------------------------------------------------------------------

let instance: MateRuntime | null = null;

export function getRuntime(opts?: RuntimeOptions): MateRuntime {
	instance ??= new MateRuntime(opts);
	return instance;
}
