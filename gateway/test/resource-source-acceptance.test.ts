import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
