/**
 * MATE - a deterministic affective kernel for pi-based companions.
 *
 * Port and adaptation of Lobozov, S. "MATE: A Deterministic Affective Middleware for LLM-Based
 * Companions with Emergent Character and Persistent Internal State" v8 (Zenodo 20400530,
 * CC-BY-4.0), extended for a machine that powers off (see catchup.ts).
 *
 * Public surface, grouped by role:
 *   - state:   birth, sanitiseState, MateState and friends
 *   - kernel:  transition (the pure function), sleepTransition, effort/energy/burst models
 *   - offline: catchUp, verifySubdivisionInvariance, crossedSleepWindows
 *   - context: stableContext (cached prefix) / stateContext (volatile per-turn tail), publicView
 *   - autonomy: tick, replyInclination, generateThoughts, sendStyle
 *   - spark:   the SPARK belief loop (see spark.ts)
 *   - memory:  the associative graph — tokenise/encode/recall/consolidate/summary. Private
 *              thoughts are ordinary entries in this graph, marked private (see memory.ts)
 *   - session: the open/close autobiographical log — openSession/closeSession/sessionSummary
 *   - quantum: the density-matrix helpers, exposed for tests and introspection
 *   - store:   load/save with atomic writes
 */

export * from "./birth.ts";
export * from "./catchup.ts";
export * from "./context.ts";
export * from "./daemon.ts";
export * from "./i18n.ts";
export * from "./judge.ts";
export * from "./kernel.ts";
export * from "./memory.ts";
export * from "./params.ts";
export * from "./quantum.ts";
export * from "./rng.ts";
export * from "./session.ts";
export * from "./spark.ts";
export * from "./store.ts";
export * from "./types.ts";
