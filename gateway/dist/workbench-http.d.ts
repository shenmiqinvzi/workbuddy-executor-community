/**
 * Local read-only HTTP adapter (`/workbench/v1`), task stage-2 plus quota-1.
 *
 * Contract source: docs/INTERFACE_CONTRACT.md section 1; stage scope fixed by
 * the 2026-10-23 development handoff, task T1.
 *
 * What this adapter serves:
 *   - GET /workbench/v1/health       — stored service facts, no dispatch.
 *   - GET /workbench/v1/tasks        — stable createdAt+taskId cursor list.
 *   - GET /workbench/v1/tasks/:taskId — one stage view snapshot.
 *
 * What this adapter deliberately does not serve:
 *   - Task events use the T2 persistent cross-attempt cursor. Resource quota
 *     reads use a separate versioned cache populated only by its collector.
 *   - No POST /tasks, rework, cancel, reviews or accept: write entries depend
 *     on later-stage idempotency, exclusivity and evidence binding; any
 *     non-GET method on a known path answers 405.
 *   - No /workspaces or /tasks/:taskId/export yet: they open per real
 *     registration/artifact sources, item by item, and currently answer 501.
 *
 * Everything here is transport only: the business facts and read rules stay
 * in TaskApplicationService (which stays snapshot-only), and no path in this
 * file syncs, dispatches, migrates, triggers a model request or writes to the
 * task store or the run directories.
 *
 * Access boundary (all checked before any handler runs):
 *   - Loopback addresses only: 127.0.0.1 / ::1 / ::ffff:127.0.0.1.
 *   - Host header must be a loopback host (any port, optional bracket form);
 *     a DNS name pointing at loopback is still rejected because the browser
 *     would expose this server to whatever resolves that name.
 *   - Cross-origin browser reads are refused: Origin present and not a
 *     loopback-web-origin (http/https + loopback host) answers 403.
 *   - Content-Type of a request is never parsed: no request body is read on
 *     any path in this stage.
 *
 * Error envelope follows the contract: {error:{code,message,retryable,
 * taskId,attemptId,operationId},view:null}. Messages carry no path, no
 * stored record content and no database text.
 */
import { TaskApplicationService } from "./task-application-service.js";
import { STAGE_TASK_VIEW_SCHEMA_VERSION, STAGE_TASK_VIEW_UNAVAILABLE } from "./task-view-stage.js";
import type { StageListItem } from "./task-application-service.js";
/** Default local port for the workbench HTTP surface (contract section 1). */
export declare const WORKBENCH_DEFAULT_PORT = 18493;
/** Configurable, so tests can bind an ephemeral port; default is the contract port. */
export declare function workbenchPortFromEnv(env?: NodeJS.ProcessEnv): number;
/**
 * Build the health body from real facts only.
 *
 * ready is true exactly when the shared service opened its store (the
 * composition root calls this only after constructing it); capabilities stay
 * false until independently verified, per the contract. No field here
 * claims that a model or the native app is reachable.
 */
export declare function workbenchHealth(input: {
    runtime: {
        release: string;
        packageVersion: string;
        startedAt: string;
    };
}): WorkbenchHealth;
/** The health body. ready means "this process opened its stores", nothing more. */
export interface WorkbenchHealth {
    schemaVersion: typeof STAGE_TASK_VIEW_SCHEMA_VERSION;
    ready: boolean;
    runtime: {
        release: string;
        packageVersion: string;
        startedAt: string;
    };
    capacity: {
        limit: 1;
        occupiedByTaskId: string | null;
    };
    modelPolicy: {
        /** Always false in this stage: no verified native model binding exists. */
        nativeModelBound: false;
        note: string;
    };
    capabilities: {
        /** Contract section 1: false until verified; this stage cannot verify them. */
        nativePermissionResponse: false;
        nativeSessionNavigation: false;
        /** Stage surface facts: T2 opens the read-only event stream. */
        readOnlyHttp: true;
        taskEventsHttp: true;
    };
    unavailable: typeof STAGE_TASK_VIEW_UNAVAILABLE;
}
interface WorkbenchAdapterOptions {
    /** The shared application service; the adapter holds no second store. */
    service: TaskApplicationService;
    /** Health facts supplied by the composition root, not discovered here. */
    health: (service: TaskApplicationService) => WorkbenchHealth;
    /** Loopback enforced by default; tests may pass their own predicate. */
    requestAllowed?: (remoteAddress: string | undefined, host: string | undefined, origin: string | undefined) => boolean;
}
/** Parse {limit, afterTaskId} from the list query string. */
export declare function parseListQuery(query: string): {
    ok: true;
    limit: number;
    afterTaskId?: string;
} | {
    ok: false;
    code: string;
    message: string;
};
/** The stage list body (contract: {tasks, nextAfterTaskId}). */
export interface StageListBody {
    schemaVersion: typeof STAGE_TASK_VIEW_SCHEMA_VERSION;
    unavailable: typeof STAGE_TASK_VIEW_UNAVAILABLE;
    /**
     * One entry per listed task. A read failure for one task keeps that entry
     * as {ok:false, taskId, code, field, message}; it never becomes an empty
     * view, a masked failure or an empty page.
     */
    tasks: StageListItem[];
    nextAfterTaskId: string | null;
}
export declare class WorkbenchHttpServer {
    private readonly options;
    private readonly server;
    private readonly allowed;
    constructor(options: WorkbenchAdapterOptions);
    /** Bind to loopback only. Resolves with the actual bound port. */
    listen(port: number): Promise<number>;
    close(): Promise<void>;
    private send;
    private refuse;
    private handle;
}
/** Re-exported for tests and callers that need the display-state union. */
export type { TaskViewDisplayState } from "./task-view.js";
