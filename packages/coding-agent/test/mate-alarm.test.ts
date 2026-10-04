/**
 * The alarm tool's clock arithmetic: HH:MM parsing, the next-occurrence rule, and persistence.
 * Everything else (timers, the waking turn) is host plumbing around these pure parts.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AlarmManager, nextFire } from "../src/extensions/mate/alarm-tool.ts";

const HOUR = 3_600_000;
let dir: string | null = null;

function tempManager(onFire: (label: string) => void = () => {}): AlarmManager {
	dir ??= mkdtempSync(join(tmpdir(), "mate-alarms-"));
	return new AlarmManager(dir, (a) => onFire(a.label));
}

afterEach(() => {
	if (dir) {
		rmSync(dir, { recursive: true, force: true });
		dir = null;
	}
});

describe("alarm clock", () => {
	it("parses HH:MM and refuses nonsense", () => {
		const m = tempManager();
		const now = new Date("2026-10-05T10:00:00").getTime();
		expect(m.set({ time: "08:30" }, now)).not.toBeNull();
		expect(m.set({ time: "25:00" }, now)).toBeNull();
		expect(m.set({ time: "8am" }, now)).toBeNull();
	});

	it("fires later today for a time still ahead, tomorrow for a past daily", () => {
		const now = new Date("2026-10-05T10:00:00").getTime();
		// 11:00 today.
		expect(nextFire(now, 11, 0, "none")).toBe(now + HOUR);
		// A DAILY alarm past today's 09:00 lands on tomorrow's 09:00; a one-shot fires at once
		// (covered below) — the model asked for it by name, not for the next occurrence.
		expect(nextFire(now, 9, 0, "daily")).toBe(now + 23 * HOUR);
	});

	it("a past one-shot fires immediately: the model asked for it by name", () => {
		const now = new Date("2026-10-05T10:00:00").getTime();
		expect(nextFire(now, 9, 0, "none")).toBe(now);
	});

	it("survives a restart from alarms.json and re-arms", () => {
		const m1 = tempManager();
		const now = new Date("2026-10-05T10:00:00").getTime();
		m1.set({ time: "22:00", label: "叫他去睡觉" }, now);
		// A second manager over the same dir is a restart: the alarm is still there.
		const m2 = new AlarmManager(dir!, () => {});
		expect(m2.list()).toHaveLength(1);
		expect(m2.list()[0].label).toBe("叫他去睡觉");
	});

	it("clearing removes it from disk too", () => {
		const m = tempManager();
		const a = m.set({ time: "07:00" }, new Date("2026-10-05T10:00:00").getTime())!;
		expect(m.clear(a.id)).toBe(true);
		const reloaded = JSON.parse(readFileSync(join(dir!, "alarms.json"), "utf8"));
		expect(reloaded.alarms).toHaveLength(0);
	});
});
