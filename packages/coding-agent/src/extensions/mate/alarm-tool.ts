/**
 * The `alarm` tool: the companion's own clock. It can schedule a one-shot or daily wake-up with a
 * label; when an alarm fires the host wakes the body if it was sleeping and triggers a turn, so a
 * promise ("我 8 点叫你") is kept by machinery, not by hope. Alarms persist in the state dir
 * (`alarms.json`) — like the language choice, they are host bookkeeping, not MateState.
 *
 * Exposure is `model-only`: setting an alarm mutates the companion's own schedule.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { linesFor } from "@earendil-works/pi-mate";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "../../core/extensions/types.ts";
import type { MateRuntime } from "./runtime.ts";

const alarmSchema = Type.Object({
	time: Type.String({ description: 'When to wake you, "HH:MM" (24h, local time). "08:30".' }),
	label: Type.Optional(Type.String({ description: "What the alarm is for, one short line." })),
	repeat: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("daily")], { description: "Default none." })),
});

type AlarmInput = Static<typeof alarmSchema>;

export interface Alarm {
	id: string;
	/** Next fire, epoch ms. */
	at: number;
	hour: number;
	minute: number;
	label: string;
	repeat: "none" | "daily";
}

interface AlarmFile {
	alarms: Alarm[];
}

/** Epoch ms for the next occurrence of HH:MM local time (today if still ahead, else tomorrow). */
export function nextFire(from: number, hour: number, minute: number, repeat: "none" | "daily"): number {
	const d = new Date(from);
	d.setHours(hour, minute, 0, 0);
	let at = d.getTime();
	if (at <= from) {
		if (repeat === "daily") at += 86_400_000;
		else at = from; // a past one-shot fires immediately: the model asked for it by name
	}
	return at;
}

export class AlarmManager {
	private alarms: Alarm[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly dir: string;
	private readonly onFire: (alarm: Alarm) => void;

	constructor(dir: string, onFire: (alarm: Alarm) => void) {
		this.dir = dir;
		this.onFire = onFire;
		this.load();
	}

	private get file(): string {
		return join(this.dir, "alarms.json");
	}

	private load(): void {
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as AlarmFile | undefined;
			if (raw && Array.isArray(raw.alarms)) this.alarms = raw.alarms.filter((a) => typeof a?.at === "number");
		} catch {
			this.alarms = [];
		}
	}

	private persist(): void {
		try {
			writeFileSync(this.file, JSON.stringify({ alarms: this.alarms }, null, "\t"), "utf8");
		} catch {
			// A lost alarm file loses reminders, not the companion; do not crash the tool.
		}
	}

	list(): Alarm[] {
		return [...this.alarms];
	}

	set(input: { time: string; label?: string; repeat?: "none" | "daily" }, now = Date.now()): Alarm | null {
		const m = /^(\d{1,2}):(\d{2})$/.exec(input.time.trim());
		if (!m) return null;
		const hour = Number(m[1]);
		const minute = Number(m[2]);
		if (hour > 23 || minute > 59) return null;
		const repeat = input.repeat ?? "none";
		const alarm: Alarm = {
			id: `alarm-${now.toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`,
			at: nextFire(now, hour, minute, repeat),
			hour,
			minute,
			label: (input.label ?? "").trim(),
			repeat,
		};
		this.alarms.push(alarm);
		this.persist();
		this.scheduleNext();
		return alarm;
	}

	clear(id: string): boolean {
		const before = this.alarms.length;
		this.alarms = this.alarms.filter((a) => a.id !== id);
		const removed = this.alarms.length < before;
		if (removed) {
			this.persist();
			this.scheduleNext();
		}
		return removed;
	}

	/** Arm the timer for the earliest alarm. Called after load, set and clear. */
	scheduleNext(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const next = this.alarms.reduce<Alarm | null>((best, a) => (!best || a.at < best.at ? a : best), null);
		if (!next) return;
		const delay = Math.max(1_000, next.at - Date.now());
		this.timer = setTimeout(() => {
			this.fire();
		}, delay);
		if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
			(this.timer as { unref: () => void }).unref();
		}
	}

	private fire(): void {
		const now = Date.now();
		const due = this.alarms.filter((a) => a.at <= now);
		for (const a of due) {
			if (a.repeat === "daily") a.at = nextFire(now, a.hour, a.minute, "daily");
		}
		this.alarms = this.alarms.filter((a) => a.repeat === "daily" || a.at > now);
		this.persist();
		this.scheduleNext();
		for (const a of due) this.onFire(a);
	}
}

export function createAlarmTool(
	getRuntime: () => MateRuntime,
	manager: AlarmManager,
): ToolDefinition<typeof alarmSchema, { set: boolean }> {
	return {
		name: "alarm",
		label: "Alarm",
		description: [
			"Set an alarm on your own clock. When it fires, you are woken (even from sleep) and the",
			'label is handed to you as a turn - use it to keep promises ("I\'ll check on this at 8"),',
			"to wake yourself for something you planned, or to pace your day. One alarm per call.",
		].join("\n"),
		parameters: alarmSchema,
		exposure: "model-only",
		annotations: { readOnlyHint: false, openWorldHint: false },
		async execute(
			_toolCallId,
			params: AlarmInput,
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<{ set: boolean }>> {
			const rt = getRuntime();
			const alarm = manager.set(params);
			if (!alarm) {
				return {
					content: [{ type: "text", text: 'bad alarm time — use "HH:MM" (24h)' }],
					details: { set: false },
					isError: true,
				};
			}
			const L = linesFor(rt.language);
			const hh = String(alarm.hour).padStart(2, "0");
			const mm = String(alarm.minute).padStart(2, "0");
			return {
				content: [{ type: "text", text: L.alarmSet(`${hh}:${mm}`, alarm.label || alarm.repeat) }],
				details: { set: true },
			};
		},
		// Hidden from the TUI: inner-life bookkeeping is not chat content.
		renderCall() {
			return new Text("", 0, 0);
		},
		renderResult() {
			return new Text("", 0, 0);
		},
	};
}
