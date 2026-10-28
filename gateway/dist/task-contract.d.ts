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
/** The only contract schema version this build accepts. */
export declare const TASK_CONTRACT_SCHEMA_VERSION = "workbuddy-executor/vnext-1";
export declare const TASK_CONTRACT_V2_SCHEMA_VERSION = "workbuddy-executor/vnext-2";
export interface ExecutionSelection {
    executorId: "workbuddy" | "dsh";
    connectionId: string;
    providerId: string;
    modelId: string;
    reasoningEffort: string | null;
}
export interface NormalizedTaskContractV2 extends Omit<NormalizedTaskContract, "model"> {
    execution: ExecutionSelection;
    collaboration: {
        planId: string;
        expectedPlanRevision: string;
    };
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
export declare function policyFromConfig(config: {
    maxTaskAttempts?: number;
}): TaskContractPolicy;
/** Documented limits from the interface contract, section 2. */
export declare const TASK_CONTRACT_LIMITS: Readonly<{
    titleCharacters: 120;
    objectiveCharacters: 100000;
    scopeItems: 100;
    requiredChecks: 100;
    serializedBytes: number;
    checkIdCharacters: 100;
    checkDefinitionCharacters: 2000;
    identifierCharacters: 200;
    timeoutSeconds: 86400;
}>;
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
export type TaskContractRejectionCode = "not_an_object" | "unknown_field" | "unsupported_schema_version" | "invalid_type" | "invalid_length" | "invalid_value" | "too_many_items" | "duplicate_check_id" | "invalid_scope_path" | "check_conclusion_not_allowed" | "too_large" | "task_mismatch" | "objective_mismatch";
export interface TaskContractRejection {
    code: TaskContractRejectionCode;
    field: string;
    message: string;
}
export type TaskContractValidation = {
    ok: true;
    contract: NormalizedTaskContract;
    contractHash: string;
} | {
    ok: false;
    rejection: TaskContractRejection;
};
/** Additive scope parsing for non-contract callers; historical contract digests are unchanged. */
export declare function validateTaskScope(value: unknown): {
    ok: true;
    scope: TaskContractScope;
} | {
    ok: false;
    rejection: TaskContractRejection;
};
/** The digest of a normalized contract. */
export declare function taskContractHash(contract: SupportedTaskContract): string;
/**
 * The server-generated agreement version.
 *
 * Derived from the task identity and the contract digest rather than from a
 * clock or a counter, so it is stable across restarts and can be recomputed.
 * Two tasks with identical terms still get different versions.
 */
export declare function agreementVersionFor(taskId: string, contractHash: string): string;
/** The effective attempt budget: the smaller of the request and the policy. */
export declare function effectiveMaxAttempts(requested: number, policy: TaskContractPolicy): number;
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
export declare function persistedTaskContract(contract: SupportedTaskContract, contractHash: string, createdAt: string, policy: TaskContractPolicy): PersistedTaskContract;
/** Why a stored contract cannot be trusted. */
export type TaskContractIntegrityProblem = "shape" | "identity" | "schema" | "digest" | "agreement_version" | "attempt_budget";
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
export declare function verifyPersistedContract(row: StoredContractRow): {
    ok: true;
    record: PersistedTaskContract;
} | {
    ok: false;
    integrity: TaskContractIntegrity;
};
/**
 * Validate and normalize a submitted contract.
 *
 * Rejects unknown fields, unsupported versions, duplicate check ids, wrongly
 * typed values, out-of-range numbers, unsupported scope paths and any attempt
 * to submit a check conclusion instead of a check definition.
 */
export declare function validateTaskContract(input: unknown): TaskContractValidation;
/** Explicit version dispatch; the v1-only parser above intentionally stays strict. */
export declare function validateSupportedTaskContract(input: unknown): {
    ok: true;
    contract: SupportedTaskContract;
    contractHash: string;
} | {
    ok: false;
    rejection: TaskContractRejection;
};
export declare function contractExecution(contract: SupportedTaskContract): ExecutionSelection;
/** Plan terms exclude task identity and the plan reference, avoiding a circular digest. */
export declare function collaborationTermsHash(contract: SupportedTaskContract): string;
