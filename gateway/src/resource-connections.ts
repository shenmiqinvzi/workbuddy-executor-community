import { readFileSync } from "node:fs";
import { loopbackOrigin } from "./local-statistics-client.js";

/**
 * The fixed connection register.
 *
 * The deployment used to name its statistics sources only through a handful of
 * environment variables, so nothing on the read surface could say *which*
 * loopback origin, region, pool or model the gateway was pointed at, or explain
 * why a connection stayed empty. This module reads one operator-owned file and
 * turns it into a read-only declaration document.
 *
 * Rules that make it safe to serve:
 *  - the file names an environment *variable* per credential, never a value;
 *    a literal key/token anywhere in the file is rejected by name and never
 *    echoed back, and `present` is the only fact reported about a credential;
 *  - `sourceUrl` must survive the same loopback test the transport applies, so
 *    a declaration can never widen the set of origins the gateway may call;
 *  - a duplicate or ambiguous pool/region/shared declaration is reported as a
 *    conflict and marked `ambiguous` rather than silently collapsing into one
 *    claim;
 *  - nothing here probes upstream: the document is a declaration, and its
 *    status codes say exactly that.
 */
export const RESOURCE_CONNECTIONS_SCHEMA = "workbuddy-executor/resource-connections-1";
export const RESOURCE_CONNECTIONS_ENV = "WORKBUDDY_RESOURCE_CONNECTIONS_FILE";
/** Identifiers the composition root already uses when it builds the collectors. */
export const DEFAULT_QUOTA_CONNECTION_ID = "workbuddy2api-local";
export const DEFAULT_CREDIT_CONNECTION_ID = "workbuddy2api-credit";

const MAX_CONNECTIONS = 16;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_ID = 200;
const MAX_POOLS = 16;
const MAX_MODELS = 64;
const POOL_ID = /^pool-[a-f0-9]{32}$/;
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SECRET_KEY = /^(api_?key|apikey|panel_?token|paneltoken|token|bearer|authorization|cookie|password|secret|private_?key|client_?secret)$/i;
const CONNECTION_KEYS = ["connectionId", "resource", "sourceUrl", "realm", "pools", "models", "shared", "declaredAt", "credentialEnv", "note"];
const DOCUMENT_KEYS = ["schemaVersion", "connections", "note"];

export type ResourceConnectionKind = "quota" | "credit";
export type ResourceConnectionStatus = "declared" | "ambiguous" | "invalid";

export interface RegistryDiagnostic {
  code: string;
  field: string | null;
  /** A short, stable, credential-free explanation. */
  detail: string;
}

export interface DeclaredCredentialReference {
  purpose: "api_key" | "panel_token";
  /** The environment variable name only; the value is never read into this document. */
  envVar: string;
  present: boolean;
}

export interface DeclaredResourceConnection {
  connectionId: string | null;
  resource: ResourceConnectionKind | null;
  /** Normalised loopback origin, or null when the declared value was refused. */
  sourceUrl: string | null;
  realm: "cn" | "intl" | null;
  /** null means "no pool restriction declared", not "any pool was verified". */
  pools: string[] | null;
  /** null means "no model restriction declared"; always null for credit. */
  models: string[] | null;
  shared: boolean | null;
  declaredAt: string | null;
  hasNote: boolean;
  status: ResourceConnectionStatus;
  credentials: DeclaredCredentialReference[];
  diagnostics: RegistryDiagnostic[];
}

export interface ConnectionConflict {
  code: "duplicate_connection" | "duplicate_pool_declaration" | "realm_conflict" | "shared_flag_conflict";
  connectionIds: string[];
  scopeId: string | null;
  detail: string;
}

export interface ResourceConnectionDocument {
  schemaVersion: typeof RESOURCE_CONNECTIONS_SCHEMA;
  readOnly: true;
  source: "file" | "unset";
  declaredVia: typeof RESOURCE_CONNECTIONS_ENV;
  status: "not_declared" | "declared" | "invalid_file";
  fileDiagnostics: RegistryDiagnostic[];
  connections: DeclaredResourceConnection[];
  conflicts: ConnectionConflict[];
  restrictions: {
    loopbackOriginOnly: true;
    fixedReadPathsOnly: true;
    arbitraryUrlProxy: false;
    browserManagerKey: false;
    credentialValuesExposed: false;
    credentialSource: "environment_reference_only";
  };
  limitations: string[];
}

const RESTRICTIONS: ResourceConnectionDocument["restrictions"] = {
  loopbackOriginOnly: true,
  fixedReadPathsOnly: true,
  arbitraryUrlProxy: false,
  browserManagerKey: false,
  credentialValuesExposed: false,
  credentialSource: "environment_reference_only",
};

const LIMITATIONS = ["declaration_only", "no_key_verification", "no_upstream_probe", "declaration_does_not_verify_routing"];

const problem = (code: string, field: string | null, detail: string): RegistryDiagnostic => ({ code, field, detail });

function emptyDocument(source: "file" | "unset", status: ResourceConnectionDocument["status"], fileDiagnostics: RegistryDiagnostic[]): ResourceConnectionDocument {
  return {
    schemaVersion: RESOURCE_CONNECTIONS_SCHEMA, readOnly: true, source, declaredVia: RESOURCE_CONNECTIONS_ENV, status,
    fileDiagnostics, connections: [], conflicts: [], restrictions: { ...RESTRICTIONS }, limitations: [...LIMITATIONS],
  };
}

/** Every credential-shaped key outside the one whitelisted reference object. */
function credentialShapedKeys(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) { value.forEach((item, index) => credentialShapedKeys(item, `${path}[${index}]`, found)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const where = path ? `${path}.${key}` : key;
    const insideCredentialEnv = path.endsWith("credentialEnv") && (key === "apiKey" || key === "panelToken");
    if (!insideCredentialEnv && SECRET_KEY.test(key)) found.push(where);
    else credentialShapedKeys(item, where, found);
  }
}

const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n]/.test(value);

function parsePoolList(value: unknown, field: string, diagnostics: RegistryDiagnostic[]): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) { diagnostics.push(problem("pools_not_array", field, "Declared pools must be an array of pool identifiers.")); return null; }
  if (value.length > MAX_POOLS) { diagnostics.push(problem("pools_not_array", field, "At most 16 pools can be declared per connection.")); return null; }
  const pools: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !POOL_ID.test(item)) { diagnostics.push(problem("pool_id_invalid", `${field}[${index}]`, "A pool identifier looks like pool- followed by 32 lowercase hex characters.")); continue; }
    if (!pools.includes(item)) pools.push(item);
  }
  return pools;
}

function parseModelList(value: unknown, field: string, diagnostics: RegistryDiagnostic[]): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) { diagnostics.push(problem("models_not_array", field, "Declared models must be an array of model identifiers.")); return null; }
  if (value.length > MAX_MODELS) { diagnostics.push(problem("models_not_array", field, "At most 64 models can be declared per connection.")); return null; }
  const models: string[] = [];
  for (const [index, item] of value.entries()) {
    if (!bounded(item, MAX_ID)) { diagnostics.push(problem("model_id_invalid", `${field}[${index}]`, "A model identifier must be a non-empty bounded string.")); continue; }
    if (!models.includes(item)) models.push(item);
  }
  return models;
}

function parseCredentials(value: unknown, env: NodeJS.ProcessEnv, field: string, diagnostics: RegistryDiagnostic[]): DeclaredCredentialReference[] {
  const references: DeclaredCredentialReference[] = [];
  if (value === undefined || value === null) { diagnostics.push(problem("credential_reference_missing", field, "Declare the environment variable that holds the API key.")); return references; }
  if (typeof value !== "object" || Array.isArray(value)) { diagnostics.push(problem("credential_reference_invalid", field, "Credential references must be an object of environment variable names.")); return references; }
  for (const [purpose, name] of Object.entries(value as Record<string, unknown>)) {
    if (purpose !== "apiKey" && purpose !== "panelToken") { diagnostics.push(problem("unexpected_field", `${field}.${purpose}`, "Only apiKey and panelToken can be referenced.")); continue; }
    if (typeof name !== "string" || !ENV_NAME.test(name)) { diagnostics.push(problem("credential_reference_invalid", `${field}.${purpose}`, "A credential reference is an upper-case environment variable name, never the value.")); continue; }
    const value0 = env[name];
    references.push({ purpose: purpose === "apiKey" ? "api_key" : "panel_token", envVar: name, present: typeof value0 === "string" && value0.length > 0 });
  }
  if (!references.some(item => item.purpose === "api_key")) diagnostics.push(problem("credential_reference_missing", `${field}.apiKey`, "Declare the environment variable that holds the API key."));
  return references;
}

function parseConnection(raw: unknown, env: NodeJS.ProcessEnv, index: number): DeclaredResourceConnection {
  const diagnostics: RegistryDiagnostic[] = [];
  const connection: DeclaredResourceConnection = {
    connectionId: null, resource: null, sourceUrl: null, realm: null, pools: null, models: null,
    shared: null, declaredAt: null, hasNote: false, status: "invalid", credentials: [], diagnostics,
  };
  const at = `connections[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { diagnostics.push(problem("connection_not_object", at, "A connection must be an object.")); return connection; }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (SECRET_KEY.test(key)) diagnostics.push(problem("inline_credential_rejected", `${at}.${key}`, "Credentials are referenced by environment variable name, never inlined."));
    else if (!CONNECTION_KEYS.includes(key)) diagnostics.push(problem("unexpected_field", `${at}.${key}`, "Unknown connection field."));
  }

  if (bounded(value.connectionId, MAX_ID) && CONNECTION_ID.test(value.connectionId)) connection.connectionId = value.connectionId;
  else diagnostics.push(problem("connection_id_invalid", `${at}.connectionId`, "A connection identifier must start with a letter or digit and stay within 200 characters."));

  if (value.resource === "quota" || value.resource === "credit") connection.resource = value.resource;
  else diagnostics.push(problem("resource_invalid", `${at}.resource`, "A connection serves exactly one resource: quota or credit."));

  if (typeof value.sourceUrl === "string") {
    try { connection.sourceUrl = loopbackOrigin(value.sourceUrl); }
    catch { diagnostics.push(problem("source_url_invalid", `${at}.sourceUrl`, "The source must be an explicit loopback http origin with no path, query, fragment or credentials.")); }
  } else diagnostics.push(problem("source_url_invalid", `${at}.sourceUrl`, "The source must be an explicit loopback http origin with no path, query, fragment or credentials."));

  if (value.realm === "cn" || value.realm === "intl") connection.realm = value.realm;
  else diagnostics.push(problem("realm_invalid", `${at}.realm`, "A declared realm is cn or intl; an unknown realm is never assumed."));

  connection.pools = parsePoolList(value.pools, `${at}.pools`, diagnostics);
  connection.models = parseModelList(value.models, `${at}.models`, diagnostics);
  // 空 models 列表等于“没有模型限制”，正是积分载荷能支持的形态；只有真的想限制模型才报不支持。
  if (connection.resource === "credit" && connection.models && connection.models.length > 0) diagnostics.push(problem("models_not_supported", `${at}.models`, "The credit payload carries no per-model dimension, so a model restriction cannot be declared here."));

  if (value.shared !== undefined) {
    if (typeof value.shared === "boolean") connection.shared = value.shared;
    else diagnostics.push(problem("shared_invalid", `${at}.shared`, "shared is a boolean; an unshared claim would need exclusive reservation evidence."));
  }

  if (value.declaredAt !== undefined) {
    const declaredAt = typeof value.declaredAt === "string" && Number.isFinite(Date.parse(value.declaredAt)) ? new Date(value.declaredAt).toISOString() : null;
    if (declaredAt && declaredAt === value.declaredAt) connection.declaredAt = declaredAt;
    else diagnostics.push(problem("declared_at_invalid", `${at}.declaredAt`, "declaredAt must be a canonical ISO timestamp."));
  }

  // The note is operator prose: its presence is reported, its text never is.
  connection.hasNote = typeof value.note === "string" && value.note.length > 0;
  connection.credentials = parseCredentials(value.credentialEnv, env, `${at}.credentialEnv`, diagnostics);
  connection.status = diagnostics.length ? "invalid" : "declared";
  return connection;
}

function conflictsOf(connections: DeclaredResourceConnection[]): { conflicts: ConnectionConflict[]; byIndex: Map<number, ConnectionConflict[]> } {
  const conflicts: ConnectionConflict[] = [];
  const byIndex = new Map<number, ConnectionConflict[]>();
  const note = (index: number, conflict: ConnectionConflict) => {
    const list = byIndex.get(index) ?? [];
    list.push(conflict);
    byIndex.set(index, list);
  };
  const keyed = connections.map((connection, index) => ({ connection, index })).filter(item => item.connection.connectionId && item.connection.resource);

  const byIdentity = new Map<string, { connection: DeclaredResourceConnection; index: number }[]>();
  for (const item of keyed) {
    const key = `${item.connection.resource}:${item.connection.connectionId}`;
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), item]);
  }
  for (const [key, group] of byIdentity) {
    if (group.length < 2) continue;
    const conflict: ConnectionConflict = { code: "duplicate_connection", connectionIds: group.map(item => item.connection.connectionId!), scopeId: null, detail: `The identifier ${key} is declared ${group.length} times.` };
    conflicts.push(conflict);
    for (const item of group) note(item.index, conflict);
  }

  const byPool = new Map<string, { connection: DeclaredResourceConnection; index: number }[]>();
  for (const item of keyed) for (const pool of item.connection.pools ?? []) byPool.set(pool, [...(byPool.get(pool) ?? []), item]);
  for (const [pool, group] of byPool) {
    const unique = [...new Map(group.map(item => [`${item.connection.resource}:${item.connection.connectionId}`, item])).values()];
    if (unique.length < 2) continue;
    const realms = new Set(unique.map(item => item.connection.realm));
    const sharedFlags = new Set(unique.map(item => item.connection.shared));
    const code: ConnectionConflict["code"] = realms.size > 1 ? "realm_conflict" : sharedFlags.size > 1 ? "shared_flag_conflict" : "duplicate_pool_declaration";
    const detail = code === "realm_conflict"
      ? `Pool ${pool} is declared with more than one realm; the pool-to-region mapping stays unresolved.`
      : code === "shared_flag_conflict"
        ? `Pool ${pool} is declared both shared and unshared; no exclusive reservation is claimed.`
        : `Pool ${pool} is declared by ${unique.length} connections; the duplicate is reported, not merged.`;
    const conflict: ConnectionConflict = { code, connectionIds: unique.map(item => item.connection.connectionId!), scopeId: pool, detail };
    conflicts.push(conflict);
    for (const item of unique) note(item.index, conflict);
  }

  for (const [index, list] of byIndex) {
    const connection = connections[index]!;
    for (const conflict of list) connection.diagnostics.push(problem(conflict.code, "pools", conflict.detail));
    connection.status = "ambiguous";
  }
  return { conflicts, byIndex };
}

/** Parses a declaration file body. Exported so the loader can be tested without a file. */
export function parseResourceConnections(text: string, env: NodeJS.ProcessEnv = process.env): ResourceConnectionDocument {
  const found: string[] = [];
  credentialShapedKeys(text ? safeJson(text) : null, "", found);
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return emptyDocument("file", "invalid_file", [problem("file_not_json", null, "The declaration file is not valid JSON.")]); }
  const fileDiagnostics: RegistryDiagnostic[] = [];
  if (found.length) fileDiagnostics.push(problem("inline_credential_rejected", found[0]!, "A credential value appears in the declaration file; only environment variable names are accepted."));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fileDiagnostics.push(problem("document_not_object", null, "The declaration file must contain one object."));
    return emptyDocument("file", "invalid_file", fileDiagnostics);
  }
  const document = value as Record<string, unknown>;
  for (const key of Object.keys(document)) {
    if (SECRET_KEY.test(key)) { if (!fileDiagnostics.some(item => item.code === "inline_credential_rejected")) fileDiagnostics.push(problem("inline_credential_rejected", key, "A credential value appears in the declaration file; only environment variable names are accepted.")); }
    else if (!DOCUMENT_KEYS.includes(key)) fileDiagnostics.push(problem("unexpected_field", key, "Unknown declaration field."));
  }
  if (document.schemaVersion !== RESOURCE_CONNECTIONS_SCHEMA) {
    fileDiagnostics.push(problem("schema_unsupported", "schemaVersion", `The declaration schema must be ${RESOURCE_CONNECTIONS_SCHEMA}.`));
    return emptyDocument("file", "invalid_file", fileDiagnostics);
  }
  if (!Array.isArray(document.connections)) {
    fileDiagnostics.push(problem("connections_not_array", "connections", "connections must be an array."));
    return emptyDocument("file", "invalid_file", fileDiagnostics);
  }
  if (document.connections.length > MAX_CONNECTIONS) fileDiagnostics.push(problem("too_many_connections", "connections", `At most ${MAX_CONNECTIONS} connections can be declared.`));

  const connections = document.connections.slice(0, MAX_CONNECTIONS).map((raw, index) => parseConnection(raw, env, index));
  const { conflicts } = conflictsOf(connections);
  const usable = connections.filter(item => item.status === "declared").length;
  return {
    schemaVersion: RESOURCE_CONNECTIONS_SCHEMA, readOnly: true, source: "file", declaredVia: RESOURCE_CONNECTIONS_ENV,
    status: usable > 0 ? "declared" : connections.length ? "invalid_file" : "declared",
    fileDiagnostics, connections, conflicts, restrictions: { ...RESTRICTIONS }, limitations: [...LIMITATIONS],
  };
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return null; }
}

/** Reads the declaration file named by the environment. Never throws for a
 *  missing or malformed file: an unusable declaration is still a status, and a
 *  read-only route must not fail because of it. */
export function readResourceConnections(env: NodeJS.ProcessEnv = process.env): ResourceConnectionDocument {
  const file = env[RESOURCE_CONNECTIONS_ENV];
  if (!file) return emptyDocument("unset", "not_declared", []);
  let text: string;
  try { text = readFileSync(file, "utf8"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "file_not_found" : "file_unreadable";
    return emptyDocument("file", "invalid_file", [problem(code, null, "The declaration file could not be read; no connection is treated as declared.")]);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) return emptyDocument("file", "invalid_file", [problem("file_too_large", null, "The declaration file exceeds 256 KiB.")]);
  return parseResourceConnections(text, env);
}

/* ------------------------------------------------------------------ *
 * Declaration × observation diagnostics
 * ------------------------------------------------------------------ */

interface QuotaConnectionRow { connectionId: string; status: string; errorCode: string | null; snapshotId: string | null }
interface QuotaObservationRow { scopeId: string; realm: string; modelId: string; connectionId: string; connectionIds: string[] }
interface CreditConnectionRow { connectionId: string; status: string; errorCode: string | null; snapshotId: string | null }
interface CreditBalanceRow { scopeId: string; realm: string; connectionId: string; connectionIds: string[] }

export interface ConnectionDiagnosis {
  connectionId: string;
  resource: ResourceConnectionKind;
  declaration: "declared" | "ambiguous" | "invalid" | "missing";
  observation: { status: string | null; errorCode: string | null; snapshotId: string | null; pools: string[]; models: string[] };
  codes: string[];
  notes: string[];
}

export interface ResourceConnectionDiagnostics {
  readOnly: true;
  declarationStatus: ResourceConnectionDocument["status"];
  attribution: "connection_only";
  connections: ConnectionDiagnosis[];
  undeclaredObserved: { connectionId: string; resource: ResourceConnectionKind; status: string; errorCode: string | null }[];
  summary: { declared: number; usable: number; flagged: number; observed: number; undeclaredObserved: number; conflicts: number };
  limitations: string[];
}

const NO_OBSERVATION = { status: null, errorCode: null, snapshotId: null, pools: [] as string[], models: [] as string[] };

/**
 * Explains each declared connection against what the collectors stored.
 *
 * The two sides are kept apart on purpose: a declaration says what the
 * deployment was pointed at, an observation says what one saved snapshot
 * contains. A declaration is never upgraded into "this connection serves this
 * pool"; a difference becomes a code, not a merge.
 */
export function diagnoseResourceConnections(
  registry: ResourceConnectionDocument,
  quota: { connections: QuotaConnectionRow[]; observations: QuotaObservationRow[] },
  credit: { connections: CreditConnectionRow[]; balances: CreditBalanceRow[] },
): ResourceConnectionDiagnostics {
  const quotaRows = new Map(quota.connections.map(row => [row.connectionId, row]));
  const creditRows = new Map(credit.connections.map(row => [row.connectionId, row]));
  const quotaPools = new Map<string, { pools: Set<string>; models: Set<string> }>();
  for (const observation of quota.observations) {
    for (const connectionId of new Set([observation.connectionId, ...observation.connectionIds])) {
      const entry = quotaPools.get(connectionId) ?? { pools: new Set<string>(), models: new Set<string>() };
      entry.pools.add(observation.scopeId);
      entry.models.add(observation.modelId);
      quotaPools.set(connectionId, entry);
    }
  }
  const creditPools = new Map<string, Set<string>>();
  for (const balance of credit.balances) {
    for (const connectionId of new Set([balance.connectionId, ...balance.connectionIds])) {
      const pools = creditPools.get(connectionId) ?? new Set<string>();
      pools.add(balance.scopeId);
      creditPools.set(connectionId, pools);
    }
  }
  const realmOf = new Map<string, string>();
  for (const observation of quota.observations) realmOf.set(observation.scopeId, observation.realm);
  for (const balance of credit.balances) realmOf.set(balance.scopeId, balance.realm);

  const connections: ConnectionDiagnosis[] = [];
  for (const declared of registry.connections) {
    if (!declared.connectionId || !declared.resource) continue;
    const resource = declared.resource;
    const row = resource === "quota" ? quotaRows.get(declared.connectionId) : creditRows.get(declared.connectionId);
    const pools = resource === "quota" ? [...(quotaPools.get(declared.connectionId)?.pools ?? [])] : [...(creditPools.get(declared.connectionId) ?? [])];
    const models = resource === "quota" ? [...(quotaPools.get(declared.connectionId)?.models ?? [])] : [];
    const observation = row ? { status: row.status, errorCode: row.errorCode, snapshotId: row.snapshotId, pools, models } : { ...NO_OBSERVATION, pools, models };
    const codes: string[] = [];
    const notes: string[] = [];
    if (declared.status === "invalid") { codes.push("declaration_invalid"); notes.push("The declaration cannot bind a scope; the stored observation stands on its own."); }
    if (declared.status === "ambiguous") { codes.push("declaration_ambiguous"); notes.push("A duplicate or conflicting declaration was reported; it is not resolved by picking one."); }
    for (const credential of declared.credentials) {
      if (!credential.present) { codes.push("credential_absent"); notes.push(`The environment variable ${credential.envVar} is not set in this process.`); break; }
    }
    if (!row) { codes.push("declared_not_configured"); notes.push("Declared, but this deployment stored no observation under that identifier."); }
    else {
      codes.push("declared_and_observed");
      if (row.errorCode) { codes.push(`observed_source_error:${row.errorCode}`); notes.push("The last collection of this connection reported an error; its saved snapshot is not refreshed."); }
      if (row.snapshotId === null) { codes.push("declared_no_snapshot"); notes.push("The connection is configured but no snapshot was ever stored."); }
    }
    if (declared.pools) {
      const outside = pools.filter(pool => !declared.pools!.includes(pool));
      if (outside.length) { codes.push("observed_pool_outside_declaration"); notes.push("The stored snapshot names a pool the declaration does not allow."); }
      const missing = declared.pools.filter(pool => !pools.includes(pool));
      if (missing.length) { codes.push("declared_pool_not_observed"); notes.push("A declared pool did not appear in any stored snapshot."); }
      const mismatched = declared.pools.filter(pool => realmOf.get(pool) !== undefined && declared.realm !== null && realmOf.get(pool) !== declared.realm);
      if (mismatched.length) { codes.push("realm_mismatch"); notes.push("A declared pool was observed under a different realm."); }
    }
    if (declared.models) {
      const missing = declared.models.filter(model => !models.includes(model));
      if (missing.length) { codes.push("declared_model_not_observed"); notes.push("A declared model did not appear in any stored snapshot."); }
    }
    connections.push({
      connectionId: declared.connectionId, resource, declaration: declared.status === "declared" ? "declared" : declared.status,
      observation, codes, notes,
    });
  }

  const declaredKeys = new Set(registry.connections.filter(item => item.connectionId).map(item => `${item.resource}:${item.connectionId}`));
  const undeclaredObserved = [
    ...quota.connections.map(row => ({ connectionId: row.connectionId, resource: "quota" as const, status: row.status, errorCode: row.errorCode })),
    ...credit.connections.map(row => ({ connectionId: row.connectionId, resource: "credit" as const, status: row.status, errorCode: row.errorCode })),
  ].filter(row => !declaredKeys.has(`${row.resource}:${row.connectionId}`));

  // "Usable" means the declaration is unambiguous and its key reference is
  // actually set in this process; anything else is counted as flagged.
  const usable = connections.filter(item => item.declaration === "declared" && !item.codes.includes("credential_absent")).length;
  return {
    readOnly: true, declarationStatus: registry.status, attribution: "connection_only",
    connections,
    undeclaredObserved,
    summary: {
      declared: connections.length,
      usable,
      flagged: connections.length - usable,
      observed: connections.filter(item => item.observation.status !== null).length,
      undeclaredObserved: undeclaredObserved.length,
      conflicts: registry.conflicts.length,
    },
    // The declaration explains configuration; it is not evidence of a route.
    limitations: ["declaration_only", "diagnostics_do_not_probe_upstream", "declaration_does_not_verify_routing", "credential_presence_only"],
  };
}
