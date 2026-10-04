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
import {
	birth,
	catchUp,
	closeSession,
	consolidate,
	type EmotionVector,
	emptyMemory,
	emptySessions,
	encode,
	gapLabel,
	type ImpulseDecision,
	type Intent,
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
	stableContext,
	stateContext,
	type Thought,
	type TickResult,
	tick,
	tickEvent,
	transition,
} from "@earendil-works/pi-mate";
import { getAgentDir } from "../../config.ts";
import { type AppraisalResult, appraise } from "./appraisal.ts";

/**
 * The live heartbeat interval while the process is alive. Deliberately NOT the kernel's canonical
 * HEARTBEAT_MS (params.ts, 60s): that value is what the catch-up integrator assumes about the world and
 * sizes its no-op floor by, and it stays 60s whatever the host does. Here the beat is a host choice —
 * the state integrates in closed form, so a coarser beat costs nothing in fidelity and keeps an idle
 * CLI quiet.
 */
const BEAT_MS = 5 * 60_000;

/** Minimum gap that triggers a boot catch-up note. Below this, waking is unremarkable. */
const CATCHUP_NOTE_MS = 3 * 60_000;

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
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private lastCatchUpNote = "";
	private booted = false;
	/** Snapshot of the state immediately before the last user message. `refine` replays from here with
	 * the vector the model reports instead of applying a SECOND contact event, so the feel-tool never
	 * double-counts time (states are immutable; holding the ref is safe). */
	private preEventState: MateState | null = null;
	/** The text of that same message, replayed into the refined event so topic beliefs still bear
	 * evidence from it (the kernel matches belief subjects against `event.text`). */
	private preEventText = "";
	private lastEventT = 0;
	/** Channels the model has told us about (e.g. it set up its own email). Not used by us directly;
	 * surfaced back into context so the companion remembers it has them. */
	private discoveredChannels: string[] = [];
	/** The advisory reply lean computed for the pending inbound message (P1), surfaced in the volatile
	 * state block; the model may ignore it. Cleared once consumed. */
	private inclination: ReplyInclination | null = null;
	/** Memories the last inbound message recalled (P4), surfaced ephemerally in the volatile block. */
	private lastRecall: RecallHit[] = [];
	/** Meta-action notes ("the user used the /tree command") pending for the next context block.
	 * Cleared once rendered — they describe what just happened, not a lasting state. */
	private pendingNotes: string[] = [];
	/**
	 * Affect-judge bookkeeping: when the last outside reading was taken and how many user turns have
	 * arrived since. Deliberately process state, not persisted — the reading is about a LIVE transcript,
	 * and a new session's transcript is new evidence whether or not the last process judged one. Which
	 * model does the reading is a HOST question and lives in the extension (settings `mate.judgeModel`),
	 * not here: the runtime holds the inner state, never a network configuration.
	 */
	private lastJudgeAt = 0;
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
	 * happened since the last reading.
	 */
	judgeDue(now = Date.now()): boolean {
		return judgeDue({ now, lastAt: this.lastJudgeAt, userTurns: this.turnsSinceJudge });
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
	 * Apply the reading a judge model made of a stretch of recent exchange. Unlike `refine` this is NOT a
	 * replay: the window spans turns already lived, and time has genuinely moved on, so the event stacks
	 * on the current state at the current clock. The kernel counts an `appraisal` as contact for mood,
	 * relationship and beliefs — but not as the user being here, not as a drive satisfied, not as a
	 * message counted, so a background reading cannot fake a conversation.
	 */
	judgeRead(activations: Partial<EmotionVector>): void {
		this.lastJudgeAt = Date.now();
		this.turnsSinceJudge = 0;
		if (intensityOf(activations) <= 0) return;
		try {
			const now = Date.now();
			const event = { kind: "appraisal" as const, activations, intent: "chat" as const, t: now };
			this.applyEvent(event);
			// A reading that lands mid-turn must move the snapshot `refine` replays from as well.
			// Otherwise that replay writes the pre-judgement state back and the reading vanishes — the
			// judge would be real only while the companion was quiet, which is when nobody is talking.
			if (this.preEventState) {
				const base = this.preEventState;
				this.preEventState = transition(base, event, now - base.t).state;
			}
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
			// Record that THIS body just opened. If the last mark never closed (crash / killed terminal),
			// openSession seals it at `now`, so the log stays honest about the comings and goings.
			const sessions = openSession(this.persisted.sessions, now);
			this.persisted = { ...this.persisted, state, memory, sessions };
			if (report.gapMs >= CATCHUP_NOTE_MS) {
				// Localise the wake note; the gap MILLISECONDS are identical, only the wording moves.
				this.lastCatchUpNote = linesFor(this.lang).caughtUp(
					gapLabel(report.gapMs, this.lang),
					report.sleeps.length,
				);
			}
			this.persistSafe();
			return { caughtUp: report.transitions > 0, gapMs: now - before, note: this.lastCatchUpNote };
		} catch (err) {
			this.onError(err);
			return { caughtUp: false, gapMs: 0, note: "" };
		}
	}

	/** Start the idle heartbeat. Safe to call once. */
	startHeartbeat(onImpulse: (decision: ImpulseDecision, thought: Thought) => void): void {
		if (this.heartbeat) return;
		this.heartbeat = setInterval(() => {
			try {
				this.heartbeatTick(onImpulse);
			} catch (err) {
				this.onError(err);
			}
		}, BEAT_MS);
		// Do not keep the process alive just to beat.
		if (typeof this.heartbeat === "object" && this.heartbeat && "unref" in this.heartbeat) {
			(this.heartbeat as { unref: () => void }).unref();
		}
	}

	stopHeartbeat(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
	}

	/**
	 * This body is closing (session_shutdown). Seal the open mark so the log records WHEN it stopped —
	 * the requirement that the companion knows when it was opened and when it was put down. The next
	 * wake's catch-up measures the offline span from this close, not from the last message.
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
	 * The contact event carries NO activations. A message's emotional impact is not something a
	 * substring table can decide (see appraisal.ts); it is something the companion reports about
	 * itself, through `feel`. Until then this transition does the structural work only: contact,
	 * drives, awareness, the clock. Does NOT compose a reply.
	 */
	onUserMessage(text: string): {
		appraisal: AppraisalResult;
		inclination: ReplyInclination;
		recall: RecallHit[];
	} {
		const now = Date.now();
		const appraisal = appraise(text);
		try {
			// Remember the pre-event state so `refine` can replay with the model's vector, not stack.
			this.preEventState = this.state;
			this.preEventText = text;
			this.lastEventT = now;
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

	/**
	 * Put the model's own read of the LAST user message into its state. Intake applies no affect
	 * (appraisal.ts reads structure, not feeling), so this is how a message moves the companion's
	 * feelings one at a time. The event is REPLAYED from the pre-message snapshot rather than stacked on
	 * top, so the message is counted once — same clock, same drive satisfaction, same contact — with the
	 * reported vector now driving the kick, the mood, the relationship and the belief evidence.
	 */
	refine(activations: Partial<EmotionVector>, intent: Intent): void {
		try {
			const base = this.preEventState ?? this.state;
			const t = this.lastEventT || Date.now();
			const r = transition(
				base,
				{ kind: "user_message", activations, intent, text: this.preEventText, t },
				t - base.t,
			);
			this.persisted = { ...this.persisted, state: r.state };
			// The refine re-reads affect; it does not change any reply choice (there is no gate — the
			// model already owns that).
			this.persistSafe();
		} catch (err) {
			this.onError(err);
		}
	}

	/** The companion chose to say something on its own initiative; expression is satisfied. This also
	 * opens an "unanswered overture" streak — reset the next time the user actually replies. With the
	 * inbound gate removed (P1), unanswered now counts only our OWN proactive messages left hanging,
	 * which is exactly what preSendReview uses to keep the companion from chasing silence forever. */
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
			const L = linesFor(this.lang);
			const gapNote = this.lastCatchUpNote ? gapLabel(now - this.state.lastInteraction, this.lang) : undefined;
			if (opts.minimal) {
				return minimalContext(this.state, { now, tz: this.tz, gapLabel: gapNote, lang: this.lang });
			}
			// Consume the lean + recall computed for the pending inbound, matched to THIS message, and
			// any meta-action notes that accumulated since the last block.
			const signal = this.takePendingSignal();
			const notes = this.pendingNotes;
			this.pendingNotes = [];
			const body = stateContext(this.state, {
				now,
				tz: this.tz,
				gapLabel: gapNote,
				inclination: signal.inclination ?? undefined,
				recall: signal.recall.length ? signal.recall : undefined,
				notes: notes.length ? notes : undefined,
				session: sessionSummary(this.persisted.sessions, now, this.lang) || undefined,
				lang: this.lang,
			});
			// Surface discovered channels so the companion remembers what it set up for itself.
			const channels = this.discoveredChannels.length ? L.channelsYouSet(this.discoveredChannels.join(L.sep)) : "";
			return `${body}${channels}`;
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

	/**
	 * Record that the model discovered a reach-out channel (email, webhook, ...) on its own. The fact
	 * surfaces in the context block for this process AND is folded into the memory graph as a private
	 * memory, so it survives a restart: recall can bring "I can reach them via email" back after the
	 * companion wakes up, the same way any other memory persists. Nothing here takes any action.
	 */
	addDiscoveredChannel(name: string): void {
		if (this.discoveredChannels.includes(name)) return;
		this.discoveredChannels.push(name);
		try {
			const now = Date.now();
			this.persisted = {
				...this.persisted,
				memory: encode(this.persisted.memory, {
					text: `I can reach them via ${name}`,
					pad: this.state.mood,
					t: now,
					private: true,
				}),
			};
			this.persistSafe();
		} catch (err) {
			this.onError(err);
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

	/** Advance one idle beat and decide whether to reach out. */
	private heartbeatTick(onImpulse: (decision: ImpulseDecision, thought: Thought) => void): void {
		if (this.streaming) return; // never talk over a running turn
		const now = Date.now();
		// Integrate the elapsed real time (closed-form, subdivision-invariant).
		this.applyEvent(tickEvent(now));
		const { decision, state } = this.computeImpulse(now, false);
		// The beat thought something: its habituation trace is part of the state, so a topic this
		// companion keeps circling loses urgency instead of arriving fresh every single time.
		if (state !== this.state) {
			this.persisted = { ...this.persisted, state };
			this.persistSafe();
		}
		if (decision.action === "reach_out") onImpulse(decision, decision.thought);
	}

	private computeImpulse(now: number, userActive: boolean): TickResult {
		const checks: PreSendChecks = {
			hour: new Date(now).getHours(),
			userActive,
			recentProactive: this.recentProactiveCount(now),
			topic: "",
			coldEnding: this.state.relationship.frustration > 0.5,
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
