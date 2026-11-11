import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ReadinessProbes } from "./readiness.js";

/**
 * Probes that answer the first two readiness layers from *this* process:
 *
 * - `tool`: an MCP client starts the build in this install root, calls the
 *   read-only `workbuddy_health` tool and reports whether the tool answered.
 *   "Online" in that answer is not this layer's verdict; it is reported as the
 *   native observation so the caller can see both without conflating them.
 * - `native`: the same answer's bridge status. When a caller already holds a
 *   native trigger, pass `probeNative` instead of spawning a second process.
 *
 * Nothing here prepares a model, starts a desktop app, writes a file or mutates
 * a session: a probe that cannot answer is `responsive: false` with a reason,
 * never a silent "ready".
 */

export interface ToolProbeAnswer {
  responsive: boolean;
  detail?: string;
  native?: { bridgeReady: boolean; detail?: string };
}

export interface ProbeOptions {
  /** Gateway root that holds `dist/server.js`. Defaults to the parent of this module's directory. */
  gatewayRoot?: string;
  /** Module URL of the caller; used only to derive the default gateway root. */
  moduleUrl?: string;
  timeoutMs?: number;
  ttlMs?: number;
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

function healthPayload(result: unknown): { ok: boolean; online?: boolean; ready?: boolean; backend?: string } | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  const text = content?.find(item => item?.type === "text")?.text;
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { ok?: boolean; online?: boolean; ready?: boolean; backend?: string };
    return { ok: parsed.ok === true, online: parsed.online, ready: parsed.ready, backend: parsed.backend };
  } catch { return undefined; }
}

/** One MCP round trip against the build in `gatewayRoot`. Never retried, never cached here. */
export async function probeToolStdio(options: ProbeOptions = {}): Promise<ToolProbeAnswer> {
  const root = options.gatewayRoot ?? gatewayRootFrom(options.moduleUrl ?? import.meta.url);
  const server = path.join(root, "dist", "server.js");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = { ...getDefaultEnvironment(), ...(options.env ?? {}) } as Record<string, string>;
  // The probe must be identifiable in the tool process's own logs.
  env.WORKBUDDY_READINESS_PROBE = "1";
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: root, env, stderr: "pipe" });
  const client = new Client({ name: "workbuddy-readiness-probe", version: "1" }, { capabilities: {} });
  let answered = false;
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "workbuddy_health", arguments: {} }, undefined, { timeout: timeoutMs });
    const payload = healthPayload(result);
    answered = true;
    const detail = payload
      ? `workbuddy_health answered from this process (backend ${payload.backend ?? "unknown"}, online ${payload.online === true}, ready ${payload.ready === true})`
      : "workbuddy_health answered without a readable JSON body";
    return {
      responsive: payload ? payload.ok : true,
      detail: payload && !payload.ok ? `${detail}: the tool reported ok=false` : detail,
      native: { bridgeReady: payload?.online === true, detail: payload ? `bridge online=${payload.online === true} as reported by the tool process (pid ${process.pid})` : "the tool answer carried no bridge status" },
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
 * a caller can see it is at most `ttlMs` old.
 */
export function createReadinessProbes(options: ProbeOptions = {}): ReadinessProbes {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const clock = options.now ?? Date.now;
  const ask = options.probe ?? probeToolStdio;
  let tool: { at: number; answer: ToolProbeAnswer } | undefined;
  const run = async (): Promise<ToolProbeAnswer> => {
    const current = clock();
    if (tool && current - tool.at <= ttlMs) return { ...tool.answer, detail: tool.answer.detail ? `${tool.answer.detail} (cached ${current - tool.at}ms)` : undefined };
    const answer = await ask(options);
    tool = { at: clock(), answer };
    return answer;
  };
  return {
    tool: async () => { const answer = await run(); return { responsive: answer.responsive, detail: answer.detail }; },
    native: async () => {
      const answer = await run();
      return answer.native ?? { bridgeReady: false, detail: `${answer.detail ?? "the tool process answered"} — the answer carried no bridge status` };
    },
  };
}
