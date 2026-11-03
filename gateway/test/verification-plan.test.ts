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

test("preflight refuses to start while capacity is held", () => {
  const report = preflightReport({
    occupant: { taskId: "task-old", executor: "workbuddy", operationId: "desktop-send-old" },
    dispatchEnabled: true,
    databasePath: "C:\\state\\workbuddy.db",
    workspace: "C:\\work",
    workspaceWritable: true,
  });
  assert.equal(report.ready, false);
  assert.equal(report.blockers.length, 1);
  assert.match(report.blockers[0], /capacity_held_by_another_task: task-old/);
  assert.match(report.reminder, /不要用新任务去挤/);
});

test("preflight reports every blocker, not the first one", () => {
  const report = preflightReport({ occupant: null, dispatchEnabled: false, databasePath: "", workspace: "", workspaceWritable: false });
  assert.equal(report.ready, false);
  assert.equal(report.blockers.length, 3);
  assert.match(report.blockers[0], /^dispatch_not_enabled/);
  assert.match(report.blockers[1], /^workspace_not_writable/);
  assert.match(report.blockers[2], /^database_path_missing/);
});

test("a missing ledger reports unknown capacity, never free", () => {
  const report = preflightReport({ occupant: null, dispatchEnabled: false, databasePath: "", workspace: "C:\\work", workspaceWritable: true });
  assert.equal(report.observed.capacity, "unknown (database missing)");
});

test("preflight passes only when nothing blocks", () => {
  const report = preflightReport({ occupant: null, dispatchEnabled: true, databasePath: "C:\\state\\workbuddy.db", workspace: "C:\\work", workspaceWritable: true });
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
