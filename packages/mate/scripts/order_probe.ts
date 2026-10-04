/**
 * Canonical MATE kernel benchmark: catch-up cost, subdivision invariance, order effect, token budget.
 * Run with: tsx scripts/order_probe.ts
 */
import { birth } from "../src/birth.ts";
import { transition, padCentreFromRho, padCentre, netEmotions } from "../src/kernel.ts";
import { catchUp, verifySubdivisionInvariance, systemClock } from "../src/catchup.ts";
import { stateContext, minimalContext } from "../src/context.ts";
import { totalCoherence } from "../src/quantum.ts";
import type { MateState, PAD } from "../src/types.ts";

const DAY = 86_400_000;
const WARM = { joy: 0.8, trust: 0.6 };
const HOSTILE = { anger: 0.7, fear: 0.5 };
const pad = (p: PAD) => `(${p.p.toFixed(3)},${p.a.toFixed(3)},${p.d.toFixed(3)})`;
const dist = (a: PAD, b: PAD) => Math.hypot(a.p - b.p, a.a - b.a, a.d - b.d);

// --- 1. Offline catch-up: O(1) in gap length ---
for (const [label, ms] of [["1h", 3_600_000], ["1d", DAY], ["7d", 7 * DAY], ["365d", 365 * DAY]] as const) {
	const s = birth({ seed: 101, born: 0 });
	const t0 = performance.now();
	const r = catchUp(s, systemClock(), s.t + ms);
	const el = performance.now() - t0;
	console.log(`catch-up ${label.padStart(4)}: ${el.toFixed(2)}ms  transitions=${r.report.transitions} sleeps=${r.report.sleeps.length}`);
}

// --- 2. Naive replay comparison (7 days of 60s heartbeats) ---
{
	let s = birth({ seed: 101, born: 0 });
	const t0 = performance.now();
	let n = 0;
	for (let t = 60_000; t <= 7 * DAY; t += 60_000) {
		s = transition(s, { kind: "tick", activations: {}, intent: "chat", t }, 60_000).state;
		n++;
	}
	console.log(`naive 7d replay: ${(performance.now() - t0).toFixed(1)}ms over ${n} heartbeats`);
}

// --- 3. Subdivision invariance ---
{
	const s = birth({ seed: 23, born: 0 });
	const r = verifySubdivisionInvariance(s, 20 * 3_600_000, 40, systemClock());
	console.log(`invariance: maxDet=${r.maxDeterministic.toExponential(2)} maxStoch=${r.maxStochastic.toFixed(4)} moodTol=${r.moodTolerance.toFixed(4)}`);
}

// --- 4. Order effect (paper: classical 0, quantum 0.48) ---
function run(order: "AB" | "BA", dt: number, seed: number) {
	let s = birth({ seed, born: 0 });
	const first = order === "AB" ? WARM : HOSTILE;
	const second = order === "AB" ? HOSTILE : WARM;
	let t = s.t;
	s = transition(s, { kind: "user_message", activations: first, intent: "chat", t: (t += dt) }, dt).state;
	s = transition(s, { kind: "user_message", activations: second, intent: "chat", t: (t += dt) }, dt).state;
	return s;
}
const net = (s: MateState) => netEmotions(s.emotions, s.opponent);
{
	let sum = 0;
	let cls = 0;
	const seeds = [1, 7, 42, 101, 256, 999, 31337, 5];
	for (const sd of seeds) {
		const a = run("AB", 1_000, sd);
		const b = run("BA", 1_000, sd);
		sum += dist(padCentreFromRho(net(a), a.rho), padCentreFromRho(net(b), b.rho));
		cls += dist(padCentre(net(a)), padCentre(net(b)));
	}
	console.log(`order effect (dt=1s, ${seeds.length} seeds): quantum mean=${(sum / seeds.length).toFixed(4)}  classical mean=${(cls / seeds.length).toFixed(6)}`);
}

// --- 5. Coherence after an emotional exchange ---
{
	let s = birth({ seed: 101, born: 0 });
	s = transition(s, { kind: "user_message", activations: WARM, intent: "chat", t: 1000 }, 1000).state;
	console.log(`coherence after warm exchange: ${totalCoherence(s.rho).toFixed(4)}`);
}

// --- 6. Token budget ---
{
	let s = birth({ seed: 101, born: 0 });
	// Simulate 4h of silence then a message.
	s = catchUp(s, systemClock(), s.t + 4 * 3_600_000).state;
	s = transition(s, { kind: "user_message", activations: WARM, intent: "chat", t: s.t + 1000 }, 1000).state;
	const full = stateContext(s, { now: s.t });
	const min = minimalContext(s, { now: s.t });
	console.log(`--- stateContext (${full.length} chars ~${Math.round(full.length / 4)} tok) ---\n${full}`);
	console.log(`--- minimalContext (${min.length} chars ~${Math.round(min.length / 4)} tok) ---\n${min}`);
}
