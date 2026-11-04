import fs from "node:fs";
import path from "node:path";
import { loadDotEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { TaskStore } from "./task-store.js";
import { TaskCoordinator } from "./coordinator.js";
import { TaskApplicationService } from "./task-application-service.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { configuredDshCoordinator } from "./dsh-runtime.js";
import { runsDirectory } from "./run-journal.js";
import { AdmissionError } from "./collaboration.js";

// Trusted local seam for vnext-2 planning. Workspace registration, plan creation
// and plan authorization stay out of the MCP tool surface and off HTTP: an agent
// can assemble a proposal, but only a local operator can make it authorized.
// Nothing here dispatches, leases or calls a model.
export interface PlanCliResult { ok: true; action: string; [key: string]: unknown }

export function registerWorkspace(service: TaskApplicationService, id: string, directory: string, displayName: string) {
  if (!path.isAbsolute(directory)) throw new AdmissionError("WORKSPACE_CONFLICT", "Use an existing absolute project directory.");
  return service.registerWorkspace(id, fs.realpathSync.native(directory), displayName);
}

export function createPlan(service: TaskApplicationService, contract: unknown, options: { reason: string; mode?: "manual" | "recommend"; ttlSeconds?: number; operationId?: string }) {
  const plan = service.createCollaborationPlan(contract, { mode: options.mode ?? "manual", reason: options.reason, ttlSeconds: options.ttlSeconds ?? 900, operationId: options.operationId });
  return summarize(plan);
}

export function authorizePlan(service: TaskApplicationService, planId: string, revision: string, source: string, operationId?: string) {
  return summarize(service.authorizeCollaborationPlan(planId, revision, source, { operationId }));
}

export function showPlan(service: TaskApplicationService, planId: string) {
  return summarize(service.getCollaborationPlan(planId));
}

function summarize(plan: { planId: string; revision: string; mode: string; decision: string; reason: string; expiresAt: string; termsHash: string; authorizedAt: string | null; authorizationSource: string | null; consumedBy: string | null }) {
  // The proposal body stays out of the console: the caller already has the
  // contract it submitted, and the plan identity is what dispatch needs.
  return { planId: plan.planId, revision: plan.revision, mode: plan.mode, decision: plan.decision, reason: plan.reason, expiresAt: plan.expiresAt, termsHash: plan.termsHash, authorizedAt: plan.authorizedAt, authorizationSource: plan.authorizationSource, consumedBy: plan.consumedBy };
}

const USAGE = [
  "Usage:",
  "  node scripts/plan.mjs register <workspaceId> <directory> [displayName]",
  "  node scripts/plan.mjs create --contract <file|@file> --reason TEXT [--mode manual] [--ttl 900] [--operationId ID]",
  "  node scripts/plan.mjs authorize <planId> <revision> --source TEXT [--operationId ID]",
  "  node scripts/plan.mjs show <planId>",
  "",
  "create prints planId + revision; put both into the contract's collaboration block,",
  "then run authorize. Dispatch stays a separate, user-confirmed step.",
].join("\n");

export function runPlanCli(argv: string[] = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") { process.stdout.write(USAGE + "\n"); return; }
  loadDotEnv();
  const config = loadConfig(), store = new TaskStore(config.dbFile), runs = runsDirectory(config);
  const service = new TaskApplicationService(new TaskCoordinator(config, store, new WorkBuddyClient(config)), config.maxTaskAttempts ?? 3, runs, configuredDshCoordinator(store, runs));
  try {
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i]!;
      if (!token.startsWith("--")) continue;
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new AdmissionError("PLAN_STALE", `Missing value for ${token}.`);
      flags.set(token.slice(2), value); i += 1;
    }
    const positional = rest.filter((token, index) => !token.startsWith("--") && !(index > 0 && rest[index - 1]!.startsWith("--")));
    let result: PlanCliResult;
    if (command === "register") {
      const [id, directory, displayName] = positional;
      if (!id || !directory) throw new AdmissionError("WORKSPACE_CONFLICT", "Pass a workspace id and an absolute directory.");
      result = { ok: true, action: "register", workspace: registerWorkspace(service, id, directory, displayName || path.basename(directory)) };
    }
    else if (command === "create") {
      const file = flags.get("contract"), reason = flags.get("reason");
      if (!file || !reason) throw new AdmissionError("PLAN_STALE", "create needs --contract and --reason.");
      const contract = JSON.parse(fs.readFileSync(file.replace(/^@/, ""), "utf8")) as unknown;
      const ttl = flags.get("ttl") ? Number(flags.get("ttl")) : 900;
      result = { ok: true, action: "create", ...createPlan(service, contract, { reason, mode: flags.get("mode") === "recommend" ? "recommend" : "manual", ttlSeconds: ttl, operationId: flags.get("operationId") }) };
    }
    else if (command === "authorize") {
      const [planId, revision] = positional, source = flags.get("source");
      if (!planId || !revision || !source) throw new AdmissionError("PLAN_CONFIRMATION_REQUIRED", "authorize needs a planId, revision and --source.");
      result = { ok: true, action: "authorize", ...authorizePlan(service, planId, revision, source, flags.get("operationId")) };
    }
    else if (command === "show") {
      const [planId] = positional;
      if (!planId) throw new AdmissionError("PLAN_STALE", "show needs a planId.");
      result = { ok: true, action: "show", ...showPlan(service, planId) };
    }
    else throw new AdmissionError("PLAN_STALE", "Unknown command. Use register, create, authorize or show.");
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error instanceof AdmissionError ? error.code : "PLAN_FAILED", message: error instanceof Error ? error.message : String(error) }, null, 2) + "\n");
    process.exitCode = 1;
  } finally { store.close(); }
}
