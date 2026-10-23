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
/**
 * Whether a stop proof for the current attempt is established.
 *
 * A proof that belongs to another attempt, or whose attempt is unknown, does
 * not prove the stop of this attempt. A proof without a reliable time still
 * proves the stop.
 */
function stopProvenForCurrentAttempt(facts) {
    if (facts.stop.proven !== true)
        return false;
    return facts.stop.attemptId === facts.attemptId;
}
/**
 * The report state that applies to the current attempt. A report that
 * belongs to another attempt, or whose attempt is unknown, cannot be used.
 */
function reportForCurrentAttempt(facts) {
    if (facts.report.state === "absent" || facts.report.state === "unknown")
        return facts.report.state;
    if (facts.report.attemptId !== facts.attemptId)
        return "unknown";
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
function liveObservationIsUsable(facts) {
    return (facts.trust.identityMatches === true &&
        facts.trust.observationCurrent === true &&
        facts.trust.connected === true);
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
export function deriveTaskDisplayState(facts) {
    // Rule 1: a real final acceptance decision. The contract puts this first,
    // and a conflict is reported on its own channel by the caller, so it does
    // not change the display state.
    if (facts.acceptance.decision === "accepted")
        return "accepted";
    // Rule 2: a terminal decision already exists. A late report does not
    // change this priority.
    if (facts.terminalDecision.decided === true) {
        if (!stopProvenForCurrentAttempt(facts))
            return "waiting_stop";
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
    if (facts.terminalDecision.decided === null)
        return "unknown";
    // Rule 3: the native side is waiting for input. This state describes the
    // present moment, so it needs a current observation, a matching identity,
    // a known and not yet reached deadline, and no confirmed stop.
    if (facts.nativeWaitingForInput === true) {
        if (!liveObservationIsUsable(facts))
            return "unknown";
        if (facts.terminalDecision.deadlineReached !== false)
            return "unknown";
        if (stopProvenForCurrentAttempt(facts))
            return "unknown";
        return "waiting_input";
    }
    // Rule 4: a report has arrived for this attempt.
    const report = reportForCurrentAttempt(facts);
    if (report === "authenticated" || report === "unauthenticated") {
        if (!stopProvenForCurrentAttempt(facts))
            return "waiting_stop";
        if (report === "authenticated")
            return "needs_review";
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
    if (report !== "absent")
        return "unknown";
    if (stopProvenForCurrentAttempt(facts))
        return "unknown";
    if (!liveObservationIsUsable(facts))
        return "unknown";
    if (facts.nativePhase === "queued")
        return "queued";
    if (facts.nativePhase === "running")
        return "running";
    return "unknown";
}
//# sourceMappingURL=task-view-state.js.map