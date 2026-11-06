/**
 * Desktop command tests for L06.
 *
 * The HTTP adapter is read-only, so these commands are the only way a template
 * or an export is written. The tests pin the boundary: unknown fields are
 * refused, a template save never carries an old identity, a notification switch
 * cannot invent a reason, and an export is written only into an absolute folder
 * after a preview digest matches.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProductivityCommand } from "../src/desktop-productivity.js";
import { openProductivityRuntime, PRODUCTIVITY_FILES } from "../src/productivity-runtime.js";
import type { DeliveryExportStore } from "../src/delivery-export.js";
import type { StoredTask } from "../src/task-store.js";

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "l06-commands-"));
}

const CREATED_AT = "2026-11-05T08:00:00.000Z";

function fakeStore(): DeliveryExportStore & { tasks: Map<string, StoredTask> } {
  const tasks = new Map<string, StoredTask>();
  tasks.set("task-1", {
    taskId: "task-1",
    messageId: "message-1",
    objective: "在既定范围内完成前端小修。",
    state: "completed",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    attemptId: "attempt-1",
    report: { status: "completed", filesChanged: ["src/a.ts"], commandsRun: ["npm test"], rawText: "done" },
    evidence: [],
  });
  return {
    tasks,
    get: taskId => tasks.get(taskId),
    listAttempts: () => [],
    listTasksByCreatedCursor: () => ({ tasks: [...tasks.values()], anchorFound: true }),
    listTaskEvents: () => ({ events: [], nextEventId: 0 }),
    getContract: () => ({ state: "absent" }),
    reviews: { list: () => [] },
  };
}

function templateBody(name = "前端小修") {
  return {
    schemaVersion: "workbuddy-executor/project-template-2",
    kind: "manual",
    name,
    description: "只改样式的小修模板",
    project: {
      titleTemplate: "前端小修：{{范围}}",
      objectiveTemplate: "在既定范围内完成前端小修，并运行检查。",
      scope: { allowedChanges: ["src/ui/**"], permittedMetadata: [] },
      requiredChecks: [{ id: "build", kind: "command", definition: "npm run build" }],
      timeoutSeconds: 1800,
      maxAttempts: 2,
    },
    selectionSuggestion: null,
    policySuggestion: null,
  };
}

function runtime() {
  const configDir = temporaryDirectory();
  const store = fakeStore();
  return { configDir, store, ...openProductivityRuntime({ configDir, store }) };
}

test("desktop productivity: non-productivity methods are left to the older channel", () => {
  const { commands } = runtime();
  const outcome = runProductivityCommand(commands, "catalog", {});
  assert.equal(outcome.handled, false);
  assert.equal(outcome.failure, undefined);
});

test("desktop productivity: saving a template writes the config file and bumps a named version", () => {
  const { commands, configDir } = runtime();
  const created = runProductivityCommand(commands, "productivity_template_save", { template: templateBody() });
  assert.equal(created.failure, undefined);
  const createdValue = created.value as { template: { templateId: string; templateVersion: number; contentHash: string } };
  assert.match(createdValue.template.templateId, /^tmpl-/);
  assert.equal(createdValue.template.templateVersion, 1);
  assert.ok(fs.existsSync(path.join(configDir, PRODUCTIVITY_FILES.templates)), "the template file is created on demand");

  const updated = runProductivityCommand(commands, "productivity_template_save", {
    template: templateBody("前端小修（收紧）"),
    templateId: createdValue.template.templateId,
  });
  assert.equal(updated.failure, undefined);
  assert.equal((updated.value as { template: { templateVersion: number } }).template.templateVersion, 2);

  const unknownIdentity = runProductivityCommand(commands, "productivity_template_save", {
    template: templateBody(),
    templateId: "tmpl-00000000",
  });
  assert.equal(unknownIdentity.failure?.code, "template_not_found");
});

test("desktop productivity: template commands refuse unknown fields and unsupported identity shapes", () => {
  const { commands } = runtime();
  const extraField = runProductivityCommand(commands, "productivity_template_save", { template: templateBody(), note: "extra" });
  assert.equal(extraField.failure?.code, "INVALID_REQUEST");
  const badName = runProductivityCommand(commands, "productivity_template_save", { template: { ...templateBody(), name: "" } });
  assert.equal(badName.failure?.code, "invalid_value");
  const policyActivation = runProductivityCommand(commands, "productivity_template_save", { template: { ...templateBody(), activation: "enabled" } });
  assert.equal(policyActivation.failure?.code, "invalid_value");
  const badArchive = runProductivityCommand(commands, "productivity_template_archive", { templateId: "../../etc" });
  assert.equal(badArchive.failure?.code, "INVALID_REQUEST");
  const missing = runProductivityCommand(commands, "productivity_template_archive", { templateId: "tmpl-00000000" });
  assert.equal(missing.failure?.code, "template_not_found");
});

test("desktop productivity: archiving hides the template from the default catalog", () => {
  const { commands } = runtime();
  const created = runProductivityCommand(commands, "productivity_template_save", { template: templateBody() });
  const templateId = (created.value as { template: { templateId: string } }).template.templateId;
  const archived = runProductivityCommand(commands, "productivity_template_archive", { templateId });
  assert.equal(archived.failure, undefined);
  const catalog = runProductivityCommand(commands, "productivity_catalog", {});
  assert.equal((catalog.value as { count: number }).count, 0);
  const withArchived = runProductivityCommand(commands, "productivity_catalog", { includeArchived: true });
  assert.equal((withArchived.value as { count: number }).count, 1);
});

test("desktop productivity: a notification switch accepts only the documented fields and never activates a reason", () => {
  const { commands, configDir } = runtime();
  const disabled = runProductivityCommand(commands, "productivity_notification_config", {
    config: { enabled: false, reasons: { needs_review: false } },
  });
  assert.equal(disabled.failure, undefined);
  const config = (disabled.value as { config: { enabled: boolean; reasons: Record<string, boolean> } }).config;
  assert.equal(config.enabled, false);
  assert.equal(config.reasons.needs_review, false);
  assert.ok(fs.existsSync(path.join(configDir, PRODUCTIVITY_FILES.notificationConfig)));

  for (const patch of [
    { config: { enabled: true, mystery: 1 } },
    { config: { reasons: { invented_reason: true } } },
    { config: { minIntervalMs: -1 } },
    { config: { minIntervalMs: 1.5 } },
    { config: { minIntervalMs: 7_200_000 } },
  ]) {
    const rejected = runProductivityCommand(commands, "productivity_notification_config", patch);
    assert.ok(rejected.failure, `expected a refusal for ${JSON.stringify(patch)}`);
  }
  // A refusal leaves the stored file alone.
  const reread = runProductivityCommand(commands, "productivity_notification_config", { config: { enabled: true } });
  assert.equal((reread.value as { config: { enabled: boolean } }).config.enabled, true);
});

test("desktop productivity: export save requires a preview digest and an absolute folder", () => {
  const { commands } = runtime();
  const missingDigest = runProductivityCommand(commands, "productivity_export_save", { taskId: "task-1", directory: temporaryDirectory() });
  assert.equal(missingDigest.failure?.code, "INVALID_REQUEST");

  const preview = runProductivityCommand(commands, "productivity_export_preview", { taskId: "task-1" });
  assert.equal(preview.failure, undefined);
  const digest = (preview.value as { digest: string }).digest;
  assert.match(digest, /^[a-f0-9]{64}$/);

  const relative = runProductivityCommand(commands, "productivity_export_save", { taskId: "task-1", directory: "outputs", digest });
  assert.equal(relative.failure?.code, "invalid_directory");

  const directory = temporaryDirectory();
  const saved = runProductivityCommand(commands, "productivity_export_save", { taskId: "task-1", directory, digest });
  assert.equal(saved.failure, undefined, JSON.stringify(saved.failure));
  const file = (saved.value as { file: string }).file;
  assert.equal(path.dirname(file), fs.realpathSync.native(directory));
  const document = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(document.schemaVersion, "workbuddy-executor/delivery-export-1");
  assert.equal(document.task.taskId, "task-1");

  // The same digest cannot be replayed onto a changed task.
  const stale = runProductivityCommand(commands, "productivity_export_save", { taskId: "task-1", directory, digest: "0".repeat(64) });
  assert.equal(stale.failure?.code, "export_stale");
  assert.equal(fs.readdirSync(directory).length, 1);
});

test("desktop productivity: an unknown action is refused rather than forwarded", () => {
  const { commands } = runtime();
  const outcome = runProductivityCommand(commands, "productivity_invented", {});
  assert.equal(outcome.handled, true);
  assert.equal(outcome.failure?.code, "UNKNOWN_ACTION");
});
