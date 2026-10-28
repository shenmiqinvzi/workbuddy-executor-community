import { reviewAccept } from "./support/review-accept.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";
import { workspaceRelative, resolveWorkspaceRead } from "../src/workspace-protection.js";
import { DshTaskCoordinator } from "../src/dsh-coordinator.js";
import type { DshTransport, DshSelection } from "../src/dsh-client.js";
import type { DeepSeekEvent } from "../src/deepseek-client.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { readWorkerContext, readWorkerObject } from "../src/worker-result.js";
import { TaskCoordinator } from "../src/coordinator.js";
import type { WorkBuddyClient } from "../src/workbuddy-client.js";
import type { Config } from "../src/config.js";

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wb-t5-"))), workspace = path.join(dir, "项目 with spaces"), runs = path.join(dir, "runs");
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(workspace, "src")); fs.writeFileSync(path.join(workspace, "README.md"), "protected baseline\n");
  const store = new TaskStore(path.join(dir, "state", "tasks.sqlite"));
  t.after(() => { store.close(); assert.equal(path.dirname(dir), fs.realpathSync.native(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); });
  const write = (name: string, content: string | Buffer) => { const target = path.join(workspace, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  function prepare(scope = { allowedChanges: ["src/**"], permittedMetadata: [".workbuddy-ai/memory/day.md"] }) {
    const taskId = "scope-task", bindingHash = crypto.createHash("sha256").update(JSON.stringify(scope)).digest("hex");
    store.createOrGet({ taskId, messageId: "pending", objective: "Synthetic scope test", workspace, state: "blocked", submissionHash: bindingHash });
    const original = store.workspaceProtection.create(taskId, workspace, bindingHash, scope, runs), guard = store.workspaceProtection.guard(taskId);
    store.beginAttempt(taskId, { attemptId: "run-first", messageId: "request-first" }); store.workspaceProtection.bindAttempt(taskId, "run-first", guard);
    return { taskId, original, guard, check: () => store.workspaceProtection.review(taskId, "run-first") };
  }
  return { dir, workspace, runs, store, write, prepare };
}

test("T5 inventories binary additions, modifications, deletion, both rename endpoints and minimal metadata", t => {
  const f = fixture(t); f.write("src/old.bin", Buffer.from([0, 255, 1])); f.write("src/delete.txt", "delete"); f.write("src/edit.txt", "original"); const run = f.prepare();
  fs.renameSync(path.join(f.workspace, "src/old.bin"), path.join(f.workspace, "src/new.bin")); fs.unlinkSync(path.join(f.workspace, "src/delete.txt")); f.write("src/edit.txt", "changed"); f.write("src/new/deep.txt", "new"); f.write(".workbuddy-ai/memory/day.md", "allowed metadata");
  const check = run.check(); assert.equal(check.status, "passed");
  assert.ok(check.changes.some(change => change.kind === "renamed" && change.path === "src/new.bin" && change.previousPath === "src/old.bin"));
  assert.ok(check.changes.some(change => change.kind === "deleted" && change.path === "src/delete.txt"));
  assert.ok(check.changes.some(change => change.kind === "modified" && change.path === "src/edit.txt"));
  assert.ok(check.changes.some(change => change.path === ".workbuddy-ai/memory/day.md" && change.category === "metadata"));
  assert.deepEqual(f.store.workspaceProtection.create(run.taskId, f.workspace, run.original.value.bindingHash, run.original.value.scope, f.runs), run.original);
  f.write(".workbuddy-ai/memory/extra.md", "not permitted"); assert.equal(run.check().status, "failed");
  assert.equal(fs.readFileSync(path.join(f.workspace, "README.md"), "utf8"), "protected baseline\n");
});

test("T5 rename with only one allowed endpoint is unauthorized; original baseline survives rework", t => {
  const f = fixture(t); f.write("README.md", "original"); const run = f.prepare(); fs.renameSync(path.join(f.workspace, "README.md"), path.join(f.workspace, "src/moved.md"));
  assert.equal(run.check().status, "failed"); f.store.update("scope-task", { state: "blocked" });
  const guard = f.store.workspaceProtection.guard("scope-task"); f.store.beginAttempt("scope-task", { attemptId: "run-second", messageId: "second" }); f.store.workspaceProtection.bindAttempt("scope-task", "run-second", guard);
  assert.equal(f.store.workspaceProtection.review("scope-task", "run-second").status, "failed");
  assert.equal(f.store.workspaceProtection.readView("scope-task").baselineDigest, run.original.digest);
});

test("T5 rejects stale checked content at the shared storage acceptance boundary", t => {
  const f = fixture(t), run = f.prepare(); f.write("src/a.js", "checked"); assert.equal(run.check().status, "passed"); f.store.update("scope-task", { state: "needs_review" }); f.write("src/a.js", "changed after checking");
  assert.throws(() => f.store.acceptAttempt("scope-task", "run-first", { state: "accepted" }, { type: "task_closed", occurredAt: new Date().toISOString(), actor: "synthetic-reviewer", payload: {}, sourceRef: "close" }), { code: "SCOPE_EVIDENCE_STALE" });
  assert.equal(f.store.get("scope-task")!.state, "needs_review"); assert.equal(f.store.listTaskEvents("scope-task").events.some(event => event.type === "task_closed"), false);
});

test("T5 Git dirty, staged, untracked and ignored originals are protected without changing the index", t => {
  const f = fixture(t), git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=.git/no-hooks", "-c", "commit.gpgsign=false", "-c", "user.name=Synthetic Scope Test", "-c", "user.email=synthetic@example.invalid", ...args], { cwd: f.workspace, stdio: "pipe", windowsHide: true });
  git("init", "-q"); f.write(".gitignore", "ignored.txt\n"); f.write("src/dirty.js", "committed"); f.write("src/staged.js", "committed"); git("add", "."); git("commit", "-qm", "synthetic fixture");
  f.write("src/dirty.js", "user uncommitted"); f.write("src/staged.js", "user staged"); git("add", "src/staged.js"); f.write("src/untracked.js", "user untracked"); f.write("ignored.txt", "user ignored");
  const index = fs.readFileSync(path.join(f.workspace, ".git/index")), run = f.prepare(); assert.deepEqual(fs.readFileSync(path.join(f.workspace, ".git/index")), index);
  for (const name of ["src/dirty.js", "src/staged.js", "src/untracked.js", "ignored.txt"]) assert.ok(run.original.value.protectedPaths.includes(name));
  assert.throws(() => f.store.workspaceProtection.authorizePath(run.taskId, "run-first", "src/dirty.js", "write"), { code: "SCOPE_PATH_UNAUTHORIZED" });
  f.write("src/dirty.js", "worker overwrote original user change"); assert.equal(run.check().status, "failed"); assert.throws(() => f.store.workspaceProtection.guard(run.taskId), { code: "SCOPE_USER_CHANGE_CONFLICT" });
  assert.equal(fs.readFileSync(path.join(f.workspace, "src/dirty.js"), "utf8"), "worker overwrote original user change", "Checker must never silently restore user content");
});

test("T5 Windows ambiguous names, traversal, ADS, UNC and device paths are refused", () => {
  for (const name of ["../a", "a/../b", "C:/a", "//server/share", "a.txt:stream", "NUL.txt", "a/COM1", "a./b", "a /b", "a//b", "a\\..\\b"]) assert.throws(() => workspaceRelative(name), { code: "SCOPE_PATH_INVALID" });
  assert.equal(workspaceRelative("中文 dir\\文件.txt"), "中文 dir/文件.txt");
});

test("T5 junctions and hard links cannot grant aliases outside the workspace", t => {
  const f = fixture(t), outside = path.join(f.dir, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret"), "outside");
  fs.symlinkSync(outside, path.join(f.workspace, "src/link"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.prepare(), { code: "SCOPE_PATH_LINK" });
  assert.equal(fs.readFileSync(path.join(outside, "secret"), "utf8"), "outside");
});

test("T5 a hard-linked authorized file cannot be inventoried as an exclusive deliverable", t => {
  const f = fixture(t), outside = path.join(f.dir, "outside.txt"); fs.writeFileSync(outside, "shared"); fs.linkSync(outside, path.join(f.workspace, "src/shared.txt")); assert.throws(() => f.prepare(), { code: "SCOPE_PATH_LINK" });
});

test("T5 root replacement and missing original inventories fail closed", t => {
  const f = fixture(t), run = f.prepare(); fs.renameSync(f.workspace, `${f.workspace}-original`); fs.mkdirSync(f.workspace); assert.equal(run.check().status, "checker_error");
  assert.throws(() => f.store.workspaceProtection.authorizePath("scope-task", "run-first", "src/x", "write"), { code: "SCOPE_WORKSPACE_CHANGED" });
  assert.throws(() => f.store.workspaceProtection.guard("historical"), { code: "SCOPE_BASELINE_MISSING" });
});

test("T5 actual preparation drift is rejected; known external native write intents survive rework", t => {
  const f = fixture(t), run = f.prepare(); f.write("src/concurrent.js", "before a prompt was sent"); assert.throws(() => f.store.workspaceProtection.assertGuard(run.guard), { code: "SCOPE_WORKSPACE_CHANGED" });
  f.store.workspaceProtection.observeToolCall(run.taskId, "run-first", "tool/call", { name: "write", arguments: JSON.stringify({ filePath: path.join(f.dir, "outside.txt"), content: "would write outside" }) }, "native:1");
  assert.equal(run.check().status, "failed"); f.store.update(run.taskId, { state: "blocked" }); const guard = f.store.workspaceProtection.guard(run.taskId); f.store.beginAttempt(run.taskId, { attemptId: "run-second", messageId: "second" }); f.store.workspaceProtection.bindAttempt(run.taskId, "run-second", guard);
  assert.equal(f.store.workspaceProtection.review(run.taskId, "run-second").status, "failed"); assert.equal(fs.existsSync(path.join(f.dir, "outside.txt")), false);
});

test("T5 scope facts are durable; read-only views neither scan nor modify stored bytes", t => {
  const f = fixture(t), run = f.prepare(); f.write("src/a.js", "checked"); const check = run.check(), before = fs.readFileSync(f.store.file), revision = f.store.get(run.taskId)!.revision;
  const other = new TaskStore(f.store.file); try { assert.deepEqual(other.workspaceProtection.latest(run.taskId, "run-first"), check); assert.deepEqual(other.workspaceProtection.readView(run.taskId, "run-first").check, check); } finally { other.close(); }
  assert.deepEqual(fs.readFileSync(f.store.file), before); assert.equal(f.store.get(run.taskId)!.revision, revision);
  const db = new DatabaseSync(f.store.file); db.prepare("UPDATE workspace_scope_baselines SET body=? WHERE task_id=?").run("{}", run.taskId); db.close(); assert.equal(f.store.workspaceProtection.readView(run.taskId).baseline, "integrity_failure"); assert.throws(() => run.check(), { code: "SCOPE_BASELINE_INTEGRITY" });
});

test("T5 a declared exact file cannot be replaced by a directory grant", t => {
  const f = fixture(t); f.write("src/a", "original file"); const run = f.prepare({ allowedChanges: ["src/a"], permittedMetadata: [] }); fs.unlinkSync(path.join(f.workspace, "src/a")); fs.mkdirSync(path.join(f.workspace, "src/a")); assert.equal(run.check().status, "failed");
});

test("T5 command input names resolve against the actual cwd and cannot traverse junctions or escape", t => {
  const f = fixture(t), external = path.join(f.dir, "external"); fs.mkdirSync(external); fs.writeFileSync(path.join(external, "secret"), "private sentinel"); f.write("src/normal.js", "source"); fs.symlinkSync(external, path.join(f.workspace, "src/alias"), process.platform === "win32" ? "junction" : "dir"); const run = f.prepare({ allowedChanges: [], permittedMetadata: [] });
  const queue = new DesktopQueue({ backend: "desktop-queue", dbFile: f.store.file, runsDir: f.runs } as Config, () => ({ desktopPid: process.pid }));
  // This isolates path authorization; actual native lease/ancestry remains covered by queue regressions.
  queue.authorizeCommand = () => ({ taskId: run.taskId, attemptId: "run-first", status: "working", updatedAt: new Date().toISOString() });
  const context = { sessionId: "synthetic", attemptId: "run-first", leaseToken: "synthetic" }, cwd = path.join(f.workspace, "src");
  assert.equal(queue.authorizeCommandPaths(context, { cwd, inputs: ["normal.js"] }).taskId, run.taskId);
  assert.throws(() => queue.authorizeCommandPaths(context, { cwd, inputs: ["alias/secret"] }), { code: "SCOPE_PATH_LINK" });
  fs.linkSync(path.join(external, "secret"), path.join(cwd, "hard-alias"));
  assert.throws(() => queue.authorizeCommandPaths(context, { cwd, inputs: ["hard-alias"] }), { code: "SCOPE_PATH_LINK" });
  assert.throws(() => queue.authorizeCommandPaths(context, { cwd: f.dir }), { code: "SCOPE_PATH_OUTSIDE" });
  assert.throws(() => queue.authorizeCommandPaths(context, { cwd, inputs: ["../README.md"] }), { code: "SCOPE_PATH_INVALID" });
  assert.throws(() => queue.authorizeCommandPaths(context, { cwd, inputs: [path.join(cwd, "normal.js. ")] }), { code: "SCOPE_PATH_INVALID" });
  if (process.platform === "win32") {
    assert.throws(() => resolveWorkspaceRead(f.workspace, path.toNamespacedPath(path.join(cwd, "normal.js"))), { code: "SCOPE_PATH_INVALID" });
    assert.throws(() => resolveWorkspaceRead(f.workspace, "\\\\unreachable.invalid\\share\\input.txt"), { code: "SCOPE_PATH_OUTSIDE" });
  }
  assert.equal(fs.readFileSync(path.join(external, "secret"), "utf8"), "private sentinel");
});

test("T5 worker JSON paths reject foreign and linked files before parsing or exposing contents", t => {
  const f = fixture(t), foreign = path.join(f.dir, "foreign.json"); fs.writeFileSync(foreign, "PRIVATE_SENTINEL_NOT_JSON"); const config = { runsDir: f.runs } as Config;
  assert.throws(() => readWorkerContext(config, foreign), error => error instanceof Error && !error.message.includes("PRIVATE_SENTINEL") && /execution attempt/.test(error.message));
  const attemptId = `run-${crypto.randomUUID()}`, dir = path.join(f.runs, attemptId); fs.mkdirSync(dir, { recursive: true }); const commandFile = path.join(dir, "worker-command.json"); fs.linkSync(foreign, commandFile);
  assert.throws(() => readWorkerObject(config, attemptId, commandFile, "worker-command.json", 4096), /Linked/);
  assert.equal(fs.readFileSync(foreign, "utf8"), "PRIVATE_SENTINEL_NOT_JSON");
});

test("T5 original workspace cannot be swapped under the same scope identity", t => {
  const f = fixture(t), run = f.prepare(), other = path.join(f.dir, "other"); fs.mkdirSync(other);
  assert.throws(() => f.store.workspaceProtection.create(run.taskId, other, run.original.value.bindingHash, run.original.value.scope, f.runs), { code: "SCOPE_BASELINE_INTEGRITY" });
  const db = new DatabaseSync(f.store.file); db.prepare("UPDATE tasks SET workspace=? WHERE task_id=?").run(other, run.taskId); db.close(); assert.equal(run.check().status, "checker_error");
});

test("T5 scoped WorkBuddy submissions freeze an additive scope while unscoped submissions stay read-only", async t => {
  const f = fixture(t); let prompts = 0; const config = { backend: "desktop-acp", dbFile: f.store.file, runsDir: f.runs, taskTimeoutSeconds: 60 } as Config;
  const client = { async sendMessage() { prompts++; return { messageId: "synthetic", raw: {} }; }, runSnapshot() { return undefined; } } as unknown as WorkBuddyClient;
  const coordinator = new TaskCoordinator(config, f.store, client), input = { taskId: "wb-scoped", workspace: f.workspace, sessionId: "synthetic-session", model: "synthetic-choice", objective: "Scope immutable submission", scope: { allowedChanges: ["src/**"], permittedMetadata: [] } };
  assert.equal((await coordinator.send(input)).ok, true); const task = f.store.get(input.taskId)!; f.write("src/within.js", "in scope"); assert.equal(f.store.workspaceProtection.review(task.taskId, task.attemptId!).status, "passed");
  assert.equal((await coordinator.send(input)).created, false); assert.equal(prompts, 1); await assert.rejects(coordinator.send({ ...input, scope: { allowedChanges: ["README.md"], permittedMetadata: [] } }), /conflicts/);
  assert.equal(f.store.workspaceProtection.readView(task.taskId).mode, "scoped_submission");
  const other = fixture(t), raw = new TaskCoordinator({ ...config, dbFile: other.store.file, runsDir: other.runs }, other.store, client);
  await raw.send({ taskId: "readonly", workspace: other.workspace, sessionId: "synthetic-session", model: "synthetic-choice", objective: "No implicit write scope" });
  const readonly = other.store.get("readonly")!; assert.equal(other.store.workspaceProtection.readView("readonly").mode, "legacy_read_only"); other.write("src/not-granted.js", "must not pass"); assert.equal(other.store.workspaceProtection.review("readonly", readonly.attemptId!).status, "failed");
});

function dshFixture(t: { after(fn: () => void): void }, scope = { allowedChanges: ["src/**"], permittedMetadata: [] as string[] }) {
  const f = fixture(t), taskId = "dsh-scoped", selection: DshSelection = { providerId: "synthetic-provider", modelId: "synthetic-choice", reasoningEffort: null }, events: DeepSeekEvent[] = [];
  let selected: DshSelection | null = null, selections = 0, prompts = 0, duringSelection = () => {};
  const client: DshTransport = {
    resolveHostId: () => "host", health: async () => ({}), sessions: async () => ({ sessions: [] }), create: async () => { throw Error("No session creation in synthetic test"); },
    session: async () => ({ sessionId: "session", workspace: f.workspace, busy: false, attached: true, selectedModel: selected }), models: async () => ({ models: [{ ...selection, credits: null, reasoningEfforts: [] }], pricingVerified: false }),
    selectModel: async () => { selections++; assert.equal(f.store.workspaceProtection.readView(taskId).baseline, "present"); duringSelection(); selected = selection; return { sessionId: "session", workspace: f.workspace, attached: true, selectedModel: selected }; },
    prompt: async input => { prompts++; return { requestId: input.requestId, accepted: true, turnId: "session:turn:1" }; },
    events: async input => { const page = events.filter(event => event.seq > input.afterSeq); return { events: page, cursor: page.at(-1)?.seq ?? input.afterSeq }; }, cancel: async () => ({ requested: true })
  };
  const coordinator = new DshTaskCoordinator(f.store, client, f.runs); f.store.collaboration.registerWorkspace("project", f.workspace, "Synthetic scoped workspace");
  const proposal = { schemaVersion: "workbuddy-executor/vnext-2", taskId, workspaceId: "project", title: "Synthetic scope integration", objective: "Validate actual file protection without a real model", execution: { executorId: "dsh" as const, connectionId: "host", ...selection }, timeoutSeconds: 60, maxAttempts: 2, scope, requiredChecks: [], collaboration: { planId: "pending", expectedPlanRevision: "pending" } };
  const plan = f.store.collaboration.createPlan(proposal, coordinator.policy(), { mode: "manual", reason: "Synthetic fixture, not a real dispatch approval" }); f.store.collaboration.authorizePlan(plan.planId, plan.revision, coordinator.policy(), "synthetic-user");
  const contract = { ...proposal, collaboration: { planId: plan.planId, expectedPlanRevision: plan.revision } };
  const send = () => coordinator.send({ taskId, contract, objective: contract.objective, sessionId: "session" });
  function finish() { const binding = f.store.dshBindings.forTask(taskId)!; for (const [type, rawType, data, text] of [["started", "turn/start"], ["progress", "request/header", { header: { config: { provider: selection.providerId, model: selection.modelId } } }], ["completed", "turn/end", undefined, "TASK_STATUS: completed\nTEST_RESULT: synthetic scope check"]] as const) events.push({ seq: events.length, requestId: binding.requestId, type, rawType, turnId: "session:turn:1", timestamp: new Date().toISOString(), ...(data ? { data } : {}), ...(text ? { text } : {}) }); }
  return { ...f, taskId, coordinator, send, finish, counters: () => ({ selections, prompts }), setDuringSelection: (fn: () => void) => { duringSelection = fn; } };
}

test("T5 DSH persists scope before model selection and accepts an in-scope stopped authenticated result", async t => {
  const f = dshFixture(t); assert.equal((await f.send()).ok, true); f.write("src/worker.js", "actual delta"); f.finish(); assert.equal((await reviewAccept(f.coordinator, f.taskId, "Independent synthetic file review", ["Actual temporary files inspected"])).state, "accepted"); assert.equal(f.store.workspaceProtection.readView(f.taskId, f.store.get(f.taskId)!.attemptId).check!.status, "passed");
});

test("T5 DSH scope violation refuses acceptance and preserves shared occupancy and failure evidence", async t => {
  const f = dshFixture(t); await f.send(); f.write(".workbuddy-ai/memory/not-allowed.md", "unauthorized"); f.finish(); await assert.rejects(f.coordinator.accept(f.taskId, "Review", ["File inspected"]), { code: "SCOPE_VIOLATION" });
  assert.equal(f.store.get(f.taskId)!.state, "needs_review"); assert.equal(f.store.operations.occupant()!.taskId, f.taskId); assert.equal(f.store.workspaceProtection.latest(f.taskId, f.store.get(f.taskId)!.attemptId)!.status, "failed");
});

test("T5 dangerous scope makes zero preparation calls; input drift during selection sends no prompt", async t => {
  const unsafe = dshFixture(t, { allowedChanges: ["src/a.txt:stream"], permittedMetadata: [] }); await assert.rejects(unsafe.send(), { code: "SCOPE_PATH_INVALID" }); assert.deepEqual(unsafe.counters(), { selections: 0, prompts: 0 });
  const changed = dshFixture(t); changed.setDuringSelection(() => changed.write("src/concurrent.js", "user input changed while awaiting selection")); const result = await changed.send(); assert.equal(result.ok, false); assert.deepEqual(changed.counters(), { selections: 1, prompts: 0 }); assert.notEqual(changed.store.operations.occupant(), null);
});

test("T5 excluded dependencies are explicit and an authorized dependency subtree is inventoried", t => {
  const excluded = fixture(t); excluded.write("node_modules/pkg/a.js", "dependency"); const original = excluded.prepare();
  excluded.write("node_modules/pkg/a.js", "unobserved excluded bytes"); assert.equal(original.check().status, "passed");
  assert.ok(original.check().excludedPaths.some(name => name.startsWith("node_modules")));
  assert.throws(() => excluded.store.workspaceProtection.authorizePath(original.taskId, "run-first", "node_modules/pkg/a.js", "write"), { code: "SCOPE_PATH_UNAUTHORIZED" });
  const explicit = fixture(t); explicit.write("node_modules/pkg/a.js", "original"); const scoped = explicit.prepare({ allowedChanges: ["node_modules/pkg/**"], permittedMetadata: [] });
  explicit.write("node_modules/pkg/a.js", "observed delta"); assert.ok(scoped.check().changes.some(change => change.path === "node_modules/pkg/a.js" && change.category === "deliverable"));
});

test("T5 semantic index changes block review even when workspace bytes are unchanged", t => {
  const f = fixture(t), git = (...args: string[]) => execFileSync("git", args, { cwd: f.workspace, stdio: "pipe", windowsHide: true });
  git("init", "-q"); git("add", "README.md"); const run = f.prepare(); git("update-index", "--force-remove", "README.md");
  assert.ok(run.check().changes.some(change => change.problem === "repository_index_conflict")); assert.throws(() => f.store.workspaceProtection.guard(run.taskId), { code: "SCOPE_USER_CHANGE_CONFLICT" });
});

test("T5 stopped stored scope projection reads no workspace and old attempts cannot authorize acceptance", async t => {
  const f = dshFixture(t); await f.send(); f.finish(); await f.coordinator.sync(f.taskId);
  const attemptId = f.store.get(f.taskId)!.attemptId!; f.store.workspaceProtection.review(f.taskId, attemptId);
  const { TaskApplicationService } = await import("../src/task-application-service.js");
  const service = new TaskApplicationService({ store: f.store } as TaskCoordinator, 2, f.runs, f.coordinator);
  const before = service.readStageView(f.taskId); assert.equal(before.ok, true);
  fs.renameSync(f.workspace, `${f.workspace}-removed`); const revision = f.store.get(f.taskId)!.revision;
  assert.deepEqual(service.readStageView(f.taskId), before); assert.equal(f.store.get(f.taskId)!.revision, revision);
  assert.equal(f.store.workspaceProtection.review(f.taskId, attemptId).status, "checker_error");
  assert.throws(() => f.store.workspaceProtection.authorizePath(f.taskId, "foreign-attempt", "src/x", "write"), { code: "STALE_ATTEMPT" });
});

test("T5 case-only renames retain their original endpoint and a large file fails before native preparation", async t => {
  const f = fixture(t); f.write("src/Case.txt", "original"); const run = f.prepare(); fs.renameSync(path.join(f.workspace, "src/Case.txt"), path.join(f.workspace, "src/case.txt"));
  assert.ok(run.check().changes.some(change => change.kind === "renamed" && change.previousPath === "src/Case.txt" && change.path === "src/case.txt"));
  const bounded = dshFixture(t), large = path.join(bounded.workspace, "src/large.bin"); fs.closeSync(fs.openSync(large, "w")); fs.truncateSync(large, 65 * 1024 * 1024);
  await assert.rejects(bounded.send(), { code: "SCOPE_SCAN_LIMIT" }); assert.deepEqual(bounded.counters(), { selections: 0, prompts: 0 });
});

test("T5 storage acceptance rejects history without a baseline instead of backfilling it", t => {
  const f = fixture(t); f.store.createOrGet({ taskId: "historical", objective: "Stored history", messageId: "old", workspace: f.workspace, state: "queued" }); f.store.beginAttempt("historical", { attemptId: "old-attempt", messageId: "old" }); f.store.update("historical", { state: "needs_review" });
  assert.throws(() => f.store.acceptAttempt("historical", "old-attempt", { state: "accepted" }, { type: "task_closed", occurredAt: new Date().toISOString(), actor: "synthetic-reviewer", payload: {}, sourceRef: "close" }), { code: "SCOPE_BASELINE_MISSING" });
  assert.equal(f.store.get("historical")!.state, "needs_review"); assert.equal(f.store.workspaceProtection.readView("historical").baseline, "missing");
});

test("T5 service exclusions resolve canonical aliases without hiding neighboring user files", t => {
  const f = fixture(t), alias = path.join(f.dir, "workspace-alias"); fs.symlinkSync(f.workspace, alias, process.platform === "win32" ? "junction" : "dir");
  const store = new TaskStore(path.join(alias, "gateway-state", "tasks.sqlite"));
  try {
    const scope = { allowedChanges: ["src/**"], permittedMetadata: [] };
    store.workspaceProtection.create("alias-task", alias, "synthetic", scope, path.join(alias, "gateway-state", "runs"));
    const guard = store.workspaceProtection.guard("alias-task");
    store.createOrGet({ taskId: "alias-task", workspace: alias, objective: "Alias fixture", messageId: "pending", state: "queued" });
    store.workspaceProtection.assertGuard(guard);
    f.write("gateway-state/user.txt", "not service-owned");
    assert.throws(() => store.workspaceProtection.assertGuard(guard), { code: "SCOPE_WORKSPACE_CHANGED" });
  } finally { store.close(); }
});

test("T5 an outside junction back into the workspace is never treated as a short-name alias", t => {
  const f = fixture(t), alias = path.join(f.dir, "outside~1"); f.write("src/input.txt", "private input");
  fs.symlinkSync(f.workspace, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => resolveWorkspaceRead(f.workspace, path.join(alias, "src/input.txt")), { code: process.platform === "win32" ? "SCOPE_PATH_LINK" : "SCOPE_PATH_OUTSIDE" });
});

test("T5 Windows short-name workspace inputs expand to the same real file", { skip: process.platform !== "win32" }, t => {
  const f = fixture(t), root = path.join(f.dir, "workspace with long names"); fs.mkdirSync(root); fs.writeFileSync(path.join(root, "input.txt"), "input");
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); (New-Object -ComObject Scripting.FileSystemObject).GetFolder('${root.replaceAll("'", "''")}').ShortPath | ConvertTo-Json -Compress`;
  const short = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim()) as string;
  assert.equal(fs.existsSync(short), true, "The Windows short-name API must return an existing path");
  if (short.toLowerCase() === fs.realpathSync.native(root).toLowerCase()) { t.skip("This volume does not expose a usable Windows short-name alias"); return; }
  assert.equal(resolveWorkspaceRead(fs.realpathSync.native(root), path.join(short, "input.txt")), fs.realpathSync.native(path.join(root, "input.txt")));
});
