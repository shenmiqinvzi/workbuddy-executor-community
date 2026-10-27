/**
 * The immutable initial task contract.
 *
 * A contract records what was agreed before any work started: the goal, the
 * workspace, the files that may change, the required checks, the model and the
 * attempt budget. It is stored once, under a server-generated agreement
 * version, and never updated.
 *
 * What a stored contract proves: these terms were submitted, validated and
 * persisted for this task. It does not prove that a scope check ran, that the
 * model policy was verified, that any check executed, or that independent
 * review passed. Those stay separate facts, and this module never claims them.
 *
 * `submissionHash` in the task row is NOT an agreement version: it is a
 * normalized initial-submission digest from an older design with no field
 * binding. It is never converted into a contract.
 */

import crypto from "node:crypto";

/** The only contract schema version this build accepts. */
export const TASK_CONTRACT_SCHEMA_VERSION = "workbuddy-executor/vnext-1";
export const TASK_CONTRACT_V2_SCHEMA_VERSION = "workbuddy-executor/vnext-2";

export interface ExecutionSelection {
  executorId: "workbuddy" | "dsh";
  connectionId: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string | null;
}

export interface NormalizedTaskContractV2 extends Omit<NormalizedTaskContract, "model"> {
  execution: ExecutionSelection;
  collaboration: { planId: string; expectedPlanRevision: string };
}

export type SupportedTaskContract = NormalizedTaskContract | NormalizedTaskContractV2;

/**
 * Server policy for the attempt budget.
 *
 * Supplied by the service that owns the configuration, never read from the
 * environment inside the storage layer and never accepted from a client. The
 * effective limit is min(request, policy) so a request can only lower its own
 * budget.
 */
export interface TaskContractPolicy {
  maxAttempts: number;
}

/**
 * The one place the policy is derived from the service configuration, so the
 * contract and the coordinator's retry limit cannot disagree.
 */
export function policyFromConfig(config: { maxTaskAttempts?: number }): TaskContractPolicy {
  const configured = config.maxTaskAttempts;
  const maxAttempts = typeof configured === "number" && Number.isInteger(configured) && configured >= 1 ? configured : 3;
  return { maxAttempts };
}

/** Documented limits from the interface contract, section 2. */
export const TASK_CONTRACT_LIMITS = Object.freeze({
  titleCharacters: 120,
  objectiveCharacters: 100_000,
  scopeItems: 100,
  requiredChecks: 100,
  serializedBytes: 1024 * 1024,
  checkIdCharacters: 100,
  checkDefinitionCharacters: 2_000,
  identifierCharacters: 200,
  timeoutSeconds: 86_400,
});

export type TaskCheckKind = "command" | "semantic";

export interface TaskContractCheck {
  id: string;
  kind: TaskCheckKind;
  definition: string;
}

export interface TaskContractScope {
  allowedChanges: string[];
  permittedMetadata: string[];
}

/** A validated, canonically ordered contract. */
export interface NormalizedTaskContract {
  schemaVersion: string;
  taskId: string;
  workspaceId: string;
  title: string;
  objective: string;
  model: string;
  timeoutSeconds: number;
  maxAttempts: number;
  scope: TaskContractScope;
  requiredChecks: TaskContractCheck[];
}

/** Stable rejection codes. A code never changes meaning once published. */
export type TaskContractRejectionCode =
  | "not_an_object"
  | "unknown_field"
  | "unsupported_schema_version"
  | "invalid_type"
  | "invalid_length"
  | "invalid_value"
  | "too_many_items"
  | "duplicate_check_id"
  | "invalid_scope_path"
  | "check_conclusion_not_allowed"
  | "too_large"
  | "task_mismatch"
  | "objective_mismatch";

export interface TaskContractRejection {
  code: TaskContractRejectionCode;
  field: string;
  message: string;
}

export type TaskContractValidation =
  | { ok: true; contract: NormalizedTaskContract; contractHash: string }
  | { ok: false; rejection: TaskContractRejection };

const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion",
  "taskId",
  "workspaceId",
  "title",
  "objective",
  "model",
  "timeoutSeconds",
  "maxAttempts",
  "scope",
  "requiredChecks",
]);
const SCOPE_FIELDS = new Set(["allowedChanges", "permittedMetadata"]);
const CHECK_FIELDS = new Set(["id", "kind", "definition"]);

/**
 * Keys a client might use to assert a result instead of describing a check.
 * A definition is a description, never a verdict, and no actor may be claimed.
 */
const FORBIDDEN_CHECK_FIELDS = new Set([
  "actor",
  "passed",
  "status",
  "verified",
  "result",
  "conclusion",
  "checkedAt",
  "evidenceRefs",
  "inputHashes",
  "checkerVersion",
]);

function reject(code: TaskContractRejectionCode, field: string, message: string): TaskContractValidation {
  return { ok: false, rejection: { code, field, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checkUnknownFields(value: Record<string, unknown>, allowed: Set<string>, field: string): TaskContractRejection | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      return { code: "unknown_field", field: `${field}.${key}`, message: `Unknown field ${field}.${key}.` };
    }
  }
  return null;
}

function text(value: unknown, field: string, max: number): { value: string } | { rejection: TaskContractRejection } {
  if (typeof value !== "string") return { rejection: { code: "invalid_type", field, message: `${field} must be a string.` } };
  // Natural language is stored exactly as submitted: only the emptiness and
  // length checks look at the trimmed form.
  const trimmed = value.trim();
  if (!trimmed.length) return { rejection: { code: "invalid_value", field, message: `${field} must not be empty.` } };
  if (value.length > max) return { rejection: { code: "invalid_length", field, message: `${field} must be at most ${max} characters.` } };
  return { value };
}

function positiveInteger(value: unknown, field: string, max: number): { value: number } | { rejection: TaskContractRejection } {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { rejection: { code: "invalid_type", field, message: `${field} must be an integer.` } };
  }
  if (value < 1 || value > max) {
    return { rejection: { code: "invalid_value", field, message: `${field} must be between 1 and ${max}.` } };
  }
  return { value };
}

/**
 * A scope path is either one exact workspace-relative file or a directory
 * tree ending in `/**`. Everything else is refused.
 *
 * This is a lexical check on the declaration only. It says nothing about
 * whether the path exists, who owns it or where it really resolves to; real
 * file attribution is checked later against a dispatch-time baseline.
 */
function scopePath(value: unknown, field: string): { value: string } | { rejection: TaskContractRejection } {
  if (typeof value !== "string") return { rejection: { code: "invalid_type", field, message: `${field} must be a string.` } };
  const raw = value.trim();
  if (!raw.length) return { rejection: { code: "invalid_value", field, message: `${field} must not be empty.` } };
  const normalized = raw.replaceAll("\\", "/");
  const invalid = (reason: string) => ({ rejection: { code: "invalid_scope_path" as const, field, message: `${field} ${reason}: ${raw}` } });

  if (normalized.startsWith("/")) return invalid("must be workspace-relative, not absolute");
  if (/^[A-Za-z]:/.test(normalized)) return invalid("must not name a drive");
  if (normalized.startsWith("//")) return invalid("must not be a UNC path");
  if (normalized.split("/").some(segment => segment === "..")) return invalid("must not contain '..'");
  if (normalized.split("/").some(segment => segment === "." || segment === "")) return invalid("must not contain empty or '.' segments");

  const tree = normalized.endsWith("/**");
  const pathPart = tree ? normalized.slice(0, -3) : normalized;
  if (!pathPart.length) return invalid("must name a directory before '/**'");
  // Only the trailing /** glob is supported. Any other metacharacter would be a
  // pattern this build cannot honour, so it is refused rather than approximated.
  if (/[*?[\]{}]/.test(pathPart)) return invalid("may only use a trailing '/**' glob");
  return { value: tree ? `${pathPart}/**` : pathPart };
}

function scopeList(value: unknown, field: string): { value: string[] } | { rejection: TaskContractRejection } {
  if (!Array.isArray(value)) return { rejection: { code: "invalid_type", field, message: `${field} must be an array.` } };
  if (value.length > TASK_CONTRACT_LIMITS.scopeItems) {
    return { rejection: { code: "too_many_items", field, message: `${field} must have at most ${TASK_CONTRACT_LIMITS.scopeItems} items.` } };
  }
  const items: string[] = [];
  for (const [index, entry] of value.entries()) {
    const parsed = scopePath(entry, `${field}[${index}]`);
    if ("rejection" in parsed) return parsed;
    items.push(parsed.value);
  }
  // Order carries no meaning for a path list, so it is sorted and de-duplicated.
  // That keeps equal declarations with different order on one digest.
  return { value: [...new Set(items)].sort() };
}

/** Additive scope parsing for non-contract callers; historical contract digests are unchanged. */
export function validateTaskScope(value: unknown): { ok: true; scope: TaskContractScope } | { ok: false; rejection: TaskContractRejection } {
  if (!isObject(value)) return { ok: false, rejection: { code: "invalid_type", field: "scope", message: "scope must be an object." } };
  const unknown = checkUnknownFields(value, SCOPE_FIELDS, "scope"); if (unknown) return { ok: false, rejection: unknown };
  const allowed = scopeList(value.allowedChanges, "scope.allowedChanges"), metadata = scopeList(value.permittedMetadata, "scope.permittedMetadata");
  if ("rejection" in allowed) return { ok: false, rejection: allowed.rejection };
  if ("rejection" in metadata) return { ok: false, rejection: metadata.rejection };
  return { ok: true, scope: { allowedChanges: allowed.value, permittedMetadata: metadata.value } };
}

function requiredChecks(value: unknown): { value: TaskContractCheck[] } | { rejection: TaskContractRejection } {
  if (!Array.isArray(value)) return { rejection: { code: "invalid_type", field: "requiredChecks", message: "requiredChecks must be an array." } };
  if (value.length > TASK_CONTRACT_LIMITS.requiredChecks) {
    return { rejection: { code: "too_many_items", field: "requiredChecks", message: `requiredChecks must have at most ${TASK_CONTRACT_LIMITS.requiredChecks} items.` } };
  }
  const checks: TaskContractCheck[] = [];
  const seen = new Set<string>();
  const fail = (code: TaskContractRejectionCode, field: string, message: string) => ({ rejection: { code, field, message } });
  for (const [index, entry] of value.entries()) {
    const field = `requiredChecks[${index}]`;
    if (!isObject(entry)) return fail("invalid_type", field, `${field} must be an object.`);
    // A conclusion-shaped key is reported specifically, before the generic
    // unknown-field rule, so the caller learns why it was refused.
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_CHECK_FIELDS.has(key)) {
        return fail("check_conclusion_not_allowed", `${field}.${key}`, `A check definition may not carry ${key}; a stored definition is not a result and no actor may be claimed.`);
      }
    }
    const unknown = checkUnknownFields(entry, CHECK_FIELDS, field);
    if (unknown) return { rejection: unknown };
    const id = text(entry.id, `${field}.id`, TASK_CONTRACT_LIMITS.checkIdCharacters);
    if ("rejection" in id) return id;
    if (seen.has(id.value)) return fail("duplicate_check_id", `${field}.id`, `Duplicate check id: ${id.value}.`);
    seen.add(id.value);
    if (entry.kind !== "command" && entry.kind !== "semantic") {
      return fail("invalid_value", `${field}.kind`, `${field}.kind must be "command" or "semantic".`);
    }
    const definition = text(entry.definition, `${field}.definition`, TASK_CONTRACT_LIMITS.checkDefinitionCharacters);
    if ("rejection" in definition) return definition;
    checks.push({ id: id.value, kind: entry.kind, definition: definition.value });
  }
  // Checks are a set keyed by id; ids are unique, so sorting by id is a total
  // order and the declared order stops affecting the digest.
  return { value: checks.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) };
}

/**
 * Canonical JSON: object keys sorted at every depth, arrays in the order the
 * normalization produced. Two inputs whose only difference is key order
 * therefore serialize identically.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(entry => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

/** The digest of a normalized contract. */
export function taskContractHash(contract: SupportedTaskContract): string {
  return crypto.createHash("sha256").update(canonicalJson(contract)).digest("hex");
}

/**
 * The server-generated agreement version.
 *
 * Derived from the task identity and the contract digest rather than from a
 * clock or a counter, so it is stable across restarts and can be recomputed.
 * Two tasks with identical terms still get different versions.
 */
export function agreementVersionFor(taskId: string, contractHash: string): string {
  return `av1-${crypto.createHash("sha256").update(`${taskId}\n${contractHash}`).digest("hex").slice(0, 32)}`;
}

/** The effective attempt budget: the smaller of the request and the policy. */
export function effectiveMaxAttempts(requested: number, policy: TaskContractPolicy): number {
  return Math.min(requested, policy.maxAttempts);
}

/** The immutable record as it is stored and read back. */
export interface PersistedTaskContract {
  taskId: string;
  /** Server-generated, stable for the life of the task, tied to the digest. */
  agreementVersion: string;
  contractHash: string;
  schemaVersion: string;
  contract: SupportedTaskContract;
  /** What the client asked for. */
  requestedMaxAttempts: number;
  /** What the server policy allows. Server-owned, never a request field. */
  policyMaxAttempts: number;
  /** The smaller of the two; the value any budget decision must use. */
  effectiveMaxAttempts: number;
  createdAt: string;
}

/** Build the record for a validated contract. */
export function persistedTaskContract(
  contract: SupportedTaskContract,
  contractHash: string,
  createdAt: string,
  policy: TaskContractPolicy,
): PersistedTaskContract {
  return {
    taskId: contract.taskId,
    agreementVersion: agreementVersionFor(contract.taskId, contractHash),
    contractHash,
    schemaVersion: contract.schemaVersion,
    contract,
    requestedMaxAttempts: contract.maxAttempts,
    policyMaxAttempts: policy.maxAttempts,
    effectiveMaxAttempts: effectiveMaxAttempts(contract.maxAttempts, policy),
    createdAt,
  };
}

/** Why a stored contract cannot be trusted. */
export type TaskContractIntegrityProblem =
  | "shape"
  | "identity"
  | "schema"
  | "digest"
  | "agreement_version"
  | "attempt_budget";

export interface TaskContractIntegrity {
  problem: TaskContractIntegrityProblem;
  detail: string;
}

/** The stored columns as they come back from the database. */
export interface StoredContractRow {
  taskId: string;
  agreementVersion: string;
  contractHash: string;
  schemaVersion: string;
  contract: unknown;
  requestedMaxAttempts: number;
  policyMaxAttempts: number;
  effectiveMaxAttempts: number;
  createdAt: string;
}

/**
 * Re-verify a stored contract instead of trusting it.
 *
 * A row is only usable when its content still validates, still belongs to this
 * task and schema, still hashes to the recorded digest, still derives the
 * recorded agreement version, and still carries budget metadata consistent with
 * its own terms. A record that fails any of these is reported as a specific
 * integrity problem: it is never returned as a normal contract and never
 * treated as "this task has no contract".
 */
export function verifyPersistedContract(
  row: StoredContractRow,
): { ok: true; record: PersistedTaskContract } | { ok: false; integrity: TaskContractIntegrity } {
  const fail = (problem: TaskContractIntegrityProblem, detail: string) => ({ ok: false as const, integrity: { problem, detail } });

  const revalidated = validateSupportedTaskContract(row.contract);
  if (!revalidated.ok) return fail("shape", `stored contract is not valid: ${revalidated.rejection.field} ${revalidated.rejection.code}`);
  const contract = revalidated.contract;

  if (contract.taskId !== row.taskId) return fail("identity", "the stored contract names another task");
  if (contract.schemaVersion !== row.schemaVersion) return fail("schema", "the stored schema version differs from the contract");
  if (revalidated.contractHash !== row.contractHash) return fail("digest", "the stored contract no longer hashes to the recorded digest");

  const expectedVersion = agreementVersionFor(row.taskId, row.contractHash);
  if (expectedVersion !== row.agreementVersion) return fail("agreement_version", "the agreement version does not derive from the stored digest");

  if (!Number.isInteger(row.requestedMaxAttempts) || row.requestedMaxAttempts < 1) {
    return fail("attempt_budget", "the recorded requested limit is not a positive integer");
  }
  if (row.requestedMaxAttempts !== contract.maxAttempts) {
    return fail("attempt_budget", "the recorded requested limit differs from the contract terms");
  }
  if (!Number.isInteger(row.policyMaxAttempts) || row.policyMaxAttempts < 1) {
    return fail("attempt_budget", "the recorded policy limit is not a positive integer");
  }
  if (!Number.isInteger(row.effectiveMaxAttempts) || row.effectiveMaxAttempts !== Math.min(row.requestedMaxAttempts, row.policyMaxAttempts)) {
    return fail("attempt_budget", "the effective limit is not the smaller of the request and the policy");
  }

  return {
    ok: true,
    record: {
      taskId: row.taskId,
      agreementVersion: row.agreementVersion,
      contractHash: row.contractHash,
      schemaVersion: row.schemaVersion,
      contract,
      requestedMaxAttempts: row.requestedMaxAttempts,
      policyMaxAttempts: row.policyMaxAttempts,
      effectiveMaxAttempts: row.effectiveMaxAttempts,
      createdAt: row.createdAt,
    },
  };
}

/**
 * Validate and normalize a submitted contract.
 *
 * Rejects unknown fields, unsupported versions, duplicate check ids, wrongly
 * typed values, out-of-range numbers, unsupported scope paths and any attempt
 * to submit a check conclusion instead of a check definition.
 */
export function validateTaskContract(input: unknown): TaskContractValidation {
  if (!isObject(input)) return reject("not_an_object", "contract", "The contract must be an object.");
  const asFailure = (result: { rejection: TaskContractRejection }): TaskContractValidation => ({ ok: false, rejection: result.rejection });
  const unknown = checkUnknownFields(input, TOP_LEVEL_FIELDS, "contract");
  if (unknown) return { ok: false, rejection: unknown };

  if (input.schemaVersion !== TASK_CONTRACT_SCHEMA_VERSION) {
    return reject("unsupported_schema_version", "schemaVersion", `schemaVersion must be ${TASK_CONTRACT_SCHEMA_VERSION}.`);
  }

  const taskId = text(input.taskId, "taskId", TASK_CONTRACT_LIMITS.identifierCharacters);
  if ("rejection" in taskId) return asFailure(taskId);
  const workspaceId = text(input.workspaceId, "workspaceId", TASK_CONTRACT_LIMITS.identifierCharacters);
  if ("rejection" in workspaceId) return asFailure(workspaceId);
  const title = text(input.title, "title", TASK_CONTRACT_LIMITS.titleCharacters);
  if ("rejection" in title) return asFailure(title);
  const objective = text(input.objective, "objective", TASK_CONTRACT_LIMITS.objectiveCharacters);
  if ("rejection" in objective) return asFailure(objective);
  const model = text(input.model, "model", TASK_CONTRACT_LIMITS.identifierCharacters);
  if ("rejection" in model) return asFailure(model);
  const timeoutSeconds = positiveInteger(input.timeoutSeconds, "timeoutSeconds", TASK_CONTRACT_LIMITS.timeoutSeconds);
  if ("rejection" in timeoutSeconds) return asFailure(timeoutSeconds);
  const maxAttempts = positiveInteger(input.maxAttempts, "maxAttempts", 100);
  if ("rejection" in maxAttempts) return asFailure(maxAttempts);

  if (!isObject(input.scope)) return reject("invalid_type", "scope", "scope must be an object.");
  const scopeUnknown = checkUnknownFields(input.scope, SCOPE_FIELDS, "scope");
  if (scopeUnknown) return { ok: false, rejection: scopeUnknown };
  const allowedChanges = scopeList(input.scope.allowedChanges, "scope.allowedChanges");
  if ("rejection" in allowedChanges) return asFailure(allowedChanges);
  const permittedMetadata = scopeList(input.scope.permittedMetadata, "scope.permittedMetadata");
  if ("rejection" in permittedMetadata) return asFailure(permittedMetadata);

  const checks = requiredChecks(input.requiredChecks);
  if ("rejection" in checks) return asFailure(checks);

  const contract: NormalizedTaskContract = {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: taskId.value,
    workspaceId: workspaceId.value,
    title: title.value,
    objective: objective.value,
    model: model.value,
    timeoutSeconds: timeoutSeconds.value,
    maxAttempts: maxAttempts.value,
    scope: { allowedChanges: allowedChanges.value, permittedMetadata: permittedMetadata.value },
    requiredChecks: checks.value,
  };

  const serialized = canonicalJson(contract);
  if (Buffer.byteLength(serialized, "utf8") > TASK_CONTRACT_LIMITS.serializedBytes) {
    return reject("too_large", "contract", `The normalized contract must be at most ${TASK_CONTRACT_LIMITS.serializedBytes} bytes.`);
  }
  return { ok: true, contract, contractHash: taskContractHash(contract) };
}

/** Explicit version dispatch; the v1-only parser above intentionally stays strict. */
export function validateSupportedTaskContract(input: unknown):
  | { ok: true; contract: SupportedTaskContract; contractHash: string }
  | { ok: false; rejection: TaskContractRejection } {
  if (!isObject(input) || input.schemaVersion !== TASK_CONTRACT_V2_SCHEMA_VERSION) return validateTaskContract(input);
  const allowed = new Set([...TOP_LEVEL_FIELDS].filter(key => key !== "model").concat("execution", "collaboration"));
  const unknown = checkUnknownFields(input, allowed, "contract");
  if (unknown) return { ok: false, rejection: unknown };
  if (!isObject(input.execution)) return reject("invalid_type", "execution", "execution must be an object.");
  const executionUnknown = checkUnknownFields(input.execution, new Set(["executorId", "connectionId", "providerId", "modelId", "reasoningEffort"]), "execution");
  if (executionUnknown) return { ok: false, rejection: executionUnknown };
  if (input.execution.executorId !== "workbuddy" && input.execution.executorId !== "dsh") return reject("invalid_value", "execution.executorId", "Unsupported executor.");
  const selection: ExecutionSelection = { executorId: input.execution.executorId, connectionId: "", providerId: "", modelId: "", reasoningEffort: null };
  for (const key of ["connectionId", "providerId", "modelId"] as const) {
    const parsed = text(input.execution[key], `execution.${key}`, TASK_CONTRACT_LIMITS.identifierCharacters);
    if ("rejection" in parsed) return { ok: false, rejection: parsed.rejection };
    if (parsed.value.trim() !== parsed.value) return reject("invalid_value", `execution.${key}`, "Identifiers must not have surrounding whitespace.");
    selection[key] = parsed.value;
  }
  if (input.execution.reasoningEffort !== null) {
    const effort = text(input.execution.reasoningEffort, "execution.reasoningEffort", 40);
    if ("rejection" in effort) return { ok: false, rejection: effort.rejection };
    selection.reasoningEffort = effort.value;
  }
  if (!isObject(input.collaboration)) return reject("invalid_type", "collaboration", "collaboration must be an object.");
  const planUnknown = checkUnknownFields(input.collaboration, new Set(["planId", "expectedPlanRevision"]), "collaboration");
  if (planUnknown) return { ok: false, rejection: planUnknown };
  const planId = text(input.collaboration.planId, "collaboration.planId", TASK_CONTRACT_LIMITS.identifierCharacters);
  const revision = text(input.collaboration.expectedPlanRevision, "collaboration.expectedPlanRevision", TASK_CONTRACT_LIMITS.identifierCharacters);
  if ("rejection" in planId) return { ok: false, rejection: planId.rejection };
  if ("rejection" in revision) return { ok: false, rejection: revision.rejection };
  const { execution: _execution, collaboration: _collaboration, ...common } = input;
  const base = validateTaskContract({ ...common, schemaVersion: TASK_CONTRACT_SCHEMA_VERSION, model: selection.modelId });
  if (!base.ok) return base;
  const { model: _model, ...terms } = base.contract;
  const contract: NormalizedTaskContractV2 = {
    ...terms, schemaVersion: TASK_CONTRACT_V2_SCHEMA_VERSION, execution: selection,
    collaboration: { planId: planId.value, expectedPlanRevision: revision.value },
  };
  if (Buffer.byteLength(canonicalJson(contract), "utf8") > TASK_CONTRACT_LIMITS.serializedBytes) return reject("too_large", "contract", "The normalized contract exceeds the byte limit.");
  return { ok: true, contract, contractHash: taskContractHash(contract) };
}

export function contractExecution(contract: SupportedTaskContract): ExecutionSelection {
  return "execution" in contract ? contract.execution : {
    executorId: "workbuddy", connectionId: "local-workbuddy", providerId: "workbuddy-native", modelId: contract.model, reasoningEffort: null,
  };
}

/** Plan terms exclude task identity and the plan reference, avoiding a circular digest. */
export function collaborationTermsHash(contract: SupportedTaskContract): string {
  const { taskId: _taskId, ...terms } = contract;
  if ("collaboration" in terms) {
    const { collaboration: _plan, ...proposal } = terms;
    return crypto.createHash("sha256").update(canonicalJson(proposal)).digest("hex");
  }
  return crypto.createHash("sha256").update(canonicalJson(terms)).digest("hex");
}
