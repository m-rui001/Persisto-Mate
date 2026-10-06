/**
 * Language invariants. The whole i18n design rests on one claim: a Chinese companion feels exactly
 * what the English one does, and only the LABELS move. These tests enforce that.
 *
 *   1. LANGUAGE-INDEPENDENCE: every number in the English projection appears, unchanged and in the
 *      same order, in the Chinese one. If someone starts translating thresholds or reordering drives,
 *      this fails.
 *   2. ENGLISH STABILITY: the English surfaces are snapshotted. They ride the prompt cache, so a
 *      gratuitous reword is a real cost (every existing companion loses its cache) — the snapshot
 *      makes that cost explicit and intentional rather than accidental.
 *   3. FALLBACKS: unknown language, unknown label key, and a missing lang choice all degrade to
 *      English instead of throwing.
 */

// Pin the test process to UTC before anything renders: the projection's clock line
// ("now 17:00") reads the LOCAL hour, so a snapshot taken in one timezone would fail on
// any other machine. UTC is the fixed reference the snapshot is regenerated against.
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import { birth } from "../src/birth.ts";
import { minimalContext, stableContext, stateContext } from "../src/context.ts";
import { generateThoughts, type PreSendChecks, replyInclination, tick } from "../src/daemon.ts";
import { driveGloss, emotionGloss, fmtDurLong, fmtDurSpaced, linesFor, normLang, traitGloss } from "../src/i18n.ts";
import { transition } from "../src/kernel.ts";
import { emptyMemory } from "../src/memory.ts";
import { EMOTIONS } from "../src/types.ts";

const HOUR = 3_600_000;

/** Numeric tokens, in order. Two renderings match iff no number moved or changed. */
function numbersOf(text: string): string[] {
	return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

/**
 * Per-line numeric signatures, in line order. Two renderings agree iff the same facets appear in the
 * same sequence with the same values — pairing by line index is exactly the ordering claim, and the
 * labels are ignored because they are the one thing allowed to differ.
 */
function lineSig(text: string): string[][] {
	return text
		.split("\n")
		.filter((line) => /\d/.test(line))
		.map((line) => line.match(/\d+(?:\.\d+)?/g) ?? []);
}

/** A lived-in state: some messages, some silence, so every projection line has something to render. */
function lived(seed: number) {
	let s = birth({ seed, born: 0 });
	for (let i = 0; i < 12; i++) {
		const t = i * 40 * 60_000 + 1_000;
		const act: Record<string, number> = {};
		for (const e of EMOTIONS) act[e] = ((i * 7 + e.length * 3 + seed) % 11) / 20;
		s = transition(
			s,
			{
				kind: "user_message",
				activations: act,
				intent: i % 3 ? "chat" : "question",
				text: `note ${i} about the rocket and the garden`,
				t,
			},
			t - s.t,
		).state;
	}
	return s;
}

const NOW = 12 * 40 * 60_000 + 9 * HOUR;
const state = lived(3);

function render(lang: "en" | "zh") {
	const incl = replyInclination(state, 0.6, lang);
	return [
		stableContext(state, { name: "mate", memory: emptyMemory(), lang }),
		stateContext(state, { now: NOW, tz: "UTC", lang, inclination: incl, session: "" }),
		minimalContext(state, { now: NOW, tz: "UTC", lang }),
		generateThoughts(state, NOW, emptyMemory(), lang)
			.map((t) => t.thought.text)
			.join("\n"),
		incl.reason,
		fmtDurLong(3 * HOUR + 12 * 60_000, lang),
		fmtDurSpaced(26 * HOUR, lang),
	].join("\n\n");
}

describe("language invariants", () => {
	it("keeps every number identical, and in the same line, across languages", () => {
		// Pairing by line is the strong form: line N must carry the same values in EN and ZH, in the
		// same sequence. Labels are the only thing allowed to differ.
		expect(lineSig(render("zh"))).toEqual(lineSig(render("en")));
		// Sanity: the fixture actually renders numbers, so the comparison above is not vacuous.
		expect(lineSig(render("en")).flat().length).toBeGreaterThan(20);
	});

	it("freezes the English surfaces (they ride the prompt cache)", () => {
		expect(render("en")).toMatchSnapshot();
	});

	it("authors the Chinese surfaces in Chinese, not English with labels swapped", () => {
		const zh = render("zh");
		expect(zh).toContain("当前状态：");
		expect(zh).toContain("对用户的感情：");
		expect(zh).toContain("驱力：");
		expect(zh).toContain("倾向：");
		// No English label may leak into the Chinese projection.
		expect(zh).not.toMatch(/\bmood:/);
		expect(zh).not.toMatch(/\bdrives:/);
		expect(zh).not.toMatch(/\binclination:/);
		expect(zh).not.toMatch(/\bnow \d/);
	});

	it("translates the reply-lean handle for the SAME lean value", () => {
		for (const weight of [0, 0.3, 0.6, 0.95]) {
			const en = replyInclination(state, weight, "en");
			const zh = replyInclination(state, weight, "zh");
			expect(zh.lean).toBe(en.lean);
			expect(zh.value).toBe(en.value);
			expect(zh.reason).not.toBe(en.reason);
			if (en.reason !== "steady") expect(zh.reason.length).toBeGreaterThan(0);
		}
	});

	it("localises the surfaced impulse without changing which one fires", () => {
		const checks: PreSendChecks = { userActive: false, recentProactive: 0 };
		const en = tick(state, NOW, checks, emptyMemory(), "en").decision;
		const zh = tick(state, NOW, checks, emptyMemory(), "zh").decision;
		if (en.action === "reach_out" && zh.action === "reach_out") {
			expect(zh.thought.kind).toBe(en.thought.kind);
			expect(zh.thought.topic).toBe(en.thought.topic);
			expect(zh.thought.urgency).toBe(en.thought.urgency);
			expect(zh.thought.text).not.toBe(en.thought.text);
		} else {
			expect(zh.action).toBe(en.action);
		}
	});

	it("maps EVERY state key to Chinese, so no English name leaks into a zh projection", () => {
		// Regression: the trait table originally carried keys from the paper's fuller model, not the
		// real Character interface, and English names showed up mid-sentence.
		for (const key of Object.keys(state.character)) expect(traitGloss(key, "zh"), key).not.toBe(key);
		for (const key of EMOTIONS) expect(emotionGloss(key, "zh"), key).not.toBe(key);
		for (const key of Object.keys(state.drives)) expect(driveGloss(key, "zh"), key).not.toBe(key);
		expect(traitGloss("nonexistentTrait", "zh")).toBe("nonexistentTrait"); // pass-through, no throw
	});

	it("falls back to English instead of throwing on anything unknown", () => {
		expect(normLang("zh-CN")).toBe("zh");
		expect(normLang("中文")).toBe("zh");
		expect(normLang(undefined)).toBe("en");
		expect(normLang("")).toBe("en");
		expect(normLang("klingon")).toBe("en");
		expect(linesFor(undefined).lang).toBe("en");
		expect(linesFor("de" as never).lang).toBe("en");
		// Unknown keys pass through untranslated — a token cost, never a crash.
		expect(stateContext(state, { now: NOW, lang: "de" as never })).toContain("state:");
	});

	it("keeps durations honest in both languages", () => {
		expect(fmtDurLong(3 * HOUR + 12 * 60_000, "en")).toBe("3h 12m");
		expect(fmtDurLong(3 * HOUR + 12 * 60_000, "zh")).toBe("3小时12分");
		expect(fmtDurSpaced(26 * HOUR, "en")).toBe("1d 2h");
		expect(fmtDurSpaced(26 * HOUR, "zh")).toBe("1天2小时");
		// The same instant, the same amount of time.
		expect(numbersOf(fmtDurLong(26 * HOUR, "zh"))).toEqual(numbersOf(fmtDurLong(26 * HOUR, "en")));
	});
});
