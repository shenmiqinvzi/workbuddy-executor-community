import type { TaskStore } from "./task-store.js";
export declare const PANEL_SCHEMA: "workbuddy-executor/panel-1";
/** A separate, additive read DTO. Stage-2 retains its existing meaning. */
export declare function readPanelTask(store: TaskStore, runsDir: string, taskId: string, detail?: boolean): import("./task-view-reader.js").TaskProjectionFailure | {
    ok: false;
    taskId: string;
    code: string;
    field: string;
    message: string;
    schemaVersion?: undefined;
    readOnly?: undefined;
    snapshotOnly?: undefined;
    view?: undefined;
    presentation?: undefined;
    reviews?: undefined;
    reviewsTruncated?: undefined;
    reviewMeaning?: undefined;
} | {
    ok: true;
    taskId: string;
    schemaVersion: "workbuddy-executor/panel-1";
    readOnly: boolean;
    snapshotOnly: boolean;
    view: import("./task-view-stage.js").StageTaskView;
    presentation: {
        title: string | null;
        objective: string;
        blockingReason: string | null;
        allowedChanges: string[] | null;
        model: string | null;
        report: {
            status: string | null;
            authentication: import("./task-view-state.js").ReportState;
            text: string;
            truncated: boolean;
        } | null;
    };
    reviews: {
        reviewId: string;
        attemptId: string;
        createdAt: string;
        basisRevision: string;
        committedRevision: string;
        runtimeSource: string;
        note: string;
        supersedesReviewId: string | null;
        correction: "reviewer_error" | null;
        checks: {
            id: string;
            checkId: string;
            kind: "scope" | "command" | "semantic" | "provenance";
            status: import("./task-reviews.js").CheckStatus;
            actor: "program" | "independent_reviewer" | "worker";
            checkedAt: string;
            note: string;
            evidenceRefs: string[];
            checkedFileCount: number;
        }[];
    }[] | null;
    reviewsTruncated: boolean;
    reviewMeaning: "stored_acceptance_snapshot";
    code?: undefined;
    field?: undefined;
    message?: undefined;
};
