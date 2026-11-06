/**
 * L06 acceptance tests: the read-only productivity views.
 *
 * These exercise the transport-agnostic handler the HTTP adapter will call.
 * Everything is local: a temporary template store, a fake task store behind the
 * notification center, and a fake export store. The handler must stay read-only
 * — above all, reading the notification snapshot may not move a watermark or
 * mark an episode delivered.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NotificationCenter } from "../src/notification-center.js";
import {
  PRODUCTIVITY_NOTIFICATIONS_PATH,
  PRODUCTIVITY_SCHEMA,
  PRODUCTIVITY_TEMPLATES_PATH,
  handleProductivityRequest,
  previewDeliveryExport,
  readNotificationSnapshot,
  readTemplateCatalog,
  readTemplateDetail,
  type ProductivitySources,
} from "../src/productivity-service.js";
import { ProjectTemplateStore } from "../src/project-template.js";
import type { DeliveryExportStore } from "../src/delivery-export.js";
import type { NotificationStore } from "../src/notification-center.js";
import type { StoredTask, StoredTaskEvent, TaskContractRead } from "../src/task-store.js";

const NOW = new Date("2026-11-05T12:00:00.000Z");

function tempDir(t: { after(callback: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l06-productivity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return dir;
}

function templateInput(name = "前端小修"): Record<string, unknown> {
  return {
    name,
    description: "合成模板",
    kind: "manual",
    project: {
      titleTemplate: "修一处前端文案",
      objectiveTemplate: "把示例页面的标题改成分成两行。",
      scope: { allowedChanges: ["src/app.ts"], permittedMetadata: ["package.json"] },
      requiredChecks: [{ id: "typecheck", kind: "command", definition: "npm run typecheck" }],
      timeoutSeconds: 900,
      maxAttempts: 2,
    },
    selectionSuggestion: { executorId: "dsh", connectionId: "conn-1", providerId: "prov-1", modelId: "model-a", reasoningEffort: "medium" },
  };
}

class FakeTaskStore implements NotificationStore {
  constructor(readonly task: StoredTask, readonly events: StoredTaskEvent[]) {}
  get(taskId: string): StoredTask | undefined { return taskId === this.task.taskId ? this.task : undefined; }
  listTasksByCreatedCursor(): { tasks: StoredTask[]; anchorFound: boolean } { return { tasks: [this.task], anchorFound: true }; }
  listTaskEvents(): { events: StoredTaskEvent[]; nextEventId: number } { return { events: this.events, nextEventId: this.events.at(-1)?.eventId ?? 0 }; }
  getContract(): TaskContractRead { return { state: "absent" }; }
}

function exportStore(): DeliveryExportStore {
  const task: StoredTask = {
    taskId: "task-1", messageId: "msg-1", objective: "PRIVATE", state: "needs_review",
    createdAt: "2026-11-05T09:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z", revision: "rev-1",
  };
  return {
    get: id => (id === "task-1" ? task : undefined),
    getContract: () => ({ state: "absent" }),
    listAttempts: () => [{ attemptId: "attempt-1" }],
    listTaskEvents: () => ({ events: [], nextEventId: 3 }),
    reviews: { list: () => [] },
  };
}

function sources(t: { after(callback: () => void): void }): ProductivitySources {
  const dir = tempDir(t);
  const templates = new ProjectTemplateStore({ file: path.join(dir, "templates.json"), now: () => NOW });
  const saved = templates.save(templateInput());
  assert.equal(saved.ok, true, "the fixture template saves");
  const task: StoredTask = {
    taskId: "task-1", messageId: "msg-1", objective: "PRIVATE", state: "needs_review",
    createdAt: "2026-11-05T09:00:00.000Z", updatedAt: "2026-11-05T10:00:00.000Z", revision: "rev-1",
  };
  const event: StoredTaskEvent = {
    taskId: "task-1", eventId: 1, attemptId: null, type: "task_state_changed",
    occurredAt: "2026-11-05T10:00:00.000Z", observedAt: "2026-11-05T10:00:00.000Z",
    actor: "workbuddy", payload: { patch: { state: "needs_review" } }, sourceRef: "event-1",
  };
  const notifications = new NotificationCenter({
    store: new FakeTaskStore(task, [event]),
    configFile: path.join(dir, "notifications.json"),
    ledgerFile: path.join(dir, "notification-ledger.json"),
    now: () => NOW,
  });
  return { templates, notifications, exportStore: exportStore() };
}

test("productivity: the template catalog is read-only and marks policy activation unsupported", (t) => {
  const view = sources(t);
  const catalog = readTemplateCatalog(view);
  assert.equal(catalog.schemaVersion, PRODUCTIVITY_SCHEMA);
  assert.equal(catalog.readOnly, true);
  assert.equal(catalog.source, PRODUCTIVITY_TEMPLATES_PATH);
  assert.equal(catalog.count, 1);
  assert.equal(catalog.templates[0]?.kind, "manual");
  assert.equal(catalog.activation.supported, false);
  assert.match(catalog.activation.note, /unsupported|未交付/);
  assert.deepEqual(catalog.issues, []);

  const first = view.templates.list()[0]!;
  assert.equal(view.templates.archive(first.templateId).ok, true);
  assert.equal(readTemplateCatalog(view).count, 0, "archived templates are hidden by default");
  assert.equal(readTemplateCatalog(view, { includeArchived: true }).count, 1);
});

test("productivity: template detail lists versions and names a bad or missing identity", (t) => {
  const view = sources(t);
  const templateId = view.templates.list()[0]!.templateId;
  assert.equal(view.templates.save({ ...templateInput("前端小修（第二版）"), templateId }).ok, true);

  const detail = readTemplateDetail(view, templateId);
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  assert.equal(detail.templateId, templateId);
  assert.equal(detail.versions.length, 2);
  assert.equal(detail.latest.templateVersion, 2);
  assert.equal(detail.archived, false);

  const invalid = readTemplateDetail(view, "not-a-template-id");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.code, "invalid_template_id");
  const missing = readTemplateDetail(view, "tmpl-00000000");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "template_not_found");
});

test("productivity: the notification snapshot lists pending episodes without consuming them", (t) => {
  const view = sources(t);
  const before = readNotificationSnapshot(view);
  assert.equal(before.config.enabled, true);
  assert.equal(before.pending.length, 1);
  assert.equal(before.pending[0]?.reason, "needs_review");
  assert.equal(before.delivery.mode, "desktop_native");
  assert.equal(before.delivery.delivered, null);

  const again = readNotificationSnapshot(view);
  assert.equal(again.pending.length, 1, "a read does not mark the episode delivered");
  assert.equal(again.pending[0]?.episodeKey, before.pending[0]?.episodeKey, "the same episode keeps its identity");

  const delivered: string[] = [];
  const center = view.notifications;
  const polled = center.poll();
  assert.equal(polled.delivered.length, 1, "only an explicit poll delivers");
  assert.equal(readNotificationSnapshot(view).pending.length, 0);
  assert.deepEqual(delivered, []);
});

test("productivity: the export preview reports digest, size, whitelist and never writes a file", (t) => {
  const view = sources(t);
  const result = previewDeliveryExport(view, "task-1", NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const preview = result.preview;
  assert.equal(preview.taskId, "task-1");
  assert.equal(preview.digest.length, 64);
  assert.ok(preview.bytes > 0);
  assert.equal(preview.bytesLimit, 4 * 1024 * 1024);
  assert.equal(preview.target, "user_chosen_directory");
  assert.equal(preview.whitelist.includes("task"), true);
  assert.equal(preview.whitelist.includes("password"), false);
  assert.deepEqual(preview.presentFields, [...preview.presentFields].sort());
  assert.equal(preview.counts.events, 3);
  assert.equal(preview.counts.attempts, 1);
  assert.ok(preview.limitations.length >= 3);

  const missing = previewDeliveryExport(view, "task-missing", NOW);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "task_not_found");
});

test("productivity: routes answer 200, 400 and 404 with the shared error shape", (t) => {
  const view = sources(t);

  const catalog = handleProductivityRequest(view, PRODUCTIVITY_TEMPLATES_PATH, "");
  assert.equal(catalog?.status, 200);

  const badFlag = handleProductivityRequest(view, PRODUCTIVITY_TEMPLATES_PATH, "?includeArchived=yes");
  assert.equal(badFlag?.status, 400);
  const badBody = badFlag?.body as { error: { code: string; retryable: boolean }; view: null };
  assert.equal(badBody.error.code, "INVALID_QUERY", "error codes are upper-case like the rest of the adapter");
  assert.equal(badBody.error.retryable, false);
  assert.equal(badBody.view, null);

  const unknownDetail = handleProductivityRequest(view, `${PRODUCTIVITY_TEMPLATES_PATH}/tmpl-00000000`, "");
  assert.equal(unknownDetail?.status, 404);

  const extraQuery = handleProductivityRequest(view, PRODUCTIVITY_NOTIFICATIONS_PATH, "?limit=5");
  assert.equal(extraQuery?.status, 400);

  assert.equal(handleProductivityRequest(view, "/workbench/v1/statistics", ""), null, "other routes stay with their owner");
});
