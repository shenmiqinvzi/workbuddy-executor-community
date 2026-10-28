import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { reviewFixture } from "./support/review-fixture.js";
import { TaskStore } from "../src/task-store.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ReviewInput } from "../src/task-reviews.js";

for (const executor of ["workbuddy", "dsh"] as const) {
  test(`T6 ${executor} authentic report -> immutable independent review -> atomic acceptance and closure`, async t => {
    const f = await reviewFixture(t, executor, { semantic: true }); await f.finish();
    assert.equal(f.current().state, "needs_review");
    const before = f.current().revision, review = f.review();
    assert.notEqual(review.revision, before); assert.equal(review.review.committedRevision, f.current().revision);
    assert.notEqual(review.review.basisRevision, review.revision);
    assert.ok(f.service.statusView(f.current()).allowedActions.includes("accept"));
    assert.equal(f.store.operations.isClosed(f.current()), false);
    const input = { ...f.op(), reviewId: review.reviewId };
    const accepted = f.service.acceptReview(input);
    assert.equal(accepted.task.state, "accepted"); assert.equal(f.store.operations.isClosed(f.current()), true);
    assert.deepEqual(f.service.acceptReview(input), accepted);
    assert.equal(f.store.listTaskEvents("task").events.filter(event => event.type === "task_closed").length, 1);
    assert.equal(f.store.operations.get(input.operationId)!.state, "succeeded");
    assert.equal(f.current().attempt, 1); assert.equal(f.prompts(), executor === "dsh" ? 1 : 0);
  });
  test(`T6 ${executor} missing required command cannot use worker self-report`, async t => {
    const f = await reviewFixture(t, executor, { command: true }); await f.finish();
    const batch = f.checks(); assert.equal(batch.checks.find(check => check.checkId === "test")!.status, "unknown");
    const review = f.review(batch); assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }), { code: "CHECKS_REQUIRED" });
    assert.equal(f.current().state, "needs_review");
  });
}

for (const status of ["failed", "unknown", "checker_error", "not_applicable"] as const) test(`T6 required semantic ${status} never accepts; correction preserves evidence and budget`, async t => {
  const f = await reviewFixture(t, "dsh", { semantic: true }); await f.finish(); const first = f.review(f.checks(), status);
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: first.reviewId }), { code: "CHECKS_REQUIRED" });
  const corrected = f.review(f.checks(), "passed", first.reviewId);
  const history = f.service.listReviews("task"); assert.equal(history.length, 2); assert.equal(history[0]!.checks.at(-1)!.status, status);
  assert.equal(history[1]!.correction, "reviewer_error"); assert.equal(history[1]!.supersedesReviewId, first.reviewId);
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: first.reviewId }), { code: "REVIEW_STALE" });
  assert.equal(f.service.acceptReview({ ...f.op(), reviewId: corrected.reviewId }).task.state, "accepted"); assert.equal(f.current().attempt, 1);
});

test("T6 missing semantic check rejects, fake machine actor and unknown evidence cannot enter review", async t => {
  const f = await reviewFixture(t, "workbuddy", { semantic: true }); await f.finish(); const batch = f.checks();
  const base = () => ({ ...f.op(), note: "Independent check", machineCheckIds: batch.machineCheckIds, semanticChecks: [] });
  const missing = f.service.review(base()); assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: missing.reviewId }), { code: "CHECKS_REQUIRED" });
  assert.throws(() => f.service.review({ ...base(), actor: "program" } as ReviewInput), { code: "INVALID_REVIEW" });
  assert.throws(() => f.service.review({ ...base(), machineCheckIds: ["passed"] }), { code: "REVIEW_EVIDENCE_UNKNOWN" });
  assert.throws(() => f.service.review({ ...base(), semanticChecks: [{ checkId: "behavior", status: "passed", note: "Tests passed", evidenceRefs: ["worker-says-passed"] }] }), { code: "REVIEW_EVIDENCE_UNKNOWN" });
  assert.throws(() => f.service.review({ ...base(), semanticChecks: [{ checkId: "$provenance", status: "passed", note: "Manual override", evidenceRefs: ["anything"] }] }), { code: "INVALID_REVIEW" });
  assert.throws(() => f.service.review({ ...base(), taskId: "other" }), { code: "STALE_ATTEMPT" });
});

for (const changed of ["source", "scope", "protected", "report", "request", "events", "inspection"] as const) test(`T6 ${changed} changes after review invalidate acceptance`, async t => {
  const f = await reviewFixture(t, "workbuddy", { semantic: true }); await f.finish(); const review = f.review();
  if (changed === "source" || changed === "inspection" || changed === "protected") fs.appendFileSync(f.source, "// concurrent change\n");
  if (changed === "scope") fs.writeFileSync(path.join(f.workspace, "outside.txt"), "unauthorized");
  if (changed === "report") { const journal = f.journal(); journal.save({ ...journal.snapshot()!, text: "Different report" }); }
  if (changed === "request") fs.appendFileSync(path.join(f.journal().dir, "request.json"), " ");
  if (changed === "events") f.journal().append("progress", "new native evidence");
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }));
  assert.equal(f.current().state, "needs_review"); assert.equal(f.store.operations.isClosed(f.current()), false);
  assert.equal(f.store.listTaskEvents("task").events.some(event => event.type === "task_closed"), false);
});

test("T6 unchanged persisted reviews survive restart, cannot UPDATE/DELETE, and reads do not inspect workspace", async t => {
  const f = await reviewFixture(t); await f.finish(); const review = f.review(), before = f.service.listReviews("task"), op = f.op();
  const db = new DatabaseSync(f.store.file);
  assert.throws(() => db.prepare("UPDATE task_review_records SET body='{}' WHERE id=?").run(review.reviewId), /immutable/);
  assert.throws(() => db.prepare("DELETE FROM task_review_records WHERE id=?").run(review.reviewId), /immutable/); db.close();
  fs.renameSync(f.workspace, `${f.workspace}-moved`); assert.deepEqual(f.service.listReviews("task"), before); assert.equal(f.current().revision, op.expectedRevision);
  fs.renameSync(`${f.workspace}-moved`, f.workspace);
  const store = f.restart(); assert.deepEqual(store.reviews.list("task"), before);
  assert.equal(store.reviews.accept({ ...op, reviewId: review.reviewId }).task.state, "accepted");
});

test("T6 revision, attempt, operation conflicts and cross-connection competition never double-accept", async t => {
  const f = await reviewFixture(t); await f.finish(); const review = f.review(), input = { ...f.op(), reviewId: review.reviewId };
  assert.throws(() => f.service.acceptReview({ ...input, operationId: "old-revision", expectedRevision: "stale" }), { code: "STALE_REVISION" });
  assert.throws(() => f.service.acceptReview({ ...input, operationId: "old-attempt", expectedAttemptId: "stale" }), { code: "STALE_ATTEMPT" });
  const other = new TaskStore(f.store.file);
  try {
    assert.equal(other.reviews.accept(input).task.state, "accepted");
    assert.deepEqual(f.service.acceptReview(input), other.reviews.accept(input));
    assert.throws(() => f.service.acceptReview({ ...input, reviewId: "another" }), { code: "OPERATION_CONFLICT" });
    assert.throws(() => f.service.acceptReview({ ...input, operationId: "competing-accept" }), { code: "STALE_REVISION" });
  } finally { other.close(); }
});

test("T6 another persisted fact after review rejects despite correct file evidence", async t => {
  const f = await reviewFixture(t); await f.finish(); const review = f.review(); f.store.update("task", { blockingReason: "Concurrent observation changed facts" });
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }), { code: "REVIEW_STALE" });
});

test("T6 acceptance and receipt roll back when the closure event cannot commit", async t => {
  const f = await reviewFixture(t); await f.finish(); const review = f.review();
  const db = new DatabaseSync(f.store.file); db.exec("CREATE TRIGGER reject_t6_closure BEFORE INSERT ON task_events WHEN NEW.type='task_closed' BEGIN SELECT RAISE(ABORT,'injected closure failure'); END");
  const op = { ...f.op(), reviewId: review.reviewId }; assert.throws(() => f.service.acceptReview(op), /injected closure/);
  assert.equal(f.current().state, "needs_review"); assert.equal(f.store.operations.get(op.operationId)!.state, "rejected");
  db.exec("DROP TRIGGER reject_t6_closure"); db.close(); assert.equal(f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }).task.state, "accepted");
});

test("T6 new round cannot use an old review; no review operation adds worker budget", async t => {
  const f = await reviewFixture(t, "dsh"); await f.finish(); const old = f.review();
  await f.service.continue({ taskId: "task", feedback: "A real content correction" }); await f.finish();
  assert.equal(f.current().attempt, 2); assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: old.reviewId }), { code: "REVIEW_STALE" });
  const current = f.review(); assert.equal(f.service.acceptReview({ ...f.op(), reviewId: current.reviewId }).task.attempt, 2); assert.equal(f.service.listReviews("task").length, 2);
});

test("T6 busy native execution, unauthenticated report, forged source and old acceptance cannot close", async t => {
  const f = await reviewFixture(t); await f.finish(false);
  assert.throws(() => f.checks(), { code: "STOP_UNCONFIRMED" });
  f.queue.observeNative(f.current().attemptId!, { state: "idle", workspace: f.workspace }); await f.service.sync("task");
  await assert.rejects(f.wb.accept("task", "Old textual acceptance", ["Worker says tests passed"]), { code: "REVIEW_REQUIRED" });
  const journal = f.journal(), snapshot = journal.snapshot()!;
  journal.save({ ...snapshot, reportAuthentication: undefined }); await f.service.sync("task"); assert.throws(() => f.checks(), { code: "CONTRACT_INTEGRITY" });
  journal.save({ ...snapshot, runtimeSource: "dsh" }); await f.service.sync("task"); assert.throws(() => f.checks());
  assert.equal(f.service.listReviews("task").length, 0);
});

for (const executor of ["workbuddy", "dsh"] as const) test(`T6 ${executor} explicit independent bounded command binds actual source and output; replay never reruns`, async t => {
  const f = await reviewFixture(t, executor, { command: true }); await f.finish();
  const input = { ...f.op(), checkId: "test" }, command = await f.service.runReviewCommand(input);
  assert.equal(command.ok, true); assert.equal(command.status, "passed", JSON.stringify(command)); assert.equal(command.cleanupConfirmed, true);
  assert.deepEqual(await f.service.runReviewCommand(input), command);
  const batch = f.checks(), check = batch.checks.find(check => check.checkId === "test")!;
  assert.equal(check.status, "passed"); assert.equal(check.actor, "program"); assert.ok(check.fileHashes[f.source]);
  const review = f.review(batch); assert.equal(f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }).task.state, "accepted");
  assert.equal(f.current().attempt, 1);
});

test("T6 independent checker command failure preserves its evidence and never becomes a worker failure", async t => {
  const f = await reviewFixture(t, "dsh", { command: true, commandExitCode: 3 }); await f.finish();
  const command = await f.service.runReviewCommand({ ...f.op(), checkId: "test" });
  assert.equal(command.status, "failed"); assert.equal(command.exitCode, 3);
  const batch = f.checks(); assert.equal(batch.checks.at(-1)!.status, "failed");
  const review = f.review(batch); assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }), { code: "CHECKS_REQUIRED" });
  assert.equal(f.current().state, "needs_review"); assert.equal(f.current().attempt, 1);
});

test("T6 new independent command evidence invalidates old batches; uncertain cleanup retains the original operation", async t => {
  const f = await reviewFixture(t, "dsh", { command: true }); await f.finish(); const old = f.checks(), input = { ...f.op(), checkId: "test" };
  const command = await f.service.runReviewCommand(input);
  if (!command.cleanupConfirmed) {
    assert.equal(command.status, "checker_error"); assert.equal(command.operationState, "outcome_unknown");
    assert.throws(() => f.service.review({ ...f.op(), machineCheckIds: old.machineCheckIds, semanticChecks: [], note: "Cannot bypass uncertain cleanup" }), { code: "OUTCOME_UNKNOWN" });
    await assert.rejects(f.service.runReviewCommand(input), { code: "OUTCOME_UNKNOWN" });
  } else {
    assert.throws(() => f.service.review({ ...f.op(), machineCheckIds: old.machineCheckIds, semanticChecks: [], note: "Cannot reuse an older program batch" }), { code: "REVIEW_STALE" });
    assert.deepEqual(await f.service.runReviewCommand(input), command);
  }
  assert.equal(f.current().state, "needs_review"); assert.equal(f.current().attempt, 1);
});

test("T6 output evidence changed after independent command invalidates the stored review", async t => {
  const f = await reviewFixture(t, "dsh", { command: true }); await f.finish(); await f.service.runReviewCommand({ ...f.op(), checkId: "test" });
  const batch = f.checks(), command = batch.checks.at(-1)!, review = f.review(batch);
  const output = Object.keys(command.fileHashes).find(file => file.endsWith(".stdout.log"))!;
  assert.ok(output); fs.appendFileSync(output, "changed output");
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }), { code: "REVIEW_STALE" });
});

test("T6 checker_error scope cannot be waived by a semantic reviewer", async t => {
  const f = await reviewFixture(t, "dsh"); await f.finish(); fs.renameSync(f.workspace, `${f.workspace}-moved`);
  try {
    const batch = f.checks(); assert.equal(batch.checks.find(check => check.kind === "scope")!.status, "checker_error");
    const review = f.review(batch); assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }));
  } finally { fs.renameSync(`${f.workspace}-moved`, f.workspace); }
});

test("T6 file mutation between application verification and storage commit cannot create accepted", async t => {
  const f = await reviewFixture(t); await f.finish(); const review = f.review(), original = f.store.acceptAttempt.bind(f.store);
  f.store.acceptAttempt = (...args) => { fs.appendFileSync(f.source, "// changed before final storage gate\n"); return original(...args); };
  assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }));
  assert.equal(f.current().state, "needs_review"); assert.equal(f.store.operations.isClosed(f.current()), false);
});

test("T6 two real processes race final acceptance under one SQLite authority", async t => {
  const f = await reviewFixture(t); await f.finish(); const review = f.review(), input = { ...f.op(), reviewId: review.reviewId };
  const run = (operationId: string) => new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", new URL("./support/typescript-loader.mjs", import.meta.url).href, fileURLToPath(new URL("./support/review-race-worker.ts", import.meta.url)), f.store.file, JSON.stringify({ ...input, operationId })], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", data => out += String(data)); child.stderr.on("data", data => err += String(data));
    child.once("error", reject); child.once("exit", code => { if (code !== 0) reject(Error(`Review process failed ${code}: ${err}`)); else { try { resolve(JSON.parse(out)); } catch (error) { reject(error); } } });
  });
  const results = await Promise.all([run("race-a"), run("race-b")]);
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results)); assert.equal(results.find(result => !result.ok)!.code, "STALE_REVISION");
  assert.equal(f.current().state, "accepted"); assert.equal(f.store.listTaskEvents("task").events.filter(event => event.type === "task_closed").length, 1);
});

test("T6 real MCP tool schemas refuse legacy acceptance and expose the same review lifecycle", async t => {
  const f = await reviewFixture(t, "dsh"); await f.finish();
  const client = new Client({ name: "t6-synthetic-review", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["--import", new URL("./support/typescript-loader.mjs", import.meta.url).href, fileURLToPath(new URL("../src/server.ts", import.meta.url))],
    cwd: path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))), stderr: "pipe",
    env: { ...getDefaultEnvironment(), WORKBUDDY_BACKEND: "desktop-queue", WORKBUDDY_DB_FILE: f.store.file, WORKBUDDY_RUNS_DIR: f.runs,
      WORKBUDDY_CONFIG_DIR: f.root, WORKBUDDY_CLI_ELECTRON: process.execPath, WORKBUDDY_SERVICE_CONFIG: path.join(f.root, "unused-service.json") } });
  try {
    await client.connect(transport);
    const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === "workbuddy_review_task"));
    const legacy = await client.callTool({ name: "workbuddy_accept_task", arguments: { taskId: "task", note: "Worker says passed", evidence: ["passed"] } });
    assert.equal(legacy.isError, true); assert.equal(f.current().state, "needs_review");
    const call = async (name: string, args: object) => {
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      assert.notEqual(result.isError, true);
      const content = result.content as Array<{ type: string; text?: string }>;
      const data = JSON.parse(content.find(block => block.type === "text")!.text!); assert.equal(data.ok, true); return data;
    };
    const batch = await call("workbuddy_check_task", f.op());
    const review = await call("workbuddy_review_task", { ...f.op(), machineCheckIds: batch.machineCheckIds, semanticChecks: [], note: "Actual synthetic source inspection" });
    const accepted = await call("workbuddy_accept_task", { ...f.op(), reviewId: review.reviewId }); assert.equal(accepted.task.state, "accepted");
    const stored = await call("workbuddy_get_reviews", { taskId: "task" }); assert.equal(stored.reviews.length, 1);
    assert.equal(stored.reviews[0].reviewId, review.reviewId); assert.equal(f.prompts(), 1);
  } finally { await client.close(); }
});

test("T6 migration preserves accepted history without inventing authentication, scope or independent review", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t6-history-")), file = path.join(dir, "tasks.sqlite");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE tasks(task_id TEXT PRIMARY KEY,message_id TEXT NOT NULL,objective TEXT NOT NULL,workspace TEXT,state TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_message_id TEXT,report_json TEXT,cancel_note TEXT,review_note TEXT,reviewed_at TEXT,revision TEXT)");
  old.prepare("INSERT INTO tasks(task_id,message_id,objective,state,created_at,updated_at,review_note,reviewed_at) VALUES(?,?,?,?,?,?,?,?)").run("history", "old", "Synthetic legacy accepted fact", "accepted", "2026-10-18T00:00:00Z", "2026-10-18T01:00:00Z", "Original historical note", "2026-10-18T01:00:00Z"); old.close();
  const store = new TaskStore(file); t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(store.get("history")!.state, "accepted"); assert.equal(store.get("history")!.reviewNote, "Original historical note");
  assert.deepEqual(store.reviews.list("history"), []); assert.equal(store.getContract("history").state, "absent");
  assert.equal(store.workspaceProtection.readView("history").baseline, "missing"); assert.deepEqual(store.listTaskEvents("history").events, []);
});

test("T6 authenticated worker command JSON cannot forge an independent program check", async t => {
  const f = await reviewFixture(t, "workbuddy", { command: true });
  const contract = f.store.getContract("task"); if (contract.state !== "found") throw Error("Missing fixture contract");
  const spec = JSON.parse(contract.record.contract.requiredChecks[0]!.definition), hash = crypto.createHash("sha256").update(fs.readFileSync(f.source)).digest("hex");
  const file = path.join(f.journal().dir, "commands", `${crypto.randomUUID()}.json`); fs.mkdirSync(path.dirname(file), { recursive: true });
  // A worker can write plausible JSON; no command actually ran here.
  fs.writeFileSync(file, JSON.stringify({ ...spec, endedAt: new Date().toISOString(), exitCode: 0, cleanupConfirmed: true, before: { [f.source]: hash }, after: { [f.source]: hash } }));
  await f.finish(true, [{ path: file, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") }]);
  assert.ok(f.journal().snapshot()!.reportAuthentication);
  const batch = f.checks(); assert.equal(batch.checks.find(check => check.checkId === "test")!.status, "unknown");
  const review = f.review(batch); assert.throws(() => f.service.acceptReview({ ...f.op(), reviewId: review.reviewId }), { code: "CHECKS_REQUIRED" });
  assert.equal(f.current().state, "needs_review");
});
