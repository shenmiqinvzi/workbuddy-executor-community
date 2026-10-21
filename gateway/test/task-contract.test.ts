/**
 * The immutable task contract: validation, normalization and persistence.
 *
 * The store tests use a temporary database. The concurrency test spawns two
 * worker processes that open their own connections and start on a shared
 * barrier, so the contention is real rather than a sequential call pair.
 * Nothing here touches a real database, dispatches work or executes a check.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaskStore } from "../src/task-store.js";
import { readTaskProjection, registerTaskProjectionTool, type TaskProjectionSources } from "../src/task-view-reader.js";
import {
  TASK_CONTRACT_SCHEMA_VERSION,
  agreementVersionFor,
  persistedTaskContract,
  policyFromConfig,
  validateTaskContract,
  type NormalizedTaskContract,
  type TaskContractPolicy,
} from "../src/task-contract.js";

const TASK_ID = "contract-task";
const DEFAULT_POLICY: TaskContractPolicy = { maxAttempts: 3 };

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
  const record = persistedTaskContract(contract, contractHash, "2026-01-01T00:00:00.000Z", DEFAULT_POLICY);
  assert.equal(record.agreementVersion, agreementVersionFor(TASK_ID, contractHash));
});

test("the effective attempt budget is the smaller of the request and the policy", () => {
  const { contract, contractHash } = accepted({ maxAttempts: 9 });
  const record = persistedTaskContract(contract, contractHash, "2026-01-01T00:00:00.000Z", { maxAttempts: 1 });
  assert.equal(record.requestedMaxAttempts, 9);
  assert.equal(record.policyMaxAttempts, 1);
  assert.equal(record.effectiveMaxAttempts, 1, "a request of 9 under a policy of 1 is still 1");
  const small = accepted({ maxAttempts: 1 });
  assert.equal(persistedTaskContract(small.contract, small.contractHash, "x", { maxAttempts: 9 }).effectiveMaxAttempts, 1);
});

test("the policy comes from the service configuration", () => {
  assert.equal(policyFromConfig({ maxTaskAttempts: 1 }).maxAttempts, 1);
  assert.equal(policyFromConfig({ maxTaskAttempts: 9 }).maxAttempts, 9);
  assert.equal(policyFromConfig({}).maxAttempts, 3, "the documented default");
  assert.equal(policyFromConfig({ maxTaskAttempts: 0 }).maxAttempts, 3, "a nonsensical value falls back");
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
  return { taskId, messageId: "msg-1", workspace: "E:/fixture", state: "queued" as const };
}

function found(store: TaskStore, taskId = TASK_ID) {
  const read = store.getContract(taskId);
  assert.equal(read.state, "found", read.state === "integrity_failure" ? `${read.integrity.problem}: ${read.integrity.detail}` : read.state);
  if (read.state !== "found") throw new Error("expected a contract");
  return read.record;
}

test("the first save creates the task and the contract together", t => {
  const { store } = tempStore(t);
  const result = store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  assert.equal(result.status, "created");
  assert.ok(store.get(TASK_ID));
  const record = found(store);
  assert.equal(record.contractHash, accepted().contractHash, "the digest describes the submitted content");
  assert.equal(record.agreementVersion, agreementVersionFor(TASK_ID, record.contractHash));
  assert.deepEqual(record.contract, accepted().contract);
});

test("the digest is computed from the input, not supplied by the caller", t => {
  const { store } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  const original = found(store);

  // Changing the terms but claiming the old identity is a conflict, because the
  // method hashes what it was actually given. There is no digest parameter to
  // lie with.
  const changed = store.createTaskWithContract(taskRow(), submission({ title: "改变后的标题" }), DEFAULT_POLICY);
  assert.equal(changed.status, "conflict");
  assert.equal(found(store).contractHash, original.contractHash);
  assert.equal(found(store).contract.title, "修复折扣边界");

  // The same change expressed as the identical content is still the same record.
  assert.equal(store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY).status, "existing_same");
});

test("an illegal submitted object is rejected before anything is written", t => {
  const { store } = tempStore(t);
  for (const submitted of [null, undefined, "contract", 42, [], {}, { ...submission(), schemaVersion: "v9" }, { ...submission(), taskId: "another-task" }]) {
    const result = store.createTaskWithContract(taskRow(), submitted, DEFAULT_POLICY);
    assert.equal(result.status, "rejected", `expected rejection for ${JSON.stringify(submitted)}`);
    assert.equal(store.get(TASK_ID), undefined, "no task row may survive a rejected contract");
    assert.equal(store.getContract(TASK_ID).state, "absent", "no contract may survive a rejected contract");
  }
});

test("a task objective that contradicts the contract is refused", t => {
  const { store } = tempStore(t);
  const result = store.createTaskWithContract({ ...taskRow(), objective: "另一个目标" }, submission(), DEFAULT_POLICY);
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") return;
  assert.equal(result.rejection.code, "objective_mismatch");
  assert.equal(store.get(TASK_ID), undefined);
  assert.equal(store.getContract(TASK_ID).state, "absent");
});

test("the task objective is derived from the contract when omitted", t => {
  const { store } = tempStore(t);
  const result = store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  assert.equal(result.status, "created");
  const contractObjective = accepted().contract.objective;
  assert.equal(store.get(TASK_ID)!.objective, contractObjective);
  assert.equal(store.get(TASK_ID)!.objective, found(store).contract.objective);
});

test("an identical retry returns the original record and creates nothing", t => {
  const { store } = tempStore(t);
  const first = store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  assert.equal(first.status, "created");
  const second = store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  assert.equal(second.status, "existing_same");
  if (first.status !== "created" || second.status !== "existing_same") return;
  assert.deepEqual(second.record, first.record);
  assert.equal(found(store).createdAt, first.record.createdAt);
});

test("a later policy change does not rewrite an existing budget", t => {
  const { store } = tempStore(t);
  const first = store.createTaskWithContract(taskRow(), submission({ maxAttempts: 9 }), { maxAttempts: 1 });
  assert.equal(first.status, "created");
  if (first.status !== "created") return;
  assert.equal(first.record.effectiveMaxAttempts, 1);

  // The service policy is raised afterwards and the same contract is retried.
  const retried = store.createTaskWithContract(taskRow(), submission({ maxAttempts: 9 }), { maxAttempts: 5 });
  assert.equal(retried.status, "existing_same");
  if (retried.status !== "existing_same") return;
  assert.deepEqual(retried.record, first.record, "the stored policy snapshot must not be recomputed");
  assert.equal(retried.record.policyMaxAttempts, 1);
  assert.equal(retried.record.effectiveMaxAttempts, 1);
});

test("a repeated request cannot raise an existing budget", t => {
  const { store } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission({ maxAttempts: 1 }), DEFAULT_POLICY);
  const raised = store.createTaskWithContract(taskRow(), submission({ maxAttempts: 3 }), DEFAULT_POLICY);
  assert.equal(raised.status, "conflict");
  assert.equal(found(store).effectiveMaxAttempts, 1);
});

test("the version and digest survive a restart", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-contract-restart-"));
  const file = path.join(directory, "tasks.sqlite");
  const opened: TaskStore[] = [];
  t.after(() => {
    for (const store of opened) { try { store.close(); } catch { /* closed */ } }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const first = new TaskStore(file);
  opened.push(first);
  first.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  const before = found(first);
  first.close();

  const second = new TaskStore(file);
  opened.push(second);
  assert.deepEqual(found(second), before);
});

test("an existing task without a contract is reported, never backfilled", t => {
  const { store } = tempStore(t);
  store.createOrGet({ ...taskRow(), objective: "旧任务的目标", acceptanceCommands: ["npm test"], submissionHash: "a".repeat(64) });
  assert.deepEqual(store.getContract(TASK_ID), { state: "absent" });

  const result = store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  assert.equal(result.status, "task_without_contract");
  assert.deepEqual(store.getContract(TASK_ID), { state: "absent" }, "the query must not manufacture a contract");
  assert.equal(store.get(TASK_ID)!.submissionHash, "a".repeat(64));
});

test("a failure inside the composite write rolls the task row back", t => {
  const { store } = tempStore(t);
  const shared = "run-11111111-1111-1111-1111-111111111111";
  store.createOrGet({ ...taskRow("task-a"), objective: "任务 A", attemptId: shared, attempt: 1 });
  assert.ok(store.get("task-a"));

  // The attempt snapshot is rejected inside the transaction, after the task row,
  // so the whole create must roll back. An internal invariant failure surfaces
  // as a thrown error rather than a caller-facing rejection.
  assert.throws(
    () => store.createTaskWithContract(
      { ...taskRow("task-b"), attemptId: shared, attempt: 1 },
      submission({ taskId: "task-b" }),
      DEFAULT_POLICY,
    ),
    /another task/,
  );
  assert.equal(store.get("task-b"), undefined, "the task row must be rolled back");
  assert.deepEqual(store.getContract("task-b"), { state: "absent" });
  assert.ok(store.get("task-a"));
});

test("a contract row cannot outlive its task", t => {
  const { store, file } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  const raw = new DatabaseSync(file);
  try {
    assert.throws(() => raw.exec("DELETE FROM tasks WHERE task_id = 'contract-task'"), /FOREIGN KEY/i);
  } finally {
    raw.close();
  }
  assert.ok(store.get(TASK_ID));
  assert.ok(found(store));
});

/* ------------------------------------------------------------------ *
 * Stored records are re-verified on read
 * ------------------------------------------------------------------ */

/** Rewrite one column of the stored contract row. */
function tamperRow(file: string, change: (row: Record<string, unknown>) => void): void {
  const raw = new DatabaseSync(file);
  try {
    const row = raw.prepare("SELECT * FROM task_contracts WHERE task_id = ?").get(TASK_ID) as Record<string, unknown>;
    change(row);
    raw.prepare(`UPDATE task_contracts SET contract_json = ?, contract_hash = ?, agreement_version = ?, schema_version = ?,
      requested_max_attempts = ?, policy_max_attempts = ?, effective_max_attempts = ? WHERE task_id = ?`).run(
      String(row.contract_json), String(row.contract_hash), String(row.agreement_version), String(row.schema_version),
      Number(row.requested_max_attempts), Number(row.policy_max_attempts), Number(row.effective_max_attempts), TASK_ID,
    );
  } finally {
    raw.close();
  }
}

test("a stored contract whose content changed is an integrity failure", t => {
  const { store, file } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  tamperRow(file, row => {
    const parsed = JSON.parse(String(row.contract_json));
    parsed.title = "被改写";
    row.contract_json = JSON.stringify(parsed);
  });
  const read = store.getContract(TASK_ID);
  assert.equal(read.state, "integrity_failure");
  if (read.state !== "integrity_failure") return;
  assert.equal(read.integrity.problem, "digest");
});

test("a stored digest that no longer matches is an integrity failure", t => {
  const { store, file } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  tamperRow(file, row => { row.contract_hash = "0".repeat(64); });
  const read = store.getContract(TASK_ID);
  assert.equal(read.state, "integrity_failure");
  if (read.state !== "integrity_failure") return;
  assert.equal(read.integrity.problem, "digest");
});

test("a forged agreement version is an integrity failure", t => {
  const { store, file } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  tamperRow(file, row => { row.agreement_version = "av1-" + "1".repeat(32); });
  const read = store.getContract(TASK_ID);
  assert.equal(read.state, "integrity_failure");
  if (read.state !== "integrity_failure") return;
  assert.equal(read.integrity.problem, "agreement_version");
});

test("inconsistent budget metadata is an integrity failure", t => {
  const { store, file } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission({ maxAttempts: 3 }), { maxAttempts: 1 });
  tamperRow(file, row => { row.effective_max_attempts = 3; });
  const read = store.getContract(TASK_ID);
  assert.equal(read.state, "integrity_failure");
  if (read.state !== "integrity_failure") return;
  assert.equal(read.integrity.problem, "attempt_budget");
});

test("a requested limit that disagrees with the contract is an integrity failure", t => {
  const { store, file } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission({ maxAttempts: 2 }), DEFAULT_POLICY);
  tamperRow(file, row => { row.requested_max_attempts = 3; row.effective_max_attempts = 3; });
  const read = store.getContract(TASK_ID);
  assert.equal(read.state, "integrity_failure");
  if (read.state !== "integrity_failure") return;
  assert.equal(read.integrity.problem, "attempt_budget");
});

test("a schema version that disagrees with the record is an integrity failure", t => {
  const { store, file } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  tamperRow(file, row => { row.schema_version = "workbuddy-executor/vnext-9"; });
  const read = store.getContract(TASK_ID);
  assert.equal(read.state, "integrity_failure");
  if (read.state !== "integrity_failure") return;
  assert.equal(read.integrity.problem, "schema");
});

/* ------------------------------------------------------------------ *
 * Real concurrency
 * ------------------------------------------------------------------ */

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Start one worker process per contract on a shared barrier and return their
 * results. Every worker opens its own connection and waits for the same start
 * signal, so they contend for the task id instead of taking turns.
 */
async function raceContracts(
  directory: string,
  contracts: unknown[],
  policy: TaskContractPolicy,
  dbFile = path.join(directory, "tasks.sqlite"),
): Promise<Array<Record<string, unknown>>> {
  const barrier = path.join(directory, "barrier");
  fs.mkdirSync(barrier, { recursive: true });
  const policyFile = path.join(directory, "policy.json");
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  // Create the schema before the workers start, so they contend over the
  // creation rather than over opening a brand-new database file.
  const seed = new TaskStore(dbFile);
  seed.close();

  const children: ChildProcess[] = [];
  const outputs: string[] = [];
  const errors: string[] = [];
  contracts.forEach((contract, slot) => {
    const contractFile = path.join(directory, `contract-${slot}.json`);
    fs.writeFileSync(contractFile, JSON.stringify(contract));
    const out = path.join(directory, `out-${slot}.json`);
    outputs.push(out);
    const child = spawn(process.execPath, [
      "--import", "./test/support/typescript-loader.mjs",
      path.resolve("test/support/contract-race-worker.ts"),
      "--db", dbFile, "--barrier", barrier, "--slot", String(slot),
      "--task", TASK_ID, "--contract", contractFile, "--policy", policyFile, "--out", out,
    ], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", chunk => errors.push(`[worker ${slot}] ${String(chunk).trim()}`));
    children.push(child);
  });

  try {
    // Wait until every worker has opened its connection and is parked.
    const deadline = Date.now() + 120_000;
    while (!children.every((_, slot) => fs.existsSync(path.join(barrier, `${slot}.ready`)))) {
      if (Date.now() > deadline) throw new Error(`workers did not reach the barrier: ${errors.join("\n")}`);
      await pause(10);
    }
    fs.writeFileSync(path.join(barrier, "go"), "");
    await Promise.all(children.map(child => new Promise<void>(resolve => { child.once("exit", () => resolve()); })));
    return outputs.map((output, slot) => {
      if (!fs.existsSync(output)) throw new Error(`worker ${slot} produced no result file: ${errors.join("\n")}`);
      return JSON.parse(fs.readFileSync(output, "utf8")) as Record<string, unknown>;
    });
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
  }
}

test("two processes racing with identical terms create exactly once", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-contract-race-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const results = await raceContracts(directory, [submission(), submission()], DEFAULT_POLICY);
  const statuses = results.map(result => String(result.status ?? result.error));
  assert.equal(statuses.filter(status => status === "created").length, 1, `exactly one creation expected, got ${statuses.join(", ")}`);
  assert.equal(statuses.filter(status => status === "existing_same").length, 1, `exactly one existing_same expected, got ${statuses.join(", ")}`);
  assert.equal(statuses.filter(status => status.startsWith("error")).length, 0, `workers must not fail: ${JSON.stringify(results)}`);

  const store = new TaskStore(path.join(directory, "tasks.sqlite"));
  try {
    assert.ok(store.get(TASK_ID), "the task exists");
    const record = found(store);
    assert.equal(record.contractHash, accepted().contractHash);
    assert.equal(store.get(TASK_ID)!.objective, record.contract.objective);
  } finally {
    store.close();
  }
});

test("two processes racing with different terms produce one winner and one conflict", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-contract-race-diff-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const results = await raceContracts(directory, [submission(), submission({ title: "另一个标题" })], DEFAULT_POLICY);
  const statuses = results.map(result => String(result.status ?? result.error));
  assert.equal(statuses.filter(status => status === "created").length, 1, `one winner expected, got ${statuses.join(", ")}`);
  assert.equal(statuses.filter(status => status === "conflict").length, 1, `one conflict expected, got ${statuses.join(", ")}`);

  const store = new TaskStore(path.join(directory, "tasks.sqlite"));
  try {
    const record = found(store);
    // Exactly one of the two contracts is stored, whole, and it matches the task row.
    assert.ok(
      record.contractHash === accepted().contractHash || record.contractHash === accepted({ title: "另一个标题" }).contractHash,
      "the stored contract must be one of the submitted contracts, not a mixture",
    );
    assert.equal(store.get(TASK_ID)!.objective, record.contract.objective);
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------------------ *
 * The read-only projection
 * ------------------------------------------------------------------ */

test("the projection carries the stored contract", t => {
  const { store } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  const expected = accepted();

  const sources: TaskProjectionSources = { store, runsDir: path.join(path.dirname(store.file), "runs") };
  const result = readTaskProjection(sources, TASK_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.contract, "a stored contract must be returned");
  assert.equal(result.contract!.contractHash, expected.contractHash);
  assert.equal(result.contract!.agreementVersion, agreementVersionFor(TASK_ID, expected.contractHash));
  assert.deepEqual(result.contract!.contract, expected.contract);
  assert.equal(result.projection.actionFacts, null);
  assert.deepEqual(result.projection.allowedActions, ["export"]);
});

test("an old task projects with contract null", t => {
  const { store } = tempStore(t);
  store.createOrGet({ ...taskRow(), objective: "旧任务的目标" });
  const sources: TaskProjectionSources = { store, runsDir: path.join(path.dirname(store.file), "runs") };
  const result = readTaskProjection(sources, TASK_ID);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.contract, null, "absence is reported as null, not as an error");
});

test("a corrupted stored contract is a structured error, not no contract", t => {
  const { store, file } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  tamperRow(file, row => {
    const parsed = JSON.parse(String(row.contract_json));
    parsed.title = "被改写";
    row.contract_json = JSON.stringify(parsed);
  });
  const sources: TaskProjectionSources = { store, runsDir: path.join(path.dirname(store.file), "runs") };
  const result = readTaskProjection(sources, TASK_ID);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "contract_integrity");
  assert.equal(result.field, "contract.digest", "the failure names which invariant broke");
});

test("a contract read failure is structured, not reported as no contract", t => {
  const { store } = tempStore(t);
  store.createOrGet({ ...taskRow(), objective: "旧任务的目标" });
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
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);

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
    assert.equal(payload.contract.contractHash, accepted().contractHash);
    assert.equal(payload.contract.contract.requiredChecks.length, 2);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the registered tool reports a corrupted contract as an error", async t => {
  const { store, file } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
  tamperRow(file, row => { row.contract_hash = "0".repeat(64); });

  const server = new McpServer({ name: "contract-corrupt", version: "0.0.0" });
  registerTaskProjectionTool(server, { store, runsDir: path.join(path.dirname(store.file), "runs") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "contract-corrupt-client", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    const response = await client.callTool({ name: "workbuddy_get_task_projection", arguments: { taskId: TASK_ID } });
    const text = (response.content as Array<{ type: string; text?: string }>).find(part => part.type === "text")?.text ?? "{}";
    const payload = JSON.parse(text);
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "contract_integrity");
    assert.equal(payload.contract, undefined, "no contract may be returned for a record that failed verification");
  } finally {
    await client.close();
    await server.close();
  }
});

test("the query writes neither the task, the contract nor any run file", t => {
  const { store } = tempStore(t);
  store.createTaskWithContract(taskRow(), submission(), DEFAULT_POLICY);
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
