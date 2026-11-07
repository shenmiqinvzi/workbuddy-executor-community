import assert from "node:assert/strict";
import test from "node:test";

import {
  SOURCE_CAPABILITY_SCHEMA,
  RESOURCE_SOURCE_PATHS,
  checkPayloadConformance,
  checkSourceConfiguration,
  listSourceCapabilities,
  sourceCapability,
  sourceFreshness,
  unprovidedFacts,
} from "../src/resource-source-capability.js";

test("every source states its own unit and what it does not publish", () => {
  const capabilities = listSourceCapabilities();
  assert.deepEqual(capabilities.map(item => item.endpoint), ["usage_remaining", "balance_summary", "models"]);
  assert.deepEqual(capabilities.map(item => item.unit), ["tokens", "credit", "none"]);
  for (const capability of capabilities) {
    assert.equal(capability.schemaVersion, SOURCE_CAPABILITY_SCHEMA);
    assert.equal(capability.method, "GET");
    assert.equal(capability.readTime, "collector_clock");
    assert.equal(capability.requestIdField, null, "no source publishes a request id, so routing stays unverified");
    assert.equal(RESOURCE_SOURCE_PATHS[capability.endpoint], capability.path);
    assert.ok(capability.notProvided.length > 0);
  }
  const facts = unprovidedFacts();
  assert.ok(facts.includes("per_request_identity"));
  assert.ok(facts.includes("per_task_usage"));
  assert.ok(facts.includes("price_or_currency_amount"));
});

test("the capability table cannot be mutated by a caller", () => {
  const capability = sourceCapability("usage_remaining");
  assert.throws(() => {
    (capability.notProvided as string[]).push("invented_fact");
  }, TypeError);
  assert.ok(!sourceCapability("usage_remaining").notProvided.includes("invented_fact"));
});

test("an unconfigured or non-loopback source is rejected before any request", () => {
  assert.deepEqual(checkSourceConfiguration({}), { ok: false, code: "source_unconfigured", field: "baseUrl" });
  assert.deepEqual(checkSourceConfiguration({ baseUrl: "http://10.0.0.5:9000" }), { ok: false, code: "invalid_source_url", field: "baseUrl" });
  assert.deepEqual(checkSourceConfiguration({ baseUrl: "http://127.0.0.1:18491/usage/remaining" }), { ok: false, code: "invalid_source_url", field: "baseUrl" });
  assert.deepEqual(checkSourceConfiguration({ baseUrl: "http://127.0.0.1:18491" }), { ok: false, code: "source_credential_missing", field: "apiKey" });
  assert.deepEqual(checkSourceConfiguration({ baseUrl: "http://127.0.0.1:18491", apiKey: "key", panelToken: "panel" }), {
    ok: true, origin: "http://127.0.0.1:18491", authenticated: true, panelToken: true,
  });
});

test("quota payloads keep source time separate and count rejected rows", () => {
  const good = checkPayloadConformance("usage_remaining", {
    generated_at: 1793500000,
    rows: [{ uid: "u1", model: "model-a", realm: "cn", cooling: false, used: 10, budget: 100, remaining: 90, reset_at: null }],
  });
  assert.equal(good.conformance, "complete", "realm is carried per row on this endpoint");
  assert.equal(good.rowsRead, 1);
  assert.deepEqual(good.rowsRejected, 0);

  const mixed = checkPayloadConformance("usage_remaining", {
    generated_at: 1793500000,
    realm: "cn",
    rows: [
      { uid: "u1", model: "model-a", realm: "cn", cooling: false },
      { uid: "u2", model: "model-b", realm: "mars", cooling: false },
      { uid: "u3", realm: "cn", cooling: "no" },
    ],
  });
  assert.equal(mixed.conformance, "partial");
  assert.equal(mixed.rowsRead, 1);
  assert.equal(mixed.rowsRejected, 2);
  assert.deepEqual(mixed.rejectedReasons, ["row_realm_unknown", "row_identity_missing:model"]);
});

test("a payload without a source timestamp is partial, not complete", () => {
  const missingTime = checkPayloadConformance("usage_remaining", {
    realm: "cn",
    rows: [{ uid: "u1", model: "model-a", realm: "cn", cooling: false }],
  });
  assert.equal(missingTime.conformance, "partial");
  assert.deepEqual(missingTime.missingFields, ["generated_at"]);
});

test("a bad payload is invalid and never yields a zero-filled observation", () => {
  assert.equal(checkPayloadConformance("usage_remaining", null).conformance, "invalid");
  assert.equal(checkPayloadConformance("usage_remaining", { generated_at: 1 }).conformance, "invalid");
  const noUsableRows = checkPayloadConformance("usage_remaining", { generated_at: 1, realm: "cn", rows: [{ uid: "u1" }] });
  assert.equal(noUsableRows.conformance, "invalid");
  assert.equal(noUsableRows.rowsRead, 0);
  const tooMany = checkPayloadConformance("usage_remaining", { generated_at: 1, rows: Array.from({ length: 2001 }, () => ({})) });
  assert.equal(tooMany.conformance, "invalid");
  assert.deepEqual(tooMany.rejectedReasons, ["rows_exceed_cap:2000"]);
});

test("credit payloads are credit-only and never money", () => {
  const credit = checkPayloadConformance("balance_summary", {
    unit: "credit", realm: "cn", balance: "12.34", accounts_enabled: 3, accounts_with_data: 2, updated_at: 1793500000,
  });
  assert.equal(credit.conformance, "complete");
  const money = checkPayloadConformance("balance_summary", { unit: "currency", realm: "cn", balance: "12.34" });
  assert.equal(money.conformance, "partial");
  assert.ok(money.rejectedReasons.includes("unit_mismatch:balance_summary_reports_credit"));
  assert.deepEqual(money.missingFields, ["updated_at"]);
});

test("the model list carries identities only; pricing is a stated gap", () => {
  const models = checkPayloadConformance("models", { data: [{ id: "model-a" }, { name: "model-b" }] });
  assert.equal(models.conformance, "partial");
  assert.equal(models.rowsRead, 1);
  assert.equal(models.rowsRejected, 1);
  assert.deepEqual(models.missingFields, []);
  assert.ok(sourceCapability("models").notProvided.includes("model_price"));
});

test("stale data stays usable and labelled; it is not refreshed to fresh and not zeroed", () => {
  const now = new Date("2026-11-07T08:00:00.000Z");
  const fresh = sourceFreshness({ collectedAt: "2026-11-07T07:59:30.000Z", sourceObservedAt: "2026-11-07T07:59:00.000Z", maxAgeMs: 90_000, now });
  assert.deepEqual(fresh, { status: "fresh", ageSeconds: 30, sourceSkewSeconds: -30, reason: "within_max_age" });

  const stale = sourceFreshness({ collectedAt: "2026-11-07T07:00:00.000Z", sourceObservedAt: null, maxAgeMs: 90_000, now });
  assert.deepEqual(stale, { status: "stale", ageSeconds: 3600, sourceSkewSeconds: null, reason: "max_age_exceeded" });

  const never = sourceFreshness({ collectedAt: null, sourceObservedAt: null, maxAgeMs: 90_000, now });
  assert.deepEqual(never, { status: "unavailable", ageSeconds: null, sourceSkewSeconds: null, reason: "not_collected" });

  const noSourceTime = sourceFreshness({ collectedAt: "2026-11-07T07:59:59.000Z", sourceObservedAt: null, maxAgeMs: 90_000, now });
  assert.equal(noSourceTime.status, "fresh");
  assert.equal(noSourceTime.sourceSkewSeconds, null, "an absent source time is unknown, not zero skew");
});
