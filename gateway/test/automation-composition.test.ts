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
import { defaultModelPolicy } from "../src/collaboration.js";
import type { DesktopCatalogSource } from "../src/desktop-dispatch.js";

/**
 * D02 + D04 + D05: the whole chain through the real CLI composition root.
 *
 * Nothing here is injected as a saved observation: the service builds the read-only probe itself,
 * the only substituted surface is the catalog reader (a reader seam, not a recorded snapshot), and
 * the decision is then carried by the same guarded `TaskApplicationService.send` a manual task uses.
 */
const KEYS = ["WORKBUDDY_DB_FILE", "WORKBUDDY_RUNS_DIR", "WORKBUDDY_CLI_ELECTRON", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_BACKEND", "WORKBUDDY_DSH_ENABLED", "NO_PROXY"];
const EXECUTION = { executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: "synthetic-user-choice", reasoningEffort: null } as const;

class RecordingClient extends WorkBuddyClient {
  readonly sent: Array<{ content: string; taskId?: string; attemptId?: string }> = [];
  override async sendMessage(content: string, _workspace?: string, _timeout?: number, _conversation?: string, options: { taskId?: string; attemptId?: string; sessionMode?: "existing" | "new" } = {}) {
    this.sent.push({ content, taskId: options.taskId, attemptId: options.attemptId });
    return { messageId: options.attemptId ?? "synthetic-message", raw: { data: { message_id: options.attemptId ?? "synthetic-message" } } as never };
  }
  override runSnapshot(): never { return { status: "working" } as never; }
  override cancel(): never { return true as never; }
}

interface CompositionEnv {
  root: string;
  workspace: string;
  dbFile: string;
  runtime: AutomationCliRuntime;
  client: RecordingClient;
  setCredits(value: string | null, verified: boolean): void;
}

function compositionEnvironment(t: { after(fn: () => void): void }): CompositionEnv {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "automation-composition-")));
  const workspace = path.join(root, "project");
  const runs = path.join(root, "runs");
  for (const directory of [workspace, runs, path.join(root, "state")]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "input.js"), "export const value = 1;\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Synthetic Composition", "-c", "user.email=composition@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, windowsHide: true, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "Synthetic composition baseline");

  const native = new DatabaseSync(path.join(root, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES(?,?,0,NULL)").run("session", workspace);
  native.close();

  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) saved.set(key, process.env[key]);
  const dbFile = path.join(root, "state", "tasks.sqlite");
  const values: Record<string, string> = {
    WORKBUDDY_DB_FILE: dbFile,
    WORKBUDDY_RUNS_DIR: runs,
    WORKBUDDY_CLI_ELECTRON: path.join(root, "WorkBuddyAI.exe"),
    WORKBUDDY_CONFIG_DIR: root,
    WORKBUDDY_BACKEND: "desktop-queue",
    WORKBUDDY_DSH_ENABLED: "0",
    NO_PROXY: "127.0.0.1,localhost",
  };
  fs.writeFileSync(path.join(root, "WorkBuddyAI.exe"), "synthetic\n");
  for (const [key, value] of Object.entries(values)) process.env[key] = value;

  const client = new RecordingClient({ backend: "desktop-queue", dbFile, workbuddyConfigDir: root } as Config);
  const registered = new TaskStore(dbFile);
  registered.collaboration.registerWorkspace("project", workspace, "Synthetic composition project");
  registered.close();

  // Only the catalog reader is substituted: the probe itself is the production read-only adapter.
  const catalogState = { credits: "x0.00" as string | null, pricingVerified: true };
  const catalog = (): DesktopCatalogSource => ({
    models: [{ execution: { ...EXECUTION }, credits: catalogState.credits, pricingVerified: catalogState.pricingVerified }],
    sessions: [],
    policy: defaultModelPolicy(3),
    requiredFreeModel: null,
    dispatchEnabled: true,
    errors: [],
  });

  const runtime: AutomationCliRuntime = {
    client,
    catalog,
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
  return { root, workspace, dbFile, runtime, client, setCredits: (credits, verified) => { catalogState.credits = credits; catalogState.pricingVerified = verified; } };
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

function contractFor(env: CompositionEnv, taskId: string): string {
  const file = path.join(env.root, `${taskId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: "workbuddy-executor/vnext-2",
    taskId,
    workspaceId: "project",
    title: "Automated synthetic task",
    objective: "Verify the saved automation policy path through the real composition root",
    execution: EXECUTION,
    timeoutSeconds: 600,
    maxAttempts: 3,
    scope: { allowedChanges: ["src/**"], permittedMetadata: [] },
    requiredChecks: [],
    collaboration: { planId: "pending", expectedPlanRevision: "pending" },
  }, null, 2));
  return file;
}

const SOURCE = ["--source", "user:synthetic-operator", "--actor", "synthetic-operator"];

async function createPolicy(env: CompositionEnv, maxTasks: number): Promise<{ policyId: string; revision: string }> {
  const created = await runCli([
    "policy-create", "--workspace", "project", "--executor", "workbuddy", "--connection", "local-workbuddy",
    "--provider", "workbuddy-native", "--model", "synthetic-user-choice", "--scope-allow", "src/**",
    "--max-tasks", String(maxTasks), "--window-seconds", "3600", "--max-timeout", "1800", "--ttl-hours", "2",
    ...SOURCE,
  ], env.runtime);
  assert.equal(created.ok, true, JSON.stringify(created));
  return (created as { policy: { policyId: string; revision: string } }).policy;
}

test("the real read-only probe carries a decision through to one guarded dispatch", async (t) => {
  const env = compositionEnvironment(t);
  const policy = await createPolicy(env, 5);

  const status = await runCli(["status", ...SOURCE], env.runtime);
  assert.equal(status.ok, true);
  assert.equal(status.probeKind, "read_only_local", "the CLI wires the read-only adapter, not a snapshot file");
  const layers = status.layers as Record<string, { layer: string; writeEntry?: string; httpWrites?: boolean }>;
  assert.deepEqual(Object.values(layers).map((entry) => entry.layer), [
    "installation_enabled", "process_armed", "policy_authorization", "per_task_selection", "recorded_decision", "actual_dispatch",
  ]);
  assert.equal(layers.authorization?.writeEntry, "local_cli_only");
  assert.equal(layers.authorization?.httpWrites, false);

  const decided = await runCli(["decide", "--contract", contractFor(env, "auto-composition-task"), "--policy-id", policy.policyId, ...SOURCE], env.runtime);
  assert.equal(decided.ok, true, JSON.stringify(decided));
  const decision = (decided as { decision: { decisionId: string; status: string; evaluation: { decision: string; blocks: unknown[]; probe: { coverage: { catalog: string; costEvidence: string }; sources: Array<{ source: string; status: string }> } } } }).decision;
  assert.equal(decision.status, "pending", `expected a delegable decision, got ${JSON.stringify(decision.evaluation.blocks)}`);
  assert.equal(decision.evaluation.decision, "delegate");
  assert.equal(decision.evaluation.probe.coverage.catalog, "observed");
  assert.equal(decision.evaluation.probe.coverage.costEvidence, "executor_catalog");

  const enabled = await runCli(["enable", ...SOURCE], env.runtime);
  assert.equal(enabled.ok, true);

  const operationId = "0b1e2d3c-4b5a-4968-8776-655443322110";
  const executed = await runCli(["execute", decision.decisionId, "--operation-id", operationId, "--enable-dispatch", ...SOURCE], env.runtime);
  assert.equal(executed.ok, true, JSON.stringify(executed));
  assert.equal(executed.status, "dispatched");
  assert.equal(env.client.sent.length, 1);
  assert.equal(env.client.sent[0]!.taskId, "auto-composition-task");

  // The audit answers who authorized through which entry and which observation was used.
  const audit = await runCli(["audit", "--limit", "30", ...SOURCE], env.runtime);
  const rows = audit.audit as Array<{ action: string; source: string; detail: Record<string, unknown> }>;
  const dispatched = rows.find((row) => row.action === "decision_dispatched");
  assert.ok(dispatched, JSON.stringify(rows.map((row) => row.action)));
  assert.equal(dispatched!.source, `automation:${policy.policyId}`);
  assert.equal(dispatched!.detail.requestedBy, "synthetic-operator");
  const intent = rows.find((row) => row.action === "decision_dispatch_intent");
  assert.ok(intent, "the intent is recorded before the transport is touched");
  const pending = rows.find((row) => row.action === "decision_pending");
  const probe = pending!.detail.probe as { sources: string[]; observedAt: string } | undefined;
  assert.ok(probe, "the decision records which observation it was decided on");
  assert.ok(probe!.sources.some((entry) => entry.startsWith("catalog:")), JSON.stringify(probe));
});

test("an unverified catalog price blocks the decision before any dispatch", async (t) => {
  const env = compositionEnvironment(t);
  const policy = await createPolicy(env, 5);
  env.setCredits(null, false);

  const decided = await runCli(["decide", "--contract", contractFor(env, "auto-unverified-task"), "--policy-id", policy.policyId, ...SOURCE], env.runtime);
  const decision = (decided as { decision: { status: string; blocks: Array<{ code: string }>; evaluation: { blocks: Array<{ code: string }> } } }).decision;
  assert.equal(decision.status, "blocked");
  const codes = (decision.blocks ?? decision.evaluation.blocks).map((block) => block.code);
  assert.ok(codes.includes("QUOTA_UNAVAILABLE"), JSON.stringify(codes));

  const enabled = await runCli(["enable", ...SOURCE], env.runtime);
  assert.equal(enabled.ok, true);
  const executed = await runCli(["execute", (decided as { decision: { decisionId: string } }).decision.decisionId, "--operation-id", "1b1e2d3c-4b5a-4968-8776-655443322110", "--enable-dispatch", ...SOURCE], env.runtime);
  assert.equal(executed.ok, false, "a blocked decision never dispatches");
  assert.equal(env.client.sent.length, 0);
});

test("the window budget survives a restart and a new operation key does not buy another task", async (t) => {
  const env = compositionEnvironment(t);
  const policy = await createPolicy(env, 1);
  await runCli(["enable", ...SOURCE], env.runtime);

  const first = await runCli(["decide", "--contract", contractFor(env, "auto-budget-a"), "--policy-id", policy.policyId, ...SOURCE], env.runtime);
  const firstDecision = (first as { decision: { decisionId: string; status: string } }).decision;
  assert.equal(firstDecision.status, "pending", JSON.stringify(first));
  const dispatched = await runCli(["execute", firstDecision.decisionId, "--operation-id", "2b1e2d3c-4b5a-4968-8776-655443322110", "--enable-dispatch", ...SOURCE], env.runtime);
  assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
  assert.equal(env.client.sent.length, 1);

  // Every CLI invocation is a fresh process against the same database: this is the restart.
  const second = await runCli(["decide", "--contract", contractFor(env, "auto-budget-b"), "--policy-id", policy.policyId, ...SOURCE], env.runtime);
  const secondDecision = (second as { decision: { status: string; evaluation: { blocks: Array<{ code: string; field: string }>; rounds: { used: number; limit: number } } } }).decision;
  assert.equal(secondDecision.status, "blocked");
  assert.ok(
    secondDecision.evaluation.blocks.some((block) => block.code === "ATTEMPT_LIMIT" && block.field === "rounds"),
    JSON.stringify(secondDecision.evaluation.blocks),
  );
  assert.equal(secondDecision.evaluation.rounds.used, 1);
  assert.equal(secondDecision.evaluation.rounds.limit, 1);

  const again = await runCli(["execute", (second as { decision: { decisionId: string } }).decision.decisionId, "--operation-id", "3b1e2d3c-4b5a-4968-8776-655443322110", "--enable-dispatch", ...SOURCE], env.runtime);
  assert.equal(again.ok, false);
  assert.equal(env.client.sent.length, 1, "the consumed round is not reopened by a new key");

  // And the budget is persisted, not remembered in the process.
  const decisions = await runCli(["decisions", ...SOURCE], env.runtime);
  const statuses = (decisions.decisions as Array<{ status: string }>).map((row) => row.status).sort();
  assert.deepEqual(statuses, ["blocked", "dispatched"]);
});

test("a restart receipt turns an interrupted intent into an unknown outcome, never a retry", async (t) => {
  const env = compositionEnvironment(t);
  const policy = await createPolicy(env, 5);
  await runCli(["enable", ...SOURCE], env.runtime);
  const decided = await runCli(["decide", "--contract", contractFor(env, "auto-restart-task"), "--policy-id", policy.policyId, ...SOURCE], env.runtime);
  const decisionId = (decided as { decision: { decisionId: string } }).decision.decisionId;

  // The process that recorded the intent died before it could record the result.
  const raw = new DatabaseSync(env.dbFile);
  raw.prepare("UPDATE automation_decisions SET status='executing', effect_operation=?, plan_id=? WHERE decision_id=?")
    .run("4b1e2d3c-4b5a-4968-8776-655443322110", "plan-interrupted", decisionId);
  raw.close();

  const recovered = await runCli(["recover", ...SOURCE], env.runtime);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.recovered, [decisionId]);

  const rows = await runCli(["decisions", ...SOURCE], env.runtime);
  const row = (rows.decisions as Array<{ decisionId: string; status: string }>).find((item) => item.decisionId === decisionId);
  assert.equal(row?.status, "outcome_unknown");

  const retried = await runCli(["execute", decisionId, "--operation-id", "5b1e2d3c-4b5a-4968-8776-655443322110", "--enable-dispatch", ...SOURCE], env.runtime);
  assert.equal(retried.ok, false);
  assert.equal(retried.code, "OUTCOME_UNKNOWN");
  assert.equal(env.client.sent.length, 0, "an unknown effect is observed, never dispatched again");
});

test("revoking the policy retires its pending decisions without dispatching", async (t) => {
  const env = compositionEnvironment(t);
  const policy = await createPolicy(env, 5);
  await runCli(["enable", ...SOURCE], env.runtime);
  const decided = await runCli(["decide", "--contract", contractFor(env, "auto-revoke-task"), "--policy-id", policy.policyId, ...SOURCE], env.runtime);
  const decisionId = (decided as { decision: { decisionId: string } }).decision.decisionId;

  const revoked = await runCli(["policy-revoke", policy.policyId, "--expected-revision", policy.revision, "--reason", "synthetic revocation", ...SOURCE], env.runtime);
  assert.equal(revoked.ok, true, JSON.stringify(revoked));

  const rows = await runCli(["decisions", ...SOURCE], env.runtime);
  const row = (rows.decisions as Array<{ decisionId: string; status: string; blockedCode: string | null }>).find((item) => item.decisionId === decisionId);
  assert.equal(row?.status, "revoked");
  assert.equal(row?.blockedCode, "POLICY_REVOKED");

  const executed = await runCli(["execute", decisionId, "--operation-id", "6b1e2d3c-4b5a-4968-8776-655443322110", "--enable-dispatch", ...SOURCE], env.runtime);
  assert.equal(executed.ok, false);
  assert.equal(env.client.sent.length, 0);

  const audit = await runCli(["audit", "--limit", "30", ...SOURCE], env.runtime);
  const actions = (audit.audit as Array<{ action: string }>).map((entry) => entry.action);
  assert.ok(actions.includes("decision_revoked"), JSON.stringify(actions));
});
