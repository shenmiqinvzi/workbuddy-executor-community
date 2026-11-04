import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { TaskStore } from "../src/task-store.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { authorizePlan, createPlan, registerWorkspace, showPlan } from "../src/plan.js";

// The plan CLI is the trusted local seam that makes a vnext-2 dispatch legal.
// These tests pin the three facts that seam must not blur: registration is
// path-checked, a plan is unauthorized until authorized, and authorization is
// revision-bound.
function fixture(t: { after: (fn: () => unknown) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-cli-"));
  const config = { ...loadConfig(), dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs") } as Config;
  const store = new TaskStore(config.dbFile);
  const service = new TaskApplicationService(new TaskCoordinator(config, store, new WorkBuddyClient(config)), 1, path.join(dir, "runs"));
  const workspace = path.join(dir, "project");
  fs.mkdirSync(workspace);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const proposal = {
    schemaVersion: "workbuddy-executor/vnext-2", taskId: "plan-task", workspaceId: "project", title: "Synthetic plan", objective: "Verify the local plan seam",
    execution: { executorId: "dsh", connectionId: "dsh-synthetic", providerId: "deepseek-account", modelId: "deepseek-flash", reasoningEffort: null },
    timeoutSeconds: 60, maxAttempts: 2, scope: { allowedChanges: ["src/example.ts"], permittedMetadata: [] }, requiredChecks: [],
    // A vnext-2 proposal must carry the collaboration block; the real ids are
    // bound after createPlan returns.
    collaboration: { planId: "placeholder", expectedPlanRevision: "placeholder" },
  };
  return { dir, store, service, workspace, proposal };
}

test("workspace registration refuses a directory that is not absolute", t => {
  const f = fixture(t);
  assert.throws(() => registerWorkspace(f.service, "project", "relative/project", "Project"), { code: "WORKSPACE_CONFLICT" });
  const registered = registerWorkspace(f.service, "project", f.workspace, "Project");
  assert.equal(registered.id, "project");
  assert.equal(registered.realPath, fs.realpathSync.native(f.workspace));
  // The same id cannot silently point at a second directory later.
  const other = path.join(f.dir, "other"); fs.mkdirSync(other);
  assert.throws(() => registerWorkspace(f.service, "project", other, "Other"), { code: "WORKSPACE_CONFLICT" });
});

test("a created plan stays unauthorized until the local operator authorizes it", t => {
  const f = fixture(t);
  registerWorkspace(f.service, "project", f.workspace, "Project");
  const created = createPlan(f.service, f.proposal, { reason: "User chose this model for the DSH task" });
  assert.equal(created.mode, "manual");
  assert.equal(created.authorizedAt, null);
  assert.equal(created.consumedBy, null);
  assert.deepEqual(showPlan(f.service, created.planId).authorizedAt, null);
  const authorized = authorizePlan(f.service, created.planId, created.revision, "user-confirmed-in-chat");
  assert.equal(authorized.authorizedAt !== null, true);
  assert.equal(authorized.authorizationSource, "user-confirmed-in-chat");
  assert.equal(showPlan(f.service, created.planId).authorizedAt, authorized.authorizedAt);
});

test("authorization is bound to the plan revision and needs a real source", t => {
  const f = fixture(t);
  registerWorkspace(f.service, "project", f.workspace, "Project");
  const created = createPlan(f.service, f.proposal, { reason: "Revision binding check" });
  assert.throws(() => authorizePlan(f.service, created.planId, "stale-revision", "user-confirmed-in-chat"), { code: "PLAN_STALE" });
  assert.throws(() => authorizePlan(f.service, created.planId, created.revision, "  "), { code: "PLAN_CONFIRMATION_REQUIRED" });
  assert.equal(showPlan(f.service, created.planId).authorizedAt, null);
});

test("plan creation rejects a proposal that is not a vnext-2 contract", t => {
  const f = fixture(t);
  registerWorkspace(f.service, "project", f.workspace, "Project");
  assert.throws(() => createPlan(f.service, { ...f.proposal, schemaVersion: "workbuddy-executor/vnext-1" }, { reason: "Wrong schema" }), { code: "PLAN_STALE" });
  assert.throws(() => createPlan(f.service, f.proposal, { reason: "" }), { code: "PLAN_STALE" });
});
