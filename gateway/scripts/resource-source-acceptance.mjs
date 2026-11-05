#!/usr/bin/env node
/**
 * Repeatable acceptance for the real statistics sources.
 *
 * The gateway already knows how to collect local WorkBuddy statistics: the
 * collectors in `src/quota-observation.ts` and `src/credit-balance.ts` read the
 * loopback endpoints, persist a snapshot, and the read-only HTTP service serves
 * it. What was missing was a way to answer, repeatedly and without guessing,
 * "does the real source work from this machine, and what exactly was proven?".
 *
 * Two modes, both strictly read-only:
 *
 *   --check    Offline condition report. Validates the configured origin and the
 *              presence of the credential fields, then reports ready / missing.
 *              It performs no network request, never logs in to the hub and can
 *              never report a pass.
 *
 *   --execute  One bounded read per requested source, through the production
 *              collector, the production store and the production HTTP server,
 *              all bound to a run-owned state directory and an ephemeral
 *              loopback port. Nothing touches the deployed gateway, task
 *              database or configuration, and no model request is made.
 *
 * State ownership: `--state-dir` names a *parent* directory. The tool creates a
 * unique `resource-source-acceptance-*` directory inside it and removes only
 * that directory, after checking that it really is the directory this run
 * created. A caller's own files, including a pre-existing `resources.sqlite`,
 * are never opened, migrated, overwritten or deleted.
 *
 * Database neutrality: reads are compared through a second connection that
 * samples `PRAGMA data_version` and a content digest of every table, so a
 * committed write during the read window is detected even when it stays in the
 * write-ahead log and the database file's own bytes do not change.
 *
 * Shutdown: the collectors, the HTTP server and the store are closed one by
 * one, each result is recorded, and the port is probed afterwards. A resource
 * that cannot be confirmed closed fails the run; its state directory is then
 * kept rather than deleted underneath a live service.
 *
 * Exit codes: 0 executed and every check passed; 1 executed and something
 * failed; 2 conditions missing, nothing (or not everything) executed.
 *
 * Credentials are read from the process environment only. Values, headers and
 * payload bodies never reach stdout, the report file or an error message; the
 * report carries presence flags, status classes, schema names, coverage,
 * timestamps and counts.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL, fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.join(scriptDir, "..");

/** Prefix of the directory this tool creates and owns. */
const STATE_PREFIX = "resource-source-acceptance-";

/** Upper bound for one close call; the acceptance must never hang on shutdown. */
const CLOSE_TIMEOUT_MS = 5000;

function distModule(relative) {
  return import(pathToFileURL(path.join(gatewayRoot, "dist", relative)).href);
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Mirrors the client's own loopback rule so the check fails for the same reasons. */
function describeOrigin(raw) {
  if (!present(raw)) return { state: "missing" };
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:") return { state: "invalid", reason: "not_http" };
    if (!["127.0.0.1", "[::1]"].includes(url.hostname)) return { state: "invalid", reason: "not_loopback" };
    if (url.username || url.password) return { state: "invalid", reason: "url_has_credentials" };
    if (url.search || url.hash || url.pathname !== "/") return { state: "invalid", reason: "url_has_path_or_query" };
    return { state: "ok", port: Number(url.port || 80) };
  } catch {
    return { state: "invalid", reason: "unparsable" };
  }
}

/**
 * Offline condition report. No request is made, so an unreachable hub or a wrong
 * key is not detected here; this mode only answers "is this machine configured
 * for a read at all". `ready` is about conditions, never about acceptance.
 */
export function checkConditions(env = process.env) {
  const token = {
    source: "token",
    fields: {
      url: describeOrigin(env.WORKBUDDY_QUOTA_SOURCE_URL),
      apiKey: { state: present(env.WORKBUDDY_QUOTA_API_KEY) ? "ok" : "missing" },
      // /usage/remaining is a panel route: the hub answers it for a valid panel
      // session token, and a panel password is not a session token.
      panelToken: { state: present(env.WORKBUDDY_QUOTA_PANEL_TOKEN) ? "ok" : "missing" },
    },
    explanation: "token statistics need the loopback origin, an API key and a panel session token issued by POST /panel/login",
  };
  const credit = {
    source: "credit",
    fields: {
      url: describeOrigin(env.WORKBUDDY_CREDIT_SOURCE_URL),
      apiKey: { state: present(env.WORKBUDDY_CREDIT_API_KEY) ? "ok" : "missing" },
    },
    explanation: "credit statistics need the loopback origin and an API key; the panel session is not used",
  };
  for (const entry of [token, credit]) {
    entry.missing = Object.entries(entry.fields).filter(([, value]) => value.state !== "ok").map(([name]) => name);
    entry.ready = entry.missing.length === 0;
  }
  const build = fs.existsSync(path.join(gatewayRoot, "dist", "workbench-http.js"));
  return {
    mode: "check",
    executed: false,
    accepted: false,
    node: process.version,
    build: build ? "present" : "missing",
    ready: build && (token.ready || credit.ready),
    sources: { token, credit },
    actions: [
      ...(build ? [] : ["run `npm run build` so the acceptance can drive the compiled collectors"]),
      ...(token.ready ? [] : ["token: provide WORKBUDDY_QUOTA_SOURCE_URL, WORKBUDDY_QUOTA_API_KEY and WORKBUDDY_QUOTA_PANEL_TOKEN in the protected process that runs the acceptance"]),
      ...(credit.ready ? [] : ["credit: provide WORKBUDDY_CREDIT_SOURCE_URL and WORKBUDDY_CREDIT_API_KEY in the protected process that runs the acceptance"]),
    ],
    note: "conditions only; a real read is only claimed by --execute, and a missing condition is never reported as a pass",
  };
}

function request(port, requestPath, method = "GET") {
  return fetch(`http://127.0.0.1:${port}${requestPath}`, { method, headers: { host: `127.0.0.1:${port}` } }).then(async response => ({
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: await response.json().catch(() => null),
  }));
}

/**
 * Records which upstream requests the production collectors make without
 * touching their code: the tool owns the process, so it wraps fetch and keeps
 * only method and path. Headers and bodies are dropped before anything could
 * print them.
 */
export function trackUpstream(origins) {
  const original = globalThis.fetch;
  const wanted = new Set(origins);
  const calls = [];
  globalThis.fetch = (input, init) => {
    const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
    if (wanted.has(url.origin)) calls.push({ method: (init?.method ?? "GET").toUpperCase(), path: url.pathname });
    return original(input, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function check(id, ok, detail = {}) {
  return { id, ok: Boolean(ok), ...detail };
}

function isIso(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function errorCode(error) {
  if (error && typeof error === "object") {
    if (typeof error.code === "string") return error.code;
    if (error.name === "StatisticsSourceError") return "source_error";
  }
  return "acceptance_error";
}

function failure(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

/**
 * Creates the run-owned directory.
 *
 * A caller-provided `stateDir` is a *parent*: the run root is a fresh
 * `resource-source-acceptance-*` directory created inside it, so nothing the
 * caller already had is reused. Without `stateDir` the run root is a temporary
 * directory that is also exclusively this run's.
 */
function allocateStateRoot(stateDir) {
  if (!stateDir) {
    const root = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), STATE_PREFIX)));
    return { root, parent: path.resolve(os.tmpdir()), external: false };
  }
  const parent = path.resolve(stateDir);
  fs.mkdirSync(parent, { recursive: true });
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw failure("state_parent_not_a_directory");
  const root = path.resolve(fs.mkdtempSync(path.join(parent, STATE_PREFIX)));
  return { root, parent, external: true };
}

/**
 * Removes the run-owned directory, and nothing else.
 *
 * Ownership is proved from resolved paths: the root must be a real directory
 * (not a symbolic link or junction), must carry the tool's prefix, and must sit
 * directly inside the parent recorded when it was created. Any doubt raises
 * instead of widening the deletion.
 */
function removeOwnedRoot(stateRoot) {
  let realRoot;
  let realParent;
  try {
    realRoot = fs.realpathSync(stateRoot.root);
    realParent = fs.realpathSync(stateRoot.parent);
  } catch (error) {
    if (error && error.code === "ENOENT") return { removed: false, code: "already_absent" };
    throw failure("state_root_unreadable");
  }
  if (path.dirname(realRoot) !== realParent) throw failure("state_root_outside_parent");
  if (!path.basename(realRoot).startsWith(STATE_PREFIX)) throw failure("state_root_not_owned");
  const stat = fs.lstatSync(realRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure("state_root_not_a_directory");
  fs.rmSync(realRoot, { recursive: true, force: false, maxRetries: 2 });
  return { removed: true, code: null };
}

/**
 * A second connection used only to observe the database.
 *
 * `PRAGMA data_version` is per connection and changes when *another* connection
 * commits, which covers both an independent writer and the store's own
 * connection (the observer is a different connection either way). On top of
 * that the sample digests every table's rows, so an in-place update that leaves
 * `data_version` alone is still visible. The observer never writes.
 */
function openDatabaseObserver(dbFile) {
  let db;
  let mode = "read_only";
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    // A read-only handle can be refused when the -shm file cannot be opened for
    // writing; a plain handle still only issues reads here.
    mode = "plain";
    db = new DatabaseSync(dbFile);
  }
  const sample = () => {
    const version = Number(db.prepare("PRAGMA data_version").get()?.data_version ?? -1);
    const userVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? -1);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const digest = crypto.createHash("sha256");
    digest.update(`version=${version}\u0000user=${userVersion}\u0000`);
    let rows = 0;
    for (const table of tables) {
      const name = String(table.name);
      const encoded = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all().map(row => JSON.stringify(row)).sort();
      digest.update(`${name}\u0000${encoded.length}\u0000`);
      for (const row of encoded) digest.update(row).update("\u0001");
      rows += encoded.length;
    }
    return { version, userVersion, tables: tables.length, rows, digest: digest.digest("hex") };
  };
  return { mode, sample, close: () => { try { db.close(); } catch { /* a closed observer leaks nothing */ } } };
}

/** Resolves once the loopback port refuses connections (or the probe times out). */
function portIsClosed(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = value => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.once("timeout", () => finish(false));
  });
}

/** Runs one close, bounded, and keeps only a code when it fails. */
async function closeBounded(resource, action) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure("close_timeout")), CLOSE_TIMEOUT_MS); }),
    ]);
    return { resource, closed: true };
  } catch (error) {
    return { resource, closed: false, code: errorCode(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One bounded read through the production chain.
 *
 * `source` is "token", "credit" or "both". A source without conditions is
 * reported as not executed instead of being replaced by synthetic data, so a
 * one-sided pass can never read as both sides passing.
 *
 * `instrument` is a test seam only: the callbacks receive the objects this run
 * created so a regression can inject a failure. Production callers omit it, and
 * every callback runs before the checks are computed.
 */
export async function runAcceptance({ source = "both", env = process.env, timeoutMs = 5000, stateDir, keep = false, now = () => Date.now(), instrument = {} } = {}) {
  const conditions = checkConditions(env);
  const wanted = source === "both" ? ["token", "credit"] : [source];
  const selected = wanted.filter(name => (name === "token" ? conditions.sources.token.ready : conditions.sources.credit.ready));
  if (selected.length === 0) {
    return { mode: "execute", executed: false, accepted: false, exitCode: 2, sources: [], notExecuted: wanted, conditions, checks: [], note: "no requested source has complete conditions; nothing was read" };
  }

  let stateRoot;
  try {
    stateRoot = allocateStateRoot(stateDir);
  } catch (error) {
    return {
      mode: "execute",
      executed: false,
      accepted: false,
      exitCode: 1,
      sources: [],
      notExecuted: wanted,
      checks: [check("state_directory_ready", false, { code: errorCode(error) })],
      note: "the run-owned state directory could not be created; nothing was read and nothing was deleted",
    };
  }
  fs.mkdirSync(path.join(stateRoot.root, "runs"), { recursive: true });
  const dbFile = path.join(stateRoot.root, "resources.sqlite");
  const notExecuted = wanted.filter(name => !selected.includes(name));
  const checks = [];
  let server;
  let store;
  let observer;
  let tracker;
  let port;
  const collectors = [];
  try {
    const { TaskStore } = await distModule("task-store.js");
    const { TaskApplicationService } = await distModule("task-application-service.js");
    const { WorkbenchHttpServer, workbenchHealth } = await distModule("workbench-http.js");
    const { WorkBuddyQuotaCollector } = await distModule("quota-observation.js");
    const { WorkBuddyCreditBalanceCollector } = await distModule("credit-balance.js");

    // A task store is required by the shared service, but this acceptance never
    // creates a task: the database stays empty and its content must stay
    // identical. It lives inside the run-owned directory only.
    store = new TaskStore(dbFile);
    const service = new TaskApplicationService({ store }, 3, path.join(stateRoot.root, "runs"));
    server = new WorkbenchHttpServer({ service, health: () => workbenchHealth({ runtime: { release: "acceptance", packageVersion: "0.0.0", startedAt: new Date().toISOString() } }) });
    port = Number(await server.listen(0));
    checks.push(check("isolated_service_listening", true, { loopback: true, port }));
    observer = openDatabaseObserver(dbFile);
    await instrument.afterListening?.({ server, store, service, port, dbFile });

    const origins = selected.map(name => new URL(name === "token" ? env.WORKBUDDY_QUOTA_SOURCE_URL : env.WORKBUDDY_CREDIT_SOURCE_URL).origin);
    tracker = trackUpstream(origins);
    const shared = { port, dbFile, tracker, now, service, observer, store, instrument };

    if (selected.includes("token")) {
      const collector = new WorkBuddyQuotaCollector(store.quotas, {
        id: env.WORKBUDDY_QUOTA_SOURCE_ID ?? "workbuddy2api-local",
        baseUrl: env.WORKBUDDY_QUOTA_SOURCE_URL,
        apiKey: env.WORKBUDDY_QUOTA_API_KEY,
        panelToken: env.WORKBUDDY_QUOTA_PANEL_TOKEN,
        intervalMs: 3600000,
        timeoutMs,
      });
      collectors.push(collector);
      await instrument.afterCollectors?.({ collectors });
      checks.push(...(await readSource("token", { collector, ...shared })));
    }
    if (selected.includes("credit")) {
      const collector = new WorkBuddyCreditBalanceCollector(store.creditBalances, {
        id: env.WORKBUDDY_CREDIT_SOURCE_ID ?? "workbuddy2api-credit",
        baseUrl: env.WORKBUDDY_CREDIT_SOURCE_URL,
        apiKey: env.WORKBUDDY_CREDIT_API_KEY,
        intervalMs: 3600000,
        timeoutMs,
      });
      collectors.push(collector);
      await instrument.afterCollectors?.({ collectors });
      checks.push(...(await readSource("credit", { collector, ...shared })));
    }

    tracker.restore();
    checks.push(check("no_model_requests", tracker.calls.every(call => call.method === "GET" && ["/usage/remaining", "/v1/balance-summary"].includes(call.path)), {
      upstreamReads: tracker.calls.length,
      paths: [...new Set(tracker.calls.map(call => call.path))],
    }));
  } catch (error) {
    // Only a code is kept: an error object can carry a URL with a credential or
    // an upstream body inside its message.
    checks.push(check("acceptance_completed", false, { code: errorCode(error) }));
  } finally {
    tracker?.restore();
    const shutdown = [];
    for (const [index, collector] of collectors.entries()) {
      shutdown.push(await closeBounded(`collector_${index}`, () => collector.stop()));
    }
    if (server) shutdown.push(await closeBounded("server", () => server.close()));
    // The wrapper exposes no `listening` flag and its `close` can resolve while
    // the socket is still bound, so the port itself is probed.
    const portClosed = server && port ? await portIsClosed(port) : null;
    if (store) shutdown.push(await closeBounded("store", () => store.close()));
    observer?.close();
    const closed = shutdown.every(entry => entry.closed) && portClosed !== false;
    checks.push(check("services_closed", closed, {
      resources: shutdown.map(entry => ({ resource: entry.resource, closed: entry.closed, code: entry.code ?? null })),
      portClosed,
    }));

    let cleanup = { removed: false, code: null };
    if (!keep) {
      if (closed) {
        try {
          cleanup = removeOwnedRoot(stateRoot);
        } catch (error) {
          cleanup = { removed: false, code: errorCode(error) };
        }
      } else {
        // Deleting the directory a live service still uses would fake a cleanup.
        cleanup = { removed: false, code: "kept_after_close_failure" };
      }
    }
    checks.push(check("state_cleanup", !cleanup.code || cleanup.code === "kept_after_close_failure", { ...cleanup, kept: keep }));
  }
  const failed = checks.filter(entry => !entry.ok);
  const closeFailed = checks.some(entry => entry.id === "services_closed" && !entry.ok);
  const retained = keep || closeFailed;
  return {
    mode: "execute",
    executed: true,
    accepted: failed.length === 0 && notExecuted.length === 0,
    exitCode: failed.length > 0 ? 1 : notExecuted.length > 0 ? 2 : 0,
    sources: selected,
    notExecuted,
    stateRoot: stateRoot.root,
    stateDir: retained ? stateRoot.root : null,
    stateRetention: keep ? "kept" : closeFailed ? "kept_after_close_failure" : "removed",
    passed: checks.length - failed.length,
    failed: failed.length,
    checks,
  };
}

/**
 * Verifies one source end to end.
 *
 * The collector runs first, then the store is read, then the HTTP endpoints are
 * read while the upstream call count and the database sample are measured
 * around them. The database baseline is taken *after* the collection has
 * committed, so the collection's own writes are not mistaken for a read-side
 * write, and the comparison runs after every HTTP read of this source.
 */
async function readSource(name, { collector, store, port, dbFile, tracker, now, service, observer, instrument = {} }) {
  const checks = [];
  const label = name === "token" ? "quota" : "credit";
  const target = name === "token" ? store.quotas : store.creditBalances;
  const failures = [];
  const originalFailure = target.failed.bind(target);
  target.failed = (id, epoch, generation, code) => { failures.push(code); return originalFailure(id, epoch, generation, code); };

  await collector.collect();
  const read = name === "token" ? service.readQuotaResources({}) : service.readCreditBalances(undefined);
  const connections = Array.isArray(read?.connections) ? read.connections : [];
  const connection = connections[0] ?? null;
  const observed = connection?.status === "observed";

  checks.push(check(`${label}_collection_reported`, observed || failures.length > 0, {
    connectionState: connection?.status ?? "none",
    failureCode: failures[0] ?? null,
  }));
  checks.push(check(`${label}_snapshot_persisted`, observed, { connectionState: connection?.status ?? "none" }));

  if (name === "token") {
    const observations = Array.isArray(read?.observations) ? read.observations : [];
    const kinds = [...new Set(observations.map(item => item.valueKind))];
    checks.push(check("token_rows_attributed", observations.length > 0 && observations.every(item => Array.isArray(item.connectionIds) && item.connectionIds.includes(connection?.connectionId)), { observations: observations.length, truncated: read?.truncated === true }));
    checks.push(check("token_units_kept", observations.length > 0 && observations.every(item => item.unit === "tokens" && ["estimated", "unavailable"].includes(item.valueKind)), { valueKinds: kinds }));
    checks.push(check("token_null_is_not_zero", observations.length > 0 && observations.every(item => item.valueKind === "unavailable"
      ? item.remaining === null && item.budget === null && item.used === null
      : item.remaining !== null || item.budget !== null), { valueKinds: kinds }));
    checks.push(check("token_availability_distinct", observations.length > 0 && observations.every(item => ["available", "exhausted", "unknown"].includes(item.availability)), { states: [...new Set(observations.map(item => item.availability))] }));
    checks.push(check("token_times_ordered", observations.length > 0 && observations.every(item => isIso(item.sourceObservedAt) && isIso(item.collectedAt) && Date.parse(item.sourceObservedAt) <= Date.parse(item.collectedAt) && Date.parse(item.collectedAt) <= now() + 300000), {}));
    checks.push(check("token_routing_unverified", observations.length > 0 && observations.every(item => Array.isArray(item.limitations) && item.limitations.includes("routing_unverified")), { attribution: read?.attribution ?? null }));
    checks.push(check("token_task_usage_absent", read?.actualTaskTokens === null && read?.actualTaskCredits === null, {}));
  } else {
    const balances = Array.isArray(read?.balances) ? read.balances : [];
    checks.push(check("credit_unit_is_not_currency", balances.length > 0 && balances.every(item => item.unit === "credit" && item.valueKind === "reported_cache"), { balances: balances.length }));
    checks.push(check("credit_coverage_matches_counts", balances.length > 0 && balances.every(item => {
      const expected = item.accountsWithData === 0 ? "unavailable" : item.accountsWithData === item.accountsEnabled ? "complete" : "partial";
      return item.coverage === expected;
    }), { coverage: [...new Set(balances.map(item => item.coverage))] }));
    checks.push(check("credit_null_balance_not_zero", balances.length > 0 && balances.every(item => (item.accountsWithData === 0) === (item.balance === null)), { nullBalances: balances.filter(item => item.balance === null).length }));
    checks.push(check("credit_member_freshness_separate", balances.length > 0 && balances.every(item => item.balanceFreshness !== "fresh"), { balanceFreshness: [...new Set(balances.map(item => item.balanceFreshness))] }));
    checks.push(check("credit_times_ordered", balances.length > 0 && balances.every(item => isIso(item.cacheExpiresAt) && isIso(item.collectedAt) && Date.parse(item.cacheExpiresAt) > Date.parse(item.collectedAt) && (item.latestMemberObservedAt === null || Date.parse(item.latestMemberObservedAt) <= Date.parse(item.collectedAt))), {}));
  }

  // --- HTTP reads: they must serve the saved snapshot without collecting or writing.
  const baseline = observer.sample();
  const upstreamBefore = tracker.calls.length;
  const quotaHttp = name === "token" ? await request(port, "/workbench/v1/resources/quotas") : null;
  const creditHttp = name === "credit" ? await request(port, "/workbench/v1/resources/credit-balances") : null;
  const routingHttp = await request(port, "/workbench/v1/resources/routing");
  const upstreamAfter = tracker.calls.length;
  await instrument.duringHttpGet?.({ dbFile, source: name, store });
  const after = observer.sample();
  const served = quotaHttp ?? creditHttp;
  checks.push(check(`${label}_http_serves_snapshot`, observed && served?.status === 200 && served.contentType.includes("application/json"), { status: served?.status ?? 0 }));
  checks.push(check(`${label}_http_matches_store`, observed && JSON.stringify(served?.body?.connections?.[0]?.snapshotId ?? null) === JSON.stringify(connection?.snapshotId ?? null), {}));
  checks.push(check("get_does_not_collect", upstreamAfter === upstreamBefore, { upstreamReadsDuringGet: upstreamAfter - upstreamBefore }));
  checks.push(check("routing_links_this_connection", routingHttp.status === 200 && Array.isArray(routingHttp.body?.connections) && routingHttp.body.connections.some(item => item.connectionId === connection?.connectionId), {
    connections: Array.isArray(routingHttp.body?.connections) ? routingHttp.body.connections.length : 0,
  }));
  checks.push(check("routing_never_claims_verification", routingHttp.body?.routingVerified === false, {}));
  checks.push(check("routing_primary_is_traceable", Array.isArray(routingHttp.body?.mappings) && routingHttp.body.mappings.every(mapping => typeof mapping.primaryConnectionId === "string" && Array.isArray(mapping.sources) && mapping.sources.length > 0), {}));
  checks.push(check("database_unchanged_by_reads", baseline.digest === after.digest && baseline.version === after.version, {
    dataVersionStable: baseline.version === after.version,
    contentStable: baseline.digest === after.digest,
    tables: after.tables,
    observer: observer.mode,
  }));
  checks.push(check("unknown_states_are_not_upgraded", Array.isArray(routingHttp.body?.mappings) && routingHttp.body.mappings.every(mapping => mapping.level !== "observed" || mapping.evidenceReason === "snapshot_fresh" || mapping.evidenceReason === "cache_fresh"), {}));
  return checks;
}

const USAGE = `Usage: node scripts/resource-source-acceptance.mjs [--check | --execute] [options]

  --check              only inspect the environment; never reads an upstream and never claims a pass
  --execute            perform a bounded read-only acceptance (needs complete conditions)
  --source <name>      token | credit | both (default: both)
  --timeout-ms <n>     per-request upstream timeout for --execute (default: 5000)
  --state-dir <path>   parent directory for this run's own state; a unique
                       resource-source-acceptance-* subdirectory is created inside it and
                       only that subdirectory is removed (never the parent or its files)
  --keep               keep this run's own state directory; its path is reported as stateDir

Exit codes: 0 complete pass, 1 a check failed, 2 conditions missing or a source was not executed.
Credentials are read from the process environment only; they are never printed or written.`;

function parseArgs(argv) {
  const options = { mode: "check", source: "both", timeoutMs: 5000, keep: false, stateDir: undefined, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--check") options.mode = "check";
    else if (arg === "--execute") options.mode = "execute";
    else if (arg === "--source") options.source = argv[++index] ?? "both";
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index] ?? "5000");
    else if (arg === "--state-dir") options.stateDir = argv[++index];
    else if (arg === "--keep") options.keep = true;
  }
  return options;
}

/** A source only counts as ready when every requested source is ready. */
function requestedReady(report, source) {
  const names = source === "both" ? ["token", "credit"] : [source];
  return names.every(name => report.sources?.[name]?.ready === true);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!["token", "credit", "both"].includes(options.source)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const report = options.mode === "execute"
    ? await runAcceptance({ source: options.source, env, timeoutMs: options.timeoutMs, stateDir: options.stateDir, keep: options.keep })
    : checkConditions(env);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return options.mode === "execute" ? report.exitCode : (requestedReady(report, options.source) ? 0 : 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; });
}
