import fs from "node:fs";
import { enforceModelPolicy, verifySelectedModel } from "./collaboration.js";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import { TaskStore, type StoredTask } from "./task-store.js";
import { DesktopQueue } from "./desktop-queue.js";
import { readDesktopSession } from "./desktop-runtime.js";
import { RunJournal, runsDirectory, writePrivateJson, hasNativeStopEvidence } from "./run-journal.js";
import { WorkspaceWorkers } from "./workspace-workers.js";
import { readNativeTurnFailure } from "./native-turn-failure.js";
import {reconcileOwnedCommands} from "./command-cleanup.js";
import { latestNativeWake } from "./native-ownership.js";

/** This adapter may wake the native chat; it must never execute the queue task. */
export interface NativeObservation {
  state: "idle" | "busy" | "waiting_input" | "offline";
  workspace?: string;
  reason?: string;
  activityAt?: number;
  latestWakeId?: string | null;
  failure?: { wakeId: string; error: string; observedAt: string; phase?: "session:sendMessage" | "native_history" };
}
export interface NativeDesktopTrigger {
  listModels?(sessionId?: string): Promise<{ models: Array<{ id: string; credits?: unknown }>; currentModel?: string; sessionId?: string }>;
  inspect(sessionId: string, options?: { readOnly?: boolean }): Promise<NativeObservation>;
  setModel?(sessionId: string, model: string): Promise<{ sessionId: string; model: string }>;
  wakeIdle(sessionId: string, wakeId: string, prompt: string, model?:string): Promise<{ accepted: boolean; receipt?: string; error?:string }>;
  findWake?(sessionId: string, wakeId: string): Promise<boolean>;
  cancelAttempt?(sessionId: string, wakeId: string, workspace: string): Promise<void>;
}

export interface ServiceRegistration {
  version: 1;
  sessionId: string;
  workspace: string;
  projectDir: string;
  nodeBin: string;
  cdpPort: number;
  dbFile: string;
  runsDir: string;
  workbuddyConfigDir: string;
  cliElectronPath: string;
  intervalMs?: number;
  installedAt?: string;
  launchdLabel?: string;
  plistPath?: string;
  launchctlEnvPrevious?: { present: boolean; value?: string };
}

export interface WakeIntent {
  version: 1;
  sessionId: string;
  attemptId: string;
  wakeId: string;
  state: "submitting" | "submitted" | "uncertain" | "rejected";
  receipt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  submissions?: number;
}

export interface PumpResult {
  status: "no_task" | "session_busy" | "listener_ready" | "active_lease" | "unavailable" | "binding_mismatch" | "deadline_passed" | "wake_submitted" | "wake_pending" | "wake_uncertain" | "wake_rejected" | "native_blocked" | "waiting_input" | "stop_confirmed" | "stop_unconfirmed";
  sessionId: string;
  attemptId?: string;
  wakeId?: string;
  reason?: string;
}

export function serviceRegistrationPath(projectDir: string): string {
  return path.join(projectDir, "data", "persistent-service.json");
}

export function readServiceRegistration(file: string): ServiceRegistration | undefined {
  let value: ServiceRegistration;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) as ServiceRegistration; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  validateServiceRegistration(value);
  return value;
}

export function validateServiceRegistration(value: ServiceRegistration): void {
  if (value.version !== 1 || typeof value.sessionId !== "string" || !value.sessionId.trim()) throw new Error("Invalid persistent worker registration");
  for (const field of ["workspace", "projectDir", "nodeBin", "dbFile", "runsDir", "workbuddyConfigDir", "cliElectronPath"] as const) {
    if (typeof value[field] !== "string" || !path.isAbsolute(value[field])) throw new Error(`Persistent worker ${field} must be an absolute path`);
  }
  if (!Number.isInteger(value.cdpPort) || value.cdpPort < 1 || value.cdpPort > 65535) throw new Error("cdpPort must be between 1 and 65535");
  if (value.intervalMs !== undefined && (!Number.isInteger(value.intervalMs) || value.intervalMs < 500 || value.intervalMs > 60_000)) throw new Error("intervalMs must be between 500 and 60000");
}

export function registeredServiceConfig(config: Config, registration: ServiceRegistration): Config {
  validateServiceRegistration(registration);
  return { ...config, backend: "desktop-queue", dbFile: registration.dbFile, runsDir: registration.runsDir, workbuddyConfigDir: registration.workbuddyConfigDir, cliElectronPath: registration.cliElectronPath };
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function bounded<T>(operation:Promise<T>,ms:number):Promise<T> {
  let timer:ReturnType<typeof setTimeout>;
  try{return await Promise.race([operation,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(Error("Native stop/observation timed out; stop_unconfirmed")),ms);})]);}
  finally{clearTimeout(timer!);}
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function sessionKey(sessionId: string): string { return crypto.createHash("sha256").update(sessionId).digest("hex"); }
function writeWakeIntent(file: string, intent: WakeIntent): void {
  writePrivateJson(file, intent);
  // Force the intent and renamed directory entry to stable storage before native
  // submission. A machine restart must not erase our evidence of possible delivery.
  // Windows rejects FlushFileBuffers on read-only handles and on directories, so
  // keep the flush best effort there instead of failing the whole wake; the
  // rename itself is still atomic and journaled by NTFS.
  let fd: number | undefined;
  try { fd = fs.openSync(file, process.platform === "win32" ? "r+" : "r"); fs.fsyncSync(fd); }
  catch { /* Best-effort durability; delivery evidence is still written. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  if (process.platform !== "win32") {
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

/** SQLite CAS avoids two recovering daemons reclaiming the same stale file lock. */
class ServicePumpLock {
  private readonly db: DatabaseSync;
  private readonly owner = crypto.randomUUID();
  private acquired = false;
  constructor(root: string, private readonly sessionId: string) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "persistent-service.sqlite");
    this.db = new DatabaseSync(file);
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS pump_locks(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL)");
  }
  acquire(): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT pid FROM pump_locks WHERE session_id=?").get(this.sessionId) as { pid: number } | undefined;
      if (current && alive(current.pid)) { this.db.exec("COMMIT"); return false; }
      this.db.prepare("DELETE FROM pump_locks WHERE session_id=?").run(this.sessionId);
      this.db.prepare("INSERT INTO pump_locks VALUES(?, ?, ?)").run(this.sessionId, this.owner, process.pid);
      this.db.exec("COMMIT");
      this.acquired = true;
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void {
    try { if (this.acquired) this.db.prepare("DELETE FROM pump_locks WHERE session_id=? AND owner=?").run(this.sessionId, this.owner); }
    finally { this.db.close(); }
  }
}

/** Explicit operator recovery, never part of the automatic pump/retry loop. */
export async function recoverExpiredAttempt(config: Config, registration: ServiceRegistration, trigger: NativeDesktopTrigger, input: { taskId: string; attemptId: string; reason: string }) {
  const bound = registeredServiceConfig(config, registration);
  const lock = new ServicePumpLock(runsDirectory(bound), registration.sessionId);
  try {
    if (!lock.acquire()) throw new Error("A service pump owns this session; retry recovery without dispatching a new task");
    if (!input.reason.trim()) throw new Error("Describe the inspected native failure before recovery");
    if (new DesktopQueue(bound).listeners().some((listener) => listener.sessionId === registration.sessionId)) throw new Error("A native helper is still waiting; recovery refused");
    const native = await trigger.inspect(registration.sessionId);
    if (native.state !== "idle" || native.workspace !== registration.workspace) throw new Error(`Native session must be verified idle in the original workspace; observed ${native.state}`);
    const result = new DesktopQueue(bound).confirmExpiredStop({ ...input, sessionId: registration.sessionId, workspace: registration.workspace, observedAt: new Date().toISOString() });
    return { ...result, taskId: input.taskId, attemptId: input.attemptId, sessionId: registration.sessionId, state: "blocked", taskCompleted: false, next: "Use continue_task with specific recovery feedback, preserving valid existing artifacts." };
  } finally { lock.close(); }
}

/** Bounded reconciliation restores an existing report for review, never a new execution or acceptance. */
export async function reconcileReportedAttempt(config: Config, registration: ServiceRegistration, trigger: NativeDesktopTrigger,
  input: {taskId:string;attemptId:string;reason:string}) {
  const bound = registeredServiceConfig(config, registration);
  const lock = new ServicePumpLock(runsDirectory(bound), registration.sessionId);
  try {
    if (!lock.acquire()) throw Error("A service pump owns this session; reconciliation did not dispatch anything");
    const journal = new RunJournal(runsDirectory(bound), input.attemptId);
    const wake = readJson<WakeIntent>(path.join(journal.dir,"wake.json"));
    if (!wake || wake.attemptId !== input.attemptId || wake.sessionId !== registration.sessionId ||
        latestNativeWake(bound.workbuddyConfigDir, registration.sessionId) !== wake.wakeId) throw Error("Latest native turn does not belong to this attempt; reconciliation refused");
    const queue = new DesktopQueue(bound);
    if (queue.listeners().some(listener=>listener.sessionId === registration.sessionId)) throw Error("A native helper is still waiting; reconciliation refused");
    const native = await bounded(trigger.inspect(registration.sessionId,{readOnly:true}),7000);
    if (native.state !== "idle" || native.workspace !== registration.workspace) throw Error(`Report reconciliation requires current native idle in the original workspace; observed ${native.state}${native.reason ? ": " + native.reason : ""}`);
    if (!native.failure) native.failure = readNativeTurnFailure(bound.workbuddyConfigDir,registration.sessionId,wake);
    if (latestNativeWake(bound.workbuddyConfigDir, registration.sessionId) !== wake.wakeId) throw Error("Native turn ownership changed during reconciliation");
    return {...queue.reconcileReportedFailure({...input,sessionId:registration.sessionId,workspace:registration.workspace},native),
      taskId:input.taskId,attemptId:input.attemptId,state:"needs_review",next:"Inspect the existing result and rerun affected checks before accept_task. No task was dispatched."};
  } finally {lock.close();}
}

/** One launchd service supervises every enrolled native session independently. */
export async function pumpWorkspaceWorkers(config: Config, registration: ServiceRegistration, trigger: NativeDesktopTrigger, store: TaskStore) {
  const bound = registeredServiceConfig(config,registration);
  const registry = new WorkspaceWorkers(bound);
  let workers;
  try { registry.seed(registration);workers=registry.list().filter(worker=>worker.state==='ready'); }
  finally { registry.close(); }
  const results: Array<PumpResult & {workspace:string}> = [];
  for(const worker of workers) {
    const service=new PersistentDesktopService(bound,{...registration,sessionId:worker.sessionId,workspace:worker.workspace},trigger,store);
    results.push({...await service.pump(),workspace:worker.workspace});
  }
  const current=results.find(result=>result.status!=='no_task')??results[0];
  return {...current,workers:results};
}

export class PersistentDesktopService {
  private readonly config: Config;
  private readonly root: string;
  constructor(config: Config, readonly registration: ServiceRegistration, private readonly trigger: NativeDesktopTrigger, private readonly store: TaskStore) {
    this.config = registeredServiceConfig(config, registration);
    this.root = runsDirectory(this.config);
  }

  async pump(): Promise<PumpResult> {
    const lock = new ServicePumpLock(this.root, this.registration.sessionId);
    try {
      if (!lock.acquire()) return this.result("session_busy", { reason: "Another service pump owns this desktop session" });
      return await this.pumpLocked();
    } catch (error) {
      return this.result("unavailable", { reason: error instanceof Error ? error.message : String(error) });
    } finally { lock.close(); }
  }

  private result(status: PumpResult["status"], extra: Omit<Partial<PumpResult>, "status" | "sessionId"> = {}): PumpResult {
    return { status, sessionId: this.registration.sessionId, ...extra };
  }

  private candidates(): Array<{ task: StoredTask; journal: RunJournal }> {
    const tasks: StoredTask[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = this.store.listTasks({ states: ["queued", "working", "blocked"], limit: 500, offset });
      tasks.push(...page);
      if (page.length < 500) break;
    }
    return tasks.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.taskId.localeCompare(b.taskId)).flatMap((task) => {
      if (!task.attemptId || (task.sessionId && task.sessionId !== this.registration.sessionId)) return [];
      const journal = new RunJournal(this.root, task.attemptId);
      const snapshot = journal.snapshot();
      if (snapshot?.driver !== "desktop-queue" || snapshot.sessionId !== this.registration.sessionId || snapshot.status !== "queued" || journal.cancellationRequested()) return [];
      // A claim followed by an incomplete state write is uncertain, not a fresh task.
      if (fs.existsSync(path.join(journal.dir, "claim.json"))) return [];
      return [{ task, journal }];
    });
  }

  private unresolvedAttempt(): { attemptId: string } | undefined {
    let active = readJson<{ attemptId: string }>(path.join(this.root, "queue-session-locks", `${sessionKey(this.registration.sessionId)}.active.json`));
    // A delivered wake can fail before claim, so it has no active lease file.
    // Retain supervision after that failure/cancellation as well.
    if (!active || hasNativeStopEvidence(new RunJournal(this.root, active.attemptId).snapshot())) {
      active = undefined;
      if (fs.existsSync(this.root)) for (const name of fs.readdirSync(this.root)) {
        if (!/^run-[a-f0-9-]{36}$/.test(name)) continue;
        const journal = new RunJournal(this.root, name), snapshot = journal.snapshot();
        if (snapshot?.driver === "desktop-queue" && snapshot.sessionId === this.registration.sessionId &&
            !hasNativeStopEvidence(snapshot) && (fs.existsSync(path.join(journal.dir, "claim.json")) ||
              ((["blocked", "cancelled"].includes(snapshot.status) || journal.cancellationRequested()) && fs.existsSync(path.join(journal.dir, "wake.json"))))) {
          active = { attemptId: name }; break;
        }
      }
    }
    return active;
  }
  private unresolvedLease(): boolean {
    return Boolean(this.unresolvedAttempt());
  }

  private async inspectAttempt(journal: RunJournal): Promise<NativeObservation> {
    const native = await bounded(this.trigger.inspect(this.registration.sessionId, { readOnly: true }),7000);
    new DesktopQueue(this.config).recordNativeHealth(journal.attemptId,native);
    if (native.state === "idle" && !native.failure && native.workspace === this.registration.workspace) {
      const wake = readJson<WakeIntent>(path.join(journal.dir, "wake.json"));
      if (wake?.sessionId === this.registration.sessionId && wake.attemptId === journal.attemptId) {
        const failure = readNativeTurnFailure(this.config.workbuddyConfigDir, this.registration.sessionId, wake);
        if (failure) return { ...native, failure };
      }
    }
    return native;
  }

  private async stopAttempt(journal: RunJournal): Promise<PumpResult> {
    const queue = new DesktopQueue(this.config), snapshot = journal.snapshot()!, request = journal.request();
    const task = this.store.get(snapshot.taskId);
    const identity = {attemptId:journal.attemptId};
    const wake = readJson<WakeIntent>(path.join(journal.dir, "wake.json"));
    let control = snapshot.stopControl ?? {state:"requested" as const,requestedAt:new Date().toISOString()};
    const remember = (error?: string) => {
      control = {...control,state:"stop_unconfirmed",checkedAt:new Date().toISOString(),error};
      queue.updateStopControl(journal.attemptId,control);
      return this.result("stop_unconfirmed", {...identity,reason:error ?? "Native stop has not been confirmed"});
    };
    if (task?.attemptId !== journal.attemptId || task.sessionId !== this.registration.sessionId || snapshot.sessionId !== task.sessionId ||
        request.taskId !== task.taskId || request.sessionId !== task.sessionId || request.workspace !== this.registration.workspace ||
        (wake && (wake.attemptId !== journal.attemptId || wake.sessionId !== task.sessionId || wake.wakeId !== `wake-${journal.attemptId}`))) return remember("Stop identity mismatch; no native cancellation was sent");
    // One durable issue marker survives MCP/service reconnects. A timed-out RPC is uncertain, never blindly replayed.
    try {
      const native = await this.inspectAttempt(journal);
      if (native.state === "offline" || native.workspace !== this.registration.workspace) return remember(native.reason ?? "Native session unavailable or binding changed");
      if ((native.state !== "idle" || snapshot.nativeFailure) && !control.issuedAt) {
        if (!wake || !this.trigger.cancelAttempt) return remember("Native stop API or exact wake evidence unavailable");
        control = {...control,issuedAt:new Date().toISOString(),state:"requested"};
        queue.updateStopControl(journal.attemptId,control);
        journal.append("status", "Native cancellation issued for this task/attempt/session only.", {taskId:task.taskId,attemptId:journal.attemptId,sessionId:task.sessionId});
        await bounded(this.trigger.cancelAttempt(task.sessionId!,wake.wakeId,this.registration.workspace),10000);
        control = {...control,acknowledgedAt:new Date().toISOString()};
        queue.updateStopControl(journal.attemptId,control);
      }
      if (snapshot.nativeFailure && !control.acknowledgedAt) return remember("Native cancellation acknowledgement is missing; the request will not be replayed");
      const end = Date.now() + 3000;
      // Never count the pre-cancellation observation as post-cancellation proof.
      let observed = control.acknowledgedAt ? await this.inspectAttempt(journal) : native;
      do {
        if (observed.state === "offline" || observed.workspace !== this.registration.workspace) return remember(observed.reason ?? "Native session unavailable or binding changed during stop confirmation");
        if (snapshot.nativeFailure && observed.latestWakeId !== wake?.wakeId) return remember("Latest native turn changed or is unknown after cancellation; stop is unconfirmed");
        if (observed.state === "idle") {
          const cleanup=reconcileOwnedCommands(path.join(journal.dir,"commands"));
          if(cleanup.recovered.length)journal.append("status","Interrupted command supervisors are absent; Windows Job handle closure proves cleanup. Exit codes remain unknown (125), never passing validations.",{recoveredCommands:cleanup.recovered,sessionId:task.sessionId});
          const stopped = queue.observeNative(journal.attemptId,observed);
          if (hasNativeStopEvidence(stopped)) {
            queue.updateStopControl(journal.attemptId,{...control,state:"stopped",checkedAt:new Date().toISOString(),error:undefined});
            return this.result(stopped.nativeFailure && stopped.status === "blocked" ? "native_blocked" : "stop_confirmed",identity);
          }
        }
        if (Date.now() >= end) break;
        await new Promise(resolve=>setTimeout(resolve,250));
        observed = await this.inspectAttempt(journal);
      } while (observed.state !== "offline" && observed.workspace === this.registration.workspace);
      return remember(observed.reason ?? "Cancellation requested; native idle not confirmed within the bounded check");
    } catch (error) { return remember(error instanceof Error ? error.message : String(error)); }
  }

  private async pumpLocked(): Promise<PumpResult> {
    // Claimed work is no longer a queue candidate. Keep supervising it, even
    // after cancellation or timeout, until native stop has actually been proven.
    const active = this.unresolvedAttempt();
    if (active) {
      const journal = new RunJournal(this.root, active.attemptId);
      const snapshot = journal.snapshot();
      if (snapshot?.driver === "desktop-queue" && snapshot.sessionId === this.registration.sessionId &&
          !hasNativeStopEvidence(snapshot)) {
        // Expire even if the native application is currently offline.
        new DesktopQueue(this.config).checkDeadline(active.attemptId);
        if (journal.cancellationRequested()) return this.stopAttempt(journal);
        const native = await this.inspectAttempt(journal);
        const identity = { attemptId: active.attemptId };
        if (native.state === "offline") return this.result("unavailable", { ...identity, reason: native.reason });
        if (native.workspace !== this.registration.workspace) return this.result("binding_mismatch", identity);
        if(native.state==="idle")reconcileOwnedCommands(path.join(journal.dir,"commands"));
        const observed = new DesktopQueue(this.config).observeNative(active.attemptId, native);
        if (observed.nativeFailure && !hasNativeStopEvidence(observed)) return this.stopAttempt(journal);
        if (observed.waitingInput) return this.result("waiting_input", { ...identity, reason: native.reason });
        if (hasNativeStopEvidence(observed)) return this.result(["cancelled", "needs_review"].includes(observed.status) ? "stop_confirmed" : "native_blocked", { ...identity, reason: observed.error });
        if (observed.status === "blocked") return this.result("native_blocked", { ...identity, reason: observed.error });
        return this.result("active_lease", identity);
      }
    }
    const candidate = this.candidates()[0];
    if (!candidate) return this.result("no_task");
    const { task, journal } = candidate;
    const identity = { attemptId: journal.attemptId };
    new DesktopQueue(this.config).checkDeadline(journal.attemptId);
    const snapshot = journal.snapshot()!;
    if (snapshot.status !== "queued") {
      return this.result("deadline_passed", identity);
    }
    if (this.unresolvedLease()) return this.result("active_lease", identity);
    const evidence = readDesktopSession(this.config.workbuddyConfigDir, this.registration.sessionId);
    if (!evidence.registered) return this.result("unavailable", { ...identity, reason: evidence.reason });
    const request = journal.request();
    const contractAdmission = this.store.collaboration.getTaskAdmission(task.taskId);
    let contractModelVerified = false;
    const modelReady=()=>{if(request.model && (!contractAdmission || contractModelVerified))writePrivateJson(path.join(journal.dir,'model-ready.json'),{model:request.model,sessionId:this.registration.sessionId,attemptId:journal.attemptId});};
    if (request.sessionId !== this.registration.sessionId || (request.workspace && path.resolve(request.workspace) !== this.registration.workspace) || (task.workspace && path.resolve(task.workspace) !== this.registration.workspace) || (evidence.cwd && path.resolve(evidence.cwd) !== this.registration.workspace)) {
      return this.result("binding_mismatch", { ...identity, reason: "The registered workspace or session no longer matches the queued task" });
    }
    const intentFile = path.join(journal.dir, "wake.json");
    const previous = readJson<WakeIntent>(intentFile);
    if (previous && (previous.sessionId !== this.registration.sessionId || previous.attemptId !== journal.attemptId)) throw new Error("Wake intent identity does not match its queue attempt");
    if (previous?.state === "rejected" && (previous.submissions ?? 1) >= 2) {
      const error = "Native wake was rejected twice. Automatic retries stopped; inspect this attempt before explicit rework.";
      journal.save({ ...snapshot, status: "blocked", stopReason: "wake_retry_limit", error, nativeStoppedAt: new Date().toISOString(), nativeStopSource: "not_dispatched" });
      journal.append("result", `TASK_STATUS: blocked\n${error}`, { status: "blocked", blockedReason: error, sessionId: this.registration.sessionId });
      return this.result("wake_rejected", { ...identity, reason: error });
    }
    if (previous && previous.state !== "rejected") {
      const native = await this.inspectAttempt(journal);
      if (native.state !== "offline" && native.workspace === this.registration.workspace) {
        const observed = new DesktopQueue(this.config).observeNative(journal.attemptId, native);
        if (observed.nativeFailure && !hasNativeStopEvidence(observed)) return this.stopAttempt(journal);
        if (observed.waitingInput) return this.result("waiting_input", { ...identity, reason: native.reason });
        if (observed.status === "blocked" || observed.stopReason) return this.result(observed.status === "cancelled" ? "stop_confirmed" : "native_blocked", { ...identity, reason: observed.error });
      }
      if (previous.state === "submitted") {modelReady();return this.result("wake_pending", { ...identity, wakeId: previous.wakeId });}
      if (this.trigger.findWake) {
        try {
          if (await this.trigger.findWake(this.registration.sessionId, previous.wakeId)) {
            writeWakeIntent(intentFile, { ...previous, state: "submitted", updatedAt: new Date().toISOString() });
            modelReady();
            return this.result("wake_pending", { ...identity, wakeId: previous.wakeId });
          }
        } catch { /* An unavailable lookup must not cause replay of an ambiguous submission. */ }
      }
      return this.result("wake_uncertain", { ...identity, wakeId: previous.wakeId, reason: previous.error ?? "Native wake submission has not been confirmed; inspect the original desktop conversation before retrying" });
    }
    if (new DesktopQueue(this.config).listeners().some((listener) => listener.sessionId === this.registration.sessionId)) return this.result("listener_ready", identity);
    const native = await this.trigger.inspect(this.registration.sessionId);
    if (native.state === "offline") return this.result("unavailable", { ...identity, reason: native.reason });
    if (native.state !== "idle") return this.result("session_busy", { ...identity, reason: native.reason ?? native.state });
    if (native.workspace && path.resolve(native.workspace) !== this.registration.workspace) return this.result("binding_mismatch", { ...identity, reason: "Native desktop workspace differs from the registered worker" });
    // Recheck after awaiting the native API. A native listener may have appeared meanwhile.
    if (journal.snapshot()?.status !== "queued" || journal.cancellationRequested() || this.unresolvedLease()) return this.result("active_lease", identity);
    if (new DesktopQueue(this.config).listeners().some((listener) => listener.sessionId === this.registration.sessionId)) return this.result("listener_ready", identity);
    const now = new Date().toISOString();
    const intent: WakeIntent = { version: 1, sessionId: this.registration.sessionId, attemptId: journal.attemptId, wakeId: previous?.wakeId ?? `wake-${journal.attemptId}`, state: "submitting", submissions: (previous?.submissions ?? (previous ? 1 : 0)) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
    // A legacy worker must obey the same retained workflow before model preparation or wake.
    this.store.operations.assertExecution(task.taskId, journal.attemptId);
    // Persist before submission. A crash after this point is resolved by receipt lookup,
    // never by replaying an uncertain native prompt.
    writeWakeIntent(intentFile, intent);
    const prompt = `[CODEX_QUEUE_WAKE ${intent.wakeId}]\n${new DesktopQueue(this.config).prepare(this.registration.sessionId, false, true).prompt}`;
    try {
      // A native helper can run before wakeIdle returns its submission receipt.
      // Verify the real model first and authorize this attempt before sending
      // the prompt; otherwise a perfectly valid immediate claim sees no task.
      if (request.model) {
        try {
          const contract = this.store.getContract(task.taskId);
          if (contract.state === "integrity_failure") throw new Error("Contract dispatch admission failed integrity verification");
          if (contractAdmission) {
            const attempt = this.store.collaboration.getAttempt(journal.attemptId);
            const workspace = this.store.collaboration.getWorkspace(contractAdmission.workspace.id);
            if (workspace.realPath !== request.workspace || workspace.device !== contractAdmission.workspace.device || workspace.inode !== contractAdmission.workspace.inode ||
                !attempt || attempt.deadlineAt !== request.deadline || attempt.deadlineAt !== snapshot.deadline || contractAdmission.execution.modelId !== request.model) throw new Error("Contract attempt, directory, deadline or model binding changed before wake");
            enforceModelPolicy(this.store.collaboration.currentPolicy(contractAdmission.policy), contractAdmission.execution);
          }
          if (!this.trigger.setModel) throw new Error("Native model preparation is unavailable; refusing an unverified wake");
          const configured = await this.trigger.setModel(this.registration.sessionId, request.model);
          if (configured.sessionId !== this.registration.sessionId || configured.model !== request.model) throw new Error("Native model preparation returned a different session or model");
          if (contractAdmission) {
            enforceModelPolicy(this.store.collaboration.currentPolicy(contractAdmission.policy), contractAdmission.execution);
            const models = await this.trigger.listModels?.(this.registration.sessionId);
            const entry = models?.models.find(model => model.id === request.model);
            verifySelectedModel(contractAdmission.execution, entry ? {
              sessionId: models?.sessionId ?? "", modelId: entry.id, selectedModel: models?.currentModel ?? "", credits: typeof entry.credits === "string" ? entry.credits : null, level: "selected", observedAt: new Date().toISOString(),
            } : undefined, this.registration.sessionId, contractAdmission.policy.requireFree || this.store.collaboration.currentPolicy(contractAdmission.policy).requireFree);
            enforceModelPolicy(this.store.collaboration.currentPolicy(contractAdmission.policy), contractAdmission.execution);
            contractModelVerified = true;
          }
          modelReady();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          writeWakeIntent(intentFile, { ...intent, state: "rejected", error: reason, updatedAt: new Date().toISOString() });
          journal.save({ ...journal.snapshot()!, status: "blocked", stopReason: "model_configuration_rejected", error: reason,
            nativeStoppedAt: new Date().toISOString(), nativeStopSource: "not_dispatched" });
          journal.append("result", `TASK_STATUS: blocked\n${reason}`, { status: "blocked", blockedReason: reason, sessionId: this.registration.sessionId });
          return this.result("wake_rejected", { ...identity, reason });
        }
        new DesktopQueue(this.config).checkDeadline(journal.attemptId);
        if (journal.cancellationRequested() || journal.snapshot()?.status !== "queued") {
          writeWakeIntent(intentFile, { ...intent, state: "rejected", updatedAt: new Date().toISOString() });
          return this.result("deadline_passed", identity);
        }
      }
      const response = await this.trigger.wakeIdle(this.registration.sessionId, intent.wakeId, prompt, request.model);
      writeWakeIntent(intentFile, { ...intent, state: response.accepted ? "submitted" : "rejected", receipt: response.receipt, updatedAt: new Date().toISOString() });
      if(response.accepted)modelReady();
      if(response.error){
        journal.save({...journal.snapshot()!,status:'blocked',stopReason:'model_configuration_rejected',error:response.error,nativeStoppedAt:new Date().toISOString(),nativeStopSource:'not_dispatched'});
        journal.append('result',`TASK_STATUS: blocked\n${response.error}`,{status:'blocked',blockedReason:response.error,sessionId:this.registration.sessionId});
      }
      return this.result(response.accepted ? "wake_submitted" : "wake_rejected", { ...identity, wakeId: intent.wakeId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      writeWakeIntent(intentFile, { ...intent, state: "uncertain", error: reason, updatedAt: new Date().toISOString() });
      return this.result("wake_uncertain", { ...identity, wakeId: intent.wakeId, reason });
    }
  }
}
