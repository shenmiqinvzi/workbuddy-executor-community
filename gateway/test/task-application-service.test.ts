import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { reportDigest } from "../src/report-authentication.js";
import type { RunSnapshot } from "../src/run-journal.js";
import type { Config } from "../src/config.js";

class SnapshotClient extends WorkBuddyClient {
  snapshot?: RunSnapshot;
  sent = 0;
  override runSnapshot() { return this.snapshot; }
  override async messages() { return []; }
  override async sendMessage(...args: Parameters<WorkBuddyClient["sendMessage"]>) {
    this.sent++;
    const options = args[4]!;
    this.snapshot = { taskId: options.taskId!, attemptId: options.attemptId!, sessionId: args[3], status: "queued", updatedAt: new Date().toISOString() };
    return { messageId: options.attemptId!, raw: { code: 0, data: { message_id: options.attemptId! } } };
  }
}

test("two service instances reuse one task identity and dispatch only once", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-task-service-send-"));
  const config = { ...loadConfig(), backend: "desktop-acp" as const, dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs") };
  const firstStore = new TaskStore(config.dbFile);
  const secondStore = new TaskStore(config.dbFile);
  t.after(() => { secondStore.close(); firstStore.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = new SnapshotClient(config);
  const first = new TaskApplicationService(new TaskCoordinator(config, firstStore, client), 3, config.runsDir);
  const second = new TaskApplicationService(new TaskCoordinator(config, secondStore, client), 3, config.runsDir);
  const input = { taskId: "same-task", objective: "fix a file", workspace: dir, sessionId: "session-one" };
  const results = await Promise.all([first.send(input), second.send(input)]);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(client.sent, 1);
  await assert.rejects(() => second.send({ ...input, objective: "different work" }), /Task ID conflicts/);
  assert.equal(client.sent, 1);
});

test("separate entry point services agree and never offer review actions before matching stop proof", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-task-service-"));
  const config = { ...loadConfig(), backend: "desktop-queue" as const, dbFile: path.join(dir, "tasks.sqlite"), runsDir: path.join(dir, "runs") };
  const firstStore = new TaskStore(config.dbFile);
  const secondStore = new TaskStore(config.dbFile);
  t.after(() => { secondStore.close(); firstStore.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = new SnapshotClient(config);
  const first = new TaskApplicationService(new TaskCoordinator(config, firstStore, client), 3, config.runsDir);
  const second = new TaskApplicationService(new TaskCoordinator(config, secondStore, client), 3, config.runsDir);
  firstStore.createOrGet({ taskId: "one", messageId: "pending", objective: "fix it", state: "queued", sessionId: "session-one" });
  const attemptId = "run-00000000-0000-4000-8000-000000000001";
  firstStore.beginAttempt("one", { attemptId, messageId: attemptId, sessionId: "session-one" });

  client.snapshot = { taskId: "one", attemptId, sessionId: "session-one", driver: "desktop-queue", status: "queued", updatedAt: new Date().toISOString() };
  assert.deepEqual(first.statusView(first.requireTask("one")), second.statusView(second.requireTask("one")));
  assert.deepEqual(first.statusView(first.requireTask("one")).allowedActions, ["cancel"]);

  firstStore.updateAttempt("one", attemptId, {
    state: "needs_review", runtimeSource: "desktop_queue",
    report: { rawText: "TASK_STATUS: completed", filesChanged: [], commandsRun: [] },
  });
  client.snapshot = { ...client.snapshot, status: "needs_review", reportDigest: "digest" };
  assert.equal(first.statusView(first.requireTask("one")).displayState, "waiting_stop");
  assert.deepEqual(first.statusView(first.requireTask("one")).allowedActions, []);

  client.snapshot = { ...client.snapshot, taskId: "other", nativeStoppedAt: new Date().toISOString(), nativeStopSource: "native_idle" };
  assert.equal(first.statusView(first.requireTask("one")).remoteStopped, false);
  assert.deepEqual(first.statusView(first.requireTask("one")).allowedActions, []);

  client.snapshot = { ...client.snapshot, taskId: "one", sessionId: "other-session" };
  assert.equal(first.statusView(first.requireTask("one")).remoteStopped, false);
  client.snapshot = { ...client.snapshot, sessionId: "session-one", attemptId: "run-00000000-0000-4000-8000-000000000002" };
  assert.equal(first.statusView(first.requireTask("one")).remoteStopped, false);

  client.snapshot = { ...client.snapshot, attemptId };
  const withoutDigest = { ...client.snapshot };
  delete withoutDigest.reportDigest;
  client.snapshot = withoutDigest;
  assert.deepEqual(first.statusView(first.requireTask("one")).allowedActions, ["rework"]);
  client.snapshot = { ...client.snapshot, reportDigest: "digest" };
  const view = first.statusView(first.requireTask("one"));
  assert.equal(view.displayState, "needs_review");
  assert.deepEqual(view.allowedActions, ["rework", "accept"]);
  assert.deepEqual(view, second.statusView(second.requireTask("one")));

  const reportedSnapshot = client.snapshot;
  firstStore.updateAttempt("one", attemptId, { state: "blocked" });
  client.snapshot = { ...client.snapshot, status: "blocked", nativeStoppedAt: new Date().toISOString(), nativeStopSource: "native_idle",
    nativeFailure: { wakeId: `wake-${attemptId}`, error: "429 too many requests", observedAt: new Date().toISOString() } };
  const failedTurn = first.statusView(first.requireTask("one"));
  assert.equal(failedTurn.displayState, "waiting_stop", "a native failure plus one idle observation cannot release the shared task view");
  assert.equal(failedTurn.remoteStopped, false);
  assert.deepEqual(failedTurn.allowedActions, []);
  assert.deepEqual(failedTurn, second.statusView(second.requireTask("one")));
  await assert.rejects(() => first.continue({ taskId: "one", feedback: "overlap" }), /not been confirmed stopped/);
  assert.equal(client.sent, 0);

  client.snapshot = reportedSnapshot;
  firstStore.updateAttempt("one", attemptId, { state: "cancelled" });
  assert.equal(second.statusView(second.requireTask("one")).displayState, "cancelled");
  assert.deepEqual(second.statusView(second.requireTask("one")).allowedActions, []);
  client.snapshot = { ...client.snapshot, nativeStoppedAt: undefined, nativeStopSource: undefined };
  assert.equal(second.statusView(second.requireTask("one")).displayState, "waiting_stop");
  assert.deepEqual(second.statusView(second.requireTask("one")).allowedActions, []);
});

/**
 * Stage-1 read query tests.
 *
 * The config is built explicitly so the fixture does not depend on how many
 * WorkBuddy installations exist on the machine running the tests; everything
 * is synthetic and isolated in a temporary directory.
 */
function stageFixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-service-stage-"));
  const config: Config = {
    backend: "desktop-queue",
    apiBaseUrl: "http://127.0.0.1/unreachable",
    tokenFile: path.join(dir, "credentials.json"),
    dbFile: path.join(dir, "tasks.sqlite"),
    oauthRedirectUri: "http://127.0.0.1:0/oauth",
    oauthPort: 0,
    oauthScopes: "test",
    requestTimeoutMs: 1000,
    cliElectronPath: path.join(dir, "no-electron.exe"),
    cliScriptPath: path.join(dir, "no-cli"),
    cliPermissionMode: "deny",
    acpPermissionMode: "deny",
    gatewayUrl: "http://127.0.0.1:0",
    workbuddyConfigDir: path.join(dir, "workbuddy-config"),
    runsDir: path.join(dir, "runs"),
    taskTimeoutSeconds: 600,
    claimTimeoutSeconds: 60,
    maxTaskAttempts: 3,
    serviceConfigFile: path.join(dir, "persistent-service.json"),
  };
  const store = new TaskStore(config.dbFile);
  const coordinator = new TaskCoordinator(config, store, new WorkBuddyClient(config));
  const service = new TaskApplicationService(coordinator, 3, config.runsDir!);
  // The SQLite handle (and its WAL/SHM sidecar files) keeps the directory
  // locked on Windows until the process exits, so the temp directory is left
  // for OS temp cleanup instead of blocking the runner on rmSync (EPERM).
  t.after(() => { store.close(); });
  let counter = 0;
  const seed = (options: { taskId: string; createdAt: string; state?: import("../src/task-store.js").TaskState; stop?: boolean; authenticated?: boolean; snapshotPatch?: Partial<RunSnapshot> }) => {
    counter += 1;
    const attemptId = `run-10000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
    const sessionId = "session-stage-1";
    const state = options.state ?? "needs_review";
    store.createOrGet({ taskId: options.taskId, messageId: `msg-${options.taskId}`, objective: `objective ${options.taskId}`, state: "queued", createdAt: options.createdAt, sessionId, runtimeSource: "desktop_queue", workspace: dir });
    store.beginAttempt(options.taskId, { attemptId, messageId: `msg-${options.taskId}`, sessionId });
    store.update(options.taskId, { state });
    store.updateAttempt(options.taskId, attemptId, { state, runtimeSource: "desktop_queue" });
    const runDir = path.join(config.runsDir!, attemptId);
    fs.mkdirSync(runDir, { recursive: true });
    const text = "TASK_STATUS: completed\nsynthetic report";
    const digest = reportDigest({ status: "completed", text, artifacts: [] });
    // The run-journal snapshot status is narrower than the store state; map
    // the store state into the closest snapshot status.
    const snapshotStatus: import("../src/run-journal.js").RunStatus
      = state === "accepted" || state === "completed" ? "needs_review"
      : state === "blocked" || state === "failed" || state === "cancelled" || state === "queued" || state === "working" || state === "needs_review" ? state
      : "needs_review";
    const snapshot: RunSnapshot = {
      attemptId, taskId: options.taskId, status: snapshotStatus, driver: "desktop-queue",
      sessionId, runtimeSource: "desktop_queue", text,
      reportDigest: digest, updatedAt: options.createdAt, ...options.snapshotPatch,
      ...(options.stop ? { nativeStoppedAt: "2026-10-18T10:30:00.000Z", nativeStopSource: "native_idle" as const } : {}),
      ...(options.authenticated ? { reportAuthentication: { formatVersion: 1, taskId: options.taskId, attemptId, sessionId, runtimeSource: "desktop_queue", reportedStatus: "completed", reportDigest: digest, authenticatedAt: options.createdAt } } : {}),
    };
    fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(snapshot));
    return attemptId;
  };
  return { dir, store, service, seed };
}

test("stage detail keeps stored facts, gaps and unknown values without inventing contract fields", async t => {
  const f = stageFixture(t);
  f.seed({ taskId: "stage-a", createdAt: "2026-10-18T10:00:00.000Z", stop: true, authenticated: true });
  const result = f.service.readStageView("stage-a");
  assert.equal(result.ok, true);
  if (!result.ok) throw Error("expected a view");
  const view = result.view;
  assert.equal(result.schemaVersion, "workbuddy-executor/stage-2");
  assert.equal(typeof view.revision, "string", "T2 persists a revision for rows that have fact changes");
  assert.notEqual(view.revision, null, "no persisted revision is invented; the seeded row earned one");
  assert.equal(view.title, null, "the objective is not relabelled as a title");
  assert.deepEqual(view.workspace, { id: null, displayName: null, storedPath: f.dir });
  assert.deepEqual(view.allowedActions, []);
  assert.deepEqual(view.checks, []);
  assert.deepEqual(view.changes, []);
  assert.deepEqual(view.artifacts, []);
  assert.equal(view.metrics, null);
  assert.equal(view.blocker, null);
  assert.equal(view.businessState, "needs_review");
  assert.equal(view.displayState, "needs_review");
  assert.equal(view.remoteStopped, true);
  assert.equal(view.timing.createdAt, "2026-10-18T10:00:00.000Z");
  assert.equal(view.timing.nativeStoppedAt, "2026-10-18T10:30:00.000Z");
  assert.equal(view.timing.attemptDeadlineAt, null);
  assert.equal(view.timing.terminalDecisionAt, null);
  assert.equal(view.timing.closedAt, null);
  assert.equal(typeof view.timing.lastObservedAt, "string", "lastObservedAt is the stored save time");
  assert.ok(result.unavailable.includes("title_unavailable"), "title stays unavailable; the objective is not relabelled");
  assert.ok(result.unavailable.includes("metrics_unavailable"));

  // The projection keeps its action-capability gaps; none of the unavailable
  // facts is filled by this stage view.
  const projection = f.service.readProjection("stage-a");
  assert.equal(projection.ok, true);
  if (projection.ok) {
    assert.ok(projection.projection.gaps.some(gap => gap.code === "required_checks_unavailable"));
    assert.ok(projection.projection.gaps.some(gap => gap.code === "review_id_unavailable"));
  }
});

test("stage detail reports a missing task and a bad id without pretending an empty page", async t => {
  const f = stageFixture(t);
  const missing = f.service.readStageView("no-such-task");
  assert.equal(missing.ok, false);
  if (missing.ok) throw Error("expected failure");
  assert.equal(missing.code, "task_not_found");
  assert.equal(missing.taskId, "no-such-task");

  const invalid = f.service.readStageView("");
  assert.equal(invalid.ok, false);
  if (invalid.ok) throw Error("expected failure");
  assert.equal(invalid.code, "invalid_task_id");
});

test("stage detail keeps distinguishable failures for corrupt records instead of empty answers", async t => {
  const f = stageFixture(t);
  const attemptId = f.seed({ taskId: "stage-corrupt", createdAt: "2026-10-18T10:00:00.000Z", stop: true });
  const runDir = path.join(f.dir, "runs", attemptId);
  fs.writeFileSync(path.join(runDir, "state.json"), "{not json");
  const corrupt = f.service.readStageView("stage-corrupt");
  assert.equal(corrupt.ok, false);
  if (corrupt.ok) throw Error("expected failure");
  assert.equal(corrupt.code, "state_corrupt");
});

test("stage list applies the stable cursor order and validates the cursor", async t => {
  const f = stageFixture(t);
  for (let index = 0; index < 4; index++) {
    f.seed({ taskId: `stage-list-${index}`, createdAt: `2026-10-18T1${index}:00:00.000Z` });
  }
  const first = f.service.listStageViews({ limit: 2 });
  assert.equal(first.ok, true);
  if (!first.ok) throw Error("expected a page");
  assert.deepEqual(first.tasks.map(view => view.taskId), ["stage-list-0", "stage-list-1"]);
  assert.equal(first.nextAfterTaskId, "stage-list-1");

  const second = f.service.listStageViews({ limit: 2, afterTaskId: "stage-list-1" });
  assert.equal(second.ok, true);
  if (!second.ok) throw Error("expected a page");
  assert.deepEqual(second.tasks.map(view => view.taskId), ["stage-list-2", "stage-list-3"]);
  assert.equal(second.nextAfterTaskId, null);

  // Updating a task between pages must not move it across the cursor.
  f.store.update("stage-list-0", { reviewNote: "touched" });
  const again = f.service.listStageViews({ limit: 2, afterTaskId: "stage-list-1" });
  assert.equal(again.ok, true);
  if (!again.ok) throw Error("expected a page");
  assert.deepEqual(again.tasks.map(view => view.taskId), ["stage-list-2", "stage-list-3"]);

  const badCursor = f.service.listStageViews({ limit: 2, afterTaskId: "missing" });
  assert.equal(badCursor.ok, false);
  if (badCursor.ok) throw Error("expected failure");
  assert.equal(badCursor.code, "invalid_cursor");

  const badLimit = f.service.listStageViews({ limit: 0 });
  assert.equal(badLimit.ok, false);
  const bigLimit = f.service.listStageViews({ limit: 101 });
  assert.equal(bigLimit.ok, false);
});

test("stage views of a stored report without an authentication record stay unknown", async t => {
  const f = stageFixture(t);
  // Report with a digest but no authentication record: report unknown. With
  // the stop proven the display cannot claim needs_review (that requires an
  // authenticated report) and cannot claim queued/running either, so it
  // degrades to unknown with the reason recorded in the projection gaps.
  f.seed({ taskId: "stage-unknown-report", createdAt: "2026-10-18T10:00:00.000Z", stop: true });
  const result = f.service.readStageView("stage-unknown-report");
  assert.equal(result.ok, true);
  if (!result.ok) throw Error("expected a view");
  assert.equal(result.view.displayState, "unknown");
  assert.equal(result.view.remoteStopped, true);
  const projection = f.service.readProjection("stage-unknown-report");
  assert.equal(projection.ok, true);
  if (projection.ok) {
    assert.ok(projection.projection.gaps.some(gap => gap.code === "report_authentication_missing"));
  }
});

test("stage view keeps a queue-authenticated pre-stop report at waiting_stop", async t => {
  const f = stageFixture(t);
  // The queue authenticated the report but no stop proof exists yet: the
  // report arrived before the stop, so the display must stay waiting_stop.
  f.seed({ taskId: "stage-early-report", createdAt: "2026-10-18T10:00:00.000Z", authenticated: true });
  const result = f.service.readStageView("stage-early-report");
  assert.equal(result.ok, true);
  if (!result.ok) throw Error("expected a view");
  assert.equal(result.view.displayState, "waiting_stop");
  assert.equal(result.view.remoteStopped, false);
  assert.equal(result.view.timing.nativeStoppedAt, null, "no stop instant is copied without a bound proof");
});

test("stage detail keeps one round when a concurrent rework changes the attempt mid-read", async t => {  const f = stageFixture(t);
  const attemptA = f.seed({ taskId: "stage-race", createdAt: "2026-10-18T10:00:00.000Z", stop: true, authenticated: true });
  // Interpose a rework (new attempt B, working) between the projection's own
  // reads and the view assembly, exactly the window a second store.get used
  // to open. The view must describe attempt A only.
  const original = f.service.readProjection.bind(f.service);
  const service = f.service as unknown as { readProjection: (taskId: string) => unknown };
  service.readProjection = (taskId: string) => {
    const result = original(taskId) as { ok: boolean };
    if (result.ok) {
      const attemptB = `run-b0000000-0000-4000-8000-${"1".padStart(12, "0")}`;
      f.store.beginAttempt("stage-race", { attemptId: attemptB, messageId: "msg-stage-race", sessionId: "session-stage-1" });
      f.store.update("stage-race", { state: "working" });
      f.store.updateAttempt("stage-race", attemptB, { state: "working", runtimeSource: "desktop_queue" });
    }
    return result;
  };
  const result = f.service.readStageView("stage-race");
  assert.equal(result.ok, true);
  if (!result.ok) throw Error("expected a view");
  assert.equal(result.view.attempt.id, attemptA, "the view describes the projected round, not a later one");
  assert.equal(result.view.businessState, "needs_review");
  assert.equal(result.view.displayState, "needs_review");
  assert.equal(result.view.remoteStopped, true);
  service.readProjection = original;
});

test("stage detail stays one consistent snapshot when a concurrent acceptance keeps the same attemptId", async t => {
  const f = stageFixture(t);
  const attemptA = f.seed({ taskId: "stage-accept-race", createdAt: "2026-10-18T10:00:00.000Z", stop: true, authenticated: true });
  // A real second connection accepts the SAME attempt between the reader's
  // two store.get calls: the attempt id never changes, so the reader's
  // attempt-identity re-check passes and the first read row (needs_review)
  // is what the projection is built from. The view must describe that one
  // snapshot — never businessState accepted with a needs_review display, and
  // never accepted row values next to a pre-acceptance projection.
  const otherStore = new TaskStore(f.store.file);
  // SQLite keeps WAL/SHM handles open, so this temp directory is not removed
  // here; the OS temp cleanup owns it (same policy as the other stage tests
  // that hold a second store connection).
  t.after(() => { otherStore.close(); });
  // Interpose inside readTaskProjection's real read window: patch the
  // reader's own store.get BEFORE the read starts, let the first store.get
  // pass through untouched, and land a real acceptance from a second
  // connection just before the re-check store.get. The attempt id stays the
  // same, so the reader's identity re-check passes — exactly the window
  // where returning `row: after` would mix two snapshots into one answer.
  const readerStore = f.store as unknown as { get: (id: string) => unknown };
  const realGet = readerStore.get.bind(readerStore);
  let gets = 0;
  readerStore.get = (id: string) => {
    gets += 1;
    if (id === "stage-accept-race" && gets === 2) {
      readerStore.get = realGet;
      const accepted = otherStore.updateAttempt("stage-accept-race", attemptA, { state: "accepted", reviewNote: "verified by another connection", reviewedAt: "2026-10-18T10:40:00.000Z" }, { expectedStates: ["needs_review", "completed"] });
      assert.equal(accepted.applied, true, "the concurrent acceptance lands between the two store.get calls");
    }
    return realGet(id);
  };
  const result = f.service.readStageView("stage-accept-race");
  readerStore.get = realGet;
  assert.ok(gets >= 2, "the reader must perform its re-check store.get");
  assert.equal(result.ok, true, "same attemptId must not be a read_conflict");
  if (!result.ok) throw Error("expected a view");
  const view = result.view;
  // One consistent snapshot: every row fact and the projection must come
  // from the same read of the task row.
  const consistentPreAccept = view.businessState === "needs_review"
    && view.displayState === "needs_review"
    && view.timing.reviewedAt === null
    && view.remoteStopped === true;
  // A full post-acceptance snapshot would also be consistent, but the
  // projection was built from the pre-acceptance read, so that combination
  // (accepted row values beside a needs_review projection) is the mixture
  // the previous implementation produced and must never appear.
  assert.ok(consistentPreAccept, `the view must be one consistent snapshot, got businessState=${view.businessState} displayState=${view.displayState} reviewedAt=${view.timing.reviewedAt}`);
  assert.equal(view.attempt.id, attemptA);
});

test("stage list stays per-item consistent when a concurrent acceptance keeps the same attemptId", async t => {
  const f = stageFixture(t);
  const attemptA = f.seed({ taskId: "stage-list-race", createdAt: "2026-10-18T10:00:00.000Z", stop: true, authenticated: true });
  const otherStore = new TaskStore(f.store.file);
  // SQLite keeps WAL/SHM handles open, so this temp directory is not removed
  // here; the OS temp cleanup owns it (same policy as the other stage tests
  // that hold a second store connection).
  t.after(() => { otherStore.close(); });
  // Same interposition as the detail test: patch the reader's own store.get
  // before the page read starts, and land a real acceptance from a second
  // connection between the first store.get and the re-check store.get, with
  // the attempt id unchanged.
  const readerStore = f.store as unknown as { get: (id: string) => unknown };
  const realGet = readerStore.get.bind(readerStore);
  let gets = 0;
  readerStore.get = (id: string) => {
    gets += 1;
    if (id === "stage-list-race" && gets === 2) {
      readerStore.get = realGet;
      const accepted = otherStore.updateAttempt("stage-list-race", attemptA, { state: "accepted", reviewedAt: "2026-10-18T10:40:00.000Z" }, { expectedStates: ["needs_review", "completed"] });
      assert.equal(accepted.applied, true, "the concurrent acceptance lands between the two store.get calls");
    }
    return realGet(id);
  };
  const page = f.service.listStageViews({ limit: 10 });
  readerStore.get = realGet;
  assert.ok(gets >= 2, "the reader must perform its re-check store.get");
  assert.equal(page.ok, true);
  if (!page.ok) throw Error("expected a page");
  const entry = page.tasks.find(item => item.ok && item.view.taskId === "stage-list-race");
  assert.ok(entry && entry.ok, "the raced task must appear in the page");
  if (entry.ok) {
    assert.equal(entry.view.businessState, "needs_review");
    assert.equal(entry.view.displayState, "needs_review");
    assert.equal(entry.view.timing.reviewedAt, null);
  }
});

test("stage list keeps a per-item failure instead of an empty view or a masked error", async t => {
  const f = stageFixture(t);
  f.seed({ taskId: "stage-list-ok", createdAt: "2026-10-18T10:00:00.000Z", stop: true, authenticated: true });
  f.seed({ taskId: "stage-list-bad", createdAt: "2026-10-18T11:00:00.000Z" });
  const attemptId = f.store.get("stage-list-bad")!.attemptId!;
  fs.writeFileSync(path.join(f.dir, "runs", attemptId, "state.json"), "{not json");
  const result = f.service.listStageViews({ limit: 10 });
  assert.equal(result.ok, true);
  if (!result.ok) throw Error("expected a page");
  assert.equal(result.tasks.length, 2);
  const good = result.tasks[0]!;
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.view.taskId, "stage-list-ok");
    assert.equal(good.view.displayState, "needs_review");
  }
  const bad = result.tasks[1]!;
  assert.equal(bad.ok, false, "the corrupt record is reported, not turned into displayState null");
  if (!bad.ok) {
    assert.equal(bad.taskId, "stage-list-bad");
    assert.equal(bad.code, "state_corrupt");
    assert.equal(bad.field, "state.json");
  }
});

test("stage list reports a store failure as store_unavailable, never as a cursor error", async t => {
  const f = stageFixture(t);
  f.seed({ taskId: "stage-store-fail", createdAt: "2026-10-18T10:00:00.000Z", state: "working" });
  const store = f.store as unknown as { listTasksByCreatedCursor: () => never; hasTaskAfterCursor: () => never };
  store.listTasksByCreatedCursor = () => { throw new Error("database is locked"); };
  const listFailure = f.service.listStageViews({ limit: 10 });
  assert.equal(listFailure.ok, false);
  if (!listFailure.ok) {
    assert.equal(listFailure.code, "store_unavailable");
    assert.equal(listFailure.field, "store.listTasksByCreatedCursor");
  }
  // The next-page probe fails the same way.
  const workingStore = f.store as unknown as { listTasksByCreatedCursor: () => unknown };
  workingStore.listTasksByCreatedCursor = () => ({ tasks: f.store.get("stage-store-fail") ? [f.store.get("stage-store-fail")] : [], anchorFound: true });
  store.hasTaskAfterCursor = () => { throw new Error("database is locked"); };
  const probeFailure = f.service.listStageViews({ limit: 10 });
  assert.equal(probeFailure.ok, false);
  if (!probeFailure.ok) {
    assert.equal(probeFailure.code, "store_unavailable");
    assert.equal(probeFailure.field, "store.hasTaskAfterCursor");
  }
});

// ---------------------------------------------------------------------------
// T2: persistent task events and revision.
// ---------------------------------------------------------------------------

test("task events stay monotonic across attempts, dedup journal replays and resume after a restart", async t => {
  const f = stageFixture(t);
  const attemptA = f.seed({ taskId: "stage-events", createdAt: "2026-10-18T10:00:00.000Z", stop: true, authenticated: true });
  const attemptB = f.seed({ taskId: "stage-events", createdAt: "2026-10-18T10:00:00.000Z", state: "working" });

  // Journal mirror: the same native event seq replays idempotently (dedup by
  // attemptId+type+journal:seq), and a second attempt continues the cursor
  // without restarting at 1.
  const journalA = [
    { seq: 1, type: "status", createdAt: "2026-10-18T10:05:00.000Z", metadata: { text: "waking worker" } },
    { seq: 2, type: "result", createdAt: "2026-10-18T10:06:00.000Z", metadata: { text: "report ready" } },
  ];
  const firstPass = f.store.mirrorJournalEvents("stage-events", journalA, { attemptId: attemptA, actor: "workbuddy" });
  assert.equal(firstPass.length, 2, "two fresh journal events append");
  const replay = f.store.mirrorJournalEvents("stage-events", journalA, { attemptId: attemptA, actor: "workbuddy" });
  assert.equal(replay.length, 0, "the same journal events replay to zero new events");
  const journalB = [
    { seq: 1, type: "status", createdAt: "2026-10-18T11:05:00.000Z", metadata: { text: "rework round" } },
  ];
  const secondPass = f.store.mirrorJournalEvents("stage-events", journalB, { attemptId: attemptB, actor: "workbuddy" });
  assert.equal(secondPass.length, 1, "the second attempt's journal appends");

  const page = f.store.listTaskEvents("stage-events", { afterEventId: 0, limit: 200 });
  assert.ok(page.events.length >= 3, `seed+mirror events exist, got ${page.events.length}`);
  const ids = page.events.map(event => event.eventId);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "eventIds ascend");
  assert.equal(new Set(ids).size, ids.length, "eventIds are unique");
  // Monotonic across attempts: the cursor is one shared per-task sequence.
  // attempt-B events (seeds and mirrors alike) are appended after every
  // attempt-A event that already exists, and the mirror of a late journal
  // page never renumbers to a per-attempt 1. Anchor on the last attempt-A
  // event present before the attempt-B mirror: everything belonging to
  // attempt B must exceed the maximum attempt-A id.
  const attemptBIds = page.events.filter(event => event.attemptId === attemptB).map(event => event.eventId);
  const attemptAIds = page.events.filter(event => event.attemptId === attemptA).map(event => event.eventId);
  assert.ok(attemptBIds.length > 0 && attemptAIds.length > 0, "both attempts have events");
  const maxAttemptAId = Math.max(...attemptAIds);
  assert.ok(secondPass.every(event => event.eventId > maxAttemptAId), "the second attempt's mirrored events continue the shared cursor past every attempt-A event");
  assert.ok(Math.min(...attemptBIds) >= Math.min(...attemptAIds), "per-task ascending order holds");
  const mirrored = page.events.find(event => event.attemptId === attemptB && event.type === "status");
  assert.ok(mirrored, "the attempt-B journal event is mirrored");
  if (mirrored) {
    assert.equal(mirrored.payload.nativeEventSeq, 1, "the native per-attempt seq is preserved as payload.nativeEventSeq");
    assert.ok(typeof mirrored.sourceRef === "string" && mirrored.sourceRef.includes("journal:1"), "the dedup source ref names the journal seq");
  }

  // Cursor paging resumes: afterEventId is exclusive.
  const anchor = page.events[1]!;
  const rest = f.store.listTaskEvents("stage-events", { afterEventId: anchor.eventId, limit: 200 });
  assert.equal(rest.events[0]?.eventId, anchor.eventId + 1, "afterEventId is exclusive; the next page starts at anchor+1");
  assert.equal(rest.events.some(event => event.eventId === anchor.eventId), false, "the anchor itself is not re-served");

  // Restart: a fresh store instance over the same file reads the same stream.
  const reopened = new TaskStore(f.store.file);
  t.after(() => { reopened.close(); });
  const afterRestart = reopened.listTaskEvents("stage-events", { afterEventId: 0, limit: 200 });
  assert.deepEqual(afterRestart.events.map(event => event.eventId), ids, "the persisted stream survives a restart");
  // And continues monotonically from the persisted maximum.
  const appended = reopened.appendTaskEvent({ taskId: "stage-events", attemptId: attemptB, type: "recovery_recorded", occurredAt: "2026-10-18T12:00:00.000Z", observedAt: "2026-10-18T12:00:00.000Z", actor: "gateway", payload: {}, sourceRef: null });
  assert.equal(appended.eventId, Math.max(...ids) + 1, "a new event continues the persisted maximum");
});

test("listTaskEvents refuses missing tasks and bad cursors and never writes", async t => {
  const f = stageFixture(t);
  const missing = f.service.listTaskEvents("no-such-task", {});
  assert.equal(missing.ok, false);
  if (missing.ok) throw Error("expected failure");
  assert.equal(missing.code, "task_not_found");

  const badCursor = f.service.listTaskEvents("stage-a", { afterEventId: -1 });
  assert.equal(badCursor.ok, false);
  if (badCursor.ok) throw Error("expected failure");
  assert.equal(badCursor.code, "invalid_cursor");

  const badLimit = f.service.listTaskEvents("stage-a", { limit: 201 });
  assert.equal(badLimit.ok, false);
  if (badLimit.ok) throw Error("expected failure");
  assert.equal(badLimit.code, "invalid_cursor");

  const badId = f.service.listTaskEvents("", {});
  assert.equal(badId.ok, false);
  if (badId.ok) throw Error("expected failure");
  assert.equal(badId.code, "invalid_task_id");
});

test("revision persists per fact change, is unguessable and never time-derived, and pure polls change nothing", async t => {
  const f = stageFixture(t);
  const attemptA = f.seed({ taskId: "stage-revision", createdAt: "2026-10-18T10:00:00.000Z", stop: true, authenticated: true });
  const before = f.store.get("stage-revision")!;
  assert.ok(before.revision, "the seeded fact changes earned a revision");
  const first = before.revision!;

  // A pure read/poll (updateAttempt with only lastMessageId/lastEventSeq —
  // the sync path) must not regenerate the revision or emit a fact event.
  const eventsBeforePoll = f.store.listTaskEvents("stage-revision", { afterEventId: 0, limit: 200 }).events.length;
  f.store.updateAttempt("stage-revision", attemptA, { lastEventSeq: 99 });
  const afterPoll = f.store.get("stage-revision")!;
  assert.equal(afterPoll.revision, first, "a pure poll keeps the revision");
  const eventsAfterPoll = f.store.listTaskEvents("stage-revision", { afterEventId: 0, limit: 200 }).events.length;
  assert.equal(eventsAfterPoll, eventsBeforePoll, "a pure poll emits no fact event");

  // A real fact change (state) regenerates the revision and emits one event.
  f.store.update("stage-revision", { state: "cancelled" });
  const afterChange = f.store.get("stage-revision")!;
  assert.notEqual(afterChange.revision, first, "a fact change regenerates the revision");
  assert.ok(afterChange.revision, "the new revision persists");
  // Uniqueness/unguessability shape: base64url, 16 chars from 12 bytes, no
  // timestamp prefix (two consecutive revisions share no structure).
  assert.match(afterChange.revision!, /^[A-Za-z0-9_-]{16}$/);
  const events = f.store.listTaskEvents("stage-revision", { afterEventId: 0, limit: 200 }).events;
  assert.equal(events.length, eventsAfterPoll + 1, "one fact event for the state change");
  const last = events.at(-1)!;
  assert.equal(last.type, "task_state_changed");
  assert.equal(last.actor, "gateway");
  assert.ok("after" in last.payload && "before" in last.payload, "the fact event names before and after signatures");
});
