import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopDispatchSession, type DesktopCatalogSource } from "../src/desktop-dispatch.js";
import { defaultModelPolicy } from "../src/collaboration.js";

/** The confirmation's drift check compares catalog identities. A catalog whose
 * content did not change must therefore keep its identity across reads, while a
 * real change must still produce a new one and refuse the confirmation. */
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-catalog-identity-")));
  const project = path.join(dir, "project");
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const source: DesktopCatalogSource = {
    models: [{ execution: { executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-model", reasoningEffort: null }, credits: "x0.08", pricingVerified: true }],
    sessions: [],
    policy: defaultModelPolicy(),
    requiredFreeModel: null,
    dispatchEnabled: true,
    errors: [],
  };
  const session = new DesktopDispatchSession({ catalog: async () => structuredClone(source), now: () => Date.parse("2026-11-12T09:00:00.000Z"), enqueue: async () => { throw new Error("no dispatch in this fixture"); } });
  return { project, session, source };
}

test("an unchanged catalog keeps its identity across reads", async (t) => {
  const f = fixture(t);
  const first = await f.session.catalog();
  const second = await f.session.catalog();
  assert.equal(first.catalogId, second.catalogId);
  assert.match(first.catalogId, /^cat-[a-f0-9]{40}$/);
});

test("a reviewed agreement stays confirmable while the catalog content is stable", async (t) => {
  const f = fixture(t);
  const catalog = await f.session.catalog();
  const value = await f.session.preview({
    catalogId: catalog.catalogId,
    modelKey: catalog.models[0]!.key,
    workspace: f.project,
    title: "Stable catalog",
    objective: "Keep the reviewed terms",
    allowedChanges: [],
    permittedMetadata: [],
    checks: ["The independent check still passes"],
    maxAttempts: 1,
    timeoutSeconds: 600,
    sessionId: null,
  });
  // Reading the catalog again is exactly what the confirmation does before it opens.
  assert.equal((await f.session.catalog()).catalogId, catalog.catalogId);
  assert.equal(f.session.review(value.draftId, value.digest).digest, value.digest);
});

test("a changed catalog still gets a new identity", async (t) => {
  const f = fixture(t);
  const before = (await f.session.catalog()).catalogId;
  f.source.models[0]!.credits = "x1.20";
  assert.notEqual((await f.session.catalog()).catalogId, before, "a different observed rate is a different quote");
  f.source.policy.version = "changed";
  assert.notEqual((await f.session.catalog()).catalogId, before, "a different policy is a different agreement");
});

test("session availability is not an agreed term and never voids a reviewed catalog", async (t) => {
  const f = fixture(t);
  f.source.sessions = [{ hostId: "dsh-synthetic", sessionId: "session-1", workspace: f.project, attached: true, busy: false }];
  const before = (await f.session.catalog()).catalogId;
  f.source.sessions = [{ hostId: "dsh-synthetic", sessionId: "session-1", workspace: f.project, attached: true, busy: true }];
  assert.equal((await f.session.catalog()).catalogId, before);
  f.source.sessions = [{ hostId: "dsh-synthetic", sessionId: "session-2", workspace: f.project, attached: false, busy: false }];
  assert.equal((await f.session.catalog()).catalogId, before, "a session that comes and goes is re-checked at preview, not in the catalog identity");
  f.source.errors = ["目录列出 200 个 DSH 会话（共 204 个）；未列出的会话无法接收派工。"];
  assert.equal((await f.session.catalog()).catalogId, before, "source prose is a diagnostic, not a term");
});
