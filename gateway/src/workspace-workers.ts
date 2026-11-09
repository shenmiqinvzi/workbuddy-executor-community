import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import { AdmissionError } from "./collaboration.js";
import { readDesktopSession, waitForDesktopSession, type DesktopSessionEvidence } from "./desktop-runtime.js";
import { runsDirectory } from "./run-journal.js";
import { PreparationJournal } from "./preparation-journal.js";
import type { PreparationProbeInput, PreparationProbeRecord } from "./preparation-protocol.js";
import { sameWorkspacePath } from "./native-process.js";
export interface WorkspaceWorker {
  sessionId: string;
  workspace: string;
  state: "creating" | "ready" | "uncertain";
  selected: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
export interface NativeWorkerCreator {
  createWorker(workspace: string, sessionId: string, title?: string): Promise<{sessionId: string; workspace: string}>;
  setModel?(sessionId: string, model: string): Promise<{sessionId:string;model:string}>;
  /** 只读观测：返回该会话当前是否在原生端可见；缺席不代表没有创建。 */
  probe?(sessionId: string, workspace: string): Promise<{sessionId: string; workspace: string} | null>;
}
type Row = Omit<WorkspaceWorker, "selected"> & { selected: number };
function decode(row: Row): WorkspaceWorker {return {...row,selected:row.selected===1,error:row.error??undefined};}

/**
 * How long a non-ready reservation keeps the workspace wedged. A creator that
 * died between reserve() and its own settle() leaves state='creating' forever
 * (F-WORKER-1); after this bound the row is reclaimable when the native app
 * never registered that session.
 */
export const CREATION_STALE_MS = 10 * 60_000;

/**
 * Pure staleness rule for a reservation, exported so the reclaim policy can be
 * checked without a ledger. A ready row is never stale; an unparseable stamp is
 * treated as ancient because no live creator wrote it.
 */
export function isStaleReservation(worker: { state: string; updatedAt: string }, now = Date.now()): boolean {
  if (worker.state === "ready") return false;
  const stamp = Date.parse(worker.updatedAt);
  const age = Number.isFinite(stamp) ? now - stamp : Number.POSITIVE_INFINITY;
  return age >= CREATION_STALE_MS;
}

export function readWorkspaceWorkers(config: Config, fallback?: {workspace:string;sessionId:string}): WorkspaceWorker[] {
  const file=path.join(runsDirectory(config),"workspace-workers.sqlite");
  let workers: WorkspaceWorker[]=[];
  if(fs.existsSync(file)) {
    const db=new DatabaseSync(file,{readOnly:true});
    try {workers=(db.prepare("SELECT * FROM workers ORDER BY workspace, createdAt, sessionId").all() as unknown as Row[]).map(decode);} finally {db.close();}
  }
  if(fallback&&!workers.some(worker=>worker.sessionId===fallback.sessionId))workers.push({...fallback,workspace:path.resolve(fallback.workspace),state:'ready',selected:!workers.some(worker=>worker.workspace===path.resolve(fallback.workspace)&&worker.selected),createdAt:'',updatedAt:''});
  return workers;
}

/** This is our routing registry, never WorkBuddy's own database. */
export class WorkspaceWorkers {
  private readonly db: DatabaseSync;
  private readonly journal: PreparationJournal;
  constructor(readonly config: Config) {
    const root = runsDirectory(config);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "workspace-workers.sqlite");
    this.db = new DatabaseSync(file);
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workers(sessionId TEXT PRIMARY KEY, workspace TEXT NOT NULL, state TEXT NOT NULL,
        selected INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS selected_workspace ON workers(workspace) WHERE selected=1;`);
    this.db.exec("CREATE TABLE IF NOT EXISTS worker_keys(workspace TEXT NOT NULL, workerKey TEXT NOT NULL, sessionId TEXT NOT NULL UNIQUE, PRIMARY KEY(workspace, workerKey))");
    this.journal = new PreparationJournal(this.db);
  }
  /**
   * 失败路径上的只读观测。它只记录“现在能看到什么”，不推导终态：
   * 查不到 ≠ 未创建，异常 ≠ 未到达。任何异常都不得顶替原来的失败原因。
   */
  private async observePreparation(worker: {sessionId: string; workspace: string}, native: NativeWorkerCreator): Promise<void> {
    const expected = { sessionId: worker.sessionId, workspace: worker.workspace };
    let input: PreparationProbeInput;
    if (native.probe) {
      try {
        input = { source: "native_session_get", expected, observed: await native.probe(worker.sessionId, worker.workspace) };
      } catch (error) {
        input = { source: "native_session_get", expected, observed: null, error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      try {
        const evidence = readDesktopSession(this.config.workbuddyConfigDir, worker.sessionId);
        input = { source: "desktop_history", expected, observed: evidence.registered && evidence.cwd ? { sessionId: worker.sessionId, workspace: evidence.cwd } : null };
      } catch (error) {
        input = { source: "desktop_history", expected, observed: null, error: error instanceof Error ? error.message : String(error) };
      }
    }
    this.journal.record({ ...input, sessionId: worker.sessionId, workspace: worker.workspace });
  }
  private async safeProbe(worker: {sessionId: string; workspace: string}, native: NativeWorkerCreator): Promise<void> {
    try { await this.observePreparation(worker, native); } catch { /* 观测不可用不能顶替原来的失败原因；日志缺行本身就是“未观测” */ }
  }
  /** 只读：某次预留身份上记录过的全部观测，按时间升序，永不改写。 */
  preparationProbes(sessionId: string): PreparationProbeRecord[] {
    return this.journal.forSession(sessionId);
  }
  private decode(row: Row | undefined): WorkspaceWorker | undefined {
    return row ? decode(row) : undefined;
  }
  selected(workspace: string): WorkspaceWorker | undefined {
    return this.decode(this.db.prepare("SELECT * FROM workers WHERE workspace=? AND selected=1").get(path.resolve(workspace)) as Row | undefined);
  }
  list(): WorkspaceWorker[] {
    return (this.db.prepare("SELECT * FROM workers ORDER BY workspace, createdAt, sessionId").all() as unknown as Row[]).map(row => this.decode(row)!);
  }
  seed(worker: {sessionId: string; workspace: string}): void {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO workers VALUES (?, ?, 'ready', ?, ?, ?, NULL)").run(worker.sessionId, path.resolve(worker.workspace), this.selected(worker.workspace) ? 0 : 1, now, now);
  }
  select(workspace: string, sessionId: string): WorkspaceWorker {
    const existing = this.db.prepare("SELECT workspace FROM workers WHERE sessionId=?").get(sessionId);
    // A native session may only ever project one workspace. The refusal keeps a
    // stable code so a blocked task can show what to fix instead of a bare
    // "contract preparation failed" (live acceptance R6, 2026-11-06).
    if(existing && !sameWorkspacePath(String(existing.workspace), workspace))throw new AdmissionError("WORKSPACE_CONFLICT","This native session is already registered for another workspace");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE workers SET selected=0 WHERE workspace=?").run(workspace);
      this.db.prepare(`INSERT INTO workers VALUES (?, ?, 'ready', 1, ?, ?, NULL)
        ON CONFLICT(sessionId) DO UPDATE SET state='ready', selected=1, updatedAt=excluded.updatedAt, error=NULL`).run(sessionId, workspace, now, now);
      this.db.exec("COMMIT");
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
    return this.selected(workspace)!;
  }
  private keyed(workspace: string, workerKey: string): WorkspaceWorker | undefined {
    return this.decode(this.db.prepare("SELECT w.* FROM workers w JOIN worker_keys k ON k.sessionId=w.sessionId WHERE k.workspace=? AND k.workerKey=?").get(workspace, workerKey) as Row | undefined);
  }
  private reserve(workspace: string, workerKey?: string): WorkspaceWorker {
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (workerKey) {
        // Re-read the key inside the write transaction (F-WORKER-2). A mapping
        // whose worker row no longer exists is an orphan left by an older
        // reclaim; it is replaced here, atomically with the new reservation.
        const mapped = this.db.prepare("SELECT k.sessionId AS sessionId, w.sessionId AS live FROM worker_keys k LEFT JOIN workers w ON w.sessionId=k.sessionId WHERE k.workspace=? AND k.workerKey=?")
          .get(workspace, workerKey) as {sessionId: string; live: string | null} | undefined;
        if (mapped && mapped.live) throw new Error("Worker key already reserved");
        if (mapped) this.db.prepare("DELETE FROM worker_keys WHERE workspace=? AND workerKey=? AND sessionId=?").run(workspace, workerKey, mapped.sessionId);
        this.db.prepare("UPDATE workers SET selected=0 WHERE workspace=?").run(workspace);
      }
      this.db.prepare("INSERT INTO workers VALUES (?, ?, 'creating', 1, ?, ?, NULL)").run(sessionId, workspace, now, now);
      if (workerKey) this.db.prepare("INSERT INTO worker_keys VALUES (?, ?, ?)").run(workspace, workerKey, sessionId);
      this.db.exec("COMMIT");
    } catch {
      this.db.exec("ROLLBACK");
      throw new Error("This workspace or worker key is already being prepared; retry ensure_workspace with the same key without creating another session");
    }
    return this.selected(workspace)!;
  }
  /**
   * Read the native registry for one reserved identity and reject a workspace
   * mismatch. Returns the raw evidence so callers can tell "absent" (a readable
   * registry said no) from "unverifiable" (the registry could not answer).
   */
  private evidenceOf(worker: {workspace: string; sessionId: string}): DesktopSessionEvidence {
    const evidence = readDesktopSession(this.config.workbuddyConfigDir, worker.sessionId);
    // A registered row without a usable project directory is not a verifiable
    // identity: the native registry can hold a row whose cwd is null or stale,
    // and binding that row would attach the task to an unknown directory.
    if(evidence.registered) {
      if(!evidence.cwd) throw new Error("The chosen WorkBuddy session has no recorded project directory, so it cannot be bound; no native session was created or replaced");
      if(!sameWorkspacePath(evidence.cwd, worker.workspace)) throw new Error("Native session workspace differs from the requested project");
    }
    return evidence;
  }
  async ensure(input: {workspace: string; sessionId?: string; title?: string; model?:string; workerKey?: string}, native: NativeWorkerCreator): Promise<{created: boolean; worker: WorkspaceWorker; model?:string}> {
    if(!path.isAbsolute(input.workspace)||!fs.statSync(input.workspace).isDirectory())throw new Error("workspace must be an existing absolute directory");
    const workspace = path.resolve(input.workspace);
    if (input.workerKey !== undefined && (!input.workerKey.trim() || input.workerKey.length > 200 || input.sessionId)) throw new Error("workerKey must be nonempty, at most 200 characters and cannot be combined with sessionId");
    const selectionBefore=this.selected(workspace)?.sessionId;
    const checkSelection=()=>{
      if(this.selected(workspace)?.sessionId!==selectionBefore)throw new Error('Workspace selection changed during model configuration; the newer binding was retained');
    };
    const configure=async(sessionId:string)=>{
      if(!input.model)return;
      if(!native.setModel)throw new Error("Native model selection is unavailable; update the complete gateway");
      const actual=await native.setModel(sessionId,input.model);
      if(actual.sessionId!==sessionId||actual.model!==input.model)throw new Error("Native model selection returned a different identity or model");
    };
    if(input.sessionId) {
      const evidence = this.evidenceOf({workspace,sessionId:input.sessionId});
      if(!evidence.registered) throw new Error(evidence.state === "unverifiable"
        ? "The WorkBuddy desktop history could not be read, so that session cannot be confirmed; no native session was created or replaced"
        : "The chosen WorkBuddy session is not registered; supply a real existing session or omit sessionId for native creation");
      await configure(input.sessionId);
      checkSelection();
      return {created:false,worker:this.select(workspace,input.sessionId),model:input.model};
    }
    const previous = input.workerKey ? this.keyed(workspace, input.workerKey) : this.selected(workspace);
    if(previous) {
      const evidence = this.evidenceOf(previous);
      if(evidence.registered){await configure(previous.sessionId);checkSelection();return {created:false,worker:this.select(workspace,previous.sessionId),model:input.model};}
      // An unreadable registry is not a negative finding. Creating here would
      // produce a second native session next to one that may still exist.
      if(evidence.state === "unverifiable") throw new Error(`The WorkBuddy desktop history could not be read (${evidence.reason ?? "unknown reason"}); the reserved identity ${previous.sessionId} was kept and no second native session was created. Repair the desktop directory or point WORKBUDDY_CONFIG_DIR at the real one, then retry with the same worker key`);
      if(previous.state!=='ready')await this.safeProbe(previous,native);
      const reclaim = this.reclaimStale(previous, workspace);
      if(reclaim === "reclaimed") return this.create(workspace, input, native, configure, checkSelection);
      if(reclaim === "changed") {
        // Another writer advanced this reservation between our read and the
        // write transaction; decide again from what is on disk now.
        const current = input.workerKey ? this.keyed(workspace, input.workerKey) : this.selected(workspace);
        if(!current) return this.create(workspace, input, native, configure, checkSelection);
        const currentEvidence = this.evidenceOf(current);
        if(currentEvidence.registered){await configure(current.sessionId);checkSelection();return {created:false,worker:this.select(workspace,current.sessionId),model:input.model};}
        if(currentEvidence.state === "unverifiable") throw new Error(`The WorkBuddy desktop history could not be read (${currentEvidence.reason ?? "unknown reason"}); the reserved identity ${current.sessionId} was kept and no second native session was created`);
      }
      throw new Error(previous.state==='ready' ? "The registered WorkBuddy session was deleted or is unavailable; select another real session explicitly" : "Native creation is in progress or uncertain; inspect the reserved session before retrying. No second session was created");
    }
    return this.create(workspace, input, native, configure, checkSelection);
  }
  /**
   * Reclaim a reservation whose creator died before it could settle (F-WORKER-1).
   * Only a stale row whose native session the readable registry reports as absent
   * is reclaimed; a registered row is a real conflict, an unreadable registry is
   * no evidence at all, and a row that changed since we read it belongs to
   * another writer. The worker row is kept (with an error note); its key mapping
   * is released in the same transaction so the same worker key can be retried
   * (F-WORKER-2).
   */
  private reclaimStale(worker: WorkspaceWorker, workspace: string): "reclaimed" | "not-stale" | "changed" | "registered" | "unverifiable" {
    if (!isStaleReservation(worker)) return "not-stale";
    const evidence = readDesktopSession(this.config.workbuddyConfigDir, worker.sessionId);
    if (evidence.state === "registered") return "registered";
    if (evidence.state === "unverifiable") return "unverifiable";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state, updatedAt FROM workers WHERE sessionId=?").get(worker.sessionId) as {state: string; updatedAt: string} | undefined;
      if (!row || row.state === "ready" || row.updatedAt !== worker.updatedAt) { this.db.exec("ROLLBACK"); return "changed"; }
      this.db.prepare("UPDATE workers SET selected=0,error=?,updatedAt=? WHERE sessionId=? AND state<>'ready'")
        .run("Reservation reclaimed: its creator never registered this native session", new Date().toISOString(), worker.sessionId);
      this.db.prepare("DELETE FROM worker_keys WHERE sessionId=?").run(worker.sessionId);
      this.db.exec("COMMIT");
      return "reclaimed";
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private async create(workspace: string, input: {workspace: string; title?: string; model?:string; workerKey?: string},
    native: NativeWorkerCreator, configure: (sessionId: string) => Promise<void>, checkSelection: () => void): Promise<{created: boolean; worker: WorkspaceWorker; model?:string}> {
    const worker = this.reserve(workspace, input.workerKey);
    try {
      const result = await native.createWorker(workspace,worker.sessionId,input.title??`执行：${path.basename(workspace)}`);
      if(result.sessionId!==worker.sessionId || !sameWorkspacePath(result.workspace,workspace))throw new Error("Native creation returned another session or workspace; inspect the reserved identity, do not replay");
      const evidence = await waitForDesktopSession(this.config.workbuddyConfigDir,worker.sessionId);
      if(!evidence.registered) throw new Error(evidence.state === "unverifiable"
        ? "Native creation returned but the desktop history could not be verified; the reserved identity was kept, do not replay"
        : "Native creation returned but desktop history is not registered; inspect the reserved identity, do not replay");
      // The final readback is itself evidence: a read that flipped to absent or
      // unverifiable must stop the bind instead of being ignored.
      const confirmed=this.evidenceOf(worker);
      if(confirmed.state === "unverifiable") throw new Error("Native creation returned but the desktop history could not be re-read; the reserved identity was kept, do not replay");
      if(!confirmed.registered) throw new Error("Native creation returned but desktop history is no longer registered; inspect the reserved identity, do not replay");
      this.db.prepare("UPDATE workers SET state='ready',updatedAt=?,error=NULL WHERE sessionId=?").run(new Date().toISOString(),worker.sessionId);
      const selected=this.selected(workspace);
      if(selected?.sessionId!==worker.sessionId)throw new Error("Workspace selection changed while creating this session; its native record was retained without overriding the newer selection");
      await configure(worker.sessionId);
      if(this.selected(workspace)?.sessionId!==worker.sessionId)throw new Error('Workspace selection changed during model configuration; the newer binding was retained');
      return {created:true,worker:selected,model:input.model};
    } catch(error) {
      this.db.prepare("UPDATE workers SET state='uncertain',error=?,updatedAt=? WHERE sessionId=? AND state='creating'").run(error instanceof Error?error.message:String(error),new Date().toISOString(),worker.sessionId);
      await this.safeProbe(worker,native);
      throw error;
    }
  }
  close(): void { this.db.close(); }
}
