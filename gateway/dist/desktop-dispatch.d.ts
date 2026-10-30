import { type ModelPolicy } from "./collaboration.js";
import { type ExecutionSelection, type NormalizedTaskContractV2 } from "./task-contract.js";
export interface DesktopModel {
    key: string;
    execution: ExecutionSelection;
    credits: string | null;
    pricingVerified: boolean;
    blockedReason: string | null;
}
export interface DesktopSession {
    hostId: string;
    sessionId: string;
    workspace: string;
    attached: boolean;
    busy: boolean;
}
export interface DesktopCatalogSource {
    models: Omit<DesktopModel, "key" | "blockedReason">[];
    sessions: DesktopSession[];
    policy: ModelPolicy;
    requiredFreeModel: string | null;
    dispatchEnabled: boolean;
    errors: string[];
}
export interface DesktopCatalog extends DesktopCatalogSource {
    catalogId: string;
    observedAt: string;
    expiresAt: string;
    models: DesktopModel[];
}
export interface DesktopDraft {
    draftId: string;
    digest: string;
    taskId: string;
    operationId: string;
    expiresAt: string;
    workspace: {
        realPath: string;
        device: string;
        inode: string;
    };
    contract: NormalizedTaskContractV2;
    sessionId: string | null;
    quote: {
        credits: string | null;
        pricingVerified: boolean;
        observedAt: string;
    };
    policyVersion: string;
}
export interface DesktopReceipt {
    requestId: string;
    taskId: string;
    operationId: string;
    state: "launch_requested" | "dispatching" | "submitted" | "failed" | "outcome_unknown";
    code?: string;
    message?: string;
}
export interface DesktopDispatchDependencies {
    catalog(): Promise<DesktopCatalogSource>;
    enqueue(draft: DesktopDraft): Promise<DesktopReceipt>;
    receipt(requestId: string): DesktopReceipt | null;
    latest?(): DesktopReceipt | null;
    observe?(requestId: string): Promise<{
        taskId: string;
        observedAt: string;
    }>;
    now?: () => number;
}
export declare function normalizedDesktopCatalog(source: DesktopCatalogSource): DesktopCatalogSource;
export declare function desktopExact(value: unknown, keys: string[]): asserts value is Record<string, unknown>;
export declare function desktopWorkspace(directory: string): {
    realPath: string;
    device: string;
    inode: string;
};
/** Drafts are memory-only. Reading choices or reviewing a proposal never opens
 * a writing executor store, prepares a model, registers a project or dispatches. */
export declare class DesktopDispatchSession {
    private readonly dependencies;
    private readonly catalogs;
    private readonly drafts;
    private readonly commits;
    private readonly inFlight;
    private readonly now;
    constructor(dependencies: DesktopDispatchDependencies);
    catalog(): Promise<DesktopCatalog>;
    preview(input: unknown): DesktopDraft;
    review(draftId: string, digest: string): DesktopDraft;
    /** Only the trusted native confirmation handler invokes this operation. */
    commit(draftId: string, digest: string): Promise<DesktopReceipt>;
    private commitOnce;
    receipt(requestId: string): DesktopReceipt | null;
    latest(): DesktopReceipt | null;
    observe(requestId: string): Promise<{
        taskId: string;
        observedAt: string;
    }>;
    private checkSession;
}
