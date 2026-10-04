/**
 * Intake reads STRUCTURE, never affect.
 *
 * This module used to carry a hand-maintained English/Chinese keyword table mapping surface tokens to
 * Plutchik activations (haha -> joy, 难过 -> sadness), and the kernel treated that table's output as the
 * companion's genuine first impression of the message — so a fabricated reading propagated into mood,
 * the relationship, memory charge and SPARK beliefs. These tests pin the replacement contract: what a
 * message ASKS FOR is inferred from punctuation and work verbs; how it FELT is not inferred at all.
 * The only path into the affective state is the model's own `feel` report (feel-tool.ts -> refine()).
 */

import { describe, expect, it } from "vitest";
import { appraise } from "../src/extensions/mate/appraisal.ts";

describe("mate intake appraisal: structure only", () => {
	it("classifies what a message asks for", () => {
		expect(appraise("ok").intent).toBe("chat");
		expect(appraise("好的").intent).toBe("chat");
		expect(appraise("what are you doing?").intent).toBe("question");
		expect(appraise("你在干嘛吗").intent).toBe("question");
		expect(appraise("can you run the tests").intent).toBe("task");
		expect(appraise("帮我写一个脚本").intent).toBe("task");
		expect(appraise("refactor the auth middleware").intent).toBe("task");
	});

	it("asks for more of a message that demands something than of idle chatter", () => {
		expect(appraise("nice weather").weight).toBe(0);
		expect(appraise("what time is it?").weight).toBeGreaterThan(0);
	});

	it("does not infer an emotion from an emotionally-loaded sentence", () => {
		// The old table scored these as sadness 0.7-1.0 and fear 0.5. Nothing here may claim to know
		// how the person felt — or how the companion felt reading it — from a surface token, so the
		// result carries no affect channel at all.
		expect(Object.keys(appraise("ok")).sort()).toEqual(["intent", "weight"]);
		for (const text of ["I am so sad and tired", "haha lol amazing!!!", "我好难过，也好累", "我没事"]) {
			const result = appraise(text);
			expect(result.intent, text).toBe("chat");
			expect(result.weight, text).toBe(0);
		}
	});

	it("cannot fire on a word that merely contains a feeling token", () => {
		// Substring matching gave joy to "function" (fun) and sadness to "空间" (空).
		expect(appraise("the function is a good abstraction").weight).toBe(0);
		expect(appraise("这个空间很小").intent).toBe("chat");
	});
});
