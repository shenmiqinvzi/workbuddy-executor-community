import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { checkNativeSchema } from "./doctor.js";
import { discoverDesktopPaths, supportedNode, type DiscoveryOptions } from "./deployment-paths.js";
import { PROJECT_ROOT } from "./env.js";
import { readCapacityOccupant } from "./operation-admission.js";
import { preflightReport } from "./verification-plan.js";
import { readServiceRegistration } from "./persistent-service.js";
import { runsDirectory } from "./run-journal.js";
import type { Config } from "./config.js";

// Readiness answers five different questions that used to collapse into one
// "is it working?" answer. Each layer may only claim what it can observe:
//   toolResponsive            the MCP tool process answers at all
//   nativeOnline              the WorkBuddy desktop app is reachable over the bridge
//   projectSessionDispatchable a shared capacity slot and a project session can take a task
//   candidateDeployed         the running code is the candidate on disk (runtime summary, not a file version)
//   desktopPageReady          the workbench page in the desktop shell finished loading
// Every reader here is read-only: no model preparation, no service start, no session mutation,
// no file creation. Missing evidence is reported as unknown and never replaced by a disk version.

export const READINESS_SCHEMA = "workbuddy-readiness/v1";
export type ReadinessState = "ready" | "unverified" | "blocked" | "absent" | "unknown";
export type ReadinessLayerName = "toolResponsive" | "nativeOnline" | "projectSessionDispatchable" | "candidateDeployed" | "desktopPageReady";

export interface ReadinessLayer {
  layer: ReadinessLayerName;
  question: string;
  state: ReadinessState;
  observedAt: string;
  facts: Record<string, string | number | boolean | null>;
  missing: string[];
  reason?: string;
}

export interface ReadinessReport {
  schema: typeof READINESS_SCHEMA;
  readOnly: true;
  observedAt: string;
  selection: SelectionReport;
  layers: ReadinessLayer[];
  nextAction: { layer: ReadinessLayerName | "dispatch" | "selection"; action: string } | null;
  notes: string[];
}

/**
 * Which install the diagnosis looked at. An ambiguous machine (two native data
 * directories) is its own state with its own candidates: it is not "unknown" and
 * it is not a hang. Nothing here writes a config file; the commands are for the user.
 */
export interface SelectionReport {
  state: "resolved" | "ambiguous" | "missing";
  backend: string;
  config: { state: string; candidates: string[] };
  executable: { state: string; candidates: string[] };
  suggested: string[];
}

export interface RuntimeSummary {
  pid: number;
  codeHash?: string;
  packageVersion?: string;
  release?: string;
  updatedAt?: string;
  status?: string;
}

export interface DesktopWindowObservation {
  reachable: boolean;
  reason?: string;
  snapshot?: Record<string, unknown>;
}

export interface ReadinessProbes {
  tool?: () => Promise<{ responsive: boolean; detail?: string }>;
  native?: () => Promise<{ bridgeReady: boolean; detail?: string }>;
}

export interface ReadinessOptions extends DiscoveryOptions {
  root?: string;
  config?: Config;
  /** Set when the caller could not resolve a config; reported as unknown, never as "no database". */
  configError?: string;
  probes?: ReadinessProbes;
  candidate?: { codeHash?: string; packageVersion?: string };
  desktopObservation?: DesktopWindowObservation;
  desktopObserver?: () => Promise<DesktopWindowObservation>;
  now?: () => Date;
  timeoutMs?: number;
}

const QUESTIONS: Record<ReadinessLayerName, string> = {
  toolResponsive: "工具本身能否应答（MCP 进程在跑吗）",
  nativeOnline: "WorkBuddy 原生端是否在线（桥接可否联通）",
  projectSessionDispatchable: "共享容量与项目会话现在能否接单",
  candidateDeployed: "正在运行的代码是不是磁盘上的候选（运行摘要一致吗）",
  desktopPageReady: "桌面壳里的工作台页面是否已就绪",
};

function hasFile(filename?: string): boolean {
  try { return Boolean(filename && fs.statSync(filename).isFile()); } catch { return false; }
}

function isDirectory(directory?: string): boolean {
  try { return Boolean(directory && fs.statSync(directory).isDirectory()); } catch { return false; }
}

function writable(directory: string): boolean {
  try { fs.accessSync(directory, fs.constants.W_OK); return true; } catch { return false; }
}

function short(hash?: string): string | null { return hash ? hash.slice(0, 12) : null; }

/** Local paths stay recognisable but never print a user name or an install root verbatim. */
export function maskPath(value: string, replacement: { home: string; env: NodeJS.ProcessEnv }): string {
  const pairs: Array<[string | undefined, string]> = [[replacement.home, "%USERPROFILE%"], [replacement.env.LOCALAPPDATA, "%LOCALAPPDATA%"], [replacement.env.ProgramFiles, "%ProgramFiles%"], [replacement.env["ProgramFiles(x86)"], "%ProgramFiles(x86)%"]];
  let output = value;
  for (const [from, to] of pairs) if (from && from.trim()) output = output.split(from).join(to);
  return output;
}

function selectionReport(discovery: ReturnType<typeof discoverDesktopPaths> | undefined, config: Config | undefined, env: NodeJS.ProcessEnv, home: string): SelectionReport {
  const configPath = discovery?.config, executable = discovery?.executable;
  const state: SelectionReport["state"] = configPath?.source === "ambiguous" || executable?.source === "ambiguous" ? "ambiguous"
    : config ? "resolved" : "missing";
  const mask = (value: string) => maskPath(value, { home, env });
  const suggested: string[] = [];
  if (configPath?.source === "ambiguous") for (const candidate of configPath.candidates.slice(0, 4)) suggested.push(`$env:WORKBUDDY_CONFIG_DIR = "${mask(candidate)}"`);
  if (executable?.source === "ambiguous") for (const candidate of executable.candidates.slice(0, 4)) suggested.push(`$env:WORKBUDDY_CLI_ELECTRON = "${mask(candidate)}"`);
  if (executable?.source === "missing") suggested.push('$env:WORKBUDDY_CLI_ELECTRON = "%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddyAI.exe"');
  if (state !== "resolved") suggested.push('$env:WORKBUDDY_BACKEND = "desktop-queue"');
  return {
    state, backend: config?.backend ?? String(env.WORKBUDDY_BACKEND ?? "unresolved"),
    config: { state: configPath?.source ?? "missing", candidates: (configPath?.candidates ?? []).map(mask) },
    executable: { state: executable?.source ?? "missing", candidates: (executable?.candidates ?? []).map(mask) },
    suggested,
  };
}

const SANE_CODE_HASH = /^[a-f0-9]{64}$/;

/** Same shape as runtime-version: relative paths sorted, name then bytes. */
export function codeHashOf(root: string): string | undefined {
  if (!isDirectory(root)) return undefined;
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []).sort();
  try {
    const files = walk(root);
    if (files.length === 0) return undefined;
    const hash = crypto.createHash("sha256");
    for (const file of files) hash.update(path.relative(root, file).replaceAll("\\", "/")).update(fs.readFileSync(file));
    return hash.digest("hex");
  } catch { return undefined; }
}

/**
 * The supervisor writes this once per turn. It is the only in-band evidence about
 * the *running* code, so a missing summary stays unknown; the on-disk package.json
 * version is a different fact and must never stand in for it.
 */
export function readRuntimeSummary(projectDir: string): { found: boolean; summary?: RuntimeSummary; reason?: string } {
  const file = path.join(projectDir, "data", "persistent-service-status.json");
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { found: false, reason: code === "ENOENT" ? "no runtime summary was ever written" : "the runtime summary could not be read" };
  }
  if (!raw || typeof raw !== "object") return { found: false, reason: "the runtime summary is not an object" };
  const record = raw as Record<string, unknown>;
  const pid = typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
  if (pid === undefined) return { found: false, reason: "the runtime summary has no usable pid" };
  const runtime = record.runtime && typeof record.runtime === "object" ? record.runtime as Record<string, unknown> : undefined;
  const codeHash = typeof runtime?.codeHash === "string" && SANE_CODE_HASH.test(runtime.codeHash) ? runtime.codeHash : undefined;
  return {
    found: true,
    summary: {
      pid,
      codeHash,
      packageVersion: typeof runtime?.packageVersion === "string" ? runtime.packageVersion : undefined,
      release: typeof runtime?.release === "string" ? runtime.release : undefined,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : undefined,
      status: typeof record.status === "string" ? record.status : undefined,
    },
  };
}

export function isFresh(summary: RuntimeSummary | undefined, now: Date, intervalMs = 1500): boolean {
  if (!summary?.updatedAt) return false;
  const written = Date.parse(summary.updatedAt);
  if (!Number.isFinite(written)) return false;
  const budget = Math.max(intervalMs * 3, 15_000);
  return now.getTime() - written <= budget && written - now.getTime() <= budget;
}

/** Mirrors DesktopPolicy.InstanceKey so a status read reaches the window this install owns. */
/**
 * Mirrors DesktopPolicy.InstanceKey so a status read reaches the window this install owns.
 * A trailing separator must not change the identity: the launcher passes the gateway directory
 * without one, while the module root carries one, and the two have to name the same pipe.
 */
export function desktopInstanceKey(input: { gatewayDir: string; database: string; runsDir: string }): string {
  const material = [input.gatewayDir, input.database, input.runsDir]
    .map(value => path.win32.normalize(value).replace(/[\\/]+$/, "").toUpperCase())
    .join("\n");
  return crypto.createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24).toUpperCase();
}

export function desktopWindowPaths(config: Config, root: string): { gatewayDir: string; database: string; runsDir: string; pipeName: string } {
  const trim = (value: string) => path.win32.normalize(value).replace(/[\\/]+$/, "");
  const database = trim(config.dbFile);
  const runsDir = trim(runsDirectory(config));
  const gatewayDir = trim(path.join(root));
  return { gatewayDir, database, runsDir, pipeName: `WorkBuddy.Workbench.${desktopInstanceKey({ gatewayDir, database, runsDir })}` };
}

/**
 * Ask the shell for its snapshot. The request is status-only, so the window neither
 * raises itself nor navigates. `status:true` also keeps a second window from opening.
 */
export async function observeDesktopWindow(pipeName: string, timeoutMs = 2500): Promise<DesktopWindowObservation> {
  return await new Promise<DesktopWindowObservation>(resolve => {
    let settled = false;
    const finish = (observation: DesktopWindowObservation) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(observation); };
    const socket = net.connect(`\\\\.\\pipe\\${pipeName}`);
    const timer = setTimeout(() => finish({ reachable: false, reason: `no snapshot within ${timeoutMs}ms` }), timeoutMs);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const reason = error.code === "ENOENT" || error.code === "ECONNREFUSED" ? "no desktop window is running for this install" : "the desktop window did not accept a status read";
      finish({ reachable: false, reason });
    });
    socket.on("data", chunk => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffered.slice(0, newline));
        finish(parsed && typeof parsed === "object" ? { reachable: true, snapshot: parsed as Record<string, unknown> } : { reachable: false, reason: "the snapshot was not an object" });
      } catch { finish({ reachable: false, reason: "the snapshot was not valid JSON" }); }
    });
    socket.on("connect", () => socket.write(JSON.stringify({ taskId: null, status: true }) + "\n"));
  });
}

function countSessions(configDir: string | undefined): { state: "known"; count: number } | { state: "unreadable"; reason: string } {
  if (!configDir) return { state: "unreadable", reason: "no native config directory is configured" };
  const file = path.join(configDir, "workbuddy.db");
  if (!hasFile(file)) return { state: "unreadable", reason: "the native session store is not readable" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare("SELECT COUNT(*) AS total FROM sessions WHERE deleted_at IS NULL").get() as { total?: number } | undefined;
    return { state: "known", count: typeof row?.total === "number" ? row.total : 0 };
  } catch { return { state: "unreadable", reason: "the native session store could not be read" }; }
  finally { db?.close(); }
}

function layer(name: ReadinessLayerName, state: ReadinessState, observedAt: string, facts: ReadinessLayer["facts"], missing: string[], reason?: string): ReadinessLayer {
  return { layer: name, question: QUESTIONS[name], state, observedAt, facts, missing, ...(reason ? { reason } : {}) };
}

const WORKBENCH_PAGE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/workbench\/?(?:#.*)?$/;

export async function observeReadiness(options: ReadinessOptions = {}): Promise<ReadinessReport> {
  const root = options.root ?? PROJECT_ROOT;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const observedAt = now().toISOString();
  // An ambiguous install is a state the user can fix, not a crash: report it and
  // keep the other four layers observable.
  const selection: { ok?: ReturnType<typeof discoverDesktopPaths>; error?: string } = (() => {
    try { return { ok: discoverDesktopPaths(options) }; }
    catch (error) { return { error: (error as Error)?.message ?? "the install could not be selected" }; }
  })();
  const discovery = selection.ok;
  const discoveryError = selection.error;
  const config = options.config;
  const notes: string[] = [];

  // ---- toolResponsive -------------------------------------------------------
  const buildPresent = hasFile(path.join(root, "dist", "server.js"));
  const summaryRead = readRuntimeSummary(root);
  const heartbeatFresh = isFresh(summaryRead.summary, now());
  const toolFacts: ReadinessLayer["facts"] = {
    buildPresent, nodeSupported: supportedNode(), platformSupported: (options.platform ?? process.platform) === "win32",
    runtimeSummary: summaryRead.found ? "present" : "missing", runtimePid: summaryRead.summary?.pid ?? null,
    runtimeHeartbeat: summaryRead.found ? (heartbeatFresh ? "fresh" : "stale") : "absent",
    supervisorPidAlive: summaryRead.summary ? isAlive(summaryRead.summary.pid) : null,
  };
  let toolProbe: { responsive: boolean; detail?: string } | undefined;
  if (options.probes?.tool) {
    try { toolProbe = await options.probes.tool(); } catch { toolProbe = { responsive: false, detail: "the tool probe failed" }; }
  }
  const toolLayer = !buildPresent
    ? layer("toolResponsive", "absent", observedAt, toolFacts, ["dist/server.js"], "this install root has no build to respond with")
    : toolProbe
      ? layer("toolResponsive", toolProbe.responsive ? "ready" : "blocked", observedAt, { ...toolFacts, toolProbe: toolProbe.responsive }, [], toolProbe.detail)
      : heartbeatFresh
        ? layer("toolResponsive", "unverified", observedAt, toolFacts, ["tool_probe"], "a supervisor is writing heartbeats, but nothing proved the tool process itself answers")
        : layer("toolResponsive", "unknown", observedAt, toolFacts, [summaryRead.found ? "fresh_runtime_summary" : "runtime_summary"], summaryRead.reason);

  // ---- nativeOnline --------------------------------------------------------
  const applicationPresent = hasFile(discovery?.executable.value);
  const nativeFacts: ReadinessLayer["facts"] = {
    applicationPresent, applicationSource: discovery?.executable.source ?? "ambiguous",
    configSchemaCompatible: checkNativeSchema(discovery?.config.value),
  };
  let nativeProbe: { bridgeReady: boolean; detail?: string } | undefined;
  if (options.probes?.native) {
    try { nativeProbe = await options.probes.native(); } catch { nativeProbe = { bridgeReady: false, detail: "the bridge probe failed" }; }
  }
  const nativeLayer = discoveryError
    ? layer("nativeOnline", "blocked", observedAt, nativeFacts, ["application_selection"], discoveryError)
    : !applicationPresent
      ? layer("nativeOnline", "absent", observedAt, nativeFacts, ["application"], "no WorkBuddy executable was found; diagnosis does not install or start it")
      : nativeProbe
        ? layer("nativeOnline", nativeProbe.bridgeReady ? "ready" : "blocked", observedAt, { ...nativeFacts, bridgeReady: nativeProbe.bridgeReady }, [], nativeProbe.detail)
        : layer("nativeOnline", "unverified", observedAt, nativeFacts, ["native_probe"], "the app exists, but nothing observed its bridge from this process");

  // ---- projectSessionDispatchable ------------------------------------------
  // An unresolvable config is "unknown", never "no database": a broken .env must
  // not look like a fresh install, and it must not be repaired here.
  const configBroken = !config && Boolean(options.configError);
  if (configBroken) notes.push(`config: ${options.configError}`);
  const databasePath = config?.dbFile;
  const databaseExists = hasFile(databasePath);
  let capacityTable = false;
  let occupant: { taskId: string; executor: string; operationId: string } | null = null;
  let capacityReadable = false;
  let capacityReason: string | undefined;
  if (databaseExists && databasePath) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(databasePath, { readOnly: true });
      occupant = readCapacityOccupant(db);
      capacityTable = true; capacityReadable = true;
    } catch (error) {
      capacityReason = (error as Error)?.message === "resource_storage_missing:workflow_capacity"
        ? "the task store has no workflow_capacity table" : "the shared capacity slot could not be read";
    } finally { db?.close(); }
  }
  const sessions = countSessions(discovery?.config.value);
  const dispatchEnabled = env.WORKBUDDY_DESKTOP_DISPATCH_ENABLED === "1";
  const preflight = preflightReport({
    occupant,
    dispatchEnabled, databasePath: databasePath ?? "", capacityTable,
    workspace: path.basename(root), workspaceWritable: writable(root),
  });
  const sessionReadable = sessions.state === "known";
  const dispatchFacts: ReadinessLayer["facts"] = {
    databasePresent: databaseExists, capacityTable, capacityState: !databaseExists ? "unknown (database missing)" : capacityReadable ? (occupant ? `occupied by ${occupant.taskId}` : "free") : "unknown (unreadable)",
    occupantTask: occupant?.taskId ?? null, dispatchEnabled, sessions: sessionReadable ? (sessions.state === "known" ? sessions.count : 0) : "unreadable",
    preflightReady: preflight.ready, blockers: preflight.blockers.slice(0, 5).join(" | ") || null,
  };
  const dispatchMissing: string[] = [];
  const nativeUsable = nativeLayer.state === "ready" || nativeLayer.state === "unverified";
  if (!nativeUsable) dispatchMissing.push("native_online");
  if (configBroken) dispatchMissing.push("config");
  else if (!databaseExists) dispatchMissing.push("database");
  else if (!capacityTable) dispatchMissing.push("workflow_capacity");
  if (!sessionReadable) dispatchMissing.push("sessions");
  else if (sessions.state === "known" && sessions.count === 0) dispatchMissing.push("project_session");
  if (!dispatchEnabled) dispatchMissing.push("dispatch_enabled");
  const dispatchState: ReadinessState = !nativeUsable ? "unknown"
    : configBroken ? "unknown"
      : !databaseExists ? "absent"
        : !capacityTable || !capacityReadable ? "blocked"
          : occupant ? "blocked"
            : !sessionReadable ? "unknown"
              : sessions.state === "known" && sessions.count === 0 ? "blocked"
                : !dispatchEnabled ? "blocked"
                  : "ready";
  const dispatchReason = !nativeUsable ? "dispatching needs a usable desktop app; this layer cannot be observed without one"
    : configBroken ? options.configError
      : !databaseExists ? "no task database was found; no empty database was created"
    : !capacityReadable ? capacityReason
      : occupant ? `the shared capacity slot belongs to ${occupant.taskId}; unknown or occupied slots are never treated as free`
        : !sessionReadable ? (sessions as { reason: string }).reason
          : sessions.state === "known" && sessions.count === 0 ? "no project session is registered"
            : !dispatchEnabled ? "WORKBUDDY_DESKTOP_DISPATCH_ENABLED is not 1, so nothing may be dispatched" : undefined;
  const dispatchLayer = layer("projectSessionDispatchable", dispatchState, observedAt, dispatchFacts, dispatchMissing, dispatchReason);

  // ---- candidateDeployed --------------------------------------------------
  const installedCodeHash = codeHashOf(path.join(root, "dist"));
  const candidate = options.candidate;
  const deployedFacts: ReadinessLayer["facts"] = {
    runtimeSummary: summaryRead.found ? "present" : "missing",
    runtimeCodeHash: summaryRead.summary?.codeHash ?? null,
    installedCodeHash: short(installedCodeHash),
    candidateCodeHash: candidate?.codeHash ?? null,
    registration: registrationPresent(path.join(root, "data", "persistent-service.json")),
    diskPackageVersion: readDiskVersion(root) ?? null,
  };
  const deployedMissing: string[] = [];
  if (!summaryRead.found) deployedMissing.push("runtime_summary");
  else if (!summaryRead.summary?.codeHash) deployedMissing.push("runtime_code_hash");
  if (!installedCodeHash) deployedMissing.push("installed_dist");
  if (candidate && !candidate.codeHash) deployedMissing.push("candidate_code_hash");
  const comparable = Boolean(summaryRead.summary?.codeHash && installedCodeHash);
  const matches = comparable && summaryRead.summary!.codeHash === installedCodeHash;
  const candidateMatches = !candidate || (candidate.codeHash ? candidate.codeHash === installedCodeHash : true);
  const deployedState: ReadinessState = !summaryRead.found || !summaryRead.summary?.codeHash ? "unknown"
    : !installedCodeHash ? "unknown"
      : matches && candidateMatches ? "ready" : "blocked";
  const deployedReason = deployedState === "blocked"
    ? matches ? "the installed files are not the candidate that was requested" : "the running code and the files on disk differ"
    : deployedState === "unknown"
      ? summaryRead.found ? "the runtime summary carries no code hash; the disk version is not a substitute" : summaryRead.reason
      : undefined;
  const deployedLayer = layer("candidateDeployed", deployedState, observedAt, deployedFacts, deployedMissing, deployedReason);

  // ---- desktopPageReady ---------------------------------------------------
  let observation: DesktopWindowObservation | undefined = options.desktopObservation;
  if (!observation) {
    if (options.desktopObserver) try { observation = await options.desktopObserver(); } catch { observation = { reachable: false, reason: "the desktop observer failed" }; }
    else if (process.platform === "win32" && config) observation = await observeDesktopWindow(desktopWindowPaths(config, root).pipeName, options.timeoutMs ?? 2500);
    else notes.push("desktop window: not observed (no config was provided or the platform is not Windows)");
  }
  const snapshot = observation?.snapshot;
  const startup = snapshot?.startup && typeof snapshot.startup === "object" ? snapshot.startup as Record<string, unknown> : undefined;
  const page = typeof snapshot?.page === "string" ? snapshot.page : null;
  const pageReady = snapshot?.ready === true && page !== null && WORKBENCH_PAGE.test(page);
  const desktopFacts: ReadinessLayer["facts"] = {
    windowPresent: Boolean(observation?.reachable), ready: snapshot?.ready === true, page,
    startupStage: typeof snapshot?.startupStage === "string" ? snapshot.startupStage : null,
    failureCode: typeof snapshot?.failureCode === "string" ? snapshot.failureCode : null,
    startupOutcome: typeof startup?.outcome === "string" ? startup.outcome : null,
    awaitingStage: typeof startup?.awaitingStage === "string" ? startup.awaitingStage : null,
    awaitingMs: typeof startup?.awaitingMs === "number" ? startup.awaitingMs : null,
    awaitingBoundedMs: typeof startup?.awaitingBoundedMs === "number" ? startup.awaitingBoundedMs : null,
    windowPid: typeof snapshot?.pid === "number" ? snapshot.pid : null,
    gatewayPid: typeof snapshot?.gatewayPid === "number" ? snapshot.gatewayPid : null,
  };
  const desktopMissing: string[] = [];
  if (!observation) desktopMissing.push("desktop_observation");
  else if (!observation.reachable) desktopMissing.push("desktop_window");
  else if (!startup) desktopMissing.push("startup_diagnostics");
  else if (!pageReady) desktopMissing.push("navigation_completed");
  const desktopState: ReadinessState = !observation ? "unknown"
    : !observation.reachable ? "absent"
      : pageReady ? "ready"
        : "blocked";
  const desktopReason = desktopState === "unknown" ? "the desktop window was not observed from this process"
    : desktopState === "absent" ? observation?.reason
    : desktopState === "blocked"
      ? startup
        ? `the window has not reached a ready page yet (${String(startup.outcome ?? "unknown")}${typeof startup.awaitingStage === "string" ? ` while waiting on ${startup.awaitingStage}` : ""})`
        : "this shell build reports no startup diagnostics; rebuild the desktop app before reading startup stages"
      : undefined;
  const desktopLayer = layer("desktopPageReady", desktopState, observedAt, desktopFacts, desktopMissing, desktopReason);

  const layers = [toolLayer, nativeLayer, dispatchLayer, deployedLayer, desktopLayer];
  const nextAction = pickNextAction(layers, { dispatchState, deployedState, desktopState, toolLayer }, selectionReport(discovery, config, env, options.home ?? os.homedir()));
  return { schema: READINESS_SCHEMA, readOnly: true, observedAt, selection: selectionReport(discovery, config, env, options.home ?? os.homedir()), layers, nextAction, notes };
}

/** A registration that exists but does not validate is still "present but unreadable", never "absent". */
function registrationPresent(file: string): string {
  try { return readServiceRegistration(file) ? "present" : "absent"; }
  catch { return "unreadable"; }
}

function readDiskVersion(root: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch { return undefined; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function pickNextAction(layers: ReadinessLayer[], context: { dispatchState: ReadinessState; deployedState: ReadinessState; desktopState: ReadinessState; toolLayer: ReadinessLayer }, selection: SelectionReport): ReadinessReport["nextAction"] {
  // Nothing downstream can be trusted until one install is chosen, so this comes first.
  if (selection.state !== "resolved") return { layer: "selection", action: selection.state === "ambiguous"
    ? "这台机器上有多个 WorkBuddy 安装或数据目录：按 selection.candidates 选定一个，自己设置 WORKBUDDY_CONFIG_DIR / WORKBUDDY_CLI_ELECTRON 后重跑；诊断不会写入任何配置文件。"
    : "诊断没能唯一确定安装位置：设置 WORKBUDDY_CONFIG_DIR（数据目录）与 WORKBUDDY_CLI_ELECTRON（可执行文件）后重跑；诊断不会写入任何配置文件。" };
  const first = layers.find(item => item.state !== "ready");
  if (!first) return { layer: "dispatch", action: "五层都已就绪：可以在项目会话里展示执行器/来源/模型/推理档与价格，取得用户确认后再派工；本诊断不派工。" };
  switch (first.layer) {
    case "toolResponsive":
      return { layer: first.layer, action: first.state === "absent" ? "在这个安装根里先构建（npm ci && npm run build），再运行诊断。" : "从工具进程内部运行 readiness（npm run readiness -- --json）；独立进程只能给出 unknown。" };
    case "nativeOnline":
      return { layer: first.layer, action: "打开 WorkBuddy 桌面应用并完成首次连接；诊断不会启动应用、也不会安装原生桥。" };
    case "projectSessionDispatchable":
      return { layer: first.layer, action: dispatchAction(first) };
    case "candidateDeployed":
      return { layer: first.layer, action: context.deployedState === "blocked" ? "已装文件与运行摘要不一致：先重启常驻服务再核对；核对前不得声称候选已部署。" : "启动一次常驻服务以写入运行摘要（data/persistent-service-status.json）；不要用磁盘 package.json 版本代替运行版本。" };
    default:
      return { layer: first.layer, action: first.state === "absent" ? "启动桌面壳（WorkBuddy.Workbench.exe），窗口会自行拉起它的宿主。" : desktopAction(first) };
  }
}

function dispatchAction(item: ReadinessLayer): string {
  const blockers = String(item.facts.blockers ?? "");
  if (item.missing.includes("config")) return "配置无法解析（多个安装或数据目录）：显式设置 WORKBUDDY_CLI_ELECTRON 与 WORKBUDDY_CONFIG_DIR 后重跑；诊断不会改 .env 里的既有政策。";
  if (item.state === "absent") return "先设置 WORKBUDDY_DB_FILE 指向真实任务库；诊断不会创建空库。";
  if (blockers.includes("dispatch_not_enabled")) return "设置 WORKBUDDY_DESKTOP_DISPATCH_ENABLED=1 后重启工具；在此之前不派工。";
  if (item.facts.capacityTable === false) return "任务库里没有 workflow_capacity 表：按恢复整套备份处理，不要当作空闲、也不要先建表写元数据。";
  if (typeof item.facts.occupantTask === "string") return `共享容量仍被 ${item.facts.occupantTask} 占用：先按原身份核对它的停止证据；未证实时不释放、不换库、不换身份。`;
  return "在 WorkBuddy 中打开一个项目会话（非 playground）并保持可见，再重跑诊断。";
}

function desktopAction(item: ReadinessLayer): string {
  const code = String(item.facts.failureCode ?? "");
  if (code.startsWith("timeout:")) return `窗口卡在 ${String(item.facts.awaitingStage ?? code.slice(8))}（已等 ${String(item.facts.awaitingMs ?? "?")}ms，界 ${String(item.facts.awaitingBoundedMs ?? "?")}ms）：在窗口内点重试，并保留快照作为诊断证据。`;
  if (code.startsWith("interrupted:")) return `窗口里的 ${code.slice(12)} 这一步自己中断了（不是操作者关闭窗口）：重试一次并保留快照。`;
  if (code) return `窗口以 ${code} 失败：按 failureStage 修复后重试。`;
  return "窗口在跑但页面未就绪：读取快照的 awaitingStage 与 await*Ms 判断是在等环境还是等控制器。";
}

/** Human-readable single line per layer; never prints paths or private history. */
export function describeReadiness(report: ReadinessReport): string[] {
  return report.layers.map(item => `${item.state.padEnd(11)} ${item.layer.padEnd(26)} ${item.reason ?? ""}`.trimEnd());
}
