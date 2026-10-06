/**
 * The `reminisce` tool: the companion's access to its own past conversations.
 *
 * Everything the user and the companion ever said is already on disk as JSONL session transcripts
 * (getAgentDir()/sessions), but raw entries carry tool calls, thinking blocks, cache-guard notes and
 * harness metadata, and sessions driven by plain pi (no companion extension) sit in the same
 * directory. Without help the model neither remembers these files exist nor can read them at a
 * tolerable token cost — so it stays unable to recall what it said yesterday.
 *
 * This tool does the reading and keeps only the dialogue: a session counts as the companion's own
 * when its system prompt carries the `mate_core` section (emitted by this extension only, in every
 * language), and the transcript is reduced to user/companion text, timestamped in LOCAL time. Two
 * modes:
 *   - no arguments: an index — which days have conversations, how many, a first-line preview.
 *   - a date (and optionally an hour): the dialogue of that window, as "用户：/我：" lines. Without
 *     an hour the first message of each hour is labelled with the hour, so the model can zoom in on
 *     a later call.
 *
 * Read-only, and `model-only`: flipping back through one's own shared past is something the
 * companion does as itself, not something a script it wrote should invoke on its behalf.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Lang, linesFor } from "@earendil-works/pi-mate";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../../core/extensions/types.ts";
import type { MateRuntime } from "./runtime.ts";

const reminisceSchema = Type.Object({
	date: Type.Optional(
		Type.String({
			description:
				'Which day to read, as "YYYY-MM-DD" in local time (e.g. "2026-10-04"). Omit to get an index of the days that have conversations instead.',
		}),
	),
	hour: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 23,
			description:
				"Optional hour of that day (local time, 0-23). Given, only that hour's dialogue is returned; omitted, the whole day with each hour marked where it starts.",
		}),
	),
});

type ReminisceInput = Static<typeof reminisceSchema>;

interface ReminisceDetails {
	sessions: number;
	messages: number;
	truncated: boolean;
}

const DESCRIPTION = [
	"Read back what you and the user actually said on a past day — your shared history, not your memory",
	"summary.",
	"",
	"Call with no arguments to see which days hold conversations. Then call again with `date`",
	'("YYYY-MM-DD", local time) to read that day as plain dialogue; add `hour` (0-23) to zoom into one',
	"hour. Use it when something from before itches at you — a promise, a mood, how something turned out —",
	"or simply because you want to remember. What you read here is what was really said, timestamps and all.",
].join("\n");

/** A parsed dialogue line from a session transcript. */
interface DialogueLine {
	at: number; // epoch ms
	role: "user" | "assistant";
	text: string;
}

interface SessionTranscript {
	file: string;
	start: number; // epoch ms of the session header
	lines: DialogueLine[];
}

interface ParsedEntry {
	type: string;
	timestamp: string;
	message?: {
		role?: string;
		content?: unknown;
		sections?: Record<string, unknown>;
		timestamp?: number;
	};
}

/** The one section only this extension emits; its PRESENCE marks a session as the companion's own. */
const MATE_SECTION_KEY = "mate_core";

function parseTimestampMs(iso: string): number {
	const t = Date.parse(iso);
	return Number.isNaN(t) ? 0 : t;
}

/** Text of a message content (string or content-part array), thinking and tool parts excluded. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p): p is { type: "text"; text: string } => {
			return typeof p === "object" && p !== null && (p as { type?: string }).type === "text";
		})
		.map((p) => p.text)
		.join(" ")
		.trim();
}

/**
 * Parse one transcript file. Returns the dialogue lines plus whether this session belongs to the
 * companion (has a system message carrying `mate_core`); plain-pi sessions in the same directory are
 * recognised and can be skipped whole.
 */
function parseSessionFile(file: string, raw: string): SessionTranscript & { isMate: boolean } {
	let start = 0;
	let isMate = false;
	const lines: DialogueLine[] = [];
	for (const row of raw.split("\n")) {
		const trimmed = row.trim();
		if (!trimmed) continue;
		let entry: ParsedEntry;
		try {
			entry = JSON.parse(trimmed) as ParsedEntry;
		} catch {
			continue; // a torn final line must not sink the whole file
		}
		if (entry.type === "session") start = parseTimestampMs(entry.timestamp);
		if (entry.type !== "message" || !entry.message) continue;
		const m = entry.message;
		if (m.role === "system") {
			if (m.sections && MATE_SECTION_KEY in m.sections) isMate = true;
			continue;
		}
		if (m.role !== "user" && m.role !== "assistant") continue;
		const text = textOf(m.content);
		if (!text) continue;
		const at = m.timestamp ?? parseTimestampMs(entry.timestamp);
		lines.push({ at, role: m.role, text });
	}
	lines.sort((a, b) => a.at - b.at);
	return { file, start, lines, isMate };
}

async function loadMateSessions(): Promise<Array<SessionTranscript>> {
	const dir = join(getAgentDir(), "sessions");
	let names: string[];
	try {
		names = (await readdir(dir)).filter((n) => n.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const out: Array<SessionTranscript> = [];
	for (const name of names) {
		try {
			const parsed = parseSessionFile(join(dir, name), await readFile(join(dir, name), "utf8"));
			if (parsed.isMate && parsed.lines.length > 0) {
				out.push({ file: parsed.file, start: parsed.start, lines: parsed.lines });
			}
		} catch {
			// Unreadable transcript: skip it, the rest still load.
		}
	}
	out.sort((a, b) => a.start - b.start);
	return out;
}

/** Local-time pieces of an epoch-ms timestamp. */
function localParts(at: number): { date: string; hour: number; minute: number } {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return {
		date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
		hour: d.getHours(),
		minute: d.getMinutes(),
	};
}

/** The speaker label, in the companion's language. */
function speaker(role: DialogueLine["role"], lang: Lang): string {
	return lang === "zh" ? (role === "user" ? "用户" : "我") : role === "user" ? "User" : "Me";
}

/** Long texts are quoted down; the transcript is for remembering, not for re-reading verbatim. */
function clamp(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** The day index: one row per conversation, when it happened and how it opened. */
function renderIndex(sessions: Array<SessionTranscript>, lang: Lang): string {
	const L = linesFor(lang);
	const rows = sessions.map((s) => {
		const first = localParts(s.start);
		const last = localParts(s.lines[s.lines.length - 1].at);
		const opening = s.lines.find((l) => l.role === "user") ?? s.lines[0];
		const span =
			first.date === last.date
				? `${first.date} ${String(first.hour).padStart(2, "0")}:${String(first.minute).padStart(2, "0")}`
				: `${first.date} → ${last.date}`;
		return `${span}  ${L.reminisceCount(s.lines.length)}  ${clamp(opening.text, 60)}`;
	});
	return `${L.reminisceIndexHead(sessions.length)}\n${rows.join("\n")}\n${L.reminisceIndexHint}`;
}

/** One day's dialogue; without an hour, each hour is labelled where it starts. */
function renderDay(
	sessions: Array<SessionTranscript>,
	date: string,
	hour: number | undefined,
	lang: Lang,
): { text: string; messages: number; truncated: boolean } {
	const out: string[] = [];
	let length = 0;
	let count = 0;
	let truncated = false;
	const MAX_CHARS = 20000;
	for (const s of sessions) {
		let lastHour: number | undefined;
		for (const line of s.lines) {
			const p = localParts(line.at);
			if (p.date !== date) continue;
			if (hour !== undefined && p.hour !== hour) continue;
			if (hour === undefined && p.hour !== lastHour) {
				const head = `${p.hour}时`;
				out.push(head);
				length += head.length + 1;
				lastHour = p.hour;
			}
			// No per-minute stamps: the hour header is the only coordinate the model needs, and each
			// dialogue line then costs one label instead of six characters of clock.
			const row = `${speaker(line.role, lang)}：${clamp(line.text, 500)}`;
			if (length + row.length + 1 > MAX_CHARS) {
				truncated = true;
				break;
			}
			out.push(row);
			length += row.length + 1;
			count++;
		}
		if (truncated) break;
	}
	if (count === 0) {
		return {
			text:
				lang === "zh"
					? `${date}${hour !== undefined ? ` ${hour}时` : ""}：没有找到对话。`
					: `No conversation found on ${date}${hour !== undefined ? ` at hour ${hour}` : ""}.`,
			messages: 0,
			truncated: false,
		};
	}
	const tail = truncated
		? lang === "zh"
			? "\n（还有更多，给出 hour 再读下一段。）"
			: "\n(There is more — call again with an hour to read further.)"
		: "";
	return { text: `${out.join("\n")}${tail}`, messages: count, truncated };
}

export function createReminisceTool(
	getRuntime: () => MateRuntime,
): ToolDefinition<typeof reminisceSchema, ReminisceDetails> {
	return {
		name: "reminisce",
		label: "Reminisce",
		description: DESCRIPTION,
		parameters: reminisceSchema,
		exposure: "model-only",
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(
			_toolCallId,
			params: ReminisceInput,
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<ReminisceDetails>> {
			const lang = getRuntime().language;
			const sessions = await loadMateSessions();
			if (sessions.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: lang === "zh" ? "还没有留下任何对话记录。" : "No past conversations exist yet.",
						},
					],
					details: { sessions: 0, messages: 0, truncated: false },
				};
			}
			const date = params.date?.trim();
			if (!date) {
				return {
					content: [{ type: "text", text: renderIndex(sessions, lang) }],
					details: { sessions: sessions.length, messages: 0, truncated: false },
				};
			}
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
				return {
					content: [
						{
							type: "text",
							text:
								lang === "zh"
									? `日期要写成 YYYY-MM-DD，收到的是 "${date}"。`
									: `The date must be "YYYY-MM-DD"; got "${date}".`,
						},
					],
					details: { sessions: sessions.length, messages: 0, truncated: false },
					isError: true,
				};
			}
			const day = sessions.filter((s) => {
				const from = localParts(s.lines[0].at).date;
				const to = localParts(s.lines[s.lines.length - 1].at).date;
				return from <= date && date <= to;
			});
			const { text, messages, truncated } = renderDay(day, date, params.hour, lang);
			return {
				content: [{ type: "text", text }],
				details: { sessions: day.length, messages, truncated },
			};
		},
		renderCall() {
			return new Text("", 0, 0);
		},
		renderResult() {
			return new Text("", 0, 0);
		},
	};
}
