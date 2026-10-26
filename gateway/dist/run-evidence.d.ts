import { type RunSnapshot } from "./run-journal.js";
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
export declare function runEvidenceDigestOf(snapshot: RunSnapshot, cancellation?: {
    requestedAt?: string | null;
    reason?: string | null;
}): string;
