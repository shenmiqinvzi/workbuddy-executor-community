import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  AdmissionError,
  defaultModelPolicy,
  enforceModelPolicy,
  type AutomationPlanBinding,
  type ModelPolicy,
} from "./collaboration.js";
import {
  contractExecution,
  validateSupportedTaskContract,
  type ExecutionSelection,
  type SupportedTaskContract,
} from "./task-contract.js";
import type { SendTaskInput } from "./coordinator.js";
import type { TaskStore } from "./task-store.js";
import { readQuotaResources } from "./quota-observation.js";
import { readCreditBalances } from "./credit-balance.js";
import { readResourceConnections, type ResourceConnectionDocument } from "./resource-connections.js";
import type { DesktopCatalogSource } from "./desktop-dispatch.js";

/**
 * Saved automation policy (D5-01).
 *
 * A policy is a *user-saved* statement of what may be dispatched without asking again. It is
 * created, revised and revoked only through a trusted local entry (`scripts/automation.mjs`),
 * which records who authorized it. No HTTP write route and no MCP tool can save one, so an agent
 * can propose a policy but never forge the confirmation behind it.
 *
 * A policy only narrows dispatch. It never grants commit/push/deploy/native-approval rights.
 */
export const AUTOMATION_SCHEMA_VERSION = 1;

/** Errors used only by the automation module. They are additive to INTERFACE_CONTRACT §7. */
export const AUTOMATION_ERRORS = Object.freeze({
  notEnabled: "AUTOMATION_NOT_ENABLED",
  notArmed: "AUTOMATION_NOT_ARMED",
  policyMissing: "POLICY_MISSING",
  policyAmbiguous: "POLICY_AMBIGUOUS",
  policyExpired: "POLICY_EXPIRED",
  policyRevoked: "POLICY_REVOKED",
  decisionMissing: "DECISION_NOT_FOUND",
  schemaUnsupported: "AUTOMATION_SCHEMA_UNSUPPORTED",
  observationUnavailable: "OBSERVATION_UNAVAILABLE",
  invalid: "INVALID_AUTOMATION",
});

export type AutomationPolicyStatus = "active" | "expired" | "revoked" | "superseded";
export type AutomationDecisionStatus = "pending" | "executing" | "dispatched" | "blocked" | "outcome_unknown" | "revoked";
export type CostMode = "free_only" | "known_cost" | "unknown_allowed";

export interface AutomationCostPolicy {
  /** free_only proves x0.00; known_cost needs a reported balance; unknown_allowed accepts unknown cost. */
  mode: CostMode;
  unit: "credit" | "tokens";
  /** Per-task ceiling the operator is willing to spend. Required for known_cost, forbidden for free_only. */
  ceiling: number | null;
  /** True when the operator asked for a hard spending limit; an unsupported source must then refuse. */
  requiresHardCap: boolean;
}

export interface AutomationPolicy {
  policyId: string;
  /** Immutable revision token; a revision is a new row, the previous row stays for audit. */
  revision: string;
  version: string;
  workspaceId: string;
  executor: ExecutionSelection;
  /** Upper bound of the task scope this policy may authorize. Empty = read-only tasks only. */
  scope: { allowedChanges: string[]; permittedMetadata: string[] };
  maxTasksPerWindow: number;
  windowSeconds: number;
  maxTimeoutSeconds: number;
  maxAttempts: number;
  cost: AutomationCostPolicy;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  /** `user:` / `local-operator:` / `desktop:` only. Anything else is rejected at save time. */
  authorizationSource: string;
  supersedes: string | null;
}

export interface AutomationPolicyRecord {
  policy: AutomationPolicy;
  status: AutomationPolicyStatus;
  current: boolean;
}

export interface AutomationPolicyInput {
  policyId?: string;
  workspaceId: string;
  executor: ExecutionSelection;
  scope?: { allowedChanges?: string[]; permittedMetadata?: string[] };
  maxTasksPerWindow: number;
  windowSeconds: number;
  maxTimeoutSeconds: number;
  maxAttempts: number;
  cost: AutomationCostPolicy;
  expiresAt: string;
}

/** Records who performed a trusted operation. `actor` is free text, `source` is policy-bound. */
export interface AuditContext {
  actor: string;
  source: string;
}

export interface AutomationProblem {
  code: string;
  field: string;
  message: string;
}

export interface AutomationProbeModel {
  executorId: "workbuddy" | "dsh";
  connectionId: string;
  providerId: string;
  modelId: string;
  reasoningEfforts: Array<string | null>;
  credits: string | null;
  remaining: number | null;
  unit: "credit" | "tokens";
  valueKind: "reported" | "estimated" | "unavailable";
  freshness: "fresh" | "stale" | "unavailable";
  hardCap: "reported" | "unsupported";
  catalogState: "available" | "missing";
  observedAt: string;
  expiresAt: string | null;
  /**
   * R2 — a catalog multiplier is a *rate*, not a balance: `credits` proves what one unit costs, it
   * never proves how much is left. Kept separate so `known_cost` cannot read a rate as a balance.
   */
  rate?: { kind: "reported" | "unavailable"; value: string | null };
  /**
   * R2 — the balance surface, with the two facts a cost threshold needs: the unit it is counted in
   * and whether the source routes the number to *this* executor/connection/model. A shared pool
   * reports `routing: "unverified"`, so it can never satisfy `known_cost`.
   */
  balance?: { kind: "reported" | "estimated" | "unavailable"; unit: "credit" | "tokens"; remaining: number | null; routing: "verified" | "unverified"; source: string | null };
}

export interface AutomationProbeExecutor {
  executorId: "workbuddy" | "dsh";
  connectionId: string;
  providerId: string;
  online: boolean;
  dispatchable: boolean;
  evidence: string;
  observedAt: string;
  /** What the source says this executor can do; absent means "not reported", not "nothing". */
  capabilities?: string[];
}

/** A read-only catalog/quota observation. The default probe reports no cost evidence at all. */
export interface AutomationProbeResult {
  observedAt: string;
  executors: AutomationProbeExecutor[];
  models: AutomationProbeModel[];
}

/**
 * D02 — the formal read-only observation.
 *
 * A decision may only be made from an observation somebody else can re-read. Every read surface
 * this probe touches is a *saved or declared* local resource, and each one reports its own state:
 * a surface that was never configured, never collected, or is too old is reported as such instead
 * of being folded into "no data" or, worse, into "free". Nothing here logs in, calls a model, or
 * writes to the database.
 */
export const AUTOMATION_PROBE_VERSION = "workbuddy-executor/automation-probe-1";

export type AutomationProbeSourceName = "connections" | "quota" | "credit" | "catalog" | "liveness";

export type AutomationProbeSourceStatus = "ok" | "not_declared" | "missing" | "unreadable" | "stale" | "unavailable" | "unwired";

export interface AutomationProbeSourceState {
  source: AutomationProbeSourceName;
  status: AutomationProbeSourceStatus;
  /** When the *source* said it observed something; null when nothing was observed. */
  observedAt: string | null;
  expiresAt: string | null;
  entries: number;
  detail: string;
  limitations: string[];
}

export interface AutomationProbeCoverage {
  /** `observed` only when a live executor read produced the row; a declaration is never enough. */
  executors: "observed" | "unavailable";
  /** `observed` = a catalog read listed the exact model; `declared_only` = an operator declared it. */
  catalog: "observed" | "declared_only" | "missing";
  /** Where the price/limit evidence came from. A pool snapshot is not a per-task attribution. */
  costEvidence: "executor_catalog" | "gateway_pool" | "unavailable";
  tokenEstimates: "observed" | "unavailable";
  creditCache: "observed" | "stale" | "unavailable";
  taskAttribution: "unavailable";
}

export interface AutomationProbeReport extends AutomationProbeResult {
  probeVersion: string;
  readOnly: true;
  /** The exact policy revision this observation was taken for. */
  policy: { policyId: string; revision: string; version: string };
  sources: AutomationProbeSourceState[];
  coverage: AutomationProbeCoverage;
  limitations: string[];
}

export interface AutomationCandidate {
  execution: ExecutionSelection;
  status: "candidate" | "excluded";
  blocks: AutomationProblem[];
  limits: string[];
  cost: { evidence: "reported" | "estimated" | "unavailable"; remaining: number | null; unit: "credit" | "tokens"; hardCapSupported: boolean };
}

export interface AutomationEvaluation {
  policyId: string;
  policyRevision: string;
  policyVersion: string;
  decision: "delegate" | "wait";
  blocks: AutomationProblem[];
  limits: string[];
  candidates: AutomationCandidate[];
  cost: { mode: CostMode; unit: "credit" | "tokens"; ceiling: number | null; evidence: "reported" | "estimated" | "unavailable"; remaining: number | null; hardCapSupported: boolean; note: string };
  rounds: { used: number; limit: number; windowSeconds: number };
  history: { requireFree: boolean; selectionMode: "allowlist" | "user_choice"; allowed: number; source: "live_policy"; blocked: boolean };
  scope: { workspaceId: string; workspaceRealPath: string | null; allowedChanges: string[]; permittedMetadata: string[] };
  expiresAt: string;
  observedAt: string;
  probeObservedAt: string;
  /** Which read surfaces produced this evaluation and whether they failed. Read-only record. */
  probe: {
    probeVersion: string;
    observedAt: string;
    sources: AutomationProbeSourceState[];
    coverage: AutomationProbeCoverage | null;
    limitations: string[];
  };
}

export interface AutomationDecision {
  decisionId: string;
  policyId: string;
  policyRevision: string;
  policyVersion: string;
  policyDigest: string;
  taskId: string;
  status: AutomationDecisionStatus;
  evaluation: AutomationEvaluation;
  proposal: SupportedTaskContract;
  contractHash: string;
  planId: string | null;
  operationId: string | null;
  effectStartedAt: string | null;
  blockedCode: string | null;
  blockedMessage: string | null;
  createdAt: string;
  updatedAt: string;
  result: unknown;
  /** Who triggered the evaluation that produced this row. Absent on rows written before D05. */
  requestedBy?: string | null;
}

export interface AutomationServiceOptions {
  /** Same guarded entry a manual dispatch uses; the automation path never calls an adapter directly. */
  send?: (input: SendTaskInput) => Promise<unknown>;
  probe?: (policy: AutomationPolicy) => Promise<AutomationProbeReport | AutomationProbeResult> | AutomationProbeReport | AutomationProbeResult;
  /** Says which read surface the probe is, so the panel never presents a file snapshot as live. */
  probeKind?: "read_only_local" | "snapshot_file" | "injected";
  now?: () => Date;
  /** Default false: this line ships an unwired automation path until an operator arms it. */
  armed?: boolean;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const SOURCE = /^(user|local-operator|desktop):[A-Za-z0-9._:@/-]{1,120}$/;
const FREE_CREDITS = /^x0(?:\.0+)?(?: credits)?$/i;
const PROBE_FRESH_MS = 60_000;
const PROBE_FUTURE_MS = 5_000;
const MAX_POLICY_LIFETIME_MS = 366 * 24 * 60 * 60 * 1000;

function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function fail(code: string, message: string): never {
  throw new AdmissionError(code, message);
}
/**
 * Identifier minting. Every generated id is checked again by a validator on the way back in:
 * this module's own `ID` pattern (`[A-Za-z0-9][A-Za-z0-9._:@-]*`) and the collaboration service's
 * `validId` (`[a-zA-Z0-9][a-zA-Z0-9._:-]*`), which the automatic plan binding must satisfy.
 * base64url emits `_`, which neither pattern accepts, so a base64url id could mint itself and then
 * be refused by its own guard (an intermittent PLAN_CONFIRMATION_REQUIRED / INVALID_AUTOMATION on
 * dispatch). Hex keeps 144 bits of entropy inside both alphabets.
 */
function token(): string {
  return randomBytes(18).toString("hex");
}
function sameSelection(left: ExecutionSelection, right: ExecutionSelection): boolean {
  return left.executorId === right.executorId && left.connectionId === right.connectionId && left.providerId === right.providerId &&
    left.modelId === right.modelId && left.reasoningEffort === right.reasoningEffort;
}
function canonical(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (input === undefined) return null;
    if (input === null || typeof input !== "object") {
      if (typeof input === "number" && !Number.isFinite(input)) fail(AUTOMATION_ERRORS.invalid, "A non-finite number cannot be recorded.");
      return input;
    }
    if (Array.isArray(input)) return input.map(walk);
    const source = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = walk(source[key]);
    return out;
  };
  return JSON.stringify(walk(value));
}
function digestOf(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}
function iso(date: Date): string {
  return date.toISOString();
}
function uniqueStrings(value: unknown, field: string, limit: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) fail(AUTOMATION_ERRORS.invalid, `${field} must be a list of at most ${limit} entries.`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || item.length > 300) fail(AUTOMATION_ERRORS.invalid, `${field} contains an invalid entry.`);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}
function isSubset(requested: string[], allowed: string[]): boolean {
  return requested.every((item) => allowed.includes(item) || allowed.some((pattern) => {
    if (!pattern.endsWith("/**")) return false;
    const prefix = pattern.slice(0, -2);
    return item === pattern.slice(0, -3) || item.startsWith(prefix);
  }));
}

export function ensureAutomationSchema(db: DatabaseSync): void {
  // A future database must not be mutated by an older gateway, so the stored
  // version is checked before this build creates or indexes any table.
  const metaTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='automation_meta'")
    .get() as { name?: string } | undefined;
  if (metaTable) {
    let stored: number;
    try {
      const current = db
        .prepare("SELECT schema_version FROM automation_meta WHERE id=1")
        .get() as { schema_version?: number } | undefined;
      stored = current === undefined ? AUTOMATION_SCHEMA_VERSION : Number(current.schema_version);
    } catch (error) {
      fail(AUTOMATION_ERRORS.schemaUnsupported,
        `The automation metadata exists but is unreadable (${(error as Error).message}); this build will not migrate it.`);
    }
    if (!Number.isInteger(stored) || stored > AUTOMATION_SCHEMA_VERSION) {
      fail(AUTOMATION_ERRORS.schemaUnsupported,
        `This build reads automation schema ${AUTOMATION_SCHEMA_VERSION}; the database reports ${String(stored)}. Upgrade the gateway instead of rolling the database back.`);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS automation_meta (
    id INTEGER PRIMARY KEY CHECK (id=1),
    schema_version INTEGER NOT NULL,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automation_policies (
    policy_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    is_current INTEGER NOT NULL,
    digest TEXT NOT NULL,
    body_json TEXT NOT NULL,
    PRIMARY KEY (policy_id, revision)
  );
  CREATE INDEX IF NOT EXISTS automation_policies_current ON automation_policies (policy_id, is_current);
  CREATE TABLE IF NOT EXISTS automation_decisions (
    decision_id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    status TEXT NOT NULL,
    task_id TEXT NOT NULL,
    plan_id TEXT,
    effect_operation TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    digest TEXT NOT NULL,
    body_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS automation_decisions_policy ON automation_decisions (policy_id, status, created_at);
  CREATE TABLE IF NOT EXISTS automation_audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id TEXT,
    decision_id TEXT,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    source TEXT NOT NULL,
    detail_json TEXT NOT NULL,
    at TEXT NOT NULL
  );`);
  const row = db.prepare("SELECT schema_version FROM automation_meta WHERE id=1").get() as { schema_version?: number } | undefined;
  if (!row) {
    db.prepare("INSERT INTO automation_meta (id,schema_version,enabled,updated_at) VALUES (1,?,0,?)").run(AUTOMATION_SCHEMA_VERSION, iso(new Date()));
    return;
  }
  const version = Number(row.schema_version);
  if (!Number.isInteger(version) || version > AUTOMATION_SCHEMA_VERSION) {
    fail(AUTOMATION_ERRORS.schemaUnsupported,
      `This build reads automation schema ${AUTOMATION_SCHEMA_VERSION}; the database reports ${String(row.schema_version)}. Upgrade the gateway instead of rolling the database back.`);
  }
  if (version < AUTOMATION_SCHEMA_VERSION) {
    // Schema 1 is the first version, so this only records the forward migration.
    db.prepare("UPDATE automation_meta SET schema_version=?, updated_at=? WHERE id=1").run(AUTOMATION_SCHEMA_VERSION, iso(new Date()));
  }
}

export class AutomationService {
  private readonly inflight = new Set<string>();
  private schemaReady = false;

  constructor(private readonly store: TaskStore, private readonly options: AutomationServiceOptions = {}) {}

  /**
   * The raw handle, opened lazily. A read-only composition root (the desktop
   * window) exposes no database, so constructing this service there must not
   * create tables: it fails at first use with a named code instead.
   */
  private database(): DatabaseSync {
    const db = (this.store as TaskStore & { database?: DatabaseSync }).database;
    if (!db) fail(AUTOMATION_ERRORS.invalid, "The saved automation policy needs the writable task database; this composition root opened a read-only view.");
    if (!this.schemaReady) { ensureAutomationSchema(db); this.schemaReady = true; }
    return db;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Read-only description used by the CLI and the panel; no policy is created here. */
  describe(): Record<string, unknown> {
    const meta = this.meta();
    return {
      schemaVersion: meta.schemaVersion,
      enabled: meta.enabled,
      armed: this.options.armed === true,
      dispatcherWired: typeof this.options.send === "function",
      probe: this.options.probe ? "injected" : "saved_snapshot_none",
      probeKind: this.options.probeKind ?? (this.options.probe ? "injected" : "none"),
      writeEntry: "local_cli_only",
      httpWrites: false,
      // D01: the six layers are reported separately so "enabled", "armed", "authorized",
      // "chosen", "decided" and "dispatched" can never be read as one another.
      layers: this.layers(),
      limits: [
        "A policy only narrows dispatch; it never grants commit, push, deploy or native-approval rights.",
        "Capacity stays a single shared slot owned by the operation layer.",
        "An enabled policy does not arm dispatch; the running process must also be armed.",
        "A saved policy does not choose a model for a future task: each new real task still needs its own executor/model/reasoning selection confirmed by the user.",
      ],
    };
  }

  /**
   * The six automation layers, each with its own source of truth. Reading this must never require
   * a dispatch, a probe or a model call: it is a projection of saved state plus this process.
   */
  private layers(): Record<string, unknown> {
    const counted = this.database().prepare("SELECT status, COUNT(*) AS total FROM automation_decisions GROUP BY status").all() as Array<{ status?: string; total?: number }>;
    const byStatus: Record<string, number> = {};
    for (const row of counted) byStatus[String(row.status ?? "unknown")] = Number(row.total ?? 0);
    return {
      installation: {
        layer: "installation_enabled",
        enabled: this.meta().enabled,
        source: "automation_meta.enabled",
        changeEntry: "scripts/automation.mjs enable|disable --source user:NAME",
        httpWrites: false,
      },
      process: {
        layer: "process_armed",
        armed: this.options.armed === true,
        dispatcherWired: typeof this.options.send === "function",
        probeKind: this.options.probeKind ?? (this.options.probe ? "injected" : "none"),
        source: "constructed options of this process",
        note: "Armed is a process flag; it is never persisted and never implied by an enabled installation.",
      },
      authorization: {
        layer: "policy_authorization",
        writeEntry: "local_cli_only",
        acceptedSources: ["user:", "local-operator:", "desktop:"],
        refusedSources: ["agent:", "http:", "model:", "automation:", "empty"],
        policiesCurrent: this.listPolicies(200).length,
        httpWrites: false,
        mcpWrites: false,
        note: "A caller string in a CLI argument is not authorization; only a saved policy from a trusted source authorizes narrowing.",
      },
      taskSelection: {
        layer: "per_task_selection",
        mode: "per_task_confirmed",
        note: "Controlled policy execution: the policy pins one already-chosen executor/model/reasoning, but it never chooses a model for a future task. Every new real task still needs its own selection confirmed by the user.",
      },
      decision: {
        layer: "recorded_decision",
        pending: byStatus.pending ?? 0,
        blocked: byStatus.blocked ?? 0,
        executing: byStatus.executing ?? 0,
        dispatched: byStatus.dispatched ?? 0,
        outcomeUnknown: byStatus.outcome_unknown ?? 0,
        revoked: byStatus.revoked ?? 0,
      },
      dispatch: {
        layer: "actual_dispatch",
        guardedService: "TaskApplicationService.send",
        capacity: "single_shared_slot",
        effectBoundary: "one effect per decision, bound to its own operationId",
        plan: "plan/policy/capacity/native-identity/scope rechecked inside the pre-effect transaction",
      },
    };
  }

  private meta(): { schemaVersion: number; enabled: boolean } {
    const row = this.database().prepare("SELECT schema_version, enabled FROM automation_meta WHERE id=1").get() as { schema_version?: number; enabled?: number } | undefined;
    if (!row) fail(AUTOMATION_ERRORS.schemaUnsupported, "The automation schema marker is missing.");
    return { schemaVersion: Number(row.schema_version), enabled: Number(row.enabled) === 1 };
  }

  setEnabled(enabled: boolean, context: AuditContext): { enabled: boolean } {
    this.assertTrusted(context);
    if (typeof enabled !== "boolean") fail(AUTOMATION_ERRORS.invalid, "enabled must be a boolean.");
    this.database().prepare("UPDATE automation_meta SET enabled=?, updated_at=? WHERE id=1").run(enabled ? 1 : 0, iso(this.now()));
    this.appendAudit({ action: enabled ? "enabled" : "disabled", actor: context.actor, source: context.source, policyId: null, decisionId: null, detail: { enabled } });
    return { enabled };
  }

  // ---------------------------------------------------------------- policies

  createPolicy(input: AutomationPolicyInput, context: AuditContext): AutomationPolicyRecord {
    this.assertTrusted(context);
    const now = this.now();
    const policy = this.normalizePolicy(input, null, context, now);
    const policyId = input.policyId ?? `policy-${token()}`;
    if (!validId(policyId) || policyId.length > 60) fail(AUTOMATION_ERRORS.invalid, "policyId must be a stable identifier of at most 60 characters.");
    const existing = this.database().prepare("SELECT revision FROM automation_policies WHERE policy_id=? AND is_current=1").get(policyId);
    if (existing) fail(AUTOMATION_ERRORS.invalid, "This policyId already has a current revision; revise it instead of creating a second policy.");
    const body: AutomationPolicy = { ...policy, policyId };
    this.store.atomic(() => {
      this.database().prepare("INSERT INTO automation_policies (policy_id,revision,is_current,digest,body_json) VALUES (?,?,1,?,?)")
        .run(policyId, body.revision, digestOf(body), JSON.stringify(body));
      this.appendAudit({ action: "created", actor: context.actor, source: context.source, policyId, decisionId: null, detail: { revision: body.revision, expiresAt: body.expiresAt, costMode: body.cost.mode } });
    });
    return this.policyRecord(policyId, body.revision);
  }

  revisePolicy(policyId: string, expectedRevision: string, patch: Partial<AutomationPolicyInput>, context: AuditContext): AutomationPolicyRecord {
    this.assertTrusted(context);
    const current = this.readPolicy(policyId, expectedRevision);
    if (current.revokedAt) fail(AUTOMATION_ERRORS.policyRevoked, "A revoked policy cannot be revised; save a new policy.");
    const now = this.now();
    if (patch.workspaceId !== undefined && patch.workspaceId !== current.workspaceId) {
      fail("SCOPE_VIOLATION", "A revision cannot move a policy to another workspace; save a new policy for that project.");
    }
    const merged: AutomationPolicyInput = {
      workspaceId: current.workspaceId,
      executor: patch.executor ?? current.executor,
      scope: patch.scope ?? current.scope,
      maxTasksPerWindow: patch.maxTasksPerWindow ?? current.maxTasksPerWindow,
      windowSeconds: patch.windowSeconds ?? current.windowSeconds,
      maxTimeoutSeconds: patch.maxTimeoutSeconds ?? current.maxTimeoutSeconds,
      maxAttempts: patch.maxAttempts ?? current.maxAttempts,
      cost: patch.cost ?? current.cost,
      expiresAt: patch.expiresAt ?? current.expiresAt,
    };
    if (Date.parse(merged.expiresAt) > Date.parse(current.expiresAt)) {
      fail(AUTOMATION_ERRORS.invalid, "A revision cannot extend its own expiry; save a new policy so the longer window is authorized on its own.");
    }
    const next = this.normalizePolicy(merged, current, context, now);
    const body: AutomationPolicy = { ...next, policyId, supersedes: current.revision };
    this.store.atomic(() => {
      this.database().prepare("UPDATE automation_policies SET is_current=0 WHERE policy_id=? AND revision=?").run(policyId, current.revision);
      this.database().prepare("INSERT INTO automation_policies (policy_id,revision,is_current,digest,body_json) VALUES (?,?,1,?,?)")
        .run(policyId, body.revision, digestOf(body), JSON.stringify(body));
      this.appendAudit({
        action: "revised", actor: context.actor, source: context.source, policyId, decisionId: null,
        detail: { fromRevision: current.revision, toRevision: body.revision, expiresAt: body.expiresAt, costMode: body.cost.mode, maxTasksPerWindow: body.maxTasksPerWindow },
      });
    });
    return this.policyRecord(policyId, body.revision);
  }

  revokePolicy(policyId: string, expectedRevision: string, reason: string, context: AuditContext): AutomationPolicyRecord {
    this.assertTrusted(context);
    if (!reason?.trim() || reason.length > 500) fail(AUTOMATION_ERRORS.invalid, "A short revocation reason is required.");
    const current = this.readPolicy(policyId, expectedRevision);
    if (current.revokedAt) return this.policyRecord(policyId, current.revision);
    const revoked: AutomationPolicy = { ...current, revokedAt: iso(this.now()), revocationReason: reason.trim() };
    this.store.atomic(() => {
      this.database().prepare("UPDATE automation_policies SET body_json=?, digest=? WHERE policy_id=? AND revision=?")
        .run(JSON.stringify(revoked), digestOf(revoked), policyId, current.revision);
      this.appendAudit({ action: "revoked", actor: context.actor, source: context.source, policyId, decisionId: null, detail: { revision: current.revision, reason: revoked.revocationReason } });
      // Revocation stops future decisions. An already executing decision keeps its own operation;
      // cancelling it here would be a second effect on an unknown native outcome.
      const executing = this.database().prepare("SELECT decision_id FROM automation_decisions WHERE policy_id=? AND status='executing'").all(policyId) as Array<{ decision_id: string }>;
      for (const row of executing) {
        this.appendAudit({
          action: "revoke_after_dispatch_intent", actor: context.actor, source: context.source, policyId, decisionId: row.decision_id,
          detail: { note: "The decision had already passed its pre-dispatch recheck; observe that operation instead of re-dispatching." },
        });
      }
      // A decision that was recorded but never dispatched is retired by the same revocation: its
      // stored rows keep their identity, and `execute` reports POLICY_REVOKED instead of a race.
      const pending = this.database().prepare("SELECT decision_id FROM automation_decisions WHERE policy_id=? AND status='pending'").all(policyId) as Array<{ decision_id: string }>;
      for (const row of pending) {
        const recorded = this.getDecision(row.decision_id);
        const at = iso(this.now());
        this.writeDecision({
          ...recorded, status: "revoked", updatedAt: at,
          blockedCode: AUTOMATION_ERRORS.policyRevoked, blockedMessage: "The saved policy was revoked before this decision dispatched.",
        });
        this.appendAudit({
          action: "decision_revoked", actor: context.actor, source: context.source, policyId, decisionId: row.decision_id,
          detail: { revision: current.revision, policyVersion: current.version, note: "Recorded but never dispatched; retirement is not a dispatch." },
        });
      }
    });
    return this.policyRecord(policyId, current.revision);
  }

  getPolicy(policyId: string): AutomationPolicyRecord {
    const row = this.database().prepare("SELECT revision FROM automation_policies WHERE policy_id=? AND is_current=1").get(policyId) as { revision?: string } | undefined;
    if (!row?.revision) fail(AUTOMATION_ERRORS.policyMissing, "The saved automation policy does not exist.");
    return this.policyRecord(policyId, row.revision);
  }

  listPolicies(limit = 50): AutomationPolicyRecord[] {
    const rows = this.database().prepare("SELECT policy_id, revision FROM automation_policies WHERE is_current=1 ORDER BY rowid DESC LIMIT ?").all(limit) as Array<{ policy_id: string; revision: string }>;
    return rows.map((row) => this.policyRecord(row.policy_id, row.revision));
  }

  listPolicyRevisions(policyId: string): Array<{ revision: string; current: boolean; status: AutomationPolicyStatus; createdAt: string; revokedAt: string | null }> {
    const rows = this.database().prepare("SELECT revision, is_current, body_json FROM automation_policies WHERE policy_id=? ORDER BY rowid DESC").all(policyId) as Array<{ revision: string; is_current: number; body_json: string }>;
    return rows.map((row) => {
      const body = JSON.parse(row.body_json) as AutomationPolicy;
      return { revision: row.revision, current: Number(row.is_current) === 1, status: this.statusOf(body, Number(row.is_current) === 1), createdAt: body.createdAt, revokedAt: body.revokedAt };
    });
  }

  private statusOf(policy: AutomationPolicy, current: boolean): AutomationPolicyStatus {
    if (policy.revokedAt) return "revoked";
    if (Date.parse(policy.expiresAt) <= this.now().getTime()) return "expired";
    return current ? "active" : "superseded";
  }

  private policyRecord(policyId: string, revision: string): AutomationPolicyRecord {
    const policy = this.readPolicy(policyId, revision);
    const current = Number((this.database().prepare("SELECT is_current FROM automation_policies WHERE policy_id=? AND revision=?").get(policyId, revision) as { is_current?: number } | undefined)?.is_current) === 1;
    return { policy, status: this.statusOf(policy, current), current };
  }

  private readPolicy(policyId: string, revision: string): AutomationPolicy {
    const row = this.database().prepare("SELECT body_json, digest FROM automation_policies WHERE policy_id=? AND revision=?").get(policyId, revision) as { body_json?: string; digest?: string } | undefined;
    if (!row?.body_json) fail(AUTOMATION_ERRORS.policyMissing, "The saved automation policy revision does not exist.");
    const body = JSON.parse(row.body_json) as AutomationPolicy;
    if (digestOf(body) !== row.digest || body.policyId !== policyId || body.revision !== revision) {
      fail("CONTRACT_INTEGRITY", "The saved automation policy failed integrity verification.");
    }
    return body;
  }

  private normalizePolicy(input: AutomationPolicyInput, previous: AutomationPolicy | null, context: AuditContext, now: Date): AutomationPolicy {
    this.assertTrusted(context);
    if (!validId(input.workspaceId)) fail(AUTOMATION_ERRORS.invalid, "workspaceId must be a registered workspace identifier.");
    const executor = input.executor;
    if (!executor || !["workbuddy", "dsh"].includes(executor.executorId) || !validId(executor.connectionId) || !validId(executor.providerId) ||
      typeof executor.modelId !== "string" || !executor.modelId.trim() || executor.modelId.length > 200 ||
      (executor.reasoningEffort !== null && !validId(executor.reasoningEffort))) {
      fail(AUTOMATION_ERRORS.invalid, "The policy must pin one exact executor, connection, provider, model and reasoning effort.");
    }
    if (!Number.isInteger(input.maxTasksPerWindow) || input.maxTasksPerWindow < 1 || input.maxTasksPerWindow > 100) fail(AUTOMATION_ERRORS.invalid, "maxTasksPerWindow must be 1..100.");
    if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 60 || input.windowSeconds > 2_592_000) fail(AUTOMATION_ERRORS.invalid, "windowSeconds must be 60..2592000.");
    if (!Number.isInteger(input.maxTimeoutSeconds) || input.maxTimeoutSeconds < 1 || input.maxTimeoutSeconds > 86_400) fail(AUTOMATION_ERRORS.invalid, "maxTimeoutSeconds must be 1..86400.");
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100) fail(AUTOMATION_ERRORS.invalid, "maxAttempts must be 1..100.");
    const expiresAt = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) fail(AUTOMATION_ERRORS.invalid, "A saved policy needs a future expiry.");
    if (expiresAt > now.getTime() + MAX_POLICY_LIFETIME_MS) fail(AUTOMATION_ERRORS.invalid, "A saved policy cannot live longer than 366 days; re-authorize instead.");
    const cost = input.cost;
    if (!cost || !["free_only", "known_cost", "unknown_allowed"].includes(cost.mode)) fail(AUTOMATION_ERRORS.invalid, "Invalid cost mode.");
    if (cost.unit !== "credit" && cost.unit !== "tokens") fail(AUTOMATION_ERRORS.invalid, "Invalid cost unit.");
    if (cost.mode === "known_cost") {
      if (typeof cost.ceiling !== "number" || !Number.isFinite(cost.ceiling) || cost.ceiling <= 0) fail(AUTOMATION_ERRORS.invalid, "A known-cost policy needs a positive per-task ceiling.");
    } else if (cost.ceiling !== null && cost.ceiling !== undefined) {
      fail(AUTOMATION_ERRORS.invalid, "Only a known-cost policy may carry a ceiling.");
    }
    if (typeof cost.requiresHardCap !== "boolean") fail(AUTOMATION_ERRORS.invalid, "requiresHardCap must be explicit.");
    const scope = {
      allowedChanges: uniqueStrings(input.scope?.allowedChanges, "scope.allowedChanges", 100),
      permittedMetadata: uniqueStrings(input.scope?.permittedMetadata, "scope.permittedMetadata", 100),
    };
    const revision = previous ? token() : token();
    return {
      policyId: previous?.policyId ?? "",
      revision,
      version: `automation-${token().slice(0, 24)}`,
      workspaceId: input.workspaceId,
      executor: { ...executor },
      scope,
      maxTasksPerWindow: input.maxTasksPerWindow,
      windowSeconds: input.windowSeconds,
      maxTimeoutSeconds: input.maxTimeoutSeconds,
      maxAttempts: input.maxAttempts,
      cost: { mode: cost.mode, unit: cost.unit, ceiling: cost.mode === "known_cost" ? cost.ceiling ?? null : null, requiresHardCap: cost.requiresHardCap },
      expiresAt: iso(new Date(expiresAt)),
      createdAt: iso(now),
      revokedAt: null,
      revocationReason: null,
      authorizationSource: context.source,
      supersedes: previous?.revision ?? null,
    };
  }

  private assertTrusted(context: AuditContext): void {
    if (!context || typeof context.actor !== "string" || !context.actor.trim() || context.actor.length > 120) fail(AUTOMATION_ERRORS.invalid, "A trusted actor is required.");
    if (typeof context.source !== "string" || !SOURCE.test(context.source)) {
      fail("PLAN_CONFIRMATION_REQUIRED", "Only a saved user/local-operator/desktop source may authorize a policy; agent and HTTP sources cannot.");
    }
  }

  // ---------------------------------------------------------------- decisions

  async evaluate(request: { proposal: unknown; policyId?: string }): Promise<AutomationEvaluation> {
    const { contract, policy } = this.resolve(request);
    const probe = await this.runProbe(policy);
    return this.assessment(contract, policy, probe);
  }

  /**
   * Record one evaluation as a durable decision. A blocked evaluation still produces a readable
   * decision row (with the first block as its reason), because the operator has to see why the
   * policy declined; a race that another process won surfaces as a block, not as a lost dispatch.
   */
  async decide(request: { proposal: unknown; policyId?: string }, actor: string): Promise<AutomationDecision> {
    const { contract, policy } = this.resolve(request);
    const probe = await this.runProbe(policy);
    const contractHash = digestOf(contract);
    const decisionId = `decision-${token()}`;
    const createdAt = iso(this.now());

    const decision = this.store.atomic(() => {
      // Recovered rows are re-assessed against the same probe so the recorded reason matches the
      // rows this process can see right now (revocation, capacity, rounds, task identity).
      let evaluation: AutomationEvaluation;
      try {
        const current = this.policyRecord(policy.policyId, policy.revision).policy;
        evaluation = this.assessment(contract, current, probe);
      } catch (error) {
        evaluation = this.assessment(contract, policy, probe);
        evaluation.blocks.unshift({ code: error instanceof AdmissionError ? error.code : "POLICY_CHANGED", field: "policy", message: error instanceof Error ? error.message : "The policy is no longer readable." });
        evaluation.decision = "wait";
      }
      const record: AutomationDecision = {
        decisionId, policyId: policy.policyId, policyRevision: policy.revision, policyVersion: policy.version, policyDigest: digestOf(policy),
        taskId: contract.taskId, status: evaluation.decision === "delegate" ? "pending" : "blocked", evaluation, proposal: contract,
        contractHash, planId: null, operationId: null, effectStartedAt: null,
        blockedCode: evaluation.blocks[0]?.code ?? null, blockedMessage: evaluation.blocks[0]?.message ?? null,
        createdAt, updatedAt: createdAt, result: null, requestedBy: actor || "agent",
      };
      this.database().prepare("INSERT INTO automation_decisions (decision_id,policy_id,policy_revision,status,task_id,plan_id,effect_operation,created_at,updated_at,digest,body_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .run(decisionId, policy.policyId, policy.revision, record.status, contract.taskId, null, null, createdAt, createdAt, digestOf(record), JSON.stringify(record));
      this.appendAudit({
        action: record.status === "pending" ? "decision_pending" : "decision_blocked",
        actor: actor || "agent", source: `automation:${policy.policyId}`, policyId: policy.policyId, decisionId,
        // D05: the audit answers who triggered it, which policy revision and terms applied, which
        // observation was used, and why nothing was dispatched — without copying the task body.
        detail: {
          taskId: contract.taskId,
          requestedBy: actor || "agent",
          policyRevision: policy.revision,
          policyVersion: policy.version,
          authorizationSource: policy.authorizationSource,
          costMode: policy.cost.mode,
          expiresAt: policy.expiresAt,
          probe: {
            probeVersion: record.evaluation.probe.probeVersion,
            observedAt: record.evaluation.probe.observedAt,
            sources: record.evaluation.probe.sources.map((source) => `${source.source}:${source.status}`),
            coverage: record.evaluation.probe.coverage,
          },
          blocks: record.evaluation.blocks.map((block) => ({ code: block.code, field: block.field, message: block.message })),
          limits: record.evaluation.limits,
        },
      });
      return record;
    });
    return decision;
  }

  /**
   * Dispatch a pending decision. The whole pre-effect state (policy row, capacity, rounds, task
   * identity) is rechecked inside one write transaction; the native send happens after it commits,
   * so two processes or a restart can produce at most one effect per decision.
   */
  async execute(decisionId: string, input: { operationId: string; actor?: string }): Promise<Record<string, unknown>> {
    if (!this.options.armed) fail(AUTOMATION_ERRORS.notArmed, "Automatic dispatch is not armed in this process; a manual dispatch is still available.");
    if (!this.meta().enabled) fail(AUTOMATION_ERRORS.notEnabled, "Automatic policy use is disabled for this installation.");
    if (typeof this.options.send !== "function") fail(AUTOMATION_ERRORS.notArmed, "No guarded dispatcher is wired into this process.");
    if (!validId(input?.operationId)) fail(AUTOMATION_ERRORS.invalid, "A stable operationId is required for automated dispatch.");

    const decision = this.getDecision(decisionId);
    if (decision.status === "dispatched") {
      if (decision.operationId === input.operationId) return { ok: true, replay: true, decisionId, status: decision.status, planId: decision.planId, taskId: decision.taskId, result: decision.result };
      fail("OPERATION_CONFLICT", "This decision already produced its effect under another operationId.");
    }
    if (decision.status === "executing") {
      fail("OUTCOME_UNKNOWN", "This decision has an unconfirmed effect; observe its original operation instead of dispatching again.");
    }
    if (decision.status === "outcome_unknown") {
      fail("OUTCOME_UNKNOWN", "The earlier effect of this decision is unresolved; observe the original operation.");
    }
    if (decision.status === "blocked") fail(decision.blockedCode ?? "AUTOMATION_BLOCKED", decision.blockedMessage ?? "The decision is blocked.");
    if (decision.status === "revoked") fail(AUTOMATION_ERRORS.policyRevoked, "The policy was revoked before this decision dispatched.");

    const policyRecord = this.policyRecord(decision.policyId, decision.policyRevision);
    const policy = policyRecord.policy;
    const probe = await this.runProbe(policy);
    const evaluation = this.assessment(decision.proposal, policy, probe);
    if (evaluation.decision !== "delegate") {
      this.blockDecision(decisionId, evaluation);
      fail(evaluation.blocks[0]?.code ?? "AUTOMATION_BLOCKED", evaluation.blocks[0]?.message ?? "The saved policy no longer permits this dispatch.");
    }

    const intent = this.store.atomic(() => {
      const fresh = this.getDecision(decisionId);
      if (fresh.status !== "pending" || fresh.operationId !== null) fail("OPERATION_CONFLICT", "Another process already claimed this decision.");
      const livePolicy = this.store.collaboration.currentPolicy(defaultModelPolicy(3));
      this.assertPolicyLive(policy);
      this.assertRounds(policy);
      this.assertCapacityFree();
      const existing = this.store.get(decision.proposal.taskId);
      if (existing) fail("TASK_CONFLICT", "A task with this identifier already exists; automation never replaces it.");
      const plan = this.store.collaboration.createPlan(decision.proposal, livePolicy, {
        mode: "automatic",
        reason: this.planReason(decision, policy, evaluation),
        ttlSeconds: this.planTtl(policy),
        automation: { policyId: policy.policyId, policyRevision: policy.revision, policyVersion: policy.version, decisionId },
      });
      const authorized = this.store.collaboration.authorizePlan(plan.planId, plan.revision, livePolicy, `automation:${policy.policyId}`);
      const bound = { ...decision.proposal, collaboration: { planId: authorized.planId, expectedPlanRevision: authorized.revision } } as SupportedTaskContract;
      const updated: AutomationDecision = {
        ...fresh, status: "executing", planId: plan.planId, operationId: input.operationId,
        effectStartedAt: iso(this.now()), updatedAt: iso(this.now()), evaluation,
      };
      this.writeDecision(updated);
      this.appendAudit({
        action: "decision_dispatch_intent", actor: input.actor ?? "automation", source: `automation:${policy.policyId}`,
        policyId: policy.policyId, decisionId,
        detail: {
          planId: authorized.planId, operationId: input.operationId, taskId: decision.taskId,
          policyRevision: policy.revision, policyVersion: policy.version,
          probeObservedAt: evaluation.probeObservedAt, requestedBy: input.actor ?? "automation",
        },
      });
      return { planId: authorized.planId, taskId: decision.taskId, contract: bound };
    });

    this.inflight.add(decisionId);
    try {
      const sent = await this.options.send({
        taskId: intent.taskId,
        objective: intent.contract.objective,
        contract: intent.contract,
        operationId: input.operationId,
        expectedRevision: null,
        expectedAttemptId: null,
      }) as { ok?: boolean } | null | undefined;
      // The guarded service reports a swallowed native failure as `ok:false`, so "the call returned"
      // is not evidence of a dispatch. Only a completed operation counts; anything else is unknown.
      const operation = this.store.operations.get(input.operationId);
      if (operation?.state !== "succeeded" || sent?.ok === false) {
        throw new AdmissionError("OUTCOME_UNKNOWN", "The dispatch did not confirm a completed effect; observe the original operation instead of dispatching again.");
      }
      this.store.atomic(() => {
        const current = this.getDecision(decisionId);
        this.writeDecision({ ...current, status: "dispatched", updatedAt: iso(this.now()), result: sent ?? null });
        this.appendAudit({
          action: "decision_dispatched", actor: input.actor ?? "automation", source: `automation:${policy.policyId}`,
          policyId: policy.policyId, decisionId,
          detail: {
            planId: intent.planId, operationId: input.operationId, taskId: decision.taskId,
            policyRevision: policy.revision, policyVersion: policy.version, requestedBy: input.actor ?? "automation",
          },
        });
      });
      return { ok: true, replay: false, decisionId, status: "dispatched", planId: intent.planId, taskId: decision.taskId, operationId: input.operationId, result: sent ?? null };
    } catch (error) {
      const unknown = this.effectUnknown(input.operationId, error);
      this.store.atomic(() => {
        const current = this.getDecision(decisionId);
        const code = error instanceof AdmissionError ? error.code : "AUTOMATION_DISPATCH_FAILED";
        this.writeDecision({
          ...current,
          status: unknown ? "outcome_unknown" : "blocked",
          blockedCode: code,
          blockedMessage: error instanceof Error ? error.message : "The automated dispatch failed.",
          updatedAt: iso(this.now()),
        });
        this.appendAudit({
          action: unknown ? "decision_unknown" : "decision_dispatch_failed",
          actor: input.actor ?? "automation", source: `automation:${policy.policyId}`, policyId: policy.policyId, decisionId,
          detail: { code, unknown, operationId: input.operationId, note: unknown ? "Observe the original operation; do not re-dispatch." : "No native effect was recorded for this operation." },
        });
      });
      throw error;
    } finally {
      this.inflight.delete(decisionId);
    }
  }

  /**
   * Restart receipt: an `executing` decision that no live instance owns produced an unknown
   * outcome. It is never re-dispatched and never released on a timer; the original operation is
   * the only thing to observe.
   */
  recover(): { recovered: string[] } {
    const rows = this.database().prepare("SELECT decision_id FROM automation_decisions WHERE status='executing'").all() as Array<{ decision_id: string }>;
    const recovered: string[] = [];
    for (const row of rows) {
      if (this.inflight.has(row.decision_id)) continue;
      const decision = this.getDecision(row.decision_id);
      this.store.atomic(() => {
        this.writeDecision({ ...decision, status: "outcome_unknown", updatedAt: iso(this.now()) });
        this.appendAudit({
          action: "decision_recovered_unknown", actor: "automation", source: "automation:startup", policyId: decision.policyId, decisionId: row.decision_id,
          detail: { operationId: decision.operationId, planId: decision.planId, note: "No live instance owned this decision; observe the original operation." },
        });
      });
      recovered.push(row.decision_id);
    }
    return { recovered };
  }

  getDecision(decisionId: string): AutomationDecision {
    const row = this.database().prepare("SELECT body_json, digest, status, plan_id, effect_operation FROM automation_decisions WHERE decision_id=?").get(decisionId) as
      { body_json?: string; digest?: string; status?: string; plan_id?: string | null; effect_operation?: string | null } | undefined;
    if (!row?.body_json) fail(AUTOMATION_ERRORS.decisionMissing, "The automation decision does not exist.");
    const body = JSON.parse(row.body_json) as AutomationDecision;
    if (digestOf(body) !== row.digest || body.decisionId !== decisionId) fail("CONTRACT_INTEGRITY", "The automation decision failed integrity verification.");
    return { ...body, status: row.status as AutomationDecisionStatus, planId: row.plan_id ?? null, operationId: row.effect_operation ?? null };
  }

  /**
   * Read-only view of the guarded dispatcher's own record for this decision's operation.
   *
   * Automation never writes here and never re-dispatches from it: after an attempt whose effect is
   * unknown, observing the original operation is the only permitted move (`OUTCOME_UNKNOWN`), and
   * this method exists so a reader can do exactly that instead of guessing from the decision row.
   */
  operationFor(decisionId: string): {
    decisionId: string;
    status: AutomationDecisionStatus;
    operationId: string | null;
    operation: {
      operationId: string; kind: string; state: string; taskId: string; attemptId: string | null;
      effectStartedAt: string | null; createdAt: string; updatedAt: string; error: { code: string; message: string } | null;
    } | null;
    note: string;
  } {
    const decision = this.getDecision(decisionId);
    if (!decision.operationId) {
      return { decisionId, status: decision.status, operationId: null, operation: null, note: "This decision never reserved an operation, so there is nothing to observe." };
    }
    const record = this.store.operations.get(decision.operationId);
    if (!record) {
      return { decisionId, status: decision.status, operationId: decision.operationId, operation: null, note: "The reserved operation is not in this database; observe the original task and do not re-dispatch." };
    }
    return {
      decisionId,
      status: decision.status,
      operationId: decision.operationId,
      operation: {
        operationId: record.operationId,
        kind: record.kind,
        state: record.state,
        taskId: record.taskId,
        attemptId: record.attemptId,
        effectStartedAt: record.effectStartedAt ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        error: record.error ? { code: record.error.code, message: record.error.message } : null,
      },
      note: "Read-only. The state of this operation is the only evidence of what actually happened.",
    };
  }

  listDecisions(limit = 50): AutomationDecision[] {
    const rows = this.database().prepare("SELECT decision_id FROM automation_decisions ORDER BY rowid DESC LIMIT ?").all(Math.max(1, Math.min(200, limit))) as Array<{ decision_id: string }>;
    return rows.map((row) => this.getDecision(row.decision_id));
  }

  audit(limit = 50): Array<{ seq: number; action: string; policyId: string | null; decisionId: string | null; actor: string; source: string; at: string; detail: unknown }> {
    const rows = this.database().prepare("SELECT * FROM automation_audit ORDER BY seq DESC LIMIT ?").all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      seq: Number(row.seq), action: String(row.action), policyId: (row.policy_id as string | null) ?? null,
      decisionId: (row.decision_id as string | null) ?? null, actor: String(row.actor), source: String(row.source), at: String(row.at),
      detail: JSON.parse(String(row.detail_json)),
    }));
  }

  /** Read-only projection for the WorkBuddy panel; it carries no write capability. */
  snapshot(): Record<string, unknown> {
    const meta = this.meta();
    return {
      schemaVersion: meta.schemaVersion, enabled: meta.enabled, armed: this.options.armed === true,
      writeEntry: "local_cli_only", httpWrites: false,
      probeKind: this.options.probeKind ?? (this.options.probe ? "injected" : "none"),
      layers: this.layers(),
      policies: this.listPolicies(50).map((record) => ({
        policyId: record.policy.policyId, revision: record.policy.revision, status: record.status,
        workspaceId: record.policy.workspaceId, executor: record.policy.executor, cost: record.policy.cost,
        scope: record.policy.scope, maxTasksPerWindow: record.policy.maxTasksPerWindow, windowSeconds: record.policy.windowSeconds,
        maxTimeoutSeconds: record.policy.maxTimeoutSeconds, maxAttempts: record.policy.maxAttempts,
        expiresAt: record.policy.expiresAt, createdAt: record.policy.createdAt, revokedAt: record.policy.revokedAt,
        authorizationSource: record.policy.authorizationSource, supersedes: record.policy.supersedes,
      })),
      decisions: this.listDecisions(30).map((decision) => ({
        decisionId: decision.decisionId, policyId: decision.policyId, policyRevision: decision.policyRevision,
        taskId: decision.taskId, status: decision.status, decision: decision.evaluation.decision,
        blocks: decision.evaluation.blocks, limits: decision.evaluation.limits, cost: decision.evaluation.cost,
        rounds: decision.evaluation.rounds, planId: decision.planId, operationId: decision.operationId,
        createdAt: decision.createdAt, updatedAt: decision.updatedAt, blockedCode: decision.blockedCode,
        probeObservedAt: decision.evaluation.probeObservedAt ?? null,
        probe: decision.evaluation.probe ?? null,
        requestedBy: decision.requestedBy ?? null,
      })),
      audit: this.audit(25),
    };
  }

  // ---------------------------------------------------------------- internals

  private resolve(request: { proposal: unknown; policyId?: string }): { contract: SupportedTaskContract; policy: AutomationPolicy } {
    const validated = validateSupportedTaskContract(request?.proposal);
    if (!validated.ok) fail("PLAN_STALE", validated.rejection.message);
    const contract = validated.contract;
    if (!("execution" in contract)) fail("PLAN_STALE", "An automatic decision requires a vnext-2 proposal with an exact execution.");
    let policyId = request.policyId;
    if (policyId === undefined) {
      const candidates = this.listPolicies(100).filter((record) => record.policy.workspaceId === contract.workspaceId && record.status === "active");
      if (candidates.length === 0) fail(AUTOMATION_ERRORS.policyMissing, "No active saved policy covers this workspace.");
      if (candidates.length > 1) fail(AUTOMATION_ERRORS.policyAmbiguous, "More than one active policy covers this workspace; name the policy explicitly.");
      policyId = candidates[0]!.policy.policyId;
    }
    const record = this.getPolicy(policyId);
    return { contract, policy: record.policy };
  }

  private async runProbe(policy: AutomationPolicy): Promise<AutomationProbeReport> {
    if (this.options.probe) {
      const observed = await this.options.probe(policy);
      // An injected observation is normalised, never trusted to describe itself: fields the
      // assessment depends on are defaulted here so a partial snapshot cannot imply a fresher
      // reading than it is.
      if ("sources" in observed && Array.isArray((observed as AutomationProbeReport).sources)) return observed as AutomationProbeReport;
      return {
        ...observed,
        probeVersion: AUTOMATION_PROBE_VERSION,
        readOnly: true,
        policy: { policyId: policy.policyId, revision: policy.revision, version: policy.version },
        sources: [{
          source: "catalog", status: "ok", observedAt: observed.observedAt ?? null, expiresAt: null,
          entries: observed.models?.length ?? 0, detail: "The caller supplied this observation; it is not a local read of this process.",
          limitations: ["caller_supplied_observation"],
        }],
        coverage: {
          executors: observed.executors?.length ? "observed" : "unavailable",
          catalog: observed.models?.length ? "observed" : "missing",
          costEvidence: observed.models?.some((row) => row.valueKind === "reported") ? "executor_catalog" : "unavailable",
          tokenEstimates: observed.models?.some((row) => row.unit === "tokens" && row.valueKind !== "unavailable") ? "observed" : "unavailable",
          creditCache: "unavailable",
          taskAttribution: "unavailable",
        },
        limitations: ["caller_supplied_observation"],
      };
    }
    // No read surface is wired into this process. The executor is NOT assumed dispatchable and
    // the model is NOT assumed to cost nothing: this snapshot exists so the panel and the audit
    // can say why nothing was decided, not so a policy can proceed on an empty reading.
    const observedAt = iso(this.now());
    return {
      probeVersion: AUTOMATION_PROBE_VERSION,
      readOnly: true,
      observedAt,
      policy: { policyId: policy.policyId, revision: policy.revision, version: policy.version },
      executors: [],
      models: [],
      sources: [{
        source: "catalog", status: "unwired", observedAt: null, expiresAt: null, entries: 0,
        detail: "No read-only catalog observation is wired into this process; the saved policy is not evidence that its executor is dispatchable.",
        limitations: ["no_catalog_reader"],
      }],
      coverage: { executors: "unavailable", catalog: "missing", costEvidence: "unavailable", tokenEstimates: "unavailable", creditCache: "unavailable", taskAttribution: "unavailable" },
      limitations: ["no_catalog_reader", "saved_policy_is_not_an_observation"],
    };
  }

  private assessment(contract: SupportedTaskContract, policy: AutomationPolicy, probe: AutomationProbeResult): AutomationEvaluation {
    const now = this.now();
    const nowMs = now.getTime();
    const blocks: AutomationProblem[] = [];
    const limits: string[] = [];
    const execution = contractExecution(contract);
    const block = (code: string, field: string, message: string): void => { blocks.push({ code, field, message }); };

    if (policy.revokedAt) block(AUTOMATION_ERRORS.policyRevoked, "policy", "The saved policy was revoked.");
    if (Date.parse(policy.expiresAt) <= nowMs) block(AUTOMATION_ERRORS.policyExpired, "policy.expiresAt", "The saved policy expired.");

    let workspaceRealPath: string | null = null;
    try {
      workspaceRealPath = this.store.collaboration.getWorkspace(contract.workspaceId).realPath;
    } catch (error) {
      block("WORKSPACE_CONFLICT", "workspaceId", error instanceof Error ? error.message : "The workspace identity could not be verified.");
    }
    if (contract.workspaceId !== policy.workspaceId) block("SCOPE_VIOLATION", "workspaceId", "The task targets a different project than the saved policy.");
    try {
      this.store.collaboration.getWorkspace(policy.workspaceId);
    } catch (error) {
      block("WORKSPACE_CONFLICT", "policy.workspaceId", error instanceof Error ? error.message : "The saved policy workspace no longer matches its directory identity.");
    }
    if (!isSubset(contract.scope.allowedChanges, policy.scope.allowedChanges)) {
      block("SCOPE_VIOLATION", "scope.allowedChanges", "The task asks for changes outside the saved policy scope.");
    }
    if (!isSubset(contract.scope.permittedMetadata, policy.scope.permittedMetadata)) {
      block("SCOPE_VIOLATION", "scope.permittedMetadata", "The task asks for metadata outside the saved policy scope.");
    }
    if (!sameSelection(execution, policy.executor)) {
      block("MODEL_POLICY_BLOCKED", "execution", "The proposed executor, connection, provider, model or reasoning differs from the saved policy.");
    }
    if (contract.timeoutSeconds > policy.maxTimeoutSeconds) block("DEADLINE_EXCEEDED", "timeoutSeconds", "The task duration exceeds the saved policy.");
    if (contract.timeoutSeconds > policy.maxAttempts * policy.maxTimeoutSeconds) limits.push("attempts_share_the_same_deadline");
    if (nowMs + contract.timeoutSeconds * 1000 > Date.parse(policy.expiresAt)) {
      block("DEADLINE_EXCEEDED", "policy.expiresAt", "The saved policy would expire before this task could finish.");
    }
    if (contract.maxAttempts > policy.maxAttempts) block("ATTEMPT_LIMIT", "maxAttempts", "The task asks for more attempts than the saved policy allows.");

    const livePolicy: ModelPolicy = this.store.collaboration.currentPolicy(defaultModelPolicy(3));
    let historyBlocked = false;
    try {
      enforceModelPolicy(livePolicy, execution);
    } catch (error) {
      historyBlocked = true;
      block("MODEL_POLICY_BLOCKED", "history", error instanceof Error ? error.message : "The installed model policy blocks this selection.");
    }
    if (livePolicy.requireFree) limits.push("history_require_free");
    if (livePolicy.selectionMode === "allowlist" && livePolicy.allowed.length > 0) limits.push("history_allowlist");

    let roundsUsed = 0;
    try {
      roundsUsed = this.roundsUsed(policy, nowMs);
    } catch {
      block("ATTEMPT_LIMIT", "rounds", "The decision history could not be read.");
    }
    if (roundsUsed >= policy.maxTasksPerWindow) block("ATTEMPT_LIMIT", "rounds", `The saved policy allows ${policy.maxTasksPerWindow} tasks per ${policy.windowSeconds}s and that window is full.`);

    try {
      const occupant = this.store.operations.occupant();
      if (occupant) block("EXECUTOR_BUSY", "capacity", "The shared executor slot is occupied by another workflow.");
    } catch (error) {
      block("EXECUTOR_BUSY", "capacity", `Capacity could not be verified: ${error instanceof Error ? error.message : "unknown"}`);
    }
    try {
      if (this.store.get(contract.taskId)) block("TASK_CONFLICT", "taskId", "A task with this identifier already exists.");
    } catch {
      block("TASK_CONFLICT", "taskId", "The task table could not be read.");
    }

    const probeAt = Date.parse(probe.observedAt);
    if (!Number.isFinite(probeAt) || nowMs - probeAt > PROBE_FRESH_MS || probeAt - nowMs > PROBE_FUTURE_MS) {
      block("MODEL_UNVERIFIED", "probe.observedAt", "The executor/catalog observation is stale or from the future.");
    }
    // A read surface that failed is its own reason. Folding it into "model missing" would hide
    // the difference between "the catalog does not list this model" and "nothing could be read".
    const probeReport = probe as AutomationProbeReport;
    for (const source of probeReport.sources ?? []) {
      if (source.source !== "catalog" || source.status === "ok") continue;
      const field = `probe.${source.source}`;
      if (blocks.some((entry) => entry.field === field)) continue;
      blocks.push({
        code: AUTOMATION_ERRORS.observationUnavailable, field,
        message: `The executor/model catalog was not observed (${source.status}): ${source.detail}`,
      });
    }
    const executorRow = probe.executors.find((row) => row.executorId === policy.executor.executorId && row.connectionId === policy.executor.connectionId && row.providerId === policy.executor.providerId);
    if (!executorRow) block("EXECUTOR_UNAVAILABLE", "executor", "The saved executor/connection is not in the current catalog.");
    else if (!executorRow.online || !executorRow.dispatchable) block("EXECUTOR_UNAVAILABLE", "executor", `The saved executor is not dispatchable (${executorRow.evidence}).`);
    // R3: a catalog lists the same model once per reported reasoning effort. Picking the first row
    // by model identity and then asking whether *that* row mentions the saved effort makes the
    // decision depend on catalog order, and silently substitutes a neighbour effort. Group by model
    // identity first, keep every row as its own evidence, then resolve the saved effort.
    const identityRows = probe.models.filter((row) => row.executorId === policy.executor.executorId && row.connectionId === policy.executor.connectionId &&
      row.providerId === policy.executor.providerId && row.modelId === policy.executor.modelId);
    const availableEfforts = [...new Set(identityRows.flatMap((row) => row.reasoningEfforts))];
    const effortMatched = policy.executor.reasoningEffort === null
      ? identityRows.length > 0
      : identityRows.some((row) => row.reasoningEfforts.includes(policy.executor.reasoningEffort));
    const modelRow = identityRows.find((row) => row.reasoningEfforts.includes(policy.executor.reasoningEffort)) ?? identityRows[0];
    if (!identityRows.length) block("MODEL_UNVERIFIED", "model", "The exact model is not in the current catalog.");
    else {
      if (!modelRow || modelRow.catalogState !== "available") block("MODEL_UNVERIFIED", "model", "The exact model is missing from the catalog.");
      if (!effortMatched) {
        block("MODEL_UNVERIFIED", "executor.reasoningEffort",
          `The model does not report the saved reasoning effort${policy.executor.reasoningEffort === null ? "" : ` (${policy.executor.reasoningEffort})`}; reported: ${availableEfforts.map((value) => value ?? "none").join(", ") || "none"}.`);
      }
      const modelAt = Date.parse(modelRow?.observedAt ?? "");
      if (!Number.isFinite(modelAt) || nowMs - modelAt > PROBE_FRESH_MS) block("QUOTA_UNAVAILABLE", "cost.observedAt", "The quota observation is stale.");
      if (modelRow?.expiresAt && Date.parse(modelRow.expiresAt) <= nowMs) block("QUOTA_UNAVAILABLE", "cost.expiresAt", "The quota observation expired.");
    }

    // R2: rate, balance and hard cap are three different capabilities. A catalog multiplier proves a
    // rate; it says nothing about how much is left. Only a balance that names its unit, and whose
    // source routes the number to this executor/connection/model, may stand behind a cost threshold.
    const rate = modelRow?.rate ?? {
      kind: (typeof modelRow?.credits === "string" ? "reported" : "unavailable") as "reported" | "unavailable",
      value: typeof modelRow?.credits === "string" ? modelRow.credits : null,
    };
    const balance = modelRow?.balance ?? (modelRow && modelRow.remaining !== null
      ? {
        kind: (modelRow.valueKind === "reported" ? "reported" : modelRow.valueKind === "estimated" ? "estimated" : "unavailable") as "reported" | "estimated" | "unavailable",
        unit: modelRow.unit,
        remaining: modelRow.remaining,
        routing: (modelRow.valueKind === "reported" ? "verified" : "unverified") as "verified" | "unverified",
        source: modelRow.valueKind === "reported" ? "probe" : null,
      }
      : { kind: "unavailable" as const, unit: modelRow?.unit ?? policy.cost.unit, remaining: null as number | null, routing: "unverified" as const, source: null as string | null });
    const evidence = balance.kind === "unavailable" ? "unavailable" as const : balance.kind;
    const remaining = balance.remaining;
    const hardCapSupported = modelRow?.hardCap === "reported";
    const unitMatches = Boolean(modelRow) && balance.unit === policy.cost.unit;
    const verifiedBalances = identityRows.filter((row) => row.balance?.routing === "verified" && row.balance.remaining !== null);
    const distinctBalances = new Set(verifiedBalances.map((row) => `${row.balance!.source ?? "unknown"}:${row.balance!.remaining}`));
    let note = "";
    if (policy.cost.mode === "free_only") {
      note = "free_only proves a reported x0.00 rate for the exact model.";
      if (!modelRow || rate.kind === "unavailable" || modelRow.freshness !== "fresh") block("QUOTA_UNAVAILABLE", "cost", "A free-only policy needs a fresh reported rate.");
      else if (!FREE_CREDITS.test(rate.value ?? "")) block("MODEL_UNVERIFIED", "cost.credits", "The model rate is not a proven x0.00.");
      if (modelRow && !unitMatches) {
        block("COST_CONTROL_UNAVAILABLE", "cost.unit", `The saved balance is in ${balance.unit} while the policy is in ${policy.cost.unit}; the two numbers are not comparable.`);
        limits.push("cost_unit_mismatch");
      }
    } else if (policy.cost.mode === "known_cost") {
      note = "known_cost needs a reported per-model balance with a named unit and verified routing; a catalog multiplier is only a rate.";
      if (!modelRow || balance.kind === "unavailable" || remaining === null || modelRow.freshness !== "fresh") {
        block("QUOTA_UNAVAILABLE", "cost", "A known-cost policy needs a fresh reported balance for this exact model; a multiplier alone is not a balance.");
      }
      if (balance.routing !== "verified") {
        block("COST_CONTROL_UNAVAILABLE", "cost.routing", "The saved balance is not routed to this executor/connection/model; a shared pool cannot satisfy known_cost.");
        limits.push("cost_routing_unverified");
      }
      if (modelRow && !unitMatches) {
        block("COST_CONTROL_UNAVAILABLE", "cost.unit", `The saved balance is in ${balance.unit} while the policy is in ${policy.cost.unit}; the two numbers are not compared.`);
        limits.push("cost_unit_mismatch");
      }
      if (distinctBalances.size > 1) {
        block("COST_CONTROL_UNAVAILABLE", "cost.source", "More than one verified balance claims this model; name one source before a known-cost decision.");
        limits.push("cost_source_ambiguous");
      }
      if (policy.cost.requiresHardCap && !hardCapSupported) block("COST_CONTROL_UNAVAILABLE", "cost.hardCap", "The source cannot enforce a hard spending cap for this model.");
      if (policy.cost.requiresHardCap && !hardCapSupported && modelRow?.hardCap === "unsupported") limits.push("paid_source_without_hard_cap_refused");
      if (remaining !== null && remaining <= 0) block("QUOTA_EXHAUSTED", "cost.remaining", "The reported balance is exhausted.");
      else if (remaining !== null && unitMatches && policy.cost.ceiling !== null && remaining < policy.cost.ceiling) {
        block("QUOTA_EXHAUSTED", "cost.remaining", "The reported balance cannot cover the per-task ceiling.");
      }
    } else {
      note = "unknown_allowed accepts an unknown price; it is not a hard spending limit.";
      limits.push("cost_unknown_not_a_hard_cap");
      if (policy.cost.requiresHardCap) block("COST_CONTROL_UNAVAILABLE", "cost.hardCap", "An unknown price cannot satisfy a requested hard cap.");
      if (remaining !== null && remaining <= 0) block("QUOTA_EXHAUSTED", "cost.remaining", "The reported balance is exhausted.");
      if (modelRow && !unitMatches) limits.push("cost_unit_mismatch");
    }

    const candidate: AutomationCandidate = {
      execution, status: blocks.length === 0 ? "candidate" : "excluded", blocks: blocks.slice(), limits: limits.slice(),
      cost: { evidence, remaining, unit: modelRow?.unit ?? policy.cost.unit, hardCapSupported },
    };
    const candidates: AutomationCandidate[] = [candidate];
    for (const row of probe.models) {
      const other: ExecutionSelection = { executorId: row.executorId, connectionId: row.connectionId, providerId: row.providerId, modelId: row.modelId, reasoningEffort: policy.executor.reasoningEffort };
      if (sameSelection(other, policy.executor)) continue;
      candidates.push({
        execution: other, status: "excluded",
        blocks: [{ code: "MODEL_POLICY_BLOCKED", field: "executor", message: "This model is outside the saved policy; save a new policy to use it." }],
        limits: [], cost: { evidence: row.valueKind, remaining: row.remaining, unit: row.unit, hardCapSupported: row.hardCap === "reported" },
      });
    }

    return {
      policyId: policy.policyId, policyRevision: policy.revision, policyVersion: policy.version,
      decision: blocks.length === 0 ? "delegate" : "wait", blocks, limits, candidates,
      cost: { mode: policy.cost.mode, unit: policy.cost.unit, ceiling: policy.cost.ceiling, evidence, remaining, hardCapSupported, note },
      rounds: { used: roundsUsed, limit: policy.maxTasksPerWindow, windowSeconds: policy.windowSeconds },
      history: { requireFree: livePolicy.requireFree, selectionMode: livePolicy.selectionMode ?? "allowlist", allowed: livePolicy.allowed.length, source: "live_policy", blocked: historyBlocked },
      scope: { workspaceId: contract.workspaceId, workspaceRealPath, allowedChanges: policy.scope.allowedChanges, permittedMetadata: policy.scope.permittedMetadata },
      expiresAt: policy.expiresAt, observedAt: iso(now), probeObservedAt: probe.observedAt,
      probe: {
        probeVersion: probeReport.probeVersion ?? AUTOMATION_PROBE_VERSION,
        observedAt: probe.observedAt,
        sources: probeReport.sources ?? [],
        coverage: probeReport.coverage ?? null,
        limitations: probeReport.limitations ?? [],
      },
    };
  }

  private roundsUsed(policy: AutomationPolicy, nowMs: number): number {
    const since = new Date(nowMs - policy.windowSeconds * 1000).toISOString();
    const row = this.database().prepare("SELECT COUNT(*) AS total FROM automation_decisions WHERE policy_id=? AND status IN ('executing','dispatched','outcome_unknown') AND created_at > ?").get(policy.policyId, since) as { total?: number } | undefined;
    return Number(row?.total ?? 0);
  }

  private assertPolicyLive(policy: AutomationPolicy): void {
    const current = this.readPolicy(policy.policyId, policy.revision);
    if (current.revokedAt) fail(AUTOMATION_ERRORS.policyRevoked, "The saved policy was revoked.");
    if (Date.parse(current.expiresAt) <= this.now().getTime()) fail(AUTOMATION_ERRORS.policyExpired, "The saved policy expired.");
    if (digestOf(current) !== digestOf(policy)) fail("POLICY_CHANGED", "The saved policy changed after this decision was recorded.");
  }

  private assertRounds(policy: AutomationPolicy): void {
    if (this.roundsUsed(policy, this.now().getTime()) >= policy.maxTasksPerWindow) {
      fail("ATTEMPT_LIMIT", `The saved policy allows ${policy.maxTasksPerWindow} tasks per ${policy.windowSeconds}s and that window is full.`);
    }
  }

  private assertCapacityFree(): void {
    let occupant: unknown = null;
    try {
      occupant = this.store.operations.occupant();
    } catch (error) {
      fail("EXECUTOR_BUSY", `Capacity could not be verified: ${error instanceof Error ? error.message : "unknown"}`);
    }
    if (occupant) fail("EXECUTOR_BUSY", "The shared executor slot is occupied by another workflow.");
  }

  private effectUnknown(operationId: string, error: unknown): boolean {
    if (error instanceof AdmissionError && error.code === "OUTCOME_UNKNOWN") return true;
    try {
      const operation = this.store.operations.get(operationId);
      return operation !== null && (operation.state === "outcome_unknown" || operation.state === "effect_started");
    } catch {
      // No persisted intent under this operationId: the send was rejected before it could record one.
      return false;
    }
  }

  private planReason(decision: AutomationDecision, policy: AutomationPolicy, evaluation: AutomationEvaluation): string {
    const codes = evaluation.blocks.map((block) => block.code).join(",") || "none";
    return `Automatic decision ${decision.decisionId} under saved policy ${policy.policyId}@${policy.revision.slice(0, 8)}: ` +
      `cost=${policy.cost.mode}/${evaluation.cost.evidence}, rounds=${evaluation.rounds.used}/${evaluation.rounds.limit}, blocks=${codes}.`.slice(0, 1900);
  }

  private planTtl(policy: AutomationPolicy): number {
    const remaining = Math.floor((Date.parse(policy.expiresAt) - this.now().getTime()) / 1000);
    return Math.max(1, Math.min(1800, remaining));
  }

  private blockDecision(decisionId: string, evaluation: AutomationEvaluation): void {
    const decision = this.getDecision(decisionId);
    this.store.atomic(() => {
      this.writeDecision({ ...decision, status: "blocked", evaluation, blockedCode: evaluation.blocks[0]?.code ?? null, blockedMessage: evaluation.blocks[0]?.message ?? null, updatedAt: iso(this.now()) });
      this.appendAudit({
        action: "decision_blocked_at_dispatch", actor: "automation", source: `automation:${decision.policyId}`, policyId: decision.policyId, decisionId,
        detail: { blocks: evaluation.blocks.map((block) => block.code) },
      });
    });
  }

  private writeDecision(decision: AutomationDecision): void {
    this.database().prepare("UPDATE automation_decisions SET status=?, plan_id=?, effect_operation=?, updated_at=?, digest=?, body_json=? WHERE decision_id=?")
      .run(decision.status, decision.planId, decision.operationId, decision.updatedAt, digestOf(decision), JSON.stringify(decision), decision.decisionId);
  }

  private appendAudit(entry: { action: string; actor: string; source: string; policyId: string | null; decisionId: string | null; detail: unknown }): void {
    this.database().prepare("INSERT INTO automation_audit (policy_id,decision_id,action,actor,source,detail_json,at) VALUES (?,?,?,?,?,?,?)")
      .run(entry.policyId, entry.decisionId, entry.action, entry.actor.slice(0, 120), entry.source.slice(0, 160), JSON.stringify(entry.detail ?? null).slice(0, 4000), iso(this.now()));
  }
}

export type { AutomationPlanBinding };

// ------------------------------------------------------------------ D02 probe

/**
 * The read surfaces the probe composes. Each one is optional on purpose: a composition root that
 * cannot offer a surface must say so, and the probe reports `unwired` instead of inventing a value.
 */
export interface AutomationProbeCatalogReader {
  (): DesktopCatalogSource | Promise<DesktopCatalogSource>;
}

export interface AutomationReadOnlyProbeOptions {
  /** The existing visible executor/model catalog. The CLI passes desktopModelCatalog(config, env). */
  catalog?: AutomationProbeCatalogReader;
  /** SQLite handle that holds the saved quota/credit resource tables (the task database in production). */
  db?: DatabaseSync;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Optional live executor read. A saved resource declaration is never promoted into liveness. */
  liveness?: () => AutomationProbeExecutor[] | Promise<AutomationProbeExecutor[]>;
}

export interface AutomationReadOnlyProbe {
  (policy: AutomationPolicy): Promise<AutomationProbeReport>;
  readonly kind: "read_only_local";
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * Compose one read-only observation out of the evidence this machine already has.
 *
 * Rules the implementation keeps, because the assessment trusts its output:
 *   - Only a catalog read may say an executor is dispatchable. A declared resource connection is a
 *     declaration (`declaration_only`, `no_upstream_probe`), so it never becomes an executor row.
 *   - Only the exact model id may receive a pool number. A quota row for another model is not
 *     "close enough", and an unavailable value is not zero.
 *   - Every row keeps the time its *source* observed it, so an old snapshot cannot be presented as
 *     a live reading: the assessment compares each row's own timestamp against its freshness bound.
 *   - A failed surface stays in `sources` with its reason, so the decision can say why it waited.
 */
export function createReadOnlyProbe(options: AutomationReadOnlyProbeOptions = {}): AutomationReadOnlyProbe {
  const read = async (policy: AutomationPolicy): Promise<AutomationProbeReport> => {
    const now = options.now?.() ?? new Date();
    const at = iso(now);
    const env = options.env ?? process.env;
    const sources: AutomationProbeSourceState[] = [];
    const limitations: string[] = [];

    // 1. Declared resource connections. Declaration only: it says what exists, never that it works.
    let declared: ResourceConnectionDocument | null = null;
    try {
      declared = readResourceConnections(env);
      const declaredOk = declared.status === "declared";
      sources.push({
        source: "connections",
        status: declaredOk ? "ok" : declared.status === "invalid_file" ? "unreadable" : "not_declared",
        observedAt: at, expiresAt: null, entries: declared.connections.length,
        detail: declaredOk
          ? `${declared.connections.length} resource connection(s) declared via ${declared.declaredVia}; a declaration does not verify routing or availability.`
          : declared.status === "invalid_file"
            ? `The resource-connection document could not be used (${declared.fileDiagnostics.map((item) => item.code).join(",") || "no diagnostic"}).`
            : `No resource connection is declared via ${declared.declaredVia}.`,
        limitations: [...declared.limitations],
      });
      if (declared.conflicts.length) limitations.push("resource_connection_conflicts");
      if (declared.connections.some((item) => item.status !== "declared")) limitations.push("resource_connection_not_clean");
    } catch (error) {
      sources.push({
        source: "connections", status: "unreadable", observedAt: null, expiresAt: null, entries: 0,
        detail: `The resource-connection registry could not be read: ${describeError(error)}`, limitations: ["registry_unreadable"],
      });
      limitations.push("resource_connection_registry_unreadable");
    }

    // 2 + 3. Saved token estimates and the saved credit cache. Both come from the same database and
    // both refuse to translate a missing table into "no quota configured".
    let quota: ReturnType<typeof readQuotaResources> | null = null;
    let credit: ReturnType<typeof readCreditBalances> | null = null;
    if (!options.db) {
      for (const source of ["quota", "credit"] as const) {
        sources.push({
          source, status: "unwired", observedAt: null, expiresAt: null, entries: 0,
          detail: "No resource database handle is available in this composition root.", limitations: ["no_resource_database"],
        });
      }
      limitations.push("cost_evidence_unavailable_no_resource_database");
    } else {
      try {
        quota = readQuotaResources(options.db);
        const fresh = quota.connections.filter((item) => item.freshness === "fresh");
        sources.push({
          source: "quota", status: quota.observations.length ? (fresh.length ? "ok" : "stale") : quota.connections.length ? "missing" : "not_declared",
          observedAt: fresh[0]?.sourceObservedAt ?? fresh[0]?.collectedAt ?? null,
          expiresAt: fresh[0]?.expiresAt ?? null,
          entries: quota.observations.length,
          detail: quota.observations.length
            ? `${quota.observations.length} saved token estimate(s) across ${quota.connections.length} connection(s); attribution=${quota.attribution}.`
            : "No saved token estimate exists; this is not a zero balance.",
          limitations: ["shared_pool", "budget_estimated", "task_attribution_unavailable"],
        });
        if (quota.observations.length && !fresh.length) limitations.push("token_estimates_stale");
      } catch (error) {
        sources.push({
          source: "quota", status: "unreadable", observedAt: null, expiresAt: null, entries: 0,
          detail: `Saved token estimates could not be read: ${describeError(error)}`, limitations: ["quota_storage_unreadable"],
        });
        limitations.push("token_estimates_unreadable");
      }
      try {
        credit = readCreditBalances(options.db);
        const observed = credit.connections.filter((item) => item.status === "observed");
        const fresh = observed.filter((item) => item.cacheFreshness === "fresh");
        sources.push({
          source: "credit",
          status: credit.balances.length ? (fresh.length ? "ok" : "stale") : credit.connections.length ? "missing" : "not_declared",
          observedAt: credit.balances[0]?.latestMemberObservedAt ?? credit.balances[0]?.collectedAt ?? null,
          expiresAt: credit.balances[0]?.cacheExpiresAt ?? null,
          entries: credit.balances.length,
          detail: credit.balances.length
            ? `${credit.balances.length} saved region credit cache row(s); coverage in the source is ${credit.balances[0]?.coverage ?? "unknown"}.`
            : "No saved credit balance exists; unknown price is not a zero price.",
          limitations: ["shared_region_pool", "routing_unverified", "task_attribution_unavailable"],
        });
        if (credit.balances.length && !fresh.length) limitations.push("credit_cache_stale");
      } catch (error) {
        sources.push({
          source: "credit", status: "unreadable", observedAt: null, expiresAt: null, entries: 0,
          detail: `Saved credit balances could not be read: ${describeError(error)}`, limitations: ["credit_storage_unreadable"],
        });
        limitations.push("credit_balance_unreadable");
      }
    }

    // 4. The executor/model catalog: the only surface allowed to make an executor dispatchable.
    let catalog: DesktopCatalogSource | null = null;
    if (!options.catalog) {
      sources.push({
        source: "catalog", status: "unwired", observedAt: null, expiresAt: null, entries: 0,
        detail: "No catalog reader is wired into this composition root; nothing here may claim the executor is dispatchable.",
        limitations: ["no_catalog_reader"],
      });
      limitations.push("no_catalog_reader");
    } else {
      try {
        catalog = await options.catalog();
        const rows = Array.isArray(catalog.models) ? catalog.models : [];
        sources.push({
          source: "catalog", status: rows.length ? "ok" : "missing", observedAt: at, expiresAt: null, entries: rows.length,
          detail: rows.length
            ? `${rows.length} catalog row(s); pricing verified for ${rows.filter((row) => row.pricingVerified).length}.`
            : `The catalog returned no model; diagnostics: ${(catalog.diagnostics ?? []).map((item) => `${item.source}/${item.code}`).join(",") || "none"}.`,
          limitations: rows.some((row) => !row.pricingVerified) ? ["pricing_unverified_for_some_rows"] : [],
        });
        for (const diagnostic of catalog.diagnostics ?? []) limitations.push(`catalog_diagnostic:${diagnostic.source}:${diagnostic.code}`);
        if (!rows.length) limitations.push("catalog_empty");
      } catch (error) {
        sources.push({
          source: "catalog", status: "unavailable", observedAt: null, expiresAt: null, entries: 0,
          detail: `The executor/model catalog could not be read: ${describeError(error)}`, limitations: ["catalog_unavailable"],
        });
        limitations.push("catalog_unavailable");
      }
    }

    const poolFor = (modelId: string): { unit: "credit" | "tokens"; valueKind: "reported" | "estimated"; remaining: number | null; observedAt: string; expiresAt: string | null; evidence: string } | null => {
      // An exact model id match on a fresh saved estimate. Never another model's number.
      for (const row of quota?.observations ?? []) {
        if (row.modelId !== modelId || row.valueKind === "unavailable") continue;
        const connection = quota?.connections.find((item) => item.connectionId === row.connectionId);
        if (connection && connection.freshness !== "fresh") continue;
        return {
          unit: "tokens", valueKind: "estimated", remaining: row.remaining,
          observedAt: row.sourceObservedAt ?? row.collectedAt, expiresAt: connection?.expiresAt ?? null,
          evidence: `quota:${row.connectionId}`,
        };
      }
      // The saved credit cache is a region pool, not a per-model balance: a credit connection may
      // not even declare a model restriction, so promoting its number onto one model row would
      // invent an attribution the source never made. It stays a region-level surface instead.
      return null;
    };

    const models: AutomationProbeModel[] = [];
    const executors: AutomationProbeExecutor[] = [];
    const seenExecutors = new Set<string>();
    for (const row of catalog?.models ?? []) {
      const execution = row.execution;
      const executorKey = `${execution.executorId}:${execution.connectionId}:${execution.providerId}`;
      if (!seenExecutors.has(executorKey)) {
        seenExecutors.add(executorKey);
        executors.push({
          executorId: execution.executorId, connectionId: execution.connectionId, providerId: execution.providerId,
          online: true, dispatchable: true,
          evidence: `${execution.executorId === "dsh" ? "dsh_catalog" : "workbuddy_catalog"}:read_only`,
          observedAt: at,
          capabilities: execution.executorId === "dsh" ? ["dsh_bridge_prompt", "per_host_session"] : ["desktop_queue_send", "native_session"],
        });
      }
      const pool = poolFor(execution.modelId);
      const reportedRate = row.pricingVerified && typeof row.credits === "string";
      models.push({
        executorId: execution.executorId, connectionId: execution.connectionId, providerId: execution.providerId,
        modelId: execution.modelId, reasoningEfforts: [execution.reasoningEffort],
        credits: typeof row.credits === "string" ? row.credits : null,
        remaining: pool?.remaining ?? null,
        unit: pool?.unit ?? policy.cost.unit,
        valueKind: reportedRate ? "reported" : pool ? pool.valueKind : "unavailable",
        freshness: "fresh",
        hardCap: "unsupported",
        catalogState: "available",
        observedAt: pool?.observedAt ?? at,
        expiresAt: pool?.expiresAt ?? null,
        // A verified multiplier is a rate. A saved pool is a balance, but it is a shared gateway
        // pool without verified routing, so it can never satisfy `known_cost` on its own.
        rate: { kind: reportedRate ? "reported" : "unavailable", value: typeof row.credits === "string" ? row.credits : null },
        balance: pool
          ? { kind: pool.valueKind, unit: pool.unit, remaining: pool.remaining, routing: "unverified", source: pool.evidence }
          : { kind: "unavailable", unit: policy.cost.unit, remaining: null, routing: "unverified", source: null },
      });
    }

    if (options.liveness) {
      try {
        const live = await options.liveness();
        for (const row of live) {
          const key = `${row.executorId}:${row.connectionId}:${row.providerId}`;
          const index = executors.findIndex((item) => `${item.executorId}:${item.connectionId}:${item.providerId}` === key);
          if (index >= 0) executors[index] = row; else executors.push(row);
        }
        sources.push({
          source: "liveness", status: live.length ? "ok" : "missing", observedAt: at, expiresAt: null, entries: live.length,
          detail: live.length ? `${live.length} live executor row(s) from the local executor registry.` : "The executor registry reported no live host.",
          limitations: [],
        });
        if (!live.length) limitations.push("no_live_executor_registered");
      } catch (error) {
        sources.push({
          source: "liveness", status: "unavailable", observedAt: null, expiresAt: null, entries: 0,
          detail: `The executor registry could not be read: ${describeError(error)}`, limitations: ["liveness_unavailable"],
        });
        limitations.push("liveness_unavailable");
      }
    }

    const catalogRows = catalog?.models ?? [];
    const costEvidence: AutomationProbeCoverage["costEvidence"] =
      catalogRows.some((row) => row.pricingVerified && typeof row.credits === "string") ? "executor_catalog"
        : (quota?.observations.length ?? 0) + (credit?.balances.length ?? 0) > 0 ? "gateway_pool" : "unavailable";
    if (costEvidence === "gateway_pool") limitations.push("cost_evidence_is_a_shared_pool_not_task_attribution");
    // A credit cache is one region-wide pool across accounts; it is reported, never spent as one model's balance.
    if ((credit?.balances.length ?? 0) > 0) limitations.push("credit_balance_is_a_region_pool_not_a_model_balance");

    return {
      probeVersion: AUTOMATION_PROBE_VERSION,
      readOnly: true,
      observedAt: at,
      policy: { policyId: policy.policyId, revision: policy.revision, version: policy.version },
      executors,
      models,
      sources,
      coverage: {
        executors: executors.length ? "observed" : "unavailable",
        catalog: catalogRows.length ? "observed" : declared?.connections.length ? "declared_only" : "missing",
        costEvidence,
        tokenEstimates: (quota?.observations.length ?? 0) > 0 ? "observed" : "unavailable",
        creditCache: (credit?.balances.length ?? 0) === 0 ? "unavailable" : credit!.connections.some((item) => item.cacheFreshness === "fresh") ? "observed" : "stale",
        taskAttribution: "unavailable",
      },
      limitations: [...new Set(limitations)],
    };
  };
  return Object.assign(read, { kind: "read_only_local" as const });
}
