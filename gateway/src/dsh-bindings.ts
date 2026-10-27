import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { ExecutionSelection } from "./task-contract.js";
import { AdmissionError } from "./collaboration.js";

export interface DshBinding {
  taskId: string; attemptId: string; hostId: string; sessionId: string; requestId: string;
  execution: ExecutionSelection; cursor: number; runOpen: boolean; cancelRequested: boolean;
  dispatch: "preparing" | "reserved" | "accepted" | "uncertain" | "rejected";
  terminalSeq?: number; turnId?: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export class DshBindingStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS dsh_attempt_bindings (attempt_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,run_open INTEGER NOT NULL,body_json TEXT NOT NULL,digest TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS dsh_one_open_binding ON dsh_attempt_bindings(run_open) WHERE run_open=1;`);
  }
  get(attemptId: string): DshBinding | null {
    const row = this.db.prepare("SELECT * FROM dsh_attempt_bindings WHERE attempt_id=?").get(attemptId);
    if (!row) return null;
    try {
      const value = JSON.parse(String(row.body_json)) as DshBinding;
      if (digest(String(row.body_json)) !== row.digest || value.attemptId !== attemptId || value.taskId !== row.task_id || Number(value.runOpen) !== row.run_open || !Number.isSafeInteger(value.cursor) || value.cursor < -1) throw Error();
      return value;
    } catch { throw new AdmissionError("CONTRACT_INTEGRITY", "The DSH binding failed integrity verification."); }
  }
  forTask(taskId: string): DshBinding | null {
    const row = this.db.prepare("SELECT attempt_id FROM dsh_attempt_bindings WHERE task_id=? ORDER BY rowid DESC LIMIT 1").get(taskId);
    return row ? this.get(String(row.attempt_id)) : null;
  }
  assertNoOpen(exceptTaskId: string): void {
    if (this.db.prepare("SELECT 1 FROM dsh_attempt_bindings WHERE run_open=1 AND task_id<>?").get(exceptTaskId)) throw new AdmissionError("CAPACITY_OCCUPIED", "An original DSH dispatch or execution remains unresolved.");
  }
  /** Called under TaskStore.atomic, before native model preparation. */
  reserve(binding: DshBinding): void {
    this.assertNoOpen(binding.taskId);
    if (this.forTask(binding.taskId)?.runOpen) throw new AdmissionError("CAPACITY_OCCUPIED", "This DSH task still owns its original execution.");
    for (const row of this.db.prepare("SELECT task_id,attempt_id,run_evidence_digest FROM tasks WHERE task_id<>? AND attempt_id IS NOT NULL").all(binding.taskId)) {
      let stopped = false;
      try { const evidence = JSON.parse(String(row.run_evidence_digest)); stopped = evidence.stopped === true && evidence.attemptId === row.attempt_id; } catch { /* no stop evidence */ }
      if (!stopped) throw new AdmissionError("CAPACITY_OCCUPIED", "Another task lacks persisted stop evidence.");
    }
    const body = JSON.stringify(binding);
    this.db.prepare("INSERT INTO dsh_attempt_bindings VALUES (?,?,?,?,?)").run(binding.attemptId, binding.taskId, 1, body, digest(body));
  }
  update(binding: DshBinding): void {
    const previous = this.get(binding.attemptId);
    if (!previous || previous.taskId !== binding.taskId || previous.hostId !== binding.hostId || previous.sessionId !== binding.sessionId || previous.requestId !== binding.requestId || JSON.stringify(previous.execution) !== JSON.stringify(binding.execution) || binding.cursor < previous.cursor || (!previous.runOpen && binding.runOpen)) throw new AdmissionError("CONTRACT_INTEGRITY", "A DSH binding cannot change its original identity or regress.");
    const body = JSON.stringify(binding);
    this.db.prepare("UPDATE dsh_attempt_bindings SET run_open=?,body_json=?,digest=? WHERE attempt_id=?").run(Number(binding.runOpen), body, digest(body), binding.attemptId);
  }
}
