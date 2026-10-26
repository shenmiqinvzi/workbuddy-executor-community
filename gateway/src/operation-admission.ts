import { createHash } from "node:crypto";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { AdmissionError } from "./collaboration.js";
import type { StoredTask, TaskStore } from "./task-store.js";

export interface OperationOptions {
  operationId?: string;
  expectedRevision?: string | null;
  expectedAttemptId?: string | null;
}
export type OperationState = "reserved" | "effect_started" | "succeeded" | "rejected" | "outcome_unknown";
export interface OperationReceipt { operationId: string; operationState: OperationState; outcomeCode?: "OUTCOME_UNKNOWN" }
export interface PreparationBinding { taskId: string; workspace: string; sessionId: string | null; model: string; workerKey: string | null; title: string | null }
export interface OperationRecord {
  operationId: string; kind: string; taskId: string; attemptId: string | null;
  parameterDigest: string; expectedRevision: string | null; expectedAttemptId: string | null;
  executor: string; binding: unknown; state: OperationState;
  resolvedBinding?: { sessionId: string | null; runtimeSource: string | null };
  preparationBinding?: PreparationBinding;
  preparationSessionId?: string;
  preparationEnteredAt?: string;
  effectStartedAt?: string;
  createdAt: string; updatedAt: string; result?: unknown; error?: { code: string; message: string };
}
export class OperationOutcomeError extends AdmissionError {
  constructor(readonly operationId: string, readonly operationState: OperationState) {
    super("OUTCOME_UNKNOWN", "Observe the original operation and task; execution will not be retried automatically.");
  }
}

/** JSON data only; never hash transport metadata by accident or omit unknown behavior fields. */
export function operationDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (item === undefined) return null;
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(canonical);
    if (typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
    }
    throw new AdmissionError("INVALID_OPERATION", "Operation parameters must be finite JSON data.");
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** SQLite is the arbiter. The local promises only let same-process callers await a receipt. */
export class OperationAdmission {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(private readonly db: DatabaseSync, private readonly store: TaskStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS task_operations (
      operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      state TEXT NOT NULL, body_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_operations_task ON task_operations(task_id);
      CREATE TABLE IF NOT EXISTS workflow_capacity (
      slot INTEGER PRIMARY KEY CHECK(slot=1), task_id TEXT NOT NULL, executor TEXT NOT NULL, operation_id TEXT NOT NULL);`);
  }
  get(operationId: string): OperationRecord | null {
    const row = this.db.prepare("SELECT * FROM task_operations WHERE operation_id=?").get(operationId);
    if (!row) return null;
    try {
      const record = JSON.parse(String(row.body_json)) as OperationRecord;
      if (record.operationId !== operationId || record.taskId !== row.task_id || record.kind !== row.kind || record.state !== row.state) throw Error();
      return record;
    } catch { throw new AdmissionError("CONTRACT_INTEGRITY", "The operation record is invalid; execution remains blocked."); }
  }
  listUnfinished(): OperationRecord[] {
    return this.db.prepare("SELECT operation_id FROM task_operations WHERE state IN ('reserved','effect_started','outcome_unknown') ORDER BY rowid").all().map(row => this.get(String(row.operation_id))!);
  }
  originalBinding(taskId: string): unknown {
    const row = this.db.prepare("SELECT operation_id FROM task_operations WHERE task_id=? AND kind='send' AND state<>'rejected' ORDER BY rowid LIMIT 1").get(taskId);
    return row ? this.get(String(row.operation_id))!.binding : null;
  }
  originalSession(taskId: string): string | null {
    const row = this.db.prepare("SELECT operation_id FROM task_operations WHERE task_id=? AND kind='send' AND state<>'rejected' ORDER BY rowid LIMIT 1").get(taskId);
    if (!row) return null;
    const operation = this.get(String(row.operation_id))!;
    return operation.resolvedBinding?.sessionId ?? (operation.binding as { sessionId?: string })?.sessionId ?? null;
  }
  private save(record: OperationRecord): void {
    this.db.prepare("UPDATE task_operations SET state=?,body_json=? WHERE operation_id=?").run(record.state, JSON.stringify(record), record.operationId);
  }
  compatibilityOperation(kind: string, taskId: string, parameters: unknown): OperationRecord | null {
    return this.get(`compat:${kind}:${taskId}:${operationDigest(parameters)}`);
  }
  assertTaskVersion(record: OperationRecord): void {
    this.store.atomic(() => {
      const task = this.store.get(record.taskId);
      if ((task?.attemptId ?? null) !== record.expectedAttemptId) throw new AdmissionError("STALE_ATTEMPT", "The original operation's attempt changed during observation.");
      if ((task?.revision ?? null) !== record.expectedRevision) throw new AdmissionError("STALE_REVISION", "The original operation's revision changed during observation.");
    });
  }
  /** Only a receipt explicitly saved before any native boundary proves a clean dispatch refusal. */
  provenNotDispatched(taskId: string, attemptId: string): boolean {
    return this.db.prepare("SELECT operation_id FROM task_operations WHERE task_id=? AND kind IN ('send','rework') AND state='succeeded'").all(taskId).some(row => {
      const operation = this.get(String(row.operation_id))!;
      const result = operation.result as { ok?: boolean; task?: { attemptId?: string } } | undefined;
      return !operation.effectStartedAt && operation.attemptId === operation.expectedAttemptId && result?.ok === false && result.task?.attemptId === attemptId;
    });
  }
  /** Persist the exact route chosen by the admitted coordinator, before calling its native adapter. */
  reservePreparation(operationId: string, target: PreparationBinding): void {
    this.store.atomic(() => {
      const operation = this.get(operationId);
      if (!operation || operation.kind !== "send" || operation.executor !== "workbuddy" || operation.taskId !== target.taskId || !["reserved", "effect_started"].includes(operation.state)) throw new AdmissionError("OPERATION_REQUIRED", "The original send operation must authorize preparation.");
      const requested = operation.binding as { model?: string | null; sessionId?: string | null; contract?: { execution?: { modelId?: string }; model?: string } };
      const model = requested.contract?.execution?.modelId ?? requested.contract?.model ?? requested.model;
      if (!model || target.model !== model || target.sessionId !== (requested.sessionId ?? null)) throw new AdmissionError("MODEL_BINDING_CHANGED", "Preparation differs from the original model or session selection.");
      const bound = { ...target, workspace: fs.realpathSync.native(target.workspace) };
      const task = this.store.get(target.taskId);
      if (task?.workspace && fs.realpathSync.native(task.workspace) !== bound.workspace) throw new AdmissionError("WORKSPACE_CONFLICT", "Preparation differs from the admitted task directory.");
      if (operation.preparationBinding && operationDigest(operation.preparationBinding) !== operationDigest(bound)) throw new AdmissionError("MODEL_BINDING_CHANGED", "The original preparation route cannot change.");
      this.save({ ...operation, preparationBinding: bound, updatedAt: new Date().toISOString() });
    });
  }
  preparationBoundary(operationId: string | undefined, target: PreparationBinding, resolvedSessionId?: string, enter = false): void {
    this.store.atomic(() => {
      const operation = operationId ? this.get(operationId) : null;
      if (!operation?.preparationBinding || operation.kind !== "send" || operation.executor !== "workbuddy" || operation.taskId !== target.taskId) throw new AdmissionError("OPERATION_REQUIRED", "Preparation requires the coordinator's original persisted operation and route.");
      if (operationDigest(operation.preparationBinding) !== operationDigest({ ...target, workspace: fs.realpathSync.native(target.workspace) })) throw new AdmissionError("MODEL_BINDING_CHANGED", "The preparation target differs from its authorized route.");
      if (enter && operation.preparationEnteredAt) throw new OperationOutcomeError(operation.operationId, operation.state);
      if (!enter && !operation.preparationEnteredAt) throw new AdmissionError("OPERATION_REQUIRED", "The original native preparation has not entered its adapter.");
      if (resolvedSessionId && ((target.sessionId && target.sessionId !== resolvedSessionId) || (operation.preparationSessionId && operation.preparationSessionId !== resolvedSessionId))) throw new AdmissionError("MODEL_BINDING_CHANGED", "Preparation cannot switch its original resolved session.");
      this.nativeBoundary(target.taskId);
      this.save({ ...this.get(operation.operationId)!, ...(enter ? { preparationEnteredAt: new Date().toISOString() } : {}), ...(resolvedSessionId ? { preparationSessionId: resolvedSessionId } : {}), updatedAt: new Date().toISOString() });
    });
  }
  /** Closing requires all existing durable facts, never idle/TTL or a business label alone. */
  isClosed(task: StoredTask): boolean {
    if (!task.attemptId || !["accepted", "cancelled", "failed"].includes(task.state)) return false;
    try {
      const evidence = JSON.parse(task.runEvidenceDigest ?? "");
      return evidence.stopped === true && evidence.attemptId === task.attemptId && !!this.db.prepare("SELECT 1 FROM task_events WHERE task_id=? AND attempt_id=? AND type='task_closed'").get(task.taskId, task.attemptId);
    } catch { return false; }
  }
  occupant(): { taskId: string; executor: string; operationId: string } | null {
    const row = this.db.prepare("SELECT * FROM workflow_capacity WHERE slot=1").get();
    return row ? { taskId: String(row.task_id), executor: String(row.executor), operationId: String(row.operation_id) } : null;
  }
  /** Called under BEGIN IMMEDIATE, also used by compatibility queue/worker gates. */
  claim(taskId: string, executor: string, operationId: string): void {
    const owner = this.occupant();
    if (owner && owner.taskId !== taskId) {
      const previous = this.store.get(owner.taskId);
      if (!previous || !this.isClosed(previous)) throw new AdmissionError("CAPACITY_OCCUPIED", "An original workflow remains open or uncertain.");
      this.db.prepare("DELETE FROM workflow_capacity WHERE slot=1").run();
    } else if (owner && owner.executor !== executor) throw new AdmissionError("EXECUTOR_UNAVAILABLE", "The workflow cannot change its original executor.");
    // Check ALL historical rows, including preparations with no attempt. Migration invents no stop facts.
    for (const row of this.db.prepare("SELECT task_id FROM tasks WHERE task_id<>?").all(taskId)) {
      if (!this.isClosed(this.store.get(String(row.task_id))!)) throw new AdmissionError("CAPACITY_OCCUPIED", "A historical workflow has no verified closure.");
    }
    this.store.dshBindings.assertNoOpen(taskId);
    this.db.prepare("INSERT OR IGNORE INTO workflow_capacity VALUES (1,?,?,?)").run(taskId, executor, operationId);
  }
  private admit(kind: string, taskId: string, executor: string, parameters: unknown, options: OperationOptions, binding: unknown, capacity: boolean): { record: OperationRecord; fresh: boolean } {
    const legacy = options.operationId === undefined;
    const operationId = options.operationId ?? `compat:${kind}:${taskId}:${operationDigest(parameters)}`;
    if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 512) throw new AdmissionError("INVALID_OPERATION", "Use a stable bounded operationId.");
    const parameterDigest = operationDigest({ kind, taskId, executor, parameters, ...(legacy ? {} : { expectedRevision: options.expectedRevision, expectedAttemptId: options.expectedAttemptId }) });
    return this.store.atomic(() => {
      const prior = this.get(operationId);
      if (prior) {
        if (prior.parameterDigest !== parameterDigest) throw new AdmissionError("OPERATION_CONFLICT", "This operationId has different original parameters.");
        return { record: prior, fresh: false };
      }
      const task = this.store.get(taskId);
      if (!legacy && capacity) {
        if (options.expectedRevision === undefined || options.expectedAttemptId === undefined) throw new AdmissionError("OPERATION_PRECONDITION_REQUIRED", "Provide expectedRevision and expectedAttemptId; new tasks use null, never a fabricated attempt.");
        if ((task?.attemptId ?? null) !== options.expectedAttemptId) throw new AdmissionError("STALE_ATTEMPT", "The expected attempt is no longer current.");
        if ((task?.revision ?? null) !== options.expectedRevision) throw new AdmissionError("STALE_REVISION", "The expected revision is no longer current.");
      }
      if (capacity) {
        const active = this.db.prepare("SELECT operation_id FROM task_operations WHERE task_id=? AND state IN ('reserved','effect_started','outcome_unknown') LIMIT 1").get(taskId);
        if (active) throw new OperationOutcomeError(String(active.operation_id), this.get(String(active.operation_id))!.state);
        this.claim(taskId, executor, operationId);
      }
      const now = new Date().toISOString();
      const record: OperationRecord = { operationId, kind, taskId, attemptId: task?.attemptId ?? null, parameterDigest,
        expectedRevision: legacy ? task?.revision ?? null : options.expectedRevision ?? null,
        expectedAttemptId: legacy ? task?.attemptId ?? null : options.expectedAttemptId ?? null,
        executor, binding, state: "reserved", createdAt: now, updatedAt: now };
      this.db.prepare("INSERT INTO task_operations VALUES (?,?,?,?,?)").run(operationId, taskId, kind, record.state, JSON.stringify(record));
      return { record, fresh: true };
    });
  }
  /** Commit before every possibly mutating native call; never roll this back with its receipt. */
  nativeBoundary(taskId: string, attemptId?: string): void {
    this.store.atomic(() => {
      const owner = this.occupant();
      if (!owner || owner.taskId !== taskId) throw new AdmissionError("OPERATION_REQUIRED", "Native execution requires the original durable admission.");
      const task = this.store.get(taskId);
      if (task && (task.cancelNote || ["accepted", "cancelled", "failed"].includes(task.state))) throw new AdmissionError("CANCELLED_TERMINAL", "The original workflow no longer permits native dispatch.");
      const rows = this.db.prepare("SELECT operation_id FROM task_operations WHERE task_id=? AND state IN ('reserved','effect_started')").all(taskId);
      if (!rows.length) throw new AdmissionError("OPERATION_REQUIRED", "No active operation authorizes this native side effect.");
      for (const row of rows) {
        const record = this.get(String(row.operation_id))!;
        this.save({ ...record, state: "effect_started", effectStartedAt: record.effectStartedAt ?? new Date().toISOString(), resolvedBinding: { sessionId: task?.sessionId ?? null, runtimeSource: task?.runtimeSource ?? null }, attemptId: attemptId ?? record.attemptId, updatedAt: new Date().toISOString() });
      }
    });
  }
  /** Existing queue receipts may wake exactly their original attempt, under its retained workflow. */
  assertExecution(taskId: string, attemptId: string, target?: { sessionId: string; model?: string; workspace?: string }): void {
    this.store.atomic(() => {
      const owner = this.occupant();
      if (!owner || owner.taskId !== taskId || owner.executor !== "workbuddy") throw new AdmissionError("OPERATION_REQUIRED", "The original workflow must already own shared capacity.");
      this.claim(taskId, "workbuddy", owner.operationId);
      const receipt = this.get(`queue:${attemptId}`);
      if (!receipt || receipt.kind !== "queue" || receipt.taskId !== taskId || receipt.attemptId !== attemptId) throw new AdmissionError("OPERATION_REQUIRED", "Historical queue execution needs explicit recovery; it is not automatically dispatched after migration.");
      if (receipt.state !== "succeeded") throw new OperationOutcomeError(receipt.operationId, receipt.state);
      const pending = this.db.prepare("SELECT operation_id FROM task_operations WHERE task_id=? AND kind IN ('send','rework') AND state IN ('reserved','effect_started','outcome_unknown') LIMIT 1").get(taskId);
      if (pending) throw new OperationOutcomeError(String(pending.operation_id), this.get(String(pending.operation_id))!.state);
      const task = this.store.get(taskId);
      if (task?.attemptId !== attemptId || task.cancelNote || ["accepted", "cancelled", "failed"].includes(task.state)) throw new AdmissionError("STALE_ATTEMPT", "Only the current live attempt may execute.");
      const binding = receipt.binding as { sessionId?: string; workspace?: string; model?: string };
      if (!binding.model?.trim()) throw new AdmissionError("MODEL_SELECTION_REQUIRED", "A queue attempt must retain an explicit user-selected model.");
      if (target && ((task.sessionId && task.sessionId !== target.sessionId) || (binding.sessionId && binding.sessionId !== target.sessionId) || binding.model !== target.model || (binding.workspace && (!target.workspace || fs.realpathSync.native(binding.workspace) !== fs.realpathSync.native(target.workspace))))) throw new AdmissionError("MODEL_BINDING_CHANGED", "Queue execution differs from its original session, directory or model.");
    });
  }
  executeQueueAttempt<T>(taskId: string, attemptId: string, target: { sessionId: string; model?: string; workspace?: string }, action: () => T): T {
    return this.store.atomic(() => { this.assertExecution(taskId, attemptId, target); return action(); });
  }
  private replay<T>(record: OperationRecord): T {
    if (record.state === "succeeded") return structuredClone(record.result) as T;
    if (record.state === "rejected") throw new AdmissionError(record.error?.code ?? "OPERATION_REJECTED", record.error?.message ?? "The original operation was rejected.");
    throw new OperationOutcomeError(record.operationId, record.state);
  }
  run<T extends object>(kind: string, taskId: string, executor: string, parameters: unknown, options: OperationOptions, binding: unknown, action: (operation: OperationRecord) => Promise<T>): Promise<T & OperationReceipt> {
    const { record, fresh } = this.admit(kind, taskId, executor, parameters, options, binding, true);
    if (!fresh) {
      const pending = this.pending.get(record.operationId);
      if (!options.operationId && !pending && ["reserved", "effect_started", "outcome_unknown"].includes(record.state)) {
        const task = this.store.get(taskId);
        if (!task) throw new OperationOutcomeError(record.operationId, record.state);
        return Promise.resolve({ ok: false, created: false, task, code: "OUTCOME_UNKNOWN", operationId: record.operationId, operationState: record.state } as unknown as T & OperationReceipt);
      }
      const replayed = pending ? pending.then(result => structuredClone(result) as T & OperationReceipt) : Promise.resolve(this.replay<T & OperationReceipt>(record));
      return replayed.then(result => options.operationId ? result : { ...result, created: false, task: this.store.get(taskId) ?? (result as { task?: unknown }).task });
    }
    const promise = (async () => {
      try {
        const raw = await action(record);
        const current = this.get(record.operationId)!;
        const uncertain = current.state === "effect_started" && (raw as { ok?: boolean; code?: string })?.ok === false && (raw as { code?: string }).code !== "DISPATCH_REJECTED";
        const result = JSON.parse(JSON.stringify({ ...raw, operationId: record.operationId, operationState: uncertain ? "outcome_unknown" : "succeeded", ...(uncertain ? { outcomeCode: "OUTCOME_UNKNOWN", ...((raw as { code?: string }).code ? {} : { code: "OUTCOME_UNKNOWN" }) } : {}) })) as T & OperationReceipt;
        this.store.atomic(() => {
          this.save({ ...current, state: uncertain ? "outcome_unknown" : "succeeded", result, updatedAt: new Date().toISOString() });
        });
        return result;
      } catch (error) {
        try { this.store.atomic(() => {
          const current = this.get(record.operationId)!;
          const uncertain = current.state === "effect_started" || current.state === "outcome_unknown";
          this.save({ ...current, state: uncertain ? "outcome_unknown" : "rejected", error: { code: error instanceof AdmissionError ? error.code : "OPERATION_FAILED", message: "The original operation failed; inspect its stored task and binding." }, updatedAt: new Date().toISOString() });
          if (!uncertain && !this.store.get(taskId) && this.occupant()?.operationId === record.operationId) this.db.prepare("DELETE FROM workflow_capacity WHERE slot=1").run();
        }); } catch {
          // Failure to save the failure is never evidence that native work did not occur.
          if (error instanceof Error) Object.assign(error, { operationId: record.operationId, operationState: "outcome_unknown", outcomeCode: "OUTCOME_UNKNOWN" });
          throw error;
        }
        const failed = this.get(record.operationId)!;
        if (failed.state === "outcome_unknown" && error instanceof Error) Object.assign(error, { operationId: record.operationId, operationState: failed.state, outcomeCode: "OUTCOME_UNKNOWN" });
        throw error;
      } finally { this.pending.delete(record.operationId); }
    })();
    this.pending.set(record.operationId, promise);
    return promise;
  }
  /** Internal queue persistence has its own stable receipt, while retaining its parent's workflow. */
  enqueue(taskId: string, attemptId: string, parameters: unknown, action: () => void): void {
    const { record, fresh } = this.store.atomic(() => {
      const admission = this.admit("queue", taskId, "workbuddy", parameters, { operationId: `queue:${attemptId}` }, parameters, false);
      if (admission.fresh) {
        this.claim(taskId, "workbuddy", admission.record.operationId);
        const task = this.store.get(taskId);
        if (task && task.attemptId !== attemptId) throw new AdmissionError("STALE_ATTEMPT", "The queue request is not the current attempt.");
      }
      return admission;
    });
    if (!fresh) { this.replay(record); return; }
    this.nativeBoundary(taskId, attemptId);
    try {
      action();
      this.store.atomic(() => this.save({ ...this.get(record.operationId)!, state: "succeeded", result: null, updatedAt: new Date().toISOString() }));
    } catch (error) {
      this.store.atomic(() => this.save({ ...this.get(record.operationId)!, state: "outcome_unknown", error: { code: "QUEUE_UNCONFIRMED", message: "Inspect the original queue attempt; it will not be resent." }, updatedAt: new Date().toISOString() }));
      throw error;
    }
  }
  metadata<T>(kind: string, taskId: string, parameters: unknown, options: Pick<OperationOptions, "operationId">, action: () => T, binding: unknown = null): T {
    return this.store.atomic(() => {
      const { record, fresh } = this.admit(kind, taskId, "metadata", parameters, options, binding, false);
      if (!fresh) return this.replay<T>(record);
      const result = action();
      this.save({ ...record, state: "succeeded", result, updatedAt: new Date().toISOString() });
      return result;
    });
  }
}
