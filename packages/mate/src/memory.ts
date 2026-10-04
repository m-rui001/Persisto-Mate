/**
 * Memory: the things the companion chose to keep.
 *
 * Why this exists: the kernel has affect but no episodic memory. Every "thought" would be generated
 * purely from mood + drives, which means the companion could FEEL something without ever having a
 * specific thing to feel it ABOUT. The requirement behind this module: memory, not just mood, should
 * drive thinking.
 *
 * Design, and the deliberate difference from the paper's associative graph: memory entries are
 * AUTHORED, not extracted. An earlier version tokenised every inbound message into concept nodes
 * (NEXUS-style), which filled the graph with lexical fragments — "试试看", "感觉" — that the
 * companion then treated as things it remembered. The model now decides what deserves to survive:
 * the `remember`/`ponder` tools encode one memory each, as a short sentence in the model's own
 * words, optionally tagged with a few TOPICS (short subject strings like 面试 or work) that make
 * the memory findable later. Because topics are whole words chosen by the model, matching them
 * against incoming text needs no tokeniser — a literal check (substring for CJK, word-bounded for
 * latin) is exact where segmentation was approximate.
 *
 * A memory is one node. Same text = same node (re-encoding reinforces it, like a fact mentioned
 * again). There are no co-occurrence edges: a single-node episode has nothing to co-occur with, and
 * spreading activation over authored sentences never earned its keep — direct topical recall over a
 * small, high-signal store is both simpler and more accurate.
 *
 * Forgetting model (grounded in the literature):
 *   - **Time, not a nightly fixed cut.** ACT-R treats recency as a *consequence* of the power law of
 *     forgetting — activation simply decays with age. We follow that with a closed-form exponential
 *     (matching the kernel's exact-integration style): retrieval scores use `effectiveStrength`,
 *     which decays from `stored · exp(-(now-t)/τ)`. Generative-Agents' recency term is exactly this.
 *   - **Retrieval is reinforcement.** In ACT-R a successful retrieval raises a chunk's base-level
 *     activation (the testing effect); a memory you keep recalling gets stickier even if nobody says
 *     it again. `recall()` is pure, so `rehearse()` is the companion side-effect the runtime applies
 *     to whatever surfaced. Untouched, unrehearsed memories fade; recalled-often ones persist.
 *
 * Determinism rules: no Date.now() inside; every function takes explicit timestamps; pruning ties
 * broken by (strength desc, key asc) so the graph converges identically.
 *
 * Storage: a single JSON file `memory.json` in the state dir, atomic-written like state.json.
 */

import { kv, type Lang, linesFor } from "./i18n.ts";

/** A single memory. */
export interface MemoryNode {
	/** The memory itself, in the model's own words (trimmed). Not used for identity. */
	label: string;
	/** Long-term strength in [0,1]. Reinforced on re-encoding, decayed on consolidate. */
	strength: number;
	/** Short-term salience, decays fast; folds into recall scoring but not into the summary. */
	salience: number;
	/** Affective centroid from the moments this memory was written or reinforced, PAD each [-1,1]. */
	pad: { p: number; a: number; d: number };
	/** How many times this memory was written/reinforced. */
	count: number;
	/** Last activation, epoch ms. */
	t: number;
	/** Short subject strings (e.g. 面试, work) the model tagged this memory with. Optional, but the
	 * only way a CJK memory is findable by recall — matching is a literal text check, no tokeniser. */
	topics?: string[];
	/** True for the companion's own private notes (ponder): they participate in recall, reinforcement
	 * and consolidation like any other memory, but are never rendered into the user-visible summary. */
	private?: boolean;
}

/** A single memory. */

export interface MemoryGraph {
	version: number;
	/** Cap on total memories so the store is bounded; consolidation prunes the weakest beyond this. */
	maxNodes: number;
	nodes: Record<string, MemoryNode>;
	/** Monotonic counters for telemetry. */
	counters: { encoded: number; consolidations: number; pruned: number };
	/** Threaded PRNG state, reserved for future deterministic drift. */
	seed: number;
}

/** The memory text is stored trimmed to this length; recall summaries may trim further. */
const MEMORY_LABEL_MAX = 160;
/** Cap on topics per memory; the tool layer enforces it too, this is the storage-side bound. */
const MAX_TOPICS = 3;

/**
 * Strength time-constant, ms. How long a memory holds before it has decayed to 1/e of its stored
 * strength, absent reinforcement. Deliberately on the order of DAYS, not hours: retrieval can
 * de-weight a stale node quickly (salience handles the fast "just now" layer), but true forgetting —
 * a memory falling below the prune floor in `consolidate` — should take a companion's realistic
 * timescale. A neutral one-off note fades to the 0.08 floor in roughly three weeks if never recalled
 * again; emotional charge slows that by up to 4× (see `protectedTau`), and the testing effect
 * (`rehearse`) stalls the clock entirely. This matches the Ebbinghaus/ACT-R picture: unrehearsed
 * traces decay over days, retrieved and charged ones persist.
 */
const STRENGTH_TAU_MS = 5 * 86_400_000;

/** Max extra persistence a highly-charged memory earns, as a multiplier on tau. */
const IMPORTANCE_BOOST = 3;

/** Short-term trace time-constant, ms. Salience is the fast-decaying "just now" layer; it fades in a
 * few hours so it can nudge retrieval without permanently inflating a memory. */
const SALIENCE_TAU_MS = 6 * 3_600_000;

/** The lift one successful recall adds to stored strength (the testing effect). */
const REHEARSE_BOOST = 0.06;

/**
 * A tiny stop-list for MATCHING only (extracting searchable words from a memory's label). English
 * high-frequency function words; the point is not NLP-grade parsing, it is avoiding a recall hit
 * because the message and a memory both contain "the". Topic matches bypass this entirely.
 */
const STOP = new Set(
	(
		"the and for with that this your you're it's was were are you your they them their what when " +
		"how have has had not but can cant dont wont im id ve ll just like about into onto out off " +
		"then than so too yes yeah nope also well okay ok fine some any many much more most very"
	).split(" "),
);

/** Deterministic FNV-1a 32-bit hash, reused as node-key material. */
function hashKey(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/** Compute a memory's identity from its text: a short content hash. Same text = same key, always.
 * (An earlier format embedded the whole text in the key — "text:hash" — a leftover from the
 * fragment-node era that tripled the storage of every memory; identity is the hash alone.) */
export function nodeKey(text: string): string {
	return hashKey(text);
}

function hasCJK(s: string): boolean {
	for (const ch of s) {
		const cp = ch.codePointAt(0) ?? 0;
		if (
			(cp >= 0x3040 && cp <= 0x30ff) ||
			(cp >= 0x3400 && cp <= 0x4dbf) ||
			(cp >= 0x4e00 && cp <= 0x9fff) ||
			(cp >= 0xf900 && cp <= 0xfaff) ||
			(cp >= 0x20000 && cp <= 0x2ebef)
		) {
			return true;
		}
	}
	return false;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does a topic appear in a text? Topics are short model-chosen subject strings, so this is a literal
 * check — exact where segmentation was approximate:
 *   - CJK topics: plain substring (no word boundaries exist; 面试 matches 面试 correctly everywhere).
 *     Single-character topics are rejected: 好 would match 好吗, 好的, and every 好 in the language.
 *   - latin topics: word-bounded, case-insensitive, minimum length 3 (so "work" never hits "network").
 */
export function topicMatchesText(topic: string, text: string): boolean {
	const t = topic.trim().toLowerCase();
	if (!t) return false;
	if (hasCJK(t)) return t.length >= 2 && text.toLowerCase().includes(t);
	if (t.length < 3) return false;
	return new RegExp(`(?<![a-z0-9_])${escapeRegExp(t)}(?![a-z0-9_])`).test(text.toLowerCase());
}

/** Searchable latin words from a memory's label, for recall when no topics were tagged. */
function labelTerms(label: string): string[] {
	return label
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Fresh, empty store. */
export function emptyMemory(maxNodes = 400): MemoryGraph {
	return {
		version: 4,
		maxNodes,
		nodes: {},
		counters: { encoded: 0, consolidations: 0, pruned: 0 },
		seed: 0x2545f491,
	};
}

interface EncodeArgs {
	text: string;
	pad: { p: number; a: number; d: number };
	t: number;
	/** The memory is the companion's own private note; private memories participate in recall but are
	 * excluded from the user-visible summary. */
	private?: boolean;
	/** Topic tags (short subject strings). Capped at MAX_TOPICS; merged into existing tags. */
	topics?: string[];
	/** 0..1, how much this memory matters. Scales the INITIAL strength; time and rehearsal do the rest. */
	importance?: number;
}

/**
 * Encode one authored memory. Reinforces the node if the exact same text was stored before.
 * Purely functional — returns a NEW store.
 */
export function encode(g: MemoryGraph, args: EncodeArgs): MemoryGraph {
	const text = args.text.trim();
	if (!text) return g;
	const key = nodeKey(text);
	const label = trim(text, MEMORY_LABEL_MAX);
	const topics = sanitiseTopics(args.topics);
	const importance = clamp01(args.importance ?? 0.3);

	const prev = g.nodes[key];
	let node: MemoryNode;
	if (prev) {
		// Exponential moving average on PAD; strength + salience bumped, capped. The merged topic set
		// keeps the memory findable under every subject it has been tagged with.
		const alpha = 0.35;
		node = {
			...prev,
			label,
			strength: Math.min(1, prev.strength + 0.15),
			salience: Math.min(1, prev.salience + 0.3),
			pad: {
				p: prev.pad.p + (args.pad.p - prev.pad.p) * alpha,
				a: prev.pad.a + (args.pad.a - prev.pad.a) * alpha,
				d: prev.pad.d + (args.pad.d - prev.pad.d) * alpha,
			},
			topics: mergeTopics(prev.topics, topics),
			count: prev.count + 1,
			t: args.t,
			private: prev.private ?? args.private,
		};
	} else {
		node = {
			label,
			strength: 0.25 + 0.5 * importance,
			salience: 0.5 + 0.3 * importance,
			pad: { ...args.pad },
			count: 1,
			t: args.t,
			topics: topics.length ? topics : undefined,
			private: args.private,
		};
	}

	return {
		...g,
		version: 4,
		nodes: { ...g.nodes, [key]: node },
		counters: { ...g.counters, encoded: g.counters.encoded + 1 },
	};
}

function sanitiseTopics(raw: string[] | undefined): string[] {
	if (!raw || !Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const t of raw) {
		if (typeof t !== "string") continue;
		const s = t.trim();
		if (!s || s.length > 24 || out.includes(s)) continue;
		out.push(s);
		if (out.length >= MAX_TOPICS) break;
	}
	return out;
}

function mergeTopics(prev: string[] | undefined, next: string[]): string[] | undefined {
	const merged = [...(prev ?? [])];
	for (const t of next) if (!merged.includes(t)) merged.push(t);
	const capped = merged.slice(0, MAX_TOPICS);
	return capped.length ? capped : undefined;
}

/**
 * Spreading activation is gone with the graph edges; recall is direct topical match. A memory is
 * "stirred" by a message when one of its topics appears in the text (strong match) or when a
 * content word of the memory itself shows up (weaker match). Scoring is the ACT-R base-level
 * picture in one line: time-decayed strength (`effectiveStrength`) times the match factor, plus a
 * slice of the still-hot short-term salience. Ties broken by (score desc, key asc).
 */
export interface RecallOptions {
	/** The text to match against (usually the inbound message). */
	query: string;
	now: number;
	/** Number of top results. Default 6. */
	limit?: number;
}

export interface RecallHit {
	key: string;
	label: string;
	score: number;
	pad: { p: number; a: number; d: number };
	strength: number;
	salience: number;
}

/** How retrievable a node is right now: time-decayed strength plus a slice of its short-term trace. */
function activation(n: MemoryNode, now: number): number {
	return effectiveStrength(n, now) * 0.6 + n.salience * 0.4;
}

/** Match factor for a memory against a query text: 1.0 via topic, up to 0.8 via label words, else 0. */
function matchFactor(n: MemoryNode, query: string): number {
	for (const t of n.topics ?? []) {
		if (topicMatchesText(t, query)) return 1;
	}
	let hits = 0;
	for (const w of labelTerms(n.label)) {
		if (topicMatchesText(w, query)) hits++;
	}
	if (hits === 0) return 0;
	return Math.min(0.4 + 0.2 * hits, 0.8);
}

export function recall(g: MemoryGraph, opts: RecallOptions): RecallHit[] {
	const query = opts.query ?? "";
	if (!query.trim()) return [];
	const limit = opts.limit ?? 6;
	const hits: RecallHit[] = [];
	for (const [k, n] of Object.entries(g.nodes)) {
		const factor = matchFactor(n, query);
		if (factor <= 0) continue;
		const act = activation(n, opts.now);
		// Effectively forgotten: time has already taken this memory below retrieval range.
		if (act < 0.02) continue;
		hits.push({
			key: k,
			label: n.label,
			score: act * factor + n.salience * 0.1 * factor,
			pad: n.pad,
			strength: n.strength,
			salience: n.salience,
		});
	}
	return hits.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1)).slice(0, limit);
}

/**
 * The testing effect (ACT-R: a successful retrieval raises base-level activation; the
 * generation/testing effect in the memory literature). `recall` is pure, so this is the companion
 * side-effect the host applies to whatever surfaced: recalled memories get a little stickier. A
 * memory you keep pulling up persists; one you never retrieve fades — that is the
 * remembering/forgetting balance this module exists to strike. Not a blanket bonus: bounded, so
 * trivia recalled a hundred times still can't outrank a core memory that is also rehearsed.
 *
 * `t` is deliberately NOT touched — and there is no timestamp argument at all, which is the point.
 * Resetting the decay clock here used to make every recall start the forgetting clock over, so
 * whatever surfaced once surfaced again and again: one node became the companion's whole idle mental
 * life ("第五次路过" — the same thought, arriving for the fifth time). Stickiness rises through
 * `strength` instead, which is bounded, while time keeps forgetting at the same rate for a rehearsed
 * memory as for a fresh one. The recall score's recency term still favours what was just written
 * (`encode`), so a genuinely recent memory keeps its edge.
 */
export function rehearse(g: MemoryGraph, keys: string[]): MemoryGraph {
	if (keys.length === 0) return g;
	const nodes = { ...g.nodes };
	let changed = false;
	for (const k of keys) {
		const n = nodes[k];
		if (!n) continue;
		nodes[k] = {
			...n,
			strength: Math.min(1, n.strength + REHEARSE_BOOST),
			salience: Math.min(1, n.salience + 0.2),
		};
		changed = true;
	}
	return changed ? { ...g, nodes } : g;
}

/**
 * Consolidate — commit what time has already done, then let the weak fall. Called from the sleep path
 * and once per wake after catch-up. This mirrors synaptic downscaling (Tononi): across the gap that
 * just passed, every memory decayed toward zero according to its OWN protected time constant (charged
 * memories fade slower); we bank that decay into stored strength, prune what has fallen below the
 * floor, and cap the store. `now` is required so the decay is measured over real elapsed time, not a
 * fixed nightly percentage — a memory off for a week must lose more than one off for a night.
 */
export function consolidate(g: MemoryGraph, now: number): MemoryGraph {
	const nodes: Record<string, MemoryNode> = {};
	for (const [k, n] of Object.entries(g.nodes)) {
		// Bank the elapsed decay: effective strength at `now` becomes the new stored strength, and the
		// clock resets so we do not decay the same interval twice. Salience, the fast layer, just fades.
		const strength = effectiveStrength(n, now);
		const salience = n.salience * recencyWeight(n.t, now, SALIENCE_TAU_MS);
		if (strength < 0.08) continue; // below floor: dropped — this is the forgetting that matters
		nodes[k] = { ...n, strength, salience, t: now };
	}
	// Cap by maxNodes, weakest-first (now time-aware, since we just banked decay into strength).
	const keys = Object.keys(nodes);
	if (keys.length > g.maxNodes) {
		const drop = keys
			.sort((a, b) => nodes[a].strength - nodes[b].strength || (a < b ? -1 : 1))
			.slice(0, keys.length - g.maxNodes);
		for (const k of drop) delete nodes[k];
	}
	const prunedDelta = Object.keys(g.nodes).length - Object.keys(nodes).length;
	return {
		...g,
		nodes,
		counters: {
			...g.counters,
			consolidations: g.counters.consolidations + 1,
			pruned: g.counters.pruned + Math.max(0, prunedDelta),
		},
	};
}

/**
 * A terse, STABLE rendering for the cached system-prompt prefix. Deliberately small and slow to
 * change so prompt caching holds. Emits: the top N memories by strength and one line for the most
 * recently written memory. Not the same thing as `recall` — recall is per-turn and volatile; the summary is
 * per-forever and lives in the cacheable prefix. Private memories are excluded from the listing:
 * they still count for recall, rehearse and consolidate, but this block is user-visible, so the
 * companion's private notes never render into it.
 *
 * `lang` labels the lines only. Order, strengths and content are untouched, so a Chinese companion
 * remembers exactly what the English one does.
 */
export function summary(g: MemoryGraph, opts: { nodes?: number; maxChars?: number; lang?: Lang } = {}): string {
	const lang = opts.lang ?? "en";
	const L = linesFor(lang);
	const topN = opts.nodes ?? 12;
	const memoryLines = Object.entries(g.nodes)
		.filter(([, n]) => n.private !== true)
		.sort((a, b) => b[1].strength - a[1].strength || (a[0] < b[0] ? -1 : 1))
		.slice(0, topN)
		.map(([, n]) => `${trim(n.label, 60)}:${n.strength.toFixed(2)}`);
	const lines: string[] = [];
	if (memoryLines.length) lines.push(kv(L.memoryNodes, memoryLines.join(L.sep), lang));
	// The most recently written (or reinforced) memory, taken from the nodes themselves — the
	// store keeps no separate episode log, which would only duplicate the labels.
	let recent: MemoryNode | undefined;
	for (const n of Object.values(g.nodes)) {
		if (n.private === true) continue;
		if (!recent || n.t > recent.t) recent = n;
	}
	if (recent) lines.push(kv(L.memoryRecent, trim(recent.label, 90), lang));
	if (lines.length === 0) return "";
	const body = `<mate-memory>\n${lines.join("\n")}\n</mate-memory>`;
	const max = opts.maxChars ?? 900;
	return body.length <= max ? body : `${body.slice(0, max - 14)}…\n</mate-memory>`;
}

/** The top-k memory keys for a mood-driven "what has been on my mind" seed. Uses the same
 * moment-to-moment `activation` scores recall scores with, so the daemon's free-floating thoughts
 * are GROUNDed in the things that are most retrievable RIGHT NOW (reinforced + recent + charged),
 * not in raw stored strength. (The previous comparator had a bug — it paired one node's recency with
 * the other's strength and so ignored strength entirely.) */
export function topNodes(g: MemoryGraph, now: number, k = 3): string[] {
	return Object.entries(g.nodes)
		.sort((a, b) => activation(b[1], now) - activation(a[1], now) || (a[0] < b[0] ? -1 : 1))
		.slice(0, k)
		.map(([key]) => key);
}

/** How many of the top nodes a thought seed may draw from. */
const SEED_WINDOW = 4;

/**
 * Pick the memory an idle thought should be ABOUT, rotating through a short window around the top.
 *
 * Taking `topNodes(...)[0]` every time made one dominant node the companion's whole idle mental life:
 * every thought was about the same thing, and the thought about that fact ("发现自己一直在绕X")
 * arrived on schedule. Ranking is real information — the strongest retrievable memory IS the likeliest
 * thing to be on one's mind — but a mind that can only revisit the front of the queue is a broken
 * queue. So the seed is drawn from the top few, in rank order, rotating by `seq`: the caller advances
 * `seq` once per decision, which keeps the choice deterministic given the state and the number of
 * decisions taken, and lets a strong node lead most of the time without monopolising every thought.
 */
export function seedNode(g: MemoryGraph, now: number, seq: number): string | undefined {
	const top = topNodes(g, now, SEED_WINDOW);
	if (top.length === 0) return undefined;
	return top[((seq % top.length) + top.length) % top.length];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recencyWeight(t: number, now: number, tau: number): number {
	const dt = Math.max(0, now - t);
	return Math.exp(-dt / tau);
}

/**
 * How slowly a memory's STRENGTH decays with time. Emotional salience lengthens the time constant: a
 * memory tied to strong feeling (any PAD axis far from neutral) persists further than a grey one-off
 * note. This is the "importance" term of Generative-Agents retrieval, expressed biologically as a
 * slower forgetting rate rather than as a separate retrieval bonus — the same direction ACT-R and the
 * synaptic-homeostasis literature point to (what mattered is what survives downscaling).
 */
function protectedTau(n: MemoryNode): number {
	const charge = Math.max(Math.abs(n.pad.p), Math.abs(n.pad.a), Math.abs(n.pad.d));
	return STRENGTH_TAU_MS * (1 + IMPORTANCE_BOOST * charge);
}

/**
 * The strength a memory effectively carries RIGHT NOW: stored strength decayed by elapsed time, with
 * a charge-scaled time constant. Every retrieval score reads this instead of raw `strength`, so time
 * is doing the forgetting continuously — there is no separate recency addend to double-count it.
 */
export function effectiveStrength(n: MemoryNode, now: number): number {
	return n.strength * recencyWeight(n.t, now, protectedTau(n));
}

function clamp01(x: number): number {
	if (!Number.isFinite(x)) return 0;
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

function trim(s: string, n: number): string {
	return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Repair a loaded store. This reader speaks format v4 ONLY: a file with any other version (or a
 * malformed one) yields a fresh store — older formats are not migrated, keeping this path clean.
 * Entries that fail validation are dropped individually; nothing here crashes boot.
 */
export function sanitiseMemory(raw: unknown): MemoryGraph {
	if (!raw || typeof raw !== "object") return emptyMemory();
	const r = raw as Partial<MemoryGraph>;
	if (r.version !== 4 || typeof r.maxNodes !== "number" || r.maxNodes <= 0) return emptyMemory();
	const nodes: Record<string, MemoryNode> = {};
	for (const [k, v] of Object.entries(r.nodes ?? {})) {
		if (!v || typeof v !== "object") continue;
		const n = v as Partial<MemoryNode>;
		if (typeof n.label !== "string" || !n.label.trim()) continue;
		if (typeof n.strength !== "number" || typeof n.salience !== "number") continue;
		const topics = Array.isArray(n.topics)
			? sanitiseTopics(n.topics.filter((t): t is string => typeof t === "string"))
			: undefined;
		nodes[k] = {
			label: trim(n.label, MEMORY_LABEL_MAX),
			strength: n.strength,
			salience: n.salience,
			pad: {
				p: typeof n.pad?.p === "number" ? n.pad.p : 0,
				a: typeof n.pad?.a === "number" ? n.pad.a : 0,
				d: typeof n.pad?.d === "number" ? n.pad.d : 0,
			},
			count: typeof n.count === "number" ? n.count : 1,
			t: typeof n.t === "number" ? n.t : 0,
			topics: topics?.length ? topics : undefined,
			private: n.private === true,
		};
	}
	return {
		version: 4,
		maxNodes: r.maxNodes,
		nodes,
		counters:
			r.counters && typeof r.counters === "object"
				? { ...emptyMemory().counters, ...r.counters }
				: emptyMemory().counters,
		seed: typeof r.seed === "number" ? r.seed : 0x2545f491,
	};
}
