import { Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { MessageRenderer, MessageRenderOptions } from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { convertToLlm, createCustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("convertToLlm: custom message envelope", () => {
	test("a custom message reaches the model as a harness event, never as user speech", () => {
		const messages = convertToLlm([
			createCustomMessage(
				"mate-sleep",
				"Drowsiness has won - the body is going down now.",
				false,
				undefined,
				new Date().toISOString(),
			),
		]);
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		const text = (
			typeof messages[0].content === "string"
				? [{ type: "text" as const, text: messages[0].content }]
				: messages[0].content
		)
			.map((p) => (p.type === "text" ? p.text : ""))
			.join("");
		// The envelope carries the event type and the attribution, so the companion cannot read its
		// own sleep event as "the user is going to bed".
		expect(text).toContain('<system-event type="mate-sleep">');
		expect(text).toContain("not the user");
		expect(text).toContain("Drowsiness has won");
		expect(text.trimEnd().endsWith("</system-event>")).toBe(true);
	});
});

describe("CustomMessageComponent", () => {
	test("provides output padding to custom renderers and updates it", () => {
		initTheme("dark");
		const optionsSeen: MessageRenderOptions[] = [];
		const renderer: MessageRenderer = (_message, options) => {
			optionsSeen.push(options);
			return new Text("custom", options.outputPad, 0);
		};
		const message: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: Date.now(),
		};
		const component = new CustomMessageComponent(message, renderer, undefined, 1);

		expect(optionsSeen).toEqual([{ expanded: false, outputPad: 1 }]);
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith(" custom")),
		).toBe(true);

		component.setOutputPad(0);

		expect(optionsSeen.at(-1)).toEqual({ expanded: false, outputPad: 0 });
		expect(
			component
				.render(40)
				.map(stripAnsi)
				.some((line) => line.startsWith("custom")),
		).toBe(true);
	});
});
