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

function healthPayload(result: unknown): { ok: boolean; online?: boolean; ready?: boolean; backend?: string; observer?: { pid?: number; dataRoot?: string; codeHash?: string } } | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = content?.find(item => item?.type === "text")?.text;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { ok?: boolean; online?: boolean; ready?: boolean; backend?: string; observer?: { pid?: number; dataRoot?: string; codeHash?: string } };
    return { ok: parsed.ok === true, online: parsed.online, ready: parsed.ready, backend: parsed.backend, observer: parsed.observer };
  } catch { return undefined; }
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
    const payload = healthPayload(result);
    answered = true;
    const identity = payload?.observer ? { pid: payload.observer.pid, dataRoot: payload.observer.dataRoot, codeHash: payload.observer.codeHash } : undefined;
    const who = identity?.pid ? `pid ${identity.pid}` : "an unidentified process";
    const where = identity?.dataRoot ? `dataRoot ${identity.dataRoot}` : "no reported dataRoot";
    const detail = payload
      ? `workbuddy_health answered from ${who} (backend ${payload.backend ?? "unknown"}, ${where}, online ${payload.online === true}, ready ${payload.ready === true})`
      : "workbuddy_health answered without a readable JSON body";
    return {
      responsive: payload ? payload.ok : true,
      detail: payload && !payload.ok ? `${detail}: the tool reported ok=false` : detail,
      native: { bridgeReady: payload?.online === true, detail: payload ? `bridge online=${payload.online === true} as reported by ${who}` : "the tool answer carried no bridge status" },
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
