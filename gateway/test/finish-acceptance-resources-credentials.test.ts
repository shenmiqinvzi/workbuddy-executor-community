/**
 * L08 acceptance line — export whitelist, credential boundary, template identity
 * and statistics/resource degradation.
 *
 * These cases exercise the real modules with synthetic documents. A missing
 * resource read must leave an explicit "unavailable" mark, never a zero; a
 * template must never carry an attempt, a plan or an authorization.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DELIVERY_EXPORT_LIMITS,
  EXPORT_KEY_WHITELIST,
  buildDeliveryExport,
  findUnlistedExportKey,
  redactSecrets,
  resolveExportTarget,
  type DeliveryExportStore,
} from "../src/delivery-export.js";
import {
  findCarriedIdentity,
  instantiateTemplate,
  upgradeLegacyTemplate,
  type ProjectTemplate,
} from "../src/project-template.js";

const SECRETISH = /(secret|token|passwd|password|credential|cookie|authorization|api[-_]?key|private[-_]?key|access[-_]?key|session[-_]?key)/i;

function legacyTemplate(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "workbuddy-executor/project-template-1",
    id: "tmpl-l08-legacy-0001",
    name: "L08 合成旧模板",
    description: "synthetic",
    scopePaths: ["lib/**"],
    checks: [{ id: "behavior", kind: "semantic", definition: "Synthetic review question" }],
    timeoutSeconds: 900,
    maxAttempts: 2,
    model: "deepseek-v4.1-flash",
    workspacePath: "E:\\synthetic\\secret-workspace",
    ...overrides,
  };
}

function upgraded(overrides: Record<string, unknown> = {}): ProjectTemplate {
  const result = upgradeLegacyTemplate(legacyTemplate(overrides), { now: new Date("2026-11-06T00:00:00.000Z") });
  assert.equal(result.ok, true, `legacy upgrade failed: ${JSON.stringify(result)}`);
  return (result as { ok: true; template: ProjectTemplate }).template;
}

test("L08 the export whitelist refuses every key it does not own", () => {
  assert.equal(findUnlistedExportKey({ schemaVersion: "x", task: { taskId: "t" }, attempts: [{ attemptId: "a" }] }), null);
  assert.equal(findUnlistedExportKey({ schemaVersion: "x", token: "abc" }), "token");
  assert.equal(findUnlistedExportKey({ task: { attempts: [{ sessionKey: "abc" }] } }), "sessionKey");
  assert.equal(findUnlistedExportKey({ limitations: ["ok"], limitationCounts: { "any.code": 1 } }), null, "bounded limitation codes stay allowed");
  const leaked = [...EXPORT_KEY_WHITELIST].filter(key => SECRETISH.test(key));
  assert.deepEqual(leaked, [], "the whitelist itself must never admit a credential-shaped field");
});

test("L08 credentials are removed by key and by value at any depth", () => {
  const redacted = redactSecrets({
    task: { objective: "keep me", nested: { authorization: "Bearer abcdef", note: "password: hunter2" } },
    events: [{ eventId: 1, apiKey: "sk-live-123" }, { eventId: 2, text: "token=abcdef" }],
  });
  const text = JSON.stringify(redacted.value);
  assert.equal(text.includes("Bearer abcdef"), false);
  assert.equal(text.includes("hunter2"), false);
  assert.equal(text.includes("sk-live-123"), false);
  assert.equal(text.includes("token=abcdef"), false);
  assert.ok(text.includes("keep me"), "ordinary text survives redaction");
  assert.deepEqual(redacted.fields.sort(), ["events[0].apiKey", "events[1].text", "task.nested.authorization", "task.nested.note"]);
});

test("L08 an export target cannot escape its folder or invent a task identity", () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "l08-export-")));
  assert.deepEqual(resolveExportTarget(root, "../evil"), { ok: false, code: "invalid_task_id", message: "The task id is not a saved task identity." });
  assert.equal(resolveExportTarget(root, "task/../../evil").ok, false);
  assert.equal(resolveExportTarget("relative/folder", "task-1").ok, false);
  assert.equal(resolveExportTarget(`${root}\\..\\escape`, "task-1").ok, false);
  assert.equal(resolveExportTarget(path.join(root, "missing"), "task-1").ok, false);
  assert.equal(resolveExportTarget(root, "task-1\u0000evil").ok, false);

  const target = resolveExportTarget(root, "task-1", new Date("2026-11-06T01:02:03.000Z"));
  assert.equal(target.ok, true);
  if (!target.ok) return;
  assert.equal(path.dirname(target.target.file), root, "the resolved file stays in the chosen folder");
  assert.equal(target.target.file.includes(".."), false);
  assert.match(target.target.fileName, /^delivery-task-1-\d{8}T\d{6}Z\.json$/);
});

test("L08 a failed resource read leaves the export explicit, never zero", () => {
  const taskId = "l08-export-task";
  const store: DeliveryExportStore = {
    get: id => id === taskId
      ? ({ taskId, state: "needs_review", createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z", report: null } as never)
      : undefined,
    getContract: () => ({ state: "absent" } as never),
    listAttempts: () => [],
    listTaskEvents: () => ({ events: [], nextEventId: 0 }),
    reviews: { list: () => [] },
  };
  const withoutStatistics = buildDeliveryExport(store, taskId, { now: new Date("2026-11-06T00:00:00.000Z"), statistics: null });
  assert.equal(withoutStatistics.ok, true);
  if (!withoutStatistics.ok) return;
  assert.deepEqual(withoutStatistics.document.statistics, { present: false });
  assert.ok(withoutStatistics.document.limitations.some(line => line.includes("不把缺失当作零")));
  assert.equal(withoutStatistics.document.task.events, 0);
  assert.ok(withoutStatistics.bytes.byteLength <= DELIVERY_EXPORT_LIMITS.bytes);
  assert.match(withoutStatistics.digest, /^[a-f0-9]{64}$/);

  const unreadable: DeliveryExportStore = { ...store, listTaskEvents: () => { throw new Error("synthetic resource read failure"); } };
  const degraded = buildDeliveryExport(unreadable, taskId, { statistics: null });
  assert.equal(degraded.ok, true, "a failing event stream must not abort the whole export");
  if (!degraded.ok) return;
  assert.ok(degraded.document.limitations.some(line => line.includes("事件流当前不可读取")));
  assert.equal(degraded.document.task.events, 0);
});

test("L08 a legacy template loses its machine identity instead of carrying it forward", () => {
  const template = upgraded();
  assert.equal(template.selectionSuggestion, null, "a legacy model name is not promoted into an execution selection");
  const serialized = JSON.stringify(template);
  assert.equal(serialized.includes("secret-workspace"), false, "the old workspace path is discarded");
  assert.equal(serialized.includes("deepseek-v4.1-flash"), false, "the bare model name is not re-used as an authorized selection");
  assert.equal(template.migration?.from, "workbuddy-executor/project-template-1");
  assert.ok((template.migration?.notes.length ?? 0) >= 2);

  const instance = instantiateTemplate(template, { workspaceId: "l08-workspace", taskId: "l08-task-fresh" });
  assert.equal(instance.ok, true);
  if (!instance.ok) return;
  assert.equal(instance.draft.authorization, null, "a template can never carry an authorization");
  assert.deepEqual(instance.draft.requires, ["plan_create", "user_confirmation"]);
  assert.equal(instance.draft.contract.model, "template-unselected", "an unselected model must stay explicit");
  assert.equal(findCarriedIdentity(instance.draft), null, "no attempt, plan or review identity may appear in a fresh draft");
  assert.equal(JSON.stringify(instance.draft).includes("l08-session"), false);
});

test("L08 a template cannot activate policy or resurrect an archived version", () => {
  const template = upgraded();
  const archived = instantiateTemplate({ ...template, archivedAt: "2026-11-05T00:00:00.000Z" }, { workspaceId: "l08-workspace" });
  assert.equal(archived.ok, false);
  if (!archived.ok) assert.equal(archived.rejection.code, "template_archived");

  const policy = instantiateTemplate({ ...template, kind: "policy-suggestion" }, { workspaceId: "l08-workspace" });
  assert.equal(policy.ok, false);
  if (!policy.ok) {
    assert.equal(policy.rejection.code, "policy_activation_unsupported");
    assert.deepEqual(policy.rejection.allowed, ["manual"]);
  }

  assert.equal(findCarriedIdentity({ execution: { attemptId: "run-x" } }), "attemptId");
  assert.equal(findCarriedIdentity({ nested: [{ planId: "plan-1" }] }), "planId");
  assert.equal(findCarriedIdentity({ contract: { scope: { allowedChanges: ["lib/**"] } } }), null);
});
