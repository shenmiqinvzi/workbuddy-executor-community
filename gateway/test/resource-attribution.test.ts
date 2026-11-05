import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTRIBUTION_LEVELS,
  ATTRIBUTION_UNITS,
  REQUEST_ATTRIBUTION_SCHEMA,
  buildRequestAttribution,
  normalizeAttributionUsage,
} from "../src/resource-attribution.js";

// The upstream payload aggregates by account and model. It carries no request
// identity, so the honest answer to "which model served this task" is a stated
// gap with a work list, not a fabricated field. These tests hold that line.

test("the gap report names what is missing and what would close it", () => {
  const gap = buildRequestAttribution();

  assert.equal(gap.schemaVersion, REQUEST_ATTRIBUTION_SCHEMA);
  assert.equal(gap.readOnly, true);
  assert.equal(gap.capability, "request_level_attribution");
  assert.equal(gap.status, "unavailable");
  assert.equal(gap.reason, "upstream_payload_lacks_request_identity");
  assert.deepEqual(gap.fields, { requestId: null, role: null, unit: null, usageLevel: null });
  assert.deepEqual(gap.optionalLinks, { taskId: null, sessionId: null, providerId: null, modelIdForRequest: null });
  assert.deepEqual(gap.knownAt, { connection: true, pool: true, modelAggregate: true, task: false, session: false, request: false });
  assert.equal(gap.integrationTodo.length, 10);
  assert.equal(gap.doesNotProve.length >= 3, true);
  assert.ok(gap.limitations.includes("request_attribution_unavailable"));
  // Only units that cannot be mixed are allowed anywhere in this document.
  assert.deepEqual([...ATTRIBUTION_UNITS], ["tokens", "credit"]);
  assert.deepEqual([...ATTRIBUTION_LEVELS], ["request", "task", "session", "pool"]);
});

test("the observed payload fields are transcribed, not interpreted", () => {
  const gap = buildRequestAttribution();
  assert.ok(gap.observedPayload.tokenFields.includes("model"));
  assert.ok(gap.observedPayload.tokenFields.includes("used"));
  assert.ok(gap.observedPayload.creditFields.includes("balance"));
  for (const field of [...gap.observedPayload.tokenFields, ...gap.observedPayload.creditFields]) {
    assert.equal(typeof field, "string");
    assert.equal(/key|token/i.test(field), false, `no credential field is transcribed: ${field}`);
  }
  // No payload key may read like a credential name, so the document can be archived.
  const credentialShaped = /^(api_?key|apikey|panel_?token|paneltoken|token|bearer|authorization|cookie|password|secret|private_?key|client_?secret)$/i;
  assert.deepEqual(Object.keys(gap.observedPayload).filter(key => credentialShaped.test(key)), []);
});

test("a record without request identity stays all-null", () => {
  const usage = normalizeAttributionUsage(undefined);
  assert.equal(usage.requestId, null);
  assert.equal(usage.taskId, null);
  assert.equal(usage.sessionId, null);
  assert.equal(usage.role, null);
  assert.equal(usage.unit, null);
  assert.equal(usage.usageLevel, null);
  assert.equal(usage.value, null);
  assert.deepEqual(usage.rejected, []);

  const notObject = normalizeAttributionUsage("request-1");
  assert.deepEqual(notObject.rejected, [{ field: "record", code: "record_not_object" }]);
  assert.equal(notObject.requestId, null);
});

test("a complete record normalizes and keeps its unit", () => {
  const usage = normalizeAttributionUsage({
    requestId: "synthetic-request-0001",
    taskId: "synthetic-task",
    sessionId: "synthetic-session",
    role: "assistant",
    unit: "tokens",
    usageLevel: "request",
    value: 1234,
  });

  assert.equal(usage.requestId, "synthetic-request-0001");
  assert.equal(usage.taskId, "synthetic-task");
  assert.equal(usage.sessionId, "synthetic-session");
  assert.equal(usage.role, "assistant");
  assert.equal(usage.unit, "tokens");
  assert.equal(usage.usageLevel, "request");
  assert.equal(usage.value, 1234);
  assert.deepEqual(usage.rejected, []);
});

test("an unknown unit nulls the value instead of adding numbers", () => {
  const usage = normalizeAttributionUsage({ requestId: "synthetic-request-0002", unit: "usd", value: 5 });
  assert.equal(usage.unit, null);
  assert.equal(usage.value, null);
  assert.deepEqual(usage.rejected, [{ field: "unit", code: "unit_unsupported" }, { field: "value", code: "unit_missing" }]);

  const credit = normalizeAttributionUsage({ requestId: "synthetic-request-0003", unit: "credit", value: 12.5 });
  assert.equal(credit.unit, "credit");
  assert.equal(credit.value, 12.5);
});

test("a value without a unit is dropped rather than assumed to be tokens", () => {
  const usage = normalizeAttributionUsage({ requestId: "synthetic-request-0004", value: 900 });
  assert.equal(usage.unit, null);
  assert.equal(usage.value, null);
  assert.deepEqual(usage.rejected, [{ field: "value", code: "unit_missing" }]);
});

test("an unsupported usage level and a malformed field are reported, not coerced", () => {
  const usage = normalizeAttributionUsage({
    requestId: "synthetic-request-0005",
    taskId: 7,
    role: "assistant",
    unit: "tokens",
    usageLevel: "account",
    value: 10,
  });

  assert.equal(usage.usageLevel, null);
  assert.equal(usage.taskId, null);
  assert.equal(usage.requestId, "synthetic-request-0005");
  assert.ok(usage.rejected.some(item => item.code === "usage_level_unsupported"));
  assert.ok(usage.rejected.some(item => item.code === "field_invalid" && item.field === "taskId"));
});
