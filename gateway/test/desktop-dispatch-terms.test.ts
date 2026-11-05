import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopDispatchSession, type DesktopCatalogSource, type DesktopCatalogDiagnostic, type DesktopDraft, type DesktopProjectRegistry, type DesktopReceipt, type DesktopSession } from "../src/desktop-dispatch.js";
import { defaultModelPolicy } from "../src/collaboration.js";
import { DesktopProjectStore, resolveDesktopProject } from "../src/desktop-projects.js";

const workbuddyModel = { execution: { executorId: "workbuddy" as const, connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-model", reasoningEffort: null }, credits: "x0.00", pricingVerified: true };
const dshModel = { execution: { executorId: "dsh" as const, connectionId: "synthetic-host", providerId: "synthetic-provider", modelId: "synthetic-dsh-model", reasoningEffort: "low" }, credits: null, pricingVerified: false };
const hasCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && (error as { code: string }).code === code;

function sandbox(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-terms-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return dir;
}

interface FixtureOptions {
  models?: unknown[];
  sessions?: DesktopSession[] | ((project: string, other: string) => DesktopSession[]);
  dispatchEnabled?: boolean;
  diagnostics?: DesktopCatalogDiagnostic[];
}
function fixture(t: { after: (fn: () => void) => void }, options: FixtureOptions = {}) {
  const dir = sandbox(t), project = path.join(dir, "project"), other = path.join(dir, "other");
  fs.mkdirSync(project); fs.mkdirSync(other);
  let now = Date.now(), catalogCalls = 0, enqueued = 0;
  const receipts = new Map<string, DesktopReceipt>(), dispatched: DesktopDraft[] = [];
  const store = new DesktopProjectStore({ file: path.join(dir, "state", "projects.json"), now: () => now });
  const sessions = typeof options.sessions === "function" ? options.sessions(project, other) : options.sessions ?? [];
  const source: DesktopCatalogSource = { models: (options.models ?? [workbuddyModel]) as DesktopCatalogSource["models"], sessions,
    policy: defaultModelPolicy(), requiredFreeModel: null, dispatchEnabled: options.dispatchEnabled ?? true, errors: [], diagnostics: options.diagnostics ?? [] };
  const make = (registry: DesktopProjectRegistry = store) => new DesktopDispatchSession({
    catalog: async () => { catalogCalls++; return structuredClone(source); }, projects: registry, now: () => now, receipt: id => receipts.get(id) ?? null,
    enqueue: async draft => { enqueued++; dispatched.push(draft); const receipt: DesktopReceipt = { requestId: draft.draftId, taskId: draft.taskId, operationId: draft.operationId, state: "launch_requested" }; receipts.set(draft.draftId, receipt); return receipt; },
  });
  const session = make();
  return { dir, project, other, store, source, session, make, receipts, dispatched,
    get catalogCalls() { return catalogCalls; }, get enqueued() { return enqueued; },
    advance: () => { now += 300_001; },
    draft: async (override: Record<string, unknown> = {}) => {
      const catalog = await session.catalog();
      return session.preview({ catalogId: catalog.catalogId, modelKey: catalog.models[0]!.key, workspace: project, title: "Synthetic scoped task", objective: "Update only the allowed files", allowedChanges: ["src/**"], permittedMetadata: [], checks: ["Independent check of the requested behavior"], maxAttempts: 1, timeoutSeconds: 600, sessionId: null, projectId: null, ...override });
    },
    terms: (override: Record<string, unknown> = {}) => ({ title: "Synthetic scoped task", objective: "Update only the allowed files", allowedChanges: ["src/**"], permittedMetadata: [], checks: ["Independent check of the requested behavior"], maxAttempts: 1, timeoutSeconds: 600, sessionId: null, projectId: null, ...override }) };
}

test("preview reads the catalog once, dispatches nothing and only remembers the verified identity", async t => {
  const f = fixture(t), value = await f.draft();
  assert.equal(f.catalogCalls, 1);
  assert.equal(f.enqueued, 0);
  assert.equal(f.session.receipt(value.draftId), null);
  assert.equal(value.revision, 1);
  assert.equal(value.sessionId, null);
  const remembered = f.store.list();
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0]!.projectId, value.projectId);
  assert.equal(remembered[0]!.realPath, fs.realpathSync.native(f.project));
  const byIdentity = await f.draft({ workspace: null, projectId: remembered[0]!.projectId });
  assert.equal(byIdentity.projectId, value.projectId);
  assert.equal(f.catalogCalls, 2);
});

test("an unknown project row, a replaced directory and two selections are refused by name", async t => {
  const f = fixture(t), catalog = await f.session.catalog(), base = { catalogId: catalog.catalogId, modelKey: catalog.models[0]!.key, ...f.terms() };
  await assert.rejects(async () => f.session.preview({ ...base, workspace: f.project, projectId: "project-" + "0".repeat(32) }), hasCode("PROJECT_SELECTION_REQUIRED"));
  await assert.rejects(async () => f.session.preview({ ...base, workspace: null }), hasCode("PROJECT_SELECTION_REQUIRED"));
  await assert.rejects(async () => f.session.preview({ ...base, workspace: null, projectId: "project-" + "0".repeat(32) }), hasCode("PROJECT_NOT_REGISTERED"));
  await assert.rejects(async () => f.session.preview({ ...base, workspace: path.join(f.dir, "missing") }), hasCode("PROJECT_NOT_FOUND"));
  await assert.rejects(async () => f.session.preview({ ...base, workspace: "relative/project" }), hasCode("PROJECT_PATH_NOT_ABSOLUTE"));
  const real = resolveDesktopProject(f.project);
  assert.equal(real.ok, true);
  if (!real.ok) return;
  const forged: DesktopProjectRegistry = { candidates: () => [], remember: () => ({ projectId: "x", realPath: f.project, device: "1", inode: "2", displayName: "project", aliases: [], observedAt: new Date(0).toISOString() }),
    find: id => ({ projectId: id, realPath: f.project, device: real.identity.device, inode: String(BigInt(real.identity.inode) + 1n), displayName: "project", aliases: [], observedAt: new Date(0).toISOString() }) };
  const replaced = f.make(forged), replacedCatalog = await replaced.catalog();
  await assert.rejects(async () => replaced.preview({ ...base, catalogId: replacedCatalog.catalogId, modelKey: replacedCatalog.models[0]!.key, workspace: null, projectId: "project-" + "1".repeat(32) }), hasCode("PROJECT_IDENTITY_CHANGED"));
});

test("a revision keeps the task identity, retires the old digest and never extends the deadline", async t => {
  const f = fixture(t), first = await f.draft();
  const second = f.session.revise(first.draftId, first.digest, { checks: ["A narrower independent check"] });
  assert.equal(second.revision, 2);
  assert.equal(second.taskId, first.taskId);
  assert.equal(second.operationId, first.operationId);
  assert.equal(second.expiresAt, first.expiresAt);
  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(second.contract.requiredChecks.map(check => check.definition), ["A narrower independent check"]);
  assert.throws(() => f.session.review(first.draftId, first.digest), hasCode("DRAFT_CHANGED"));
  assert.equal(f.session.review(second.draftId, second.digest).revision, 2);
  assert.equal(f.catalogCalls, 1, "a revision never re-reads the catalog and never substitutes a model");
  assert.throws(() => f.session.revise(second.draftId, second.digest, { modelKey: "another-model" }), hasCode("MODEL_SWITCH_REQUIRES_PREVIEW"));

  // The transport shape of `preview` (draftId + digest) is the same revision.
  const g = fixture(t), catalog = await g.session.catalog(), base = { catalogId: catalog.catalogId, modelKey: catalog.models[0]!.key, ...g.terms() };
  const draft = g.session.preview({ ...base, workspace: g.project });
  const revised = g.session.preview({ ...base, workspace: g.project, title: "Renamed while reviewing", draftId: draft.draftId, digest: draft.digest });
  assert.equal(revised.revision, 2);
  assert.equal(revised.taskId, draft.taskId);
  assert.equal(revised.contract.title, "Renamed while reviewing");
  await g.session.commit(revised.draftId, revised.digest);
  assert.throws(() => g.session.revise(revised.draftId, revised.digest, { checks: ["Too late"] }), hasCode("DRAFT_CONSUMED"));
  assert.equal(g.enqueued, 1);
});

test("one agreement is dispatched once even when a second task identity carries the same terms", async t => {
  const f = fixture(t), first = await f.draft();
  const receipt = await f.session.commit(first.draftId, first.digest);
  assert.equal(receipt.state, "launch_requested");
  assert.equal(f.enqueued, 1);
  const duplicate = await f.draft();
  assert.notEqual(duplicate.taskId, first.taskId);
  await assert.rejects(f.session.commit(duplicate.draftId, duplicate.digest), hasCode("PLAN_ALREADY_CONSUMED"));
  assert.equal(f.enqueued, 1);
  const different = await f.draft({ checks: ["A different independent check"] });
  await f.session.commit(different.draftId, different.digest);
  assert.equal(f.enqueued, 2);
  assert.equal(new Set(f.dispatched.map(draft => draft.taskId)).size, 2);
});

test("an expired agreement, a changed quote or a removed effort never reach an executor", async t => {
  for (const mutation of ["quote", "policy", "removed", "expired"] as const) {
    const f = fixture(t), value = await f.draft();
    if (mutation === "quote") f.source.models[0]!.credits = "x2.00";
    if (mutation === "policy") f.source.policy.version = "changed";
    if (mutation === "removed") (f.source.models as unknown[]).length = 0;
    if (mutation === "expired") f.advance();
    await assert.rejects(Promise.resolve().then(() => f.session.commit(value.draftId, value.digest)), undefined, mutation);
    assert.equal(f.enqueued, 0, mutation);
  }
});

test("each DSH session problem keeps its own explanation instead of one generic state", async t => {
  const cases: Array<{ sessions: (project: string, other: string) => DesktopSession[]; sessionId: string | null; message: RegExp }> = [
    { sessions: () => [], sessionId: null, message: /没有可用于这个项目的 DSH 会话/ },
    { sessions: project => [1, 2].map(() => ({ hostId: "synthetic-host", sessionId: "dup", workspace: project, attached: true, busy: false })), sessionId: "dup", message: /身份不唯一/ },
    { sessions: project => [{ hostId: "synthetic-host", sessionId: "busy", workspace: project, attached: true, busy: true, availability: "busy" }], sessionId: "busy", message: /正在执行其他任务/ },
    { sessions: project => [{ hostId: "synthetic-host", sessionId: "unknown", workspace: project, attached: true, busy: false, availability: "unknown" }], sessionId: "unknown", message: /无法确认所选会话的状态/ },
    { sessions: project => [{ hostId: "synthetic-host", sessionId: "off", workspace: project, attached: false, busy: false, availability: "disconnected" }], sessionId: "off", message: /未连接/ },
    { sessions: (_project, other) => [{ hostId: "synthetic-host", sessionId: "other", workspace: other, attached: true, busy: false }], sessionId: "other", message: /不属于当前项目/ },
  ];
  for (const item of cases) {
    const f = fixture(t, { models: [dshModel], sessions: item.sessions }), catalog = await f.session.catalog();
    await assert.rejects(async () => f.session.preview({ catalogId: catalog.catalogId, modelKey: catalog.models[0]!.key, workspace: f.project, ...f.terms({ sessionId: item.sessionId }) }),
      (error: unknown) => hasCode("SESSION_REQUIRED")(error) && item.message.test(String((error as Error).message)), String(item.message));
    assert.equal(f.enqueued, 0);
  }
});

test("the catalog separates listed, dispatchable and stop evidence per source", async t => {
  const f = fixture(t, { diagnostics: [{ source: "dsh", code: "source_disabled", message: "DSH 来源未启用" }] });
  const catalog = await f.session.catalog();
  assert.equal(catalog.sources.length, 2);
  const workbuddy = catalog.sources.find(view => view.executorId === "workbuddy")!, dsh = catalog.sources.find(view => view.executorId === "dsh")!;
  assert.equal(workbuddy.state, "online");
  assert.equal(workbuddy.dispatchable, true);
  assert.equal(workbuddy.stoppable, "unknown");
  assert.equal(dsh.state, "disabled");
  assert.equal(dsh.dispatchable, false);
  assert.equal(dsh.models.length, 0);
  assert.match(dsh.stateReason ?? "", /未启用/);
  assert.deepEqual(catalog.errors, [], "the session keeps the runtime's error channel unchanged instead of duplicating diagnostics");
  assert.deepEqual(catalog.diagnostics, [{ source: "dsh", code: "source_disabled", message: "DSH 来源未启用" }]);
  assert.deepEqual(catalog.projects, []);
  assert.deepEqual(catalog.projectIssues, []);
  const closed = await fixture(t, { dispatchEnabled: false }).session.catalog();
  assert.equal(closed.sources[0]!.state, "online");
  assert.equal(closed.sources[0]!.dispatchable, false);
});

test("a direct task never carries a DSH session or an attempt identity", async t => {
  const f = fixture(t), value = await f.draft();
  assert.equal(value.contract.execution.executorId, "workbuddy");
  assert.equal(value.sessionId, null);
  await assert.rejects(async () => f.draft({ sessionId: "synthetic-session" }), hasCode("INVALID_REQUEST"));
  const receipt = await f.session.commit(value.draftId, value.digest);
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0]!.sessionId, null);
  assert.equal("attemptId" in receipt, false);
  assert.equal(receipt.taskId, value.taskId);
});
