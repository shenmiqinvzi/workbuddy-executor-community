/**
 * Sanitized delivery export.
 *
 * The export is built from an explicit field whitelist and nothing else. It
 * never copies the task database, native logs, chat bodies, configuration,
 * credentials or arbitrary local files, and it never reads a file or URL named
 * by the caller: the only inputs are a task id plus the local store, and the
 * only destination is a directory the user picked in a native dialog.
 *
 * Saving is structured, not string-concatenated: `taskId` and `directory` are
 * validated values, the file name is derived here, an existing file is never
 * overwritten, and the bytes are re-generated from the store after the user
 * confirmed a preview digest, so a changed task cannot be saved as the preview
 * the user approved.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ReviewCheck, ReviewRecord } from "./task-reviews.js";
import type { StoredTask, StoredTaskEvent, TaskContractRead } from "./task-store.js";
import type { StatisticsCoverage } from "./statistics-service.js";

/** The only statistics shape an export carries: coverage plus named limits. */
export interface ExportStatistics {
  window: { from: string | null; to: string | null };
  coverage: StatisticsCoverage;
  limitations: string[];
  limitationCounts: Record<string, number>;
}

export const DELIVERY_EXPORT_SCHEMA = "workbuddy-executor/delivery-export-1";

export const DELIVERY_EXPORT_LIMITS = {
  bytes: 4 * 1024 * 1024,
  reviews: 50,
  checksPerReview: 100,
  noteCharacters: 1000,
  definitionCharacters: 500,
  fileAttempts: 20,
} as const;

/**
 * Every key an export document may contain. A key outside this set is a bug in
 * the builder, and the self-check refuses to hand out the document.
 */
export const EXPORT_KEY_WHITELIST: ReadonlySet<string> = new Set([
  "schemaVersion", "exportedAt", "generator", "name", "version", "readOnly",
  "task", "taskId", "title", "state", "createdAt", "updatedAt", "attempts", "attemptId", "events", "reviews",
  "contract", "present", "reason", "schemaVersion", "agreementVersion", "hashPrefix", "timeoutSeconds",
  "maxAttempts", "requested", "policy", "effective", "scope", "allowedChanges", "permittedMetadata",
  "requiredChecks", "id", "kind", "definition", "definitionTruncated",
  "evidence", "reviewId", "supersedesReviewId", "correction", "reviewer", "actor", "channel",
  "machineCheckIds", "checks", "checkId", "status", "checkedAt", "note", "noteTruncated",
  "evidenceTypes", "statistics", "coverage", "window", "from", "to", "limitations", "limitationCounts",
  "claims", "savings", "superiority", "redactions", "count", "fields",
  "tasksRead", "tasksIncluded", "tasksExcludedOutsideWindow", "tasksWithoutEvents", "tasksIncomplete",
  "eventsRead", "tasksTruncated", "eventsTruncated",
]);

const SECRET_KEY = /(secret|token|passwd|password|credential|cookie|authorization|api[-_]?key|private[-_]?key|access[-_]?key|session[-_]?key)/i;
// Bearer tokens, provider key prefixes, PEM headers, and inline `name=value`
// pairs (`token=…`, `password: …`) that reached a free-text field.
const SECRET_VALUE = /^(?:bearer\s|basic\s|sk-[A-Za-z0-9]|ghp_|xox[baprs]-|-----BEGIN )|(?:^|[\s,;])(?:secret|token|passwd|password|api[-_]?key)\s*[:=]\s*\S+/i;

export interface RedactionResult { value: unknown; fields: string[] }

/** Remove secret-looking keys and values at any depth, naming what was removed. */
export function redactSecrets(value: unknown, at = ""): RedactionResult {
  const fields: string[] = [];
  const walk = (input: unknown, where: string): unknown => {
    if (Array.isArray(input)) return input.map((item, index) => walk(item, `${where}[${index}]`));
    if (typeof input === "object" && input !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        const child = where ? `${where}.${key}` : key;
        if (SECRET_KEY.test(key)) { fields.push(child); continue; }
        out[key] = walk(item, child);
      }
      return out;
    }
    if (typeof input === "string" && SECRET_VALUE.test(input.trim())) { fields.push(where); return "[redacted]"; }
    return input;
  };
  return { value: walk(value, at), fields };
}

/** Return the first key outside the whitelist, or null. Test seam. */
export function findUnlistedExportKey(value: unknown, dynamic = false): string | null {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findUnlistedExportKey(item); if (found) return found; }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!dynamic && !EXPORT_KEY_WHITELIST.has(key)) return key;
    // Limitation counts are keyed by limitation code, a bounded vocabulary the
    // statistics module owns; the codes themselves are not field names.
    const found = findUnlistedExportKey(item, key === "limitationCounts");
    if (found) return found;
  }
  return null;
}

export interface DeliveryExportStore {
  get(taskId: string): StoredTask | undefined;
  getContract(taskId: string): TaskContractRead;
  listAttempts(taskId: string): Array<{ attemptId: string }>;
  listTaskEvents(taskId: string, options?: { afterEventId?: number; limit?: number }): { events: StoredTaskEvent[]; nextEventId: number };
  reviews: { list(taskId: string): ReviewRecord[] };
}

export interface DeliveryExportDocument {
  schemaVersion: typeof DELIVERY_EXPORT_SCHEMA;
  exportedAt: string;
  generator: { name: "workbuddy-executor"; version: null; readOnly: true };
  task: { taskId: string; title: string; state: string; createdAt: string; updatedAt: string; attempts: number; events: number; reviews: number };
  contract:
    | { present: false; reason: "absent" | "integrity_failure" }
    | {
      present: true;
      schemaVersion: string;
      agreementVersion: string;
      hashPrefix: string;
      timeoutSeconds: number;
      maxAttempts: { requested: number; policy: number; effective: number };
      scope: { allowedChanges: string[]; permittedMetadata: string[] };
      requiredChecks: Array<{ id: string; kind: string; definition: string; definitionTruncated: boolean }>;
    };
  evidence: {
    attempts: Array<{ attemptId: string }>;
    reviews: Array<{
      reviewId: string;
      createdAt: string;
      supersedesReviewId: string | null;
      correction: string | null;
      reviewer: { actor: string; channel: string };
      machineCheckIds: string[];
      checks: Array<{ checkId: string; kind: string; status: string; actor: string; checkedAt: string; note: string; noteTruncated: boolean }>;
    }>;
    evidenceTypes: string[];
  };
  statistics:
    | { present: false }
    | {
      present: true;
      window: { from: string | null; to: string | null };
      coverage: StatisticsCoverage;
      limitations: string[];
      limitationCounts: Record<string, number>;
      claims: { savings: null; superiority: null };
    };
  limitations: string[];
  redactions: { count: number; fields: string[] };
}

export type DeliveryExportResult =
  | { ok: true; document: DeliveryExportDocument; bytes: Buffer; digest: string }
  | { ok: false; code: "invalid_task_id" | "task_not_found" | "export_too_large" | "export_not_whitelisted"; message: string };

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function clip(value: string, max: number): { text: string; truncated: boolean } {
  return value.length <= max ? { text: value, truncated: false } : { text: `${value.slice(0, max - 1)}…`, truncated: true };
}

function reviewChecks(record: ReviewRecord): ReviewCheck[] {
  return Array.isArray(record.checks) ? record.checks.slice(0, DELIVERY_EXPORT_LIMITS.checksPerReview) : [];
}

/**
 * Build the export from the store. `statistics` is optional: without it the
 * document says coverage is unavailable instead of printing zeroes.
 */
export function buildDeliveryExport(
  store: DeliveryExportStore,
  taskId: string,
  options: { now?: Date; statistics?: ExportStatistics | null; maxBytes?: number } = {},
): DeliveryExportResult {
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return { ok: false, code: "invalid_task_id", message: "The task id is not a saved task identity." };
  const task = store.get(taskId);
  if (!task) return { ok: false, code: "task_not_found", message: "No saved task with that identity exists." };
  const contract = store.getContract(taskId);
  const attempts = store.listAttempts(taskId).slice(0, 50).map(attempt => ({ attemptId: attempt.attemptId }));
  // Event ids are monotonic per task, so the cursor after the last event is a
  // count that does not require reading the whole stream into the export.
  let eventCount = 0;
  let eventsReadable = true;
  try { eventCount = store.listTaskEvents(taskId, { limit: 1 }).nextEventId; }
  catch { eventsReadable = false; }
  const reviews = store.reviews.list(taskId);
  const limitations: string[] = [
    "导出只包含白名单字段：不含任务正文原文之外的聊天记录、原生日志、任务数据库、配置或凭据。",
    "导出是某一时刻的只读快照；保存后任务继续变化不会回写这份文件。",
    "执行器自报与独立审查分别保存；报告里的“通过”不构成验收结论。",
  ];
  if (reviews.length > DELIVERY_EXPORT_LIMITS.reviews) limitations.push(`审查记录超过 ${DELIVERY_EXPORT_LIMITS.reviews} 份，仅导出最近的 ${DELIVERY_EXPORT_LIMITS.reviews} 份。`);
  if (contract.state === "integrity_failure") limitations.push("原始约定校验失败，契约部分只标记为不可解释，不复制可疑内容。");
  if (!eventsReadable) limitations.push("事件流当前不可读取；导出里的 events 计为 0，不代表没有事件。");
  const statistics = options.statistics ?? null;
  if (!statistics) limitations.push("未提供统计 coverage；这份导出不包含汇总数字，也不把缺失当作零。");

  const contractSection: DeliveryExportDocument["contract"] = contract.state === "found"
    ? {
      present: true,
      schemaVersion: contract.record.schemaVersion,
      agreementVersion: contract.record.agreementVersion,
      hashPrefix: contract.record.contractHash.slice(0, 16),
      timeoutSeconds: contract.record.contract.timeoutSeconds,
      maxAttempts: { requested: contract.record.requestedMaxAttempts, policy: contract.record.policyMaxAttempts, effective: contract.record.effectiveMaxAttempts },
      scope: { allowedChanges: [...contract.record.contract.scope.allowedChanges], permittedMetadata: [...contract.record.contract.scope.permittedMetadata] },
      requiredChecks: contract.record.contract.requiredChecks.map(check => {
        const definition = clip(check.definition, DELIVERY_EXPORT_LIMITS.definitionCharacters);
        return { id: check.id, kind: check.kind, definition: definition.text, definitionTruncated: definition.truncated };
      }),
    }
    : { present: false, reason: contract.state === "absent" ? "absent" : "integrity_failure" };

  const evidenceTypes = new Set<string>();
  if (attempts.length) evidenceTypes.add("attempt");
  if (eventCount > 0) evidenceTypes.add("task_event");
  for (const review of reviews) for (const check of reviewChecks(review)) evidenceTypes.add(`check:${check.kind}`);
  if (task.report) evidenceTypes.add("executor_report");

  const document: DeliveryExportDocument = {
    schemaVersion: DELIVERY_EXPORT_SCHEMA,
    exportedAt: (options.now ?? new Date()).toISOString(),
    generator: { name: "workbuddy-executor", version: null, readOnly: true },
    task: {
      taskId: task.taskId,
      title: contract.state === "found" ? contract.record.contract.title : "",
      state: task.state,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      attempts: attempts.length,
      events: eventCount,
      reviews: reviews.length,
    },
    contract: contractSection,
    evidence: {
      attempts,
      reviews: reviews.slice(-DELIVERY_EXPORT_LIMITS.reviews).map(review => ({
        reviewId: review.reviewId,
        createdAt: review.createdAt,
        supersedesReviewId: review.supersedesReviewId,
        correction: review.correction,
        reviewer: { actor: review.reviewer.actor, channel: review.reviewer.channel },
        machineCheckIds: [...review.machineCheckIds],
        checks: reviewChecks(review).map(check => {
          const note = clip(check.note, DELIVERY_EXPORT_LIMITS.noteCharacters);
          return { checkId: check.checkId, kind: check.kind, status: check.status, actor: check.actor, checkedAt: check.checkedAt, note: note.text, noteTruncated: note.truncated };
        }),
      })),
      evidenceTypes: [...evidenceTypes].sort(),
    },
    statistics: statistics
      ? {
        present: true,
        window: { from: statistics.window.from, to: statistics.window.to },
        coverage: statistics.coverage,
        limitations: [...statistics.limitations],
        limitationCounts: { ...statistics.limitationCounts },
        claims: { savings: null, superiority: null },
      }
      : { present: false },
    limitations,
    redactions: { count: 0, fields: [] },
  };

  const redacted = redactSecrets(document);
  const redactedDocument = redacted.value as DeliveryExportDocument;
  const finalDocument: DeliveryExportDocument = { ...redactedDocument, redactions: { count: redacted.fields.length, fields: redacted.fields } };
  const unlisted = findUnlistedExportKey(redacted.value);
  if (unlisted) return { ok: false, code: "export_not_whitelisted", message: `The export builder produced a field outside its whitelist: ${unlisted}.` };
  const bytes = Buffer.from(`${JSON.stringify(finalDocument, null, 2)}\n`, "utf8");
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? DELIVERY_EXPORT_LIMITS.bytes, DELIVERY_EXPORT_LIMITS.bytes));
  if (bytes.byteLength > maxBytes) return { ok: false, code: "export_too_large", message: `The export is ${bytes.byteLength} bytes; the limit is ${maxBytes}.` };
  // The digest identifies the exported facts, not the moment of the preview: `exportedAt` is blanked so a
  // preview digest still matches when the user confirms a minute later. Any change to the task, contract,
  // evidence or statistics changes the digest and is refused by `saveDeliveryExport`.
  const digest = createHash("sha256").update(JSON.stringify({ ...finalDocument, exportedAt: "" })).digest("hex");
  return { ok: true, document: finalDocument, bytes, digest };
}

export interface ExportTarget { file: string; directory: string; fileName: string }

export type ExportTargetResult = { ok: true; target: ExportTarget } | { ok: false; code: "invalid_directory" | "invalid_task_id" | "export_target_exists" | "export_target_unwritable"; message: string };

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeFilePart(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

/**
 * Resolve a user-chosen directory into a concrete, non-overwriting target.
 * Symbolic links, relative paths and traversal segments are refused: the bytes
 * land in the folder the user actually picked.
 */
export function resolveExportTarget(directory: unknown, taskId: string, now: Date = new Date()): ExportTargetResult {
  if (typeof taskId !== "string" || !TASK_ID.test(taskId)) return { ok: false, code: "invalid_task_id", message: "The task id is not a saved task identity." };
  if (typeof directory !== "string" || !directory.trim()) return { ok: false, code: "invalid_directory", message: "Choose an existing folder for the export." };
  if (directory.includes("\u0000") || /[\u0000-\u001f]/.test(directory)) return { ok: false, code: "invalid_directory", message: "The chosen folder contains control characters." };
  if (!path.isAbsolute(directory)) return { ok: false, code: "invalid_directory", message: "The chosen folder must be an absolute path." };
  if (directory.split(/[\\/]+/).includes("..")) return { ok: false, code: "invalid_directory", message: "The chosen folder must not contain traversal segments." };
  let real: string;
  try {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink()) return { ok: false, code: "invalid_directory", message: "Choose the real folder, not a symbolic link." };
    if (!stat.isDirectory()) return { ok: false, code: "invalid_directory", message: "The chosen path is not a directory." };
    real = fs.realpathSync.native(directory);
  }
  catch { return { ok: false, code: "invalid_directory", message: "The chosen folder does not exist or cannot be read." }; }
  const base = `delivery-${safeFilePart(taskId)}-${stamp(now)}`;
  for (let index = 0; index < DELIVERY_EXPORT_LIMITS.fileAttempts; index++) {
    const fileName = `${base}${index === 0 ? "" : `-${index}`}.json`;
    const file = path.join(real, fileName);
    if (path.dirname(file) !== real) return { ok: false, code: "invalid_directory", message: "The resolved target escaped the chosen folder." };
    if (!fs.existsSync(file)) return { ok: true, target: { file, directory: real, fileName } };
  }
  return { ok: false, code: "export_target_exists", message: `No free file name after ${DELIVERY_EXPORT_LIMITS.fileAttempts} attempts; choose another folder.` };
}

export type ExportSaveResult =
  | { ok: true; file: string; bytes: number; digest: string }
  | { ok: false; code: string; message: string };

/**
 * Save a previously previewed export. The bytes are regenerated here and
 * compared with the preview digest; the UI never supplies document bytes.
 */
export function saveDeliveryExport(
  store: DeliveryExportStore,
  input: { taskId: string; directory: string; expectedDigest?: string; statistics?: ExportStatistics | null },
  options: { now?: Date; maxBytes?: number } = {},
): ExportSaveResult {
  const built = buildDeliveryExport(store, input.taskId, { now: options.now, statistics: input.statistics ?? null, ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) });
  if (!built.ok) return { ok: false, code: built.code, message: built.message };
  if (input.expectedDigest !== undefined && input.expectedDigest !== built.digest) {
    return { ok: false, code: "export_stale", message: "The task changed since the preview; review the new export before saving." };
  }
  const resolved = resolveExportTarget(input.directory, input.taskId, options.now ?? new Date());
  if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
  try {
    // wx: never overwrite a file that appeared after the target was resolved.
    fs.writeFileSync(resolved.target.file, built.bytes, { flag: "wx", mode: 0o600 });
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, code: code === "EEXIST" ? "export_target_exists" : "export_target_unwritable", message: code === "EEXIST" ? "The target file appeared while saving; nothing was overwritten." : "The export could not be written to the chosen folder." };
  }
  return { ok: true, file: resolved.target.file, bytes: built.bytes.byteLength, digest: built.digest };
}
