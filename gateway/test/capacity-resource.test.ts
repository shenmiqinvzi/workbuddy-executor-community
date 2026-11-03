import test from "node:test";
import assert from "node:assert/strict";
import { CAPACITY_RESOURCE_SCHEMA, capacityResource } from "../src/capacity-view.js";

test("the capacity slot is published as its own read-only version", () => {
  const resource = capacityResource(null, "2026-11-02T00:00:00.000Z");
  assert.deepEqual(resource, {
    schemaVersion: "workbuddy-executor/capacity-1",
    readOnly: true,
    snapshotOnly: true,
    limit: 1,
    occupied: null,
    observedAt: "2026-11-02T00:00:00.000Z",
  });
  assert.equal(CAPACITY_RESOURCE_SCHEMA, "workbuddy-executor/capacity-1");
});

test("an occupant is copied verbatim; a free slot is never invented", () => {
  const occupant = { taskId: "task-a", executor: "workbuddy", operationId: "desktop-send-1" };
  const resource = capacityResource(occupant, "2026-11-02T00:00:00.000Z");
  assert.deepEqual(resource.occupied, occupant);
  assert.notEqual(resource.occupied, occupant, "the reading is a snapshot, not the live row");
  assert.equal(resource.limit, 1);
  assert.equal(resource.readOnly, true);
  // The resource carries no stop, closure or verdict field: capacity is not a decision.
  assert.deepEqual(Object.keys(resource).sort(), ["limit", "observedAt", "occupied", "readOnly", "schemaVersion", "snapshotOnly"]);
});
