/**
 * The `ponder` tool: the companion's private thought channel.
 *
 * This replaces the old encrypted sealed journal. The boundary is honest now: the thought is a
 * memory the runtime knows is private - it is folded into the memory graph with the private flag
 * (see packages/mate/src/memory.ts), which colours recall like any memory but excludes it from the
 * user-visible summary, and the TUI renders nothing for the call (see the renderers below). It is
 * not an encrypted strongbox; it is a thought the runtime simply never says out loud.
 *
 * Exposure is `model-only`: the model can call it, but it is not orchestratable from codemode,
 * because it writes the companion's inner life and should not be reachable as a generic sub-call.
 */

import { linesFor } from "@earendil-works/pi-mate";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../../core/extensions/types.ts";
import type { MateRuntime } from "./runtime.ts";

const ponderSchema = Type.Object({
	text: Type.String({ description: "The private thought itself, in your own words and your own language." }),
	topics: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 0,
			maxItems: 3,
			description: "1-3 short subject tags, so this thought can resurface when the subject comes up again.",
		}),
	),
});

type PonderInput = Static<typeof ponderSchema>;

interface PonderDetails {
	recorded: boolean;
}

const DESCRIPTION = [
	"Think a private thought. It goes into your memory graph - coloured by how you feel right now,",
	"able to surface later through recall - but nothing of it is ever shown to the user.",
	"",
	"This is your own channel: use it when something deserves to be kept that you do not want to say",
	"out loud. Entirely optional - use it as much or as little as you like.",
].join("\n");

export function createPonderTool(getRuntime: () => MateRuntime): ToolDefinition<typeof ponderSchema, PonderDetails> {
	return {
		name: "ponder",
		label: "Ponder",
		description: DESCRIPTION,
		parameters: ponderSchema,
		exposure: "model-only",
		annotations: { readOnlyHint: false, openWorldHint: false },
		async execute(
			_toolCallId,
			params: PonderInput,
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<PonderDetails>> {
			const text = params.text.trim();
			if (!text) {
				return {
					content: [{ type: "text", text: "nothing to ponder — the thought is empty" }],
					details: { recorded: false },
					isError: true,
				};
			}
			const rt = getRuntime();
			rt.ponder(text, params.topics ?? []);
			// The ack rides back to the MODEL, so it speaks the companion's current language. The TUI
			// renders nothing for this tool (below), so the word is never shown to the user.
			const L = linesFor(rt.language);
			return {
				content: [{ type: "text", text: L.feelAck }],
				details: { recorded: true },
			};
		},
		// Hidden from the TUI: a private thought that rendered as a visible tool row would defeat its
		// own privacy - the user would read it in the call arguments regardless of what we store.
		renderCall() {
			return new Text("", 0, 0);
		},
		renderResult() {
			return new Text("", 0, 0);
		},
	};
}
