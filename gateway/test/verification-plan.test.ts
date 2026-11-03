import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  VERIFICATION_PLAN_REVISION,
  VERIFICATION_STEPS,
  allowedClaims,
  preflightReport,
  stepResult,
  verificationSummary,
  type VerificationEvidence,
} from "../src/verification-plan.js";

const at = "2026-11-02T05:00:00.000Z";
const evidenceFor = (stepId: string, kinds: string[]): VerificationEvidence[] => kinds.map(kind => ({ stepId, kind, value: "recorded", observedAt: at }));

test("every step states what its evidence cannot prove", () => {
  for (const step of VERIFICATION_STEPS) {
    assert.ok(step.mayNotProve.trim().length > 0, `${step.id} must state a limitation`);
    assert.ok(step.evidence.length > 0, `${step.id} must require evidence`);
  }
  assert.equal(VERIFICATION_PLAN_REVISION, "p0-5-verification-1");
});

test("evidence is either recorded or missing, never a verdict", () => {
  const partial = evidenceFor("preflight", ["capacity", "dispatch_flag", "database_path"]);
  const result = stepResult(VERIFICATION_STEPS[0], partial);
  assert.equal(result.status, "missing");
  assert.deepEqual(result.missing, ["workspace"]);
  const full = stepResult(VERIFICATION_STEPS[0], evidenceFor("preflight", ["capacity", "dispatch_flag", "database_path", "workspace"]));
  assert.equal(full.status, "recorded");
});

test("blank values do not count as evidence", () => {
  const blank: VerificationEvidence[] = [{ stepId: "reserve", kind: "reserved_session", value: "   ", observedAt: at }];
  assert.equal(stepResult(VERIFICATION_STEPS[1], blank).status, "missing");
});

test("a failure value is not evidence of success", () => {
  const failed: VerificationEvidence[] = [
    { stepId: "reserve", kind: "reserved_session", value: "identity_mismatch", observedAt: at },
    { stepId: "reserve", kind: "worker_key", value: "error", observedAt: at },
  ];
  assert.equal(stepResult(VERIFICATION_STEPS[1], failed).status, "missing");
  const unknownCapacity: VerificationEvidence[] = [{ stepId: "preflight", kind: "capacity", value: "unknown (workflow_capacity missing)", observedAt: at }];
  assert.equal(stepResult(VERIFICATION_STEPS[0], unknownCapacity).missing.includes("capacity"), true);
});

test("a reserved session must look like a session id", () => {
  const notAUuid: VerificationEvidence[] = [{ stepId: "reserve", kind: "reserved_session", value: "session-7", observedAt: at }];
  assert.equal(stepResult(VERIFICATION_STEPS[1], notAUuid).missing.includes("reserved_session"), true);
  const uuid = "0f9d2f1e-2c55-4b7a-9f1d-8d9a6f0a1b23";
  const ok: VerificationEvidence[] = [{ stepId: "reserve", kind: "reserved_session", value: uuid, observedAt: at }];
  assert.equal(stepResult(VERIFICATION_STEPS[1], ok).missing.includes("reserved_session"), false);
  assert.equal(stepResult(VERIFICATION_STEPS[1], ok).missing.includes("worker_key"), true);
});

test("summary counts steps and keeps every limitation attached", () => {
  const evidence = [...evidenceFor("preflight", ["capacity", "dispatch_flag", "database_path", "workspace"]), ...evidenceFor("dispatch", ["request_id", "receipt_state", "lease"])];
  const summary = verificationSummary(evidence);
  assert.equal(summary.recorded, 2);
  assert.equal(summary.missing, VERIFICATION_STEPS.length - 2);
  assert.ok(summary.steps.every(step => step.mayNotProve.length > 0));
});

test("no evidence means nothing may be claimed", () => {
  assert.deepEqual(allowedClaims([]), []);
});

test("a report without native stop may only claim that much", () => {
  const claims = allowedClaims([...evidenceFor("report-received", ["report_text", "received_at"])]);
  assert.equal(claims.length, 1);
  assert.match(claims[0].claim, /原生停止尚未确认/);
  assert.match(claims[0].limitation, /报告收到≠原生停止/);
});

test("review alone never claims acceptance", () => {
  const claims = allowedClaims(evidenceFor("independent-review", ["reviewer", "reviewed_artifact", "review_conclusion"]));
  assert.equal(claims.length, 1);
  assert.match(claims[0].limitation, /不等同真实派工验收/);
});

test("an executor reviewing its own work is not an independent review", () => {
  const evidence: VerificationEvidence[] = [
    { stepId: "independent-review", kind: "reviewer", value: "workbuddy", observedAt: at },
    { stepId: "independent-review", kind: "reviewed_artifact", value: "run-7", observedAt: at },
    { stepId: "independent-review", kind: "review_conclusion", value: "looks fine", observedAt: at },
  ];
  const claims = allowedClaims(evidence, { executor: "workbuddy" });
  assert.equal(claims.length, 1);
  assert.match(claims[0].claim, /独立性没有得到核对/);
  const unnamed = allowedClaims(evidence);
  assert.match(unnamed[0].claim, /独立性没有得到核对/);
});

test("identity is only claimed when both sides name the same session", () => {
  const session = "0f9d2f1e-2c55-4b7a-9f1d-8d9a6f0a1b23";
  const same: VerificationEvidence[] = [
    { stepId: "reserve", kind: "reserved_session", value: session, observedAt: at },
    { stepId: "reserve", kind: "worker_key", value: "workbuddy-native", observedAt: at },
    { stepId: "native-create", kind: "create_result", value: `{"sessionId":"${session}"}`, observedAt: at },
    { stepId: "native-create", kind: "elapsed_ms", value: "812", observedAt: at },
  ];
  assert.match(allowedClaims(same)[0].claim, /身份一致/);
  const other: VerificationEvidence[] = [
    { stepId: "reserve", kind: "reserved_session", value: session, observedAt: at },
    { stepId: "reserve", kind: "worker_key", value: "workbuddy-native", observedAt: at },
    { stepId: "native-create", kind: "create_result", value: `{"sessionId":"1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"}`, observedAt: at },
    { stepId: "native-create", kind: "elapsed_ms", value: "812", observedAt: at },
  ];
  assert.match(allowedClaims(other)[0].claim, /没有指向同一个会话/);
});

test("preflight refuses to start while capacity is held", () => {
  const report = preflightReport({
    occupant: { taskId: "task-old", executor: "workbuddy", operationId: "desktop-send-old" },
    dispatchEnabled: true,
    databasePath: "C:\\state\\workbuddy.db",
    capacityTable: true,
    workspace: "C:\\work",
    workspaceWritable: true,
  });
  assert.equal(report.ready, false);
  assert.equal(report.blockers.length, 1);
  assert.match(report.blockers[0], /capacity_held_by_another_task: task-old/);
  assert.match(report.reminder, /不要用新任务去挤/);
});

test("preflight reports every blocker, not the first one", () => {
  const report = preflightReport({ occupant: null, dispatchEnabled: false, databasePath: "", capacityTable: false, workspace: "", workspaceWritable: false });
  assert.equal(report.ready, false);
  assert.equal(report.blockers.length, 3);
  assert.match(report.blockers[0], /^dispatch_not_enabled/);
  assert.match(report.blockers[1], /^workspace_not_writable/);
  assert.match(report.blockers[2], /^database_path_missing/);
});

test("a missing ledger reports unknown capacity, never free", () => {
  const report = preflightReport({ occupant: null, dispatchEnabled: false, databasePath: "", capacityTable: false, workspace: "C:\\work", workspaceWritable: true });
  assert.equal(report.observed.capacity, "unknown (database missing)");
});

test("a ledger without the capacity table blocks instead of reporting free", () => {
  const report = preflightReport({ occupant: null, dispatchEnabled: true, databasePath: "C:\\state\\old.db", capacityTable: false, workspace: "C:\\work", workspaceWritable: true });
  assert.equal(report.ready, false);
  assert.match(report.blockers[0], /capacity_table_missing/);
  assert.equal(report.observed.capacity, "unknown (workflow_capacity missing)");
});

test("preflight passes only when nothing blocks", () => {
  const report = preflightReport({ occupant: null, dispatchEnabled: true, databasePath: "C:\\state\\workbuddy.db", capacityTable: true, workspace: "C:\\work", workspaceWritable: true });
  assert.equal(report.ready, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.observed.capacity, "free");
});

test("the read-only preflight script never writes and reports the occupant", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-p0-5-"));
  const dbFile = path.join(root, "workbuddy.db");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE workflow_capacity(slot INTEGER PRIMARY KEY CHECK(slot=1), task_id TEXT, executor TEXT, operation_id TEXT)");
  db.prepare("INSERT INTO workflow_capacity VALUES (1,?,?,?)").run("task-held", "workbuddy", "op-held");
  db.close();
  const before = fs.statSync(dbFile).mtimeMs;
  const output = execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "verification-preflight.mjs"), "--db", dbFile, "--workspace", root], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.ready, false);
  assert.match(report.blockers[0], /task-held/);
  assert.equal(fs.statSync(dbFile).mtimeMs, before);
});

test("the preflight script refuses a database that has no capacity table", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-p0-5-old-"));
  const dbFile = path.join(root, "workbuddy.db");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY)");
  db.close();
  const output = execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "verification-preflight.mjs"), "--db", dbFile, "--workspace", root], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((blocker: string) => /^capacity_table_missing/.test(blocker)), report.blockers.join("; "));
  assert.equal(report.observed.capacity, "unknown (workflow_capacity missing)");
});
