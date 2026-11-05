import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { checkConditions, main, runAcceptance } from "../scripts/resource-source-acceptance.mjs";

const KEY = "synthetic-acceptance-key-0123456789";

/**
 * A loopback stand-in for the WorkBuddy2API statistics endpoints. It is the only
 * upstream used here: no WorkBuddy application, hub process or model is invoked.
 */
async function fixtureHub(t: { after(fn: () => void): void }, behaviour: "ok" | "unauthorized" | "hang" | "invalid" | "empty" = "ok") {
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    if (behaviour === "unauthorized" || request.headers.authorization !== `Bearer ${KEY}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (behaviour === "hang") return;
    if (behaviour === "invalid") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not-json");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (request.url === "/usage/remaining") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        generated_at: now,
        rows: behaviour === "empty" ? [] : [
          { uid: "synthetic-account-a", nickname: "a", realm: "cn", model: "synthetic-model", used: 20, budget: 100, remaining: 80, cooling: false },
          { uid: "synthetic-account-b", nickname: "b", realm: "cn", model: "synthetic-model-unknown", used: null, budget: null, remaining: null, cooling: false },
        ],
      }));
      return;
    }
    if (request.url === "/v1/balance-summary") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(behaviour === "empty"
        ? { unit: "credit", realm: "cn", balance: null, accounts_enabled: 2, accounts_with_credit_data: 0, updated_at: now - 60 }
        : { unit: "credit", realm: "cn", balance: 12.5, accounts_enabled: 3, accounts_with_credit_data: 2, updated_at: now - 60 }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "no route" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as { port: number };
  const origin = `http://127.0.0.1:${port}/`;
  const env = {
    WORKBUDDY_QUOTA_SOURCE_URL: origin,
    WORKBUDDY_QUOTA_API_KEY: KEY,
    WORKBUDDY_QUOTA_PANEL_TOKEN: "synthetic-panel-session-token",
    WORKBUDDY_CREDIT_SOURCE_URL: origin,
    WORKBUDDY_CREDIT_API_KEY: KEY,
  };
  return { origin, port, env, seen };
}

const byId = (report: { checks: { id: string; ok: boolean }[] }, id: string) => report.checks.find(entry => entry.id === id);

test("conditions are reported without a request and a missing credential is never a pass", () => {
  const empty = checkConditions({}) as Record<string, any>;
  assert.equal(empty.mode, "check");
  assert.equal(empty.executed, false);
  assert.equal(empty.accepted, false);
  assert.equal(empty.ready, false);
  assert.deepEqual(empty.sources.token.missing, ["url", "apiKey", "panelToken"]);
  assert.deepEqual(empty.sources.credit.missing, ["url", "apiKey"]);
  assert.ok(empty.actions.length >= 2);
  // A password is not a session token, and a non-loopback origin cannot be read.
  const wrong = checkConditions({ WORKBUDDY_QUOTA_SOURCE_URL: "http://example.com/", WORKBUDDY_QUOTA_API_KEY: "k", WORKBUDDY_QUOTA_PANEL_TOKEN: "t", WORKBUDDY_CREDIT_SOURCE_URL: "http://127.0.0.1:8788/usage", WORKBUDDY_CREDIT_API_KEY: "k" }) as Record<string, any>;
  assert.equal(wrong.sources.token.ready, false);
  assert.deepEqual(wrong.sources.token.fields.url, { state: "invalid", reason: "not_loopback" });
  assert.deepEqual(wrong.sources.credit.fields.url, { state: "invalid", reason: "url_has_path_or_query" });
  assert.equal(wrong.ready, false);
});

test("a source without conditions is not executed and cannot be reported as passing", async () => {
  const report = await runAcceptance({ source: "both", env: {} }) as Record<string, any>;
  assert.equal(report.executed, false);
  assert.equal(report.exitCode, 2);
  assert.equal(report.accepted, false);
  assert.deepEqual(report.notExecuted, ["token", "credit"]);
  assert.deepEqual(report.checks, []);
});

test("one configured source runs while the unconfigured one stays explicitly not executed", async t => {
  const hub = await fixtureHub(t);
  const env = { ...hub.env };
  delete (env as Record<string, string>).WORKBUDDY_QUOTA_PANEL_TOKEN;
  const report = await runAcceptance({ source: "both", env, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-test-")) }) as Record<string, any>;
  assert.equal(report.executed, true);
  assert.deepEqual(report.sources, ["credit"]);
  assert.deepEqual(report.notExecuted, ["token"]);
  assert.equal(report.exitCode, 2, "a one-sided run must not exit like a complete pass");
  assert.equal(report.accepted, false);
  assert.ok(report.checks.every((entry: { ok: boolean }) => entry.ok));
});

test("a real read proves collection, persistence, HTTP service and isolation together", async t => {
  const hub = await fixtureHub(t);
  const report = await runAcceptance({ source: "both", env: hub.env }) as Record<string, any>;
  assert.equal(report.exitCode, 0, JSON.stringify(report.checks.filter((entry: { ok: boolean }) => !entry.ok)));
  assert.equal(report.accepted, true);
  assert.equal(byId(report, "quota_snapshot_persisted")?.ok, true);
  assert.equal(byId(report, "credit_snapshot_persisted")?.ok, true);
  assert.equal(byId(report, "quota_http_serves_snapshot")?.ok, true);
  assert.equal(byId(report, "quota_http_matches_store")?.ok, true);
  assert.equal(byId(report, "get_does_not_collect")?.ok, true);
  assert.equal(byId(report, "database_unchanged_by_reads")?.ok, true);
  const dbCheck = byId(report, "database_unchanged_by_reads") as Record<string, any>;
  assert.equal(dbCheck.dataVersionStable, true, "the read window saw no other commit");
  assert.equal(dbCheck.contentStable, true, "the collection's own writes were committed before the baseline");
  assert.equal(byId(report, "routing_links_this_connection")?.ok, true);
  assert.equal(byId(report, "routing_never_claims_verification")?.ok, true);
  assert.equal(byId(report, "services_closed")?.ok, true);
  // Both upstream paths were read exactly once, and never with another method.
  const paths = (byId(report, "no_model_requests") as Record<string, any>).paths.sort();
  assert.deepEqual(paths, ["/usage/remaining", "/v1/balance-summary"]);
  assert.ok(hub.seen.every(entry => entry.startsWith("GET ")));
  assert.equal(hub.seen.length, 2, "one read per source and no retry storm");
});

test("the report carries no credential, header or upstream body", async t => {
  const hub = await fixtureHub(t);
  const report = await runAcceptance({ source: "both", env: hub.env }) as Record<string, any>;
  const text = JSON.stringify(report);
  assert.equal(text.includes(KEY), false);
  assert.equal(text.includes("synthetic-panel-session-token"), false);
  assert.equal(text.includes("Bearer"), false);
  assert.equal(text.includes("synthetic-account-a"), false, "account identities stay out of the report");
  assert.equal(text.includes("12.5"), false, "a real balance value never reaches the report");
});

test("an unauthorized read is reported as its own failure code", async t => {
  const hub = await fixtureHub(t, "unauthorized");
  const report = await runAcceptance({ source: "credit", env: hub.env }) as Record<string, any>;
  assert.equal(report.exitCode, 1);
  assert.equal(report.accepted, false);
  const reported = byId(report, "credit_collection_reported") as Record<string, any>;
  assert.equal(reported.ok, true, "a refused read is recorded, not hidden");
  assert.equal(reported.failureCode, "source_unauthorized");
  assert.equal(byId(report, "credit_snapshot_persisted")?.ok, false);
  assert.equal(byId(report, "credit_http_serves_snapshot")?.ok, false);
});

test("a hanging source is bounded by the requested timeout", async t => {
  const hub = await fixtureHub(t, "hang");
  const started = Date.now();
  const report = await runAcceptance({ source: "credit", env: hub.env, timeoutMs: 300 }) as Record<string, any>;
  assert.equal(report.exitCode, 1);
  assert.equal((byId(report, "credit_collection_reported") as Record<string, any>).failureCode, "source_timeout");
  assert.ok(Date.now() - started < 15000, "the acceptance must not wait for the hung request");
});

test("an invalid payload is refused instead of becoming an empty snapshot", async t => {
  const hub = await fixtureHub(t, "invalid");
  const report = await runAcceptance({ source: "credit", env: hub.env }) as Record<string, any>;
  assert.equal(report.exitCode, 1);
  assert.equal((byId(report, "credit_collection_reported") as Record<string, any>).failureCode, "source_invalid");
  assert.equal(byId(report, "credit_snapshot_persisted")?.ok, false);
});

test("an empty upstream is not reported as a passing data read", async t => {
  const hub = await fixtureHub(t, "empty");
  const report = await runAcceptance({ source: "token", env: hub.env }) as Record<string, any>;
  assert.equal(byId(report, "quota_snapshot_persisted")?.ok, true, "the connection did publish a snapshot");
  assert.equal(byId(report, "token_rows_attributed")?.ok, false, "no rows means nothing was attributed");
  assert.equal(byId(report, "token_units_kept")?.ok, false);
  assert.equal(report.accepted, false);
  assert.equal(report.exitCode, 1);
});

test("the acceptance closes its own service and removes its isolated state", async t => {
  const hub = await fixtureHub(t);
  const report = await runAcceptance({ source: "credit", env: hub.env }) as Record<string, any>;
  assert.equal(report.exitCode, 0);
  assert.equal(report.stateDir, null, "an unkept state directory is removed");
  const listening = byId(report, "isolated_service_listening") as Record<string, any>;
  await assert.rejects(() => fetch(`http://127.0.0.1:${listening.port}/workbench/v1/health`, { signal: AbortSignal.timeout(2000) }), /fetch failed|ECONNREFUSED|connect/i);
});

const sha256 = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A caller-owned directory with its own files, mirroring an operator's tree. */
function callerDirectory(t: { after(fn: () => void): void }) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-parent-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const sentinel = path.join(parent, "sentinel.txt");
  fs.writeFileSync(sentinel, "a caller file this run must not touch");
  const database = path.join(parent, "resources.sqlite");
  fs.writeFileSync(database, "not a database this run may open, migrate or delete");
  return { parent, sentinel, database };
}

test("a caller-provided state directory keeps its own files and only the run's subdirectory is removed", async t => {
  const hub = await fixtureHub(t);
  const { parent, sentinel, database } = callerDirectory(t);
  const beforeBytes = fs.readFileSync(database);
  const report = await runAcceptance({ source: "credit", env: hub.env, stateDir: parent }) as Record<string, any>;
  assert.equal(report.exitCode, 0);
  assert.equal(report.accepted, true, "the read itself must still succeed");
  assert.equal(fs.existsSync(sentinel), true, "a caller file survives the acceptance");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "a caller file this run must not touch");
  assert.deepEqual(fs.readFileSync(database), beforeBytes, "the caller's own database is never opened or rewritten");
  assert.deepEqual(fs.readdirSync(parent).sort(), ["resources.sqlite", "sentinel.txt"], "only the caller's files remain");
  assert.equal(report.stateDir, null, "an unkept run reports no retained directory");
  assert.equal(fs.existsSync(report.stateRoot), false, "the run's own directory is gone");
});

test("--keep retains exactly the run's own directory, not the caller's parent", async t => {
  const hub = await fixtureHub(t);
  const { parent, sentinel } = callerDirectory(t);
  const report = await runAcceptance({ source: "credit", env: hub.env, stateDir: parent, keep: true }) as Record<string, any>;
  t.after(() => { if (report.stateDir) fs.rmSync(report.stateDir, { recursive: true, force: true }); });
  assert.equal(report.exitCode, 0);
  assert.equal(report.stateDir, report.stateRoot);
  assert.equal(path.dirname(report.stateDir), path.resolve(parent), "the retained directory sits inside the caller's parent");
  assert.equal(path.basename(report.stateDir).startsWith("resource-source-acceptance-"), true);
  assert.equal(fs.existsSync(path.join(report.stateDir, "resources.sqlite")), true);
  assert.equal(fs.existsSync(sentinel), true);
});

test("a failing run still leaves the caller's files intact", async t => {
  const hub = await fixtureHub(t, "unauthorized");
  const { parent, sentinel, database } = callerDirectory(t);
  const beforeBytes = fs.readFileSync(database);
  const report = await runAcceptance({ source: "credit", env: hub.env, stateDir: parent }) as Record<string, any>;
  assert.equal(report.exitCode, 1, "a refused read is a failure");
  assert.equal(fs.existsSync(sentinel), true);
  assert.deepEqual(fs.readFileSync(database), beforeBytes);
  assert.deepEqual(fs.readdirSync(parent).sort(), ["resources.sqlite", "sentinel.txt"]);
});

test("a committed write during the read window fails the check even when it stays in the WAL", async t => {
  const hub = await fixtureHub(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-parent-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let mainBefore = "";
  let mainAfter = "";
  const report = await runAcceptance({
    source: "credit",
    env: hub.env,
    stateDir: parent,
    instrument: {
      duringHttpGet: ({ dbFile }: { dbFile: string }) => {
        mainBefore = sha256(dbFile);
        const writer = new DatabaseSync(dbFile);
        writer.exec("CREATE TABLE IF NOT EXISTS acceptance_probe (x INTEGER)");
        writer.exec("INSERT INTO acceptance_probe (x) VALUES (1)");
        writer.close();
        mainAfter = sha256(dbFile);
      },
    },
  }) as Record<string, any>;
  assert.ok(mainBefore.length > 0, "the instrumented write ran inside the read window");
  assert.equal(mainBefore, mainAfter, "the committed write stayed in the write-ahead log");
  const result = byId(report, "database_unchanged_by_reads") as Record<string, any>;
  assert.equal(result.ok, false, "a WAL-only write is still a write");
  assert.equal(result.contentStable, false);
  assert.equal(report.accepted, false);
  assert.equal(report.exitCode, 1);
});

test("a write from the store's own connection during the window is detected as well", async t => {
  const hub = await fixtureHub(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-parent-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const report = await runAcceptance({
    source: "credit",
    env: hub.env,
    stateDir: parent,
    instrument: {
      duringHttpGet: ({ store }: { store: any }) => {
        store.quotas.register("acceptance-probe", "acceptance-probe-fingerprint");
      },
    },
  }) as Record<string, any>;
  const result = byId(report, "database_unchanged_by_reads") as Record<string, any>;
  assert.equal(result.ok, false);
  assert.equal(report.accepted, false);
  assert.equal(report.exitCode, 1);
});

test("a throwing server.close is recorded as a failure, not a pass", async t => {
  const hub = await fixtureHub(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-parent-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let realClose: (() => Promise<void>) | undefined;
  let keptRoot = "";
  const report = await runAcceptance({
    source: "credit",
    env: hub.env,
    stateDir: parent,
    instrument: {
      afterListening: ({ server, port }: { server: any; port: number }) => {
        realClose = server.close.bind(server);
        server.close = async () => { throw Object.assign(new Error("close refused"), { code: "close_refused" }); };
        keptRoot = String(port);
      },
    },
  }) as Record<string, any>;
  t.after(() => { if (realClose) return realClose(); });
  assert.ok(keptRoot.length > 0);
  const closed = byId(report, "services_closed") as Record<string, any>;
  assert.equal(closed.ok, false);
  assert.equal(closed.portClosed, false, "the port was still bound when the run reported");
  const entry = closed.resources.find((item: { resource: string }) => item.resource === "server") as Record<string, any>;
  assert.equal(entry.closed, false);
  assert.equal(entry.code, "close_refused");
  assert.equal(report.accepted, false);
  assert.equal(report.exitCode, 1);
  assert.equal(fs.existsSync(report.stateRoot), true, "state is kept while a live service still uses it");
  fs.rmSync(report.stateRoot, { recursive: true, force: true });
});

test("a throwing store.close cannot be reported as a closed store", async t => {
  const hub = await fixtureHub(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-parent-"));
  let release: (() => void) | undefined;
  const report = await runAcceptance({
    source: "credit",
    env: hub.env,
    stateDir: parent,
    instrument: {
      afterListening: ({ store }: { store: any }) => {
        // Throws once, then restores itself so the test can release the real
        // handle; an unclosed handle would keep the file locked on Windows.
        const real = store.close.bind(store);
        release = () => { try { real(); } catch { /* already closed */ } };
        store.close = () => { store.close = real; throw Object.assign(new Error("store busy"), { code: "store_busy" }); };
      },
    },
  }) as Record<string, any>;
  t.after(() => {
    release?.();
    if (report.stateRoot) fs.rmSync(report.stateRoot, { recursive: true, force: true });
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const closed = byId(report, "services_closed") as Record<string, any>;
  assert.equal(closed.ok, false);
  const entry = closed.resources.find((item: { resource: string }) => item.resource === "store") as Record<string, any>;
  assert.equal(entry.closed, false);
  assert.equal(entry.code, "store_busy");
  assert.equal(report.accepted, false);
});

test("a failing collector stop still closes the others and records each result", async t => {
  const hub = await fixtureHub(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-parent-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  let secondStopped = false;
  const report = await runAcceptance({
    source: "both",
    env: hub.env,
    stateDir: parent,
    instrument: {
      afterCollectors: ({ collectors }: { collectors: any[] }) => {
        if (collectors.length !== 2) return;
        collectors[0].stop = async () => { throw Object.assign(new Error("stop failed"), { code: "stop_failed" }); };
        const original = collectors[1].stop.bind(collectors[1]);
        collectors[1].stop = async () => { secondStopped = true; return original(); };
      },
    },
  }) as Record<string, any>;
  t.after(() => { if (report.stateRoot) fs.rmSync(report.stateRoot, { recursive: true, force: true }); });
  const closed = byId(report, "services_closed") as Record<string, any>;
  assert.equal(closed.ok, false);
  const first = closed.resources.find((item: { resource: string }) => item.resource === "collector_0") as Record<string, any>;
  assert.equal(first.closed, false);
  assert.equal(first.code, "stop_failed");
  assert.equal(secondStopped, true, "the other collector is still closed");
  assert.equal(report.accepted, false);
});

test("a failure after partial initialisation closes only what this run created", async t => {
  const hub = await fixtureHub(t);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "acceptance-parent-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const report = await runAcceptance({
    source: "both",
    env: hub.env,
    stateDir: parent,
    instrument: {
      afterListening: () => { throw Object.assign(new Error("instrumented init failure"), { code: "init_failed" }); },
    },
  }) as Record<string, any>;
  assert.equal(report.executed, true);
  assert.equal((byId(report, "acceptance_completed") as Record<string, any>).ok, false);
  assert.equal((byId(report, "acceptance_completed") as Record<string, any>).code, "init_failed");
  const closed = byId(report, "services_closed") as Record<string, any>;
  assert.equal(closed.ok, true, "the server and store that did exist are closed");
  assert.equal(closed.resources.some((item: { resource: string }) => item.resource.startsWith("collector_")), false, "no collector was created");
  assert.equal(report.accepted, false);
  assert.equal(report.exitCode, 1);
  assert.equal(fs.existsSync(report.stateRoot), false, "a clean shutdown still removes the run's own directory");
});

test("the command line reports an incomplete environment as a distinct exit code", async t => {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await main(["--help"], {}), 0);
    assert.match(writes.join(""), /--execute/);
    assert.equal(await main(["--check"], {}), 2, "missing conditions never exit like a pass");
    assert.equal(await main(["--source", "nope"], {}), 2);
  } finally {
    process.stdout.write = original;
  }
  // A partially ready environment is still not a complete pass for --check.
  const hub = await fixtureHub(t);
  const env = { ...hub.env };
  delete (env as Record<string, string>).WORKBUDDY_QUOTA_PANEL_TOKEN;
  assert.equal(await main(["--check", "--source", "token"], env), 2);
  assert.equal(await main(["--check", "--source", "credit"], env), 0);
});
