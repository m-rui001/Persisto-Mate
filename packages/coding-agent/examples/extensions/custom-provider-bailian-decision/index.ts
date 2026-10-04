/**
 * Aliyun Model Studio (Bailian) decision model: makes it a classifier Pi can call.
 *
 * `decision-model-preview` is not a chat model. One forward pass answers a set of structured questions
 * — pick a label, judge yes/no, rate on an ordinal scale — and returns a probability distribution plus a
 * confidence per answer, with no text generated at all. It serves TypeSafe's System One protocol, which
 * Pi already implements (`typesafeSystemOneApi`), so this extension writes no wire code: it only tells
 * Pi the model exists, where it lives, and which implementation speaks for it.
 *
 * Verified against the live service: `POST https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone`
 * answers `{answers, usage}` with a `decision-model-preview` model id; the same path on
 * `dashscope.aliyuncs.com` returns 404 and `chat/completions` for this model id returns 403. So the model
 * cannot be reached through `models.json` even when the key works there for chat — which is the second
 * reason this has to be an extension: `models.json` defines chat models only, and a classifier model must
 * be registered by code that also supplies its implementation.
 *
 * Configure it in `settings.json`. `apiKey` may be a literal, `$ENV_VAR`, or a `!command` that prints it:
 *
 *   { "bailianDecision": { "apiKey": "$DASHSCOPE_API_KEY" } }
 *
 * Optional keys: `baseUrl` (defaults to the Beijing trial host above; use your own
 * `{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` for a workspace-scoped endpoint),
 * `model` (default `decision-model-preview`), `provider` (the id Pi shows it under, default `bailian`).
 *
 * With no `apiKey` this registers nothing and Pi behaves as if the extension were absent. Nothing here
 * decides what a reading is used for — see the mate companion's affect judge.
 */

import { typesafeSystemOneApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Beijing trial host, reachable with a global DashScope key. Workspace-scoped keys need their own host. */
const DEFAULT_BASE_URL = "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL_ID = "decision-model-preview";
const DEFAULT_PROVIDER_ID = "bailian";
/** The documented input limit for the `state` payload. Output is structured, so there is no completion budget. */
const CONTEXT_WINDOW = 65_536;

interface BailianDecisionSettings {
	apiKey?: string;
	baseUrl?: string;
	model?: string;
	provider?: string;
}

export default function (pi: ExtensionAPI): void {
	// Settings are only readable once the runtime is bound, so registration happens on the first session
	// rather than in the factory. A judge call occurs mid-session by definition, so nothing that needs
	// this model can ask for it earlier.
	let registered = false;
	pi.on("session_start", () => {
		if (registered) return;
		registered = true;
		const settings = (pi.getSettings() as { bailianDecision?: BailianDecisionSettings } | undefined)?.bailianDecision;
		const apiKey = settings?.apiKey;
		if (!apiKey) return;

		pi.registerProvider(settings.provider ?? DEFAULT_PROVIDER_ID, {
			name: "Aliyun Decision Model",
			baseUrl: settings.baseUrl ?? DEFAULT_BASE_URL,
			apiKey,
			models: [
				{
					type: "classifier",
					id: settings.model ?? DEFAULT_MODEL_ID,
					name: "Decision Model (preview)",
					api: "typesafe-system-one",
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: CONTEXT_WINDOW,
				},
			],
			classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
		});
	});
}
