import fs from "node:fs";
import { loadDotEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { TaskStore } from "./task-store.js";
import { TaskCoordinator } from "./coordinator.js";
import { TaskApplicationService } from "./task-application-service.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { configuredDshCoordinator } from "./dsh-runtime.js";
import { runsDirectory } from "./run-journal.js";
import { AdmissionError } from "./collaboration.js";
import type { SendTaskInput } from "./coordinator.js";
import { createReadOnlyProbe, type AutomationPolicyInput, type AutomationProbeResult, type CostMode } from "./automation.js";
import { desktopModelCatalog } from "./desktop-dispatch-runtime.js";
import type { DesktopCatalogSource } from "./desktop-dispatch.js";

// Trusted local seam for the saved automation policy (D5-01/D5-02).
//
// This is the only write entry. There is no MCP tool and no HTTP route that reaches these
// commands, so a coordinator can propose a policy but cannot confirm one. `execute` additionally
// needs an explicit `--enable-dispatch` for the process and an installation where automation was
// enabled on purpose; both default to off, so a fresh checkout never dispatches by itself.
// Nothing here commits, pushes, deploys or approves native permissions.

const USAGE = [
  "Usage (run after `npm run build`, from gateway/):",
  "  node scripts/automation.mjs status [--probe FILE]",
  "  node scripts/automation.mjs policy-create --workspace ID --executor workbuddy|dsh --connection ID",
  "        --provider ID --model ID [--reasoning EFFORT] --source user:NAME [--policy-id ID]",
  "        [--scope-allow a/**;b] [--scope-metadata note] [--max-tasks 1] [--window-seconds 86400]",
  "        [--max-timeout 1800] [--max-attempts 3] [--cost-mode free_only|known_cost|unknown_allowed]",
  "        [--cost-unit credit] [--ceiling 10] [--requires-hard-cap] --expires ISO|--ttl-hours 24",
  "  node scripts/automation.mjs policy-revise ID --expected-revision R --source user:NAME [same flags]",
  "  node scripts/automation.mjs policy-revoke ID --expected-revision R --reason TEXT --source user:NAME",
  "  node scripts/automation.mjs policy-show ID | policy-list",
  "  node scripts/automation.mjs evaluate --contract FILE [--policy-id ID] [--probe FILE]",
  "  node scripts/automation.mjs decide   --contract FILE [--policy-id ID] [--probe FILE]",
  "  node scripts/automation.mjs execute DECISION_ID --operation-id UUID [--enable-dispatch] [--probe FILE]",
  "  node scripts/automation.mjs decisions [--limit 20] | audit [--limit 20] | recover",
  "  node scripts/automation.mjs enable --source user:NAME | disable --source user:NAME",
  "",
  "A saved policy only narrows dispatch; it never grants commit/push/deploy/native approval.",
  "evaluate and decide never dispatch. execute needs --enable-dispatch and an enabled installation,",
  "and it refuses paid or unknown-price models unless the saved policy says so explicitly.",
].join("\n");

interface Parsed {
  positional: string[];
  values: Map<string, string>;
  switches: Set<string>;
}

function parse(rest: string[]): Parsed {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next === undefined || next.startsWith("--")) { switches.add(name); continue; }
    values.set(name, next);
    index += 1;
  }
  return { positional, values, switches };
}

function required(parsed: Parsed, name: string): string {
  const value = parsed.values.get(name);
  if (value === undefined || !value.trim()) throw new AdmissionError("INVALID_AUTOMATION", `Missing --${name}.`);
  return value;
}

function list(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

function number(parsed: Parsed, name: string, fallback?: number): number {
  const raw = parsed.values.get(name);
  if (raw === undefined) {
    if (fallback === undefined) throw new AdmissionError("INVALID_AUTOMATION", `Missing --${name}.`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new AdmissionError("INVALID_AUTOMATION", `--${name} must be a number.`);
  return value;
}

function context(parsed: Parsed) {
  return { actor: parsed.values.get("actor") ?? process.env.USERNAME ?? process.env.USER ?? "operator", source: required(parsed, "source") };
}

function policyInput(parsed: Parsed, current?: { expiresAt: string }): AutomationPolicyInput {
  const executors = required(parsed, "executor");
  if (executors !== "workbuddy" && executors !== "dsh") throw new AdmissionError("INVALID_AUTOMATION", "--executor must be workbuddy or dsh.");
  const expiresAt = parsed.values.get("expires") ??
    (parsed.values.get("ttl-hours") ? new Date(Date.now() + Number(parsed.values.get("ttl-hours")) * 3_600_000).toISOString() : current?.expiresAt);
  if (!expiresAt) throw new AdmissionError("INVALID_AUTOMATION", "Pass --expires ISO or --ttl-hours.");
  const costMode = (parsed.values.get("cost-mode") ?? "free_only") as CostMode;
  return {
    policyId: parsed.values.get("policy-id"),
    workspaceId: required(parsed, "workspace"),
    executor: {
      executorId: executors,
      connectionId: required(parsed, "connection"),
      providerId: required(parsed, "provider"),
      modelId: required(parsed, "model"),
      reasoningEffort: parsed.switches.has("no-reasoning") ? null : parsed.values.get("reasoning") ?? null,
    },
    scope: { allowedChanges: list(parsed.values.get("scope-allow")), permittedMetadata: list(parsed.values.get("scope-metadata")) },
    maxTasksPerWindow: number(parsed, "max-tasks", 1),
    windowSeconds: number(parsed, "window-seconds", 86_400),
    maxTimeoutSeconds: number(parsed, "max-timeout", 1_800),
    maxAttempts: number(parsed, "max-attempts", 3),
    cost: {
      mode: costMode,
      unit: (parsed.values.get("cost-unit") ?? "credit") === "tokens" ? "tokens" : "credit",
      ceiling: parsed.values.get("ceiling") === undefined ? null : Number(parsed.values.get("ceiling")),
      requiresHardCap: parsed.switches.has("requires-hard-cap"),
    },
    expiresAt,
  };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file.replace(/^@/, ""), "utf8")) as unknown;
}

/**
 * Test-only seams for the local CLI composition root. Production callers pass
 * nothing, so the CLI still builds the real coordinator, the real native
 * client and the real workspace routing. The seams exist so an isolated test
 * can prove the wiring without a desktop process, a native session or an
 * account: the guarded service, operation admission and the policy checks all
 * stay real, only the transport and the workspace resolver are substituted.
 */
export interface AutomationCliRuntime {
  client?: WorkBuddyClient;
  resolveWorkspace?: ConstructorParameters<typeof TaskCoordinator>[3];
  observeModel?: ConstructorParameters<typeof TaskCoordinator>[4];
  /** Test seam for the read-only catalog observation; production reads the real catalog. */
  catalog?: () => DesktopCatalogSource | Promise<DesktopCatalogSource>;
}

export async function runAutomationCli(argv: string[] = process.argv.slice(2), runtime: AutomationCliRuntime = {}): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE + "\n");
    return;
  }
  loadDotEnv();
  const config = loadConfig();
  const store = new TaskStore(config.dbFile);
  const runs = runsDirectory(config);
  const parsed = parse(rest);
  const probeFile = parsed.values.get("probe");
  const armed = parsed.switches.has("enable-dispatch");
  // D02: the default observation is a real read-only composition over what this machine already
  // has — the declared resource connections, the saved quota/credit tables and the visible
  // executor/model catalog. `--probe FILE` stays available for replaying a recorded observation,
  // and it is labelled as a file snapshot so nobody mistakes it for a live read.
  const probe = probeFile
    ? () => readJson(probeFile) as AutomationProbeResult
    : createReadOnlyProbe({
      db: store.database,
      env: process.env,
      catalog: runtime.catalog ?? (() => desktopModelCatalog(config, process.env)),
    });
  const probeKind = probeFile ? "snapshot_file" : "read_only_local";
  // R3: this trusted local CLI is a real composition root. Automated dispatch
  // must enter the same guarded service a manual dispatch uses, so the same
  // plan/policy/capacity/native-identity/scope/fee rechecks apply. Wiring the
  // seam does not arm anything: `--enable-dispatch` still has to be passed and
  // the saved policy still has to be enabled.
  let sharedDispatch: ((input: SendTaskInput) => Promise<unknown>) | undefined;
  const service = new TaskApplicationService(
    new TaskCoordinator(config, store, runtime.client ?? new WorkBuddyClient(config), runtime.resolveWorkspace, runtime.observeModel),
    config.maxTaskAttempts ?? 3,
    runs,
    configuredDshCoordinator(store, runs),
    undefined,
    {
      armed,
      probe,
      probeKind,
      send: input => {
        if (!sharedDispatch) throw new AdmissionError("AUTOMATION_NOT_ARMED", "The guarded dispatcher is not available in this process.");
        return sharedDispatch(input);
      },
    },
  );
  sharedDispatch = input => service.send(input);
  const automation = service.automation;
  try {
    let result: Record<string, unknown>;
    if (command === "status") result = { ok: true, action: "status", ...automation.describe() };
    else if (command === "policy-create") {
      const input = policyInput(parsed);
      result = { ok: true, action: "policy-create", ...automation.createPolicy(input, context(parsed)) };
    } else if (command === "policy-revise") {
      const [policyId] = parsed.positional;
      if (!policyId) throw new AdmissionError("INVALID_AUTOMATION", "policy-revise needs a policyId.");
      const expected = required(parsed, "expected-revision");
      const current = automation.getPolicy(policyId).policy;
      result = { ok: true, action: "policy-revise", ...automation.revisePolicy(policyId, expected, policyInput(parsed, current), context(parsed)) };
    } else if (command === "policy-revoke") {
      const [policyId] = parsed.positional;
      if (!policyId) throw new AdmissionError("INVALID_AUTOMATION", "policy-revoke needs a policyId.");
      result = { ok: true, action: "policy-revoke", ...automation.revokePolicy(policyId, required(parsed, "expected-revision"), required(parsed, "reason"), context(parsed)) };
    } else if (command === "policy-show") {
      const [policyId] = parsed.positional;
      if (!policyId) throw new AdmissionError("INVALID_AUTOMATION", "policy-show needs a policyId.");
      result = { ok: true, action: "policy-show", ...automation.getPolicy(policyId), revisions: automation.listPolicyRevisions(policyId) };
    } else if (command === "policy-list") {
      result = { ok: true, action: "policy-list", policies: automation.listPolicies(Number(parsed.values.get("limit") ?? 50)) };
    } else if (command === "evaluate" || command === "decide") {
      const contract = readJson(required(parsed, "contract"));
      const request = { proposal: contract, policyId: parsed.values.get("policy-id") };
      result = command === "evaluate"
        ? { ok: true, action: "evaluate", evaluation: await automation.evaluate(request) }
        : { ok: true, action: "decide", decision: await automation.decide(request, parsed.values.get("actor") ?? "agent") };
    } else if (command === "execute") {
      const [decisionId] = parsed.positional;
      if (!decisionId) throw new AdmissionError("INVALID_AUTOMATION", "execute needs a decisionId.");
      result = await automation.execute(decisionId, { operationId: required(parsed, "operation-id"), actor: parsed.values.get("actor") ?? "operator" });
    } else if (command === "decisions") {
      result = { ok: true, action: "decisions", decisions: automation.listDecisions(Number(parsed.values.get("limit") ?? 20)) };
    } else if (command === "audit") {
      result = { ok: true, action: "audit", audit: automation.audit(Number(parsed.values.get("limit") ?? 20)) };
    } else if (command === "recover") {
      result = { ok: true, action: "recover", ...automation.recover() };
    } else if (command === "enable" || command === "disable") {
      result = { ok: true, action: command, ...automation.setEnabled(command === "enable", context(parsed)) };
    } else {
      throw new AdmissionError("INVALID_AUTOMATION", `Unknown command ${command}. Run with --help.`);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error instanceof AdmissionError ? error.code : "AUTOMATION_FAILED", message: error instanceof Error ? error.message : String(error) }, null, 2) + "\n");
    process.exitCode = 1;
  } finally {
    store.close();
  }
}
