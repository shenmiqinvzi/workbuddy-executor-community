export type DesktopControlKind = "cancel" | "rework" | "review" | "accept";
export type DesktopControlState = "requested" | "started" | "succeeded" | "rejected" | "outcome_unknown";
export interface DesktopControlDraft {
    requestId: string;
    operationId: string;
    kind: DesktopControlKind;
    taskId: string;
    attemptId: string;
    revision: string;
    parameters: Record<string, unknown>;
    createdAt: string;
    expiresAt: string;
}
export interface DesktopControlReceipt {
    requestId: string;
    operationId: string;
    kind: DesktopControlKind;
    taskId: string;
    attemptId: string;
    revision: string;
    state: DesktopControlState;
    code?: string;
    message?: string;
}
/** Durable, task-bound desktop receipts. A claimed request is never reclaimed. */
export declare class DesktopControlJournal {
    readonly file: string;
    constructor(file: string);
    private open;
    private parse;
    enqueue(draft: DesktopControlDraft): DesktopControlReceipt;
    claim(requestId: string): DesktopControlDraft | null;
    finish(requestId: string, state: "succeeded" | "rejected" | "outcome_unknown", code?: string, message?: string): void;
    receipt(requestId: string): DesktopControlReceipt | null;
    forAttempt(taskId: string, attemptId: string): DesktopControlReceipt[];
}
