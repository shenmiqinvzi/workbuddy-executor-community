import { hasNativeStopEvidence } from "./run-journal.js";
import crypto from "node:crypto";
import { snapshotReportDigest } from "./report-authentication.js";
/**
 * Pure evidence-digest builder (T2-R1/R2): the digest covers every
 * run-file fact the projection reads — stop proof, full report
 * authentication object (not just its presence), report digest and status —
 * and is bound to the attemptId so a previous round's evidence can never be
 * mistaken for this round's. The projection reader recomputes it from the
 * run file to detect "file facts ahead of the persisted revision".
 *
 * T2-R1 round 3: the digest also binds the report's ACTUAL content. A
 * snapshot can carry an unchanged declared reportDigest while its text or
 * artifacts were altered on disk; the recomputed content digest diverges and
 * the evidence identity changes, so the reader refuses the stale revision
 * and the next sync regenerates it.
 */
export function runEvidenceDigestOf(snapshot, cancellation) {
    const stopped = hasNativeStopEvidence(snapshot);
    // The digest the snapshot's own bytes support right now (null when the
    // snapshot lacks a report or a usable authentication status). Comparing
    // this against the DECLARED digest is the adapter's authentication check;
    // here it only has to be part of the identity so any content change moves
    // the evidence.
    let contentDigest = null;
    try {
        contentDigest = snapshotReportDigest(snapshot);
    }
    catch {
        contentDigest = null;
    }
    // `stopControl.checkedAt` is an observation timestamp refreshed on every poll. Binding it
    // to the evidence identity made the read path permanently stale whenever an observer was
    // alive: the digest moved even though no recorded fact did. Only transitions belong here.
    const stopControl = snapshot.stopControl ? {
        state: snapshot.stopControl.state,
        requestedAt: snapshot.stopControl.requestedAt,
        issuedAt: snapshot.stopControl.issuedAt ?? null,
        acknowledgedAt: snapshot.stopControl.acknowledgedAt ?? null,
        error: snapshot.stopControl.error ?? null,
    } : null;
    return JSON.stringify({
        taskId: snapshot.taskId,
        attemptId: snapshot.attemptId,
        sessionId: snapshot.sessionId ?? null,
        runtimeSource: snapshot.runtimeSource ?? null,
        driver: snapshot.driver ?? null,
        stopped, nativeStoppedAt: snapshot.nativeStoppedAt ?? null,
        nativeStopSource: snapshot.nativeStopSource ?? null,
        stopReason: snapshot.stopReason ?? null,
        stopProofDigest: crypto.createHash("sha256").update(JSON.stringify([
            snapshot.nativeFailure ?? null, stopControl, snapshot.nativeStopCheck ?? null,
        ])).digest("hex"),
        rawContentDigest: crypto.createHash("sha256").update(JSON.stringify([
            snapshot.text ?? null, snapshot.artifacts ?? null, snapshot.validationRecords ?? null,
        ])).digest("hex"),
        cancellation: cancellation ? { requestedAt: cancellation.requestedAt ?? null, reason: cancellation.reason ?? null } : null,
        reportDigest: snapshot.reportDigest ?? null,
        // Actual on-disk report content binding: changes whenever text,
        // artifacts, validation records or the reported status change.
        contentDigest,
        auth: snapshot.reportAuthentication ?? null,
        status: snapshot.status,
        ...(snapshot.dsh ? { dsh: snapshot.dsh } : {}),
    });
}
//# sourceMappingURL=run-evidence.js.map