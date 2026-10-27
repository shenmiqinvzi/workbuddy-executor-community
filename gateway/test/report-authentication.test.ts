/**
 * Report authentication: persistence at the real report entry, and the mapping
 * the read-only projection derives from it.
 *
 * The report is written through a real DesktopQueue (the same claim, lease and
 * desktop-registration checks production uses) and then read back through the
 * reader and the registered MCP tool. Nothing here hand-builds an
 * "authenticated" snapshot, so a broken writer cannot hide behind a hand-made
 * fixture.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "../src/config.js";
import { DesktopQueue } from "../src/desktop-queue.js";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { TaskCoordinator, runEvidenceDigestOf } from "../src/coordinator.js";
import { RunJournal } from "../src/run-journal.js";
import { readTaskProjection, registerTaskProjectionTool } from "../src/task-view-reader.js";
import { REPORT_AUTHENTICATION_FORMAT, reportDigest } from "../src/report-authentication.js";

const SESSION = "authz-session";

/**
 * A queue wired to a temporary database, runs directory and native session
 * table. The actor is injected so the fixture does not need a real desktop
 * process, exactly as the existing queue tests do.
 */
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-authz-"));
  const config: Config = {
    ...loadConfig(),
    backend: "desktop-queue",
    dbFile: path.join(dir, "tasks.sqlite"),
    workbuddyConfigDir: dir,
    runsDir: path.join(dir, "runs"),
  };
  const native = new DatabaseSync(path.join(dir, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES (?, ?, 0, NULL)").run(SESSION, dir);
  native.close();
  const store = new TaskStore(config.dbFile);
  const client = new WorkBuddyClient(config);
  const coordinator = new TaskCoordinator(config, store, client);
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const send = (taskId = "authz-task") =>
    coordinator.send({ taskId, objective: "Authentication fixture", workspace: dir, sessionId: SESSION, constraints: [], timeoutSeconds: 600 });
  const claimFor = async () => {
    const claim = await queue.claim(SESSION, 0);
    if (claim.status !== "task") throw new Error("expected a claim");
    // No message mirror runs here: the production path is
    // send -> claim -> report -> stop confirmation -> query, and the task row's
    // runtime source is still empty at that point. The row's evidence digest is
    // persisted through explicit recordRunEvidence syncs where a test asserts
    // projection facts; T2-R1 binds every answer to that persisted digest.
    return claim;
  };
  return { dir, config, store, coordinator, queue, send, claimFor };
}

/** Read the run snapshot the queue just wrote. */
function snapshotOf(config: Config, attemptId: string) {
  return new RunJournal(config.runsDir!, attemptId).snapshot()!;
}

/**
 * Persist the current run-file evidence digest into the task row exactly like
 * recordRunEvidence does, but without any message mirror (so runtimeSource
 * stays empty). T2-R1 binds every projection answer to this digest.
 */
function syncEvidence(f: ReturnType<typeof fixture>): void {
  const task = f.store.get("authz-task")!;
  if (!task.attemptId) return;
  const snapshot = snapshotOf(f.config, task.attemptId);
  if (!snapshot) return;
  const digest = runEvidenceDigestOf(snapshot);
  if (digest !== task.runEvidenceDigest) f.store.updateAttempt(task.taskId, task.attemptId, { runEvidenceDigest: digest });
}

/** Project the task through the reader, as the tool does. */
function project(config: Config, store: TaskStore, taskId: string) {
  return readTaskProjection({ store: store as never, runsDir: config.runsDir! }, taskId);
}

/* ------------------------------------------------------------------ *
 * The whole chain without coordinator.sync()
 * ------------------------------------------------------------------ */

/** Every file under the attempt directory, by name and content. */
function runFileSnapshot(config: Config, attemptId: string): Record<string, string> {
  const directory = path.join(config.runsDir!, attemptId);
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(directory).sort()) {
    out[name] = fs.readFileSync(path.join(directory, name), "utf8");
  }
  return out;
}

test("send, claim and report authenticate without ever calling coordinator.sync", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nNo sync anywhere", artifacts: [] });
  // T2-R1: the answer must be bound to the persisted evidence digest, so the
  // report facts are synced into the row (recordRunEvidence only 鈥?no message
  // mirror runs, so runtimeSource stays empty).
  syncEvidence(f);

  // The task row really is still lagging: this is the state the query must cope
  // with, not a fixture convenience.
  assert.equal(f.store.get("authz-task")!.runtimeSource, undefined, "the fixture must not sync the task row");

  const result = project(f.config, f.store, "authz-task");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.projection.facts!.report.state, "authenticated");
  assert.equal(result.projection.facts!.report.attemptId, claim.attemptId);
  assert.equal(result.projection.displayState, "waiting_stop");
  // A missing stored source is still reported as a gap; it is not patched in.
  assert.ok(result.projection.gaps.some(gap => gap.code === "runtime_source_missing"));
  assert.equal(result.projection.facts!.trust.identityMatches, null, "trust must not be promoted from a missing field");
});

test("the same unsynced chain reaches needs_review after a real stop confirmation", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nStop follows", artifacts: [] });
  syncEvidence(f);
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  // The stop confirmation changes the persisted conditions, so the synced
  // revision must move with it before the projection can describe it.
  syncEvidence(f);

  assert.equal(f.store.get("authz-task")!.runtimeSource, undefined);
  const result = project(f.config, f.store, "authz-task");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.projection.facts!.report.state, "authenticated");
  assert.equal(result.projection.facts!.stop.proven, true);
  assert.equal(result.projection.displayState, "needs_review");
  assert.deepEqual(result.projection.allowedActions, ["export"]);
  assert.equal(result.projection.actionFacts, null);
});

test("the registered tool agrees with the unsynced chain", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTool, no sync", artifacts: [] });
  syncEvidence(f);
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  syncEvidence(f);

  const server = new McpServer({ name: "authz-nosync", version: "0.0.0" });
  registerTaskProjectionTool(server, { store: f.store as never, runsDir: f.config.runsDir! });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "authz-nosync-client", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "workbuddy_get_task_projection", arguments: { taskId: "authz-task" } });
    const text = (response.content as Array<{ type: string; text?: string }>).find(part => part.type === "text")?.text ?? "{}";
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.projection.facts.report.state, "authenticated");
    assert.equal(payload.projection.displayState, "needs_review");
  } finally {
    await client.close();
    await server.close();
  }
});

test("the query changes neither the task record nor the run files", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nRead only", artifacts: [] });

  const taskBefore = JSON.stringify(f.store.get("authz-task"));
  const filesBefore = runFileSnapshot(f.config, claim.attemptId);
  project(f.config, f.store, "authz-task");
  project(f.config, f.store, "authz-task");

  assert.equal(JSON.stringify(f.store.get("authz-task")), taskBefore, "the query must not write the task row");
  assert.deepEqual(runFileSnapshot(f.config, claim.attemptId), filesBefore, "the query must not write run files");
});

/* ------------------------------------------------------------------ *
 * A missing source versus a conflicting one
 * ------------------------------------------------------------------ */

test("a missing task source is verified from the current round", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nMissing row source", artifacts: [] });
  syncEvidence(f);
  assert.equal(f.store.get("authz-task")!.runtimeSource, undefined);

  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "authenticated");
});

test("an explicitly conflicting task source refuses authentication", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nConflicting source", artifacts: [] });
  syncEvidence(f);
  // Now the task row names a different source than the round and the record.
  f.store.update("authz-task", { runtimeSource: "desktop_acp" });

  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "unknown");
  // The association check catches this first and rejects the snapshot as
  // foreign, so authentication is never even attempted. Either way the report
  // is not authenticated and the conflict is named.
  assert.ok(outcome.codes.some(code => code.startsWith("report_authentication_")));
  assert.ok(
    outcome.codes.includes("attempt_runtime_source_mismatch") || outcome.codes.includes("snapshot_identity_mismatch"),
    `the source conflict must be reported, got ${outcome.codes.join(",")}`,
  );
});

test("a conflicting source between the snapshot and the record refuses authentication", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nSnapshot source conflict", artifacts: [] });
  syncEvidence(f);
  tamper(f.config, claim.attemptId, snapshot => {
    (snapshot.reportAuthentication as Record<string, unknown>).runtimeSource = "desktop_acp";
  });

  const outcome = reportStateOf(f);
  // T2-R1: the record inside the synced digest was altered, so the version gate
  // rejects the read before authentication can classify the conflict.
  assert.equal(outcome.state, "evidence_stale");
  assert.ok(outcome.codes.includes("evidence_stale"));
});

/* ------------------------------------------------------------------ *
 * History, replay and forged input
 * ------------------------------------------------------------------ */

type ReportInput = Parameters<DesktopQueue["report"]>[0];

test("a forged authentication record in the request is ignored", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  const forged = {
    formatVersion: 1,
    taskId: "forged-task",
    attemptId: "run-00000000-0000-0000-0000-000000000000",
    sessionId: "forged-session",
    runtimeSource: "forged_source",
    reportedStatus: "completed",
    reportDigest: "f".repeat(64),
    authenticatedAt: "2000-01-01T00:00:00.000Z",
  };
  const text = "TASK_STATUS: completed\nForged proof attempt";
  f.queue.report({ ...claim, status: "completed", text, artifacts: [], reportAuthentication: forged } as unknown as ReportInput);
  syncEvidence(f);

  const record = snapshotOf(f.config, claim.attemptId).reportAuthentication!;
  // The queue builds the record from what it verified, not from the request.
  assert.equal(record.taskId, "authz-task");
  assert.equal(record.attemptId, claim.attemptId);
  assert.equal(record.sessionId, SESSION);
  assert.equal(record.runtimeSource, "desktop_queue");
  assert.equal(record.reportedStatus, "completed");
  assert.equal(record.reportDigest, reportDigest({ status: "completed", text, artifacts: [] }));
  assert.notEqual(record.reportDigest, forged.reportDigest);
  assert.notEqual(record.authenticatedAt, forged.authenticatedAt);
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "authenticated", "the real record still authenticates; the forged one is irrelevant");
});

test("a forged record cannot carry a report past a bad lease", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  const forged = { formatVersion: 1, taskId: "authz-task", attemptId: claim.attemptId, sessionId: SESSION, runtimeSource: "desktop_queue", reportedStatus: "completed", reportDigest: "f".repeat(64), authenticatedAt: "2000-01-01T00:00:00.000Z" };
  assert.throws(
    () => f.queue.report({ ...claim, leaseToken: "wrong", status: "completed", text: "forged", artifacts: [], reportAuthentication: forged } as unknown as ReportInput),
    /execution lease/,
  );
  assert.equal(snapshotOf(f.config, claim.attemptId).reportAuthentication, undefined);
});

test("replaying a report that never had a record does not add one", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  const text = "TASK_STATUS: completed\nLegacy replay";
  f.queue.report({ ...claim, status: "completed", text, artifacts: [] });
  // The row digest carries the synced record; stripping the file's record makes
  // the file diverge from the persisted evidence and the version gate refuses.
  syncEvidence(f);
  // Strip the record to imitate a report written before it existed.
  tamper(f.config, claim.attemptId, snapshot => { delete snapshot.reportAuthentication; });
  const outcomeBefore = reportStateOf(f);
  assert.ok(outcomeBefore.codes.includes("evidence_stale"));

  // The identical report is an idempotent replay: it must not backfill a proof.
  const replay = f.queue.report({ ...claim, status: "completed", text, artifacts: [] });
  assert.equal(replay.ok, true);
  assert.equal(snapshotOf(f.config, claim.attemptId).reportAuthentication, undefined, "a replay must not manufacture a record");
  assert.equal(reportStateOf(f).state, "evidence_stale");
});

test("a replay keeps a record that was legitimately written", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  const text = "TASK_STATUS: completed\nLegit replay";
  f.queue.report({ ...claim, status: "completed", text, artifacts: [] });
  syncEvidence(f);
  const original = snapshotOf(f.config, claim.attemptId).reportAuthentication;
  f.queue.report({ ...claim, status: "completed", text, artifacts: [] });
  assert.deepEqual(snapshotOf(f.config, claim.attemptId).reportAuthentication, original);
  assert.equal(reportStateOf(f).state, "authenticated");
});

/* ------------------------------------------------------------------ *
 * The writer
 * ------------------------------------------------------------------ */

test("a verified report persists an authentication record in the same save", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nA real fixture report", artifacts: [] });

  const snapshot = snapshotOf(f.config, claim.attemptId);
  const record = snapshot.reportAuthentication;
  assert.ok(record, "the report must carry an authentication record");
  assert.equal(record.formatVersion, REPORT_AUTHENTICATION_FORMAT);
  assert.equal(record.taskId, "authz-task");
  assert.equal(record.attemptId, claim.attemptId);
  assert.equal(record.sessionId, SESSION);
  assert.equal(record.runtimeSource, "desktop_queue");
  assert.equal(record.reportedStatus, "completed", "the originally submitted status must be kept");
  assert.match(record.reportDigest, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(record.authenticatedAt)), "the authentication time must be a real instant");
  // The report itself is stored by the same write.
  assert.equal(snapshot.text, "TASK_STATUS: completed\nA real fixture report");
  assert.equal(snapshot.reportDigest, record.reportDigest);
  // No lease token or credential may leak into the record.
  assert.ok(!JSON.stringify(record).includes(claim.leaseToken), "the lease token must not be persisted");
});

test("a report with a bad lease writes no authentication record", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  assert.throws(() => f.queue.report({ ...claim, leaseToken: "wrong", status: "completed", text: "forged", artifacts: [] }), /execution lease/);
  const snapshot = snapshotOf(f.config, claim.attemptId);
  assert.equal(snapshot.reportAuthentication, undefined, "a rejected report must not leave a proof behind");
  assert.equal(snapshot.reportDigest, undefined);
});

test("a report whose cited validation record does not belong to the attempt writes no authentication record", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  const outside = path.join(f.dir, "outside-record.json");
  fs.writeFileSync(outside, "{}");
  assert.throws(
    () => f.queue.report({ ...claim, status: "completed", text: "claimed pass", artifacts: [], validationRecords: [{ path: outside, sha256: "0".repeat(64) }] }),
    /does not belong to this attempt/,
  );
  const snapshot = snapshotOf(f.config, claim.attemptId);
  assert.equal(snapshot.reportAuthentication, undefined);
});

test("an idempotent replay does not rewrite or duplicate the authentication record", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  const text = "TASK_STATUS: completed\nReplay fixture";
  f.queue.report({ ...claim, status: "completed", text, artifacts: [] });
  const first = snapshotOf(f.config, claim.attemptId).reportAuthentication;
  f.queue.report({ ...claim, status: "completed", text, artifacts: [] });
  const second = snapshotOf(f.config, claim.attemptId).reportAuthentication;
  assert.deepEqual(second, first, "the replay must keep the original record");
});

/* ------------------------------------------------------------------ *
 * The mapping
 * ------------------------------------------------------------------ */

test("an authenticated report before the stop maps to waiting_stop", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nBefore stop", artifacts: [] });
  syncEvidence(f);

  const result = project(f.config, f.store, "authz-task");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.projection.facts!.report.state, "authenticated");
  assert.equal(result.projection.facts!.stop.proven, false);
  assert.equal(result.projection.displayState, "waiting_stop");
  assert.deepEqual(result.projection.allowedActions, ["export"]);
  assert.equal(result.projection.actionFacts, null);
});

test("an authenticated report after a confirmed stop maps to needs_review", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nAfter stop", artifacts: [] });
  syncEvidence(f);
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  syncEvidence(f);

  const result = project(f.config, f.store, "authz-task");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.projection.facts!.report.state, "authenticated");
  assert.equal(result.projection.facts!.stop.proven, true);
  assert.equal(result.projection.displayState, "needs_review");
  assert.deepEqual(result.projection.allowedActions, ["export"]);
});

test("the registered tool returns the authenticated projection", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTool path", artifacts: [] });
  syncEvidence(f);
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  syncEvidence(f);

  const server = new McpServer({ name: "authz-test", version: "0.0.0" });
  registerTaskProjectionTool(server, { store: f.store as never, runsDir: f.config.runsDir! });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "authz-client", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "workbuddy_get_task_projection", arguments: { taskId: "authz-task" } });
    const text = (response.content as Array<{ type: string; text?: string }>).find(part => part.type === "text")?.text ?? "{}";
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.projection.facts.report.state, "authenticated");
    assert.equal(payload.projection.displayState, "needs_review");
  } finally {
    await client.close();
    await server.close();
  }
});

/* ------------------------------------------------------------------ *
 * Tampering and binding conflicts
 * ------------------------------------------------------------------ */

/** Rewrite the snapshot on disk, then project again. */
function tamper(config: Config, attemptId: string, change: (snapshot: Record<string, unknown>) => void): void {
  const journal = new RunJournal(config.runsDir!, attemptId);
  const snapshot = journal.snapshot() as unknown as Record<string, unknown>;
  change(snapshot);
  fs.writeFileSync(path.join(journal.dir, "state.json"), JSON.stringify(snapshot));
}

async function reportedFixture(t: { after: (fn: () => void) => void }) {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nOriginal", artifacts: [] });
  // T2-R1: sync the report facts into the row so the projection below answers
  // from the persisted digest; tampering then diverges from that digest.
  syncEvidence(f);
  return { f, claim };
}

function reportStateOf(f: ReturnType<typeof fixture>): { state: string; codes: string[] } {
  const result = project(f.config, f.store, "authz-task");
  // T2-R1: a tampered run file diverges from the persisted evidence digest, and
  // the version gate rejects the read before the authentication layer runs.
  if (!result.ok) return { state: "evidence_stale", codes: [result.code] };
  return {
    state: result.projection.facts!.report.state,
    codes: result.projection.gaps.map(gap => gap.code),
  };
}

test("an altered report text stops being authenticated", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => { snapshot.text = "TASK_STATUS: completed\nAltered"; });
  const outcome = reportStateOf(f);
  // T2-R1: the altered text diverges from the persisted digest, so the version
  // gate refuses the whole read before the authentication layer runs.
  assert.equal(outcome.state, "evidence_stale");
  assert.ok(outcome.codes.includes("evidence_stale"));
});

test("altered artifacts stop being authenticated", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => { snapshot.artifacts = ["C:/elsewhere/added.txt"]; });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "evidence_stale");
  assert.ok(outcome.codes.includes("evidence_stale"));
});

test("a changed reported status stops being authenticated", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => {
    (snapshot.reportAuthentication as Record<string, unknown>).reportedStatus = "failed";
  });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "evidence_stale");
  assert.ok(outcome.codes.includes("evidence_stale"));
});

test("a changed validation record list stops being authenticated", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => {
    snapshot.validationRecords = [{ path: "/tmp/invented.json", sha256: "1".repeat(64) }];
  });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "evidence_stale");
  assert.ok(outcome.codes.includes("evidence_stale"));
});

test("a binding conflict on the task, attempt, session or source stops being authenticated", async t => {
  const conflicts: Array<[string, (record: Record<string, unknown>) => void, string]> = [
    ["task", record => { record.taskId = "another-task"; }, "report_authentication_binding_mismatch"],
    ["attempt", record => { record.attemptId = "run-99999999-9999-9999-9999-999999999999"; }, "report_authentication_binding_mismatch"],
    ["session", record => { record.sessionId = "another-session"; }, "report_authentication_binding_mismatch"],
    ["source", record => { record.runtimeSource = "desktop_acp"; }, "report_authentication_binding_mismatch"],
  ];
  for (const [label, change, code] of conflicts) {
    const { f, claim } = await reportedFixture(t);
    tamper(f.config, claim.attemptId, snapshot => change(snapshot.reportAuthentication as Record<string, unknown>));
    const outcome = reportStateOf(f);
    // T2-R1: the record inside the synced digest was altered, so the version
    // gate refuses the read before authentication can classify the conflict.
    assert.equal(outcome.state, "evidence_stale", `${label} conflict must not stay authenticated`);
    assert.ok(outcome.codes.includes("evidence_stale"), `${label} conflict should report evidence_stale`);
  }
});

test("a missing authentication record leaves the report unknown, not absent", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => { delete snapshot.reportAuthentication; });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "evidence_stale");
  assert.ok(outcome.codes.includes("evidence_stale"));
});

test("an unsupported record format leaves the report unknown", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => {
    (snapshot.reportAuthentication as Record<string, unknown>).formatVersion = REPORT_AUTHENTICATION_FORMAT + 1;
  });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "evidence_stale");
  assert.ok(outcome.codes.includes("evidence_stale"));
});

test("a legacy snapshot without the field still reads and stays unknown", async t => {
  const { f, claim } = await reportedFixture(t);
  const journal = new RunJournal(f.config.runsDir!, claim.attemptId);
  // Re-emit the record as an older build would have: no authentication field,
  // but a digest the historical writer produced.
  const snapshot = journal.snapshot()!;
  const { reportAuthentication, ...legacy } = snapshot as unknown as Record<string, unknown> & { reportAuthentication?: unknown };
  void reportAuthentication;
  legacy.reportDigest = reportDigest({ status: "completed", text: String(snapshot.text), artifacts: [] });
  fs.writeFileSync(path.join(journal.dir, "state.json"), JSON.stringify(legacy));

  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "evidence_stale");
  assert.ok(outcome.codes.includes("evidence_stale"));
});

test("a late report is not restored to review", async t => {
  const f = fixture(t);
  await f.send("authz-task");
  // Let the attempt expire by setting the deadline in the past, then report.
  const claim = await f.claimFor();
  const journal = new RunJournal(f.config.runsDir!, claim.attemptId);
  fs.writeFileSync(path.join(journal.dir, "cancel.json"), JSON.stringify({ requestedAt: new Date().toISOString(), reason: "deadline" }));
  fs.writeFileSync(path.join(journal.dir, "state.json"), JSON.stringify({ ...journal.snapshot(), status: "blocked", deadline: new Date(Date.now() - 1000).toISOString() }));
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nLate", artifacts: [] });

  const snapshot = snapshotOf(f.config, claim.attemptId);
  assert.equal(snapshot.reportAuthentication, undefined, "a late report must not be authenticated");
  const result = project(f.config, f.store, "authz-task");
  assert.equal(result.ok, false);
  if (result.ok) throw Error("Expected stale evidence");
  assert.equal(result.code, "evidence_stale");
});

test("a persisted acceptance is not changed by the new record", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nAccept me", artifacts: [] });
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  f.store.update("authz-task", { state: "accepted", reviewNote: "independent review", reviewedAt: new Date().toISOString() });

  syncEvidence(f);
  const result = project(f.config, f.store, "authz-task");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.projection.facts!.acceptance.decision, "accepted");
  assert.equal(result.projection.displayState, "accepted");
});

test("the report authentication record is not a field a caller can supply", async t => {
  // Behaviour, not a source scan: the request below carries a complete-looking
  // record with every field wrong, and the queue must rebuild it from what it
  // verified rather than accept any of it.
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  const forged = { formatVersion: 1, taskId: "forged", attemptId: "run-00000000-0000-0000-0000-000000000000", sessionId: "forged", runtimeSource: "forged", reportedStatus: "failed", reportDigest: "0".repeat(64), authenticatedAt: "1999-12-31T23:59:59.000Z" };
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nEvery forged field", artifacts: [], reportAuthentication: forged } as unknown as ReportInput);
  syncEvidence(f);
  const record = snapshotOf(f.config, claim.attemptId).reportAuthentication!;
  for (const field of ["taskId", "attemptId", "sessionId", "runtimeSource", "reportedStatus", "reportDigest", "authenticatedAt"] as const) {
    assert.notEqual(record[field], forged[field], `${field} must come from the verified inputs`);
  }
  assert.equal(reportStateOf(f).state, "authenticated");
});
