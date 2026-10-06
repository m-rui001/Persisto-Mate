/**
 * Quantum probability formalism for emotions (MATE section 3.1).
 *
 * An 8x8 complex Hermitian density matrix rho (Tr(rho)=1, positive semidefinite) encodes the
 * eight Plutchik primaries. The formalism buys three things a plain dict[str,float] cannot give:
 *
 *   1. Superposition - off-diagonal rho_ij holds two emotions coexisting with interference
 *      potential, not a 50/50 mixture.
 *   2. Order effects - unitary evolution U = exp(-iHt) does not commute, so warmth-then-hostility
 *      and hostility-then-warmth land on different PAD states. This REQUIRES a non-diagonal H; see
 *      buildHamiltonian/applyKick. A diagonal H only produces free-phase precession, which commutes.
 *   3. Decoherence as commitment - off-diagonals decay under Lindblad until the state is
 *      classical, which is the decision being "made".
 *
 * Representation: rho is number[8][8] where each cell is a 2-element array [re, im].
 * Hermiticity means rho[j][i] = conj(rho[i][j]); we enforce it after every write.
 *
 * Performance note: the matrix is 8x8. Two different cost regimes:
 *   - FREE evolution between events (evolveUnitary) and Lindblad dephasing (decohere) use a diagonal
 *     generator, so both reduce to elementwise cell updates - O(64). These run on EVERY transition,
 *     including the many ticks of a catch-up, so they must stay cheap.
 *   - The per-EVENT unitary kick (unitaryFromH + applyKick) uses a non-diagonal H and needs the full
 *     Pade expm plus two 8x8 conjugations - ~15 * 512 = a few thousand complex mults, still well
 *     under a millisecond. This fires ONLY on contact events (user_message / proactive), never on a
 *     tick, so offline catch-up never pays for it.
 */

import { DECOHERENCE, HAMILTONIAN, HAMILTONIAN_INTENSITY, WHEEL_COUPLING } from "./params.ts";
import { clamp01 } from "./rng.ts";
import { type ComplexCell, type DensityMatrixState, EMOTIONS, type EmotionVector } from "./types.ts";

export type Complex = ComplexCell;
export type DensityMatrix = DensityMatrixState;

const N = EMOTIONS.length;

/** Build rho from an emotion vector: diagonal = normalised intensities, seeded coherences. */
export function fromEmotions(emotions: EmotionVector, seed: number): DensityMatrix {
	const raw = EMOTIONS.map((e) => Math.max(emotions[e], 1e-6));
	const sum = raw.reduce((a, b) => a + b, 0);
	const rho: DensityMatrix = [];
	for (let i = 0; i < N; i++) {
		const row: Complex[] = [];
		for (let j = 0; j < N; j++) {
			if (i === j) row.push([raw[i] / sum, 0]);
			else row.push([0, 0]);
		}
		rho.push(row);
	}
	// Seed coherence between co-active emotions. Two emotions both present create a real
	// off-diagonal; the magnitude is the geometric mean, damped so Tr stays 1.
	for (let i = 0; i < N; i++) {
		for (let j = i + 1; j < N; j++) {
			const p = Math.sqrt((raw[i] / sum) * (raw[j] / sum));
			if (p < 1e-4) continue;
			const sign = ((seed >>> (i + j)) & 1) === 0 ? 1 : -1;
			const c = 0.35 * p * sign;
			rho[i][j] = [c, 0];
			rho[j][i] = [c, 0];
		}
	}
	return rho;
}

/** Identity matrix. */
export function identity(): DensityMatrix {
	const rho: DensityMatrix = [];
	for (let i = 0; i < N; i++) {
		const row: Complex[] = [];
		for (let j = 0; j < N; j++) row.push(i === j ? [1, 0] : [0, 0]);
		rho.push(row);
	}
	return rho;
}

/** Enforce Hermiticity by symmetrising: rho[j][i] := conj(rho[i][j]) for j > i. */
export function hermitise(rho: DensityMatrix): DensityMatrix {
	for (let i = 0; i < N; i++) {
		for (let j = i + 1; j < N; j++) {
			const [re, im] = rho[i][j];
			rho[j][i] = [re, -im];
		}
	}
	return rho;
}

/** Trace. Should be 1; used by tests and by the renormaliser. */
export function trace(rho: DensityMatrix): number {
	let t = 0;
	for (let i = 0; i < N; i++) t += rho[i][i][0];
	return t;
}

/** Rescale the diagonal so Tr(rho) = 1 exactly. */
export function normalise(rho: DensityMatrix): DensityMatrix {
	const t = trace(rho);
	if (!Number.isFinite(t) || t <= 0) return rho;
	const k = 1 / t;
	for (let i = 0; i < N; i++) {
		rho[i][i][0] *= k;
		for (let j = 0; j < N; j++) {
			if (i !== j) {
				rho[i][j][0] *= k;
				rho[i][j][1] *= k;
			}
		}
	}
	return rho;
}

/**
 * Enforce positivity of every 2x2 principal minor: |rho_ij| <= sqrt(rho_ii * rho_jj).
 *
 * Necessary for a positive-semidefinite rho. The kernel needs it because the diagonal-relaxation
 * step (transition step b) moves populations toward the net-emotion distribution WITHOUT rescaling
 * the coherences, and fresh coherence is injected against those new populations — so after both,
 * an off-diagonal written for the old populations can exceed sqrt of the new diagonal product and
 * the matrix quietly leaves the quantum-probability domain (a negative eigenvalue) while its trace
 * still reads 1. Scaling the offending cell down preserves Hermiticity and the trace, and only
 * touches cells that were already inconsistent.
 */
export function clampCoherences(rho: DensityMatrix): DensityMatrix {
	for (let i = 0; i < N; i++) {
		for (let j = i + 1; j < N; j++) {
			const bound = Math.sqrt(Math.max(rho[i][i][0], 0) * Math.max(rho[j][j][0], 0));
			const [re, im] = rho[i][j];
			const m = Math.hypot(re, im);
			if (m > bound && m > 0) {
				const k = bound / m;
				rho[i][j] = [re * k, im * k];
				rho[j][i] = [re * k, -im * k];
			}
		}
	}
	return rho;
}

/**
 * Apply unitary evolution under a diagonal Hamiltonian for dt.
 *
 * For diagonal H, exp(-iHt) is diagonal with phases e^{-i E_i t}, so
 *   rho'_ij = e^{-i E_i t} rho_ij e^{+i E_j t} = e^{-i (E_i - E_j) t} rho_ij.
 * That is a single phase rotation per cell: O(N^2), no matrix multiply.
 *
 * NOTE: this is the FREE-EVOLUTION between events. Because the Hamiltonian is diagonal here, these
 * phases add commutatively and this term alone produces NO order effect. The order effect lives in
 * `applyKick` below, where a NON-diagonal Hamiltonian is built per event so that U_A U_B != U_B U_A.
 *
 * `scale` converts dt (ms) to a phase angle in a sensible range.
 */
export function evolveUnitary(rho: DensityMatrix, dt: number, intensities: number[], scale = 1e-4): DensityMatrix {
	for (let i = 0; i < N; i++) {
		for (let j = i + 1; j < N; j++) {
			const ei = HAMILTONIAN[EMOTIONS[i]] * intensities[i];
			const ej = HAMILTONIAN[EMOTIONS[j]] * intensities[j];
			const theta = -(ei - ej) * dt * scale;
			const c = Math.cos(theta);
			const s = Math.sin(theta);
			const [re, im] = rho[i][j];
			// multiply (re + i*im) by (c + i*s); the transposed cell is its exact conjugate.
			rho[i][j] = [re * c - im * s, re * s + im * c];
			rho[j][i] = [re * c - im * s, -(re * s + im * c)];
		}
	}
	return rho;
}

/* ------------------------------------------------------------------ *
 * Non-commutative order effect: the emotional Hamiltonian and its kick.
 * ------------------------------------------------------------------ */

/** Plutchik-wheel coupling between emotions i and j: +1 adjacent, -1 opposite, 0 orthogonal. */
export function wheelCoupling(i: number, j: number): number {
	return Math.cos((2 * Math.PI * (i - j)) / N);
}

/**
 * Build the real symmetric (Hermitian) emotional Hamiltonian for one event, per MATE section 3.1:
 * "constructed from triggered emotions, personality-scaled, with relationship-modulated coupling".
 *
 *   H_ii = E_i + intensity * p_i                (an activated emotion raises its own energy)
 *   H_ij = g * w_ij * sqrt(p_i * p_j)           (co-active emotions couple on Plutchik's wheel)
 *   g    = WHEEL_COUPLING * (1 + trust)         (a trusted bond entangles emotions more strongly)
 *
 * This H is NOT diagonal, so two events with different activations give H_A, H_B with [H_A,H_B]!=0
 * and therefore U_A U_B != U_B U_A - the mathematical source of the order effect.
 */
export function buildHamiltonian(activations: Partial<EmotionVector>, personalityO: number, trust: number): number[][] {
	const p = EMOTIONS.map((e) => clamp01(activations[e] ?? 0));
	const g = WHEEL_COUPLING * (1 + 0.5 * personalityO) * (1 + trust);
	const H: number[][] = [];
	for (let i = 0; i < N; i++) {
		const row = new Array<number>(N).fill(0);
		row[i] = HAMILTONIAN[EMOTIONS[i]] + HAMILTONIAN_INTENSITY * p[i];
		H.push(row);
	}
	for (let i = 0; i < N; i++) {
		for (let j = i + 1; j < N; j++) {
			const v = g * wheelCoupling(i, j) * Math.sqrt(p[i] * p[j]);
			H[i][j] = v;
			H[j][i] = v;
		}
	}
	return H;
}

function cmat(n: number): ComplexCell[][] {
	const m: ComplexCell[][] = [];
	for (let i = 0; i < n; i++) m.push(Array.from({ length: n }, () => [0, 0] as ComplexCell));
	return m;
}

function cmatMul(A: ComplexCell[][], B: ComplexCell[][]): ComplexCell[][] {
	const C = cmat(A.length);
	for (let i = 0; i < A.length; i++) {
		for (let k = 0; k < B.length; k++) {
			const aik = A[i][k];
			if (aik[0] === 0 && aik[1] === 0) continue;
			for (let j = 0; j < B.length; j++) {
				const bkj = B[k][j];
				C[i][j][0] += aik[0] * bkj[0] - aik[1] * bkj[1];
				C[i][j][1] += aik[0] * bkj[1] + aik[1] * bkj[0];
			}
		}
	}
	return C;
}

function cmatAddInPlace(A: ComplexCell[][], B: ComplexCell[][], s: number): void {
	for (let i = 0; i < A.length; i++)
		for (let j = 0; j < A.length; j++) {
			A[i][j][0] += s * B[i][j][0];
			A[i][j][1] += s * B[i][j][1];
		}
}

/**
 * U = exp(-i * theta * H) for a real symmetric H, via scaling-and-squaring with a diagonal Pade(6,6)
 * approximant. 8x8, so each matmul is ~512 complex mults; a handful of squarings keeps a kick well
 * under a millisecond. The result is unitary to ~1e-12, so Tr(rho) and positive-semidefiniteness
 * survive the conjugation exactly.
 *
 * Pade(6,6): with A = -i*theta*H and P_k = A^k / k!,
 *   exp(A) ~= (Sum_{k} P_k) (Sum_{k} (-1)^k P_k)^{-1}
 * where the numerators use c_k = (12-k)!k!/(12!... ) coefficients; we just build powers directly.
 */
export function unitaryFromH(H: number[][], theta: number): ComplexCell[][] {
	const n = H.length;
	// Frobenius norm of the exponent A = -i*theta*H is theta*||H||_F; pick s so ||A/2^s|| <= 0.5.
	let norm = 0;
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) norm += H[i][j] * H[i][j];
	norm = theta * Math.sqrt(norm);
	const s = Math.max(0, Math.ceil(Math.log2(Math.max(norm, 1e-12) / 0.5)));
	const scale = 2 ** -s;

	// A = -i * theta * scale * H  (pure imaginary entries).
	const A = cmat(n);
	const c = -theta * scale;
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) A[i][j][1] = c * H[i][j];

	// Powers A^1..A^6.
	const pow: ComplexCell[][][] = [A];
	for (let k = 1; k < 6; k++) pow.push(cmatMul(pow[k - 1], A));

	// Pade(6,6) coefficients c_k = (12-k)!k!/(12!(6-k)!k!)... standard diagonal values:
	//   [1, 1/2, 5/44, 1/66, 1/792, 1/15840, 1/665280].
	const co = [1, 1 / 2, 5 / 44, 1 / 66, 1 / 792, 1 / 15840, 1 / 665280];
	const num = cmat(n);
	const den = cmat(n);
	for (let i = 0; i < n; i++) {
		num[i][i][0] += co[0];
		den[i][i][0] += co[0];
	}
	for (let k = 1; k <= 6; k++) {
		const sign = k % 2 === 0 ? 1 : -1;
		cmatAddInPlace(num, pow[k - 1], co[k]);
		cmatAddInPlace(den, pow[k - 1], sign * co[k]);
	}

	const denInv = cmatInv(den);
	let U = cmatMul(denInv, num);
	// Undo scaling: square s times.
	for (let i = 0; i < s; i++) U = cmatMul(U, U);
	return U;
}

/** Gauss-Jordan inverse of a complex matrix (well-conditioned: near I for small scaled exponents). */
function cmatInv(M: ComplexCell[][]): ComplexCell[][] {
	const n = M.length;
	const a: ComplexCell[][] = [];
	for (let i = 0; i < n; i++) {
		const row: ComplexCell[] = [];
		for (let j = 0; j < n; j++) row.push([M[i][j][0], M[i][j][1]]);
		for (let j = 0; j < n; j++) row.push(i === j ? [1, 0] : [0, 0]);
		a.push(row);
	}
	for (let col = 0; col < n; col++) {
		// Partial pivot on magnitude.
		let piv = col;
		let best = mag(a[col][col]);
		for (let r = col + 1; r < n; r++) {
			const m = mag(a[r][col]);
			if (m > best) {
				best = m;
				piv = r;
			}
		}
		if (piv !== col) {
			const tmp = a[col];
			a[col] = a[piv];
			a[piv] = tmp;
		}
		// Scale pivot row.
		const p = a[col][col];
		const d = p[0] * p[0] + p[1] * p[1] || 1e-300;
		const inv = [p[0] / d, -p[1] / d];
		for (let j = 0; j < 2 * n; j++) {
			const x = a[col][j];
			a[col][j] = [x[0] * inv[0] - x[1] * inv[1], x[0] * inv[1] + x[1] * inv[0]];
		}
		// Eliminate.
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = a[r][col];
			if (f[0] === 0 && f[1] === 0) continue;
			for (let j = 0; j < 2 * n; j++) {
				const y = a[col][j];
				a[r][j] = [a[r][j][0] - (f[0] * y[0] - f[1] * y[1]), a[r][j][1] - (f[0] * y[1] + f[1] * y[0])];
			}
		}
	}
	const out = cmat(n);
	for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i][j] = [a[i][n + j][0], a[i][n + j][1]];
	return out;
}

function mag(c: ComplexCell): number {
	return Math.hypot(c[0], c[1]);
}

/**
 * Apply the per-event unitary kick U rho U^dagger.
 *
 * This is where non-commutativity enters. Because U = exp(-i theta H) with a NON-diagonal H built
 * from THIS event's activations, kicking warmth then hostility does not equal hostility then warmth.
 * theta is a fixed base angle scaled by the event's affective intensity - deliberately NOT proportional
 * to dt, so two near-simultaneous messages still produce a real order effect (it is a property of the
 * rotation sequence, not of elapsed time).
 *
 * rho' = U rho U^dagger, with U^dagger_ij = conj(U_ji).
 */
export function applyKick(rho: DensityMatrix, U: ComplexCell[][]): DensityMatrix {
	const n = rho.length;
	// T = U rho
	const T = cmat(n);
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++) {
			let re = 0;
			let im = 0;
			for (let k = 0; k < n; k++) {
				re += U[i][k][0] * rho[k][j][0] - U[i][k][1] * rho[k][j][1];
				im += U[i][k][0] * rho[k][j][1] + U[i][k][1] * rho[k][j][0];
			}
			T[i][j] = [re, im];
		}
	// rho' = T U^dagger
	const out = cmat(n);
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++) {
			let re = 0;
			let im = 0;
			for (let k = 0; k < n; k++) {
				// U^dagger_kj = conj(U_jk)
				const dk = [U[j][k][0], -U[j][k][1]];
				re += T[i][k][0] * dk[0] - T[i][k][1] * dk[1];
				im += T[i][k][0] * dk[1] + T[i][k][1] * dk[0];
			}
			out[i][j] = [re, im];
		}
	for (let i = 0; i < n; i++)
		for (let j = 0; j < n; j++) {
			rho[i][j][0] = out[i][j][0];
			rho[i][j][1] = out[i][j][1];
		}
	return rho;
}

/**
 * Lindblad dephasing for dt (Eq. 3).
 *
 * With diagonal jump operators L_k (population-preserving dephasing), the master equation
 *   drho/dt = -i[H,rho] + sum_k gamma_k (L_k rho L_k^dag - 1/2 {L_k^dag L_k, rho})
 * reduces to exponential decay of the off-diagonals while the diagonal is untouched:
 *   rho_ij(dt) = rho_ij(0) * exp(-gamma * dt),  i != j
 *   rho_ii(dt) = rho_ii(0)
 * So this is O(N^2) elementwise, not a matrix product.
 *
 * gamma is modulated by arousal: a highly aroused state decoheres faster (commits sooner).
 */
export function decohere(rho: DensityMatrix, dt: number, arousalModulator = 1): DensityMatrix {
	const k = Math.exp(-DECOHERENCE * dt * Math.max(arousalModulator, 0));
	if (k >= 1) return rho;
	for (let i = 0; i < N; i++) {
		for (let j = 0; j < N; j++) {
			if (i === j) continue;
			rho[i][j][0] *= k;
			rho[i][j][1] *= k;
		}
	}
	return rho;
}

/** Read the diagonal as an emotion vector. */
export function toEmotions(rho: DensityMatrix): EmotionVector {
	const out = {} as EmotionVector;
	const t = trace(rho) || 1;
	EMOTIONS.forEach((e, i) => {
		out[e] = Math.max(0, rho[i][i][0] / t);
	});
	return out;
}

/**
 * Create superposition between co-active emotions.
 *
 * This is where the density matrix earns its keep. A classical vector cannot represent "joy and
 * sadness both present, unresolved" - it can only average them. The off-diagonal can: when an
 * event co-activates two emotions, we write a coherence term whose magnitude is the geometric mean
 * of their (normalised) populations and whose sign is seeded. Later unitary evolution rotates that
 * coherence, and the order in which emotions were activated changes the resulting PAD - the order
 * effect the paper measures (warmth-then-hostility != hostility-then-warmth).
 *
 * `strength` in [0,1] scales how much new coherence the event injects: a strong emotional message
 * creates more superposition than a mild one. Existing (already evolved/decohered) coherence is
 * blended with the fresh term rather than overwritten, so history accumulates.
 */
export function injectCoherence(
	rho: DensityMatrix,
	emotions: EmotionVector,
	seed: number,
	strength: number,
): DensityMatrix {
	const pops = EMOTIONS.map((e) => Math.max(emotions[e], 0));
	const sum = pops.reduce((a, b) => a + b, 0);
	if (sum <= 1e-6 || strength <= 0) return rho;
	const k = Math.min(1, Math.max(0, strength));
	for (let i = 0; i < N; i++) {
		for (let j = i + 1; j < N; j++) {
			const pi = pops[i] / sum;
			const pj = pops[j] / sum;
			const mag = 0.35 * Math.sqrt(pi * pj);
			if (mag < 1e-4) continue;
			// Seeded sign: stable for a given seed, so the state stays reproducible.
			const sign = ((seed >>> ((i * N + j) % 31)) & 1) === 0 ? 1 : -1;
			const targetRe = mag * sign * k;
			const [re, im] = rho[i][j];
			// Blend toward the fresh coherence, keeping any surviving imaginary part.
			const nre = re * (1 - k) + targetRe;
			rho[i][j] = [nre, im * (1 - k)];
			rho[j][i] = [nre, -im * (1 - k)];
		}
	}
	return rho;
}

/** Coherence magnitude |rho_ij| for two emotions - the superposition measure. */
export function coherence(rho: DensityMatrix, a: number, b: number): number {
	const [re, im] = rho[a][b];
	return Math.hypot(re, im);
}

/** Total off-diagonal magnitude: 0 = fully classical, high = strongly superposed. */
export function totalCoherence(rho: DensityMatrix): number {
	let s = 0;
	for (let i = 0; i < N; i++) {
		for (let j = i + 1; j < N; j++) s += Math.abs(rho[i][j][0]) + Math.abs(rho[i][j][1]);
	}
	return s;
}

/** Von Neumann entropy approximation from the diagonal (bounds the true entropy). */
export function diagonalEntropy(rho: DensityMatrix): number {
	let h = 0;
	const t = trace(rho) || 1;
	for (let i = 0; i < N; i++) {
		const p = rho[i][i][0] / t;
		if (p > 1e-9) h -= p * Math.log(p);
	}
	return h / Math.log(N);
}

/** Deep copy. The kernel never mutates a state it was handed. */
export function clone(rho: DensityMatrix): DensityMatrix {
	return rho.map((row) => row.map((cell) => [cell[0], cell[1]] as Complex));
}

/** Repair a matrix loaded from disk: finite, Hermitian, positive diagonal, Tr=1. */
export function sanitise(rho: unknown): DensityMatrix {
	if (!Array.isArray(rho) || rho.length !== N) return identity();
	const out: DensityMatrix = [];
	for (let i = 0; i < N; i++) {
		const row = Array.isArray(rho[i]) ? (rho[i] as unknown[]) : [];
		const cells: Complex[] = [];
		for (let j = 0; j < N; j++) {
			const cell = Array.isArray(row[j]) ? (row[j] as unknown[]) : [];
			const re = Number(cell[0]);
			const im = Number(cell[1]);
			cells.push([Number.isFinite(re) ? re : 0, Number.isFinite(im) ? im : 0]);
		}
		out.push(cells);
	}
	hermitise(out);
	// Positive diagonal, else fall back to uniform.
	let bad = false;
	for (let i = 0; i < N; i++) {
		out[i][i][1] = 0;
		if (!(out[i][i][0] >= 0)) bad = true;
	}
	if (bad || trace(out) <= 0) return identity();
	return normalise(out);
}
