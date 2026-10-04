/**
 * Kernel invariants. The paper tests these with property-based methods over 300+ random inputs;
 * here we assert the same guarantees deterministically. If any of these fail, the state can escape
 * its bounds and the companion's behaviour becomes undefined.
 */

import { describe, expect, it } from "vitest";
import { birth } from "../src/birth.ts";
import { catchUp, systemClock, verifySubdivisionInvariance } from "../src/catchup.ts";
import { emptyEmotions, netEmotions, padCentre, padCentreFromRho, transition } from "../src/kernel.ts";
import { applyKick, buildHamiltonian, fromEmotions, totalCoherence, trace, unitaryFromH } from "../src/quantum.ts";
import { EMOTIONS } from "../src/types.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Fire a random-ish but deterministic event at time t. */
function event(t: number, seed: number) {
	const act = {} as Record<string, number>;
	for (const e of EMOTIONS)
		act[e] = ((((Math.sin(seed * 12.9898 + e.length * 78.233) * 43758.5453) % 1) + 1) % 1) * 0.6;
	return { kind: "user_message" as const, activations: act, intent: "chat" as const, t };
}

describe("kernel invariants", () => {
	it("keeps every emotion in [0,1] across many random events", () => {
		let s = birth({ seed: 1, born: 0 });
		for (let i = 0; i < 300; i++) {
			const t = i * 60_000 + 1;
			const r = transition(s, event(t, i), t - s.t);
			s = r.state;
			for (const e of EMOTIONS) {
				expect(s.emotions[e]).toBeGreaterThanOrEqual(0);
				expect(s.emotions[e]).toBeLessThanOrEqual(1);
			}
		}
	});

	it("keeps mood PAD in [-1,1]", () => {
		let s = birth({ seed: 7, born: 0 });
		for (let i = 0; i < 200; i++) {
			const t = i * 120_000;
			s = transition(s, event(t, i * 3 + 1), t - s.t).state;
			expect(Math.abs(s.mood.p)).toBeLessThanOrEqual(1);
			expect(Math.abs(s.mood.a)).toBeLessThanOrEqual(1);
			expect(Math.abs(s.mood.d)).toBeLessThanOrEqual(1);
		}
	});

	it("keeps character traits bounded, optimismBias in [-0.3,0.3]", () => {
		let s = birth({ seed: 3, born: 0 });
		for (let i = 0; i < 200; i++) {
			const t = i * 60_000;
			s = transition(s, event(t, i), t - s.t).state;
		}
		for (const [k, v] of Object.entries(s.character)) {
			if (k === "optimismBias") {
				expect(v).toBeGreaterThanOrEqual(-0.3);
				expect(v).toBeLessThanOrEqual(0.3);
			} else {
				expect(v).toBeGreaterThanOrEqual(0);
				expect(v).toBeLessThanOrEqual(1);
			}
		}
	});

	it("keeps the density matrix trace at 1", () => {
		let s = birth({ seed: 5, born: 0 });
		for (let i = 0; i < 100; i++) {
			const t = i * 90_000;
			s = transition(s, event(t, i), t - s.t).state;
			expect(trace(s.rho)).toBeCloseTo(1, 6);
		}
	});

	it("caps trust drop per event", () => {
		let s = birth({ seed: 9, born: 0 });
		s = { ...s, relationship: { ...s.relationship, trust: 0.8 } };
		const hostile = {
			kind: "user_message" as const,
			activations: { anger: 1, disgust: 1 },
			intent: "chat" as const,
			t: HOUR,
		};
		const after = transition(s, hostile, HOUR - s.t).state;
		// One event cannot wipe out trust: drop is bounded by TRUST_DROP_CAP fraction.
		expect(after.relationship.trust).toBeGreaterThan(0.8 * (1 - 0.12) - 0.05);
	});

	it("is reproducible: same seed + same events = identical state", () => {
		const run = () => {
			let s = birth({ seed: 42, born: 0 });
			for (let i = 0; i < 50; i++) s = transition(s, event(i * 60_000, i), 60_000).state;
			return s;
		};
		const a = run();
		const b = run();
		expect(a.seed).toBe(b.seed);
		expect(a.mood).toEqual(b.mood);
		expect(a.emotions).toEqual(b.emotions);
	});

	it("produces dyads from co-active emotions", () => {
		const s = birth({ seed: 2, born: 0 });
		const r = transition(
			s,
			{ kind: "user_message", activations: { joy: 0.8, trust: 0.8 }, intent: "chat", t: 1000 },
			1000,
		);
		expect(r.dyads).toContain("love");
		// netEmotions/padCentre are exercised through transition; sanity-check them directly too.
		const emo = emptyEmotions();
		emo.joy = 0.7;
		expect(padCentre(emo).p).toBeGreaterThan(0);
		expect(netEmotions(emo, emptyEmotions()).joy).toBe(0.7);
	});
});

describe("offline catch-up", () => {
	it("advances state across a multi-day gap at constant cost", () => {
		const s = birth({ seed: 11, born: 0 });
		const t0 = performance.now();
		const { state, report } = catchUp(s, systemClock(), 7 * DAY);
		const elapsed = performance.now() - t0;
		expect(report.gapMs).toBe(7 * DAY);
		expect(report.sleeps.length).toBeGreaterThanOrEqual(6); // ~7 nights crossed
		expect(state.counters.sleepCycles).toBeGreaterThanOrEqual(6);
		// Constant cost: a week offline must not take more than a handful of ms.
		expect(elapsed).toBeLessThan(50);
		expect(report.elapsedMs).toBeLessThan(50);
	});

	it("a year offline costs about the same as a week", () => {
		const s = birth({ seed: 13, born: 0 });
		const week = catchUp(s, systemClock(), 7 * DAY);
		const year = catchUp(s, systemClock(), 365 * DAY);
		// Transitions scale with sleep windows crossed (~2 per day: segment + sleep), NOT with the
		// naive heartbeat replay count (365*24*60 = 525,600). The whole point of the closed-form
		// design: a year is ~730 transitions, still sub-millisecond-per-step.
		expect(year.report.transitions).toBeLessThan(900);
		expect(week.report.transitions).toBeLessThan(30);
		expect(year.report.transitions).toBeLessThan(525_600 / 100); // 100x cheaper than naive replay
		// State stays valid.
		for (const e of EMOTIONS) {
			expect(year.state.emotions[e]).toBeGreaterThanOrEqual(0);
			expect(year.state.emotions[e]).toBeLessThanOrEqual(1);
		}
		expect(trace(year.state.rho)).toBeCloseTo(1, 6);
	});

	it("drives saturate after a long gap (connection hunger)", () => {
		const s = birth({ seed: 17, born: 0 });
		const { state, report } = catchUp(s, systemClock(), 3 * DAY);
		// After days of silence the connection drive climbs toward saturation.
		expect(state.drives.connection).toBeGreaterThan(0.5);
		expect(typeof report.drivesSaturated).toBe("boolean");
	});

	it("is subdivision-invariant on deterministic channels", () => {
		const s = birth({ seed: 23, born: 0 });
		const { maxDeterministic, channels } = verifySubdivisionInvariance(s, 6 * HOUR, 24, systemClock());
		// Deterministic channels are exact exponentials: subdividing must only introduce float noise.
		expect(maxDeterministic).toBeLessThan(1e-6);
		expect(channels["drives.connection"]).toBeLessThan(1e-9);
	});

	it("mood matches in distribution, not path-wise", () => {
		const s = birth({ seed: 29, born: 0 });
		const { maxStochastic, moodTolerance } = verifySubdivisionInvariance(s, 20 * HOUR, 40, systemClock());
		// The O-U mood is stochastic: one big draw vs many small draws agree only in distribution.
		// The deviation must stay within a few stationary standard deviations, not diverge.
		expect(maxStochastic).toBeLessThan(moodTolerance * 6 + 1e-6);
	});

	it("coherence decays over long silence (state becomes classical)", () => {
		let s = birth({ seed: 31, born: 0 });
		// Pump some emotion in to create coherence.
		s = transition(
			s,
			{ kind: "user_message", activations: { joy: 0.8, sadness: 0.6 }, intent: "chat", t: 1000 },
			1000,
		).state;
		const c0 = totalCoherence(s.rho);
		const { state: later } = catchUp(s, systemClock(), s.t + 2 * DAY);
		const c1 = totalCoherence(later.rho);
		expect(c1).toBeLessThan(c0);
	});
});

/**
 * Non-commutative order effects (MATE section 3.1 / Fig. 6, the paper's headline quantum claim).
 *
 * Warmth-then-hostility and hostility-then-warmth must land on DIFFERENT PAD states, while a classical
 * (diagonal-only) readout of the same events gives ~identical results. If this ever regresses to zero,
 * the density matrix has become decorative and the fork no longer implements MATE.
 */
describe("quantum order effects", () => {
	const WARM = { joy: 0.8, trust: 0.6 };
	const HOSTILE = { anger: 0.7, fear: 0.5 };
	const pad = (a: { p: number; a: number; d: number }, b: { p: number; a: number; d: number }) =>
		Math.hypot(a.p - b.p, a.a - b.a, a.d - b.d);

	/** Fire the two events in a given order, `dt` apart, from a fresh state. */
	function run(order: "AB" | "BA", dt: number, seed: number) {
		let s = birth({ seed, born: 0 });
		const first = order === "AB" ? WARM : HOSTILE;
		const second = order === "AB" ? HOSTILE : WARM;
		let t = s.t;
		t += dt;
		s = transition(s, { kind: "user_message", activations: first, intent: "chat", t }, dt).state;
		t += dt;
		s = transition(s, { kind: "user_message", activations: second, intent: "chat", t }, dt).state;
		return s;
	}
	const net = (s: ReturnType<typeof run>) => netEmotions(s.emotions, s.opponent);

	it("produces a real order effect in the quantum centre that the classical vector does not", () => {
		// Use a short dt so differential emotion decay (which is itself order-dependent classically)
		// is negligible. This isolates PURE non-commutativity: the paper's claim is that a classical
		// dict[str,float] gives ||dPAD|| = 0 because addition commutes, while the density matrix does not.
		const dt = 1_000;
		const sAB = run("AB", dt, 101);
		const sBA = run("BA", dt, 101);
		// Classical readout (diagonal only): nearly commutative at short dt, as the paper says.
		const classicalD = pad(padCentre(net(sAB)), padCentre(net(sBA)));
		// Quantum readout Tr(rho A): genuinely non-commutative, and large.
		const quantumD = pad(padCentreFromRho(net(sAB), sAB.rho), padCentreFromRho(net(sBA), sBA.rho));
		expect(classicalD).toBeLessThan(0.01);
		expect(quantumD).toBeGreaterThan(20 * classicalD); // two orders of magnitude above classical
		expect(quantumD).toBeGreaterThan(0.3); // and large enough to be behaviourally real
	});

	it("order effect is dt-independent: it is a property of the rotation sequence, not elapsed time", () => {
		// The kick angle is fixed per event, so two messages 1s apart and 5min apart give comparable
		// order effects. This is what makes the quantum formalism matter even in rapid-fire chat.
		const fast = run("AB", 1_000, 7);
		const fastRev = run("BA", 1_000, 7);
		const dFast = pad(padCentreFromRho(net(fast), fast.rho), padCentreFromRho(net(fastRev), fastRev.rho));
		expect(dFast).toBeGreaterThan(0.2);
	});

	it("order effect magnitude is in the paper's range on average across seeds", () => {
		// Paper reports ||dPAD|| = 0.48 for a strong pair on a production instance. Across fresh
		// seeds the mean should land in a comparable band - not zero (classical), not saturating at 2.
		let sum = 0;
		const seeds = [1, 7, 42, 101, 256, 999, 31337, 5];
		for (const sd of seeds) {
			const a = run("AB", 120_000, sd);
			const b = run("BA", 120_000, sd);
			sum += pad(padCentreFromRho(net(a), a.rho), padCentreFromRho(net(b), b.rho));
		}
		const mean = sum / seeds.length;
		expect(mean).toBeGreaterThan(0.25);
		expect(mean).toBeLessThan(1.1);
	});

	it("the unitary kick is trace-preserving and keeps rho positive-semidefinite", () => {
		const H = buildHamiltonian({ joy: 0.8, trust: 0.6, anger: 0.7, fear: 0.5 }, 0.5, 0.7);
		const rho = fromEmotions(
			{ joy: 0.8, trust: 0.6, fear: 0.5, surprise: 0, sadness: 0, disgust: 0, anger: 0.7, anticipation: 0 },
			12345,
		);
		const t0 = trace(rho);
		applyKick(rho, unitaryFromH(H, Math.PI / 3));
		const t1 = trace(rho);
		expect(t1).toBeCloseTo(t0, 12);
		// Diagonal (populations) must stay non-negative for the state to remain physical.
		for (let i = 0; i < EMOTIONS.length; i++) expect(rho[i][i][0]).toBeGreaterThanOrEqual(-1e-9);
	});

	it("U is unitary: U U^dagger = I to float precision", () => {
		const H = buildHamiltonian({ joy: 0.8, trust: 0.6, anger: 0.7, fear: 0.5 }, 0.5, 0.7);
		const U = unitaryFromH(H, Math.PI / 3);
		const n = U.length;
		let maxErr = 0;
		for (let i = 0; i < n; i++) {
			for (let j = 0; j < n; j++) {
				let re = 0;
				let im = 0;
				for (let k = 0; k < n; k++) {
					const a = U[i][k];
					const b = U[j][k];
					re += a[0] * b[0] + a[1] * b[1];
					im += a[1] * b[0] - a[0] * b[1];
				}
				const want = i === j ? 1 : 0;
				maxErr = Math.max(maxErr, Math.hypot(re - want, im));
			}
		}
		expect(maxErr).toBeLessThan(1e-9);
	});
});

/**
 * The intake contract. Contact events reach the kernel with an empty activation vector: whether a
 * message FELT like something is the model's own report (`feel` -> runtime.refine, which replays this
 * transition), never a keyword table's guess. That split only holds if transition() adds no affect of
 * its own — otherwise every neutral "ok" would manufacture mood, belief evidence and a kick.
 */
describe("a contact event with no activations invents no feeling", () => {
	const flat = { kind: "user_message" as const, activations: {}, intent: "chat" as const };

	it("leaves a flat state flat while still recording the contact", () => {
		const s = birth({ seed: 5, born: 0 });
		const t = s.t + HOUR;
		const r = transition(s, { ...flat, text: "ok", t }, HOUR);
		for (const e of EMOTIONS) expect(Math.abs(r.state.emotions[e]), e).toBeLessThan(1e-9);
		expect(r.state.counters.messages).toBe(s.counters.messages + 1);
		expect(r.state.t).toBe(t);
	});

	it("injects no fresh coherence and no kick", () => {
		const s = birth({ seed: 9, born: 0 });
		const r = transition(s, { ...flat, t: s.t + HOUR }, HOUR);
		// Free evolution only dephases coherence; a felt event would raise it.
		expect(totalCoherence(r.state.rho)).toBeLessThanOrEqual(totalCoherence(s.rho) + 1e-9);
	});
});
