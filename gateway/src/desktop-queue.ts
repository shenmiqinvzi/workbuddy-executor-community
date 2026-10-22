import fs from "node:fs";
import { verifyValidationEvidence, type ValidationEvidence } from "./worker-result.js";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { readDesktopSession } from "./desktop-runtime.js";
import { sameExecutable, windowsProcessTable } from "./native-process.js";
import { DurableRuns, RunJournal, runsDirectory, writePrivateJson, hasNativeStopEvidence, type RunRequest, type RunSnapshot } from "./run-journal.js";
import { TaskStore } from "./task-store.js";
import type { LocalMessage } from "./workbuddy-client.js";
import type { NativeObservation, WakeIntent } from "./persistent-service.js";
import { diagnoseNativeFailure } from "./native-turn-failure.js";

const SOURCE = "desktop_queue";
const TERMINAL = new Set(["needs_review", "blocked", "failed", "cancelled"]);
interface DesktopActor { desktopPid: number }
interface Listener { sessionId: string; pid: number; desktopPid: number; waiting: boolean; updatedAt: string }
interface Claim { sessionId: string; leaseHash: string; desktopPid: number; claimedAt: string }
export interface QueueTask {
  status: "task"; taskId: string; attemptId: string; sessionId: string; leaseToken: string;
  prompt: string; workspace?: string; deadline: string;
  reporting: { resultFile: string; command: string };
}

/** Prove the helper was launched by the native desktop app, not a standalone CLI or Codex. */
export function assertDesktopCaller(config: Config): DesktopActor {
  if (process.platform === "win32") return assertDesktopCallerWindows(config);
  let pid = process.ppid;
  const executable = path.resolve(config.cliElectronPath);
  for (let step = 0; pid > 1 && step < 30; step++) {
    const parentText = execFileSync("ps", ["-p", String(pid), "-o", "ppid="], { encoding: "utf8", timeout: 2000 }).trim();
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2000 }).trim();
    // The native application root has no script argument; daemon/CLI child
    // processes using Electron must continue walking to the application root.
    if (command === executable || command.startsWith(`${executable} --`)) {
      if (!/--type=|--stdio|cli\/bin|sidecar-entry|daemon-app-server/.test(command)) return { desktopPid: pid };
    }
    const parent = Number(parentText);
    if (!Number.isInteger(parent) || parent <= 0 || parent === pid) break;
    pid = parent;
  }
  throw new Error("This worker helper must be called from the real WorkBuddy desktop conversation. Standalone CLI and Codex-side execution cannot report WorkBuddy results.");
}

/**
 * Windows equivalent of the parent-chain proof above. The helper is started by
 * the native app's own shell tool, so walking ParentProcessId must reach the
 * WorkBuddy process that owns this configuration.
 */
function assertDesktopCallerWindows(config: Config): DesktopActor {
  let table;
  try { table = windowsProcessTable(); }
  catch { throw new Error("Cannot verify the real WorkBuddy desktop process ancestry. Native process metadata is unavailable; reporting is refused."); }
  const byPid = new Map(table.map((row) => [row.pid, row]));
  let pid = process.ppid;
  for (let step = 0; pid > 0 && step < 30; step++) {
    const row = byPid.get(pid);
    if (!row) break;
    const command = row.commandLine ?? "";
    if (sameExecutable(row.exe, config.cliElectronPath) && !/--type=|--stdio|sidecar-entry|daemon-app-server|cli[\\/]bin/i.test(command)) return { desktopPid: pid };
    if (row.ppid === pid) break;
    pid = row.ppid;
  }
  throw new Error("This worker helper must be called from the real WorkBuddy desktop conversation. Standalone CLI and Codex-side execution cannot report WorkBuddy results.");
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function key(sessionId: string): string { return crypto.createHash("sha256").update(sessionId).digest("hex"); }
function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function locked<T>(file: string, action: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Actions are synchronous and short. Wait for another process to release its
  // lock instead of turning a harmless collision into a lost worker report.
  // Never run native RPC or await a model while holding this lock.
  const until = performance.now() + 2_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let fd: number | undefined;
  while (fd === undefined) {
    try { fd = fs.openSync(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = readJson<{pid: number}>(file);
        if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && !alive(owner.pid)) {
          fs.unlinkSync(file);
          continue;
        }
      } catch (readError) {
        // The creator may not have written its PID yet, or another process
        // released the file. A partial JSON write is not permission to steal it.
        if (!(readError instanceof SyntaxError) && (readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
      }
      const remaining = until - performance.now();
      if (remaining <= 0) throw new Error("Queue record stayed busy for 2 seconds; retry this call without resending the task");
      Atomics.wait(sleeper, 0, 0, Math.min(20, remaining));
    }
  }
  try { fs.writeSync(fd, JSON.stringify({ pid: process.pid })); return action(); }
  finally { fs.closeSync(fd); fs.rmSync(file, { force: true }); }
}

export function windowsWorkerCommand(nodeBin: string, helperFile: string, workspace: string): string {
  if (![nodeBin, helperFile, workspace].every(value => path.win32.isAbsolute(value))) {
    throw new Error("Worker command requires absolute Windows paths");
  }
  const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
  // Anchor the native shell before using the shorter relative path. A helper
  // on another volume remains absolute, as required by Windows path semantics.
  const helper = path.win32.relative(workspace, helperFile);
  return `cd ${quote(workspace)} && ${quote(nodeBin)} ${quote(helper)}`;
}

export class DesktopQueue {
  readonly root: string;
  private readonly listenersDir: string;
  constructor(private readonly config: Config, private readonly verifyActor: () => DesktopActor = () => assertDesktopCaller(config)) {
    this.root = runsDirectory(config);
    this.listenersDir = path.join(this.root, "desktop-listeners");
  }
  prepare(sessionId: string, persistent = false, wakeOnce = false) {
    const evidence = readDesktopSession(this.config.workbuddyConfigDir, sessionId);
    if (!evidence.registered) throw new Error(evidence.reason ?? "Desktop session unregistered");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    // Windows cannot execute the POSIX launcher, so hand WorkBuddy an explicit
    // Node command that works from its own shell tool on either platform.
    // Forward slashes keep the command valid in both bash and Windows shells.
    const winPath = (value: string) => value.replaceAll("\\", "/");
    const helperFile = fileURLToPath(new URL("../dist/desktop-worker-cli.js", import.meta.url));
    const helper = process.platform === "win32"
      ? evidence.cwd && path.isAbsolute(evidence.cwd)
        ? windowsWorkerCommand(process.execPath, helperFile, evidence.cwd)
        : `${quote(winPath(process.execPath))} ${quote(winPath(helperFile))}`
      : quote(fileURLToPath(new URL("../bin/workbuddy-worker", import.meta.url)));
    if (persistent) {
      if (!evidence.cwd || !path.isAbsolute(evidence.cwd)) throw new Error("Persistent setup needs the native session's absolute workspace");
      const service = process.platform === "win32"
        ? `${quote(winPath(process.execPath))} ${quote(winPath(fileURLToPath(new URL("../dist/service-cli.js", import.meta.url))))}`
        : quote(fileURLToPath(new URL("../bin/workbuddy-service", import.meta.url)));
      return { sessionId, workspace: evidence.cwd, started: false, mode: "persistent", prompt: `请一次性配置本桌面会话为 Codex 的常驻执行会话。会话 ID：${sessionId}。用户授权安装本机服务，并在需要启用原生接口时、其他任务结束后自动重启 WorkBuddy 一次。\n请用你自己的 Bash 工具执行：\n${process.platform === "win32" ? service : quote(service)} install --session-id ${quote(sessionId)} --workspace ${quote(evidence.cwd)} --cdp-port 18491\n安装完成只回报安装状态或真实错误，结束当前回复。不要启动无限 claim，不改桥接器源码，不写其他成果或记忆，不改变权限设置。服务会保存会话绑定、按真实队列自动唤起本会话，退出和重开后无需再次粘贴。安装成功不等于任务通过；后续仍需实际领取、产物和验收证明。需要登录或原生权限时如实说明。` };
    }
    // The native model sees this before it can claim and read review feedback.
    const claimCommand = `\`\`\`bash\n${helper} claim --session-id ${quote(sessionId)} --wait-seconds 0\n\`\`\``;
    const claimInstructions = `下方是网关按真实安装位置生成的完整领取命令，逐字执行。不要沿用历史命令、从工作目录推测或增删路径层级。\n${claimCommand}`;
    return { sessionId, workspace: evidence.cwd, started: false, prompt: `仅执行本次领取的任务，不沿用此前会话的构建、清理或排障计划。会话 ID：${sessionId}。\n使用自己的 Bash 工具执行（不能由 Codex 代执行）：\n${claimInstructions}\n返回 status=task 后按 prompt 执行。完成时用 Write 工具在 reporting.resultFile 写 JSON：{"status":"completed|blocked|failed","text":"实际修改、检查结果及遗留问题","artifacts":["实际绝对路径"]}，然后原样执行 reporting.command。不要自行拼接租约、长文本或路径参数。空报告和计划不能报 completed。\n回报失败只允许原命令原样重试一次；仍失败就保留文件并结束，说明错误，不排障网关、不读源码、不改权限、不换 shell、不重做任务。权限等待或服务错误时停止并说明。status=retry 表示空队列，直接结束；成功回报后也结束，不再 claim 或循环等待。` };
  }
  listeners(): Array<{sessionId: string; workspace?: string; ready: boolean; source: string}> {
    if (!fs.existsSync(this.listenersDir)) return [];
    return fs.readdirSync(this.listenersDir).filter((name) => name.endsWith(".json")).flatMap((name) => {
      const value = readJson<Listener>(path.join(this.listenersDir, name));
      if (!value || !value.waiting || !alive(value.pid) || !alive(value.desktopPid) || Date.now() - Date.parse(value.updatedAt) > 70_000) return [];
      const evidence = readDesktopSession(this.config.workbuddyConfigDir, value.sessionId);
      return evidence.registered ? [{ sessionId: value.sessionId, workspace: evidence.cwd, ready: true, source: SOURCE }] : [];
    });
  }
  start(request: RunRequest): void {
    return locked(path.join(this.root, "dispatch.lock"), () => this.startLocked(request));
  }
  private startLocked(request: RunRequest): void {
    // A new task/session cannot bypass any unresolved native execution.
    if (fs.existsSync(this.root)) for (const name of fs.readdirSync(this.root)) {
      if (!/^run-[a-f0-9-]{36}$/.test(name) || name === request.attemptId) continue;
      const old = new RunJournal(this.root, name), state = old.snapshot();
      if (state?.driver === "desktop-queue" && !hasNativeStopEvidence(state) &&
          (["queued", "working"].includes(state.status) || ["claim.json", "wake.json"].some(f => fs.existsSync(path.join(old.dir, f))))) {
        throw new Error("Another desktop attempt is unresolved; stop_unconfirmed forbids dispatch to any session");
      }
    }
    if (request.sessionMode === "new") throw new Error("The queue route needs a dedicated native desktop worker conversation; it does not create one through a private API");
    const listeners = this.listeners();
    const sessionId = request.sessionId ?? (listeners.length === 1 ? listeners[0]!.sessionId : undefined);
    if (!sessionId) throw new Error("Specify a WorkBuddy worker sessionId, or start exactly one desktop queue listener first");
    const evidence = readDesktopSession(this.config.workbuddyConfigDir, sessionId);
    if (!evidence.registered) throw new Error(evidence.reason ?? "WorkBuddy desktop session is unregistered");
    if (request.workspace && evidence.cwd && path.resolve(request.workspace) !== path.resolve(evidence.cwd)) throw new Error("The task workspace differs from the dedicated desktop worker session");
    const journal = new RunJournal(this.root, request.attemptId);
    fs.mkdirSync(journal.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(journal.dir, "request.json"), JSON.stringify({ ...request, sessionId }), { flag: "wx", mode: 0o600 });
    const now = Date.now();
    journal.save({ attemptId: request.attemptId, taskId: request.taskId, sessionId, driver: "desktop-queue", status: "queued",
      deadline: new Date(now + request.timeoutSeconds * 1000).toISOString(),
      claimDeadline: new Date(now + Math.min(request.timeoutSeconds, this.config.claimTimeoutSeconds ?? 180) * 1000).toISOString(),
      reportBy: new Date(now + request.timeoutSeconds * 1000 - Math.min(120000, Math.max(5000, request.timeoutSeconds * 100))).toISOString(),
      updatedAt: new Date(now).toISOString() });
    journal.append("status", "Task queued for the specified native WorkBuddy desktop worker; waiting for its claim.", { status: "queued", sessionId });
  }
  async claim(sessionId: string, waitSeconds = 50): Promise<QueueTask | {status: "retry"; message: string}> {
    const actor = this.verifyActor();
    const evidence = readDesktopSession(this.config.workbuddyConfigDir, sessionId);
    if (!evidence.registered) throw new Error(evidence.reason ?? "Desktop session unregistered");
    const listenerFile = path.join(this.listenersDir, `${key(sessionId)}.json`);
    const writeListener = (waiting: boolean) => writePrivateJson(listenerFile, { sessionId, pid: process.pid, desktopPid: actor.desktopPid, waiting, updatedAt: new Date().toISOString() } satisfies Listener);
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0), 55) * 1000;
    writeListener(true);
    const store = new TaskStore(this.config.dbFile);
    try {
      do {
        writeListener(true);
        for (const task of store.listTasks({ states: ["queued", "working", "blocked"], limit: 100 })) {
          if (!task.attemptId || (task.sessionId && task.sessionId !== sessionId)) continue;
          const journal = new RunJournal(this.root, task.attemptId);
          const snapshot = journal.snapshot();
          if (!snapshot || snapshot.driver !== "desktop-queue" || snapshot.status !== "queued" || snapshot.sessionId !== sessionId || journal.cancellationRequested()) continue;
          const request = journal.request();
          // An old listener must not take a task requiring a different native model.
          // The wake service authorizes this attempt after native configuration, before wake.
          if(request.model){
            const ready=readJson<{model:string;sessionId:string;attemptId:string}>(path.join(journal.dir,'model-ready.json'));
            if(ready?.model!==request.model||ready.sessionId!==sessionId||ready.attemptId!==task.attemptId)continue;
          }
          const claimed = locked(path.join(this.root, "queue-session-locks", `${key(sessionId)}.lock`), () => {
            const bindingFile = path.join(this.root, "queue-session-locks", `${key(sessionId)}.active.json`);
            const active = readJson<{attemptId: string}>(bindingFile);
            if (active) {
              const previous = new RunJournal(this.root, active.attemptId).snapshot();
              if (previous && !hasNativeStopEvidence(previous)) throw new Error("The desktop conversation already has an unfinished queue task; report and verify native stop before claiming another");
            }
            return locked(path.join(journal.dir, "queue-write.lock"), () => {
              const current = journal.snapshot()!;
              if (current.status !== "queued" || journal.cancellationRequested()) return undefined;
              if (this.isDue(current)) { this.expire(journal, current); return undefined; }
              const leaseToken = crypto.randomBytes(24).toString("hex");
              writePrivateJson(path.join(journal.dir, "claim.json"), { sessionId, leaseHash: key(leaseToken), desktopPid: actor.desktopPid, claimedAt: new Date().toISOString() } satisfies Claim);
              writePrivateJson(bindingFile, { attemptId: task.attemptId });
              journal.save({ ...current, status: "working", pid: actor.desktopPid, runtimeSource: SOURCE, nativeIdleSince: undefined, waitingInput: false });
              journal.append("session", "The verified native WorkBuddy desktop conversation claimed this task.", { status: "working", sessionId, runtimeSource: SOURCE });
              const contextFile = path.join(journal.dir, "worker-context.json");
              const resultFile = path.join(journal.dir, "worker-result.json");
              writePrivateJson(contextFile, { sessionId, attemptId: task.attemptId!, leaseToken });
              const quote = (value: string) => "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";
              const helper = fileURLToPath(new URL("../dist/desktop-worker-cli.js", import.meta.url));
              const command = `${quote(process.execPath)} ${quote(helper)} finish --claim-file ${quote(contextFile)} --result-file ${quote(resultFile)}`;
              const prefix = `${quote(process.execPath)} ${quote(helper)}`;
              const progressFile = path.join(journal.dir, "worker-progress.json");
              const commandFile = path.join(journal.dir, "worker-command.json");
              const executionContract = `\n截止 ${current.deadline}；最迟 ${current.reportBy} 进入回报阶段，预留时间内不再开新验证；未完成就提交真实 blocked/failed 和部分成果，不自动延时。\n阶段变化或约60秒有意义进展时，Write ${progressFile}，JSON {"stage":"调查/实现/验证/回报","completed":"最近动作","running":"验证或等待事项","blocker":"阻塞或空串"}，执行：\n${prefix} update --claim-file ${quote(contextFile)} --progress-file ${quote(progressFile)}\n测试/浏览器样本使用有界执行器：Write ${commandFile}，JSON {"executable":"绝对可执行文件路径","args":["参数"],"cwd":"工作目录绝对路径","timeoutSeconds":60,"inputs":["被验证源码相对路径"]}，执行：\n${prefix} exec --claim-file ${quote(contextFile)} --command-file ${quote(commandFile)}\n执行器记录命令、退出码、源码哈希、日志路径并清理本命令进程树。124=超时，130=取消，125或cleanupConfirmed=false=监督/清理失败，不能算通过。不得按进程名杀其他进程。正常长任务无需修改文件来证明活动；等待用户输入时说明原因。\n验证当前改动的实际入口和相关异常边界；区分源码检查、Mock、本地浏览器、真实环境，报告实际命令/退出码/证据路径；修改后重跑受影响检查，不用旧结果。回报通常500字以内，详细日志留 artifacts。`;
              // Preserve the reporting contract inside the task itself, even
              // when a long conversation compacts the outer wake message.
              const prompt = `${request.prompt}${executionContract}\n\n[QUEUE_REPORT_CONTRACT]\n本轮最终交付必须通过队列回报，不能只在聊天中回复完成。完成或受阻时，用 Write 在以下文件写 UTF-8 JSON：\n${resultFile}\n格式：{"status":"completed|blocked|failed","text":"实际改动、验证结果及遗留问题","artifacts":["真实成果绝对路径"]}\n然后用自己的工具原样执行：\n${command}\n只回报实际结果。回报失败仅原命令原样重试一次，仍失败保留结果文件并结束，不排障网关或换 shell。回报成功后结束，不再次 claim。\n[/QUEUE_REPORT_CONTRACT]`;
              return { status: "task" as const, taskId: task.taskId, attemptId: task.attemptId!, sessionId, leaseToken, prompt, workspace: request.workspace, deadline: current.deadline!, reporting: { resultFile, command } };
            });
          });
          if (claimed) return claimed;
        }
        if (Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      return { status: "retry", message: "No task is available. End this turn; do not poll, retry claim, or fabricate an outcome. The service will wake a later task." };
    } finally { store.close(); writeListener(false); }
  }
  progress(input: {sessionId: string; attemptId: string; leaseToken: string; text: string}): {ok: true; cancellationRequested: boolean} {
    const actor = this.verifyActor();
    return this.mutateClaim(input, actor, (journal, snapshot) => {
      if (journal.cancellationRequested()) return {ok:true,cancellationRequested:true};
      let fields: Record<string, unknown>;
      try { fields=JSON.parse(input.text); } catch { fields={stage:"execution",completed:input.text}; }
      const values = ["stage", "completed", "running", "blocker"].map(k => String(fields[k] ?? "").slice(0, 600));
      if (!values[0]?.trim()) throw new Error("Progress requires a stage");
      const now = new Date().toISOString();
      const changed = !snapshot.progress || values.some((v, i) => v !== snapshot.progress![["stage", "completed", "running", "blocker"][i] as "stage"]);
      const progress = {stage:values[0]!,completed:values[1]!,running:values[2]!,blocker:values[3]!,lastMeaningfulAt:changed ? now : snapshot.progress!.lastMeaningfulAt,reportedAt:now};
      if (changed || Date.now() - Date.parse(snapshot.progress!.reportedAt) >= 60000) {
        journal.append("progress", JSON.stringify(progress), { sessionId: input.sessionId, runtimeSource: SOURCE });
        journal.save({...snapshot, progress});
      }
      return { ok: true, cancellationRequested: journal.cancellationRequested() };
    });
  }
  requestCancellation(attemptId: string): boolean {
    if (!/^run-[a-f0-9-]{36}$/.test(attemptId.split(":")[0]!)) return false;
    const journal = new RunJournal(this.root, attemptId.split(":")[0]!);
    const snapshot = journal.snapshot();
    const wake = readJson<WakeIntent>(path.join(journal.dir, "wake.json"));
    if (!snapshot || (TERMINAL.has(snapshot.status) && (hasNativeStopEvidence(snapshot) || (!fs.existsSync(path.join(journal.dir, "claim.json")) && (!wake || wake.state === "rejected"))))) return false;
    // Claim checks this flag under the same lock. Only a run with no possibly
    // delivered wake and no claim can be definitively cancelled immediately.
    locked(path.join(journal.dir, "queue-write.lock"), () => {
      const current = journal.snapshot()!;
      if (this.isDue(current) && !TERMINAL.has(current.status) && !journal.cancellationRequested()) this.expire(journal, current);
      journal.cancel();
      const latest = journal.snapshot()!;
      if (!latest.stopControl) journal.save({...latest, stopControl:{state:"requested",requestedAt:new Date().toISOString()}});
      const wake = readJson<WakeIntent>(path.join(journal.dir, "wake.json"));
      if (current.status === "queued" && !fs.existsSync(path.join(journal.dir, "claim.json")) && (!wake || wake.state === "rejected")) {
        journal.save({ ...current, status: "cancelled", stopReason: "cancelled_before_claim", nativeStoppedAt: new Date().toISOString(), nativeStopSource: "not_dispatched" });
        journal.append("result", "TASK_STATUS: cancelled\nCancelled before native claim.", { status: "cancelled", stopReason: "cancelled_before_claim", sessionId: current.sessionId });
      }
    });
    return true;
  }
  updateStopControl(attemptId: string, control: NonNullable<RunSnapshot["stopControl"]>): void {
    const journal = new RunJournal(this.root, attemptId);
    locked(path.join(journal.dir, "queue-write.lock"), () => {
      const current = journal.snapshot()!;
      journal.save({...current, stopControl:control});
    });
  }
  recordNativeHealth(attemptId:string,native:NativeObservation):void {
    const journal=new RunJournal(this.root,attemptId),snapshot=journal.snapshot();
    if(snapshot?.nativeHealth?.state===native.state && snapshot.nativeHealth.reason===native.reason && Date.now()-Date.parse(snapshot.nativeHealth.observedAt)<15000)return;
    locked(path.join(journal.dir,"queue-write.lock"),()=>{
      const current=journal.snapshot()!;
      journal.save({...current,nativeStopCheck:native.state === "idle" ? current.nativeStopCheck : undefined,nativeHealth:{state:native.state,reason:native.reason,observedAt:new Date().toISOString()}});
    });
  }
  authorizeCommand(input:{sessionId:string;attemptId:string;leaseToken:string}): RunSnapshot {
    return this.mutateClaim(input,this.verifyActor(),(journal,snapshot)=>{
      if (this.isDue(snapshot)) {this.expire(journal,snapshot);throw new Error("Task deadline passed; command refused");}
      if (journal.cancellationRequested()) throw new Error("Cancellation requested; command refused");
      return snapshot;
    });
  }
  report(input: {sessionId: string; attemptId: string; leaseToken: string; status: "completed" | "blocked" | "failed" | "cancelled"; text: string; artifacts: string[]; validationRecords?: ValidationEvidence[]}): {ok: true; status: string} {
    const actor = this.verifyActor();
    const fields: unknown[] = [input.status, input.text, input.artifacts];
    if (input.validationRecords?.length) fields.push(input.validationRecords);
    const digest = crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    return this.mutateClaim(input, actor, (journal, snapshot) => {
      if (!input.text.trim()) throw new Error("A real WorkBuddy result is required; an empty report cannot complete a task");
      verifyValidationEvidence(this.config, input.attemptId, input.validationRecords ?? []);
      // Enforce the same deadline whether or not an observer happened to poll.
      if (snapshot.status === "working" && snapshot.deadline && Date.parse(snapshot.deadline) <= Date.now() && !journal.cancellationRequested()) {
        this.expire(journal, snapshot);
        snapshot = journal.snapshot()!;
      }
      if (snapshot.status !== "working") {
        if (snapshot.reportDigest === digest) return { ok: true, status: snapshot.status };
        const cancellation = readJson<{reason?: string}>(path.join(journal.dir, "cancel.json"));
        if (!snapshot.reportDigest && snapshot.status === "blocked" && cancellation?.reason === "deadline" && !hasNativeStopEvidence(snapshot)) {
          // Actor and lease were verified by mutateClaim. Preserve the real
          // result for inspection without converting a timeout into success.
          writePrivateJson(path.join(journal.dir, "late-report.json"), {
            sessionId: input.sessionId, attemptId: input.attemptId, status: input.status,
            text: input.text, artifacts: input.artifacts, receivedAt: new Date().toISOString(),
          });
          const text = `TASK_STATUS: blocked\nThe task deadline passed. A verified late worker report was preserved for inspection; the task is not completed.\nWorker reported status: ${input.status}\n${input.text}`;
          journal.save({ ...snapshot, text, artifacts: input.artifacts, reportDigest: digest, validationRecords: input.validationRecords });
          journal.append("result", text, { status: "blocked", blockedReason: snapshot.error, lateReport: true,
            artifacts: input.artifacts, sessionId: input.sessionId, runtimeSource: SOURCE });
          return { ok: true, status: "blocked" };
        }
        throw new Error("This execution attempt is no longer active; old or conflicting reports are rejected");
      }
      const status = journal.cancellationRequested() ? "cancelled" : input.status === "completed" ? "needs_review" : input.status;
      const stopReason = status === "cancelled" ? "cancelled" : input.status === "completed" ? "end_turn" : input.status;
      journal.save({ ...snapshot, status, text: input.text, stopReason, artifacts: input.artifacts, reportDigest: digest, validationRecords: input.validationRecords, waitingInput: false, nativeStoppedAt: undefined, nativeStopSource: undefined });
      journal.append("result", input.text.slice(0, 1_000_000), { status, artifacts: input.artifacts, sessionId: input.sessionId, runtimeSource: SOURCE, stopReason });
      return { ok: true, status };
    }, true);
  }
  /** Supervisor evidence can block or confirm stop, never manufacture success. */
  observeNative(attemptId: string, native: NativeObservation): RunSnapshot {
    const journal = new RunJournal(this.root, attemptId);
    return locked(path.join(journal.dir, "queue-write.lock"), () => {
      let snapshot = journal.snapshot();
      const claim = readJson<Claim>(path.join(journal.dir, "claim.json"));
      const request = journal.request();
      if (!snapshot || snapshot.driver !== "desktop-queue" || (claim ? claim.sessionId !== snapshot.sessionId : !["queued", "blocked", "cancelled"].includes(snapshot.status)) ||
          request.sessionId !== snapshot.sessionId || native.state === "offline" || native.workspace !== request.workspace ||
          !snapshot.sessionId || !readDesktopSession(this.config.workbuddyConfigDir, snapshot.sessionId).registered) throw new Error("Native observation does not match the execution");
      const wake = readJson<WakeIntent>(path.join(journal.dir, "wake.json"));
      const incomingFailure = native.failure;
      if (incomingFailure && wake && incomingFailure.wakeId === wake.wakeId &&
          Number.isFinite(Date.parse(incomingFailure.observedAt)) && Date.parse(incomingFailure.observedAt) >= Date.parse(wake.createdAt) &&
          (!snapshot.nativeFailure || Date.parse(incomingFailure.observedAt) > Date.parse(snapshot.nativeFailure.observedAt))) {
        snapshot = {...snapshot,nativeFailure:incomingFailure,nativeStoppedAt:undefined,nativeStopSource:undefined,nativeStopCheck:undefined};
        journal.save(snapshot);
      }
      if (hasNativeStopEvidence(snapshot)) return snapshot;
      let stopped = native.state === "idle";
      if (snapshot.nativeFailure) {
        const acknowledgedAt = Date.parse(snapshot.stopControl?.acknowledgedAt ?? "");
        stopped = stopped && native.latestWakeId === wake?.wakeId && Number.isFinite(acknowledgedAt) && acknowledgedAt >= Date.parse(snapshot.nativeFailure.observedAt);
        const prior = snapshot.nativeStopCheck;
        const now = new Date().toISOString();
        const check = stopped ? prior && prior.activityAt === native.activityAt
          ? {...prior,checkedAt:now,observations:prior.observations+1}
          : {since:now,checkedAt:now,observations:1,activityAt:native.activityAt} : undefined;
        snapshot = {...snapshot,nativeStopCheck:check};
        journal.save(snapshot);
        stopped = Boolean(check && check.observations >= 2 && Date.parse(now)-Date.parse(check.since) >= 1000);
      }
      if (stopped) {
        const commands = path.join(journal.dir,"commands");
        if (fs.existsSync(commands)) for (const name of fs.readdirSync(commands)) {
          if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
          const command=readJson<{endedAt?:string;cleanupConfirmed?:boolean;reason?:string}>(path.join(commands,name));
          if (!command?.endedAt || command.cleanupConfirmed !== true) throw Error(`stop_unconfirmed: owned command cleanup lacks evidence: ${name}`);
          if (command.reason === "supervisor_exited_job_closed" && snapshot.status === "needs_review") {
            const error="Owned command supervisor exited without a final result; cleanup was verified, validation was not. Inspect existing artifacts before rework.";
            snapshot={...snapshot,status:"blocked",error};journal.save(snapshot);
            journal.append("result",`TASK_STATUS: blocked\n${error}`,{status:"blocked",blockedReason:error,sessionId:snapshot.sessionId});
          }
        }
      }
      if (journal.cancellationRequested()) {
        if (stopped) {
          const cancelled = readJson<{reason:string}>(path.join(journal.dir, "cancel.json"));
          const status = cancelled?.reason === "deadline" || snapshot.error ? "blocked" : "cancelled";
          journal.save({...snapshot,status,stopReason:snapshot.stopReason ?? "native_idle_verified",waitingInput:false,nativeStoppedAt:new Date().toISOString(),nativeStopSource:"native_idle",
            stopControl:{...snapshot.stopControl,requestedAt:snapshot.stopControl?.requestedAt ?? new Date().toISOString(),state:"stopped",checkedAt:new Date().toISOString()}});
          journal.append("status", "Native idle verified after cancellation; original outcome and report preserved.", {status,sessionId:snapshot.sessionId,runtimeSource:snapshot.runtimeSource});
        }
        return journal.snapshot()!;
      }
      const failure = snapshot.nativeFailure;
      if (failure && wake && failure.wakeId === wake.wakeId &&
          Number.isFinite(Date.parse(failure.observedAt)) && Date.parse(failure.observedAt) >= Date.parse(wake.createdAt)) {
        const diagnosis = diagnoseNativeFailure(failure.error, failure.observedAt, failure.phase);
        const reportedAt = snapshot.status === "needs_review" ? this.completedReportBeforeFailure(journal, snapshot, failure.observedAt) : undefined;
        if (reportedAt) {
          this.preserveReportedFailure(journal, snapshot, native, failure, reportedAt, undefined, stopped);
          return journal.snapshot()!;
        }
        const error = diagnosis.message;
        const stopReason = stopped ? "native_failure_verified" : undefined;
        if (snapshot.error !== error || snapshot.stopReason !== stopReason || snapshot.status !== "blocked") {
          journal.save({ ...snapshot, status: "blocked", error, nativeRateLimit: diagnosis.rateLimit, stopReason, waitingInput: native.state === "waiting_input", nativeStoppedAt: stopped ? new Date().toISOString() : undefined, nativeStopSource: stopped ? "native_idle" : undefined });
          journal.append("result", `TASK_STATUS: blocked\n${error}`, { status: "blocked", blockedReason: error, sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource, stopReason, nativeRateLimit: diagnosis.rateLimit });
        }
        return journal.snapshot()!;
      }
      if (snapshot.reportDigest || (snapshot.text && ["end_turn", "blocked", "failed", "cancelled"].includes(snapshot.stopReason ?? ""))) {
        if (native.state === "idle") {
          const nativeStoppedAt = new Date().toISOString();
          journal.save({ ...snapshot, nativeStoppedAt, nativeStopSource: "native_idle", waitingInput: false });
          journal.append("status", "Native idle verified after the worker report; the report and its artifacts were preserved.", { status: snapshot.status, sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource, nativeStoppedAt });
        } else if (Boolean(snapshot.waitingInput) !== (native.state === "waiting_input")) {
          journal.save({ ...snapshot, waitingInput: native.state === "waiting_input" });
        }
        return journal.snapshot()!;
      }
      if (journal.cancellationRequested() && native.state === "idle") {
        const status = snapshot.error ? "blocked" : "cancelled";
        journal.save({ ...snapshot, status, stopReason: "native_idle_verified", waitingInput: false, nativeStoppedAt: new Date().toISOString(), nativeStopSource: "native_idle" });
        journal.append("result", `TASK_STATUS: ${status}\nNative session verified idle after stop request. Existing files preserved.`, { status, blockedReason: snapshot.error, sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource, stopReason: "native_idle_verified" });
        return journal.snapshot()!;
      }
      if (this.isDue(snapshot) && snapshot.status !== "blocked") {
        this.expire(journal, snapshot);
        return journal.snapshot()!;
      }
      if (native.state === "waiting_input") {
        if (!snapshot.waitingInput) {
          journal.save({ ...snapshot, waitingInput: true, nativeIdleSince: undefined });
          journal.append("status", native.reason ?? "WorkBuddy is waiting for native permission or input; no automatic retry.", { status: "waiting_input", sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource });
        }
      } else if (native.state === "busy") {
        if (snapshot.waitingInput || snapshot.nativeIdleSince) {
          journal.save({ ...snapshot, waitingInput: false, nativeIdleSince: undefined });
          if (snapshot.waitingInput) journal.append("status", "Native execution resumed.", { status: snapshot.status, sessionId: snapshot.sessionId });
        }
      } else {
        // A successful RPC/idle state is not a worker result. Allow a short
        // propagation window, then expose the missing report as blocked.
        if (!snapshot.nativeIdleSince) journal.save({ ...snapshot, nativeIdleSince: new Date().toISOString(), waitingInput: false });
        else if (Date.now() - Date.parse(snapshot.nativeIdleSince) >= 10_000) {
          const error = "Native WorkBuddy turn ended without a verified worker report. Existing files preserved; no automatic resend.";
          journal.save({ ...snapshot, status: "blocked", error, stopReason: "native_idle_without_report", waitingInput: false, nativeStoppedAt: new Date().toISOString(), nativeStopSource: "native_idle" });
          journal.append("result", `TASK_STATUS: blocked\n${error}`, { status: "blocked", blockedReason: error, sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource, stopReason: "native_idle_without_report" });
        }
      }
      return journal.snapshot()!;
    });
  }
  /** Reconcile the old ordering bug using the existing authenticated report only. */
  reconcileReportedFailure(input: {taskId: string; attemptId: string; sessionId: string; workspace: string; reason: string}, native: NativeObservation) {
    const journal = new RunJournal(this.root, input.attemptId);
    return locked(path.join(journal.dir, "queue-write.lock"), () => {
      const snapshot = journal.snapshot(), request = journal.request();
      const claim = readJson<Claim>(path.join(journal.dir, "claim.json"));
      const wake = readJson<WakeIntent>(path.join(journal.dir, "wake.json"));
      const store = new TaskStore(this.config.dbFile);
      try {
        const task = store.get(input.taskId);
        if (!task || task.attemptId !== input.attemptId || task.sessionId !== input.sessionId || task.workspace !== input.workspace ||
            !snapshot || snapshot.taskId !== input.taskId || snapshot.attemptId !== input.attemptId || snapshot.sessionId !== input.sessionId || snapshot.driver !== "desktop-queue" ||
            request.taskId !== input.taskId || request.attemptId !== input.attemptId || request.sessionId !== input.sessionId || request.workspace !== input.workspace ||
            claim?.sessionId !== input.sessionId || wake?.sessionId !== input.sessionId || wake.attemptId !== input.attemptId ||
            !readDesktopSession(this.config.workbuddyConfigDir, input.sessionId).registered) throw Error("Report reconciliation identity does not match the current task/attempt/session/workspace");
        if (native.state !== "idle" || native.workspace !== input.workspace) throw Error("Report reconciliation requires current native idle in the original workspace");
        const alreadyReconciled = ["blocked","needs_review"].includes(task.state) && snapshot.status === "needs_review" && Boolean(snapshot.postReportFailure) && hasNativeStopEvidence(snapshot);
        if (!alreadyReconciled && (task.state !== "blocked" || snapshot.status !== "blocked" || snapshot.stopReason !== "native_failure_verified" || !hasNativeStopEvidence(snapshot))) throw Error("Only a stopped native-failure attempt with a preserved authenticated report can be reconciled");
        if (!input.reason.trim() || journal.cancellationRequested()) throw Error("A reconciliation reason is required and cancelled/deadline attempts cannot be reconciled");
        const failure = native.failure;
        if (!failure || failure.wakeId !== wake.wakeId) throw Error("The original native failure must be correlated with this wake");
        const reportedAt = this.completedReportBeforeFailure(journal, snapshot, failure.observedAt);
        if (!reportedAt) throw Error("No intact, on-time authenticated completed report predates the native failure");
        const commands = path.join(journal.dir, "commands");
        if (fs.existsSync(commands)) for (const name of fs.readdirSync(commands)) {
          if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
          const record = readJson<{endedAt?:string;cleanupConfirmed?:boolean;reason?:string}>(path.join(commands,name));
          if (!record?.endedAt || record.cleanupConfirmed !== true || record.reason === "supervisor_exited_job_closed") throw Error("Owned command completion/cleanup is not verified; report reconciliation refused");
        }
        this.preserveReportedFailure(journal, snapshot, native, failure, reportedAt, input.reason);
        return {ok:true,alreadyReconciled,taskCompleted:false};
      } finally {store.close();}
    });
  }
  private completedReportBeforeFailure(journal: RunJournal, snapshot: RunSnapshot, failedAt: string): string | undefined {
    if (!snapshot.reportDigest || !snapshot.text?.trim() || snapshot.runtimeSource !== SOURCE || journal.cancellationRequested() ||
        !snapshot.deadline || !Number.isFinite(Date.parse(snapshot.deadline))) return;
    const fields: unknown[] = ["completed", snapshot.text, snapshot.artifacts ?? []];
    if (snapshot.validationRecords?.length) fields.push(snapshot.validationRecords);
    if (crypto.createHash("sha256").update(JSON.stringify(fields)).digest("hex") !== snapshot.reportDigest) return;
    const event = journal.events(0, Infinity).find(event => event.type === "result" && event.metadata?.status === "needs_review" &&
      event.metadata.sessionId === snapshot.sessionId && event.metadata.runtimeSource === SOURCE && event.text === snapshot.text &&
      JSON.stringify(event.metadata.artifacts) === JSON.stringify(snapshot.artifacts ?? []));
    if (!event || !Number.isFinite(Date.parse(event.createdAt)) || !Number.isFinite(Date.parse(failedAt)) ||
        Date.parse(event.createdAt) >= Date.parse(failedAt) || (snapshot.deadline && Date.parse(event.createdAt) > Date.parse(snapshot.deadline))) return;
    return event.createdAt;
  }
  private preserveReportedFailure(journal: RunJournal, snapshot: RunSnapshot, native: NativeObservation,
    failure: NonNullable<NativeObservation["failure"]>, reportedAt: string, reconciliationReason?: string, stopped = native.state === "idle"): void {
    const diagnosis = diagnoseNativeFailure(failure.error, failure.observedAt, failure.phase);
    const warning = {error:failure.error.slice(0,2000),observedAt:failure.observedAt,reportReceivedAt:reportedAt,phase:failure.phase};
    const recorded = journal.events(0,Infinity).some(event=>event.metadata?.reportPreserved === true &&
      (event.metadata.postReportFailure as RunSnapshot["postReportFailure"])?.observedAt === failure.observedAt);
    if (snapshot.status === "needs_review" && snapshot.postReportFailure?.observedAt === failure.observedAt &&
        snapshot.postReportFailure.error === warning.error && (!stopped || hasNativeStopEvidence(snapshot)) && recorded) return;
    journal.save({...snapshot,status:"needs_review",error:undefined,stopReason:"end_turn",postReportFailure:warning,nativeRateLimit:diagnosis.rateLimit,
      waitingInput:native.state === "waiting_input",nativeStoppedAt:stopped?new Date().toISOString():undefined,nativeStopSource:stopped?"native_idle":undefined});
    journal.append("status", "Authenticated worker report preserved; a later native error is recorded separately. Independent review is still required.",
      {status:"needs_review",sessionId:snapshot.sessionId,runtimeSource:SOURCE,reportPreserved:true,postReportFailure:warning,reconciliationReason});
  }
  /** Close an expired attempt after a separate native idle check. This is NOT a worker result. */
  confirmExpiredStop(input: { taskId: string; attemptId: string; sessionId: string; workspace: string; observedAt: string; reason: string }): { ok: true; alreadyRecovered: boolean } {
    const journal = new RunJournal(this.root, input.attemptId);
    return locked(path.join(this.root, "queue-session-locks", `${key(input.sessionId)}.lock`), () => locked(path.join(journal.dir, "queue-write.lock"), () => {
      const store = new TaskStore(this.config.dbFile);
      try {
        const task = store.get(input.taskId);
        const snapshot = journal.snapshot();
        const request = journal.request();
        const claim = readJson<Claim>(path.join(journal.dir, "claim.json"));
        if (!task || task.attemptId !== input.attemptId || task.sessionId !== input.sessionId || task.state !== "blocked") throw new Error("Recovery requires the current blocked task attempt and its original session");
        if (!snapshot || snapshot.driver !== "desktop-queue" || snapshot.taskId !== input.taskId || snapshot.sessionId !== input.sessionId || snapshot.status !== "blocked" || (claim && claim.sessionId !== input.sessionId)) throw new Error("Recovery requires a blocked desktop queue attempt in its original session");
        // A service can disappear before any native delivery. Such an attempt
        // has no lease to close, but still needs the same fresh idle check.
        // Any delivery/execution evidence keeps unclaimed recovery forbidden.
        if (!claim && (fs.existsSync(path.join(journal.dir, "wake.json")) || snapshot.runtimeSource ||
            snapshot.nativeFailure || snapshot.reportDigest || snapshot.stopControl?.issuedAt)) {
          throw new Error("Unclaimed recovery requires no native delivery or execution evidence");
        }
        if (task.workspace !== input.workspace || request.workspace !== input.workspace || request.sessionId !== input.sessionId) throw new Error("Recovery workspace or session does not match the original task");
        const cancellation = readJson<{ reason?: string }>(path.join(journal.dir, "cancel.json"));
        if (!snapshot.deadline || Date.parse(snapshot.deadline) > Date.now() || (cancellation && cancellation.reason !== "deadline")) throw new Error("Only an expired attempt without an operator cancellation can be recovered");
        if (snapshot.nativeFailure && !hasNativeStopEvidence(snapshot)) throw new Error("Native failure stop is unconfirmed; a one-time idle recovery cannot bypass cancellation acknowledgement and stable idle checks");
        if (snapshot.stopReason === "native_idle_verified") return { ok: true, alreadyRecovered: true };
        if (snapshot.stopReason) throw new Error("This attempt already has a terminal stop reason");
        if (!input.reason.trim() || !Number.isFinite(Date.parse(input.observedAt)) || Math.abs(Date.now() - Date.parse(input.observedAt)) > 10_000) throw new Error("Recovery requires a fresh native idle observation and an inspection reason");
        const evidence = readDesktopSession(this.config.workbuddyConfigDir, input.sessionId);
        if (!evidence.registered || evidence.cwd !== input.workspace) throw new Error("Original native desktop registration no longer matches");
        writePrivateJson(path.join(journal.dir, "recovery.json"), { ...input, source: "native_rpc_idle_inspection", taskCompleted: false, recoveredAt: new Date().toISOString() });
        journal.save({ ...snapshot, stopReason: "native_idle_verified" });
        journal.append("status", `Expired attempt confirmed stopped through native idle inspection. Existing artifacts and failure history preserved. No task was completed or resent. Reason: ${input.reason}`, { status: "blocked", sessionId: input.sessionId, stopReason: "native_idle_verified", recovery: true });
        return { ok: true, alreadyRecovered: false };
      } finally { store.close(); }
    }));
  }
  private mutateClaim<T>(input: {sessionId: string; attemptId: string; leaseToken: string}, actor: DesktopActor, action: (journal: RunJournal, snapshot: RunSnapshot) => T, allowReportReplay = false): T {
    const journal = new RunJournal(this.root, input.attemptId);
    return locked(path.join(journal.dir, "queue-write.lock"), () => {
      const claim = readJson<Claim>(path.join(journal.dir, "claim.json"));
      if (!claim || claim.sessionId !== input.sessionId || claim.desktopPid !== actor.desktopPid || claim.leaseHash !== key(input.leaseToken)) throw new Error("Report does not belong to this verified desktop session and execution lease");
      const snapshot = journal.snapshot();
      if (!snapshot || (snapshot.status !== "working" && !allowReportReplay)) throw new Error("This execution attempt is no longer active; old or repeated reports are rejected");
      if (!readDesktopSession(this.config.workbuddyConfigDir, input.sessionId).registered) throw new Error("WorkBuddy desktop registration disappeared");
      return action(journal, snapshot);
    });
  }
  messages(cursor: string, limit = 100): LocalMessage[] {
    const attemptId = cursor.split(":")[0]!;
    if (!/^run-[a-f0-9-]{36}$/.test(attemptId)) return new DurableRuns(this.config).messages(cursor, limit);
    this.checkDeadline(attemptId);
    return new DurableRuns(this.config).messages(cursor, limit);
  }
  checkDeadline(attemptId: string): void {
    const journal = new RunJournal(this.root, attemptId);
    const snapshot = journal.snapshot();
    if (journal.cancellationRequested()) return; // Preserve the first cancellation/deadline outcome.
    // Most message/status reads have nothing to mutate. Do not take a writer
    // lock until expiration is actually due; recheck after acquiring it.
    if (snapshot?.driver === "desktop-queue" && (!TERMINAL.has(snapshot.status) || snapshot.status === "needs_review" && !hasNativeStopEvidence(snapshot)) && this.isDue(snapshot)) {
      locked(path.join(journal.dir, "queue-write.lock"), () => {
        const current = journal.snapshot()!;
        if (!journal.cancellationRequested() && (!TERMINAL.has(current.status) || current.status === "needs_review" && !hasNativeStopEvidence(current)) && this.isDue(current)) this.expire(journal, current);
      });
    }
  }
  private isDue(snapshot: RunSnapshot): boolean {
    return Boolean((snapshot.deadline && Date.parse(snapshot.deadline) <= Date.now()) ||
      (snapshot.status === "queued" && snapshot.claimDeadline && Date.parse(snapshot.claimDeadline) <= Date.now()));
  }
  private expire(journal: RunJournal, snapshot: RunSnapshot): void {
    const unclaimed = snapshot.status === "queued" && snapshot.claimDeadline && Date.parse(snapshot.claimDeadline) <= Date.now();
    const error = unclaimed
      ? "The native desktop worker did not claim the task within the startup window. Inspect the original conversation and service; no automatic resend occurred."
      : "The desktop queue task deadline passed without a verified result. Inspect the original WorkBuddy conversation before rework; no automatic resend occurred.";
    journal.save({ ...snapshot, status: "blocked", error });
    if ((fs.existsSync(path.join(journal.dir, "claim.json")) || fs.existsSync(path.join(journal.dir, "wake.json"))) && !journal.cancellationRequested()) journal.cancel("deadline");
    journal.append("result", `TASK_STATUS: blocked\n${error}`, { status: "blocked", blockedReason: error, sessionId: snapshot.sessionId, runtimeSource: snapshot.runtimeSource });
  }
}
