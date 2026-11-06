/**
 * L08 independent acceptance fixture.
 *
 * Deliberately a separate file from `test/support/review-fixture.ts`: the acceptance line must be able
 * to reproduce persisted facts without reusing the delivery line's own helper, otherwise a defect in
 * that helper would hide behind itself. Only the product's public coordinator/queue surface is driven;
 * workspace, native rows and checked-in content are synthetic and unique to this file.
 */
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
import { DesktopQueue } from "../../src/desktop-queue.js";
import { RunJournal } from "../../src/run-journal.js";
import { SelectedModelClient } from "./selected-model-client.js";
import type { DshSelection, DshTransport } from "../../src/dsh-client.js";
import type { DeepSeekEvent } from "../../src/deepseek-client.js";
import type { Config } from "../../src/config.js";

export type FakeExecutor = "workbuddy" | "dsh";

export interface AcceptanceFixtureOptions {
  semantic?: boolean;
  command?: boolean;
  commandExitCode?: number;
  maxAttempts?: number;
  timeoutSeconds?: number;
  dispatch?: boolean;
  prepareFails?: boolean;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Synthetic",
  GIT_AUTHOR_EMAIL: "synthetic@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic",
  GIT_COMMITTER_EMAIL: "synthetic@example.invalid",
};

/** Build one task that can reach `needs_review`. Everything under `root` is disposable. */
export async function acceptanceFixture(t: { after(fn: () => void): void }, executor: FakeExecutor = "workbuddy", options: AcceptanceFixtureOptions = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "l08-accept-")));
  const workspace = path.join(root, "workspace");
  const runs = path.join(root, "runs");
  const taskId = "l08-task";
  fs.mkdirSync(path.join(workspace, "lib"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "lib", "feature.js"), "export const shipped = false;\n");
  fs.writeFileSync(path.join(workspace, "NOTES.md"), "Synthetic protected note\n");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: workspace, windowsHide: true, stdio: "pipe", env: { ...process.env, ...GIT_ENV } });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "Synthetic L08 baseline");
  fs.writeFileSync(path.join(workspace, "lib", "feature.js"), "export const shipped = true; // user change before dispatch\n");

  const config: Config = {
    backend: "desktop-queue",
    dbFile: path.join(root, "state", "tasks.sqlite"),
    runsDir: runs,
    workbuddyConfigDir: root,
    apiBaseUrl: "https://synthetic.invalid",
    tokenFile: path.join(root, "unused-token.json"),
    oauthRedirectUri: "http://127.0.0.1",
    oauthPort: 8787,
    oauthScopes: "",
    requestTimeoutMs: 1000,
    cliElectronPath: process.execPath,
    cliScriptPath: "unused",
    cliPermissionMode: "deny",
    acpPermissionMode: "deny",
    gatewayUrl: "http://127.0.0.1:1",
  };
  const native = new DatabaseSync(path.join(root, "workbuddy.db"));
  native.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,is_playground INTEGER,deleted_at INTEGER)");
  native.prepare("INSERT INTO sessions VALUES(?,?,0,NULL)").run("l08-session", workspace);
  native.close();

  let store = new TaskStore(config.dbFile);
  const counters = { preparations: 0, inspections: 0, prompts: 0, reports: 0 };
  const coordinator = new TaskCoordinator(
    config,
    store,
    new SelectedModelClient(config),
    async (_config, input) => {
      counters.preparations++;
      if (options.prepareFails) throw new Error("synthetic native preparation crash");
      return { workspace: String(input.workspace), sessionId: "l08-session" };
    },
    async (_config, sessionId, model) => {
      counters.inspections++;
      return { sessionId, modelId: model as string, selectedModel: model as string, credits: null, observedAt: new Date().toISOString(), level: "selected" as const };
    },
  );
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  const execution = {
    executorId: executor,
    connectionId: executor === "workbuddy" ? "local-workbuddy" : "l08-synthetic-host",
    providerId: executor === "workbuddy" ? "workbuddy-native" : "l08-synthetic-provider",
    modelId: "synthetic-user-choice",
    reasoningEffort: null,
  };
  const events: DeepSeekEvent[] = [];
  let selection: DshSelection | null = null;
  const dshTransport: DshTransport = {
    resolveHostId: () => "l08-synthetic-host",
    health: async () => ({}),
    sessions: async () => ({ sessions: [] }),
    create: async () => {
      throw Error("the acceptance fixture never creates a real session");
    },
    session: async () => ({ sessionId: "l08-session", workspace, attached: true, busy: false, selectedModel: selection }),
    models: async () => ({ pricingVerified: false, models: [{ ...execution, credits: null, reasoningEfforts: [] }] }),
    selectModel: async () => {
      selection = execution;
      return { sessionId: "l08-session", workspace, attached: true, selectedModel: selection };
    },
    prompt: async input => {
      counters.prompts++;
      return { requestId: input.requestId, accepted: true };
    },
    events: async input => {
      const page = events.filter(event => event.requestId === input.requestId && event.seq > input.afterSeq);
      return { events: page, cursor: page.at(-1)?.seq ?? input.afterSeq };
    },
    cancel: async () => ({ requested: true }),
  };
  const dsh = new DshTaskCoordinator(store, dshTransport, runs);
  const service = new TaskApplicationService(coordinator, options.maxAttempts ?? 3, runs, dsh);
  store.collaboration.registerWorkspace("l08-workspace", workspace, "Synthetic L08 workspace");

  const featurePath = path.join(workspace, "lib", "feature.js");
  const command = {
    executable: process.execPath,
    args: ["-e", `process.stdout.write('l08 independent command\\n');process.exit(${options.commandExitCode ?? 0})`],
    cwd: workspace,
    timeoutSeconds: 10,
    inputs: [featurePath],
  };
  const requiredChecks = [
    ...(options.semantic ? [{ id: "behavior", kind: "semantic" as const, definition: "The synthetic requirement is preserved" }] : []),
    ...(options.command ? [{ id: "command", kind: "command" as const, definition: JSON.stringify(command) }] : []),
  ];
  const proposal = {
    schemaVersion: "workbuddy-executor/vnext-2",
    taskId,
    workspaceId: "l08-workspace",
    title: "L08 acceptance task",
    objective: "Verify persisted acceptance facts with synthetic native evidence",
    execution,
    timeoutSeconds: options.timeoutSeconds ?? 600,
    maxAttempts: options.maxAttempts ?? 3,
    scope: { allowedChanges: ["lib/**"], permittedMetadata: [] },
    requiredChecks,
    collaboration: { planId: "pending", expectedPlanRevision: "pending" },
  };
  const plan = service.createCollaborationPlan(proposal, { mode: "manual", reason: "L08 synthetic selection" });
  service.authorizeCollaborationPlan(plan.planId, plan.revision, "synthetic-user");
  const contract = { ...proposal, collaboration: { planId: plan.planId, expectedPlanRevision: plan.revision } };
  await (options.dispatch === false ? Promise.resolve() : service.send({ taskId, objective: contract.objective, contract, sessionId: "l08-session" }));

  /** Dispatch an additional synthetic task through the same application service with explicit overrides. */
  async function sendRaw(input: { taskId?: string; operationId?: string; model?: string; objective?: string } = {}) {
    const id = input.taskId ?? taskId;
    const draft = {
      ...proposal,
      taskId: id,
      objective: input.objective ?? proposal.objective,
      ...(input.model === undefined ? {} : { execution: { ...execution, modelId: input.model } }),
      collaboration: { planId: "pending", expectedPlanRevision: "pending" },
    };
    const draftPlan = service.createCollaborationPlan(draft, { mode: "manual", reason: "L08 synthetic selection" });
    service.authorizeCollaborationPlan(draftPlan.planId, draftPlan.revision, "synthetic-user");
    const draftContract = { ...draft, collaboration: { planId: draftPlan.planId, expectedPlanRevision: draftPlan.revision } };
    return service.send({ taskId: id, objective: draftContract.objective, contract: draftContract, sessionId: "l08-session", ...(input.operationId ? { operationId: input.operationId, expectedRevision: null, expectedAttemptId: null } : {}) });
  }

  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  const current = () => store.get(taskId)!;
  const op = () => ({ taskId, operationId: crypto.randomUUID(), expectedRevision: current().revision!, expectedAttemptId: current().attemptId! });

  async function emit(pathname: "started" | "progress" | "completed" | "failed" | "cancelled", rawType: string, data?: unknown, text?: string) {
    const binding = store.dshBindings.forTask(taskId)!;
    events.push({
      seq: events.length,
      requestId: binding.requestId,
      type: pathname as DeepSeekEvent["type"],
      rawType,
      timestamp: new Date().toISOString(),
      turnId: `l08-session:turn:${current().attempt}`,
      ...(data ? { data } : {}),
      ...(text ? { text } : {}),
    });
    await service.sync(taskId);
  }

  /** Produce a genuine authenticated report followed by the required native stop observation. */
  async function finish(stopped = true) {
    if (executor === "workbuddy") {
      const claim = await queue.claim("l08-session", 0);
      if (claim.status !== "task") throw Error(`expected a synthetic claim, got ${claim.status}`);
      counters.reports++;
      queue.report({ ...claim, status: "completed", text: "TASK_STATUS: completed\nTEST_RESULT: synthetic worker self-report is never evidence", artifacts: [] });
      if (stopped) queue.observeNative(claim.attemptId, { state: "idle", workspace });
    } else {
      await emit("started", "turn/start");
      await emit("progress", "request/header", { header: { config: { provider: execution.providerId, model: execution.modelId } } });
      if (stopped) await emit("completed", "turn/end", undefined, "TASK_STATUS: completed\nTEST_RESULT: synthetic worker self-report is never evidence");
    }
    await service.sync(taskId);
  }

  const checks = () => service.reviewChecks(op());
  function review(batch = checks(), status: "passed" | "failed" | "unknown" | "checker_error" | "not_applicable" = "passed", supersedesReviewId?: string) {
    const evidence = options.semantic ? service.recordInspection({ ...op(), note: "L08 independent inspection of the synthetic requirement", files: [featurePath] }).evidenceId : null;
    return service.review({
      ...op(),
      machineCheckIds: batch.machineCheckIds,
      semanticChecks: evidence ? [{ checkId: "behavior", status, note: "L08 independent requirement inspection", evidenceRefs: [evidence] }] : [],
      note: "L08 independent review",
      ...(supersedesReviewId ? { supersedesReviewId } : {}),
    });
  }
  const journal = () => new RunJournal(runs, current().attemptId!);

  return {
    root,
    workspace,
    runs,
    runsDir: runs,
    featurePath,
    config,
    store: () => store,
    service,
    queue,
    dsh,
    coordinator,
    counters,
    taskId,
    contract,
    current,
    op,
    finish,
    checks,
    review,
    journal,
    emit,
    execution,
    sendRaw,   
    restart() {
      store.close();
      store = new TaskStore(config.dbFile);
      return store;
    },
  };
}





