/**
 * The immutable task contract: validation, normalization and persistence.
 *
 * The store tests use a temporary database. The concurrency test opens two
 * independent connections to the same file, which is the case a single
 * process-local lock would not cover. Nothing here touches a real database,
 * dispatches work or executes a check command.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.js";
import { readTaskProjection, registerTaskProjectionTool, type TaskProjectionSources } from "../src/task-view-reader.js";
import {
  TASK_CONTRACT_POLICY,
  TASK_CONTRACT_SCHEMA_VERSION,
  agreementVersionFor,
  persistedTaskContract,
  validateTaskContract,
  type NormalizedTaskContract,
} from "../src/task-contract.js";

const TASK_ID = "contract-task";

/** A valid submitted contract. */
function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: TASK_ID,
    workspaceId: "example-project",
    title: "修复折扣边界",
    objective: "修复折扣计算并补充边界测试",
    model: "deepseek-v4.1-flash",
    timeoutSeconds: 1800,
    maxAttempts: 3,
    scope: {
      allowedChanges: ["src/Discount.java", "test/DiscountTest.java"],
      permittedMetadata: [],
    },
    requiredChecks: [
      { id: "discount-contract", kind: "command", definition: "运行项目已登记的折扣测试检查" },
      { id: "normal-behavior", kind: "semantic", definition: "原有效输入行为保持不变" },
    ],
    ...overrides,
  };
}

function accepted(overrides: Record<string, unknown> = {}): { contract: NormalizedTaskContract; contractHash: string } {
  const result = validateTaskContract(submission(overrides));
  assert.equal(result.ok, true, result.ok ? "" : `${result.rejection.code}: ${result.rejection.message}`);
  if (!result.ok) throw new Error("invalid fixture");
  return { contract: result.contract, contractHash: result.contractHash };
}

function rejectionOf(overrides: Record<string, unknown>): string {
  const result = validateTaskContract(submission(overrides));
  assert.equal(result.ok, false, "expected a rejection");
  if (result.ok) throw new Error("expected a rejection");
  return result.rejection.code;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

test("a valid contract is accepted and normalized", () => {
  const result = validateTaskContract(submission());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.contractHash, /^[a-f0-9]{64}$/);
  assert.equal(result.contract.title, "修复折扣边界");
  assert.deepEqual(result.contract.scope.allowedChanges, ["src/Discount.java", "test/DiscountTest.java"]);
});

test("unknown top-level, scope and check fields are refused", () => {
  assert.equal(rejectionOf({ extra: 1 }), "unknown_field");
  assert.equal(rejectionOf({ scope: { allowedChanges: [], permittedMetadata: [], extra: 1 } }), "unknown_field");
  assert.equal(rejectionOf({ requiredChecks: [{ id: "a", kind: "command", definition: "d", note: "x" }] }), "unknown_field");
});

test("an unsupported schema version is refused", () => {
  assert.equal(rejectionOf({ schemaVersion: "workbuddy-executor/vnext-2" }), "unsupported_schema_version");
});

test("duplicate check ids are refused", () => {
  assert.equal(rejectionOf({ requiredChecks: [
    { id: "same", kind: "command", definition: "a" },
    { id: "same", kind: "semantic", definition: "b" },
  ] }), "duplicate_check_id");
});

test("wrong types and out-of-range numbers are refused", () => {
  assert.equal(rejectionOf({ title: 42 }), "invalid_type");
  assert.equal(rejectionOf({ timeoutSeconds: "1800" }), "invalid_type");
  assert.equal(rejectionOf({ timeoutSeconds: 0 }), "invalid_value");
  assert.equal(rejectionOf({ timeoutSeconds: 90_000 }), "invalid_value");
  assert.equal(rejectionOf({ maxAttempts: 0 }), "invalid_value");
  assert.equal(rejectionOf({ maxAttempts: 1.5 }), "invalid_type");
});

test("documented length limits are enforced", () => {
  assert.equal(rejectionOf({ title: "x".repeat(121) }), "invalid_length");
  assert.equal(rejectionOf({ objective: "x".repeat(100_001) }), "invalid_length");
  assert.equal(rejectionOf({ scope: { allowedChanges: Array.from({ length: 101 }, (_, index) => `src/file${index}.ts`), permittedMetadata: [] } }), "too_many_items");
  assert.equal(rejectionOf({ requiredChecks: Array.from({ length: 101 }, (_, index) => ({ id: `c${index}`, kind: "command", definition: "d" })) }), "too_many_items");
  assert.equal(rejectionOf({ title: "   " }), "invalid_value");
});

test("scope paths are lexically constrained to workspace-relative declarations", () => {
  const ok = (allowed: string[]) => validateTaskContract(submission({ scope: { allowedChanges: allowed, permittedMetadata: [] } })).ok;
  assert.equal(ok(["src/Discount.java"]), true);
  assert.equal(ok(["src/generated/**"]), true);
  assert.equal(ok(["src\\nested\\file.ts"]), true, "backslashes are normalized, not refused");
  for (const bad of ["/etc/passwd", "C:/Windows/system32", "//server/share/file", "../outside.ts", "src/../../escape.ts", "src/*.ts", "src/?.ts", "src/[ab].ts", "src/{a,b}.ts", "/**", "src//double.ts"]) {
    assert.equal(ok([bad]), false, `expected rejection for ${bad}`);
  }
});

test("a check definition cannot smuggle a conclusion or an actor", () => {
  for (const forbidden of ["actor", "passed", "status", "verified", "result", "conclusion"]) {
    const result = validateTaskContract(submission({ requiredChecks: [{ id: "a", kind: "command", definition: "d", [forbidden]: "program" }] }));
    assert.equal(result.ok, false, `${forbidden} must be refused`);
    if (!result.ok) assert.equal(result.rejection.code, "check_conclusion_not_allowed");
  }
});

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

test("key order does not change the digest", () => {
  const reordered = {
    requiredChecks: submission().requiredChecks,
    scope: { permittedMetadata: [], allowedChanges: ["src/Discount.java", "test/DiscountTest.java"] },
    maxAttempts: 3,
    timeoutSeconds: 1800,
    model: "deepseek-v4.1-flash",
    objective: "修复折扣计算并补充边界测试",
    title: "修复折扣边界",
    workspaceId: "example-project",
    taskId: TASK_ID,
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
  };
  const left = validateTaskContract(submission());
  const right = validateTaskContract(reordered);
  assert.equal(left.ok && right.ok, true);
  if (!left.ok || !right.ok) return;
  assert.equal(left.contractHash, right.contractHash);
});

test("scope and check order do not change the digest, and nothing is dropped", () => {
  const left = accepted();
  const right = accepted({
    scope: { allowedChanges: ["test/DiscountTest.java", "src/Discount.java"], permittedMetadata: [] },
    requiredChecks: [
      { id: "normal-behavior", kind: "semantic", definition: "原有效输入行为保持不变" },
      { id: "discount-contract", kind: "command", definition: "运行项目已登记的折扣测试检查" },
    ],
  });
  assert.equal(left.contractHash, right.contractHash);
  // Reordering normalizes; it never truncates.
  assert.equal(right.contract.requiredChecks.length, 2);
  assert.deepEqual(right.contract.requiredChecks.map(check => check.id), ["discount-contract", "normal-behavior"]);
  assert.deepEqual(right.contract.scope.allowedChanges, ["src/Discount.java", "test/DiscountTest.java"]);
});

test("the natural language objective is preserved verbatim", () => {
  const objective = "  保留前后空格与\n换行，不重写  ";
  const result = validateTaskContract(submission({ objective }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.contract.objective, objective);
});

test("a changed term changes the digest", () => {
  const base = accepted();
  for (const changed of [
    accepted({ title: "另一个标题" }),
    accepted({ objective: "另一个目标" }),
    accepted({ model: "another-model" }),
    accepted({ timeoutSeconds: 600 }),
    accepted({ maxAttempts: 2 }),
    accepted({ workspaceId: "other-project" }),
    accepted({ scope: { allowedChanges: ["src/Discount.java"], permittedMetadata: [] } }),
    accepted({ requiredChecks: [{ id: "discount-contract", kind: "command", definition: "另一个定义" }] }),
  ]) {
    assert.notEqual(changed.contractHash, base.contractHash);
  }
});

test("the agreement version is stable, task-bound and derived from the digest", () => {
  const { contract, contractHash } = accepted();
  assert.equal(agreementVersionFor(TASK_ID, contractHash), agreementVersionFor(TASK_ID, contractHash));
  assert.notEqual(agreementVersionFor(TASK_ID, contractHash), agreementVersionFor("other-task", contractHash));
  assert.match(agreementVersionFor(TASK_ID, contractHash), /^av1-[a-f0-9]{32}$/);
  const record = persistedTaskContract(contract, contractHash, "2026-01-01T00:00:00.000Z");
  assert.equal(record.agreementVersion, agreementVersionFor(TASK_ID, contractHash));
});

test("the effective attempt budget is the smaller of the request and the policy", () => {
  const { contract, contractHash } = accepted({ maxAttempts: 9 });
  const record = persistedTaskContract(contract, contractHash, "2026-01-01T00:00:00.000Z");
  assert.equal(record.requestedMaxAttempts, 9);
  assert.equal(record.policyMaxAttempts, TASK_CONTRACT_POLICY.maxAttempts);
  assert.equal(record.effectiveMaxAttempts, TASK_CONTRACT_POLICY.maxAttempts);
  const small = accepted({ maxAttempts: 1 });
  assert.equal(persistedTaskContract(small.contract, small.contractHash, "x").effectiveMaxAttempts, 1);
});

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * A temporary store. The directory is removed only after the database is
 * closed: Windows keeps the WAL files locked while the handle is open.
 */
function tempStore(t: { after: (fn: () => void) => void }): { store: TaskStore; file: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-contract-"));
  const file = path.join(directory, "tasks.sqlite");
  const store = new TaskStore(file);
  t.after(() => {
    try { store.close(); } catch { /* already closed by the test */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, file };
}

function taskRow(taskId = TASK_ID) {
  return { taskId, messageId: "msg-1", objective: "fixture", workspace: "E:/fixture", state: "queued" as const };
}

test("the first save creates the task and the contract together", t => {
  const { store } = tempStore(t);
  const { contract, contractHash } = accepted();
  const result = store.createTaskWithContract(taskRow(), contract, contractHash);
  assert.equal(result.status, "created");
  assert.ok(store.get(TASK_ID));
  const record = store.getContract(TASK_ID)!;
  assert.equal(record.contractHash, contractHash);
  assert.equal(record.agreementVersion, agreementVersionFor(TASK_ID, contractHash));
  assert.deepEqual(record.contract, contract);
});

test("an identical retry returns the original record and creates nothing", t => {
  const { store } = tempStore(t);
  const { contract, contractHash } = accepted();
  const first = store.createTaskWithContract(taskRow(), contract, contractHash);
  assert.equal(first.status, "created");
  const second = store.createTaskWithContract(taskRow(), contract, contractHash);
  assert.equal(second.status, "existing_same");
  if (first.status !== "created" || second.status !== "existing_same") return;
  assert.deepEqual(second.record, first.record);
  assert.equal(store.getContract(TASK_ID)!.createdAt, first.record.createdAt);
});

test("different terms are a conflict and never overwrite the stored contract", t => {
  const { store } = tempStore(t);
  const original = accepted();
  store.createTaskWithContract(taskRow(), original.contract, original.contractHash);
  const changed = accepted({ title: "另一个标题" });
  const result = store.createTaskWithContract(taskRow(), changed.contract, changed.contractHash);
  assert.equal(result.status, "conflict");
  const stored = store.getContract(TASK_ID)!;
  assert.equal(stored.contractHash, original.contractHash);
  assert.equal(stored.contract.title, original.contract.title);
});

test("a repeated request cannot raise an existing budget", t => {
  const { store } = tempStore(t);
  const small = accepted({ maxAttempts: 1 });
  store.createTaskWithContract(taskRow(), small.contract, small.contractHash);
  const raised = accepted({ maxAttempts: 3 });
  const result = store.createTaskWithContract(taskRow(), raised.contract, raised.contractHash);
  assert.equal(result.status, "conflict");
  assert.equal(store.getContract(TASK_ID)!.effectiveMaxAttempts, 1);
});

test("the version and digest survive a restart", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-contract-restart-"));
  const file = path.join(directory, "tasks.sqlite");
  const opened: TaskStore[] = [];
  t.after(() => {
    for (const store of opened) { try { store.close(); } catch { /* closed */ } }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { contract, contractHash } = accepted();

  const first = new TaskStore(file);
  opened.push(first);
  first.createTaskWithContract(taskRow(), contract, contractHash);
  const before = first.getContract(TASK_ID)!;
  first.close();

  const second = new TaskStore(file);
  opened.push(second);
  assert.deepEqual(second.getContract(TASK_ID), before);
});

test("an existing task without a contract is reported, never backfilled", t => {
  const { store } = tempStore(t);
  // A task created the old way: no contract row.
  store.createOrGet({ ...taskRow(), objective: "旧任务的目标", acceptanceCommands: ["npm test"], submissionHash: "a".repeat(64) });
  assert.equal(store.getContract(TASK_ID), undefined);

  const { contract, contractHash } = accepted();
  const result = store.createTaskWithContract(taskRow(), contract, contractHash);
  assert.equal(result.status, "task_without_contract");
  assert.equal(store.getContract(TASK_ID), undefined, "the query must not manufacture a contract");
  // The old fields are untouched too.
  assert.equal(store.get(TASK_ID)!.submissionHash, "a".repeat(64));
});

test("a contract is never written for another task's row", t => {
  const { store } = tempStore(t);
  const { contract, contractHash } = accepted();
  assert.throws(() => store.createTaskWithContract(taskRow("other-task"), contract, contractHash), /another task/);
  assert.equal(store.get("other-task"), undefined);
  assert.equal(store.getContract("other-task"), undefined);
});

test("a rejected second creation rolls back without leaving a half row", t => {
  const { store } = tempStore(t);
  const first = accepted();
  store.createTaskWithContract(taskRow(), first.contract, first.contractHash);

  const second = accepted({ title: "重复创建" });
  const again = store.createTaskWithContract(taskRow(), second.contract, second.contractHash);
  assert.equal(again.status, "conflict");
  // The rejected transaction left the original row and contract exactly as they were.
  assert.equal(store.get(TASK_ID)!.objective, "fixture");
  assert.equal(store.getContract(TASK_ID)!.contractHash, first.contractHash);
});

test("a failure inside the composite write rolls the task row back", t => {
  const { store } = tempStore(t);
  const shared = "run-11111111-1111-1111-1111-111111111111";
  // Task A already owns this attempt identity.
  store.createOrGet({ ...taskRow("task-a"), attemptId: shared, attempt: 1 });
  assert.ok(store.get("task-a"));

  // Task B arrives claiming the same attempt identity. The task row insert wins,
  // then the attempt snapshot is rejected, so the whole create must be undone.
  const { contract, contractHash } = accepted({ taskId: "task-b" });
  assert.throws(
    () => store.createTaskWithContract({ ...taskRow("task-b"), attemptId: shared, attempt: 1 }, contract, contractHash),
    /another task/,
  );
  assert.equal(store.get("task-b"), undefined, "the task row must be rolled back");
  assert.equal(store.getContract("task-b"), undefined, "no contract may remain");
  // The other task is untouched.
  assert.ok(store.get("task-a"));
});

test("a contract row cannot outlive its task", t => {
  const { store, file } = tempStore(t);
  const { contract, contractHash } = accepted();
  store.createTaskWithContract(taskRow(), contract, contractHash);
  const raw = new DatabaseSync(file);
  try {
    assert.throws(() => raw.exec("DELETE FROM tasks WHERE task_id = 'contract-task'"), /FOREIGN KEY/i);
  } finally {
    raw.close();
  }
  assert.ok(store.get(TASK_ID), "the task survives the refused delete");
  assert.ok(store.getContract(TASK_ID));
});

test("two connections racing on one task id create exactly once", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-contract-race-"));
  const file = path.join(directory, "tasks.sqlite");
  const left = new TaskStore(file);
  const right = new TaskStore(file);
  t.after(() => {
    try { left.close(); } catch { /* closed */ }
    try { right.close(); } catch { /* closed */ }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const { contract, contractHash } = accepted();
  const a = left.createTaskWithContract(taskRow(), contract, contractHash);
  const b = right.createTaskWithContract(taskRow(), contract, contractHash);
  const created = [a.status, b.status].filter(status => status === "created").length;
  assert.equal(created, 1, `exactly one creation expected, got ${a.status} and ${b.status}`);
  assert.equal([a.status, b.status].filter(status => status === "existing_same").length, 1);

  // A different contract on a second connection is a conflict, not an overwrite.
  const changed = accepted({ title: "并发改标题" });
  assert.equal(right.createTaskWithContract(taskRow(), changed.contract, changed.contractHash).status, "conflict");
  assert.equal(left.getContract(TASK_ID)!.contractHash, contractHash);
});

/* ------------------------------------------------------------------ *
 * The read-only projection
 * ------------------------------------------------------------------ */

test("the projection carries the stored contract", t => {
  const { store } = tempStore(t);
  const { contract, contractHash } = accepted();
  store.createTaskWithContract(taskRow(), contract, contractHash);

  const sources: TaskProjectionSources = { store, runsDir: path.join(path.dirname(store.file), "runs") };
  const result = readTaskProjection(sources, TASK_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.contract, "a stored contract must be returned");
  assert.equal(result.contract!.contractHash, contractHash);
  assert.equal(result.contract!.agreementVersion, agreementVersionFor(TASK_ID, contractHash));
  assert.deepEqual(result.contract!.contract, contract);
  // Still not a full TaskView.
  assert.equal(result.projection.actionFacts, null);
  assert.deepEqual(result.projection.allowedActions, ["export"]);
});

test("an old task projects with contract null", t => {
  const { store } = tempStore(t);
  store.createOrGet(taskRow());
  const sources: TaskProjectionSources = { store, runsDir: path.join(path.dirname(store.file), "runs") };
  const result = readTaskProjection(sources, TASK_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.contract, null, "absence is reported as null, not as an error");
});

test("a contract read failure is structured, not reported as no contract", t => {
  const { store } = tempStore(t);
  store.createOrGet(taskRow());
  const failing: TaskProjectionSources = {
    store: {
      get: id => store.get(id),
      listAttempts: id => store.listAttempts(id),
      getContract: () => { throw new Error("disk I/O error opening task_contracts"); },
    },
    runsDir: path.join(path.dirname(store.file), "runs"),
  };
  const result = readTaskProjection(failing, TASK_ID);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "store_unavailable");
  assert.equal(result.field, "store.getContract");
  assert.ok(!result.message.includes("disk I/O error opening"));
});

test("the registered tool returns the contract", async t => {
  const { store } = tempStore(t);
  const { contract, contractHash } = accepted();
  store.createTaskWithContract(taskRow(), contract, contractHash);

  const server = new McpServer({ name: "contract-test", version: "0.0.0" });
  registerTaskProjectionTool(server, { store, runsDir: path.join(path.dirname(store.file), "runs") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-client", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "workbuddy_get_task_projection", arguments: { taskId: TASK_ID } });
    const text = (response.content as Array<{ type: string; text?: string }>).find(part => part.type === "text")?.text ?? "{}";
    const payload = JSON.parse(text);
    assert.equal(payload.ok, true);
    assert.equal(payload.contract.contractHash, contractHash);
    assert.equal(payload.contract.contract.requiredChecks.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the query writes neither the task, the contract nor any run file", t => {
  const { store } = tempStore(t);
  const { contract, contractHash } = accepted();
  store.createTaskWithContract(taskRow(), contract, contractHash);
  const runsDir = path.join(path.dirname(store.file), "runs");
  const sources: TaskProjectionSources = { store, runsDir };

  const taskBefore = JSON.stringify(store.get(TASK_ID));
  const contractBefore = JSON.stringify(store.getContract(TASK_ID));
  readTaskProjection(sources, TASK_ID);
  readTaskProjection(sources, TASK_ID);
  assert.equal(JSON.stringify(store.get(TASK_ID)), taskBefore);
  assert.equal(JSON.stringify(store.getContract(TASK_ID)), contractBefore);
  assert.equal(fs.existsSync(runsDir), false, "the query must not create the runs directory");
});
