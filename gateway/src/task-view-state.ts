/**
 * Pure derivation of TaskView.displayState.
 *
 * Contract source: docs/INTERFACE_CONTRACT.md section 3, "TaskView 与按钮状态",
 * in particular the ordered rules that decide the display and the allowed
 * actions.
 *
 * Scope of this module:
 *   - It turns explicit facts into exactly one display state.
 *   - It reads no clock, no database, no network and no file, mutates nothing,
 *     and derives nothing from a display string, a business state string or a
 *     metric. A fact the caller cannot establish is passed as null, which is
 *     deliberately different from a confirmed false.
 *   - It derives the display state only. The allowed actions are a separate
 *     decision and are not implemented here.
 *
 * What this module deliberately does not do:
 *   - It does not read an existing displayState, so a stored view can never
 *     answer the question.
 *   - It does not infer a terminal cause from a timestamp. The cause of a
 *     terminal decision is an explicit fact.
 *   - It does not treat remoteStopped=false as "still running". The absence of
 *     a stop proof only means the stop is unproven.
 *   - It does not look at a revision. An old revision is an old snapshot; the
 *     facts it carried are simply the facts the caller supplies now.
 *   - It does not turn a conflict into a display state. The contract reports
 *     an identity or evidence conflict on its own channel; this function
 *     only returns a display state and cannot stand in for that error.
 *   - It does not have a switch that makes every offline case unknown. A
 *     verified decision and a stop proof bound to the current attempt remain
 *     usable when the live observation is unavailable.
 */

import type { TaskViewDisplayState } from "./task-view.js";

/**
 * A fact that may be established (true), confirmed absent (false) or not yet
 * known (null). "Not yet known" is never silently read as "confirmed absent".
 */
export type DerivationFlag = boolean | null;

/**
 * The cause a terminal decision was made for. The contract names three:
 * a deadline, a cancellation or a failure. The cause is a fact of the
 * decision record and is never reconstructed from timestamps.
 */
export type TerminalDecisionCause = "deadline" | "cancellation" | "failure";

/**
 * The state of the worker's report for the current attempt.
 *
 * "absent" is a confirmed absence, "unknown" is the absence of knowledge.
 * "unauthenticated" means a report arrived but its identity or evidence did
 * not check out, which is different from an authenticated report.
 */
export type ReportState = "absent" | "unauthenticated" | "authenticated" | "unknown";

/**
 * The phase the native side reports for the current attempt.
 *
 * "idle" means the native side is not working on the attempt right now
 * without a terminal decision having been made; it is not a display state on
 * its own.
 */
export type NativePhase = "queued" | "running" | "idle" | "unknown";

/**
 * The verified final acceptance decision.
 *
 * The contract asks for a real, final acceptance decision; a client cache
 * never creates one. "accepted" therefore means the decision was verified.
 *
 * "conflict" marks the case where a decision exists but its identity or
 * evidence disagrees with the record. The contract reports that conflict as
 * an error of its own, so it does not change the display state: a verified
 * final acceptance decision stays accepted, and the conflict travels on the
 * error channel the caller owns.
 */
export interface AcceptanceFacts {
  decision: "accepted" | "not_accepted" | "unknown";
  conflict: boolean;
}

/**
 * A deadline, cancellation or failure decision that has already been made,
 * plus whether the attempt deadline has been reached.
 *
 * "decided" is null while no decision is established. "cause" is null when
 * the decision exists but its cause is not established.
 */
export interface TerminalDecisionFacts {
  decided: DerivationFlag;
  cause: TerminalDecisionCause | null;
  /**
   * Whether the attempt deadline has been reached. The contract shows the
   * waiting-for-input state only while the attempt is not overdue, so the
   * caller states this fact; this module never reads a clock.
   */
  deadlineReached: DerivationFlag;
}

/**
 * The stop proof for the current attempt.
 *
 * "proven" is null while the stop status is not established. "at" may be null
 * even when the proof holds: the contract allows old evidence that lacks a
 * reliable time, and such a proof still confirms the stop.
 */
export interface StopProofFacts {
  /** The attempt the proof belongs to, or null when that is not established. */
  attemptId: string | null;
  proven: DerivationFlag;
  /** The instant the evidence proves, or null when the evidence has no reliable time. */
  at: string | null;
}

/** The worker's report for the current attempt. */
export interface ReportFacts {
  /** The attempt the report belongs to, or null when that is not established. */
  attemptId: string | null;
  state: ReportState;
}

/**
 * Whether the observation and the identity can be relied on.
 *
 * "identityMatches" false means the native side and the record describe
 * different work, which no conclusion can be drawn from. null means the
 * match is not established.
 */
export interface TrustFacts {
  identityMatches: DerivationFlag;
  /** The observation is recent enough to describe the present state. */
  observationCurrent: DerivationFlag;
  /** The connection to the native side is established. */
  connected: DerivationFlag;
}

/**
 * Every fact the derivation reads. Each field is an explicit observation of
 * the server side; the derivation never fills a gap from another field.
 */
export interface TaskDisplayFacts {
  /** The attempt these facts describe. */
  attemptId: string;
  acceptance: AcceptanceFacts;
  terminalDecision: TerminalDecisionFacts;
  stop: StopProofFacts;
  /** Whether the native side is waiting for a human to give input. */
  nativeWaitingForInput: DerivationFlag;
  report: ReportFacts;
  nativePhase: NativePhase;
  trust: TrustFacts;
}

/**
 * Whether a stop proof for the current attempt is established.
 *
 * A proof that belongs to another attempt, or whose attempt is unknown, does
 * not prove the stop of this attempt. A proof without a reliable time still
 * proves the stop.
 */
function stopProvenForCurrentAttempt(facts: TaskDisplayFacts): boolean {
  if (facts.stop.proven !== true) return false;
  return facts.stop.attemptId === facts.attemptId;
}

/**
 * The report state that applies to the current attempt. A report that
 * belongs to another attempt, or whose attempt is unknown, cannot be used.
 */
function reportForCurrentAttempt(facts: TaskDisplayFacts): ReportState {
  if (facts.report.state === "absent" || facts.report.state === "unknown") return facts.report.state;
  if (facts.report.attemptId !== facts.attemptId) return "unknown";
  return facts.report.state;
}

/**
 * Whether the live observation can describe the present moment.
 *
 * This gates the states that describe the present moment, such as
 * waiting_input, queued and running. It never gates a persistent fact: a
 * verified acceptance decision, a terminal decision and a bound stop proof
 * stay usable when the live observation is gone.
 */
function liveObservationIsUsable(facts: TaskDisplayFacts): boolean {
  return (
    facts.trust.identityMatches === true &&
    facts.trust.observationCurrent === true &&
    facts.trust.connected === true
  );
}

/**
 * Derive the display state from explicit facts.
 *
 * The order follows the contract:
 *   1. a real final acceptance decision shows accepted;
 *   2. an existing deadline, cancellation or failure decision shows
 *      waiting_stop while the stop is unproven and the matching terminal
 *      state once the stop is confirmed, and a late report does not change
 *      that priority;
 *   3. the native side waiting for input shows waiting_input;
 *   4. a report that arrived with an unproven stop shows waiting_stop, and an
 *      authenticated report with a confirmed stop shows needs_review;
 *   5. trusted, consistent and active facts show queued or running, and
 *      anything else shows unknown.
 *
 * Two kinds of fact are kept apart throughout:
 *   - Persistent facts. A verified acceptance decision, a terminal decision
 *     and a stop proof that is bound to the current attempt are recorded
 *     facts. They do not disappear because the live observation is gone.
 *   - Live observations. Whether the native side is connected, whether the
 *     observation is current and whether the identity matches describe the
 *     present moment. They gate the states that describe the present moment.
 *
 * There is deliberately no switch that turns every offline case into
 * unknown: a verified decision and a bound stop proof remain usable when the
 * live observation is unavailable.
 */
export function deriveTaskDisplayState(facts: TaskDisplayFacts): TaskViewDisplayState {
  // Rule 1: a real final acceptance decision. The contract puts this first,
  // and a conflict is reported on its own channel by the caller, so it does
  // not change the display state.
  if (facts.acceptance.decision === "accepted") return "accepted";

  // Rule 2: a terminal decision already exists. A late report does not
  // change this priority.
  if (facts.terminalDecision.decided === true) {
    if (!stopProvenForCurrentAttempt(facts)) return "waiting_stop";
    switch (facts.terminalDecision.cause) {
      case "deadline":
        return "expired";
      case "cancellation":
        return "cancelled";
      case "failure":
        return "failed";
      default:
        // The decision exists but its cause is not established, so the
        // terminal state cannot be named.
        return "unknown";
    }
  }

  // The terminal decision status is not established. Without a verified
  // acceptance decision there is no higher rule to apply, so no conclusion
  // can be drawn: an unknown decision is not a decision that was not made.
  if (facts.terminalDecision.decided === null) return "unknown";

  // Rule 3: the native side is waiting for input. This state describes the
  // present moment, so it needs a current observation, a matching identity,
  // a known and not yet reached deadline, and no confirmed stop.
  if (facts.nativeWaitingForInput === true) {
    if (!liveObservationIsUsable(facts)) return "unknown";
    if (facts.terminalDecision.deadlineReached !== false) return "unknown";
    if (stopProvenForCurrentAttempt(facts)) return "unknown";
    return "waiting_input";
  }

  // Rule 4: a report has arrived for this attempt.
  const report = reportForCurrentAttempt(facts);
  if (report === "authenticated" || report === "unauthenticated") {
    if (!stopProvenForCurrentAttempt(facts)) return "waiting_stop";
    if (report === "authenticated") return "needs_review";
    // The stop is confirmed but the report is not authenticated, so the task
    // is not ready for review and no other state applies.
    return "unknown";
  }

  // Rule 5: the native side and the record are consistent and the attempt is
  // still active.
  //
  // A report state that is not established leaves the record side of the
  // consistency check open, so the facts are not enough. A confirmed stop
  // means the attempt is no longer active, so queued or running would be
  // wrong; without a decision or a report there is no other state to show.
  if (report !== "absent") return "unknown";
  if (stopProvenForCurrentAttempt(facts)) return "unknown";
  if (!liveObservationIsUsable(facts)) return "unknown";
  if (facts.nativePhase === "queued") return "queued";
  if (facts.nativePhase === "running") return "running";
  return "unknown";
}
