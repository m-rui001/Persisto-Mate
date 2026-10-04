/**
 * The `remember` tool: how the companion decides what stays with it.
 *
 * Nothing is written to memory automatically. An earlier design tokenised every inbound message into
 * concept nodes, which filled the memory with lexical fragments the companion kept "recalling" — so
 * the choice of what deserves to survive now belongs to the model, made in its own turn. This tool
 * stores one memory, in the model's own words, tagged with a few topics that make it findable later
 * (recall matches topics literally against incoming text — see packages/mate/src/memory.ts). Stored
 * memories surface in the cached <mate-memory> summary and in per-message recall.
 *
 * Private thoughts do not belong here — they belong to `ponder`, which stores the memory with a
 * private flag so it colours recall but never renders into any user-visible surface.
 *
 * Exposure is `model-only`: the model can call it, but it is not orchestratable from codemode,
 * because it writes the companion's inner life and should not be reachable as a generic sub-call.
 */

import { linesFor } from "@earendil-works/pi-mate";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../../core/extensions/types.ts";
import type { MateRuntime } from "./runtime.ts";

const rememberSchema = Type.Object({
	text: Type.String({
		description:
			"The memory itself, one short line in your own words — a fact, a moment, something about them or about you that should outlast this conversation.",
	}),
	topics: Type.Optional(
		Type.Array(Type.String(), {
			minItems: 0,
			maxItems: 3,
			description:
				'1-3 short subject tags (e.g. ["面试"], ["work", "health"]). How you will find this memory again later — tag the subjects it is really about.',
		}),
	),
	importance: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 1,
			description:
				"How much this matters (0 = trivia, 1 = core memory). Default 0.3. Important memories fade slower.",
		}),
	),
});

type RememberInput = Static<typeof rememberSchema>;

interface RememberDetails {
	stored: boolean;
}

const DESCRIPTION = [
	"Write down something worth keeping. Nothing is remembered for you automatically — you decide",
	"what survives, by calling this when something lands: a fact about them, a promise you made, a",
	"moment that meant something, how something turned out.",
	"",
	"Keep `text` short and self-contained (future you will read it cold). Tag `topics` with the 1-3",
	"subjects it is really about — recall matches those tags when conversation touches them again,",
	"so an untagged memory may never resurface. Private thoughts belong to `ponder` instead.",
].join("\n");

export function createRememberTool(
	getRuntime: () => MateRuntime,
): ToolDefinition<typeof rememberSchema, RememberDetails> {
	return {
		name: "remember",
		label: "Remember",
		description: DESCRIPTION,
		parameters: rememberSchema,
		exposure: "model-only",
		annotations: { readOnlyHint: false, openWorldHint: false },
		async execute(
			_toolCallId,
			params: RememberInput,
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<RememberDetails>> {
			const text = params.text.trim();
			if (!text) {
				return {
					content: [{ type: "text", text: "nothing to remember — the memory is empty" }],
					details: { stored: false },
					isError: true,
				};
			}
			const rt = getRuntime();
			rt.remember(text, params.topics ?? [], params.importance ?? 0.3);
			// The ack rides back to the MODEL, so it speaks the companion's current language. The TUI
			// renders nothing for this tool (below) — inner-life bookkeeping is not chat content.
			const L = linesFor(rt.language);
			return {
				content: [{ type: "text", text: L.toolAck }],
				details: { stored: true },
			};
		},
		// Hidden from the TUI: a row showing "remember: ..." would surface inner-life bookkeeping the
		// user did not ask to see.
		renderCall() {
			return new Text("", 0, 0);
		},
		renderResult() {
			return new Text("", 0, 0);
		},
	};
}
