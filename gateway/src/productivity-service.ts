/**
 * Read-only productivity surface (L06): saved project templates, the
 * notification snapshot, and the delivery-export preview.
 *
 * "Read-only" is load-bearing here. This module never opens the task database
 * for writing, never activates a policy template, never marks an episode
 * delivered, and never creates an export file. The four writes in this line
 * happen only through desktop commands after a native confirmation:
 *
 *   template_save (new version)   template_archive
 *   notification_config           export_save
 *
 * Routing (all GET, handled by workbench-http.ts before this module):
 *   /workbench/v1/templates[?includeArchived=1]
 *   /workbench/v1/templates/:templateId
 *   /workbench/v1/notifications
 *   /workbench/v1/export-preview/:taskId
 *
 * Identifiers are never turned into paths. A template id must match
 * `tmpl-[A-Za-z0-9-]{8,64}`; a task id must be a stored identifier of 1-200
 * characters without a separator, so no endpoint here can read a local file.
 */

import {
  summarizeTemplate,
  type ProjectTemplateStore,
  type TemplateSummary,
} from "./project-template.js";
import {
  NOTIFICATION_SCHEMA,
  type NotificationCenter,
  type NotificationConfig,
  type PendingNotification,
} from "./notification-center.js";
import {
  DELIVERY_EXPORT_SCHEMA,
  EXPORT_KEY_WHITELIST,
  buildDeliveryExport,
  type DeliveryExportStore,
  type ExportStatistics,
} from "./delivery-export.js";

export const PRODUCTIVITY_SCHEMA = "workbuddy-executor/productivity-1";
export const PRODUCTIVITY_TEMPLATES_PATH = "/workbench/v1/templates";
export const PRODUCTIVITY_NOTIFICATIONS_PATH = "/workbench/v1/notifications";
export const PRODUCTIVITY_EXPORT_PREVIEW_PREFIX = "/workbench/v1/export-preview";

const TEMPLATE_ID = /^tmpl-[A-Za-z0-9-]{8,64}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface ProductivitySources {
  templates: ProjectTemplateStore;
  notifications: NotificationCenter;
  exportStore: DeliveryExportStore;
  /** Optional overview-derived coverage; null means "not measured here". */
  statistics?: (taskId: string) => ExportStatistics | null;
}

/* ------------------------------------------------------------------ */
/* Templates                                                            */
/* ------------------------------------------------------------------ */

export interface TemplateCatalogView {
  schemaVersion: typeof PRODUCTIVITY_SCHEMA;
  readOnly: true;
  source: typeof PRODUCTIVITY_TEMPLATES_PATH;
  count: number;
  templates: TemplateSummary[];
  issues: string[];
  activation: { supported: false; note: string };
}

export function readTemplateCatalog(sources: ProductivitySources, options: { includeArchived?: boolean } = {}): TemplateCatalogView {
  const templates = sources.templates.list({ includeArchived: options.includeArchived === true }).map(summarizeTemplate);
  return {
    schemaVersion: PRODUCTIVITY_SCHEMA,
    readOnly: true,
    source: PRODUCTIVITY_TEMPLATES_PATH,
    count: templates.length,
    templates,
    issues: sources.templates.issues(),
    activation: { supported: false, note: "本版本只保存模板建议；自动政策引擎未交付，模板激活字段固定为 unsupported。" },
  };
}

export type TemplateDetailView =
  | {
    ok: true;
    schemaVersion: typeof PRODUCTIVITY_SCHEMA;
    readOnly: true;
    templateId: string;
    latest: TemplateSummary;
    versions: TemplateSummary[];
    archived: boolean;
    issues: string[];
  }
  | { ok: false; code: "invalid_template_id" | "template_not_found"; message: string };

export function readTemplateDetail(sources: ProductivitySources, templateId: string): TemplateDetailView {
  if (!TEMPLATE_ID.test(templateId)) return { ok: false, code: "invalid_template_id", message: "A template id looks like tmpl-<identifier>." };
  const versions = sources.templates.versions(templateId);
  if (!versions.length) return { ok: false, code: "template_not_found", message: "No saved template with that identity exists." };
  const latest = versions[0]!;
  return {
    ok: true,
    schemaVersion: PRODUCTIVITY_SCHEMA,
    readOnly: true,
    templateId,
    latest: summarizeTemplate(latest),
    versions: versions.map(summarizeTemplate),
    archived: latest.archivedAt !== null,
    issues: sources.templates.issues(),
  };
}

/* ------------------------------------------------------------------ */
/* Notifications                                                        */
/* ------------------------------------------------------------------ */

export interface NotificationSnapshotView {
  schemaVersion: typeof PRODUCTIVITY_SCHEMA;
  readOnly: true;
  notificationSchema: typeof NOTIFICATION_SCHEMA;
  config: NotificationConfig;
  pending: PendingNotification[];
  issues: string[];
  delivery: { mode: "desktop_native"; delivered: null; note: string };
  limits: { pendingReturned: number };
}

/**
 * A preview, not a delivery. `pending()` does not advance the watermark, so
 * opening the page cannot swallow an episode that was never shown.
 */
export function readNotificationSnapshot(sources: ProductivitySources): NotificationSnapshotView {
  const pending = sources.notifications.pending();
  return {
    schemaVersion: PRODUCTIVITY_SCHEMA,
    readOnly: true,
    notificationSchema: NOTIFICATION_SCHEMA,
    config: sources.notifications.config(),
    pending,
    issues: sources.notifications.issues(),
    delivery: { mode: "desktop_native", delivered: null, note: "通知由受控桌面壳显示；这里只列出待办，不发送也不代表任务状态。" },
    limits: { pendingReturned: pending.length },
  };
}

/* ------------------------------------------------------------------ */
/* Export preview                                                       */
/* ------------------------------------------------------------------ */

export interface ExportPreviewView {
  schemaVersion: typeof PRODUCTIVITY_SCHEMA;
  readOnly: true;
  exportSchema: typeof DELIVERY_EXPORT_SCHEMA;
  taskId: string;
  digest: string;
  bytes: number;
  bytesLimit: number;
  /** The complete field whitelist, sorted, so the page can state it exactly. */
  whitelist: string[];
  presentFields: string[];
  counts: { attempts: number; events: number; reviews: number; checks: number };
  evidenceTypes: string[];
  limitations: string[];
  redactionCount: number;
  target: "user_chosen_directory";
}

export type ExportPreviewResult =
  | { ok: true; preview: ExportPreviewView }
  | { ok: false; code: "invalid_task_id" | "task_not_found" | "export_too_large" | "export_not_whitelisted"; message: string };

export function previewDeliveryExport(sources: ProductivitySources, taskId: string, now: Date = new Date()): ExportPreviewResult {
  if (!TASK_ID.test(taskId)) return { ok: false, code: "invalid_task_id", message: "The task id is not a saved task identity." };
  const statistics = sources.statistics ? sources.statistics(taskId) : null;
  const built = buildDeliveryExport(sources.exportStore, taskId, { now, statistics });
  if (!built.ok) return built;
  const document = built.document;
  const checks = document.evidence.reviews.reduce((total, review) => total + review.checks.length, 0);
  return {
    ok: true,
    preview: {
      schemaVersion: PRODUCTIVITY_SCHEMA,
      readOnly: true,
      exportSchema: DELIVERY_EXPORT_SCHEMA,
      taskId,
      digest: built.digest,
      bytes: built.bytes.byteLength,
      bytesLimit: 4 * 1024 * 1024,
      whitelist: [...EXPORT_KEY_WHITELIST].sort(),
      presentFields: Object.keys(document).sort(),
      counts: { attempts: document.task.attempts, events: document.task.events, reviews: document.task.reviews, checks },
      evidenceTypes: [...document.evidence.evidenceTypes],
      limitations: [...document.limitations],
      redactionCount: document.redactions.count,
      target: "user_chosen_directory",
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP-shaped handler (transport-agnostic)                             */
/* ------------------------------------------------------------------ */

export interface ProductivityRouteResponse { status: number; body: unknown }

function errorBody(code: string, message: string, taskId: string | null = null): ProductivityRouteResponse {
  return {
    status: statusFor(code),
    body: { error: { code: code.toUpperCase(), message, retryable: false, taskId, attemptId: null, operationId: null }, view: null },
  };
}

function statusFor(code: string): number {
  switch (code) {
    case "invalid_query":
    case "invalid_template_id":
    case "invalid_task_id":
      return 400;
    case "template_not_found":
    case "task_not_found":
      return 404;
    case "export_too_large":
    case "export_not_whitelisted":
      return 409;
    default:
      return 500;
  }
}

function parseIncludeArchived(search: string): { ok: true; includeArchived: boolean } | { ok: false; message: string } {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of query.keys()) {
    if (key !== "includeArchived") return { ok: false, message: `Unknown query parameter "${key}".` };
  }
  const raw = query.get("includeArchived");
  if (raw === null) return { ok: true, includeArchived: false };
  if (raw !== "1" && raw !== "0") return { ok: false, message: "includeArchived must be 1 or 0." };
  return { ok: true, includeArchived: raw === "1" };
}

/**
 * Handle one productivity path, or return null for any other path. The caller
 * performs the loopback/Host/Origin checks and the GET-only rule first.
 */
export function handleProductivityRequest(sources: ProductivitySources, pathname: string, search: string): ProductivityRouteResponse | null {
  if (pathname === PRODUCTIVITY_TEMPLATES_PATH) {
    const parsed = parseIncludeArchived(search);
    if (!parsed.ok) return errorBody("invalid_query", parsed.message);
    return { status: 200, body: readTemplateCatalog(sources, { includeArchived: parsed.includeArchived }) };
  }

  if (pathname.startsWith(`${PRODUCTIVITY_TEMPLATES_PATH}/`)) {
    const rest = pathname.slice(PRODUCTIVITY_TEMPLATES_PATH.length + 1);
    if (!rest || rest.includes("/")) return errorBody("not_found", "No such template endpoint.");
    let templateId: string;
    try { templateId = decodeURIComponent(rest); }
    catch { return errorBody("invalid_template_id", "The encoded template identifier is malformed."); }
    if (search && search !== "?") return errorBody("invalid_query", "This endpoint takes no query parameters.");
    const detail = readTemplateDetail(sources, templateId);
    if (!detail.ok) return errorBody(detail.code, detail.message);
    return { status: 200, body: detail };
  }

  if (pathname === PRODUCTIVITY_NOTIFICATIONS_PATH) {
    if (search && search !== "?") return errorBody("invalid_query", "This endpoint takes no query parameters.");
    return { status: 200, body: readNotificationSnapshot(sources) };
  }

  if (pathname.startsWith(`${PRODUCTIVITY_EXPORT_PREVIEW_PREFIX}/`)) {
    const rest = pathname.slice(PRODUCTIVITY_EXPORT_PREVIEW_PREFIX.length + 1);
    if (!rest || rest.includes("/")) return errorBody("not_found", "No such export-preview endpoint.");
    let taskId: string;
    try { taskId = decodeURIComponent(rest); }
    catch { return errorBody("invalid_task_id", "The encoded task identifier is malformed."); }
    if (search && search !== "?") return errorBody("invalid_query", "This endpoint takes no query parameters.");
    const preview = previewDeliveryExport(sources, taskId);
    if (!preview.ok) return errorBody(preview.code, preview.message, taskId);
    return { status: 200, body: preview.preview };
  }

  return null;
}
