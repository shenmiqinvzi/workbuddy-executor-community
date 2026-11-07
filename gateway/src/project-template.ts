/**
 * Versioned project templates.
 *
 * A template is a *preset description*: the objective text a project usually
 * starts from, the scope it usually permits and the checks it usually agrees
 * to. It is deliberately not an agreement, not an authorization and not a
 * task. Instantiating one produces a fresh draft with a fresh identity that
 * still has to pass plan creation, real scope validation and the user's own
 * confirmation.
 *
 * Two invariants are enforced here, not in the page:
 *  - no identity from a template (or from a previous task) is reused, and no
 *    attempt/plan/review/evidence reference can be carried over;
 *  - a template never raises a budget. `maxAttempts` is capped by the caller's
 *    policy and `timeoutSeconds` by the contract limit, and a clamped value is
 *    reported instead of silently applied.
 *
 * Automatic-policy templates (the `policy-suggestion` kind) only record what a
 * future policy engine might propose. Nothing in this line may activate them:
 * instantiation refuses with `policy_activation_unsupported` until line 07
 * supplies the policy engine, and G3 aligns the two lines.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  TASK_CONTRACT_LIMITS,
  TASK_CONTRACT_SCHEMA_VERSION,
  validateTaskContract,
  type NormalizedTaskContract,
  type TaskContractCheck,
  type TaskContractRejection,
  type TaskContractScope,
} from "./task-contract.js";

/** Current on-disk/API schema for one template version. */
export const PROJECT_TEMPLATE_SCHEMA = "workbuddy-executor/project-template-2";
/** Earlier prototype schema, still readable so saved presets are not lost. */
export const LEGACY_PROJECT_TEMPLATE_SCHEMA = "workbuddy-executor/project-template-1";
/** Envelope schema of the local template file. */
export const PROJECT_TEMPLATE_FILE_SCHEMA = 1;

export const PROJECT_TEMPLATE_LIMITS = {
  /** Distinct templates kept on disk. */
  templates: 100,
  /** Versions kept per template id. */
  versionsPerTemplate: 20,
  nameCharacters: 120,
  descriptionCharacters: 2000,
  objectiveCharacters: TASK_CONTRACT_LIMITS.objectiveCharacters,
  serializedBytes: 512 * 1024,
} as const;

export type ProjectTemplateKind = "manual" | "policy-suggestion";

/** What a template suggests for a future dispatch. Never applied by itself. */
export interface ProjectTemplateSelectionSuggestion {
  executorId: "workbuddy" | "dsh";
  connectionId: string;
  providerId: string;
  modelId: string;
  reasoningEffort: string | null;
}

/** The saved project preset: objective text, scope and checks. */
export interface ProjectTemplatePreset {
  titleTemplate: string;
  objectiveTemplate: string;
  scope: TaskContractScope;
  requiredChecks: TaskContractCheck[];
  timeoutSeconds: number;
  maxAttempts: number;
}

export interface ProjectTemplateMigration {
  from: string;
  notes: string[];
}

export interface ProjectTemplate {
  schemaVersion: typeof PROJECT_TEMPLATE_SCHEMA;
  templateId: string;
  templateVersion: number;
  createdAt: string;
  archivedAt: string | null;
  name: string;
  description: string;
  kind: ProjectTemplateKind;
  project: ProjectTemplatePreset;
  selectionSuggestion: ProjectTemplateSelectionSuggestion | null;
  /** Advice for a policy engine that does not exist in this line yet. */
  policySuggestion: { maxAttempts: number; timeoutSeconds: number; note: string } | null;
  /** Always "unsupported" here: this build cannot activate a policy template. */
  activation: "unsupported";
  migration: ProjectTemplateMigration | null;
}

export interface ProjectTemplateRejection {
  code:
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
    | "unknown_enum"
    | "policy_activation_unsupported"
    | "template_not_found"
    | "template_archived";
  field: string;
  message: string;
  allowed?: readonly string[];
}

export type TemplateValidation =
  | { ok: true; template: ProjectTemplate }
  | { ok: false; rejection: ProjectTemplateRejection };

const TEMPLATE_FIELDS = new Set([
  "schemaVersion",
  "templateId",
  "templateVersion",
  "createdAt",
  "archivedAt",
  "name",
  "description",
  "kind",
  "project",
  "selectionSuggestion",
  "policySuggestion",
  "activation",
  "migration",
]);
const PRESET_FIELDS = new Set(["titleTemplate", "objectiveTemplate", "scope", "requiredChecks", "timeoutSeconds", "maxAttempts"]);
const SELECTION_FIELDS = new Set(["executorId", "connectionId", "providerId", "modelId", "reasoningEffort"]);
const POLICY_FIELDS = new Set(["maxAttempts", "timeoutSeconds", "note"]);

const KINDS: readonly ProjectTemplateKind[] = ["manual", "policy-suggestion"];
const EXECUTORS = ["workbuddy", "dsh"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownField(value: Record<string, unknown>, allowed: Set<string>, field: string): ProjectTemplateRejection | null {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return reject("unknown_field", field ? `${field}.${key}` : key, `Unknown field "${key}" is not part of a template.`);
  }
  return null;
}

function reject(code: ProjectTemplateRejection["code"], field: string, message: string, allowed?: readonly string[]): ProjectTemplateRejection {
  return allowed ? { code, field, message, allowed } : { code, field, message };
}

function text(value: unknown, field: string, max: number, options: { allowEmpty?: boolean } = {}): { value: string } | { rejection: ProjectTemplateRejection } {
  if (typeof value !== "string") return { rejection: reject("invalid_type", field, `${field} must be a string.`) };
  const trimmed = value.trim();
  if (!options.allowEmpty && !trimmed.length) return { rejection: reject("invalid_value", field, `${field} must not be empty.`) };
  if (value.length > max) return { rejection: reject("invalid_length", field, `${field} must be at most ${max} characters.`) };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return { rejection: reject("invalid_value", field, `${field} must not contain control characters.`) };
  return { value: options.allowEmpty ? value : trimmed };
}

function integer(value: unknown, field: string, min: number, max: number): { value: number } | { rejection: ProjectTemplateRejection } {
  if (typeof value !== "number" || !Number.isInteger(value)) return { rejection: reject("invalid_type", field, `${field} must be an integer.`) };
  if (value < min || value > max) return { rejection: reject("invalid_value", field, `${field} must be between ${min} and ${max}.`) };
  return { value };
}

/** Stable JSON with sorted keys, so a version hash does not depend on key order. */
export function canonicalTemplateJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (isObject(input)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) out[key] = walk(input[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

/** Digest of one template version's content, excluding its own hash. */
export function templateContentHash(template: ProjectTemplate): string {
  const { migration: _migration, ...rest } = template;
  return createHash("sha256").update(canonicalTemplateJson(rest), "utf8").digest("hex");
}

/**
 * Reuse the real contract validator for the parts a template shares with a
 * contract (scope paths, check ids, check kinds, forbidden conclusion fields,
 * size limits). A synthetic probe keeps this honest if either side changes.
 */
function validatePresetShape(preset: Record<string, unknown>): { ok: true; scope: TaskContractScope; checks: TaskContractCheck[]; timeoutSeconds: number; maxAttempts: number } | { ok: false; rejection: ProjectTemplateRejection } {
  const unknown = unknownField(preset, PRESET_FIELDS, "project");
  if (unknown) return { ok: false, rejection: unknown };
  const probe = validateTaskContract({
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: "template-probe",
    workspaceId: "template-probe",
    title: "template probe",
    objective: "template probe",
    model: "template-probe",
    timeoutSeconds: preset.timeoutSeconds,
    maxAttempts: preset.maxAttempts,
    scope: preset.scope,
    requiredChecks: preset.requiredChecks,
  });
  if (!probe.ok) return { ok: false, rejection: mapContractRejection(probe.rejection) };
  return { ok: true, scope: probe.contract.scope, checks: probe.contract.requiredChecks, timeoutSeconds: probe.contract.timeoutSeconds, maxAttempts: probe.contract.maxAttempts };
}

function mapContractRejection(rejection: TaskContractRejection): ProjectTemplateRejection {
  const field = rejection.field.startsWith("project.") ? rejection.field : `project.${rejection.field}`;
  // The template probe supplies its own task identity, so the two contract-level
  // mismatch codes cannot be produced here; if that ever changes they surface as
  // a template value error rather than silently widening the rejection union.
  const code = rejection.code === "task_mismatch" || rejection.code === "objective_mismatch" ? "invalid_value" : rejection.code;
  return { code, field, message: rejection.message };
}

/**
 * Validate one template record. `expectedVersion` is supplied by the store when
 * writing a new version of an existing template; a client cannot choose it.
 */
export function validateProjectTemplate(input: unknown, options: { now?: Date; templateId?: string; templateVersion?: number; createdAt?: string; archivedAt?: string | null } = {}): TemplateValidation {
  if (!isObject(input)) return { ok: false, rejection: reject("not_an_object", "template", "A template must be an object.") };
  if (input.schemaVersion !== undefined && input.schemaVersion !== PROJECT_TEMPLATE_SCHEMA) {
    return { ok: false, rejection: reject("unsupported_schema_version", "schemaVersion", `schemaVersion must be ${PROJECT_TEMPLATE_SCHEMA}.`) };
  }
  const unknown = unknownField(input, TEMPLATE_FIELDS, "template");
  if (unknown) return { ok: false, rejection: unknown };
  // `activation` exists so a stored template can state, truthfully, that it is
  // not an active policy. A client cannot set it to anything but that.
  if (input.activation !== undefined && input.activation !== "unsupported") {
    return { ok: false, rejection: reject("invalid_value", "activation", "activation is fixed to \"unsupported\": this build has no policy engine to activate a template.") };
  }

  const name = text(input.name, "name", PROJECT_TEMPLATE_LIMITS.nameCharacters);
  if ("rejection" in name) return { ok: false, rejection: name.rejection };
  const description = text(input.description ?? "", "description", PROJECT_TEMPLATE_LIMITS.descriptionCharacters, { allowEmpty: true });
  if ("rejection" in description) return { ok: false, rejection: description.rejection };

  const kindValue = input.kind ?? "manual";
  if (typeof kindValue !== "string" || !KINDS.includes(kindValue as ProjectTemplateKind)) {
    return { ok: false, rejection: reject("unknown_enum", "kind", "Unknown template kind.", KINDS) };
  }
  const kind = kindValue as ProjectTemplateKind;

  if (!isObject(input.project)) return { ok: false, rejection: reject("not_an_object", "project", "project must be an object.") };
  const preset = input.project;
  const title = text(preset.titleTemplate, "project.titleTemplate", TASK_CONTRACT_LIMITS.titleCharacters);
  if ("rejection" in title) return { ok: false, rejection: title.rejection };
  const objective = text(preset.objectiveTemplate, "project.objectiveTemplate", PROJECT_TEMPLATE_LIMITS.objectiveCharacters);
  if ("rejection" in objective) return { ok: false, rejection: objective.rejection };
  const shape = validatePresetShape(preset);
  if (!shape.ok) return { ok: false, rejection: shape.rejection };

  let selectionSuggestion: ProjectTemplateSelectionSuggestion | null = null;
  if (input.selectionSuggestion !== undefined && input.selectionSuggestion !== null) {
    if (!isObject(input.selectionSuggestion)) return { ok: false, rejection: reject("not_an_object", "selectionSuggestion", "selectionSuggestion must be an object or null.") };
    const selectionUnknown = unknownField(input.selectionSuggestion, SELECTION_FIELDS, "selectionSuggestion");
    if (selectionUnknown) return { ok: false, rejection: selectionUnknown };
    const rawExecutor = input.selectionSuggestion.executorId;
    if (typeof rawExecutor !== "string" || !(EXECUTORS as readonly string[]).includes(rawExecutor)) {
      return { ok: false, rejection: reject("unknown_enum", "selectionSuggestion.executorId", "Unknown executor.", EXECUTORS) };
    }
    const parts: Record<"connectionId" | "providerId" | "modelId", string> = { connectionId: "", providerId: "", modelId: "" };
    for (const key of ["connectionId", "providerId", "modelId"] as const) {
      const parsed = text(input.selectionSuggestion[key] ?? "", `selectionSuggestion.${key}`, TASK_CONTRACT_LIMITS.identifierCharacters, { allowEmpty: true });
      if ("rejection" in parsed) return { ok: false, rejection: parsed.rejection };
      parts[key] = parsed.value;
    }
    const effortRaw = input.selectionSuggestion.reasoningEffort ?? null;
    if (effortRaw !== null && typeof effortRaw !== "string") return { ok: false, rejection: reject("invalid_type", "selectionSuggestion.reasoningEffort", "reasoningEffort must be a string or null.") };
    const effort = effortRaw === null ? null : text(effortRaw, "selectionSuggestion.reasoningEffort", 100, { allowEmpty: true });
    if (effort && "rejection" in effort) return { ok: false, rejection: effort.rejection };
    if (parts.modelId.length === 0) return { ok: false, rejection: reject("invalid_value", "selectionSuggestion.modelId", "A saved selection suggestion needs a model id; it is only a suggestion and is never applied automatically.") };
    selectionSuggestion = { executorId: rawExecutor as "workbuddy" | "dsh", ...parts, reasoningEffort: effort === null ? null : effort.value };
  }

  let policySuggestion: ProjectTemplate["policySuggestion"] = null;
  if (input.policySuggestion !== undefined && input.policySuggestion !== null) {
    if (!isObject(input.policySuggestion)) return { ok: false, rejection: reject("not_an_object", "policySuggestion", "policySuggestion must be an object or null.") };
    const policyUnknown = unknownField(input.policySuggestion, POLICY_FIELDS, "policySuggestion");
    if (policyUnknown) return { ok: false, rejection: policyUnknown };
    const attempts = integer(input.policySuggestion.maxAttempts, "policySuggestion.maxAttempts", 1, 100);
    if ("rejection" in attempts) return { ok: false, rejection: attempts.rejection };
    const timeout = integer(input.policySuggestion.timeoutSeconds, "policySuggestion.timeoutSeconds", 1, TASK_CONTRACT_LIMITS.timeoutSeconds);
    if ("rejection" in timeout) return { ok: false, rejection: timeout.rejection };
    const note = text(input.policySuggestion.note ?? "", "policySuggestion.note", 500, { allowEmpty: true });
    if ("rejection" in note) return { ok: false, rejection: note.rejection };
    policySuggestion = { maxAttempts: attempts.value, timeoutSeconds: timeout.value, note: note.value };
  }
  if (kind === "policy-suggestion" && policySuggestion === null) {
    return { ok: false, rejection: reject("invalid_value", "policySuggestion", "A policy-suggestion template must record the values it suggests.") };
  }

  const templateId = options.templateId ?? (input.templateId === undefined ? `tmpl-${randomUUID()}` : undefined);
  if (input.templateId !== undefined || options.templateId !== undefined) {
    const parsedId = text(options.templateId ?? input.templateId, "templateId", TASK_CONTRACT_LIMITS.identifierCharacters);
    if ("rejection" in parsedId) return { ok: false, rejection: parsedId.rejection };
    if (!/^tmpl-[A-Za-z0-9-]{8,64}$/.test(parsedId.value)) return { ok: false, rejection: reject("invalid_value", "templateId", "templateId must look like tmpl-<identifier>.") };
  }
  const now = options.now ?? new Date();
  const template: ProjectTemplate = {
    schemaVersion: PROJECT_TEMPLATE_SCHEMA,
    templateId: options.templateId ?? (typeof input.templateId === "string" ? input.templateId : templateId!),
    templateVersion: options.templateVersion ?? 1,
    createdAt: options.createdAt ?? now.toISOString(),
    archivedAt: options.archivedAt ?? null,
    name: name.value,
    description: description.value,
    kind,
    project: { titleTemplate: title.value, objectiveTemplate: objective.value, scope: shape.scope, requiredChecks: shape.checks, timeoutSeconds: shape.timeoutSeconds, maxAttempts: shape.maxAttempts },
    selectionSuggestion,
    policySuggestion,
    activation: "unsupported",
    migration: null,
  };
  if (Buffer.byteLength(canonicalTemplateJson(template), "utf8") > PROJECT_TEMPLATE_LIMITS.serializedBytes) {
    return { ok: false, rejection: reject("too_large", "template", "The template exceeds its serialized size limit.") };
  }
  return { ok: true, template };
}

/**
 * Upgrade the prototype schema (`project-template-1`) to the current one.
 * Fields this build cannot honour are dropped with an explicit note instead of
 * being guessed at: a stored machine path is never resurrected, and a bare
 * model name is not invented into a full execution selection.
 */
export function upgradeLegacyTemplate(input: unknown, options: { now?: Date } = {}): TemplateValidation {
  if (!isObject(input)) return { ok: false, rejection: reject("not_an_object", "template", "A legacy template must be an object.") };
  if (input.schemaVersion !== LEGACY_PROJECT_TEMPLATE_SCHEMA) {
    return { ok: false, rejection: reject("unsupported_schema_version", "schemaVersion", `Legacy upgrade expects ${LEGACY_PROJECT_TEMPLATE_SCHEMA}.`) };
  }
  const notes: string[] = [];
  const nameParsed = text(input.name, "name", PROJECT_TEMPLATE_LIMITS.nameCharacters);
  if ("rejection" in nameParsed) return { ok: false, rejection: nameParsed.rejection };
  const scopePaths = input.scopePaths;
  if (!Array.isArray(scopePaths)) return { ok: false, rejection: reject("invalid_type", "scopePaths", "scopePaths must be an array.") };
  notes.push("旧版 scopePaths 已转换为约定修改范围；机器路径不会从旧模板恢复，实例化时必须重新选择工作区。");
  if (Array.isArray(input.checks)) {
    for (const check of input.checks) {
      if (isObject(check) && typeof check.kind === "string" && !["command", "semantic"].includes(check.kind)) {
        return { ok: false, rejection: reject("unknown_enum", "checks.kind", `Unknown check kind "${check.kind}".`, ["command", "semantic"]) };
      }
    }
  }
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : null;
  if (model) notes.push("旧版只保存了模型名，缺少执行器/连接/提供方，升级后不生成执行选择建议，请重新选择。");
  if (typeof input.workspacePath === "string" && input.workspacePath) notes.push("旧版工作区路径已丢弃：工作区必须在派工时由用户重新选定。");
  const candidate = {
    schemaVersion: PROJECT_TEMPLATE_SCHEMA,
    templateId: typeof input.id === "string" && /^tmpl-[A-Za-z0-9-]{8,64}$/.test(input.id) ? input.id : `tmpl-${randomUUID()}`,
    name: nameParsed.value,
    description: typeof input.description === "string" ? input.description : "",
    kind: "manual",
    project: {
      titleTemplate: typeof input.title === "string" && input.title.trim() ? input.title : nameParsed.value,
      objectiveTemplate: typeof input.objective === "string" && input.objective.trim() ? input.objective : `按模板「${nameParsed.value}」推进项目。`,
      scope: { allowedChanges: scopePaths, permittedMetadata: [] },
      requiredChecks: Array.isArray(input.checks) ? input.checks : [],
      timeoutSeconds: typeof input.timeoutSeconds === "number" ? input.timeoutSeconds : 3600,
      maxAttempts: typeof input.maxAttempts === "number" ? input.maxAttempts : 3,
    },
    selectionSuggestion: null,
    policySuggestion: null,
  };
  const validated = validateProjectTemplate(candidate, options);
  if (!validated.ok) return validated;
  return { ok: true, template: { ...validated.template, migration: { from: LEGACY_PROJECT_TEMPLATE_SCHEMA, notes } } };
}

export interface TemplateSummary {
  templateId: string;
  templateVersion: number;
  name: string;
  kind: ProjectTemplateKind;
  activation: "unsupported";
  archivedAt: string | null;
  createdAt: string;
  scopeItems: number;
  checks: number;
  contentHash: string;
  migrationNotes: string[];
}

export function summarizeTemplate(template: ProjectTemplate): TemplateSummary {
  return {
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    name: template.name,
    kind: template.kind,
    activation: template.activation,
    archivedAt: template.archivedAt,
    createdAt: template.createdAt,
    scopeItems: template.project.scope.allowedChanges.length,
    checks: template.project.requiredChecks.length,
    contentHash: templateContentHash(template),
    migrationNotes: template.migration?.notes ?? [],
  };
}

export interface TemplateInstantiationOptions {
  workspaceId: string;
  taskId?: string;
  title?: string;
  objective?: string;
  /** Server policy, never a client field. */
  policyMaxAttempts?: number;
  /** Server policy ceiling for the run deadline, never a client field. */
  policyMaxTimeoutSeconds?: number;
  now?: Date;
}

export interface TemplateDraft {
  kind: "template-draft";
  draftId: string;
  template: { templateId: string; templateVersion: number; contentHash: string; kind: ProjectTemplateKind };
  contract: NormalizedTaskContract;
  selectionSuggestion: ProjectTemplateSelectionSuggestion | null;
  /** Null by construction: a template carries no authorization. */
  authorization: null;
  requires: readonly ["plan_create", "user_confirmation"];
  budget: { requested: number; policy: number; applied: number; clamped: boolean; timeout: { requested: number; policy: number; applied: number; clamped: boolean } };
  notes: string[];
}

export type TemplateInstantiation =
  | { ok: true; draft: TemplateDraft }
  | { ok: false; rejection: ProjectTemplateRejection };

/**
 * Turn a saved template into a fresh draft. Every identity in the draft is new;
 * no attempt, plan, review, evidence or authorization reference exists in the
 * output at all (the shape has no field for them), and the probe below proves
 * it after serialization.
 */
export function instantiateTemplate(template: ProjectTemplate, options: TemplateInstantiationOptions): TemplateInstantiation {
  if (template.archivedAt) return { ok: false, rejection: reject("template_archived", "templateId", "This template version was archived; save a new version before using it.") };
  if (template.kind === "policy-suggestion") {
    return { ok: false, rejection: reject("policy_activation_unsupported", "kind", "Automatic-policy templates are saved as suggestions only. The policy engine is not delivered in this line, so no rule can be activated or applied.", ["manual"]) };
  }
  const workspace = text(options.workspaceId, "workspaceId", TASK_CONTRACT_LIMITS.identifierCharacters);
  if ("rejection" in workspace) return { ok: false, rejection: workspace.rejection };
  const title = text(options.title ?? template.project.titleTemplate, "title", TASK_CONTRACT_LIMITS.titleCharacters);
  if ("rejection" in title) return { ok: false, rejection: title.rejection };
  const objective = text(options.objective ?? template.project.objectiveTemplate, "objective", PROJECT_TEMPLATE_LIMITS.objectiveCharacters);
  if ("rejection" in objective) return { ok: false, rejection: objective.rejection };
  const policyMaxAttempts = Math.max(1, Math.min(options.policyMaxAttempts ?? 3, 100));
  const applied = Math.max(1, Math.min(template.project.maxAttempts, policyMaxAttempts));
  // The deadline is a budget too: a template may ask for longer than the
  // server policy allows, and the draft must not carry a larger one.
  const policyTimeout = Math.max(1, Math.min(options.policyMaxTimeoutSeconds ?? TASK_CONTRACT_LIMITS.timeoutSeconds, TASK_CONTRACT_LIMITS.timeoutSeconds));
  const timeoutSeconds = Math.max(1, Math.min(template.project.timeoutSeconds, policyTimeout));

  const raw = {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION,
    taskId: options.taskId ?? randomUUID(),
    workspaceId: workspace.value,
    title: title.value,
    objective: objective.value,
    model: template.selectionSuggestion?.modelId ?? "template-unselected",
    timeoutSeconds,
    maxAttempts: applied,
    scope: template.project.scope,
    requiredChecks: template.project.requiredChecks,
  };
  const validated = validateTaskContract(raw);
  if (!validated.ok) return { ok: false, rejection: mapContractRejection(validated.rejection) };

  const notes: string[] = ["模板只提供预设；派工仍需创建方案并由用户确认。"];
  if (applied !== template.project.maxAttempts) notes.push(`模板建议 ${template.project.maxAttempts} 次尝试，当前策略上限 ${policyMaxAttempts} 次，已按策略取 ${applied} 次。`);
  if (timeoutSeconds !== template.project.timeoutSeconds) notes.push(`模板预设 ${template.project.timeoutSeconds} 秒时限，当前策略上限 ${policyTimeout} 秒，已按策略取 ${timeoutSeconds} 秒。`);
  if (template.selectionSuggestion) notes.push("执行器/模型建议仅供参考，未写入授权；实际选择仍需用户在派工面板确认。");
  if (template.policySuggestion) notes.push("模板保存了政策建议，但本线不具备政策引擎，建议未生效。");

  const draft: TemplateDraft = {
    kind: "template-draft",
    draftId: randomUUID(),
    template: { templateId: template.templateId, templateVersion: template.templateVersion, contentHash: templateContentHash(template), kind: template.kind },
    contract: validated.contract,
    selectionSuggestion: template.selectionSuggestion,
    authorization: null,
    requires: ["plan_create", "user_confirmation"],
    budget: { requested: template.project.maxAttempts, policy: policyMaxAttempts, applied, clamped: applied !== template.project.maxAttempts, timeout: { requested: template.project.timeoutSeconds, policy: policyTimeout, applied: timeoutSeconds, clamped: timeoutSeconds !== template.project.timeoutSeconds } },
    notes,
  };
  const leak = findCarriedIdentity(draft);
  if (leak) throw new Error(`template instantiation produced a carried identity field: ${leak}`);
  return { ok: true, draft };
}

const FORBIDDEN_DRAFT_KEYS = new Set(["attemptId", "operationId", "planId", "reviewId", "reviewedAt", "authorizedAt", "authorizationSource", "evidenceRefs", "inputHashes", "agreementVersion", "contractHash", "consumedBy"]);

/** Returns the first forbidden key found in a draft, or null. Test seam. */
export function findCarriedIdentity(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) { const found = findCarriedIdentity(item); if (found) return found; }
    return null;
  }
  if (!isObject(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_DRAFT_KEYS.has(key)) return key;
    const found = findCarriedIdentity(item);
    if (found) return found;
  }
  return null;
}

interface TemplateFile { schemaVersion: 1; templates: unknown[] }

export type TemplateSaveResult =
  | { ok: true; template: ProjectTemplate; created: boolean }
  | { ok: false; rejection: ProjectTemplateRejection };

/**
 * Bounded local template store. A missing or corrupt file is reported through
 * `issues()` and treated as empty; a corrupt record never blocks saving a new
 * template and never invents a preset. Writes are atomic (tmp + rename, 0600).
 */
export class ProjectTemplateStore {
  private cache: ProjectTemplate[] | null = null;
  private readonly problems: string[] = [];
  private readonly limit: number;
  private readonly now: () => Date;
  constructor(private readonly options: { file?: string | null; now?: () => Date; limit?: number } = {}) {
    this.limit = Math.max(1, Math.min(options.limit ?? PROJECT_TEMPLATE_LIMITS.templates, PROJECT_TEMPLATE_LIMITS.templates));
    this.now = options.now ?? (() => new Date());
  }

  issues(): string[] { return [...this.problems]; }

  /** Latest version of every template, newest first. */
  list(options: { includeArchived?: boolean } = {}): ProjectTemplate[] {
    const all = this.load();
    const latest = new Map<string, ProjectTemplate>();
    for (const template of all) {
      const current = latest.get(template.templateId);
      if (!current || current.templateVersion < template.templateVersion) latest.set(template.templateId, template);
    }
    return [...latest.values()]
      .filter(template => options.includeArchived === true || template.archivedAt === null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  versions(templateId: string): ProjectTemplate[] {
    return this.load().filter(template => template.templateId === templateId).sort((a, b) => b.templateVersion - a.templateVersion);
  }

  get(templateId: string, version?: number): ProjectTemplate | null {
    const matches = this.load().filter(template => template.templateId === templateId);
    if (!matches.length) return null;
    if (version !== undefined) return matches.find(template => template.templateVersion === version) ?? null;
    return matches.reduce((best, item) => (item.templateVersion > best.templateVersion ? item : best));
  }

  save(input: unknown): TemplateSaveResult {
    const parsedId = isObject(input) && typeof input.templateId === "string" ? input.templateId : null;
    const previous = parsedId ? this.get(parsedId) : null;
    if (parsedId && previous === null) return { ok: false, rejection: reject("template_not_found", "templateId", "No template with that identity exists; omit templateId to create one.") };
    const validated = validateProjectTemplate(input, {
      now: this.now(),
      templateId: previous?.templateId,
      templateVersion: previous ? previous.templateVersion + 1 : 1,
      createdAt: previous?.createdAt,
      archivedAt: null,
    });
    if (!validated.ok) return { ok: false, rejection: validated.rejection };
    const all = this.load();
    const sameId = all.filter(template => template.templateId === validated.template.templateId);
    const kept = sameId.length >= PROJECT_TEMPLATE_LIMITS.versionsPerTemplate
      ? sameId.sort((a, b) => a.templateVersion - b.templateVersion).slice(sameId.length - PROJECT_TEMPLATE_LIMITS.versionsPerTemplate + 1)
      : sameId;
    const others = all.filter(template => template.templateId !== validated.template.templateId);
    const distinct = new Set(others.map(template => template.templateId));
    let next = [...others, ...kept, validated.template];
    if (!distinct.has(validated.template.templateId) && distinct.size >= this.limit) {
      const oldest = this.list({ includeArchived: true }).at(-1);
      if (oldest) next = next.filter(template => template.templateId !== oldest.templateId);
    }
    this.cache = next;
    this.persist();
    return { ok: true, template: validated.template, created: previous === null };
  }

  archive(templateId: string, now: Date = this.now()): TemplateSaveResult {
    const previous = this.get(templateId);
    if (!previous) return { ok: false, rejection: reject("template_not_found", "templateId", "No template with that identity exists.") };
    if (previous.archivedAt) return { ok: true, template: previous, created: false };
    const archived: ProjectTemplate = { ...previous, templateVersion: previous.templateVersion + 1, archivedAt: now.toISOString(), createdAt: previous.createdAt };
    this.cache = [...this.load().filter(template => template.templateId !== templateId), archived];
    this.persist();
    return { ok: true, template: archived, created: false };
  }

  private load(): ProjectTemplate[] {
    if (this.cache) return this.cache;
    this.cache = [];
    const file = this.options.file;
    if (!file) return this.cache;
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.problems.push("模板文件无法读取，已按空目录继续；已有模板不会被自动重建。");
      return this.cache;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<TemplateFile>;
      if (!parsed || parsed.schemaVersion !== PROJECT_TEMPLATE_FILE_SCHEMA || !Array.isArray(parsed.templates)) throw Error("shape");
      for (const entry of parsed.templates) {
        const schema = isObject(entry) ? entry.schemaVersion : undefined;
        const validated = schema === LEGACY_PROJECT_TEMPLATE_SCHEMA ? upgradeLegacyTemplate(entry, { now: this.now() }) : validateProjectTemplate(entry);
        if (!validated.ok) {
          this.problems.push(`已跳过一条无法解释的模板记录：${validated.rejection.field} ${validated.rejection.code}。原始文件未被改写。`);
          continue;
        }
        this.cache.push(validated.template);
      }
      this.cache.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    catch {
      this.problems.push("模板文件格式无效，已按空目录继续；损坏文件保持原样以便人工检查。");
      this.cache = [];
    }
    return this.cache;
  }

  private persist(): void {
    const file = this.options.file;
    if (!file) return;
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    const body: TemplateFile = { schemaVersion: PROJECT_TEMPLATE_FILE_SCHEMA, templates: this.cache ?? [] };
    fs.writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }
}
