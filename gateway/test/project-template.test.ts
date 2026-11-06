/**
 * L06 acceptance tests: versioned project templates.
 *
 * These tests are synthetic evidence for D6-03 on the template half. They cover
 * the rules the acceptance line names explicitly:
 *   - a new schema record saves project preset, check definitions and an
 *     optional selection suggestion, and never activates a policy;
 *   - instantiation produces fresh identities, never copies a task/operation/
 *     attempt/plan/review id, stale evidence or an authorization, and never
 *     raises a budget above the server policy;
 *   - scope paths and check definitions still pass the real contract validator,
 *     so a template cannot smuggle `..` or a check conclusion;
 *   - an old-schema record upgrades with named losses instead of guesses, a
 *     deleted template is reported as missing, and a corrupt file is explained;
 *   - unknown enum values are refused with the allowed set attached.
 *
 * Everything here is local: no model, no socket, no task database.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LEGACY_PROJECT_TEMPLATE_SCHEMA,
  PROJECT_TEMPLATE_FILE_SCHEMA,
  PROJECT_TEMPLATE_SCHEMA,
  ProjectTemplateStore,
  findCarriedIdentity,
  instantiateTemplate,
  templateContentHash,
  upgradeLegacyTemplate,
  validateProjectTemplate,
  type ProjectTemplate,
} from "../src/project-template.js";

function tempDir(t: { after(callback: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l06-template-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return dir;
}

const FIXED_NOW = new Date("2026-11-05T12:00:00.000Z");

function templateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "前端小修",
    description: "一个合成模板",
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
    ...overrides,
  };
}

function saved(t: { after(callback: () => void): void }, dir: string, input: Record<string, unknown> = templateInput()): ProjectTemplate {
  const store = new ProjectTemplateStore({ file: path.join(dir, "templates.json"), now: () => FIXED_NOW });
  const result = store.save(input);
  assert.equal(result.ok, true, result.ok ? "" : `${result.rejection.code} ${result.rejection.field}`);
  if (!result.ok) throw new Error("unreachable");
  return result.template;
}

test("template: a manual template keeps its preset and never claims activation", () => {
  const validated = validateProjectTemplate(templateInput(), { now: FIXED_NOW });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const template = validated.template;
  assert.equal(template.schemaVersion, PROJECT_TEMPLATE_SCHEMA);
  assert.equal(template.templateVersion, 1);
  assert.equal(template.activation, "unsupported");
  assert.match(template.templateId, /^tmpl-[A-Za-z0-9-]{8,64}$/);
  assert.deepEqual(template.project.scope.allowedChanges, ["src/app.ts"]);
  assert.equal(template.project.requiredChecks[0]?.kind, "command");
  assert.equal(template.selectionSuggestion?.modelId, "model-a");
  assert.equal(template.policySuggestion, null);
});

test("template: unknown fields, unknown enums and an activated policy are refused", () => {
  const unknown = validateProjectTemplate(templateInput({ activation: "enabled" }), { now: FIXED_NOW });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) {
    assert.equal(unknown.rejection.code, "invalid_value");
    assert.equal(unknown.rejection.field, "activation");
  }

  const badKind = validateProjectTemplate(templateInput({ kind: "auto-apply" }), { now: FIXED_NOW });
  assert.equal(badKind.ok, false);
  if (!badKind.ok) {
    assert.equal(badKind.rejection.code, "unknown_enum");
    assert.ok(badKind.rejection.allowed?.includes("manual"));
  }

  const policyWithoutValues = validateProjectTemplate(templateInput({ kind: "policy-suggestion" }), { now: FIXED_NOW });
  assert.equal(policyWithoutValues.ok, false);
  if (!policyWithoutValues.ok) assert.equal(policyWithoutValues.rejection.field, "policySuggestion");

  const policyWithValues = validateProjectTemplate(templateInput({
    kind: "policy-suggestion",
    policySuggestion: { maxAttempts: 2, timeoutSeconds: 600, note: "合成建议" },
  }), { now: FIXED_NOW });
  assert.equal(policyWithValues.ok, true);
  if (policyWithValues.ok) {
    assert.equal(policyWithValues.template.policySuggestion?.maxAttempts, 2);
    assert.equal(policyWithValues.template.activation, "unsupported", "a saved suggestion is never an activated rule");
  }
});

test("template: scope paths and checks pass the real contract validator", () => {
  const traversal = validateProjectTemplate(templateInput({
    project: { ...(templateInput().project as Record<string, unknown>), scope: { allowedChanges: ["../etc/passwd"], permittedMetadata: [] } },
  }), { now: FIXED_NOW });
  assert.equal(traversal.ok, false);
  if (!traversal.ok) assert.match(traversal.rejection.field, /^project\.scope/);

  const conclusion = validateProjectTemplate(templateInput({
    project: {
      ...(templateInput().project as Record<string, unknown>),
      requiredChecks: [{ id: "c1", kind: "command", definition: "npm run typecheck", passed: true }],
    },
  }), { now: FIXED_NOW });
  assert.equal(conclusion.ok, false);
  if (!conclusion.ok) assert.equal(conclusion.rejection.code, "check_conclusion_not_allowed");

  const unknownCheckKind = validateProjectTemplate(templateInput({
    project: {
      ...(templateInput().project as Record<string, unknown>),
      requiredChecks: [{ id: "c1", kind: "manual-eyeball", definition: "看一下" }],
    },
  }), { now: FIXED_NOW });
  assert.equal(unknownCheckKind.ok, false);
  // The real contract validator owns this enum and answers `invalid_value`;
  // the template layer reuses that code instead of inventing a second opinion.
  if (!unknownCheckKind.ok) assert.equal(unknownCheckKind.rejection.code, "invalid_value");
});

test("template: instantiation makes fresh identities and carries no authorization", (t) => {
  const dir = tempDir(t);
  const template = saved(t, dir);
  const first = instantiateTemplate(template, { workspaceId: "ws-1", policyMaxAttempts: 3, now: FIXED_NOW });
  const second = instantiateTemplate(template, { workspaceId: "ws-1", policyMaxAttempts: 3, now: FIXED_NOW });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.notEqual(first.draft.draftId, second.draft.draftId);
  assert.notEqual(first.draft.contract.taskId, second.draft.contract.taskId, "each instantiation is a new task identity");
  assert.equal(first.draft.authorization, null);
  assert.deepEqual(first.draft.requires, ["plan_create", "user_confirmation"]);
  assert.equal(findCarriedIdentity(first.draft), null, "no attempt/plan/review/evidence identity leaks into a draft");
  assert.equal(first.draft.budget.applied, 2, "the template's own attempt budget is kept when policy allows it");
  assert.equal(first.draft.budget.clamped, false);
});

test("template: a template budget never raises the server policy, and policy templates cannot instantiate", (t) => {
  const dir = tempDir(t);
  const template = saved(t, dir);
  const clamped = instantiateTemplate(template, { workspaceId: "ws-1", policyMaxAttempts: 1, now: FIXED_NOW });
  assert.equal(clamped.ok, true);
  if (clamped.ok) {
    assert.equal(clamped.draft.budget.applied, 1);
    assert.equal(clamped.draft.budget.clamped, true);
    assert.ok(clamped.draft.notes.some(note => note.includes("策略上限")));
  }

  const store = new ProjectTemplateStore({ file: path.join(dir, "templates.json"), now: () => FIXED_NOW });
  const policy = store.save(templateInput({
    name: "政策建议",
    kind: "policy-suggestion",
    policySuggestion: { maxAttempts: 4, timeoutSeconds: 1200, note: "建议" },
  }));
  assert.equal(policy.ok, true);
  if (!policy.ok) return;
  const refused = instantiateTemplate(policy.template, { workspaceId: "ws-1", now: FIXED_NOW });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.rejection.code, "policy_activation_unsupported");

  const archivedStore = new ProjectTemplateStore({ file: path.join(dir, "templates.json"), now: () => FIXED_NOW });
  const archived = archivedStore.archive(policy.template.templateId);
  assert.equal(archived.ok, true);
  if (!archived.ok) return;
  const refusedArchived = instantiateTemplate(archived.template, { workspaceId: "ws-1", now: FIXED_NOW });
  assert.equal(refusedArchived.ok, false);
  if (!refusedArchived.ok) assert.equal(refusedArchived.rejection.code, "template_archived");
});

test("template: instantiation still validates the substituted title and objective", (t) => {
  const dir = tempDir(t);
  const template = saved(t, dir);
  const empty = instantiateTemplate(template, { workspaceId: "ws-1", title: "  ", now: FIXED_NOW });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.rejection.code, "invalid_value");

  const control = instantiateTemplate(template, { workspaceId: "ws-1", objective: "a\u0000b", now: FIXED_NOW });
  assert.equal(control.ok, false);
  if (!control.ok) assert.equal(control.rejection.code, "invalid_value");
});

test("template: saving the same identity writes a new version and keeps a bounded history", (t) => {
  const dir = tempDir(t);
  const store = new ProjectTemplateStore({ file: path.join(dir, "templates.json"), now: () => FIXED_NOW });
  const created = store.save(templateInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const second = store.save(templateInput({ templateId: created.template.templateId, name: "前端小修 v2" }));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.template.templateVersion, 2);
  assert.equal(second.created, false);

  const versions = store.versions(created.template.templateId);
  assert.deepEqual(versions.map(item => item.templateVersion), [2, 1]);
  assert.equal(store.list().length, 1, "the catalog lists the latest version only");
  assert.notEqual(templateContentHash(versions[0]!), templateContentHash(versions[1]!));

  const missing = store.save(templateInput({ templateId: "tmpl-00000000-0000-0000-0000-000000000000" }));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.rejection.code, "template_not_found");
});

test("template: history is trimmed to the version cap and archival is visible", (t) => {
  const dir = tempDir(t);
  const store = new ProjectTemplateStore({ file: path.join(dir, "templates.json"), now: () => FIXED_NOW, limit: 2 });
  const created = store.save(templateInput());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const id = created.template.templateId;
  for (let version = 2; version <= 23; version++) {
    const next = store.save(templateInput({ templateId: id, name: `版本 ${version}` }));
    assert.equal(next.ok, true);
  }
  const versions = store.versions(id);
  assert.equal(versions.length, 20, "per-template history keeps at most 20 versions");
  assert.equal(versions[0]?.templateVersion, 23);

  const archived = store.archive(id, new Date("2026-11-06T00:00:00.000Z"));
  assert.equal(archived.ok, true);
  if (!archived.ok) return;
  assert.equal(archived.template.archivedAt, "2026-11-06T00:00:00.000Z");
  assert.equal(store.list().length, 0);
  assert.equal(store.list({ includeArchived: true }).length, 1);
});

test("template: a legacy record upgrades with named losses and never resurrects a path", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "templates.json");
  const legacy = {
    schemaVersion: LEGACY_PROJECT_TEMPLATE_SCHEMA,
    id: "tmpl-11111111-1111-1111-1111-111111111111",
    name: "旧模板",
    description: "旧结构",
    model: "old-model-name",
    workspacePath: "C:\\Users\\example\\project",
    scopePaths: ["src/app.ts"],
    checks: [{ id: "typecheck", kind: "command", definition: "npm run typecheck" }],
    notes: "旧备注",
    timeoutSeconds: 600,
    maxAttempts: 2,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: PROJECT_TEMPLATE_FILE_SCHEMA, templates: [legacy] }, null, 2)}\n`, "utf8");
  const before = fs.readFileSync(file, "utf8");

  const store = new ProjectTemplateStore({ file, now: () => FIXED_NOW });
  const list = store.list();
  assert.equal(list.length, 1);
  const template = list[0]!;
  assert.equal(template.schemaVersion, PROJECT_TEMPLATE_SCHEMA);
  assert.equal(template.selectionSuggestion, null, "a bare model name is not invented into a full selection");
  assert.ok(template.migration?.notes.some(note => note.includes("工作区路径")));
  assert.ok(template.migration?.notes.some(note => note.includes("模型")));
  assert.equal(JSON.stringify(template).includes("C:\\\\Users"), false, "the old machine path is not carried into the template");
  assert.equal(fs.readFileSync(file, "utf8"), before, "loading never rewrites the original file");

  const direct = upgradeLegacyTemplate(legacy, { now: FIXED_NOW });
  assert.equal(direct.ok, true);
  if (direct.ok) assert.equal(direct.template.migration?.from, LEGACY_PROJECT_TEMPLATE_SCHEMA);

  const wrongSchema = upgradeLegacyTemplate({ ...legacy, schemaVersion: PROJECT_TEMPLATE_SCHEMA }, { now: FIXED_NOW });
  assert.equal(wrongSchema.ok, false);
  if (!wrongSchema.ok) assert.equal(wrongSchema.rejection.code, "unsupported_schema_version");

  const badCheckKind = upgradeLegacyTemplate({ ...legacy, checks: [{ id: "x", kind: "eyeball", definition: "看" }] }, { now: FIXED_NOW });
  assert.equal(badCheckKind.ok, false);
  if (!badCheckKind.ok) assert.equal(badCheckKind.rejection.code, "unknown_enum");
});

test("template: a corrupt file is explained, treated as empty, and new saves still work", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "templates.json");
  fs.writeFileSync(file, "{ this is not json", "utf8");
  const store = new ProjectTemplateStore({ file, now: () => FIXED_NOW });
  assert.equal(store.list().length, 0);
  assert.ok(store.issues().some(issue => issue.includes("格式无效")));
  assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json", "the corrupt file is kept for inspection");

  const created = store.save(templateInput());
  assert.equal(created.ok, true);
  const reloaded = new ProjectTemplateStore({ file, now: () => FIXED_NOW });
  assert.equal(reloaded.list().length, 1);
  assert.deepEqual(reloaded.issues(), []);

  const partiallyCorrupt = path.join(dir, "partial.json");
  fs.writeFileSync(partiallyCorrupt, `${JSON.stringify({
    schemaVersion: PROJECT_TEMPLATE_FILE_SCHEMA,
    templates: [{ schemaVersion: "workbuddy-executor/project-template-0", name: "无法解释" }],
  })}\n`, "utf8");
  const partial = new ProjectTemplateStore({ file: partiallyCorrupt, now: () => FIXED_NOW });
  assert.equal(partial.list().length, 0);
  assert.ok(partial.issues().some(issue => issue.includes("无法解释")));
});
