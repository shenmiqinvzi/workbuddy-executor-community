import type { DesktopControlDraft, DesktopControlKind, DesktopControlReceipt } from "./desktop-control-journal.js";
export interface DesktopControlSnapshot {
    taskId: string;
    attemptId: string;
    revision: string;
    title: string;
    workspace: string;
    allowedActions: DesktopControlKind[];
    remoteStopped: boolean;
    model: string | null;
    rate: string | null;
    attempt: number;
    attemptLimit: number;
    executorId: string;
    connectionId: string;
    providerId: string;
    reasoningEffort: string | null;
    currentReviewId: string | null;
    requirements: Array<{
        id: string;
        kind: "command" | "semantic";
        definition: string;
    }>;
}
export interface DesktopControlPreview {
    draft: DesktopControlDraft;
    digest: string;
    expiresAt: string;
    snapshot: DesktopControlSnapshot;
}
export interface DesktopControlDependencies {
    inspect(taskId: string, kind: DesktopControlKind): Promise<DesktopControlSnapshot>;
    enqueue(draft: DesktopControlDraft): Promise<DesktopControlReceipt>;
    receipt(requestId: string): DesktopControlReceipt | null;
    forAttempt(taskId: string, attemptId: string): DesktopControlReceipt[];
    observe?(taskId: string, attemptId: string): Promise<{
        taskId: string;
        attemptId: string;
    }>;
    now?: () => number;
}
/** Only the native host may commit a preview. A page can request and inspect a
 * proposal but cannot change it after the native confirmation is displayed. */
export declare class DesktopControlSession {
    private readonly dependencies;
    private readonly previews;
    private readonly commits;
    private readonly now;
    constructor(dependencies: DesktopControlDependencies);
    preview(input: unknown): Promise<DesktopControlPreview>;
    review(requestId: string, digest: string): DesktopControlPreview;
    commit(requestId: string, digest: string): Promise<DesktopControlReceipt>;
    private commitOnce;
    receipt(requestId: string): DesktopControlReceipt | null;
    forAttempt(taskId: string, attemptId: string): DesktopControlReceipt[];
    requirements(input: unknown): Promise<DesktopControlSnapshot>;
    observe(taskId: string, attemptId: string): Promise<{
        taskId: string;
        attemptId: string;
    }>;
    private assertCurrent;
}
