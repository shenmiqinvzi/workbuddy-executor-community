/**
 * B04 acceptance tests: the export is previewed, saved and cancelled through
 * the real product command over a real task store.
 *
 * The unit tests beside `delivery-export.ts` use an in-memory store. These
 * tests open a real tasks.sqlite, write a real persisted contract and real
 * events, then drive `runProductivityCommand` exactly as the desktop channel
 * does. They assert the three facts the acceptance note asks for: the bytes on
 * disk are the bytes whose digest was previewed, the redaction count matches
 * the reported fields, and the whitelist and size limits still hold.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DELIVERY_EXPORT_LIMITS,
  DELIVERY_EXPORT_SCHEMA,
  EXPORT_KEY_WHITELIST,
  type DeliveryExportDocument,
} from "../src/delivery-export.js";
import { runProductivityCommand } from "../src/desktop-productivity.js";
import { NotificationCenter } from "../src/notification-center.js";
import { ProjectTemplateStore } from "../src/project-template.js";
import type { ProductivitySources } from "../src/productivity-service.js";
import { TASK_CONTRACT_SCHEMA_VERSION, type TaskContractPolicy } from "../src/task-contract.js";
import { TaskStore } from "../src/task-store.js";

const TASK_ID = "export-task-1";
const POLICY: TaskContractPolicy = { maxAttempts: 3 };
const SECRET = "sk-live-abc1234567890";

function submission(): Record<string, unknown> {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: TASK_ID,
    workspaceId: "export-project",
    title: `导出样本 Authorization: Bearer ${SECRET}`,
    objective: "Verify the delivered export path end to end",
    model: "deepseek-v4.1-flash",
    timeoutSeconds: 1800,
    maxAttempts: 3,
    scope: { allowedChanges: ["src/Discount.java"], permittedMetadata: [] },
    requiredChecks: [{ id: "discount-contract", kind: "command", definition: "运行折扣测试" }],
  };
}

interface Harness {
  directory: string;
  exportDirectory: string;
  store: TaskStore;
  sources: ProductivitySources;
}

function harness(t: { after(callback: () => void): void }): Harness {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-export-"));
  const exportDirectory = path.join(directory, "exports");
  fs.mkdirSync(exportDirectory);
  const store = new TaskStore(path.join(directory, "tasks.sqlite"));
  const sources: ProductivitySources = {
    templates: new ProjectTemplateStore({ file: path.join(directory, "templates.json") }),
    notifications: new NotificationCenter({
      store,
      configFile: path.join(directory, "notifications.json"),
      ledgerFile: path.join(directory, "notification-ledger.json"),
      deliver: () => {},
    }),
    exportStore: store,
    statistics: () => ({
      window: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-07T00:00:00.000Z" },
      coverage: {
        tasksRead: 1, tasksIncluded: 1, tasksExcludedOutsideWindow: 0,
        tasksWithoutEvents: 0, tasksIncomplete: 0, eventsRead: 2,
        tasksTruncated: false, eventsTruncated: false,
      },
      limitations: ["统计只覆盖本机已归档的任务。"],
      limitationCounts: { local_only: 1 },
    }),
  };
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, exportDirectory, store, sources };
}

function seed(store: TaskStore): void {
  const created = store.createTaskWithContract({
    taskId: TASK_ID,
    messageId: "msg-1",
    workspace: "E:/fixture",
    state: "needs_review",
  }, submission(), POLICY);
  assert.equal(created.status, "created");
  const task = store.get(TASK_ID)!;
  store.appendTaskEvent({ taskId: TASK_ID, attemptId: task.attemptId ?? null, type: "task_received", occurredAt: task.updatedAt, observedAt: task.updatedAt, actor: "codex", payload: {}, sourceRef: null });
  store.appendTaskEvent({ taskId: TASK_ID, attemptId: task.attemptId ?? null, type: "input_requested", occurredAt: task.updatedAt, observedAt: task.updatedAt, actor: "workbuddy", payload: { prompt: "Continue?" }, sourceRef: null });
}

function command(sources: ProductivitySources, method: string, parameters: Record<string, unknown>): any {
  const outcome = runProductivityCommand(sources, method, parameters);
  assert.equal(outcome.handled, true, `${method} must be handled by the productivity command`);
  return outcome;
}

function readDocument(file: string): DeliveryExportDocument {
  return JSON.parse(fs.readFileSync(file, "utf8")) as DeliveryExportDocument;
}

test("export: the saved file is the previewed content, byte for byte", (t) => {
  const h = harness(t);
  seed(h.store);

  const preview = command(h.sources, "productivity_export_preview", { taskId: TASK_ID });
  assert.equal(preview.failure, undefined);
  const view = preview.value;
  assert.equal(view.exportSchema, DELIVERY_EXPORT_SCHEMA);
  assert.equal(view.bytesLimit, DELIVERY_EXPORT_LIMITS.bytes);
  assert.ok(view.bytes > 0 && view.bytes <= DELIVERY_EXPORT_LIMITS.bytes);
  assert.match(view.digest, /^[a-f0-9]{64}$/);

  const saved = command(h.sources, "productivity_export_save", { taskId: TASK_ID, directory: h.exportDirectory, digest: view.digest });
  assert.equal(saved.failure, undefined, JSON.stringify(saved.failure));
  assert.equal(saved.value.digest, view.digest, "saving must reproduce the previewed digest");

  const file = saved.value.file as string;
  const raw = fs.readFileSync(file);
  assert.equal(raw.byteLength, saved.value.bytes, "reported bytes must be the bytes on disk");
  assert.equal(raw.byteLength, view.bytes, "the file is the size the preview announced");

  const document = readDocument(file);
  // The digest covers the exported facts, not the moment of export.
  const recomputed = createHash("sha256").update(JSON.stringify({ ...document, exportedAt: "" })).digest("hex");
  assert.equal(recomputed, view.digest);
  assert.equal(recomputed, saved.value.digest);

  // Only whitelisted fields travel.
  for (const key of Object.keys(document)) assert.ok(EXPORT_KEY_WHITELIST.has(key), `${key} is not whitelisted`);
  assert.equal(document.schemaVersion, DELIVERY_EXPORT_SCHEMA);
  assert.equal(document.generator.readOnly, true);
  assert.equal(document.task.taskId, TASK_ID);
  assert.equal(document.task.events, 3, "the event count is the stream, not a page cursor");
  assert.equal(document.contract.present, true);

  // The redaction count is the count of reported field paths, in both places.
  assert.equal(document.redactions.count, document.redactions.fields.length);
  assert.equal(view.redactionCount, document.redactions.count);
  assert.ok(document.redactions.count >= 1);
  assert.ok(document.redactions.fields.some(field => field.endsWith("title")), document.redactions.fields.join(","));
  assert.equal(raw.includes(SECRET), false, "the credential must not reach the file");

  // Statistics travel with their own limitations and never a quality claim.
  assert.equal(document.statistics.present, true);
  if (document.statistics.present) {
    assert.equal(document.statistics.claims.savings, null);
    assert.equal(document.statistics.claims.superiority, null);
  }
});

test("export: saving the same task twice keeps both files under distinct names", (t) => {
  const h = harness(t);
  seed(h.store);
  const preview = command(h.sources, "productivity_export_preview", { taskId: TASK_ID }).value;
  const first = command(h.sources, "productivity_export_save", { taskId: TASK_ID, directory: h.exportDirectory, digest: preview.digest });
  const second = command(h.sources, "productivity_export_save", { taskId: TASK_ID, directory: h.exportDirectory, digest: preview.digest });
  assert.equal(first.failure, undefined);
  assert.equal(second.failure, undefined);
  assert.notEqual(first.value.file, second.value.file);
  assert.equal(fs.existsSync(first.value.file), true);
  assert.equal(fs.existsSync(second.value.file), true);
  assert.equal(fs.readdirSync(h.exportDirectory).length, 2);
});

test("export: a changed task cancels the save and leaves the folder untouched", (t) => {
  const h = harness(t);
  seed(h.store);
  const preview = command(h.sources, "productivity_export_preview", { taskId: TASK_ID }).value;

  // The task moves on between preview and save.
  h.store.update(TASK_ID, { reviewNote: "reviewed later by a person" });

  const cancelled = command(h.sources, "productivity_export_save", { taskId: TASK_ID, directory: h.exportDirectory, digest: preview.digest });
  assert.equal(cancelled.value, undefined);
  assert.equal(cancelled.failure?.code, "export_stale");
  assert.equal(fs.readdirSync(h.exportDirectory).length, 0);

  // A fresh preview of the changed task can be saved.
  const again = command(h.sources, "productivity_export_preview", { taskId: TASK_ID }).value;
  assert.notEqual(again.digest, preview.digest);
  const saved = command(h.sources, "productivity_export_save", { taskId: TASK_ID, directory: h.exportDirectory, digest: again.digest });
  assert.equal(saved.failure, undefined);
  assert.equal(fs.readdirSync(h.exportDirectory).length, 1);
});

test("export: an unwritable target and an unknown task are refused before any file exists", (t) => {
  const h = harness(t);
  seed(h.store);
  const preview = command(h.sources, "productivity_export_preview", { taskId: TASK_ID }).value;

  const outside = command(h.sources, "productivity_export_save", { taskId: TASK_ID, directory: path.join(h.directory, "missing"), digest: preview.digest });
  assert.equal(outside.failure?.code, "invalid_directory");

  const unknown = command(h.sources, "productivity_export_preview", { taskId: "no-such-task" });
  assert.equal(unknown.failure?.code, "task_not_found");

  const noDigest = command(h.sources, "productivity_export_save", { taskId: TASK_ID, directory: h.exportDirectory });
  assert.equal(noDigest.failure?.code, "INVALID_REQUEST");
  assert.equal(fs.readdirSync(h.exportDirectory).length, 0);
});
