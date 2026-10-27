/**
 * Stage-1 local read-only HTTP adapter (`/workbench/v1`).
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
 *   - No GET task events: the contract requires a durable cross-attempt event
 *     cursor and a native-event dedup source (T2); neither exists in storage,
 *     so /tasks/:taskId/events answers 501 rather than a fabricated empty
 *     event stream.
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

import http from "node:http";
import type { AddressInfo } from "node:net";
import { TaskApplicationService } from "./task-application-service.js";
import { STAGE_TASK_VIEW_SCHEMA_VERSION, STAGE_TASK_VIEW_UNAVAILABLE, type StageTaskView } from "./task-view-stage.js";
import type { StageListItem } from "./task-application-service.js";

/** Default local port for the workbench HTTP surface (contract section 1). */
export const WORKBENCH_DEFAULT_PORT = 18493;

/** Configurable, so tests can bind an ephemeral port; default is the contract port. */
export function workbenchPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKBUDDY_WORKBENCH_PORT?.trim();
  if (!raw) return WORKBENCH_DEFAULT_PORT;
  // The value must be a complete decimal integer: parseInt alone would accept
  // "18493junk" or "18493.5" as 18493, silently starting on a port the
  // operator did not configure. Whitespace was already trimmed above.
  if (!/^\d+$/.test(raw)) {
    throw new Error("WORKBUDDY_WORKBENCH_PORT must be a decimal integer between 1 and 65535.");
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("WORKBUDDY_WORKBENCH_PORT must be a decimal integer between 1 and 65535.");
  }
  return value;
}

/**
 * Build the health body from real facts only.
 *
 * ready is true exactly when the shared service opened its store (the
 * composition root calls this only after constructing it); capabilities stay
 * false until independently verified, per the contract. No field here
 * claims that a model or the native app is reachable.
 */
export function workbenchHealth(input: { runtime: { release: string; packageVersion: string; startedAt: string } }): WorkbenchHealth {  return {
    schemaVersion: STAGE_TASK_VIEW_SCHEMA_VERSION,
    ready: true,
    runtime: input.runtime,
    // The shared-gateway capacity is 1 per the contract; the occupant id
    // needs the persistent exclusive lease machinery (T4) and stays null
    // rather than guessed.
    capacity: { limit: 1, occupiedByTaskId: null },
    modelPolicy: {
      nativeModelBound: false,
      note: "Model binding verification arrives with real dispatch wiring (T3); no model readiness is claimed here.",
    },
    capabilities: {
      nativePermissionResponse: false,
      nativeSessionNavigation: false,
      readOnlyHttp: true,
      taskEventsHttp: true,
    },
    unavailable: [...STAGE_TASK_VIEW_UNAVAILABLE],
  };
}

/** The health body. ready means "this process opened its stores", nothing more. */
export interface WorkbenchHealth {
  schemaVersion: typeof STAGE_TASK_VIEW_SCHEMA_VERSION;
  ready: boolean;
  runtime: { release: string; packageVersion: string; startedAt: string };
  capacity: { limit: 1; occupiedByTaskId: string | null };
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

/** One {code,message} pair per failure shape, kept stable. */
function errorBody(code: string, message: string, options: { taskId?: string } = {}) {
  return {
    error: { code, message, retryable: false, taskId: options.taskId ?? null, attemptId: null, operationId: null },
    view: null,
  };
}

function isLoopbackHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  // Strip a trailing :port (IPv6 hosts arrive bracketed). "localhost" is a
  // name, not a loopback literal: a DNS entry could resolve elsewhere, so it
  // is rejected here exactly like any other name.
  const bare = host.startsWith("[")
    ? host.slice(1, host.includes("]") ? host.indexOf("]") : undefined)
    : host.replace(/:\d+$/, "");
  return bare === "127.0.0.1" || bare === "::1";
}

function isLoopbackWebOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Same-origin GET / non-browser fetches send no Origin.
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "127.0.0.1" || url.hostname === "::1");
  } catch {
    return false;
  }
}

function isLoopbackRemote(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function defaultRequestAllowed(remoteAddress: string | undefined, host: string | undefined, origin: string | undefined): boolean {
  return isLoopbackRemote(remoteAddress) && isLoopbackHostHeader(host) && isLoopbackWebOrigin(origin);
}

/** Path shape shared by list and detail parsing. */
const TASKS_PREFIX = "/workbench/v1/tasks";
const HEALTH_PATH = "/workbench/v1/health";

/** Parse {limit, afterTaskId} from the list query string. */
export function parseListQuery(query: string): { ok: true; limit: number; afterTaskId?: string } | { ok: false; code: string; message: string } {
  const params = new URLSearchParams(query);
  const rawLimit = params.get("limit");
  let limit = 50;
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/.test(rawLimit)) return { ok: false, code: "INVALID_LIMIT", message: "limit must be a non-negative integer." };
    limit = Number.parseInt(rawLimit, 10);
    if (limit < 1) return { ok: false, code: "INVALID_LIMIT", message: "limit must be at least 1." };
    if (limit > 100) return { ok: false, code: "INVALID_LIMIT", message: "limit must be at most 100." };
  }
  const rawAfter = params.get("afterTaskId");
  if (rawAfter !== null) {
    if (rawAfter.length === 0 || rawAfter.length > 200) return { ok: false, code: "INVALID_CURSOR", message: "afterTaskId must be 1-200 characters." };
    return { ok: true, limit, afterTaskId: rawAfter };
  }
  return { ok: true, limit };
}

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

/** Map HTTP status codes for the named stage failure codes. */
function statusForStageFailure(code: string): number {
  switch (code) {
    case "task_not_found":
      return 404;
    case "invalid_task_id":
    case "invalid_cursor":
    case "evidence_stale":
    case "state_corrupt":
    case "cancel_corrupt":
      return 400;
    case "state_unreadable":
    case "cancel_unreadable":
    case "store_unavailable":
    case "contract_integrity":
    case "read_conflict":
      return 503;
    default:
      return 500;
  }
}
export class WorkbenchHttpServer {
  private readonly server: http.Server;
  private readonly allowed: NonNullable<WorkbenchAdapterOptions["requestAllowed"]>;

  constructor(private readonly options: WorkbenchAdapterOptions) {
    this.allowed = options.requestAllowed ?? defaultRequestAllowed;
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
    // A read server must not hang on dead clients; the default agent timeout
    // is irrelevant here because no upstream connection exists.
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 10_000;
  }

  /** Bind to loopback only. Resolves with the actual bound port. */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.server.address() as AddressInfo;
        resolve(address.port);
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, "127.0.0.1");
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(error => (error ? reject(error) : resolve()));
    });
  }

  private send(response: http.ServerResponse, status: number, body: unknown): void {
    if (response.headersSent) { response.end(); return; }
    const payload = JSON.stringify(body, null, 2);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(payload);
  }

  private refuse(response: http.ServerResponse, status: number, code: string, message: string, taskId?: string): void {
    this.send(response, status, errorBody(code, message, { taskId }));
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      const host = request.headers.host;
      const origin = request.headers.origin;
      if (!this.allowed(request.socket.remoteAddress, typeof host === "string" ? host : undefined, typeof origin === "string" ? origin : undefined)) {
        this.refuse(response, 403, "FORBIDDEN", "This endpoint serves local loopback clients only.");
        return;
      }
      const method = (request.method ?? "").toUpperCase();
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;
      if (method !== "GET" && method !== "HEAD") {
        // Known read-shaped contract paths answer 405 with the methods that
        // would be legal; POST write entries (tasks submit, rework, cancel,
        // reviews, accept) are not opened in this stage at all.
        const isKnownPath = pathname === HEALTH_PATH
          || pathname === TASKS_PREFIX
          || /^\/workbench\/v1\/tasks\/[^/]+(\/(rework|cancel|reviews|accept|events|export))?$/.test(pathname);
        if (isKnownPath) {
          response.setHeader("allow", "GET, HEAD");
          this.refuse(response, 405, "METHOD_NOT_ALLOWED", "Only read (GET) access is available in this stage.");
          return;
        }
        this.refuse(response, 404, "NOT_FOUND", "No such endpoint.");
        return;
      }
      if (pathname === HEALTH_PATH) {
        this.send(response, 200, this.options.health(this.options.service));
        return;
      }
      if (pathname === TASKS_PREFIX) {
        const parsed = parseListQuery(url.search);
        if (!parsed.ok) { this.refuse(response, 400, parsed.code, parsed.message); return; }
        const result = this.options.service.listStageViews({ limit: parsed.limit, afterTaskId: parsed.afterTaskId });
        if (!result.ok) {
          // A store failure is a 503, a cursor problem a 400; neither is
          // rewritten into the other.
          this.refuse(response, statusForStageFailure(result.code), result.code.toUpperCase(), result.message);
          return;
        }
        const body: StageListBody = { schemaVersion: result.schemaVersion, unavailable: result.unavailable, tasks: result.tasks, nextAfterTaskId: result.nextAfterTaskId };
        this.send(response, 200, body);
        return;
      }
      const detailMatch = /^\/workbench\/v1\/tasks\/([^/]+)$/.exec(pathname);
      if (detailMatch) {
        const taskId = decodeURIComponent(detailMatch[1]!);
        if (taskId.length === 0 || taskId.length > 200) {
          this.refuse(response, 400, "INVALID_TASK_ID", "The task id must be 1-200 characters.");
          return;
        }
        const result = this.options.service.readStageView(taskId);
        if (!result.ok) {
          this.refuse(response, statusForStageFailure(result.code), result.code.toUpperCase(), result.message, result.taskId || undefined);
          return;
        }
        this.send(response, 200, result.view);
        return;
      }
      // T2 opens the read-only event stream: afterEventId exclusive cursor,
      // limit 1-200 (default 100), ascending eventId, nothing written.
      const eventsMatch = /^\/workbench\/v1\/tasks\/([^/]+)\/events$/.exec(pathname);
      if (eventsMatch) {
        const taskId = decodeURIComponent(eventsMatch[1]!);
        if (taskId.length === 0 || taskId.length > 200) {
          this.refuse(response, 400, "INVALID_TASK_ID", "The task id must be 1-200 characters.");
          return;
        }
        const afterEventIdRaw = url.searchParams.get("afterEventId");
        if (afterEventIdRaw !== null && !/^\d+$/.test(afterEventIdRaw)) {
          this.refuse(response, 400, "INVALID_CURSOR", "afterEventId must be a non-negative integer.");
          return;
        }
        const limitRaw = url.searchParams.get("limit");
        if (limitRaw !== null && !/^\d{1,4}$/.test(limitRaw)) {
          this.refuse(response, 400, "INVALID_CURSOR", "limit must be an integer between 1 and 200.");
          return;
        }
        const afterEventId = afterEventIdRaw === null ? 0 : parseInt(afterEventIdRaw, 10);
        const limit = limitRaw === null ? 100 : parseInt(limitRaw, 10);
        const result = this.options.service.listTaskEvents(taskId, { afterEventId, limit });
        if (!result.ok) {
          const status = result.code === "task_not_found" ? 404
            : result.code === "invalid_task_id" || result.code === "invalid_cursor" ? 400
            : 503;
          this.refuse(response, status, result.code.toUpperCase(), result.message, taskId);
          return;
        }
        this.send(response, 200, { events: result.events, nextEventId: result.nextEventId });
        return;
      }
      if (/^\/workbench\/v1\/tasks\/[^/]+\/export$/.test(pathname)) {
        this.refuse(response, 501, "EXPORT_NOT_IMPLEMENTED", "Export opens per real artifact sources in a later stage.");
        return;
      }
      if (pathname === "/workbench/v1/workspaces") {
        this.refuse(response, 501, "WORKSPACES_NOT_IMPLEMENTED", "Workspace listing opens with real workspace registration binding in a later stage.");
        return;
      }
      this.refuse(response, 404, "NOT_FOUND", "No such endpoint.");
    } catch {
      // Never leak a stack, path or record content into the response.
      this.refuse(response, 500, "INTERNAL_ERROR", "The read-only endpoint failed to produce a response.");
    }
  }
}

/** Re-exported for tests and callers that need the display-state union. */
export type { TaskViewDisplayState } from "./task-view.js";
