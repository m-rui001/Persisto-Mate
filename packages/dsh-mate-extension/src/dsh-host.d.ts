/**
 * Structural declarations for the two DeepSeek Harness (dsh) runtime modules this plugin uses.
 *
 * The shapes were transcribed from the published @deepseek-ai/dsh-llm@0.0.1-rc.1 and
 * @deepseek-ai/dsh-tools@0.0.1-rc.1 type files, narrowed to what we call. They are declared here —
 * not installed — because the dsh host provides its own copies at runtime (the packages are declared
 * as peerDependencies and stay external in the bundle); installing rc-typed packages into this repo
 * just to satisfy a type checker would pin a moving alpha surface for no runtime benefit.
 */
declare module "@deepseek-ai/dsh-llm" {
	/** One model-facing block; only the text variant is produced here. */
	interface NewContentBlock {
		readonly type: "text";
		readonly text: string;
	}
	/**
	 * Create one identified, frozen user-role message. `source.kind` is merge-extensible on the
	 * host side; unknown kinds fall through, so "mate" needs no host-side registration.
	 */
	export function createUserMessage(input: {
		readonly content: readonly NewContentBlock[];
		readonly source: { readonly kind: string };
	}): unknown;
}

declare module "@deepseek-ai/dsh-tools" {
	/**
	 * Register a model-callable tool. `parameters` is the flat schema object the harness validates
	 * args against; `execute` returns the canonical value `output.schema` declares and `output.render`
	 * turns it into model-facing content.
	 */
	export function defineTool(input: {
		readonly name: string;
		readonly description: string;
		readonly parameters: Record<string, { type: string; required?: boolean; description?: string }>;
		readonly output: {
			readonly schema: { type: string };
			readonly render: (args: unknown, value: string) => ReadonlyArray<{ type: "text"; text: string }>;
		};
		readonly execute: (args: Record<string, unknown>) => Promise<string>;
	}): unknown;
}
