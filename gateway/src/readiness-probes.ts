import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "./config.js";
import type { ReadinessProbes } from "./readiness.js";

/**
 * Probes that answer the first two readiness layers from *this* process:
 *
 * - `tool`: an MCP client starts the read-only health entry in this install root,
 *   calls `workbuddy_health` and reports whether the tool answered. That entry
 *   builds no TaskStore, so asking for readiness never creates a database, runs
 *   a migration or reclaims a worker.
 * - `native`: the same answer's bridge status, reported by the answering process.
 *
 * The child is given the caller's *resolved* configuration (backend, task
 * database, runs, native config root, service registration, gateway URL) instead
 * of inheriting the parent shell: otherwise a probe could silently inspect another
 * installation and its healthy answer would be attributed to this one. The answer
 * carries the child's own pid/dataRoot/codeHash so the caller can compare, and a
 * mismatch blocks the layer instead of proving it.
 */

export interface ProbeAnswerIdentity {
  pid?: number;
  dataRoot?: string;
  /** Absolute path of the task database the answering process was configured with. */
  dbFile?: string;
  codeHash?: string;
}

export interface ToolProbeAnswer {
  responsive: boolean;
  detail?: string;
  native?: { bridgeReady: boolean; detail?: string };
  /** Identity of the process that actually answered. */
  identity?: ProbeAnswerIdentity;
}

/** The subset of a resolved configuration that defines *which* instance a probe inspects. */
export type ProbeConfig = Pick<Config, "backend" | "dbFile" | "serviceConfigFile" | "workbuddyConfigDir" | "gatewayUrl"> & {
  runsDir?: string;
  cliElectronPath?: string;
};

export interface ProbeOptions {
  /** Gateway root that holds `dist/health-entry.js`. Defaults to the parent of this module's directory. */
  gatewayRoot?: string;
  /** Module URL of the caller; used only to derive the default gateway root. */
  moduleUrl?: string;
  /** Resolved configuration of the instance under observation. */
  config?: ProbeConfig;
  timeoutMs?: number;
  ttlMs?: number;
  /**
   * Extra variables for the child. The resolved `config` still wins for every
   * variable it defines: a shell variable must never be able to redirect the
   * diagnosis to another instance than the one the caller selected.
   */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seam: replace the MCP round trip without changing caching or error semantics. */
  probe?: (options: ProbeOptions) => Promise<ToolProbeAnswer>;
}

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_TTL_MS = 5000;

export function gatewayRootFrom(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
}

/**
 * Environment for the probe child: the SDK's portable base plus exactly the
 * variables that name the instance. The resolved config is applied last, so no
 * inherited shell value can point the child at a different installation; `env`
 * only supplies variables the config does not define.
 */
export function probeEnvironment(options: Pick<ProbeOptions, "config" | "env">): Record<string, string> {
  const env = { ...getDefaultEnvironment(), ...(options.env ?? {}) } as Record<string, string>;
  const config = options.config;
  if (config) {
    env.WORKBUDDY_BACKEND = config.backend;
    env.WORKBUDDY_DB_FILE = path.resolve(config.dbFile);
    if (config.runsDir) env.WORKBUDDY_RUNS_DIR = path.resolve(config.runsDir);
    if (config.serviceConfigFile) env.WORKBUDDY_SERVICE_CONFIG = path.resolve(config.serviceConfigFile);
    if (config.workbuddyConfigDir) env.WORKBUDDY_CONFIG_DIR = path.resolve(config.workbuddyConfigDir);
    if (config.gatewayUrl) env.WORKBUDDY_GATEWAY_URL = config.gatewayUrl;
    if (config.cliElectronPath) env.WORKBUDDY_CLI_ELECTRON = config.cliElectronPath;
  }
  // The probe must be identifiable in the tool process's own logs.
  env.WORKBUDDY_READINESS_PROBE = "1";
  return env;
}

interface HealthBody {
  ok: boolean;
  online?: boolean;
  ready?: boolean;
  backend?: string;
  observer?: ProbeAnswerIdentity;
}

/**
 * Read one `workbuddy_health` answer.
 *
 * Only a tool result that reports no error, carries text, and carries *JSON
 * text shaped as an object* is an answer. Everything else — an `isError`
 * result, an empty body, a truncated or non-JSON body, a bare array — is
 * unreadable, and an unreadable answer proves nothing about this installation.
 * Treating "no payload" as responsive was the defect: the layer said ready
 * while the probe had understood nothing.
 */
function healthAnswer(result: unknown): { body?: HealthBody; problem?: string } {
  if ((result as { isError?: boolean } | undefined)?.isError === true) return { problem: "the tool call reported an error result" };
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  const text = content?.find(item => item?.type === "text")?.text;
  if (typeof text !== "string" || !text.trim()) return { problem: "the answer carried no text content" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { problem: "the answer was not JSON" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "the answer was not a JSON object" };
  const value = parsed as Record<string, unknown>;
  const observer = value.observer && typeof value.observer === "object" ? value.observer as ProbeAnswerIdentity : undefined;
  return { body: { ok: value.ok === true, online: value.online === true ? true : value.online === false ? false : undefined, ready: value.ready === true ? true : value.ready === false ? false : undefined, backend: typeof value.backend === "string" ? value.backend : undefined, observer } };
}

/** One MCP round trip against the read-only health entry in `gatewayRoot`. Never retried, never cached here. */
export async function probeToolStdio(options: ProbeOptions = {}): Promise<ToolProbeAnswer> {
  const root = options.gatewayRoot ?? gatewayRootFrom(options.moduleUrl ?? import.meta.url);
  const entry = path.join(root, "dist", "health-entry.js");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = probeEnvironment(options);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd: root, env, stderr: "pipe" });
  const client = new Client({ name: "workbuddy-readiness-probe", version: "1" }, { capabilities: {} });
  let answered = false;
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "workbuddy_health", arguments: {} }, undefined, { timeout: timeoutMs });
    const answer = healthAnswer(result);
    answered = true;
    const body = answer.body;
    const identity = body?.observer
      ? { pid: body.observer.pid, dataRoot: body.observer.dataRoot, dbFile: body.observer.dbFile, codeHash: body.observer.codeHash }
      : undefined;
    if (!body) {
      return {
        responsive: false,
        detail: `workbuddy_health answered, but ${answer.problem}; an answer that cannot be read cannot prove this installation is ready`,
        native: { bridgeReady: false, detail: `the answer was unreadable (${answer.problem}), so it carries no bridge status` },
        identity: undefined,
      };
    }
    const who = identity?.pid ? `pid ${identity.pid}` : "an unidentified process";
    const where = identity?.dbFile ? `dbFile ${identity.dbFile}` : identity?.dataRoot ? `dataRoot ${identity.dataRoot}` : "no reported dataRoot or dbFile";
    const detail = `workbuddy_health answered from ${who} (backend ${body.backend ?? "unknown"}, ${where}, online ${body.online === true}, ready ${body.ready === true})`;
    // A read-only entry that does not name its database cannot be distinguished
    // from a healthy instance somewhere else; "responsive" alone would upgrade
    // this installation on another installation's answer.
    if (!identity?.dataRoot || !identity?.dbFile) {
      return {
        responsive: false,
        detail: `${detail}: the answer did not name the database it answered for, so it cannot be tied to this installation`,
        native: { bridgeReady: body.online === true, detail: `bridge online=${body.online === true}, but the answering process named no database` },
        identity,
      };
    }
    return {
      responsive: body.ok,
      detail: body.ok ? detail : `${detail}: the tool reported ok=false`,
      native: { bridgeReady: body.online === true, detail: `bridge online=${body.online === true} as reported by ${who}` },
      identity,
    };
  } catch (error) {
    return { responsive: false, detail: `${answered ? "the tool call failed" : "the tool process did not answer"}: ${(error as Error)?.message ?? String(error)}` };
  } finally {
    // Closing is part of the probe: a leaked child would outlive the answer.
    await client.close().catch(() => undefined);
  }
}

/**
 * Memoized probes for a long-lived host: the desktop shell asks for readiness on
 * every GET, and spawning a tool process per request would make the diagnosis
 * itself a load source. A cached answer is stamped with the time it was taken so
 * a caller can see it is at most `ttlMs` old, and concurrent callers share one
 * in-flight probe instead of racing several children against the same database.
 */
export function createReadinessProbes(options: ProbeOptions = {}): ReadinessProbes {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const clock = options.now ?? Date.now;
  const ask = options.probe ?? probeToolStdio;
  let tool: { at: number; answer: ToolProbeAnswer } | undefined;
  let inFlight: Promise<ToolProbeAnswer> | undefined;
  const run = async (): Promise<ToolProbeAnswer> => {
    const current = clock();
    if (tool && current - tool.at <= ttlMs) return { ...tool.answer, detail: tool.answer.detail ? `${tool.answer.detail} (cached ${current - tool.at}ms)` : undefined };
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const answer = await ask(options);
        tool = { at: clock(), answer };
        return answer;
      } finally { inFlight = undefined; }
    })();
    return inFlight;
  };
  return {
    tool: async () => { const answer = await run(); return { responsive: answer.responsive, detail: answer.detail }; },
    native: async () => {
      const answer = await run();
      return answer.native ?? { bridgeReady: false, detail: `${answer.detail ?? "the tool process answered"} — the answer carried no bridge status` };
    },
    identity: async () => (await run()).identity,
  };
}
