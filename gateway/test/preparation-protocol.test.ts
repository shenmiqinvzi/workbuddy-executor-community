import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../src/config.js";
import { WorkspaceWorkers } from "../src/workspace-workers.js";
import { PreparationJournal } from "../src/preparation-journal.js";
import {
  NATIVE_PREPARATION_PROTOCOL,
  classifyPreparationProbe,
  describePreparationProbe,
  sameWorkspacePath,
} from "../src/preparation-protocol.js";

/** P0-3 只主张协议能证明的东西：本地观测可以记，终态不能推。 */

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-p0-3-"));
  const workspace = path.join(root, "workspace");
  const runsDir = path.join(root, "runs");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  const config = { runsDir, dbFile: path.join(root, "wb.db"), workbuddyConfigDir: path.join(root, "buddy") } as unknown as Config;
  return { root, workspace, runsDir, config };
}

function nativeFailing(mode: "throw" | "wrong-identity" | "probe-throws") {
  return {
    async createWorker(): Promise<{ sessionId: string; workspace: string }> {
      if (mode === "wrong-identity") return { sessionId: "another-session", workspace: "C:\\elsewhere" };
      throw new Error("Native submission receipt is uncertain; do not automatically replay");
    },
    async probe(): Promise<{ sessionId: string; workspace: string } | null> {
      if (mode === "probe-throws") throw new Error("Native desktop disconnected; submission outcome may be uncertain");
      return null;
    },
  };
}

test("protocol facts record the limitations instead of promising a terminal state", () => {
  assert.equal(NATIVE_PREPARATION_PROTOCOL.creationChannel, "session:create");
  assert.equal(NATIVE_PREPARATION_PROTOCOL.idempotencyKey, "caller_supplied_session_uuid");
  assert.equal(NATIVE_PREPARATION_PROTOCOL.terminalQueryProves, "presence_only");
  assert.equal(NATIVE_PREPARATION_PROTOCOL.lateCreationExcluded, false);
});

test("absence is recorded as not observed, never as not created", () => {
  const expected = { sessionId: "s-1", workspace: "C:\\work\\a" };
  assert.deepEqual(classifyPreparationProbe({ source: "desktop_history", expected, observed: null }), {
    kind: "absent",
    conclusion: "not_observed",
    reason: "absence_is_not_proof",
  });
  assert.deepEqual(classifyPreparationProbe({ source: "native_session_get", expected, observed: expected }), {
    kind: "present",
    conclusion: "created",
    reason: "session_present",
  });
});

test("a failed probe stays unconfirmed and never borrows the timeout as evidence", () => {
  const expected = { sessionId: "s-1", workspace: "C:\\work\\a" };
  assert.deepEqual(classifyPreparationProbe({ source: "native_session_get", expected, observed: null, error: "timeout" }), {
    kind: "unavailable",
    conclusion: "unconfirmed",
    reason: "probe_failed",
  });
  assert.deepEqual(classifyPreparationProbe({ source: "none", expected }), {
    kind: "unavailable",
    conclusion: "unconfirmed",
    reason: "probe_not_supported",
  });
});

test("identity mismatch is unconfirmed even when something exists", () => {
  const expected = { sessionId: "s-1", workspace: "C:\\work\\a" };
  assert.equal(classifyPreparationProbe({ source: "desktop_history", expected, observed: { sessionId: "s-2", workspace: "C:\\work\\a" } }).reason, "session_identity_mismatch");
  assert.equal(classifyPreparationProbe({ source: "desktop_history", expected, observed: { sessionId: "s-1", workspace: "C:\\work\\b" } }).reason, "workspace_identity_mismatch");
  assert.equal(sameWorkspacePath("C:\\Work\\A\\", "c:/work/a"), true);
});

test("a crash after the native call leaves one uncertain worker and one probe row", async () => {
  const { workspace, config } = fixture();
  const workers = new WorkspaceWorkers(config);
  await assert.rejects(workers.ensure({ workspace }, nativeFailing("throw")), /uncertain; do not automatically replay/);
  const [record] = workers.list();
  assert.equal(record.state, "uncertain");
  const probes = workers.preparationProbes(record.sessionId);
  assert.equal(probes.length, 1);
  assert.equal(probes[0].kind, "absent");
  assert.equal(probes[0].conclusion, "not_observed");
  assert.equal(probes[0].source, "native_session_get");
  workers.close();
});

test("without a native probe the desktop history read is used and absence is still not proof", async () => {
  const { workspace, config } = fixture();
  const workers = new WorkspaceWorkers(config);
  const native = { async createWorker(): Promise<{ sessionId: string; workspace: string }> { throw new Error("workspace:initialize failed"); } };
  await assert.rejects(workers.ensure({ workspace }, native), /workspace:initialize failed/);
  const [record] = workers.list();
  const [probe] = workers.preparationProbes(record.sessionId);
  assert.equal(probe.source, "desktop_history");
  assert.equal(probe.kind, "absent");
  assert.equal(probe.conclusion, "not_observed");
  workers.close();
});

test("an unreadable probe records unconfirmed evidence without replacing the original error", async () => {
  const { workspace, config } = fixture();
  const workers = new WorkspaceWorkers(config);
  await assert.rejects(workers.ensure({ workspace }, nativeFailing("probe-throws")), /uncertain; do not automatically replay/);
  const [record] = workers.list();
  assert.match(record.error ?? "", /uncertain/);
  const [probe] = workers.preparationProbes(record.sessionId);
  assert.equal(probe.kind, "unavailable");
  assert.equal(probe.reason, "probe_failed");
  assert.match(probe.error ?? "", /disconnected/);
  workers.close();
});

test("a wrong identity from the native side is recorded and never auto-resolved", async () => {
  const { workspace, config } = fixture();
  const workers = new WorkspaceWorkers(config);
  await assert.rejects(workers.ensure({ workspace }, nativeFailing("wrong-identity")), /another session or workspace/);
  const [record] = workers.list();
  assert.equal(record.state, "uncertain");
  assert.equal(record.sessionId !== "another-session", true);
  assert.equal(workers.list().length, 1);
  assert.equal(workers.preparationProbes(record.sessionId).length, 1);
  workers.close();
});

test("a late creation appends a row and leaves the earlier absence untouched", () => {
  const { runsDir } = fixture();
  const db = new DatabaseSync(path.join(runsDir, "workspace-workers.sqlite"));
  const journal = new PreparationJournal(db);
  const expected = { sessionId: "s-9", workspace: "C:\\work\\a" };
  const base = { sessionId: "s-9", workspace: expected.workspace };
  journal.record({ source: "desktop_history", expected, ...base, observedAt: "2026-11-02T01:00:00.000Z" });
  journal.record({ source: "desktop_history", expected, observed: expected, ...base, observedAt: "2026-11-02T01:00:20.000Z" });
  const rows = journal.forSession("s-9");
  assert.deepEqual(rows.map(row => row.conclusion), ["not_observed", "created"]);
  assert.equal(journal.latest("s-9")?.conclusion, "created");
  assert.match(describePreparationProbe(rows[0]), /不等于未创建/);
  db.close();
});

test("probe history survives a restart and a duplicate probe id is refused", async () => {
  const { workspace, runsDir, config } = fixture();
  const first = new WorkspaceWorkers(config);
  await assert.rejects(first.ensure({ workspace }, nativeFailing("throw")), /uncertain/);
  const [record] = first.list();
  first.close();
  const second = new WorkspaceWorkers(config);
  const rows = second.preparationProbes(record.sessionId);
  assert.equal(rows.length, 1);
  const raw = new DatabaseSync(path.join(runsDir, "workspace-workers.sqlite"));
  assert.throws(() => raw.prepare("INSERT INTO preparation_probes VALUES (?,?,?,?,?,?,?,?,?,?)").run(rows[0].probeId, rows[0].sessionId, rows[0].workspace, rows[0].source, rows[0].kind, rows[0].conclusion, rows[0].reason, rows[0].gatewayPid, rows[0].observedAt, rows[0].error));
  assert.equal(second.preparationProbes(record.sessionId).length, 1);
  raw.close();
  second.close();
});

test("two gateway instances record concurrently under the same reserved identity", () => {
  const { workspace, config } = fixture();
  const left = new WorkspaceWorkers(config);
  const right = new WorkspaceWorkers(config);
  const sessionId = "session-shared";
  const expected = { sessionId, workspace };
  const db = (workers: WorkspaceWorkers) => (workers as unknown as { journal: PreparationJournal }).journal;
  db(left).record({ source: "desktop_history", expected, sessionId, workspace });
  db(right).record({ source: "native_session_get", expected, observed: null, error: "disconnected", sessionId, workspace });
  const rows = left.preparationProbes(sessionId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.kind).sort(), ["absent", "unavailable"]);
  assert.equal(right.preparationProbes(sessionId).length, 2);
  left.close();
  right.close();
});
