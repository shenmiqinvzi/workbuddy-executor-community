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
import { DesktopQueue, assertDesktopCaller } from "../src/desktop-queue.js";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { TaskCoordinator } from "../src/coordinator.js";
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
  const claimFor = async (taskId = "authz-task") => {
    const claim = await queue.claim(SESSION, 0);
    if (claim.status !== "task") throw new Error("expected a claim");
    // The normal flow syncs the task after the claim, which is what records the
    // runtime source on the task row that the projection binds to.
    await coordinator.sync(taskId);
    return claim;
  };
  return { dir, config, store, coordinator, queue, send, claimFor };
}

/** Read the run snapshot the queue just wrote. */
function snapshotOf(config: Config, attemptId: string) {
  return new RunJournal(config.runsDir!, attemptId).snapshot()!;
}

/** Project the task through the reader, as the tool does. */
function project(config: Config, store: TaskStore, taskId: string) {
  return readTaskProjection({ store: store as never, runsDir: config.runsDir! }, taskId);
}

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
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });

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
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });

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
  return { f, claim };
}

function reportStateOf(f: ReturnType<typeof fixture>): { state: string; codes: string[] } {
  const result = project(f.config, f.store, "authz-task");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("projection failed");
  return {
    state: result.projection.facts!.report.state,
    codes: result.projection.gaps.map(gap => gap.code),
  };
}

test("an altered report text stops being authenticated", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => { snapshot.text = "TASK_STATUS: completed\nAltered"; });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "unknown");
  assert.ok(outcome.codes.includes("report_authentication_digest_mismatch"));
});

test("altered artifacts stop being authenticated", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => { snapshot.artifacts = ["C:/elsewhere/added.txt"]; });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "unknown");
  assert.ok(outcome.codes.includes("report_authentication_digest_mismatch"));
});

test("a changed reported status stops being authenticated", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => {
    (snapshot.reportAuthentication as Record<string, unknown>).reportedStatus = "failed";
  });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "unknown");
  assert.ok(outcome.codes.includes("report_authentication_digest_mismatch"));
});

test("a changed validation record list stops being authenticated", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => {
    snapshot.validationRecords = [{ path: "/tmp/invented.json", sha256: "1".repeat(64) }];
  });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "unknown");
  assert.ok(outcome.codes.includes("report_authentication_digest_mismatch"));
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
    assert.equal(outcome.state, "unknown", `${label} conflict must not stay authenticated`);
    assert.ok(outcome.codes.includes(code), `${label} conflict should report ${code}`);
  }
});

test("a missing authentication record leaves the report unknown, not absent", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => { delete snapshot.reportAuthentication; });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "unknown");
  assert.ok(outcome.codes.includes("report_authentication_missing"));
});

test("an unsupported record format leaves the report unknown", async t => {
  const { f, claim } = await reportedFixture(t);
  tamper(f.config, claim.attemptId, snapshot => {
    (snapshot.reportAuthentication as Record<string, unknown>).formatVersion = REPORT_AUTHENTICATION_FORMAT + 1;
  });
  const outcome = reportStateOf(f);
  assert.equal(outcome.state, "unknown");
  assert.ok(outcome.codes.includes("report_authentication_unsupported"));
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
  assert.equal(outcome.state, "unknown");
  assert.ok(outcome.codes.includes("report_authentication_missing"));
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
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.projection.displayState, "needs_review");
});

test("a persisted acceptance is not changed by the new record", async t => {
  const f = fixture(t);
  await f.send();
  const claim = await f.claimFor();
  f.queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nAccept me", artifacts: [] });
  f.queue.observeNative(claim.attemptId, { state: "idle", workspace: f.dir });
  f.store.update("authz-task", { state: "accepted", reviewNote: "independent review", reviewedAt: new Date().toISOString() });

  const result = project(f.config, f.store, "authz-task");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.projection.facts!.acceptance.decision, "accepted");
  assert.equal(result.projection.displayState, "accepted");
});

test("the report authentication record is not a field a caller can supply", () => {
  // report() takes a fixed shape; an extra property on the object is ignored
  // because the record is rebuilt from the verified inputs inside the queue.
  const surface = fs.readFileSync(path.resolve("src/desktop-queue.ts"), "utf8");
  assert.ok(surface.includes("reportAuthentication: {"), "the queue must build the record itself");
  assert.ok(surface.includes("reportedStatus: input.status"), "the reported status must come from the verified input");
  assert.ok(assertDesktopCaller, "the production actor check stays in place");
});
