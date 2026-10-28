import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";

test("persists task identity, idempotency, messages, and state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-gateway-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  const first = store.createOrGet({ taskId: "task-1", messageId: "msg-1", objective: "demo", state: "working" });
  const second = store.createOrGet({ taskId: "task-1", messageId: "msg-2", objective: "duplicate", state: "working" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.task.messageId, "msg-1");
  assert.equal(store.addMessages("task-1", [{ message_id: "msg-2", role: "assistant", content: ["done"] }]), 1);
  assert.equal(store.addMessages("task-1", [{ message_id: "msg-2", role: "assistant", content: ["done"] }]), 0);
  const updated = store.update("task-1", { state: "completed", lastMessageId: "msg-2" });
  assert.equal(updated.state, "completed");
  assert.equal(store.listMessages("task-1")[0]?.message_id, "msg-2");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("supports a rework attempt and a separate Codex acceptance record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-review-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  store.createOrGet({ taskId: "review-1", messageId: "run-1", objective: "demo", state: "completed", lastMessageId: "run-1" });

  const rework = store.update("review-1", {
    messageId: "run-2",
    lastMessageId: "run-2",
    state: "working",
    report: null,
    reviewNote: null,
    reviewedAt: null,
  });
  assert.equal(rework.messageId, "run-2");
  assert.equal(rework.lastMessageId, "run-2");
  assert.equal(rework.report, undefined);
  assert.equal(rework.reviewNote, undefined);

  const accepted = store.update("review-1", {
    state: "accepted",
    reviewNote: "Diff and tests checked by Codex.",
    reviewedAt: "2026-10-07T00:00:00.000Z",
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.reviewNote, "Diff and tests checked by Codex.");
  assert.equal(accepted.reviewedAt, "2026-10-07T00:00:00.000Z");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("migrates legacy task and message tables without losing history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-migration-"));
  const file = path.join(dir, "tasks.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, objective TEXT NOT NULL, workspace TEXT,
      state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_message_id TEXT,
      report_json TEXT, cancel_note TEXT
    );
    CREATE TABLE messages (
      task_id TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL, content_json TEXT NOT NULL,
      msg_type TEXT, created_at TEXT, raw_json TEXT NOT NULL, PRIMARY KEY(task_id, message_id)
    );
    INSERT INTO tasks VALUES ('old', 'old-run', 'original objective', '/project', 'completed', '2026-10-01', '2026-10-02', 'old-result', NULL, 'old note');
  `);
  legacy.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)").run("old", "old-result", "assistant", '["old work"]', "text", "2026-10-02", JSON.stringify({ message_id: "old-result", role: "assistant", content: ["old work"] }));
  legacy.close();
  let store = new TaskStore(file);
  assert.equal(store.get("old")?.objective, "original objective");
  assert.equal(store.get("old")?.cancelNote, "old note");
  assert.equal(store.listMessages("old")[0]?.content[0], "old work");
  store.update("old", { constraints: ["keep original audio"], acceptanceCommands: ["check media"], sessionId: "session-old" });
  store.beginAttempt("old", { attemptId: "migrated-attempt", messageId: "new-run" });
  assert.equal(store.listMessages("old").length, 0);
  assert.equal(store.listMessages("old", 100, "")[0]?.message_id, "old-result");
  store.close();
  store = new TaskStore(file);
  assert.deepEqual(store.get("old")?.constraints, ["keep original audio"]);
  assert.equal(store.get("old")?.sessionId, "session-old");
  assert.equal(store.listAttempts("old").length, 1);
  assert.equal(store.listMessages("old", 100, "").length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reserves a single durable attempt across two MCP stores and survives restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-reservation-"));
  const file = path.join(dir, "tasks.sqlite");
  let first = new TaskStore(file);
  const second = new TaskStore(file);
  first.createOrGet({ taskId: "active", messageId: "pending", objective: "video", state: "queued", constraints: ["do not change script"], acceptanceCommands: ["ffprobe output.mp4"] });
  first.beginAttempt("active", { attemptId: "attempt-1", messageId: "durable-attempt-1", sessionId: "desktop-session", runtimeSource: "workbuddy-interactive" });
  assert.throws(() => second.beginAttempt("active", { attemptId: "attempt-2", messageId: "durable-attempt-2" }), /active attempt/);
  first.updateAttempt("active", "attempt-1", { state: "working", lastEventSeq: 8, artifacts: ["output.mp4"], evidence: ["tool completed render"], blockingReason: null });
  first.close();
  first = new TaskStore(file);
  const restored = first.get("active")!;
  assert.equal(restored.sessionId, "desktop-session");
  assert.equal(restored.runtimeSource, "workbuddy-interactive");
  assert.equal(restored.lastEventSeq, 8);
  assert.deepEqual(restored.constraints, ["do not change script"]);
  assert.deepEqual(first.listTasks({ states: ["queued", "working"] }).map((task) => task.taskId), ["active"]);
  assert.throws(() => first.beginAttempt("active", { attemptId: "attempt-3", messageId: "durable-attempt-3" }), /active attempt/);
  assert.equal(first.listAttempts("active")[0]?.state, "working");
  first.close();
  second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isolates rework evidence and messages while keeping the original session and historical attempt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-attempts-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  store.createOrGet({ taskId: "video", messageId: "pending", objective: "make video", state: "queued", constraints: ["original constraints"], acceptanceCommands: ["original checks"] });
  store.beginAttempt("video", { attemptId: "round-1", messageId: "run-1", sessionId: "bound-session", runtimeSource: "interactive" });
  store.addMessages("video", [{ message_id: "same-result-id", role: "assistant", content: ["first result"], metadata: { attemptId: "round-1", eventSeq: 1 } }]);
  store.updateAttempt("video", "round-1", { state: "needs_review", lastEventSeq: 12, artifacts: ["first.mp4"], evidence: ["first render"], report: { filesChanged: ["first.mp4"], commandsRun: ["render first"], rawText: "first result" } });
  store.update("video", { reviewNote: "needs work", reviewedAt: "2026-10-08" });
  const next = store.beginAttempt("video", { attemptId: "round-2", messageId: "run-2" });
  assert.equal(next.attempt, 2);
  assert.equal(next.sessionId, "bound-session");
  assert.equal(next.report, undefined);
  assert.equal(next.reviewNote, undefined);
  assert.equal(next.lastEventSeq, 0);
  assert.deepEqual(next.artifacts, []);
  assert.deepEqual(next.evidence, []);
  assert.deepEqual(next.constraints, ["original constraints"]);
  assert.deepEqual(next.acceptanceCommands, ["original checks"]);
  assert.equal(store.listMessages("video").length, 0);
  assert.equal(store.updateAttempt("video", "round-1", { state: "failed", lastEventSeq: 99, artifacts: ["stale.mp4"] }).applied, false);
  assert.equal(store.addMessages("video", [{ message_id: "same-result-id", role: "assistant", content: ["second result"], metadata: { attemptId: "round-2", eventSeq: 1 } }]), 1);
  assert.equal(store.addMessages("video", [{ message_id: "same-result-id", role: "assistant", content: ["second result"], metadata: { attemptId: "round-2", eventSeq: 1 } }]), 0);
  assert.equal(store.listMessages("video")[0]?.content[0], "second result");
  assert.equal(store.listMessages("video", 100, "round-1")[0]?.content[0], "first result");
  store.updateAttempt("video", "round-2", { state: "working", lastEventSeq: 5 });
  assert.equal(store.updateAttempt("video", "round-2", { lastEventSeq: 3, state: "blocked" }).applied, false);
  assert.equal(store.get("video")?.state, "working");
  assert.deepEqual(store.listAttempts("video").map((attempt) => [attempt.attempt, attempt.artifacts]), [[1, ["first.mp4"]], [2, []]]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("keeps the terminal event visible after a long progress stream", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-events-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  store.createOrGet({ taskId: "long", messageId: "pending", objective: "long task", state: "queued" });
  store.beginAttempt("long", { attemptId: "long-attempt", messageId: "long-run" });
  store.addMessages("long", Array.from({ length: 601 }, (_, index) => ({ message_id: `event-${index + 1}`, role: "assistant", content: [index === 600 ? "final result" : "progress"], metadata: { attemptId: "long-attempt", eventSeq: index + 1 } })));
  const messages = store.listMessages("long", 500);
  assert.equal(messages.length, 500);
  assert.equal(messages[0]?.message_id, "event-102");
  assert.equal(messages.at(-1)?.content[0], "final result");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("protects Codex terminal decisions and atomically checks acceptance state", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-terminal-"));
  const store = new TaskStore(path.join(dir, "private-data", "tasks.sqlite"));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(store.file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  }
  store.createOrGet({ taskId: "terminal", messageId: "pending", objective: "verify", state: "queued", acceptanceCommands: ["original check"] });
  store.beginAttempt("terminal", { attemptId: "first", messageId: "first-run" });
  assert.equal(store.updateAttempt("terminal", "first", { state: "accepted" }, { expectedStates: ["needs_review", "completed"] }).applied, false);
  store.updateAttempt("terminal", "first", { state: "needs_review" });
  assert.equal(store.updateAttempt("terminal", "first", { state: "accepted", evidence: ["verified artifact"] }, { expectedStates: ["needs_review"] }).applied, true);
  assert.equal(store.updateAttempt("terminal", "first", { state: "needs_review", evidence: [] }).applied, false);
  assert.deepEqual(store.get("terminal")?.evidence, ["verified artifact"]);
  assert.throws(() => store.beginAttempt("terminal", { attemptId: "second", messageId: "second-run" }), { code: "CANCELLED_TERMINAL" });
  store.createOrGet({ taskId: "continuable", messageId: "pending", objective: "Open rework fixture", state: "needs_review", acceptanceCommands: ["original check"] });
  store.beginAttempt("continuable", { attemptId: "second", messageId: "second-run", acceptanceCommands: ["original check", "extra check"] });
  assert.deepEqual(store.get("continuable")?.acceptanceCommands, ["original check", "extra check"]);
  assert.throws(() => store.beginAttempt("continuable", { attemptId: "third", messageId: "third-run", acceptanceCommands: ["rejected parallel requirement"] }), /active attempt/);
  assert.deepEqual(store.get("continuable")?.acceptanceCommands, ["original check", "extra check"]);
  store.update("continuable", { state: "cancelled" });
  assert.equal(store.updateAttempt("continuable", "second", { state: "needs_review" }).applied, false);
  assert.equal(store.get("continuable")?.state, "cancelled");
});

test("every creation path seeds the revision and task_received in one transaction, idempotent replays never rewrite (T2-R5)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-create-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  try {
    // createOrGet: fresh creation must persist a revision and a task_received
    // event; an idempotent replay returns the same row untouched.
    const first = store.createOrGet({ taskId: "created", messageId: "msg-1", objective: "seed facts", state: "queued", workspace: dir });
    assert.equal(first.created, true);
    assert.ok(first.task.revision, "createOrGet seeds a revision on creation");
    assert.match(first.task.revision!, /^[A-Za-z0-9_-]{16}$/);
    const events = () => store.listTaskEvents("created", { limit: 200 }).events;
    const received = events().filter((event) => event.type === "task_received");
    assert.equal(received.length, 1, "exactly one task_received for the creation");
    assert.equal(received[0]?.actor, "codex");
    assert.equal(received[0]?.attemptId, null);
    const revisionAtCreation = first.task.revision!;
    const replay = store.createOrGet({ taskId: "created", messageId: "msg-2", objective: "duplicate", state: "working" });
    assert.equal(replay.created, false);
    assert.equal(replay.task.revision, revisionAtCreation, "a replay never rewrites the revision");
    assert.equal(events().filter((event) => event.type === "task_received").length, 1, "a replay never re-emits task_received");
    assert.equal(store.get("created")?.state, "queued", "a replay never overwrites stored facts");

    // createTaskWithContract: the same invariant on the contract path, plus
    // conflict/existing branches that must not touch revision or events.
    const contractTaskId = "contract-created";
    const contract = {
      schemaVersion: "workbuddy-executor/vnext-1", taskId: contractTaskId, workspaceId: "example-project",
      title: "Synthetic contract", objective: "Contract creation seeds T2 facts", model: "deepseek-v4.1-flash",
      timeoutSeconds: 600, maxAttempts: 3,
      scope: { allowedChanges: ["src/example.ts"], permittedMetadata: [] },
      requiredChecks: [{ id: "example-check", kind: "command", definition: "Run synthetic example check" }],
    } as const;
    const created = store.createTaskWithContract({ taskId: contractTaskId, messageId: "contract-message", state: "queued" }, contract, { maxAttempts: 3 });
    assert.equal(created.status, "created");
    assert.ok(created.task.revision, "createTaskWithContract seeds a revision on creation");
    const contractEvents = () => store.listTaskEvents(contractTaskId, { limit: 200 }).events;
    assert.equal(contractEvents().filter((event) => event.type === "task_received").length, 1);
    const contractRevision = created.task.revision!;
    const same = store.createTaskWithContract({ taskId: contractTaskId, messageId: "contract-message-2", state: "working" }, contract, { maxAttempts: 3 });
    assert.equal(same.status, "existing_same");
    assert.equal(same.task.revision, contractRevision, "an existing_same replay keeps the revision");
    assert.equal(contractEvents().filter((event) => event.type === "task_received").length, 1, "an existing_same replay re-emits nothing");
    assert.equal(store.get(contractTaskId)?.state, "queued");
    const conflict = store.createTaskWithContract({ taskId: contractTaskId, messageId: "contract-message-3", state: "queued" }, { ...contract, title: "A different contract" }, { maxAttempts: 3 });
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.task.revision, contractRevision, "a conflicting contract never rewrites the stored revision");
    assert.equal(contractEvents().filter((event) => event.type === "task_received").length, 1, "a conflicting contract re-emits nothing");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acceptance conditions and run evidence participate in the revision; non-input blockers never claim input semantics (T2-R1/R2)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-signature-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  try {
    store.createOrGet({ taskId: "signature", messageId: "pending", objective: "signature facts", state: "queued" });
    const baseline = store.get("signature")!;
    const baseRevision = baseline.revision!;

    // R1: acceptanceCommands/constraints are caller-facing acceptance
    // conditions — changing them regenerates the revision and emits an event.
    store.update("signature", { acceptanceCommands: ["new-required-command"], constraints: ["new constraint"] });
    const afterConditions = store.get("signature")!;
    assert.notEqual(afterConditions.revision, baseRevision, "changing acceptance conditions regenerates the revision");
    const afterConditionsEvents = store.listTaskEvents("signature", { limit: 200 }).events;
    const last = afterConditionsEvents.at(-1)!;
    assert.equal(last.type, "task_updated");
    assert.ok(last.payload.patch && (last.payload.patch as Record<string, unknown>).acceptanceCommands === 1, "the event payload names the acceptance patch");

    // No-op writes (same values) keep the revision and emit nothing.
    const stableRevision = store.get("signature")!.revision!;
    const countBefore = store.listTaskEvents("signature", { limit: 200 }).events.length;
    store.update("signature", { acceptanceCommands: ["new-required-command"], constraints: ["new constraint"] });
    assert.equal(store.get("signature")!.revision, stableRevision, "rewriting identical conditions keeps the revision");
    assert.equal(store.listTaskEvents("signature", { limit: 200 }).events.length, countBefore, "identical values emit no event");

    // R1: run evidence (stop proof digest) is a fact — writing a new digest
    // regenerates the revision; an unchanged digest does not.
    const digestA = JSON.stringify({ stopped: false, nativeStoppedAt: null, stopReason: null, reportDigest: "digest-1", reportAuthenticated: true, status: "needs_review" });
    store.update("signature", { runEvidenceDigest: digestA });
    const afterDigestA = store.get("signature")!;
    assert.notEqual(afterDigestA.revision, stableRevision, "a run-evidence change regenerates the revision");
    const digestARevision = afterDigestA.revision!;
    store.update("signature", { runEvidenceDigest: digestA });
    assert.equal(store.get("signature")!.revision, digestARevision, "an unchanged digest keeps the revision");
    const digestB = JSON.stringify({ stopped: true, nativeStoppedAt: "2026-10-23T09:00:00.000Z", stopReason: "native_idle", reportDigest: "digest-1", reportAuthenticated: true, status: "needs_review" });
    store.update("signature", { runEvidenceDigest: digestB });
    assert.notEqual(store.get("signature")!.revision, digestARevision, "stop evidence appearing regenerates the revision");

    // R2: beginAttempt writes attempt_queued exactly once (no duplicate from
    // the suppressed fact-event path).
    store.beginAttempt("signature", { attemptId: "attempt-1", messageId: "run-1", sessionId: "session-a" });
    const queued = store.listTaskEvents("signature", { limit: 200 }).events.filter((event) => event.type === "attempt_queued");
    assert.equal(queued.length, 1, "attempt_queued is written exactly once per attempt");
    assert.equal(queued[0]?.attemptId, "attempt-1");

    // R2: a blocker that is not an input request (state not transitioning to
    // blocked with the patch) never fabricates input_requested; the plain
    // state-change semantic survives.
    store.update("signature", { state: "working" });
    const eventsBeforeBlocker = store.listTaskEvents("signature", { limit: 200 }).events.length;
    store.update("signature", { blockingReason: "Native tool execution failed; not an input request" });
    const blockerEvent = store.listTaskEvents("signature", { limit: 200 }).events.at(-1)!;
    assert.equal(blockerEvent.type, "task_updated", "a non-input blocker keeps the plain fact semantic");
    assert.equal(store.listTaskEvents("signature", { limit: 200 }).events.length, eventsBeforeBlocker + 1);

    // R2: a real input request (transition into blocked with a reason and the
    // explicit inputRequested hint from the sync waiting_input path) emits
    // input_requested, and clearing it emits input_resolved.
    store.update("signature", { state: "blocked", blockingReason: "Approve this tool call", inputRequested: true });
    const blockedBatch = store.listTaskEvents("signature", { limit: 200 }).events.slice(-2).map((event) => event.type);
    assert.ok(blockedBatch.includes("input_requested"), `a real input request emits input_requested, got ${blockedBatch.join(",")}`);
    assert.ok(blockedBatch.includes("task_state_changed"), "the state fact itself still records its own event");
    store.update("signature", { state: "working", blockingReason: null });
    const resolvedBatch = store.listTaskEvents("signature", { limit: 200 }).events.slice(-2).map((event) => event.type);
    assert.ok(resolvedBatch.includes("input_resolved"), `clearing the reason emits input_resolved, got ${resolvedBatch.join(",")}`);

    // R2: blocked→blocked with the same reason emits no duplicate input event.
    store.update("signature", { state: "blocked", blockingReason: "Approve the next tool call", inputRequested: true });
    const countAfterSecond = store.listTaskEvents("signature", { limit: 200 }).events.length;
    assert.ok(countAfterSecond > 0);
    const beforeTypes = store.listTaskEvents("signature", { limit: 200 }).events.slice(-2).map((event) => event.type);
    assert.ok(beforeTypes.includes("input_requested"), "the second request emits input_requested once");
    store.update("signature", { blockingReason: "Approve the next tool call", inputRequested: true });
    const reblocked = store.listTaskEvents("signature", { limit: 200 }).events;
    assert.equal(reblocked.length, countAfterSecond, "a blocked rewrite with the same reason emits nothing new");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acceptance and task_closed commit atomically; a mid-transaction failure leaves neither behind (T2-R4)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-accept-"));
  const store = new TaskStore(path.join(dir, "tasks.sqlite"));
  try {
    store.createOrGet({ taskId: "atomic", messageId: "pending", objective: "atomic acceptance", workspace: dir, state: "queued", constraints: ["keep facts"] });
    store.workspaceProtection.create("atomic", dir, "synthetic-scope", { allowedChanges: [], permittedMetadata: [] }, path.join(dir, "runs"));
    const scopeGuard = store.workspaceProtection.guard("atomic");
    store.beginAttempt("atomic", { attemptId: "attempt-1", messageId: "run-1", sessionId: "session-a" });
    store.workspaceProtection.bindAttempt("atomic", "attempt-1", scopeGuard);
    store.updateAttempt("atomic", "attempt-1", { state: "needs_review", report: { status: "completed", filesChanged: [], commandsRun: [], rawText: "TASK_STATUS: completed" } });
    store.workspaceProtection.review("atomic", "attempt-1");

    // Fault injection: the closure append fails (NOT NULL occurred_at) after
    // the accepted-state write has run inside the same transaction. The
    // rollback must erase both — no accepted state, no closure, no review
    // event, and the revision stays where it was.
    const before = store.get("atomic")!;
    const beforeRevision = before.revision!;
    const beforeEvents = store.listTaskEvents("atomic", { limit: 200 }).events.length;
    const broken = { type: "task_closed", occurredAt: null as unknown as string, actor: "codex", payload: {}, sourceRef: null };
    assert.throws(() => store.acceptAttempt("atomic", "attempt-1", { state: "accepted", evidence: ["checked"], reviewNote: "n", reviewedAt: "2026-10-23T00:00:00.000Z" }, broken as never, { expectedStates: ["needs_review"] }), () => true, "a failing closure append rolls the acceptance back");
    const afterFailure = store.get("atomic")!;
    assert.equal(afterFailure.state, "needs_review", "the accepted state did not survive a failed closure append");
    assert.equal(afterFailure.reviewNote, before.reviewNote ?? undefined);
    assert.equal(afterFailure.revision, beforeRevision, "the revision is unchanged after the rollback");
    assert.equal(store.listTaskEvents("atomic", { limit: 200 }).events.length, beforeEvents, "no closure or review event leaked");
    assert.equal(store.listTaskEvents("atomic", { limit: 200 }).events.filter((event) => event.type === "task_closed").length, 0);

    // Recovery: the same acceptance retried with a valid closure commits both
    // facts together, exactly once.
    const accepted = store.acceptAttempt("atomic", "attempt-1", { state: "accepted", evidence: ["checked"], reviewNote: "verified by reviewer", reviewedAt: "2026-10-23T00:00:00.000Z" }, { type: "task_closed", occurredAt: "2026-10-23T00:00:00.000Z", actor: "codex", payload: { closedAs: "accepted", attempt: 1 }, sourceRef: null }, { expectedStates: ["needs_review"] });
    assert.equal(accepted.applied, true);
    assert.equal(accepted.task.state, "accepted");
    const closed = store.listTaskEvents("atomic", { limit: 200 }).events.filter((event) => event.type === "task_closed");
    assert.equal(closed.length, 1, "exactly one task_closed after the successful retry");
    const reviewEvents = store.listTaskEvents("atomic", { limit: 200 }).events.filter((event) => event.type === "review_recorded");
    assert.equal(reviewEvents.length, 1, "the review fact event is written once");
    assert.equal(store.listAttempts("atomic")[0]?.state, "accepted");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
