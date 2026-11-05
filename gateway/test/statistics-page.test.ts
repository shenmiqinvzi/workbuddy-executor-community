/**
 * L03 page formatter tests.
 *
 * The statistics page is plain ESM whose rendering helpers are pure functions
 * over a server response. These tests import that module without a DOM (only
 * the render helpers are exercised) and assert the presentation rule the
 * acceptance line cares about: an unmeasured value is never printed as zero,
 * and per-unit groups are never merged into one figure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { amount, attributionLabel, callsTotal, seconds, usageLines } from "../workbench/statistics.mjs";

test("statistics page: unmeasured numbers render as NA, never as 0", () => {
  assert.equal(amount(null), "NA");
  assert.equal(amount(undefined), "NA");
  assert.equal(amount(Number.NaN), "NA");
  assert.equal(amount(0), "0");
  assert.equal(seconds(null), "NA");
  assert.equal(seconds(Number.POSITIVE_INFINITY), "NA");
  assert.equal(seconds(0), "0m00s");
  assert.equal(seconds(65), "1m05s");
  assert.equal(callsTotal([]), null);
  assert.equal(callsTotal([{ count: 2 }, { count: 3 }]), 5);
});

test("statistics page: usage is listed per unit and currency, never summed across them", () => {
  assert.deepEqual(usageLines([]), ["NA"]);
  assert.deepEqual(usageLines(null), ["NA"]);
  const lines = usageLines([
    { unit: "tokens", currency: null, amount: 120, records: 2, measuredRecords: 2, estimatedRecords: 0, unavailableRecords: 0 },
    { unit: "currency", currency: "CNY", amount: null, records: 1, measuredRecords: 0, estimatedRecords: 1, unavailableRecords: 0 },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^tokens: 120/);
  assert.match(lines[1]!, /^currency CNY: NA/);
  assert.equal(lines[0]!.includes("240"), false);
});

test("statistics page: the attribution label names what was actually linked", () => {
  assert.match(attributionLabel("exact"), /^exact/);
  assert.match(attributionLabel("connection_only"), /^connection_only/);
  assert.match(attributionLabel(null), /^unavailable/);
});
