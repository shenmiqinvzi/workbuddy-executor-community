/**
 * Tests for the pure display state derivation.
 *
 * The cases below are written from the contract rules directly, in their own
 * input/expectation table, rather than by replaying the synthetic TaskView
 * samples. The samples carry a displayState that a server would have derived
 * earlier; using them as the source of the expected answers would hide a
 * mistake in the derivation behind a mistake in the samples.
 *
 * Input semantics used throughout:
 *   - null on a flag means "not established", never "confirmed absent".
 *   - a stop proof with a null instant still proves the stop.
 *   - a terminal cause is an explicit fact, never derived from a timestamp.
 *   - the facts describe one attempt; a proof or report from another attempt
 *     is not usable for it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveTaskDisplayState,
  type TaskDisplayFacts,
  type TerminalDecisionCause,
} from "../src/task-view-state.js";

const ATTEMPT = "attempt-under-test";

/**
 * A baseline of established, healthy facts: the native side is running, the
 * report has not arrived, no decision has been made and nothing is wrong.
 * Each case changes only the facts its name mentions.
 */
function facts(overrides: Partial<TaskDisplayFacts> = {}): TaskDisplayFacts {
  return {
    attemptId: ATTEMPT,
    acceptance: { decision: "not_accepted", conflict: false },
    terminalDecision: { decided: false, cause: null, deadlineReached: false },
    stop: { attemptId: ATTEMPT, proven: false, at: null },
    nativeWaitingForInput: false,
    report: { attemptId: ATTEMPT, state: "absent" },
    nativePhase: "running",
    trust: { identityMatches: true, observationCurrent: true, connected: true },
    ...overrides,
  };
}

/** A terminal decision with a known cause and a matching stop proof. */
function decided(cause: TerminalDecisionCause, stopProven: boolean, at: string | null = "2026-10-18T10:00:00.000Z") {
  return facts({
    terminalDecision: { decided: true, cause, deadlineReached: cause === "deadline" },
    stop: { attemptId: ATTEMPT, proven: stopProven, at },
  });
}

interface Case {
  name: string;
  facts: TaskDisplayFacts;
  expected: ReturnType<typeof deriveTaskDisplayState>;
}

const CASES: Case[] = [
  /* ---- rule 5: trusted, consistent, active facts ---- */
  {
    name: "trusted and queued native facts show queued",
    facts: facts({ nativePhase: "queued" }),
    expected: "queued",
  },
  {
    name: "trusted and running native facts show running",
    facts: facts({ nativePhase: "running" }),
    expected: "running",
  },

  /* ---- rule 1: a real final acceptance decision ---- */
  {
    name: "a real final acceptance decision shows accepted",
    facts: facts({
      acceptance: { decision: "accepted", conflict: false },
      terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "accepted",
  },
  {
    name: "an acceptance decision that conflicts with the record still shows accepted",
    // The contract keeps the final acceptance decision and reports the
    // conflict on its own channel. This function returns a display state and
    // cannot stand in for that error.
    facts: facts({
      acceptance: { decision: "accepted", conflict: true },
      terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "accepted",
  },
  {
    name: "an acceptance decision survives a native identity mismatch",
    facts: facts({
      acceptance: { decision: "accepted", conflict: false },
      trust: { identityMatches: false, observationCurrent: true, connected: true },
    }),
    expected: "accepted",
  },
  {
    name: "an unknown acceptance decision does not make the task accepted",
    facts: facts({ acceptance: { decision: "unknown", conflict: false } }),
    expected: "running",
  },

  /* ---- rule 2: a terminal decision already exists ---- */
  {
    name: "a deadline decision without a stop proof shows waiting_stop",
    facts: decided("deadline", false),
    expected: "waiting_stop",
  },
  {
    name: "a cancellation decision without a stop proof shows waiting_stop",
    facts: decided("cancellation", false),
    expected: "waiting_stop",
  },
  {
    name: "a failure decision without a stop proof shows waiting_stop",
    facts: decided("failure", false),
    expected: "waiting_stop",
  },
  {
    name: "a deadline decision with a confirmed stop shows expired",
    facts: decided("deadline", true),
    expected: "expired",
  },
  {
    name: "a cancellation decision with a confirmed stop shows cancelled",
    facts: decided("cancellation", true),
    expected: "cancelled",
  },
  {
    name: "a failure decision with a confirmed stop shows failed",
    facts: decided("failure", true),
    expected: "failed",
  },
  {
    name: "a terminal decision without an established cause cannot name a terminal state",
    facts: facts({
      terminalDecision: { decided: true, cause: null, deadlineReached: false },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "unknown",
  },
  {
    name: "a stop proof from another attempt does not confirm this attempt",
    facts: facts({
      terminalDecision: { decided: true, cause: "cancellation", deadlineReached: false },
      stop: { attemptId: "another-attempt", proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "waiting_stop",
  },
  {
    name: "a stop proof whose attempt is unknown does not confirm this attempt",
    facts: facts({
      terminalDecision: { decided: true, cause: "cancellation", deadlineReached: false },
      stop: { attemptId: null, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "waiting_stop",
  },
  {
    name: "a stop proof with no reliable time still confirms the stop",
    facts: decided("failure", true, null),
    expected: "failed",
  },

  /* ---- rule 3: the native side waits for input ---- */
  {
    name: "the native side waiting for input shows waiting_input",
    facts: facts({ nativeWaitingForInput: true, nativePhase: "idle" }),
    expected: "waiting_input",
  },
  {
    name: "waiting for input while the native side is disconnected shows unknown",
    facts: facts({
      nativeWaitingForInput: true,
      nativePhase: "idle",
      trust: { identityMatches: true, observationCurrent: true, connected: false },
    }),
    expected: "unknown",
  },
  {
    name: "waiting for input on a stale observation shows unknown",
    facts: facts({
      nativeWaitingForInput: true,
      nativePhase: "idle",
      trust: { identityMatches: true, observationCurrent: false, connected: true },
    }),
    expected: "unknown",
  },
  {
    name: "waiting for input with an unknown identity shows unknown",
    facts: facts({
      nativeWaitingForInput: true,
      nativePhase: "idle",
      trust: { identityMatches: null, observationCurrent: true, connected: true },
    }),
    expected: "unknown",
  },
  {
    name: "waiting for input with a mismatched identity shows unknown",
    facts: facts({
      nativeWaitingForInput: true,
      nativePhase: "idle",
      trust: { identityMatches: false, observationCurrent: true, connected: true },
    }),
    expected: "unknown",
  },
  {
    name: "waiting for input with an unknown deadline state shows unknown",
    facts: facts({
      nativeWaitingForInput: true,
      nativePhase: "idle",
      terminalDecision: { decided: false, cause: null, deadlineReached: null },
    }),
    expected: "unknown",
  },
  {
    name: "waiting for input while the attempt is already stopped shows unknown",
    facts: facts({
      nativeWaitingForInput: true,
      nativePhase: "idle",
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "unknown",
  },
  {
    name: "waiting for input on an overdue attempt without a decision shows unknown",
    facts: facts({
      nativeWaitingForInput: true,
      nativePhase: "idle",
      terminalDecision: { decided: false, cause: null, deadlineReached: true },
    }),
    expected: "unknown",
  },
  {
    name: "a terminal decision outranks the native side waiting for input",
    facts: facts({
      nativeWaitingForInput: true,
      nativePhase: "idle",
      terminalDecision: { decided: true, cause: "cancellation", deadlineReached: false },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "cancelled",
  },

  /* ---- rule 4: a report has arrived ---- */
  {
    name: "an authenticated report without a stop proof shows waiting_stop",
    facts: facts({
      report: { attemptId: ATTEMPT, state: "authenticated" },
      stop: { attemptId: ATTEMPT, proven: false, at: null },
    }),
    expected: "waiting_stop",
  },
  {
    name: "an unauthenticated report without a stop proof shows waiting_stop",
    facts: facts({
      report: { attemptId: ATTEMPT, state: "unauthenticated" },
      stop: { attemptId: ATTEMPT, proven: false, at: null },
    }),
    expected: "waiting_stop",
  },
  {
    name: "an authenticated report with a confirmed stop shows needs_review",
    facts: facts({
      report: { attemptId: ATTEMPT, state: "authenticated" },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "needs_review",
  },
  {
    name: "a confirmed stop with an unauthenticated report does not show needs_review",
    facts: facts({
      report: { attemptId: ATTEMPT, state: "unauthenticated" },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "unknown",
  },
  {
    name: "a report from another attempt is not usable",
    facts: facts({
      report: { attemptId: "another-attempt", state: "authenticated" },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "unknown",
  },
  {
    name: "a report whose attempt is unknown is not usable",
    facts: facts({
      report: { attemptId: null, state: "authenticated" },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "unknown",
  },
  {
    name: "a late report does not change the priority of a terminal decision",
    facts: facts({
      report: { attemptId: ATTEMPT, state: "authenticated" },
      terminalDecision: { decided: true, cause: "deadline", deadlineReached: true },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "expired",
  },
  {
    name: "a late report on a decided task without a stop proof still shows waiting_stop",
    facts: facts({
      report: { attemptId: ATTEMPT, state: "authenticated" },
      terminalDecision: { decided: true, cause: "deadline", deadlineReached: true },
      stop: { attemptId: ATTEMPT, proven: false, at: null },
    }),
    expected: "waiting_stop",
  },

  /* ---- rule 5: facts that are not enough or not consistent ---- */
  {
    name: "a mismatched identity shows unknown",
    facts: facts({ trust: { identityMatches: false, observationCurrent: true, connected: true } }),
    expected: "unknown",
  },
  {
    name: "an unknown identity shows unknown",
    facts: facts({ trust: { identityMatches: null, observationCurrent: true, connected: true } }),
    expected: "unknown",
  },
  {
    name: "a disconnected native side shows unknown",
    facts: facts({ trust: { identityMatches: true, observationCurrent: true, connected: false } }),
    expected: "unknown",
  },
  {
    name: "a stale observation shows unknown",
    facts: facts({ trust: { identityMatches: true, observationCurrent: false, connected: true } }),
    expected: "unknown",
  },
  {
    name: "an unknown native phase shows unknown",
    facts: facts({ nativePhase: "unknown" }),
    expected: "unknown",
  },
  {
    name: "an idle native side without a decision shows unknown",
    facts: facts({ nativePhase: "idle" }),
    expected: "unknown",
  },
  {
    name: "a terminal decision survives a disconnected native side",
    // The decision and the stop proof are recorded facts. A lost live
    // observation does not erase them, so the native side is genuinely
    // disconnected and the observation is stale here.
    facts: {
      ...decided("failure", true),
      trust: { identityMatches: true, observationCurrent: false, connected: false },
    },
    expected: "failed",
  },
  {
    name: "a terminal decision without a stop proof survives a disconnected native side",
    facts: facts({
      terminalDecision: { decided: true, cause: "cancellation", deadlineReached: false },
      stop: { attemptId: ATTEMPT, proven: false, at: null },
      trust: { identityMatches: true, observationCurrent: false, connected: false },
    }),
    expected: "waiting_stop",
  },
  {
    name: "a bound stop proof survives a disconnected native side",
    // A stop proof bound to the current attempt stays a confirmed stop even
    // when the live observation is gone.
    facts: facts({
      report: { attemptId: ATTEMPT, state: "authenticated" },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      trust: { identityMatches: true, observationCurrent: false, connected: false },
    }),
    expected: "needs_review",
  },
  {
    name: "a verified acceptance survives a disconnected native side",
    facts: facts({
      acceptance: { decision: "accepted", conflict: false },
      trust: { identityMatches: true, observationCurrent: false, connected: false },
    }),
    expected: "accepted",
  },
  {
    name: "a disconnected native side without a decision shows unknown",
    facts: facts({ trust: { identityMatches: true, observationCurrent: true, connected: false } }),
    expected: "unknown",
  },
  {
    name: "an unknown stop status is not treated as a confirmed absence",
    facts: facts({
      terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
      stop: { attemptId: ATTEMPT, proven: null, at: null },
    }),
    expected: "waiting_stop",
  },
  {
    name: "an unknown terminal decision status does not fall through to running",
    // An unknown decision is not a decision that was not made. Without a
    // verified acceptance decision there is no higher rule, so no state can
    // be named.
    facts: facts({
      terminalDecision: { decided: null, cause: null, deadlineReached: false },
    }),
    expected: "unknown",
  },
  {
    name: "an unknown terminal decision status does not fall through to needs_review",
    facts: facts({
      terminalDecision: { decided: null, cause: null, deadlineReached: false },
      report: { attemptId: ATTEMPT, state: "authenticated" },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "unknown",
  },
  {
    name: "an unknown terminal decision status does not fall through to waiting_input",
    facts: facts({
      terminalDecision: { decided: null, cause: null, deadlineReached: false },
      nativeWaitingForInput: true,
      nativePhase: "idle",
    }),
    expected: "unknown",
  },
  {
    name: "a verified acceptance decision outranks an unknown terminal decision status",
    facts: facts({
      acceptance: { decision: "accepted", conflict: false },
      terminalDecision: { decided: null, cause: null, deadlineReached: false },
    }),
    expected: "accepted",
  },
  {
    name: "an unknown report state is not treated as an absent report",
    facts: facts({
      report: { attemptId: ATTEMPT, state: "unknown" },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
    expected: "unknown",
  },
  {
    name: "an unknown waiting-for-input fact does not show waiting_input",
    facts: facts({ nativeWaitingForInput: null, nativePhase: "running" }),
    expected: "running",
  },
];

test("every case derives the expected display state", () => {
  for (const entry of CASES) {
    assert.equal(
      deriveTaskDisplayState(entry.facts),
      entry.expected,
      `${entry.name}: expected ${entry.expected}`,
    );
  }
});

test("the case table covers all ten display states", () => {
  const covered = new Set(CASES.map(entry => entry.expected));
  const required = [
    "queued",
    "running",
    "waiting_input",
    "waiting_stop",
    "needs_review",
    "accepted",
    "cancelled",
    "failed",
    "expired",
    "unknown",
  ];
  const missing = required.filter(state => !covered.has(state as never));
  assert.deepEqual(missing, [], `display states not covered by the case table: ${missing.join(", ")}`);
});

test("the case table names every case uniquely", () => {
  const names = CASES.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length);
});

test("the derivation does not modify its input", () => {
  for (const entry of CASES) {
    const before = JSON.stringify(entry.facts);
    deriveTaskDisplayState(entry.facts);
    assert.equal(JSON.stringify(entry.facts), before, `${entry.name}: the derivation mutated its input`);
  }
});

test("the derivation is stable for the same facts", () => {
  for (const entry of CASES) {
    const first = deriveTaskDisplayState(entry.facts);
    const second = deriveTaskDisplayState(entry.facts);
    assert.equal(first, second, `${entry.name}: the derivation is not deterministic`);
  }
});

test("the derivation does not depend on the shape of the fact objects it is given", () => {
  // The same facts expressed as separate objects must give the same answer,
  // which shows the function reads the fields it documents and nothing else.
  const base = facts({ report: { attemptId: ATTEMPT, state: "authenticated" } });
  const copy = facts({ report: { attemptId: ATTEMPT, state: "authenticated" } });
  assert.equal(deriveTaskDisplayState(base), deriveTaskDisplayState(copy));
});

test("a stop proof without a reliable time is a confirmed stop", () => {
  const withoutTime = decided("failure", true, null);
  const withTime = decided("failure", true, "2026-10-18T10:00:00.000Z");
  assert.equal(deriveTaskDisplayState(withoutTime), "failed");
  assert.equal(deriveTaskDisplayState(withTime), "failed");
  assert.equal(
    deriveTaskDisplayState(withoutTime),
    deriveTaskDisplayState(withTime),
    "the instant of the stop must not change the derived state",
  );
});

test("an unproven stop is not read as a running task", () => {
  // The contract is explicit that remoteStopped=false does not mean the task
  // is still running. A report that arrived without a stop proof therefore
  // shows waiting_stop, not running.
  const reported = facts({
    report: { attemptId: ATTEMPT, state: "authenticated" },
    stop: { attemptId: ATTEMPT, proven: false, at: null },
  });
  assert.equal(deriveTaskDisplayState(reported), "waiting_stop");
});

test("a terminal cause is never reconstructed from a timestamp", () => {
  // The facts carry no timestamp for the decision at all, so the cause can
  // only come from the explicit field. Two causes with otherwise identical
  // facts must derive different terminal states.
  const byCause = (cause: TerminalDecisionCause) =>
    deriveTaskDisplayState(
      facts({
        terminalDecision: { decided: true, cause, deadlineReached: cause === "deadline" },
        stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
      }),
    );
  assert.equal(byCause("deadline"), "expired");
  assert.equal(byCause("cancellation"), "cancelled");
  assert.equal(byCause("failure"), "failed");
});

test("an acceptance decision outranks a terminal decision", () => {
  // The contract lists the acceptance decision first. A task that was finally
  // accepted is shown as accepted even though a failure was recorded earlier.
  const derived = deriveTaskDisplayState(
    facts({
      acceptance: { decision: "accepted", conflict: false },
      terminalDecision: { decided: true, cause: "failure", deadlineReached: false },
      stop: { attemptId: ATTEMPT, proven: true, at: "2026-10-18T10:00:00.000Z" },
    }),
  );
  assert.equal(derived, "accepted");
});
