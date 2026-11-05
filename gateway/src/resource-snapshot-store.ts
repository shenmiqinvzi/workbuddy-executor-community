import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Saved resource snapshots: the artefact that lets a later reader check that a
 * response it displays is the same document the gateway served.
 *
 * A snapshot is an envelope with a SHA-256 digest of the canonical JSON of its
 * document. Re-reading recomputes the digest over the stored document, so an
 * edited, truncated or hand-patched file is reported as such instead of being
 * rendered as live resource data.
 *
 * Saving refuses a document that carries credential-shaped keys or values: the
 * "export contains no credentials" rule is enforced at the writer, not left to
 * the caller's discipline.
 */
export const RESOURCE_SNAPSHOT_SCHEMA = "workbuddy-executor/resource-snapshot-archive-1";

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const KIND = /^[a-z][a-z0-9-]{0,39}$/;
const ENVELOPE_KEYS = ["schemaVersion", "kind", "savedAt", "digest", "bytes", "documentSchema", "document"];

/** Keys that may legitimately hold a *reference* to a credential. */
const REFERENCE_KEYS = new Set(["credentialRefs", "credentials", "credentialEnv", "credentialSource", "envVar", "purpose", "present"]);
const SECRET_KEY = /^(api_?key|apikey|panel_?token|paneltoken|token|bearer|authorization|cookie|password|secret|private_?key|client_?secret)$/i;
const SECRET_VALUE = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];

export type SnapshotKind = "routing" | "plan-reference" | "quota" | "credit" | "connections" | "request-attribution" | "resource-trust";

export interface SnapshotViolation { path: string; code: "credential_key" | "credential_value" }

export interface SavedSnapshotEnvelope {
  schemaVersion: typeof RESOURCE_SNAPSHOT_SCHEMA;
  kind: SnapshotKind | string;
  savedAt: string;
  /** SHA-256 over the canonical JSON of `document`. */
  digest: string;
  bytes: number;
  documentSchema: string | null;
  document: unknown;
}

export type SnapshotReadResult =
  | { status: "ok"; digest: string; document: unknown; savedAt: string; kind: string }
  | { status: "not_found" | "unreadable" | "corrupt" | "digest_mismatch" | "schema_unsupported"; detail: string };

/** Stable serialisation: object keys sorted, no whitespace, no library change. */
export function canonicalJson(value: unknown): string {
  const walk = (item: unknown): string => {
    if (item === null) return "null";
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "number") return Number.isFinite(item) ? JSON.stringify(item) : "null";
    if (typeof item === "boolean") return item ? "true" : "false";
    if (Array.isArray(item)) return `[${item.map(walk).join(",")}]`;
    if (typeof item === "object") {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${walk(record[key])}`).join(",")}}`;
    }
    return "null";
  };
  return walk(value);
}

/** The digest a reader can compare against `routing`/`plan-reference` output. */
export function snapshotDigest(document: unknown): string {
  return createHash("sha256").update(canonicalJson(document), "utf8").digest("hex");
}

/** Every credential-shaped key or value in a document that would be exported. */
export function findCredentialLeaks(document: unknown): SnapshotViolation[] {
  const violations: SnapshotViolation[] = [];
  const walk = (item: unknown, path: string, referenceContainer: boolean) => {
    if (typeof item === "string") {
      if (SECRET_VALUE.some(pattern => pattern.test(item))) violations.push({ path: path || "document", code: "credential_value" });
      return;
    }
    if (Array.isArray(item)) { item.forEach((entry, index) => walk(entry, `${path}[${index}]`, referenceContainer)); return; }
    if (!item || typeof item !== "object") return;
    for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
      const where = path ? `${path}.${key}` : key;
      // Inside a reference container the keys name a purpose (apiKey, panelToken)
      // and the values name an environment variable, so only the values are
      // still checked for credential-shaped content.
      if (!referenceContainer && SECRET_KEY.test(key) && !REFERENCE_KEYS.has(key)) violations.push({ path: where, code: "credential_key" });
      walk(entry, where, referenceContainer || REFERENCE_KEYS.has(key));
    }
  };
  walk(document, "", false);
  return violations;
}

export interface SaveSnapshotResult {
  status: "saved" | "refused";
  file: string | null;
  digest: string;
  bytes: number;
  violations: SnapshotViolation[];
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Writes one snapshot atomically into `directory` (created when missing).
 * A document that carries a credential is never written.
 */
export function saveResourceSnapshot(input: { directory: string; kind: SnapshotKind | string; document: unknown; savedAt?: Date }): SaveSnapshotResult {
  const savedAt = input.savedAt ?? new Date();
  if (!KIND.test(input.kind)) throw new Error("snapshot_kind_invalid");
  const violations = findCredentialLeaks(input.document);
  const digest = snapshotDigest(input.document);
  if (violations.length) return { status: "refused", file: null, digest, bytes: 0, violations };
  const documentSchema = input.document && typeof input.document === "object" && typeof (input.document as { schemaVersion?: unknown }).schemaVersion === "string"
    ? (input.document as { schemaVersion: string }).schemaVersion
    : null;
  const envelope: SavedSnapshotEnvelope = {
    schemaVersion: RESOURCE_SNAPSHOT_SCHEMA, kind: input.kind, savedAt: savedAt.toISOString(), digest,
    bytes: Buffer.byteLength(canonicalJson(input.document), "utf8"), documentSchema, document: input.document,
  };
  const text = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) throw new Error("snapshot_too_large");
  mkdirSync(input.directory, { recursive: true });
  const name = `${input.kind}-${stamp(savedAt)}-${digest.slice(0, 12)}.json`;
  const file = join(input.directory, name);
  const temporary = join(input.directory, `.${name}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
  return { status: "saved", file, digest, bytes: Buffer.byteLength(text, "utf8"), violations: [] };
}

function parseEnvelope(text: string): SavedSnapshotEnvelope | null {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).length !== ENVELOPE_KEYS.length || Object.keys(envelope).some(key => !ENVELOPE_KEYS.includes(key))) return null;
  if (envelope.schemaVersion !== RESOURCE_SNAPSHOT_SCHEMA) return null;
  if (typeof envelope.kind !== "string" || typeof envelope.savedAt !== "string" || typeof envelope.digest !== "string" || !/^[a-f0-9]{64}$/.test(envelope.digest)) return null;
  if (typeof envelope.bytes !== "number" || !Number.isInteger(envelope.bytes) || envelope.bytes < 0) return null;
  if (envelope.documentSchema !== null && typeof envelope.documentSchema !== "string") return null;
  return envelope as unknown as SavedSnapshotEnvelope;
}

/**
 * Re-reads one snapshot and recomputes its digest. A mismatch is a distinct
 * status: the caller must not fall back to displaying the stored document.
 */
export function readResourceSnapshot(file: string): SnapshotReadResult {
  let text: string;
  try {
    if (statSync(file).size > MAX_SNAPSHOT_BYTES) return { status: "unreadable", detail: "snapshot_too_large" };
    text = readFileSync(file, "utf8");
  }
  catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { status: "not_found", detail: "file_not_found" } : { status: "unreadable", detail: "file_unreadable" };
  }
  const envelope = parseEnvelope(text);
  if (!envelope) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { return { status: "corrupt", detail: "file_not_json" }; }
    const schema = parsed && typeof parsed === "object" ? (parsed as { schemaVersion?: unknown }).schemaVersion : null;
    if (schema !== undefined && schema !== RESOURCE_SNAPSHOT_SCHEMA) return { status: "schema_unsupported", detail: "schema_mismatch" };
    return { status: "corrupt", detail: "envelope_invalid" };
  }
  const actual = snapshotDigest(envelope.document);
  if (actual !== envelope.digest) return { status: "digest_mismatch", detail: "digest_mismatch" };
  return { status: "ok", digest: actual, document: envelope.document, savedAt: envelope.savedAt, kind: envelope.kind };
}

/** The snapshot files in one directory, newest first. Missing directory is empty. */
export function listResourceSnapshots(directory: string): { file: string; name: string; bytes: number }[] {
  let names: string[];
  try { names = readdirSync(directory); }
  catch { return []; }
  return names
    .filter(name => name.endsWith(".json") && !name.startsWith("."))
    .map(name => {
      const file = join(directory, name);
      let bytes = 0;
      try { bytes = statSync(file).size; } catch { bytes = 0; }
      return { file, name, bytes };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}
