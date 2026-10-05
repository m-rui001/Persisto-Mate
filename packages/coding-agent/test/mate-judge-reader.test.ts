/**
 * WHO READS THE EXCHANGE, and what happens when nobody is configured to.
 *
 * The judge is the one path a message's emotional impact takes into the state, so it cannot depend on
 * configuration: when nothing is named, the exchange is read by the model already holding the
 * conversation — the one instrument that is by definition configured and reachable. A user who wants a
 * different reader names one, and then nothing else may read: every rung of these tests is a case where
 * the reading could quietly come from something the user did not pick, and the UI line has to say what
 * it was.
 */

import type { Api, ClassifierApi, ClassifierModel, ClassifierResult, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	type JudgeReader,
	type JudgeRegistry,
	judgeFailureLine,
	judgeReader,
	judgeReadingLine,
	runAffectJudge,
} from "../src/extensions/mate/judge-run.ts";

const chat = (provider: string, id: string): Model<Api> => ({
	id,
	name: id,
	provider,
	api: "openai-completions" as Api,
	baseUrl: `https://${provider}.invalid/v1`,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 8_192,
});

const classifier = (provider: string, id: string): ClassifierModel<ClassifierApi> => ({
	type: "classifier",
	id,
	name: id,
	provider,
	api: "typesafe-system-one" as ClassifierApi,
	baseUrl: `https://${provider}.invalid/v1`,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 65_536,
});

function fakeRegistry(models: Model<Api>[], classifiers: ClassifierModel<ClassifierApi>[] = []): JudgeRegistry {
	return {
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		findOfType: (type: string, provider: string, id: string) =>
			type === "classifier" ? classifiers.find((m) => m.provider === provider && m.id === id) : undefined,
	} as unknown as JudgeRegistry;
}

const session = chat("xiaomi-mimo", "mimo-v2.6-flash");
const named = chat("aliyun", "qwen-flash");
const judge = classifier("bailian", "decision-model-preview");

/** A four-turn exchange, the way the session file holds it. The assistant turns carry the reasoning the
 *  companion wrote before saying what it said, which is only ever handed to a decision model. */
const branch = [
	{ type: "message", message: { role: "user", content: "同一个报错我改了三个小时，我现在有点烦。" } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "他熬了三个小时，我跟着着急，可他没问我，我就先别急着给方案。" },
				{ type: "text", text: "三个小时对着同一个报错，确实磨人。" },
			],
		},
	},
	{ type: "message", message: { role: "user", content: "刚发现是参数名写错了。跑通了，心情好多了。" } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "通了。我心里那块石头落地了，替他高兴。" },
				{ type: "text", text: "好啊。" },
			],
		},
	},
];

function reader(registry: JudgeRegistry, ref: { provider: string; id: string } | null): JudgeReader {
	return judgeReader(registry, session, ref);
}

describe("judge reader selection", () => {
	it("uses a named classifier when the name resolves to one", () => {
		const r = reader(fakeRegistry([session, named], [judge]), { provider: "bailian", id: "decision-model-preview" });
		expect(r.via).toBe("classifier");
		expect(r.model.id).toBe("decision-model-preview");
		expect(r.source).toBe("named");
	});

	it("uses a named chat model when the name is not a classifier", () => {
		const r = reader(fakeRegistry([session, named], [judge]), { provider: "aliyun", id: "qwen-flash" });
		expect(r.via).toBe("chat");
		expect(r.model.id).toBe("qwen-flash");
		expect(r.source).toBe("named");
	});

	it("says so when a name matches nothing, rather than quietly reading with the conversation's model", () => {
		expect(() => reader(fakeRegistry([session, named]), { provider: "aliyun", id: "qwen-max" })).toThrow(
			/neither a classifier nor a chat model/,
		);
	});

	it("with nothing named, reads with the model holding the conversation", () => {
		// Not a model picked out of the user's settings: the one that is already answering them, so no
		// second provider sees the transcript and no reading is lost to a key that does not work.
		const r = reader(fakeRegistry([session, named]), null);
		expect(r.via).toBe("chat");
		expect(`${r.model.provider}/${r.model.id}`).toBe("xiaomi-mimo/mimo-v2.6-flash");
		expect(r.source).toBe("automatic");
	});

	it("says so when there is no model at all to read with", () => {
		expect(() => judgeReader(fakeRegistry([named]), undefined, null)).toThrow(/no model to judge/);
	});
});

describe("judge reading line names its reader", () => {
	const base = { turns: 6, thinking: false, deltas: { joy: 1 }, activations: { joy: 0.25 } };

	it("shows the kind of instrument for each way a reader gets chosen", () => {
		const namedClassifier = judgeReadingLine(
			{ ...base, via: "classifier", source: "named", model: "bailian/decision-model-preview" },
			"zh",
		);
		expect(namedClassifier).toContain("决策模型 bailian/decision-model-preview");
		const namedChat = judgeReadingLine({ ...base, via: "chat", source: "named", model: "aliyun/qwen-flash" }, "zh");
		expect(namedChat).toContain("语言模型 aliyun/qwen-flash");
		const own = judgeReadingLine(
			{ ...base, via: "chat", source: "automatic", model: "xiaomi-mimo/mimo-v2.6-flash" },
			"zh",
		);
		expect(own).toContain("xiaomi-mimo/mimo-v2.6-flash(对话模型)");
		expect(own).toContain("喜悦 +1");
	});

	it("says what the window actually held", () => {
		// A reader that got the reasoning read a bigger thing than the turn count alone suggests, and this
		// line is the only place the user can see that it did.
		const deep = judgeReadingLine(
			{ ...base, thinking: true, via: "classifier", source: "named", model: "bailian/decision-model-preview" },
			"zh",
		);
		expect(deep).toContain("6轮对话 + 思考");
		const plain = judgeReadingLine({ ...base, via: "chat", source: "named", model: "aliyun/qwen-flash" }, "zh");
		expect(plain).toContain("6轮对话");
		expect(plain).not.toContain("思考");
	});

	it("prints a half-rung reading with its sign, never as a bare minus", () => {
		const line = judgeReadingLine(
			{
				turns: 4,
				thinking: false,
				via: "chat",
				source: "named",
				model: "aliyun/qwen-flash",
				deltas: { joy: 1.5, sadness: -0.4 },
				activations: {},
			},
			"en",
		);
		expect(line).toContain("joy +1.5");
		expect(line).toContain("sadness −0.5");
		expect(line).not.toMatch(/−0(?![.5])/);
	});

	it("says nothing moved instead of printing an empty list", () => {
		const line = judgeReadingLine(
			{
				turns: 2,
				thinking: false,
				via: "chat",
				source: "named",
				model: "aliyun/qwen-flash",
				deltas: {},
				activations: {},
			},
			"zh",
		);
		expect(line).toContain("无波动");
	});
});

/** A runtime stand-in: the judge only asks it for a slot and tells it what landed. */
function fakeRuntime(applied: Record<string, number>[]) {
	return {
		takeJudgeSlot: () => true,
		releaseJudgeSlot: () => {},
		judgeAttempted: () => {},
		judgeRead: (activations: Record<string, number>) => applied.push(activations),
	};
}

function fakeContext(registry: Record<string, unknown>, model: Model<Api>): ExtensionContext {
	return {
		model,
		sessionManager: { getBranch: () => branch },
		modelRegistry: registry,
	} as unknown as ExtensionContext;
}

/**
 * The whole path with the network stubbed: nothing is configured, so the extension has to read the
 * session's own model, ask it, parse a reply a small model wrapped in prose, and hand the kernel the
 * activations. A model that answers in rubbish must cost the companion nothing but the reading.
 */
describe("judge with nothing configured", () => {
	it("asks the conversation's model, reads its JSON out of prose, and applies the movement", async () => {
		const applied: Record<string, number>[] = [];
		const asked: string[] = [];
		const ctx = fakeContext(
			{
				...fakeRegistry([session, named]),
				complete: async (model: Model<Api>) => {
					asked.push(`${model.provider}/${model.id}`);
					return { content: [{ type: "text", text: 'Sure!\n{"joy": 2, "anger": -1}\nHope that helps' }] };
				},
			},
			session,
		);
		const errors: unknown[] = [];
		const reading = await runAffectJudge(fakeRuntime(applied) as never, ctx, { onError: (err) => errors.push(err) });
		expect(asked).toEqual(["xiaomi-mimo/mimo-v2.6-flash"]);
		expect(reading?.via).toBe("chat");
		expect(reading?.source).toBe("automatic");
		expect(reading?.model).toBe("xiaomi-mimo/mimo-v2.6-flash");
		expect(reading?.deltas).toEqual({ joy: 2, anger: -1 });
		// A fall on anger is applied as a rise on its antipode at the full negative cap; a rise takes
		// the positive gain, half of that (the 2:1 negativity asymmetry).
		expect(reading?.activations).toEqual({ joy: 0.25, fear: 0.25 });
		expect(applied.at(-1)).toEqual(reading?.activations);
		expect(errors).toEqual([]);
	});

	it("applies nothing when the reader answers in prose instead of numbers, and does not call it a failure", async () => {
		const applied: Record<string, number>[] = [];
		const ctx = fakeContext(
			{
				...fakeRegistry([session, named]),
				complete: async () => ({ content: [{ type: "text", text: "The companion seemed fine." }] }),
			},
			session,
		);
		const errors: unknown[] = [];
		const reading = await runAffectJudge(fakeRuntime(applied) as never, ctx, { onError: (err) => errors.push(err) });
		expect(reading?.deltas).toEqual({});
		expect(errors).toEqual([]);
		// Nothing for the kernel to integrate: an unreadable answer is not a feeling, and an empty
		// `appraisal` event would still count as contact.
		expect(reading?.activations).toEqual({});
	});

	it("reports a reader that cannot be reached instead of going silent", async () => {
		const applied: Record<string, number>[] = [];
		const ctx = fakeContext(
			{
				...fakeRegistry([session, named]),
				complete: async () => {
					throw new Error("401 unauthorized");
				},
			},
			session,
		);
		const errors: unknown[] = [];
		const reading = await runAffectJudge(fakeRuntime(applied) as never, ctx, { onError: (err) => errors.push(err) });
		expect(reading).toBeNull();
		expect(String(errors[0])).toMatch(/401 unauthorized/);
		expect(applied).toEqual([]);
	});
});

/**
 * A reader the user wrote down is the one that reads, failures included: falling back to the
 * conversation's own model would be answering a question the user did not ask with an instrument they
 * did not choose.
 */
describe("a named reader gets no substitute", () => {
	it("reports the failure of the named chat model instead of asking the conversation's model", async () => {
		const asked: string[] = [];
		const applied: Record<string, number>[] = [];
		const ctx = fakeContext(
			{
				...fakeRegistry([session, named]),
				complete: async (model: Model<Api>) => {
					asked.push(model.id);
					throw new Error("connection reset");
				},
			},
			session,
		);
		const errors: unknown[] = [];
		const reading = await runAffectJudge(fakeRuntime(applied) as never, ctx, {
			model: "aliyun/qwen-flash",
			onError: (err) => errors.push(err),
		});
		expect(asked).toEqual(["qwen-flash"]);
		expect(reading).toBeNull();
		expect(String(errors[0])).toMatch(/connection reset/);
	});
});

describe("judge failure line", () => {
	it("states the reason and names the settings key that fixes it", () => {
		const zh = judgeFailureLine(new Error("401 unauthorized"), "zh");
		expect(zh).toContain("401 unauthorized");
		expect(zh).toContain("settings.mate.judgeModel");
		const en = judgeFailureLine("no model to judge the exchange with", "en");
		expect(en).toContain("affect judge: no model to judge the exchange with");
		expect(en).toContain('settings.mate.judgeModel = "provider/id"');
	});
});

/** A classifier answer shaped the way System One returns one. */
function scoreResult(scores: Record<string, [number, number]>): ClassifierResult {
	return {
		api: "typesafe-system-one" as ClassifierApi,
		provider: "bailian",
		model: "decision-model-preview",
		stopReason: "stop",
		timestamp: Date.now(),
		answers: Object.fromEntries(
			Object.entries(scores).map(([id, [score, confidence]]) => [id, { type: "score", score, confidence }]),
		),
	};
}

describe("judge with a named classifier", () => {
	const opts = { model: "bailian/decision-model-preview", onError: () => {} };

	function classifierContext(result: ClassifierResult) {
		return fakeContext(
			{
				...fakeRegistry([session, named], [judge]),
				classify: async () => result,
			},
			session,
		);
	}

	it("applies the score answers as deltas, and one axis said twice is still one axis", async () => {
		const applied: Record<string, number>[] = [];
		// The classifier answers the LEVEL INDEX of the rung: 4 is "+2", 0 is "-2".
		const reading = await runAffectJudge(
			fakeRuntime(applied) as never,
			classifierContext(scoreResult({ joy: [4, 0.9], sadness: [0, 0.8] })),
			opts,
		);
		expect(reading?.via).toBe("classifier");
		expect(reading?.deltas).toEqual({ joy: 2, sadness: -2 });
		// One axis said twice: joy +2 (positive gain x 0.9 confidence) and sadness -2 -> joy at the
		// negative cap (x 0.8) are the same statement; the larger, confidence-attenuated one wins.
		expect(reading?.activations).toEqual({ joy: 0.4 });
	});

	it("drops a reading whose distribution was flat", async () => {
		const applied: Record<string, number>[] = [];
		const reading = await runAffectJudge(
			fakeRuntime(applied) as never,
			classifierContext(scoreResult({ joy: [2, 0.21] })),
			opts,
		);
		expect(reading?.deltas).toEqual({});
		expect(reading?.activations).toEqual({});
	});

	it("surfaces a classify call that came back with an error", async () => {
		const applied: Record<string, number>[] = [];
		const errors: unknown[] = [];
		const ctx = classifierContext({
			...scoreResult({}),
			stopReason: "error",
			errorMessage: "systemone returned 403",
		});
		const reading = await runAffectJudge(fakeRuntime(applied) as never, ctx, {
			model: opts.model,
			onError: (err) => errors.push(err),
		});
		expect(reading).toBeNull();
		expect(String(errors[0])).toMatch(/403/);
	});
});
