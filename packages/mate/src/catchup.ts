/**
 * Offline catch-up: the piece MATE does not need and this fork does.
 *
 * The paper's daemon assumes a box that is always on: a 60-second heartbeat ticks continuously,
 * and "an instance left alone for 24 hours will have different emotional state". On a laptop or a
 * phone that is powered off at night, no heartbeat runs, so a naive port would wake up with
 * frozen state - the companion would have no inner life across the gap, which is exactly the
 * property we are trying to build.
 *
 * The obvious fix - replay N = gap/60s heartbeats on boot - is wrong twice over. For a week
 * offline that is 10,080 iterations of work whose result is a smooth exponential anyway, and the
 * accumulated floating-point error grows with N, so the longer the gap the less reproducible the
 * state becomes. That breaks the kernel's central guarantee.
 *
 * The fix used here: every time-dependent term in the kernel is already written in closed form.
 * Exponential decay e^{-lambda*dt}, the O-U mood integral, Lindblad dephasing and drive rise are
 * all analytic in dt, so stepping once over dt = one week is mathematically identical to stepping
 * 10,080 times over 60 seconds - and O(1) instead of O(N). `catchUp()` therefore applies the gap
 * as a single closed-form jump, then replays only the genuinely discrete events (the sleep
 * windows that were crossed, which are phase resets and cannot be smoothed into the integral).
 *
 * Two consequences worth stating plainly:
 *   - Cost of boot after any gap, from one minute to one year, is constant: a handful of kernel
 *     transitions, no LLM calls.
 *   - The result is reproducible: same state, same gap, same seed -> bit-identical output,
 *     regardless of how the gap is subdivided. `verifySubdivisionInvariance()` tests exactly this.
 */

import { fmtDurSpaced, type Lang } from "./i18n.ts";
import { sleepTransition, transition } from "./kernel.ts";
import { HEARTBEAT_MS, MOOD, SLEEP_WINDOW } from "./params.ts";
import type { MateEvent, MateState } from "./types.ts";

/** One sleep window that was crossed while offline. */
export interface CrossedSleep {
	/** Local hour the window started. */
	startHour: number;
	/** Epoch ms of the window start, in the companion's timezone. */
	t: number;
}

export interface CatchUpReport {
	/** Total wall-clock gap covered, ms. */
	gapMs: number;
	/** Human-readable gap. */
	gapLabel: string;
	/** Sleep windows consolidated retroactively. */
	sleeps: CrossedSleep[];
	/** Continuous transitions applied (always 1 for the gap itself, plus one per sleep). */
	transitions: number;
	/** Milliseconds of CPU spent. Should stay in the low single digits for any gap. */
	elapsedMs: number;
	/** Whether the gap was long enough that drives saturated. */
	drivesSaturated: boolean;
}

/** A time source and timezone, injectable so tests are deterministic. */
export interface Clock {
	now(): number;
	/** Local hour (0-23) and minute for an epoch ms. */
	localParts(t: number): { hour: number; minute: number; dayMs: number };
	/** Epoch ms for a given day boundary plus local hour. */
	atLocalHour(t: number, hour: number, minute?: number): number;
}

/** System clock in the process timezone. */
export function systemClock(): Clock {
	return {
		now: () => Date.now(),
		localParts(t: number) {
			const d = new Date(t);
			const hour = d.getHours();
			const minute = d.getMinutes();
			return { hour, minute, dayMs: hour * 3_600_000 + minute * 60_000 + d.getSeconds() * 1000 };
		},
		atLocalHour(t: number, hour: number, minute = 0) {
			const d = new Date(t);
			d.setHours(hour, minute, 0, 0);
			return d.getTime();
		},
	};
}

/**
 * Enumerate the sleep windows (default 01:00-05:00 local) crossed in (from, to].
 *
 * A window counts as crossed when its start has passed. We return window starts in ascending
 * order so consolidation replays them chronologically - the order matters, because each sleep
 * resets fatigue and the next segment's decay starts from that new value.
 */
export function crossedSleepWindows(from: number, to: number, clock: Clock): CrossedSleep[] {
	if (to <= from) return [];
	const [startHour] = SLEEP_WINDOW;
	const out: CrossedSleep[] = [];
	const DAY = 86_400_000;
	// Walk day by day. Bounded by the gap length, so at most ~366 iterations per year offline.
	let cursor = clock.atLocalHour(from, startHour);
	if (cursor <= from) cursor += DAY;
	let guard = 0;
	while (cursor <= to && guard < 4000) {
		out.push({ startHour, t: cursor });
		cursor += DAY;
		guard++;
	}
	return out;
}

/**
 * Label a gap the way a person would describe it. `lang` only changes the units; the rounding and
 * the breakpoints are shared, so an English and a Chinese companion are "offline for" the same amount
 * of time.
 */
export function gapLabel(ms: number, lang: Lang = "en"): string {
	return fmtDurSpaced(ms, lang);
}

/**
 * Advance a state across a powered-off gap.
 *
 * `to` defaults to now. The gap is applied as ONE closed-form transition, with sleep windows
 * interleaved chronologically. No heartbeat loop, no LLM calls, constant cost.
 */
export function catchUp(
	state: MateState,
	clock: Clock = systemClock(),
	to = clock.now(),
): { state: MateState; report: CatchUpReport } {
	const t0 = perfNow();
	const from = state.t;
	const gapMs = Math.max(0, to - from);

	// Nothing to do for a sub-heartbeat gap: return the state untouched and cheaply.
	if (gapMs < HEARTBEAT_MS / 4) {
		return {
			state,
			report: {
				gapMs,
				gapLabel: gapLabel(gapMs),
				sleeps: [],
				transitions: 0,
				elapsedMs: perfNow() - t0,
				drivesSaturated: false,
			},
		};
	}

	const sleeps = crossedSleepWindows(from, to, clock);
	let current = state;
	let transitions = 0;

	// Segment the gap at each sleep window. Each segment is one closed-form jump.
	let cursor = from;
	for (const s of sleeps) {
		const segmentEnd = Math.min(s.t, to);
		if (segmentEnd > cursor) {
			const r = transition(current, tickEvent(segmentEnd), segmentEnd - cursor);
			current = r.state;
			transitions++;
		}
		current = sleepTransition(current, s.t);
		transitions++;
		cursor = s.t;
	}
	// Final segment to `to`.
	if (to > cursor) {
		const r = transition(current, tickEvent(to), to - cursor);
		current = r.state;
		transitions++;
	}

	const drives = current.drives;
	const drivesSaturated =
		drives.connection > 0.92 || drives.curiosity > 0.92 || drives.rest > 0.92 || drives.expression > 0.92;

	return {
		state: current,
		report: {
			gapMs,
			gapLabel: gapLabel(gapMs),
			sleeps,
			transitions,
			elapsedMs: perfNow() - t0,
			drivesSaturated,
		},
	};
}

/** A no-op event that just carries a timestamp: the clock moved, nothing happened. */
export function tickEvent(t: number): MateEvent {
	return { kind: "tick", activations: {}, intent: "chat", t };
}

/**
 * Proof that catch-up is subdivision-invariant.
 *
 * The naive version of this test (one big jump vs N equal manual steps) is WRONG, because catchUp
 * segments the gap at sleep windows and inserts sleep resets, while a plain equal-step loop does
 * not - so the two paths genuinely differ and the test measures "sleep vs no sleep", not
 * subdivision. Here both sides go through catchUp, so they cross the identical sleep boundaries;
 * the only difference is how finely the continuous segments between them are integrated.
 *
 * Channels are split by their mathematical nature:
 *   - DETERMINISTIC (emotions, drives, awareness, allostasis, relationship): pure closed-form
 *     exponentials. Subdividing must not change them beyond float noise, so the tolerance is tiny.
 *     A failure here means a term is secretly step-count-dependent and will drift on long gaps.
 *   - STOCHASTIC (mood): the O-U process has a random increment. One big draw and many small draws
 *     are equal in DISTRIBUTION, not path-wise, so mood is checked against the stationary sd
 *     sigma/sqrt(2*kappa), not against zero.
 */
export function verifySubdivisionInvariance(
	state: MateState,
	gapMs: number,
	parts = 12,
	clock: Clock = systemClock(),
): { maxDeterministic: number; maxStochastic: number; channels: Record<string, number>; moodTolerance: number } {
	// One shot: a single catchUp over the whole gap.
	const oneShot = catchUp(state, clock, state.t + gapMs).state;

	// Subdivided: catchUp applied `parts` times, each ending at the next sub-boundary. Because
	// each call re-segments at sleep windows, the sleep crossings are identical to the one-shot.
	let cur = state;
	for (let i = 1; i <= parts; i++) {
		const t = state.t + (gapMs * i) / parts;
		cur = catchUp(cur, clock, t).state;
	}

	const channels: Record<string, number> = {};
	const cmp = (name: string, a: number, b: number) => {
		channels[name] = Math.abs(a - b);
	};

	// Deterministic channels: pure closed-form exponentials with no mood coupling. During catch-up
	// every event is a `tick` (no contact), so drives only rise, load only decays, and character is
	// frozen - each of these is an exact exponential approach, hence subdivision-invariant to float
	// noise. allostasis.load is here; allostasis.fatigue is NOT, because fatigue integrates
	// mood.a, which is stochastic (see below).
	for (const k of Object.keys(oneShot.emotions) as Array<keyof typeof oneShot.emotions>) {
		cmp(`emotions.${k}`, oneShot.emotions[k], cur.emotions[k]);
	}
	cmp("drives.connection", oneShot.drives.connection, cur.drives.connection);
	cmp("drives.curiosity", oneShot.drives.curiosity, cur.drives.curiosity);
	cmp("drives.rest", oneShot.drives.rest, cur.drives.rest);
	cmp("surpriseEma", oneShot.surpriseEma, cur.surpriseEma);
	// Beliefs decay in closed form and receive no evidence on tick events, so the store must also be
	// subdivision-invariant across the gap.
	for (const k of Object.keys(oneShot.beliefs)) {
		cmp(`beliefs.${k}.confidence`, oneShot.beliefs[k].confidence, cur.beliefs[k]?.confidence ?? Number.NaN);
	}
	cmp("awareness.userPresence", oneShot.awareness.userPresence, cur.awareness.userPresence);
	cmp("awareness.socialPressure", oneShot.awareness.socialPressure, cur.awareness.socialPressure);
	cmp("allostasis.load", oneShot.allostasis.load, cur.allostasis.load);
	cmp("relationship.frustration", oneShot.relationship.frustration, cur.relationship.frustration);

	// Stochastic channels: mood is an O-U process with a random increment, so one big draw and many
	// small draws are equal in DISTRIBUTION, not path-wise. fatigue is mood-coupled and inherits
	// that. Checked against the stationary sd sigma/sqrt(2*kappa), not against zero.
	cmp("mood.p", oneShot.mood.p, cur.mood.p);
	cmp("mood.a", oneShot.mood.a, cur.mood.a);
	cmp("mood.d", oneShot.mood.d, cur.mood.d);
	cmp("allostasis.fatigue", oneShot.allostasis.fatigue, cur.allostasis.fatigue);

	let maxDeterministic = 0;
	let maxStochastic = 0;
	const STOCHASTIC = new Set(["mood.p", "mood.a", "mood.d", "allostasis.fatigue"]);
	for (const [name, v] of Object.entries(channels)) {
		if (STOCHASTIC.has(name)) maxStochastic = Math.max(maxStochastic, v);
		else maxDeterministic = Math.max(maxDeterministic, v);
	}
	// Stationary sd of the O-U mood: sigma / sqrt(2*kappa).
	const kappa = MOOD.alpha + MOOD.beta;
	const moodTolerance = MOOD.sigma / Math.sqrt(2 * kappa);
	return { maxDeterministic, maxStochastic, channels, moodTolerance };
}

/** Monotonic-ish clock for elapsedMs diagnostics only; precision does not matter here. */
function perfNow(): number {
	return typeof performance !== "undefined" ? performance.now() : Date.now();
}
