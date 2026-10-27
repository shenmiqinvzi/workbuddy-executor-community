import type { DatabaseSync } from "node:sqlite";
import type { TaskContractScope } from "./task-contract.js";
export declare const WORKSPACE_SCOPE_VERSION = "workspace-scope/1";
export interface WorkspaceEntry {
    path: string;
    kind: "file" | "directory" | "link" | "excluded";
    sha256: string | null;
    bytes: number;
    links: number;
}
export interface WorkspaceInventory {
    root: string;
    identity: string;
    entries: WorkspaceEntry[];
    gitIndex: string | null;
}
export interface WorkspaceBaseline {
    version: typeof WORKSPACE_SCOPE_VERSION;
    taskId: string;
    bindingHash: string;
    mode: "contract" | "scoped_submission" | "legacy_read_only";
    scope: TaskContractScope;
    inventory: WorkspaceInventory;
    protectedPaths: string[];
    git: "observed" | "not_a_repository";
    excludedPaths: string[];
    createdAt: string;
}
export interface ScopeChange {
    path: string;
    previousPath?: string;
    kind: "added" | "modified" | "deleted" | "renamed";
    category: "deliverable" | "metadata" | "unauthorized";
    problem?: string;
}
export interface WorkspaceScopeCheck {
    actor: "program";
    version: typeof WORKSPACE_SCOPE_VERSION;
    taskId: string;
    attemptId: string;
    baselineDigest: string;
    status: "passed" | "failed" | "checker_error";
    checkedAt: string;
    inventoryDigest: string | null;
    coverage: "workspace_inventory";
    excludedPaths: string[];
    changes: ScopeChange[];
    limitations: string[];
    error?: string;
}
export interface WorkspaceDispatchGuard {
    taskId: string;
    baselineDigest: string;
    inventory: WorkspaceInventory;
}
export interface WorkspaceScopeView {
    scope: TaskContractScope | null;
    version: typeof WORKSPACE_SCOPE_VERSION;
    baseline: "present" | "missing" | "integrity_failure";
    mode: WorkspaceBaseline["mode"] | null;
    baselineDigest: string | null;
    protectedCount: number | null;
    coverage: "workspace_inventory";
    excludedPaths: string[];
    check: WorkspaceScopeCheck | null;
    changeCount: number | null;
    changesTruncated: boolean;
}
/** Windows-safe relative names, independent of the host used for a regression. */
export declare function workspaceRelative(value: string): string;
export declare function resolveWorkspaceRead(root: string, target: string): string;
/** Durable scope facts share the authority database; reads never touch workspace files. */
export declare class WorkspaceProtection {
    private readonly db;
    private readonly dbFile;
    constructor(db: DatabaseSync, dbFile: string);
    private write;
    private changed;
    private baseline;
    create(taskId: string, workspace: string, bindingHash: string, scope: TaskContractScope, runsDir: string, mode?: WorkspaceBaseline["mode"]): {
        value: WorkspaceBaseline;
        digest: string;
    };
    guard(taskId: string): WorkspaceDispatchGuard;
    assertGuard(guard: WorkspaceDispatchGuard): undefined;
    bindAttempt(taskId: string, attemptId: string, guard: WorkspaceDispatchGuard): undefined;
    private attempt;
    private assertCurrentAttempt;
    private rootMatches;
    private current;
    authorizePath(taskId: string, attemptId: string, target: string, mode: "read" | "write"): string;
    verifyDispatch(taskId: string, attemptId: string): void;
    verifyPreparation(taskId: string, workspace: string): undefined;
    instructions(taskId: string): string;
    observeToolCall(taskId: string, attemptId: string, rawType: string | undefined, data: unknown, sourceRef: string): void;
    noteMutation(taskId: string, attemptId: string, paths: string[], sourceRef: string): void;
    review(taskId: string, attemptId: string): WorkspaceScopeCheck;
    latest(taskId: string, attemptId?: string): WorkspaceScopeCheck | null;
    assertAcceptance(taskId: string, attemptId: string): undefined;
    readView(taskId: string, attemptId?: string): WorkspaceScopeView;
}
