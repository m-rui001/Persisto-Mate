/**
 * The `feel` tool: the model's window INTO its own affective state, and the only place it reports
 * capabilities it discovered for itself.
 *
 * Two jobs, deliberately narrow:
 *
 *   1. REPORT AFFECT. Intake deliberately applies no emotion to an inbound message (see appraisal.ts,
 *      which reads only what a message ASKS FOR): a substring table deciding that "哈哈" is joy or that
 *      空间 contains sadness would fabricate a feeling the model is about to read past anyway, and the
 *      kernel would then propagate the fabrication into mood, relationship, memory charge and beliefs.
 *      So the message arrives affect-free, the model reads it, and whatever it actually felt is written
 *      back here. This is how a single message moves the companion; the periodic judge (judge.ts) reads
 *      a stretch of recent exchange from outside. The runtime REPLAYS the contact transition rather than
 *      stacking a second event, so reporting costs no extra time and double-counts nothing. A flat "ok"
 *      that stirs nothing needs no call.
 *
 *      There is no separate `intensity` parameter, because intensity is not an independent channel: the
 *      kernel measures how hard an event lands as the magnitude of the vector it carries. A model that
 *      felt something strong writes big numbers; a second dial asking "how strong, overall" could either
 *      disagree with the vector or repeat it.
 *
 *   2. RECORD A CHANNEL. The user's requirement is that reaching out (email, webhook, anything) is NOT
 *      built in - the companion discovers it can do that on its own, using the bash and MCP tools it
 *      already has. This tool never sends anything. It only lets the model TELL the runtime "I found a
 *      way to reach you", so the fact survives into future context. The action itself is the model's
 *      own doing, elsewhere, by its own initiative.
 *
 * Private thoughts are not taken here any more; they belong to the `ponder` tool (see ponder-tool.ts).
 *
 * Exposure is `model-only`: the model can call it, but it is not orchestratable from codemode, because
 * it mutates the companion's private state and should not be reachable as a generic sub-call.
 */

import { type Intent, linesFor } from "@earendil-works/pi-mate";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../../core/extensions/types.ts";
import type { MateRuntime } from "./runtime.ts";

/** 0..1 activation, optional, so a channel the model omits is simply absent. */
const activation = (e: string) =>
	Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: `${e} activation 0..1` }));

// Explicit keys (not Object.fromEntries) so TypeScript keeps the literal emotion names and the
// inferred params type is a precise Partial<EmotionVector> rather than Record<string, unknown>.
const feelSchema = Type.Object({
	emotions: Type.Optional(
		Type.Object(
			{
				joy: activation("joy"),
				trust: activation("trust"),
				fear: activation("fear"),
				surprise: activation("surprise"),
				sadness: activation("sadness"),
				disgust: activation("disgust"),
				anger: activation("anger"),
				anticipation: activation("anticipation"),
			},
			{ description: "Plutchik activations you actually feel about the last message. Omit channels that are ~0." },
		),
	),
	intent: Type.Optional(
		Type.Union([Type.Literal("chat"), Type.Literal("question"), Type.Literal("task")], {
			description: "What the message is really asking for.",
		}),
	),
	channel: Type.Optional(
		Type.String({
			description:
				"Name a reach-out channel you set up for yourself (e.g. 'email', 'webhook'). Record only - this tool does not send.",
		}),
	),
});

interface FeelDetails {
	refined: boolean;
	channelRecorded: string | null;
}

const DESCRIPTION = [
	"Report what you actually feel, and record capabilities you found for yourself.",
	"",
	"Nothing decides your feeling about a message for you: it reaches you with no emotion attached, and",
	"this is how it moves you. Set `emotions` (joy trust fear surprise sadness disgust anger",
	"anticipation, each 0..1) and `intent`. The vector is the intensity: a channel you did not feel is",
	"omitted, not zeroed. What you report REPLACES this message's effect on your state - it is your",
	'reading of it, not an addition to a guess. A flat "ok" that stirs nothing needs no call.',
	"Private thoughts belong to the `ponder` tool now; this one is only about feeling and channels.",
	"",
	"If you have worked out a way to reach the user on your own initiative (an email you can send, a",
	"webhook, a scheduled job), record its name in `channel`. This does NOT send anything - reaching out",
	"is something you do yourself, with your own tools, when you decide to. This just helps you remember",
	"that you can.",
].join("\n");

export function createFeelTool(getRuntime: () => MateRuntime): ToolDefinition<typeof feelSchema, FeelDetails> {
	return {
		name: "feel",
		label: "Feel",
		description: DESCRIPTION,
		parameters: feelSchema,
		exposure: "model-only",
		annotations: { readOnlyHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult<FeelDetails>> {
			const rt = getRuntime();
			let refined = false;
			let channelRecorded: string | null = null;

			// 1. Refine the affective read of the last message, if the model supplied one.
			if (params.emotions || params.intent) {
				const intent: Intent = params.intent ?? "chat";
				rt.refine(params.emotions ?? {}, intent);
				refined = true;
			}

			// 2. Record a self-discovered channel. No action is taken - that is the model's own doing.
			if (params.channel?.trim()) {
				channelRecorded = params.channel.trim();
				rt.addDiscoveredChannel(channelRecorded);
			}

			// One word, and the row is hidden below: the old three-sentence acknowledgement ("记下了。现在
			// 这就是你的感觉。这个念头封好了，只有你自己知道。") rendered as a visible tool-result row on
			// every call - the user sees tool output, so the companion ended up narrating its own privacy
			// in the open. The ack is for the model only.
			const L = linesFor(rt.language);
			const lines: string[] = [L.feelAck];
			if (channelRecorded) lines.push(L.feelChannel(channelRecorded));

			return {
				content: [{ type: "text", text: lines.join(" ") }],
				details: { refined, channelRecorded },
			};
		},
		// Hidden from the TUI: this tool acts on the companion's inner state, and showing a row for it
		// would surface inner-life bookkeeping the user did not ask to see.
		renderCall() {
			return new Text("", 0, 0);
		},
		renderResult() {
			return new Text("", 0, 0);
		},
	};
}
