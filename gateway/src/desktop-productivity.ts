/**
 * Desktop command surface for templates, notifications and controlled export.
 *
 * The HTTP adapter is read-only by design, so every mutation arrives here over
 * the desktop command channel after the browser page has shown the user what
 * will change. These handlers take structured parameters only: no shell string
 * is ever assembled, and the export directory must be an absolute path the
 * native dialog produced.
 */

import { templateContentHash, type ProjectTemplate } from "./project-template.js";
import type { NotificationConfig } from "./notification-center.js";
import { saveDeliveryExport } from "./delivery-export.js";
import {
  previewDeliveryExport,
  readNotificationSnapshot,
  readTemplateCatalog,
  readTemplateDetail,
  type ProductivitySources,
} from "./productivity-service.js";

/** Aliased so a caller can pass the same view model it built for the reads. */
export type ProductivityCommandSources = ProductivitySources;

export interface ProductivityCommandOutcome {
  /** False lets the desktop channel continue with its own actions. */
  handled: boolean;
  value?: unknown;
  failure?: { code: string; message: string };
}

const TEMPLATE_ID = /^tmpl-[A-Za-z0-9-]{8,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAXIMUM_DIRECTORY_CHARACTERS = 1000;

function failure(code: string, message: string): ProductivityCommandOutcome {
  return { handled: true, failure: { code, message } };
}

function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some(key => !required.includes(key) && !optional.includes(key))) return null;
  if (required.some(key => !Object.hasOwn(value, key))) return null;
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, minimum: number, maximum: number): string | null {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum && !/[\u0000-\u001f]/.test(value) ? value : null;
}

/**
 * Turn a stored template into the short shape a command result carries. The
 * full preset stays in the store; the UI already reads it through the
 * read-only catalog.
 */
function templateSummary(template: ProjectTemplate) {
  return {
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    name: template.name,
    kind: template.kind,
    contentHash: templateContentHash(template),
    checks: template.project.requiredChecks.length,
    scopeItems: template.project.scope.allowedChanges.length + template.project.scope.permittedMetadata.length,
    archivedAt: template.archivedAt,
  };
}

export function runProductivityCommand(
  sources: ProductivityCommandSources,
  method: string,
  parameters: unknown,
): ProductivityCommandOutcome {
  if (!method.startsWith("productivity_")) return { handled: false };
  const now = new Date();

  if (method === "productivity_catalog") {
    const parsed = fields(parameters, [], ["includeArchived"]);
    if (!parsed) return failure("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
    if (parsed.includeArchived !== undefined && typeof parsed.includeArchived !== "boolean") return failure("INVALID_REQUEST", "includeArchived 只能是布尔值。");
    const view = readTemplateCatalog(sources, { includeArchived: parsed.includeArchived === true });
    return { handled: true, value: { count: view.count, templates: view.templates, issues: view.issues, activation: view.activation } };
  }

  if (method === "productivity_template_detail") {
    const parsed = fields(parameters, ["templateId"]);
    if (!parsed) return failure("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
    const templateId = boundedText(parsed.templateId, 8, 80);
    if (!templateId) return failure("INVALID_REQUEST", "模板编号格式不正确。");
    const detail = readTemplateDetail(sources, templateId);
    if (!detail.ok) return failure(detail.code, detail.message);
    return { handled: true, value: detail };
  }

  if (method === "productivity_template_save") {
    const parsed = fields(parameters, ["template"], ["templateId"]);
    if (!parsed) return failure("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
    let templateId: string | undefined;
    if (parsed.templateId !== undefined) {
      const value = boundedText(parsed.templateId, 8, 80);
      if (!value || !TEMPLATE_ID.test(value)) return failure("INVALID_REQUEST", "模板编号格式不正确。");
      templateId = value;
    }
    // The store owns versioning and validation: it derives the next version for
    // a named identity and assigns a fresh one otherwise. Validating here first
    // would mint an identity and then look for it back in the file.
    const body = parsed.template;
    const saved = sources.templates.save(templateId === undefined ? body : { ...(body as Record<string, unknown>), templateId });
    if (!saved.ok) return failure(saved.rejection.code, saved.rejection.message);
    return { handled: true, value: { template: templateSummary(saved.template), created: saved.created } };
  }

  if (method === "productivity_template_archive") {
    const parsed = fields(parameters, ["templateId"]);
    if (!parsed) return failure("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
    const templateId = boundedText(parsed.templateId, 8, 80);
    if (!templateId || !TEMPLATE_ID.test(templateId)) return failure("INVALID_REQUEST", "模板编号格式不正确。");
    const archived = sources.templates.archive(templateId);
    if (!archived.ok) return failure(archived.rejection.code, archived.rejection.message);
    return { handled: true, value: { template: templateSummary(archived.template) } };
  }

  if (method === "productivity_notifications") {
    const parsed = fields(parameters, []);
    if (!parsed) return failure("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
    // pending() neither advances the watermark nor marks anything delivered.
    const snapshot = readNotificationSnapshot(sources);
    return { handled: true, value: snapshot };
  }

  if (method === "productivity_notification_config") {
    const parsed = fields(parameters, ["config"]);
    if (!parsed) return failure("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
    // setConfig applies the same whitelist the read view documents and writes
    // the file atomically; a rejected patch leaves the stored config alone.
    const applied = sources.notifications.setConfig(parsed.config);
    if (!applied.ok) return failure(applied.rejection.code, applied.rejection.message);
    return { handled: true, value: { config: applied.config satisfies NotificationConfig } };
  }

  if (method === "productivity_export_preview") {
    const parsed = fields(parameters, ["taskId"]);
    if (!parsed) return failure("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
    const taskId = boundedText(parsed.taskId, 1, 200);
    if (!taskId) return failure("INVALID_REQUEST", "任务编号格式不正确。");
    const preview = previewDeliveryExport(sources, taskId, now);
    if (!preview.ok) return failure(preview.code, preview.message);
    return { handled: true, value: preview.preview };
  }

  if (method === "productivity_export_save") {
    const parsed = fields(parameters, ["taskId", "directory", "digest"]);
    if (!parsed) return failure("INVALID_REQUEST", "请求字段不完整或包含未支持的操作。");
    const taskId = boundedText(parsed.taskId, 1, 200);
    if (!taskId) return failure("INVALID_REQUEST", "任务编号格式不正确。");
    const directory = typeof parsed.directory === "string" ? parsed.directory : null;
    if (!directory || directory.length > MAXIMUM_DIRECTORY_CHARACTERS) return failure("INVALID_REQUEST", "请选择一个有效的导出目录。");
    const digest = typeof parsed.digest === "string" && DIGEST.test(parsed.digest) ? parsed.digest : null;
    if (!digest) return failure("INVALID_REQUEST", "请先预览导出，再按同一份内容保存。");
    const statistics = sources.statistics ? sources.statistics(taskId) : null;
    const saved = saveDeliveryExport(sources.exportStore, { taskId, directory, expectedDigest: digest, statistics }, { now });
    if (!saved.ok) return failure(saved.code, saved.message);
    return { handled: true, value: { file: saved.file, bytes: saved.bytes, digest: saved.digest } };
  }

  return failure("UNKNOWN_ACTION", "未支持的操作。");
}
