import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../../src/task-store.js";
import { TaskCoordinator } from "../../src/coordinator.js";
import { TaskApplicationService } from "../../src/task-application-service.js";
import { DshTaskCoordinator } from "../../src/dsh-coordinator.js";
import type { DshTransport, DshSelection } from "../../src/dsh-client.js";
import type { DeepSeekEvent } from "../../src/deepseek-client.js";
import { DesktopQueue } from "../../src/desktop-queue.js";
import { SelectedModelClient } from "./selected-model-client.js";
import type { Config } from "../../src/config.js";
import { RunJournal } from "../../src/run-journal.js";

/** Synthetic native adapters only. Actual temp files, Git, SQLite and report authentication. */
export async function reviewFixture(t: { after(fn: () => void): void }, executor: "workbuddy" | "dsh" = "workbuddy", options: { semantic?: boolean; command?: boolean; commandExitCode?: number } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "t6-review-"))), workspace = path.join(root, "project"), runs = path.join(root, "runs");
  fs.mkdirSync(workspace); fs.mkdirSync(path.join(workspace, "src"));
  const source = path.join(workspace, "src", "input.js"); fs.writeFileSync(source, "export const value = 1;\n");
  fs.writeFileSync(path.join(workspace, "README.md"), "Protected fixture\n");
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Synthetic Review", "-c", "user.email=review@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, windowsHide: true, stdio: "pipe" });
  git("init", "-q"); git("add", "."); git("commit", "-qm", "Synthetic baseline");
  fs.writeFileSync(path.join(workspace, "src", "input.js"), "export const value = 2; // existing user change\n");
  const config: Config = { backend: "desktop-queue", dbFile: path.join(root, "state", "tasks.sqlite"), runsDir: runs, workbuddyConfigDir: root,
    apiBaseUrl: "https://synthetic.invalid", tokenFile: path.join(root, "unused.json"), oauthRedirectUri: "http://127.0.0.1", oauthPort: 8787,
    oauthScopes: "", requestTimeoutMs: 1000, cliElectronPath: process.execPath, cliScriptPath: "unused", cliPermissionMode: "deny", acpPermissionMode: "deny", gatewayUrl: "http://127.0.0.1:1" };
  const native = new DatabaseSync(path.join(root, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)"); native.prepare("INSERT INTO sessions VALUES(?,?,0,NULL)").run("session", workspace); native.close();
  let store = new TaskStore(config.dbFile);
  const wb = new TaskCoordinator(config, store, new SelectedModelClient(config), async (_config, input) => ({ workspace: input.workspace, sessionId: "session" }),
    async (_config, sessionId, model) => ({ sessionId, modelId: model, selectedModel: model, credits: null, observedAt: new Date().toISOString(), level: "selected" }));
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  const execution = { executorId: executor, connectionId: executor === "workbuddy" ? "local-workbuddy" : "host", providerId: executor === "workbuddy" ? "workbuddy-native" : "synthetic-provider", modelId: "synthetic-user-choice", reasoningEffort: null };
  const events: DeepSeekEvent[] = [];
  let selected: DshSelection | null = null, prompts = 0;
  const client: DshTransport = {
    resolveHostId: () => "host", health: async () => ({}), sessions: async () => ({ sessions: [] }), create: async () => { throw Error("No real sessions"); },
    session: async () => ({ sessionId: "session", workspace, attached: true, busy: false, selectedModel: selected }),
    models: async () => ({ pricingVerified: false, models: [{ ...execution, credits: null, reasoningEfforts: [] }] }),
    selectModel: async () => { selected = execution; return { sessionId: "session", workspace, attached: true, selectedModel: selected }; },
    prompt: async input => { prompts++; return { requestId: input.requestId, accepted: true }; },
    events: async input => { const page = events.filter(event => event.requestId === input.requestId && event.seq > input.afterSeq); return { events: page, cursor: page.at(-1)?.seq ?? input.afterSeq }; }, cancel: async () => ({ requested: true }),
  };
  const dsh = new DshTaskCoordinator(store, client, runs), service = new TaskApplicationService(wb, 3, runs, dsh);
  store.collaboration.registerWorkspace("project", workspace, "Synthetic review project");
  const command = { executable: process.execPath, args: ["-e", `process.stdout.write('independent verification\\n');process.exit(${options.commandExitCode ?? 0})`], cwd: workspace, timeoutSeconds: 10, inputs: [source] };
  const requiredChecks = [...(options.semantic ? [{ id: "behavior", kind: "semantic", definition: "Preserve the requested behavior" }] : []), ...(options.command ? [{ id: "test", kind: "command", definition: JSON.stringify(command) }] : [])];
  const proposal = { schemaVersion: "workbuddy-executor/vnext-2", taskId: "task", workspaceId: "project", title: "Independent review", objective: "Verify the real files using synthetic native delivery", execution, timeoutSeconds: 600, maxAttempts: 3, scope: { allowedChanges: ["src/**"], permittedMetadata: [] }, requiredChecks, collaboration: { planId: "pending", expectedPlanRevision: "pending" } };
  const plan = service.createCollaborationPlan(proposal, { mode: "manual", reason: "Synthetic fixture only" });
  service.authorizeCollaborationPlan(plan.planId, plan.revision, "synthetic-user");
  const contract = { ...proposal, collaboration: { planId: plan.planId, expectedPlanRevision: plan.revision } };
  await service.send({ taskId: "task", objective: contract.objective, contract, sessionId: "session" });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const current = () => store.get("task")!;
  const op = () => ({ taskId: "task", operationId: crypto.randomUUID(), expectedRevision: current().revision!, expectedAttemptId: current().attemptId! });
  async function finish(stopped = true, validationRecords?: Array<{ path: string; sha256: string }>) {
    if (executor === "workbuddy") {
      const claim = await queue.claim("session", 0); if (claim.status !== "task") throw Error("Expected synthetic claim");
      queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: worker self-report only", artifacts: [], ...(validationRecords ? { validationRecords } : {}) });
      if (stopped) queue.observeNative(claim.attemptId, { state: "idle", workspace });
    } else {
      const binding = store.dshBindings.forTask("task")!;
      const append = (type: DeepSeekEvent["type"], rawType: string, data?: unknown, text?: string) => events.push({ seq: events.length, requestId: binding.requestId, type, rawType, timestamp: new Date().toISOString(), turnId: `session:turn:${current().attempt}`, ...(data ? { data } : {}), ...(text ? { text } : {}) });
      append("started", "turn/start"); append("progress", "request/header", { header: { config: { provider: execution.providerId, model: execution.modelId } } });
      if (stopped) append("completed", "turn/end", undefined, "TASK_STATUS: completed\nTEST_RESULT: worker self-report only");
    }
    await service.sync("task");
  }
  const checks = () => service.reviewChecks(op());
  function review(batch = checks(), status: "passed" | "failed" | "unknown" | "checker_error" | "not_applicable" = "passed", supersedesReviewId?: string) {
    const evidence = options.semantic ? service.recordInspection({ ...op(), note: "Read actual source and checked original semantic requirement", files: [source] }).evidenceId : null;
    return service.review({ ...op(), machineCheckIds: batch.machineCheckIds, semanticChecks: evidence ? [{ checkId: "behavior", status, note: "Independent original requirement inspection", evidenceRefs: [evidence] }] : [], note: "Independent source and provenance inspection", ...(supersedesReviewId ? { supersedesReviewId } : {}) });
  }
  const journal = () => new RunJournal(runs, current().attemptId!);
  return { root, workspace, runs, source, config, store, queue, wb, dsh, service, op, current, finish, checks, review, journal, prompts: () => prompts,
    restart() { store.close(); store = new TaskStore(config.dbFile); return store; } };
}
