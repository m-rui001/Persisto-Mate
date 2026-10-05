/**
 * The session log's honesty. An unclean exit (killed terminal, powered-off machine) leaves an open
 * mark that the next open seals — and sealing it at the NEXT OPEN's clock recorded a whole night's
 * absence as a seconds-long phantom session. These tests pin the seal-time contract: the unclean
 * mark is sealed at the last moment the old body was demonstrably alive, bounded to the entry's own
 * lifetime.
 */

import { describe, expect, it } from "vitest";
import { closeSession, emptySessions, openSession } from "../src/session.ts";

const HOUR = 3_600_000;

describe("session log: unclean exits", () => {
	it("seals an unclosed mark at the given last-alive time, not at the next open", () => {
		let log = emptySessions();
		log = openSession(log, 20 * HOUR); // evening open...
		// ...machine powered off without a graceful close; next boot 30s later, last-alive 20:05.
		log = openSession(log, 20 * HOUR + 12 * HOUR + 30_000, 20 * HOUR + 5 * 60_000);
		expect(log.entries[0]).toEqual({ open: 20 * HOUR, close: 20 * HOUR + 5 * 60_000 });
		expect(log.entries[1].open).toBe(20 * HOUR + 12 * HOUR + 30_000);
		// The downtime between the two sessions is the whole night, not zero.
	});

	it("defaults to the next open when no last-alive time is known", () => {
		let log = emptySessions();
		log = openSession(log, 8 * HOUR);
		log = openSession(log, 9 * HOUR);
		expect(log.entries[0].close).toBe(9 * HOUR);
	});

	it("never seals before the entry opened or after the new open", () => {
		let log = emptySessions();
		log = openSession(log, 8 * HOUR);
		// A state clock older than the session mark cannot move the seal earlier.
		log = openSession(log, 9 * HOUR, 7 * HOUR);
		expect(log.entries[0].close).toBe(8 * HOUR);
		// Nor later than the moment the next body woke.
		log = openSession(log, 10 * HOUR, 11 * HOUR);
		expect(log.entries[1].close).toBe(10 * HOUR);
	});

	it("a graceful close still wins: closeSession seals at shutdown, and is idempotent", () => {
		let log = emptySessions();
		log = openSession(log, 8 * HOUR);
		log = closeSession(log, 12 * HOUR);
		expect(log.entries[0]).toEqual({ open: 8 * HOUR, close: 12 * HOUR });
		// Closing again (double shutdown) must not move or duplicate the mark.
		log = closeSession(log, 13 * HOUR);
		expect(log.entries).toHaveLength(1);
		expect(log.entries[0].close).toBe(12 * HOUR);
		// And the next open must not re-seal a properly closed mark.
		log = openSession(log, 20 * HOUR, 9 * HOUR);
		expect(log.entries[0].close).toBe(12 * HOUR);
	});
});
