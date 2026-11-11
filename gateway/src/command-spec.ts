import path from "node:path";
import type { CommandSpec } from "./bounded-command.js";

/**
 * One commanded acceptance check submitted to a task. The canonical shape is the
 * exact JSON text documented in SKILL.md / references/dispatch.md / docs/T6,
 * so the string that a worker sees is the string an independent reviewer
 * executes. Free text stays readable on historical rows but is never parsed as
 * a command line: there is no shell here to expand it.
 */
export const COMMAND_SPEC_FIELDS = ["executable", "args", "cwd", "timeoutSeconds", "inputs"] as const;
export type CommandSpecField = (typeof COMMAND_SPEC_FIELDS)[number];
/** Same ceiling as TASK_CONTRACT_LIMITS.timeoutSeconds: admission cannot outrun the contract budget. */
export const COMMAND_SPEC_MAX_TIMEOUT_SECONDS = 86400;
export const COMMAND_SPEC_EXAMPLE =
  '{"executable":"C:/Program Files/nodejs/node.exe","args":["-p","process.version"],"cwd":"E:/project","timeoutSeconds":60,"inputs":["package.json"]}';

export type CommandSpecRejectionCode =
  | "COMMAND_SPEC_REQUIRED"
  | "COMMAND_SPEC_MISSING_FIELD"
  | "COMMAND_SPEC_UNKNOWN_FIELD"
  | "COMMAND_SPEC_INVALID_VALUE"
  | "COMMAND_SPEC_PATH";

export interface CommandSpecRejection {
  code: CommandSpecRejectionCode;
  /** Where the caller must look, e.g. `acceptanceCommands[1].inputs[0]`. */
  position: string;
  /** The rejected field name at that position ("" when the whole value is wrong). */
  field: string;
  reason: string;
  example: string;
}

export type CommandSpecAdmission = { ok: true; spec: CommandSpec } | { ok: false; rejection: CommandSpecRejection };

export interface CommandSpecOptions {
  /** Absolute task workspace. When unknown (legacy routing) containment is re-checked at execution time. */
  workspaceRoot?: string | null;
  /** Position prefix used in rejections, e.g. `acceptanceCommands[0]`. */
  position?: string;
}

function reject(code: CommandSpecRejectionCode, position: string, field: string, reason: string): CommandSpecAdmission {
  return { ok: false, rejection: { code, position, field, reason, example: COMMAND_SPEC_EXAMPLE } };
}

/** True when `candidate` is `root` itself or lives below it, comparing resolved paths. */
export function insideDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative.split(/[\\/]/)[0] !== "..";
}

function hasUnsafeCharacters(value: string): boolean {
  return /[\u0000\r\n]/.test(value);
}

function relativeInputPath(file: string): boolean {
  if (!file.trim() || hasUnsafeCharacters(file)) return false;
  if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.startsWith("\\\\") || file.startsWith("//")) return false;
  return file.split(/[\\/]/).every(segment => segment !== "..");
}

/**
 * Parse and validate one command acceptance check. Pure: no filesystem access,
 * no shell, no side effects, so a caller can run it before any native
 * preparation or capacity reservation.
 */
export function parseCommandSpec(definition: unknown, options: CommandSpecOptions = {}): CommandSpecAdmission {
  const position = options.position ?? "command";
  const workspaceRoot = options.workspaceRoot && options.workspaceRoot.trim() ? path.resolve(options.workspaceRoot) : null;
  if (typeof definition !== "string" || !definition.trim()) {
    return reject("COMMAND_SPEC_REQUIRED", position, "", "A command check must be JSON CommandSpec text; an empty value can never be verified.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition);
  } catch {
    return reject("COMMAND_SPEC_REQUIRED", position, "", "This is not JSON. A free-text or shell command line is never executed as an acceptance check.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reject("COMMAND_SPEC_REQUIRED", position, "", "A CommandSpec must be a JSON object with exactly the five documented fields.");
  }
  const record = parsed as Record<string, unknown>;
  const unknownField = Object.keys(record).find(key => !(COMMAND_SPEC_FIELDS as readonly string[]).includes(key));
  if (unknownField !== undefined) {
    return reject("COMMAND_SPEC_UNKNOWN_FIELD", `${position}.${unknownField}`, unknownField, `Unknown field "${unknownField}". Only ${COMMAND_SPEC_FIELDS.join(", ")} are accepted; extra keys could smuggle an unverified option.`);
  }
  for (const field of COMMAND_SPEC_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      return reject("COMMAND_SPEC_MISSING_FIELD", `${position}.${field}`, field, `Missing required field "${field}". All five CommandSpec fields are required.`);
    }
  }
  const executable = record["executable"];
  if (typeof executable !== "string" || !executable.trim() || hasUnsafeCharacters(executable)) {
    return reject("COMMAND_SPEC_INVALID_VALUE", `${position}.executable`, "executable", "executable must be a non-empty single-line program path.");
  }
  if (!path.isAbsolute(executable)) {
    return reject("COMMAND_SPEC_PATH", `${position}.executable`, "executable", "executable must be an absolute path; nothing is resolved through PATH.");
  }
  const args = record["args"];
  if (!Array.isArray(args)) {
    return reject("COMMAND_SPEC_INVALID_VALUE", `${position}.args`, "args", "args must be an array of strings (argument boundaries are never re-split).");
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string" || arg.includes("\u0000")) {
      return reject("COMMAND_SPEC_INVALID_VALUE", `${position}.args[${index}]`, "args", "Every argument must be a string; numbers, objects and NUL bytes are rejected.");
    }
  }
  const cwd = record["cwd"];
  if (typeof cwd !== "string" || !cwd.trim() || hasUnsafeCharacters(cwd)) {
    return reject("COMMAND_SPEC_INVALID_VALUE", `${position}.cwd`, "cwd", "cwd must be a non-empty absolute directory path.");
  }
  if (!path.isAbsolute(cwd)) {
    return reject("COMMAND_SPEC_PATH", `${position}.cwd`, "cwd", "cwd must be absolute; relative directories would depend on an uncontrolled working directory.");
  }
  if (workspaceRoot && !insideDirectory(workspaceRoot, cwd)) {
    return reject("COMMAND_SPEC_PATH", `${position}.cwd`, "cwd", `cwd must stay inside the task workspace ${workspaceRoot}.`);
  }
  const timeoutSeconds = record["timeoutSeconds"];
  if (typeof timeoutSeconds !== "number" || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > COMMAND_SPEC_MAX_TIMEOUT_SECONDS) {
    return reject("COMMAND_SPEC_INVALID_VALUE", `${position}.timeoutSeconds`, "timeoutSeconds", `timeoutSeconds must be a whole number of seconds between 1 and ${COMMAND_SPEC_MAX_TIMEOUT_SECONDS}.`);
  }
  const inputs = record["inputs"];
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return reject("COMMAND_SPEC_INVALID_VALUE", `${position}.inputs`, "inputs", "inputs must name at least one workspace file the command actually reads; an empty list proves nothing.");
  }
  const checkedInputs: string[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const file = inputs[index];
    if (typeof file !== "string" || !file.trim() || file.includes("\0")) {
      return reject("COMMAND_SPEC_PATH", `${position}.inputs[${index}]`, "inputs", "Every input must name a file the command reads; empty entries and NUL bytes are rejected.");
    }
    if (!path.isAbsolute(file) && !relativeInputPath(file)) {
      return reject("COMMAND_SPEC_PATH", `${position}.inputs[${index}]`, "inputs", "Every relative input must be a workspace path without \"..\" segments or a drive letter.");
    }
    // A stored check may name its file relatively or absolutely; either spelling
    // must resolve to a file inside cwd and the task workspace.
    const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(cwd, file);
    if (!insideDirectory(cwd, absolute)) {
      return reject("COMMAND_SPEC_PATH", `${position}.inputs[${index}]`, "inputs", "Every input must stay inside cwd.");
    }
    if (workspaceRoot && !insideDirectory(workspaceRoot, absolute)) {
      return reject("COMMAND_SPEC_PATH", `${position}.inputs[${index}]`, "inputs", `Every input must stay inside the task workspace ${workspaceRoot}.`);
    }
    checkedInputs.push(file);
  }
  return { ok: true, spec: { executable, args: args as string[], cwd, timeoutSeconds, inputs: checkedInputs } };
}

/** Validate a submitted list; returns the first rejection (with its array index) or null. */
export function admitCommandSpecs(
  definitions: readonly string[] | undefined,
  options: { workspaceRoot?: string | null; field: string },
): CommandSpecRejection | null {
  const list = definitions ?? [];
  for (let index = 0; index < list.length; index += 1) {
    const admission = parseCommandSpec(list[index], { workspaceRoot: options.workspaceRoot, position: `${options.field}[${index}]` });
    if (!admission.ok) return admission.rejection;
  }
  return null;
}

/** One-line, copy-pasteable explanation. Never includes the whole free-text value. */
export function commandSpecAdmissionMessage(rejection: CommandSpecRejection): string {
  // The position already names the field (`acceptanceCommands[1].inputs`) except
  // when the whole value was rejected (`acceptanceCommands[1]`).
  const named = rejection.position.endsWith(`.${rejection.field}`) || rejection.position === rejection.field;
  const at = rejection.field && !named ? `${rejection.position} (${rejection.field})` : rejection.position;
  return `${at}: ${rejection.reason} [${rejection.code}] Expected e.g. ${rejection.example}`;
}
