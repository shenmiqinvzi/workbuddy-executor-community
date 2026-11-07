import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Config } from "../src/config.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { runAutomationCli, type AutomationCliRuntime } from "../src/automation-cli.js";
import { TaskStore } from "../src/task-store.js";

const KEYS = ["WORKBUDDY_DB_FILE", "WORKBUDDY_RUNS_DIR", "WORKBUDDY_CLI_ELECTRON", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_BACKEND", "WORKBUDDY_DSH_ENABLED", "NO_PROXY"];

/** A transport that records the guarded dispatch instead of starting a desktop worker. */
class RecordingClient extends WorkBuddyClient {
  readonly sent: Array<{ content: string; workspace?: string; taskId?: string; attemptId?: string; sessionMode?: string }> = [];
  override async sendMessage(content: string, workspace?: string, _timeout?: number, _conversation?: string, options: { taskId?: string; attemptId?: string; sessionMode?: "existing" | "new" } = {}) {
    this.sent.push({ content, workspace, taskId: options.taskId, attemptId: options.attemptId, sessionMode: options.sessionMode });
    return { messageId: options.attemptId ?? "synthetic-message", raw: { data: { message_id: options.attemptId ?? "synthetic-message" } } as never };
  }
  override runSnapshot(): never { return { status: "working" } as never; }
  override cancel(): never { return true as never; }
}

interface CliEnv {
  root: string;
  workspace: string;
  runtime: AutomationCliRuntime;
  client: RecordingClient;
  probe: string;
}

function cliEnvironment(t: { after(fn: () => void): void }): CliEnv {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "automation-cli-dispatch-")));
  const workspace = path.join(root, "project");
  const runs = path.join(root, "runs");
  for (const directory of [workspace, runs, path.join(root, "state")]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "input.js"), "export const value = 1;\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Synthetic CLI", "-c", "user.email=cli@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, windowsHide: true, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "Synthetic CLI baseline");

  const native = new DatabaseSync(path.join(root, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES(?,?,0,NULL)").run("session", workspace);
  native.close();

  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) saved.set(key, process.env[key]);
  const values: Record<string, string> = {
    WORKBUDDY_DB_FILE: path.join(root, "state", "tasks.sqlite"),
    WORKBUDDY_RUNS_DIR: runs,
    WORKBUDDY_CLI_ELECTRON: path.join(root, "WorkBuddyAI.exe"),
    WORKBUDDY_CONFIG_DIR: root,
    WORKBUDDY_BACKEND: "desktop-queue",
    WORKBUDDY_DSH_ENABLED: "0",
    NO_PROXY: "127.0.0.1,localhost",
  };
  fs.writeFileSync(path.join(root, "WorkBuddyAI.exe"), "synthetic\n");
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  const observedAt = new Date().toISOString();
  const probe = path.join(root, "probe.json");
  fs.writeFileSync(probe, JSON.stringify({
    observedAt,
    executors: [{ executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", online: true, dispatchable: true, evidence: "synthetic-catalog", observedAt }],
    models: [{
      executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-user-choice",
      reasoningEfforts: [null], credits: "x0.00", remaining: 1000, unit: "credit", valueKind: "reported", freshness: "fresh",
      hardCap: "reported", catalogState: "available", observedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }],
  }, null, 2));

  const client = new RecordingClient({ backend: "desktop-queue", dbFile: values.WORKBUDDY_DB_FILE, workbuddyConfigDir: root } as Config);
  const registered = new TaskStore(values.WORKBUDDY_DB_FILE!);
  registered.collaboration.registerWorkspace("project", workspace, "Synthetic CLI project");
  registered.close();
  const runtime: AutomationCliRuntime = {
    client,
    resolveWorkspace: async () => ({ workspace, sessionId: "session" }),
    observeModel: async (_config, sessionId, model) => ({ sessionId, modelId: model, selectedModel: model, credits: null, observedAt: new Date().toISOString(), level: "selected" }),
  };

  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return { root, workspace, runtime, client, probe };
}

async function runCli(argv: string[], runtime: AutomationCliRuntime): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await runAutomationCli(argv, runtime);
  } finally {
    process.stdout.write = write;
    process.exitCode = 0;
  }
  return JSON.parse(lines.join("")) as Record<string, unknown>;
}

function contractFor(env: CliEnv, taskId: string): string {
  const file = path.join(env.root, `${taskId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: "workbuddy-executor/vnext-2",
    taskId,
    workspaceId: "project",
    title: "Automated synthetic task",
    objective: "Verify the saved automation policy path end to end",
    execution: { executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-user-choice", reasoningEffort: null },
    timeoutSeconds: 600,
    maxAttempts: 3,
    scope: { allowedChanges: ["src/**"], permittedMetadata: [] },
    requiredChecks: [],
    collaboration: { planId: "pending", expectedPlanRevision: "pending" },
  }, null, 2));
  return file;
}

test("a saved policy decision reaches the guarded dispatcher through the real CLI composition root", async (t) => {
  const env = cliEnvironment(t);
  const policy = await runCli([
    "policy-create", "--workspace", "project", "--executor", "workbuddy", "--connection", "local-workbuddy",
    "--provider", "workbuddy-native", "--model", "synthetic-user-choice", "--scope-allow", "src/**",
    "--max-tasks", "5", "--window-seconds", "3600", "--max-timeout", "1800", "--ttl-hours", "2",
    "--source", "user:synthetic-operator", "--actor", "synthetic-operator",
  ], env.runtime);
  assert.equal(policy.ok, true);
  const policyId = (policy as { policy: { policyId: string } }).policy.policyId;

  const decided = await runCli(["decide", "--contract", contractFor(env, "auto-cli-task"), "--policy-id", policyId, "--probe", env.probe, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(decided.ok, true);
  const decision = (decided as { decision: { decisionId: string; status: string; evaluation: { decision: string } } }).decision;
  assert.equal(decision.status, "pending", `expected a delegable decision, got ${JSON.stringify(decision.evaluation)}`);
  assert.equal(decision.evaluation.decision, "delegate");

  const operationId = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const unarmed = await runCli(["execute", decision.decisionId, "--operation-id", operationId, "--probe", env.probe, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(unarmed.ok, false);
  assert.equal(unarmed.code, "AUTOMATION_NOT_ARMED");
  assert.match(String(unarmed.message), /not armed/);

  const disabled = await runCli(["execute", decision.decisionId, "--operation-id", operationId, "--enable-dispatch", "--probe", env.probe, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, "AUTOMATION_NOT_ENABLED");
  assert.equal(env.client.sent.length, 0, "neither refusal reaches the transport");

  const enabled = await runCli(["enable", "--source", "user:synthetic-operator", "--actor", "synthetic-operator"], env.runtime);
  assert.equal(enabled.ok, true);
  assert.equal((enabled as { enabled: boolean }).enabled, true);

  const executed = await runCli(["execute", decision.decisionId, "--operation-id", operationId, "--enable-dispatch", "--probe", env.probe, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal(executed.replay, false);
  assert.equal(executed.status, "dispatched");
  assert.equal(env.client.sent.length, 1, "the guarded service reached the native transport exactly once");
  assert.equal(env.client.sent[0]!.taskId, "auto-cli-task");
  assert.match(env.client.sent[0]!.content, /auto-cli-task/);

  const replay = await runCli(["execute", decision.decisionId, "--operation-id", operationId, "--enable-dispatch", "--probe", env.probe, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(replay.replay, true);
  assert.equal(env.client.sent.length, 1, "a repeated operation never dispatches twice");

  const conflict = await runCli(["execute", decision.decisionId, "--operation-id", "11111111-2222-4333-8444-555555555555", "--enable-dispatch", "--probe", env.probe, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "OPERATION_CONFLICT");
  assert.equal(env.client.sent.length, 1);
});

test("a revoked policy blocks the next decision before any dispatch", async (t) => {
  const env = cliEnvironment(t);
  const policy = await runCli([
    "policy-create", "--workspace", "project", "--executor", "workbuddy", "--connection", "local-workbuddy",
    "--provider", "workbuddy-native", "--model", "synthetic-user-choice", "--scope-allow", "src/**",
    "--max-tasks", "5", "--window-seconds", "3600", "--max-timeout", "1800", "--ttl-hours", "2",
    "--source", "user:synthetic-operator", "--actor", "synthetic-operator",
  ], env.runtime);
  const created = (policy as { policy: { policyId: string; revision: string } }).policy;
  const revoked = await runCli(["policy-revoke", created.policyId, "--expected-revision", created.revision, "--reason", "synthetic revocation", "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(revoked.ok, true);

  const decided = await runCli(["decide", "--contract", contractFor(env, "auto-revoked-task"), "--policy-id", created.policyId, "--probe", env.probe, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(decided.ok, true);
  const decision = (decided as { decision: { status: string; blockedCode: string | null } }).decision;
  assert.equal(decision.status, "blocked");
  assert.ok(decision.blockedCode, "a blocked decision names its reason");
  const executed = await runCli(["execute", (decided as { decision: { decisionId: string } }).decision.decisionId, "--operation-id", "44444444-5555-4666-8777-888888888888", "--enable-dispatch", "--probe", env.probe, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(executed.ok, false);
  assert.equal(env.client.sent.length, 0, "a blocked decision never reaches the transport");
});

test("P1 a recorded snapshot without routing evidence cannot reach the shared dispatcher", async (t) => {
  const env = cliEnvironment(t);
  const observedAt = new Date().toISOString();
  const legacy = path.join(env.root, "legacy-observation.json");
  // The final5 shape: one row carries a catalog multiplier and a remaining number that came from a
  // shared token pool of another connection. No `rate`, no `balance`, no routing proof.
  fs.writeFileSync(legacy, JSON.stringify({
    observedAt,
    executors: [{ executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", online: true, dispatchable: true, evidence: "synthetic-catalog", observedAt }],
    models: [{
      executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-user-choice",
      reasoningEfforts: [null], credits: "x0.11", remaining: 1000, unit: "tokens", valueKind: "reported", freshness: "fresh",
      hardCap: "unsupported", catalogState: "available", observedAt, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }],
  }, null, 2));

  const policy = await runCli([
    "policy-create", "--workspace", "project", "--executor", "workbuddy", "--connection", "local-workbuddy",
    "--provider", "workbuddy-native", "--model", "synthetic-user-choice", "--scope-allow", "src/**",
    "--max-tasks", "5", "--window-seconds", "3600", "--max-timeout", "1800", "--ttl-hours", "2",
    "--cost-mode", "known_cost", "--cost-unit", "tokens", "--ceiling", "10",
    "--source", "user:synthetic-operator", "--actor", "synthetic-operator",
  ], env.runtime);
  assert.equal(policy.ok, true, JSON.stringify(policy));
  const policyId = (policy as { policy: { policyId: string } }).policy.policyId;

  const decided = await runCli(["decide", "--contract", contractFor(env, "legacy-snapshot-task"), "--policy-id", policyId, "--probe", legacy, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(decided.ok, true, JSON.stringify(decided));
  const decision = (decided as { decision: { decisionId: string; status: string; evaluation: { decision: string; blocks: Array<{ code: string; field: string }>; cost: { remaining: number | null } } } }).decision;
  assert.equal(decision.status, "blocked");
  assert.equal(decision.evaluation.decision, "wait");
  assert.ok(decision.evaluation.blocks.some((block) => block.field === "cost.routing"), JSON.stringify(decision.evaluation.blocks));
  assert.equal(decision.evaluation.cost.remaining, 1000, "the recorded number is still shown");

  const enabled = await runCli(["enable", "--source", "user:synthetic-operator", "--actor", "synthetic-operator"], env.runtime);
  assert.equal(enabled.ok, true);
  const executed = await runCli(["execute", decision.decisionId, "--operation-id", "99999999-8888-4777-8666-555555555555", "--enable-dispatch", "--probe", legacy, "--source", "user:synthetic-operator"], env.runtime);
  assert.equal(executed.ok, false);
  assert.equal(executed.code, "COST_CONTROL_UNAVAILABLE");
  assert.equal(env.client.sent.length, 0, "a refused cost decision never reaches the shared dispatcher");
});
