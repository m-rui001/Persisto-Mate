import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

/**
 * Regression: a `"type": "classifier"` entry in models.json used to be parsed into the chat shape
 * (the JSON loader ignored `type` entirely), so the registry offered a model no chat request could
 * use and no classify request could find — the affect judge failed with `returned "error"` while the
 * entry sat right there in the file.
 */

const context = {
	state: { exchange: "user: I got promoted\nassistant: congratulations!" },
	questions: {
		joy: {
			type: "score" as const,
			instructions: "How much did joy change?",
			criteria: ["-2: fell", "-1: fell a little", "0: unchanged", "+1: rose a little", "+2: rose"],
		},
	},
};

const MODELS_JSON = {
	providers: {
		bailian: {
			baseUrl: "https://bailian.test/compatible-mode/v1/",
			apiKey: "sk-test",
			models: [
				{
					type: "classifier",
					id: "decision-model-preview",
					name: "Bailian Decision Model",
					api: "typesafe-system-one",
					input: ["text"],
					contextWindow: 65536,
				},
			],
		},
	},
};

describe("models.json classifier entries", () => {
	it("registers a classifier entry under findOfType and dispatches to the System One API", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mate-models-json-"));
		const modelsPath = join(dir, "models.json");
		writeFileSync(modelsPath, JSON.stringify(MODELS_JSON));
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath,
			allowModelNetwork: false,
		});
		const model = runtime.getModelOfType("classifier", "bailian", "decision-model-preview");
		expect(model?.type).toBe("classifier");
		expect(runtime.getModel("bailian", "decision-model-preview")).toBeUndefined();

		const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			expect(new URL(String(input)).pathname).toBe("/compatible-mode/v1/systemone");
			expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
			return Response.json({
				answers: { joy: { type: "score", score: 3.2, confidence: 0.8 } },
				usage: { input_tokens: 40 },
			});
		});
		const result = await runtime.classify(model!, context, { fetch });
		expect(result.stopReason).toBe("stop");
		expect(result.answers.joy).toEqual({ type: "score", score: 3.2, confidence: 0.8 });
	});
});
