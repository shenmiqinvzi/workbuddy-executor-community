/**
 * The report authentication record.
 *
 * A worker report reaches the queue through DesktopQueue.report(). That method
 * verifies the caller's desktop identity, the claim's session, the execution
 * lease, the deadline and any cited validation records before it stores the
 * report. This module names the facts that proof leaves behind, so a later
 * read-only query can tell "a report arrived" apart from "a report arrived and
 * its origin was verified".
 *
 * What the record means: the queue accepted this report from the verified
 * desktop session that held this execution lease. It says nothing about the
 * work being correct, complete or accepted, and nothing about the native turn
 * having stopped. Independent review and acceptance stay separate.
 *
 * The digest covers the originally submitted status, the report text, the
 * artifacts and, only when non-empty, the validation records. One function
 * computes it for the writer and for the reader, so the two cannot drift.
 */
/** The only authentication record format this build writes and verifies. */
export declare const REPORT_AUTHENTICATION_FORMAT = 1;
/** The status the worker submitted, before any cancellation mapping. */
export type ReportedStatus = "completed" | "blocked" | "failed" | "cancelled";
/** A cited validation record, as stored with the report. */
export interface ReportValidationRecord {
    path: string;
    sha256: string;
}
/**
 * The persisted proof that a report passed the queue's own checks.
 *
 * It deliberately carries no lease token, credential or native history: only
 * identifiers the task record and run snapshot already hold, plus the time the
 * queue accepted the report.
 */
export interface ReportAuthentication {
    formatVersion: number;
    taskId: string;
    attemptId: string;
    sessionId: string;
    runtimeSource: string;
    /** The status as submitted, needed to recompute the digest later. */
    reportedStatus: string;
    reportDigest: string;
    /** When the queue accepted the report, as an ISO-8601 instant. */
    authenticatedAt: string;
}
export interface ReportDigestInput {
    status: string;
    text: string;
    artifacts: string[];
    validationRecords?: ReportValidationRecord[];
}
/**
 * The digest the queue has always written for a report.
 *
 * The field order and the conditional fourth element are part of the format:
 * changing them would invalidate every stored digest.
 */
export declare function reportDigest(input: ReportDigestInput): string;
/** Why a report could not be treated as authenticated. */
export type ReportAuthenticationProblem = "missing" | "unsupported_format" | "binding_mismatch" | "digest_mismatch";
export type ReportAuthenticationOutcome = {
    state: "authenticated";
    authenticatedAt: string;
} | {
    state: "unknown";
    problem: ReportAuthenticationProblem;
};
/** What the current records say the authentication record must match. */
export interface ReportAuthenticationExpectation {
    taskId: string;
    attemptId: string;
    sessionId: string;
    runtimeSource: string;
    /** The digest recomputed from the snapshot's own content and reported status. */
    snapshotDigest: string;
}
/**
 * Verify a stored authentication record against the current records.
 *
 * Every binding is compared, the format version must be one this build
 * understands, and the digest must match the one recomputed from the content
 * that is on disk now. Anything else leaves the report unauthenticated; it is
 * never rounded up to "no report".
 */
export declare function verifyReportAuthentication(record: ReportAuthentication | undefined, expectation: ReportAuthenticationExpectation): ReportAuthenticationOutcome;
/**
 * Recompute the digest of a stored snapshot from its own content.
 *
 * Returns null when the snapshot does not carry what the digest needs: a
 * reported status, the digest itself and a text body.
 */
export declare function snapshotReportDigest(snapshot: {
    reportDigest?: string;
    text?: string;
    artifacts?: string[];
    validationRecords?: ReportValidationRecord[];
    reportAuthentication?: ReportAuthentication;
}): string | null;
