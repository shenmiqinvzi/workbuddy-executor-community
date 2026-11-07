import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../../src/task-store.js";
import { TaskCoordinator } from "../../src/coordinator.js";
import { TaskApplicationService } from "../../src/task-application-service.js";
import { DesktopQueue } from "../../src/desktop-queue.js";
import { SelectedModelClient } from "./selected-model-client.js";
import type { Config } from "../../src/config.js";
import {
  AutomationService,
  type AutomationPolicyInput,
  type AutomationPolicyRecord,
  type AutomationProbeResult,
  type AutomationServiceOptions,
} from "../../src/automation.js";

/**
 * Synthetic automation fixture: a real TaskStore/DatabaseSync, a real DesktopQueue, real Git and a
 * synthetic catalog. No network, no real account and no native desktop process.
 *
 * The clock is mutable so expiry, stale-observation and window boundaries are tested without
 * sleeping. Every dispatch still goes through the same guarded TaskApplicationService a manual
 * dispatch uses.
 */
export interface AutomationFixture {
  root: string;
  workspace: string;
  otherWorkspace: string;
  config: Config;
  clock: { now: number };
  store: TaskStore;
  service: TaskApplicationService;
  queue: DesktopQueue;
  execution: { executorId: "workbuddy"; connectionId: string; providerId: string; modelId: string; reasoningEffort: string | null };
  probe(overrides?: Partial<AutomationProbeResult> & { model?: Record<string, unknown>; executor?: Record<string, unknown> }): AutomationProbeResult;
  proposal(taskId?: string, overrides?: { execution?: unknown; scope?: unknown; timeoutSeconds?: number; maxAttempts?: number; workspaceId?: string }): Record<string, unknown>;
  automation(options?: AutomationServiceOptions): AutomationService;
  armed(options?: { send?: AutomationServiceOptions["send"]; probe?: AutomationServiceOptions["probe"] }): AutomationService;
  policy(overrides?: Partial<AutomationPolicyInput>, context?: { actor: string; source: string }): AutomationPolicyRecord;
  savePolicy(service: AutomationService, overrides?: Partial<AutomationPolicyInput>): AutomationPolicyRecord;
  raw(sql: string, ...params: unknown[]): void;
  row<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  close(): void;
}

/** A transport that fails inside the native send, after the dispatch intent is durable. */
class FailingSendClient extends SelectedModelClient {
  override async sendMessage(..._args: Parameters<SelectedModelClient["sendMessage"]>): Promise<never> {
    throw Object.assign(new Error("synthetic native transport failure"), { code: "ERESET" });
  }
}

export function automationFixture(t: { after(fn: () => void): void }, options: { failNativeSend?: boolean } = {}): AutomationFixture {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t7-automation-")));
  const workspace = path.join(root, "project"), otherWorkspace = path.join(root, "other"), runs = path.join(root, "runs");
  for (const directory of [workspace, otherWorkspace, runs]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(workspace, "src"));
  const source = path.join(workspace, "src", "input.js");
  fs.writeFileSync(source, "export const value = 1;\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Synthetic Automation", "-c", "user.email=automation@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, windowsHide: true, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "Synthetic automation baseline");
  const config: Config = {
    backend: "desktop-queue", dbFile: path.join(root, "state", "tasks.sqlite"), runsDir: runs, workbuddyConfigDir: root,
    apiBaseUrl: "https://synthetic.invalid", tokenFile: path.join(root, "unused.json"), oauthRedirectUri: "http://127.0.0.1", oauthPort: 8787,
    oauthScopes: "", requestTimeoutMs: 1000, cliElectronPath: process.execPath, cliScriptPath: "unused", cliPermissionMode: "deny",
    acpPermissionMode: "deny", gatewayUrl: "http://127.0.0.1:1",
  };
  const native = new DatabaseSync(path.join(root, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES(?,?,0,NULL)").run("session", workspace);
  native.close();

  const store = new TaskStore(config.dbFile);
  const clock = { now: Date.now() };
  const client = options.failNativeSend ? new FailingSendClient(config) : new SelectedModelClient(config);
  const coordinator = new TaskCoordinator(
    config, store, client,
    async (_config, input) => ({ workspace: input.workspace ?? workspace, sessionId: "session" }),
    async (_config, sessionId, model) => ({ sessionId, modelId: model, selectedModel: model, credits: null, observedAt: new Date().toISOString(), level: "selected" }),
  );
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  const service = new TaskApplicationService(coordinator, 3, runs);
  store.collaboration.registerWorkspace("project", workspace, "Synthetic automation project");
  store.collaboration.registerWorkspace("other", otherWorkspace, "Synthetic unrelated project");

  const execution = { executorId: "workbuddy" as const, connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-user-choice", reasoningEffort: null };
  const at = () => new Date(clock.now).toISOString();

  /**
   * The current probe states a rate and a balance explicitly, including the routing that ties the
   * number to one executor/connection/model. Fixtures that want a legacy observation (a `valueKind`
   * with no routing proof) must omit `rate`/`balance` themselves.
   */
  function withCostEvidence(model: Record<string, unknown>): Record<string, unknown> {
    const rate = model.rate === undefined
      ? { kind: typeof model.credits === "string" ? "reported" : "unavailable", value: typeof model.credits === "string" ? model.credits : null }
      : model.rate;
    const remaining = typeof model.remaining === "number" ? model.remaining : null;
    const unit = (model.unit as "credit" | "tokens" | undefined) ?? "credit";
    const kind = model.valueKind === "reported" ? "reported" : model.valueKind === "estimated" ? "estimated" : "unavailable";
    const balance = model.balance === undefined
      ? (remaining !== null
        ? { kind, unit, remaining, routing: kind === "reported" ? "verified" : "unverified", source: kind === "reported" ? "probe" : "quota:shared-pool" }
        : { kind: "unavailable", unit, remaining: null, routing: "unverified", source: null })
      : model.balance;
    return { ...model, rate, balance };
  }

  function probe(overrides: Partial<AutomationProbeResult> & { model?: Record<string, unknown>; executor?: Record<string, unknown> } = {}): AutomationProbeResult {
    const observedAt = at();
    return {
      observedAt: overrides.observedAt ?? observedAt,
      executors: overrides.executors ?? [{
        executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native",
        online: true, dispatchable: true, evidence: "synthetic-catalog", observedAt,
        ...(overrides.executor ?? {}),
      }] as AutomationProbeResult["executors"],
      models: overrides.models ?? [withCostEvidence({
        executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-user-choice",
        reasoningEfforts: [null], credits: "x0.00", remaining: 1000, unit: "credit", valueKind: "reported", freshness: "fresh",
        hardCap: "reported", catalogState: "available", observedAt, expiresAt: new Date(clock.now + 3_600_000).toISOString(),
        ...(overrides.model ?? {}),
      })] as AutomationProbeResult["models"],
    };
  }

  function proposal(taskId = "auto-task", overrides: { execution?: unknown; scope?: unknown; timeoutSeconds?: number; maxAttempts?: number; workspaceId?: string } = {}) {
    return {
      schemaVersion: "workbuddy-executor/vnext-2",
      taskId,
      workspaceId: overrides.workspaceId ?? "project",
      title: "Automated synthetic task",
      objective: "Verify the saved automation policy path end to end",
      execution: overrides.execution ?? execution,
      timeoutSeconds: overrides.timeoutSeconds ?? 600,
      maxAttempts: overrides.maxAttempts ?? 3,
      scope: overrides.scope ?? { allowedChanges: ["src/**"], permittedMetadata: [] },
      requiredChecks: [],
      collaboration: { planId: "pending", expectedPlanRevision: "pending" },
    };
  }

  const context = { actor: "synthetic-operator", source: "user:synthetic-operator" };

  function savePolicy(target: AutomationService, overrides: Partial<AutomationPolicyInput> = {}): AutomationPolicyRecord {
    const input: AutomationPolicyInput = {
      workspaceId: "project",
      executor: execution,
      scope: { allowedChanges: ["src/**"], permittedMetadata: [] },
      maxTasksPerWindow: 1,
      windowSeconds: 3600,
      maxTimeoutSeconds: 1800,
      maxAttempts: 3,
      cost: { mode: "free_only", unit: "credit", ceiling: null, requiresHardCap: false },
      expiresAt: new Date(clock.now + 86_400_000).toISOString(),
      ...overrides,
    };
    return target.createPolicy(input, context);
  }

  const fixture: AutomationFixture = {
    root, workspace, otherWorkspace, config, clock, store, service, queue, execution,
    probe, proposal,
    automation: (options2 = {}) => new AutomationService(store, { now: () => new Date(clock.now), ...options2 }),
    armed: (options2 = {}) => new AutomationService(store, {
      now: () => new Date(clock.now), armed: true,
      send: options2.send ?? ((input) => service.send(input)),
      probe: options2.probe ?? (() => probe()),
    }),
    policy: (overrides = {}, ctx = context) => {
      const target = new AutomationService(store);
      return target.createPolicy({
        workspaceId: "project", executor: execution, scope: { allowedChanges: ["src/**"], permittedMetadata: [] },
        maxTasksPerWindow: 1, windowSeconds: 3600, maxTimeoutSeconds: 1800, maxAttempts: 3,
        cost: { mode: "free_only", unit: "credit", ceiling: null, requiresHardCap: false },
        expiresAt: new Date(clock.now + 86_400_000).toISOString(), ...overrides,
      }, ctx);
    },
    savePolicy,
    raw: (sql, ...params) => { store.database.prepare(sql).run(...(params as never[])); },
    row: (sql, ...params) => store.database.prepare(sql).get(...(params as never[])) as never,
    close: () => store.close(),
  };
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return fixture;
}

/** A snapshot the CLI/HTTP path may read; kept here so both suites share one shape. */
export function readOnlyProbe(fixture: AutomationFixture): AutomationProbeResult {
  return fixture.probe();
}

export const sourcePath = (fixture: AutomationFixture) => path.join(fixture.workspace, "src", "input.js");
