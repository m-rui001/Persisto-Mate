/**
 * Structural declarations for the SillyTavern host modules — the same pattern as dsh-host.d.ts.
 * The types are transcribed from the SillyTavern sources/docs (scripts/extensions.js, script.js,
 * scripts/slash-commands.js), which are NOT installed here; the specifiers are bare so they can be
 * declared ambiently, and build.mjs's esbuild plugin rewrites them to the relative runtime paths a
 * third-party extension sees inside SillyTavern.
 */

declare module "st/extensions" {
	export const extension_prompt_types: { NONE: -1; IN_PROMPT: 0; IN_CHAT: 1 };
	export const extension_settings: Record<string, unknown>;
	export function setExtensionPrompt(
		key: string,
		value: string,
		position: number,
		depth: number,
		scan?: boolean,
		role?: "system" | "user" | "assistant",
	): void;
	export function getContext(): StContext;
}

declare module "st/script" {
	export const event_types: Record<string, string>;
	export const eventSource: { on(event: string, handler: (...args: never[]) => void): void };
	export function saveSettingsDebounced(): void;
}

declare module "st/slash-commands" {
	export function executeSlashCommands(command: string): Promise<void>;
}

declare module "st/slash-commands/SlashCommandParser" {
	export const SlashCommandParser: { addCommandObject(command: unknown): void };
}

declare module "st/slash-commands/SlashCommand" {
	export const SlashCommand: {
		fromProps(props: {
			name: string;
			callback: (args: unknown, value: string) => unknown;
			help: string;
			args?: string;
		}): unknown;
	};
}

interface StMessage {
	mes?: string;
	is_user?: boolean;
	is_system?: boolean;
}

interface StContext {
	chat?: StMessage[];
	generateQuietPrompt(args: { quietPrompt: string; jsonSchema?: unknown }): Promise<string>;
	registerFunctionTool(tool: {
		name: string;
		displayName?: string;
		description: string;
		parameters: unknown;
		action: (args: Record<string, unknown>) => string | Promise<string>;
		formatMessage?: (args: Record<string, unknown>) => string;
		stealth?: boolean;
	}): void;
}
