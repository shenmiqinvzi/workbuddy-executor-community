import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RESOURCE_CONNECTIONS_ENV,
  RESOURCE_CONNECTIONS_SCHEMA,
  diagnoseResourceConnections,
  parseResourceConnections,
  readResourceConnections,
} from "../src/resource-connections.js";

// The declaration file answers only one question: what was this deployment
// pointed at? It never answers "which pool served this task". These tests keep
// that boundary: credentials stay environment variable names, an ambiguous
// declaration is reported instead of resolved, and a declared pool that no
// snapshot mentions is a difference, not a merge.

const POOL_CN = `pool-${"1".repeat(32)}`;
const POOL_INTL = `pool-${"2".repeat(32)}`;

function workspace(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resource-connections-"));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  return {
    dir,
    file: path.join(dir, "connections.json"),
    write(text: string) { fs.writeFileSync(this.file, text, "utf8"); return this.file; },
    writeJson(value: unknown) { return this.write(JSON.stringify(value, null, 2)); },
  };
}

const credentialEnv = () => ({ WORKBUDDY_QUOTA_API_KEY: "synthetic-quota-key", WORKBUDDY_QUOTA_PANEL_TOKEN: "synthetic-panel-token", WORKBUDDY_CREDIT_API_KEY: "synthetic-credit-key" }) as NodeJS.ProcessEnv;

function quotaConnection(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "synthetic-quota",
    resource: "quota",
    sourceUrl: "http://127.0.0.1:8788/",
    realm: "cn",
    pools: [POOL_CN],
    models: ["synthetic-model-alpha"],
    shared: true,
    declaredAt: "2026-11-04T00:00:00.000Z",
    credentialEnv: { apiKey: "WORKBUDDY_QUOTA_API_KEY", panelToken: "WORKBUDDY_QUOTA_PANEL_TOKEN" },
    ...overrides,
  };
}

function creditConnection(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "synthetic-credit",
    resource: "credit",
    sourceUrl: "http://127.0.0.1:8788/",
    realm: "cn",
    pools: [POOL_INTL],
    shared: true,
    declaredAt: "2026-11-04T00:00:00.000Z",
    credentialEnv: { apiKey: "WORKBUDDY_CREDIT_API_KEY" },
    ...overrides,
  };
}

function document(connections: unknown[]) {
  return { schemaVersion: RESOURCE_CONNECTIONS_SCHEMA, connections };
}

const views = () => ({
  quota: { connections: [], observations: [] },
  credit: { connections: [], balances: [] },
});

test("an unset declaration reports not_declared and exposes no credential value", () => {
  const registry = readResourceConnections({} as NodeJS.ProcessEnv);

  assert.equal(registry.schemaVersion, RESOURCE_CONNECTIONS_SCHEMA);
  assert.equal(registry.readOnly, true);
  assert.equal(registry.source, "unset");
  assert.equal(registry.declaredVia, RESOURCE_CONNECTIONS_ENV);
  assert.equal(registry.status, "not_declared");
  assert.deepEqual(registry.connections, []);
  assert.deepEqual(registry.conflicts, []);
  assert.deepEqual(registry.restrictions, {
    loopbackOriginOnly: true,
    fixedReadPathsOnly: true,
    arbitraryUrlProxy: false,
    browserManagerKey: false,
    credentialValuesExposed: false,
    credentialSource: "environment_reference_only",
  });
  assert.ok(registry.limitations.includes("declaration_does_not_verify_routing"));
});

test("a valid declaration names its sources by origin and its keys by variable", (t) => {
  const env = credentialEnv();
  const registry = readResourceConnections({
    ...env,
    [RESOURCE_CONNECTIONS_ENV]: workspace(t).writeJson(document([quotaConnection({ note: "operator note that must not be echoed" }), creditConnection()])),
  } as NodeJS.ProcessEnv);

  assert.equal(registry.status, "declared");
  assert.equal(registry.source, "file");
  assert.equal(registry.fileDiagnostics.length, 0);
  assert.equal(registry.connections.length, 2);

  const quota = registry.connections[0]!;
  assert.equal(quota.status, "declared");
  assert.equal(quota.sourceUrl, "http://127.0.0.1:8788");
  assert.deepEqual(quota.pools, [POOL_CN]);
  assert.deepEqual(quota.models, ["synthetic-model-alpha"]);
  assert.equal(quota.realm, "cn");
  assert.equal(quota.shared, true);
  assert.equal(quota.declaredAt, "2026-11-04T00:00:00.000Z");
  assert.deepEqual(quota.credentials, [
    { purpose: "api_key", envVar: "WORKBUDDY_QUOTA_API_KEY", present: true },
    { purpose: "panel_token", envVar: "WORKBUDDY_QUOTA_PANEL_TOKEN", present: true },
  ]);
  assert.equal(quota.hasNote, true);
  // The note text itself stays out of the evidence document.
  assert.equal(JSON.stringify(registry).includes("operator note"), false);
  assert.equal(JSON.stringify(registry).includes("synthetic-quota-key"), false);
});

test("a credential value in the declaration file invalidates the whole file", (t) => {
  const secret = "synthetic-credential-value-must-not-be-echoed";
  const registry = readResourceConnections({
    [RESOURCE_CONNECTIONS_ENV]: workspace(t).writeJson(document([quotaConnection({ apiKey: secret })])),
  } as NodeJS.ProcessEnv);

  assert.equal(registry.status, "invalid_file");
  assert.ok(registry.fileDiagnostics.some(item => item.code === "inline_credential_rejected"));
  assert.equal(JSON.stringify(registry).includes(secret), false);
});

test("only an explicit loopback http origin is accepted as a source", (t) => {
  const cases: [string, string][] = [
    ["https://example.com/", "https:"],
    ["http://localhost:8788/", "localhost"],
    ["http://127.0.0.1:8788/api", "/api path"],
    ["http://user:pass@127.0.0.1:8788/", "credentials"],
    ["http://127.0.0.1:8788/?token=1", "query"],
  ];
  for (const [sourceUrl, label] of cases) {
    const registry = readResourceConnections({
      [RESOURCE_CONNECTIONS_ENV]: workspace(t).writeJson(document([quotaConnection({ sourceUrl })])),
    } as NodeJS.ProcessEnv);
    const connection = registry.connections[0]!;
    assert.equal(connection.status, "invalid", label);
    assert.equal(connection.sourceUrl, null, label);
    assert.ok(connection.diagnostics.some(item => item.code === "source_url_invalid"), label);
  }
});

test("two connections claiming one pool are ambiguous until the realm differs", (t) => {
  const sameRealm = readResourceConnections({
    [RESOURCE_CONNECTIONS_ENV]: workspace(t).writeJson(document([
      quotaConnection({ connectionId: "synthetic-quota-a" }),
      quotaConnection({ connectionId: "synthetic-quota-b" }),
    ])),
  } as NodeJS.ProcessEnv);
  assert.deepEqual(sameRealm.conflicts.map(item => item.code), ["duplicate_pool_declaration"]);
  assert.equal(sameRealm.conflicts[0]!.scopeId, POOL_CN);
  assert.deepEqual(sameRealm.conflicts[0]!.connectionIds.sort(), ["synthetic-quota-a", "synthetic-quota-b"]);
  for (const connection of sameRealm.connections) {
    assert.equal(connection.status, "ambiguous");
    assert.ok(connection.diagnostics.some(item => item.code === "duplicate_pool_declaration"));
  }

  const splitRealm = readResourceConnections({
    [RESOURCE_CONNECTIONS_ENV]: workspace(t).writeJson(document([
      quotaConnection({ connectionId: "synthetic-quota-a", realm: "cn" }),
      quotaConnection({ connectionId: "synthetic-quota-b", realm: "intl" }),
    ])),
  } as NodeJS.ProcessEnv);
  assert.deepEqual(splitRealm.conflicts.map(item => item.code), ["realm_conflict"]);

  const splitShared = readResourceConnections({
    [RESOURCE_CONNECTIONS_ENV]: workspace(t).writeJson(document([
      quotaConnection({ connectionId: "synthetic-quota-a", shared: true }),
      quotaConnection({ connectionId: "synthetic-quota-b", shared: false }),
    ])),
  } as NodeJS.ProcessEnv);
  assert.deepEqual(splitShared.conflicts.map(item => item.code), ["shared_flag_conflict"]);
});

test("a repeated connection identifier is a conflict, not a last-one-wins update", (t) => {
  const registry = readResourceConnections({
    [RESOURCE_CONNECTIONS_ENV]: workspace(t).writeJson(document([
      quotaConnection({ pools: [POOL_CN] }),
      quotaConnection({ pools: [POOL_INTL] }),
    ])),
  } as NodeJS.ProcessEnv);

  assert.equal(registry.conflicts.some(item => item.code === "duplicate_connection"), true);
  assert.equal(registry.connections.length, 2);
  for (const connection of registry.connections) assert.equal(connection.status, "ambiguous");
});

test("a damaged or unsupported declaration file never crashes the read", (t) => {
  const space = workspace(t);
  const missing = readResourceConnections({ [RESOURCE_CONNECTIONS_ENV]: path.join(space.dir, "absent.json") } as NodeJS.ProcessEnv);
  assert.equal(missing.status, "invalid_file");
  assert.equal(missing.fileDiagnostics[0]!.code, "file_not_found");

  const badJson = readResourceConnections({ [RESOURCE_CONNECTIONS_ENV]: space.write("{ not json") } as NodeJS.ProcessEnv);
  assert.equal(badJson.fileDiagnostics[0]!.code, "file_not_json");

  const wrongSchema = readResourceConnections({
    [RESOURCE_CONNECTIONS_ENV]: space.writeJson({ schemaVersion: "workbuddy-executor/resource-connections-2", connections: [] }),
  } as NodeJS.ProcessEnv);
  assert.equal(wrongSchema.fileDiagnostics[0]!.code, "schema_unsupported");

  const unknownField = readResourceConnections({
    [RESOURCE_CONNECTIONS_ENV]: space.writeJson({ schemaVersion: RESOURCE_CONNECTIONS_SCHEMA, connections: [], endpoints: [] }),
  } as NodeJS.ProcessEnv);
  assert.ok(unknownField.fileDiagnostics.some(item => item.code === "unexpected_field"));

  const tooMany = parseResourceConnections(JSON.stringify(document(Array.from({ length: 17 }, (_, index) => quotaConnection({ connectionId: `synthetic-quota-${index}` })))), credentialEnv());
  assert.ok(tooMany.fileDiagnostics.some(item => item.code === "too_many_connections"));
  assert.equal(tooMany.connections.length, 16);
});

test("field-level mistakes stay on their own connection", (t) => {
  const registry = parseResourceConnections(JSON.stringify(document([
    quotaConnection({ connectionId: "synthetic-quota-ok" }),
    creditConnection({ connectionId: "synthetic-credit-models", models: ["synthetic-model-alpha"] }),
    quotaConnection({ connectionId: "synthetic-quota-realm", pools: [`pool-${"3".repeat(32)}`], realm: "moon" }),
    quotaConnection({ connectionId: "synthetic-quota-key", pools: [`pool-${"4".repeat(32)}`], credentialEnv: { apiKey: "wb_lower_case" } }),
    quotaConnection({ connectionId: "synthetic-quota-shared", pools: [`pool-${"5".repeat(32)}`], shared: "yes", declaredAt: "yesterday" }),
  ])), credentialEnv());

  const [, credit, realm, key, shared] = registry.connections;
  assert.ok(credit!.diagnostics.some(item => item.code === "models_not_supported"));
  assert.ok(realm!.diagnostics.some(item => item.code === "realm_invalid"));
  assert.equal(realm!.realm, null);
  assert.ok(key!.diagnostics.some(item => item.code === "credential_reference_invalid"));
  assert.ok(shared!.diagnostics.some(item => item.code === "shared_invalid"));
  assert.ok(shared!.diagnostics.some(item => item.code === "declared_at_invalid"));
  assert.equal(shared!.shared, null);
  assert.equal(shared!.declaredAt, null);
  assert.equal(registry.connections[0]!.status, "declared");
});

test("an empty model list on a credit connection is no restriction, not a mistake", () => {
  const registry = parseResourceConnections(JSON.stringify(document([
    creditConnection({ connectionId: "synthetic-credit-empty", models: [] }),
  ])), credentialEnv());

  const [credit] = registry.connections;
  assert.deepEqual(credit!.models, []);
  assert.equal(credit!.diagnostics.some(item => item.code === "models_not_supported"), false);
  assert.equal(credit!.status, "declared");
});

test("diagnostics compare a declaration with what the collectors stored", () => {
  const registry = parseResourceConnections(JSON.stringify(document([
    quotaConnection({ connectionId: "synthetic-quota" }),
    creditConnection({ connectionId: "synthetic-credit" }),
  ])), credentialEnv());

  const quotaRows = [{ connectionId: "synthetic-quota", status: "observed", errorCode: null, snapshotId: "synthetic-quota-snapshot-0001", collectedAt: null, sourceObservedAt: null, expiresAt: null, freshness: "fresh" }];
  const diagnostics = diagnoseResourceConnections(registry, {
    connections: [...quotaRows, { connectionId: "synthetic-quota-undeclared", status: "not_observed", errorCode: null, snapshotId: null, collectedAt: null, sourceObservedAt: null, expiresAt: null, freshness: "unavailable" }],
    observations: [
      { scopeId: POOL_CN, scopeKind: "gateway_pool", shared: true, modelId: "synthetic-model-alpha", realm: "cn", unit: "tokens", valueKind: "estimated", availability: "available", used: 1, budget: 2, remaining: 1, resetAt: null, method: "historical_budget_minus_observed_usage", limitations: [], connectionId: "synthetic-quota", snapshotId: "synthetic-quota-snapshot-0001", sourceObservedAt: null, collectedAt: null, connectionIds: [] },
    ],
  }, { connections: [], balances: [] });

  const quota = diagnostics.connections.find(item => item.connectionId === "synthetic-quota")!;
  assert.equal(quota.declaration, "declared");
  assert.deepEqual(quota.observation.pools, [POOL_CN]);
  assert.ok(quota.codes.includes("declared_and_observed"));
  assert.equal(quota.codes.includes("declared_not_configured"), false);

  const credit = diagnostics.connections.find(item => item.connectionId === "synthetic-credit")!;
  assert.ok(credit.codes.includes("declared_not_configured"));
  assert.equal(credit.observation.status, null);

  assert.deepEqual(diagnostics.undeclaredObserved.map(item => item.connectionId), ["synthetic-quota-undeclared"]);
  assert.equal(diagnostics.summary.declared, 2);
  assert.equal(diagnostics.summary.observed, 1);
  assert.equal(diagnostics.summary.undeclaredObserved, 1);
  assert.equal(diagnostics.attribution, "connection_only");
  assert.ok(diagnostics.limitations.includes("declaration_does_not_verify_routing"));
});

test("an observation that contradicts the declaration is flagged without rewriting it", () => {
  const registry = parseResourceConnections(JSON.stringify(document([
    quotaConnection({ pools: [POOL_CN], models: ["synthetic-model-alpha"] }),
  ])), {} as NodeJS.ProcessEnv);

  const diagnostics = diagnoseResourceConnections(registry, {
    connections: [{ connectionId: "synthetic-quota", status: "unavailable", errorCode: "source_unauthorized", snapshotId: null, collectedAt: null, sourceObservedAt: null, expiresAt: null, freshness: "unavailable" }],
    observations: [
      { scopeId: POOL_CN, scopeKind: "gateway_pool", shared: true, modelId: "synthetic-model-beta", realm: "intl", unit: "tokens", valueKind: "estimated", availability: "available", used: 1, budget: 2, remaining: 1, resetAt: null, method: "historical_budget_minus_observed_usage", limitations: [], connectionId: "synthetic-quota", snapshotId: null, sourceObservedAt: null, collectedAt: null, connectionIds: [] },
    ],
  }, { connections: [], balances: [] });

  const quota = diagnostics.connections[0]!;
  assert.ok(quota.codes.includes("observed_source_error:source_unauthorized"));
  assert.ok(quota.codes.includes("declared_no_snapshot"));
  // Same pool, different realm: the declaration is not rewritten to match.
  assert.ok(quota.codes.includes("realm_mismatch"));
  assert.equal(quota.codes.includes("observed_pool_outside_declaration"), false);
  assert.ok(quota.codes.includes("declared_model_not_observed"));
  // The missing key is a code, not an assumed presence.
  assert.ok(quota.codes.includes("credential_absent"));
  // The declaration keeps its own realm; the observation keeps its own.
  assert.equal(registry.connections[0]!.realm, "cn");
  assert.equal(quota.observation.pools[0], POOL_CN);
  assert.equal(diagnostics.summary.flagged, 1);
});

test("an ambiguous declaration is reported as ambiguous, never resolved by picking one", (t) => {
  const registry = readResourceConnections({
    [RESOURCE_CONNECTIONS_ENV]: workspace(t).writeJson(document([
      quotaConnection({ connectionId: "synthetic-quota-a" }),
      quotaConnection({ connectionId: "synthetic-quota-b" }),
    ])),
  } as NodeJS.ProcessEnv);

  const diagnostics = diagnoseResourceConnections(registry, views().quota, views().credit);
  assert.deepEqual(diagnostics.connections.map(item => item.declaration), ["ambiguous", "ambiguous"]);
  for (const diagnosis of diagnostics.connections) {
    assert.ok(diagnosis.codes.includes("declaration_ambiguous"));
    assert.ok(diagnosis.codes.includes("declared_not_configured"));
  }
  assert.equal(diagnostics.summary.conflicts, 1);
  assert.equal(diagnostics.summary.usable, 0);
});
