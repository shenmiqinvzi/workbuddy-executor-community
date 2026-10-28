import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.js";
import { RunJournal, runsDirectory } from "./run-journal.js";
import { resolveWorkspaceRead } from "./workspace-protection.js";

function readObject(file: string, maxBytes: number): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error("Worker JSON must be a regular file within the size limit");
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch { throw new Error("Worker JSON is invalid; file contents are not included in errors"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worker JSON must be an object");
  return value as Record<string, unknown>;
}

export interface ValidationEvidence { path: string; sha256: string }
function assertPrivateRunPath(config: Config, file: string): void {
  const root = path.resolve(runsDirectory(config)), absolute = path.resolve(file), relative = path.relative(root, absolute);
  if (!path.isAbsolute(file) || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error("Worker file is outside the service runs directory");
  let current = root;
  for (const part of ["", ...relative.split(path.sep)]) {
    current = part ? path.join(current, part) : current;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw Error("Linked worker files or directories are not accepted");
  }
}
export function readWorkerObject(config: Config, attemptId: string, file: string, filename: string, maxBytes: number) {
  if (!/^run-[a-f0-9-]{36}$/.test(attemptId) || path.resolve(file) !== path.join(path.resolve(runsDirectory(config)), attemptId, filename)) throw Error("Worker files do not belong to this execution attempt");
  assertPrivateRunPath(config, file); return readObject(file, maxBytes);
}

/** Only cited command records and their declared inputs are covered by this check. */
export function readValidationEvidence(config: Config, attemptId: string, records: unknown): ValidationEvidence[] {
  const journal = new RunJournal(runsDirectory(config), attemptId);
  if (!Array.isArray(records) || records.length > 100) throw Error("validationRecords must be an array of this attempt's command record paths");
  return records.map(item => {
    if (typeof item !== "string" || !path.isAbsolute(item) || path.dirname(path.resolve(item)) !== path.join(journal.dir,"commands") || !/^[a-f0-9-]{36}\.json$/.test(path.basename(item))) throw Error("Validation record does not belong to this attempt");
    assertPrivateRunPath(config, item);
    const command = readObject(item, 128 * 1024);
    if (!command.endedAt || command.exitCode !== 0 || command.cleanupConfirmed !== true) throw Error("A cited passing validation must have exitCode=0 and confirmed cleanup");
    const before = command.before, after = command.after;
    if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) || Array.isArray(after) ||
        JSON.stringify(Object.keys(before).sort()) !== JSON.stringify(Object.keys(after).sort())) throw Error("Validation source fingerprints are missing or inconsistent");
    for (const [file, hash] of Object.entries(after)) {
      if (!path.isAbsolute(file) || typeof hash !== "string" || !/^(?:[a-f0-9]{64}|missing)$/.test(hash)) throw Error("Invalid validation source fingerprint");
      // Resolve from the shared authority, never from worker-editable request JSON.
      const source = new DatabaseSync(config.dbFile, { readOnly: true });
      let workspace: string | undefined;
      try { workspace = (source.prepare("SELECT t.workspace FROM tasks t JOIN task_attempts a ON a.task_id=t.task_id WHERE a.attempt_id=?").get(attemptId) as { workspace?: string } | undefined)?.workspace; } finally { source.close(); }
      if (!workspace) throw Error("Validation source has no original workspace binding");
      resolveWorkspaceRead(workspace, file);
      const current = fs.existsSync(file) ? crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "missing";
      if (hash !== current || (before as Record<string, unknown>)[file] !== hash) throw Error("Source changed during or after cited validation; rerun affected checks");
    }
    return { path: item, sha256: crypto.createHash("sha256").update(fs.readFileSync(item)).digest("hex") };
  });
}

export function verifyValidationEvidence(config: Config, attemptId: string, records: ValidationEvidence[]): void {
  const current = readValidationEvidence(config, attemptId, records.map(record => record.path));
  if (current.some((record, index) => record.sha256 !== records[index]?.sha256)) throw Error("Cited validation record changed after the authenticated report; inspect evidence before acceptance");
}

/** Parse bounded, file-based results; DesktopQueue still proves native ancestry and lease. */
export function readWorkerContext(config: Config, claimFile: string) {
  const attemptId = path.basename(path.dirname(path.resolve(claimFile)));
  const context = readWorkerObject(config, attemptId, claimFile, "worker-context.json", 4096);
  for (const field of ["sessionId", "attemptId", "leaseToken"] as const) {
    if (typeof context[field] !== "string" || !context[field]) throw new Error("Invalid worker claim context");
  }
  const journal = new RunJournal(runsDirectory(config), context.attemptId as string);
  if (path.resolve(claimFile) !== path.join(journal.dir, "worker-context.json")) throw new Error("Worker files do not belong to this execution attempt");
  if (context.attemptId !== attemptId) throw Error("Worker claim identity differs from its original directory");
  return {sessionId:context.sessionId as string,attemptId:context.attemptId as string,leaseToken:context.leaseToken as string};
}
export function readWorkerResult(config: Config, claimFile: string, resultFile: string) {
  const context = readWorkerContext(config,claimFile);
  const journal = new RunJournal(runsDirectory(config),context.attemptId);
  if (path.resolve(resultFile) !== path.join(journal.dir,"worker-result.json")) throw new Error("Worker files do not belong to this execution attempt");
  const result = readWorkerObject(config, context.attemptId, resultFile, "worker-result.json", 64 * 1024);
  if (!["completed", "blocked", "failed", "cancelled"].includes(String(result.status))) throw new Error("Invalid worker result status");
  if (typeof result.text !== "string" || !result.text.trim()) throw new Error("A real, nonempty worker result is required");
  if (!Array.isArray(result.artifacts) || result.artifacts.length > 100 ||
      !result.artifacts.every(item => typeof item === "string" && path.isAbsolute(item))) throw new Error("Worker artifacts must be at most 100 absolute paths");
  const validationRecords = readValidationEvidence(config, context.attemptId, result.validationRecords ?? []);
  return {
    sessionId: context.sessionId as string, attemptId: context.attemptId as string, leaseToken: context.leaseToken as string,
    status: result.status as "completed" | "blocked" | "failed" | "cancelled", text: result.text, artifacts: result.artifacts as string[], validationRecords,
  };
}
