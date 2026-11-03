/** The single-execution capacity slot, published as its own read resource.
 *
 * It is deliberately not a field on the stage-2 view: the interface contract
 * requires new read-only data to arrive as an independently versioned resource
 * instead of pretending `workbuddy-executor/stage-2` gained a field.
 */
export const CAPACITY_RESOURCE_SCHEMA = "workbuddy-executor/capacity-1" as const;

export interface CapacityOccupant {
  taskId: string;
  executor: string;
  operationId: string;
}

export interface CapacityResource {
  schemaVersion: typeof CAPACITY_RESOURCE_SCHEMA;
  readOnly: true;
  snapshotOnly: true;
  /** The workflow shares one execution slot; this is a fact, not a tunable. */
  limit: 1;
  /** The task holding the slot, or null when the slot is free. */
  occupied: CapacityOccupant | null;
  /** When this reading was taken. A reader never upgrades it into live state. */
  observedAt: string;
}

/**
 * Pure mapping from the saved capacity row.
 *
 * It reports exactly what the row says: a free slot is `occupied: null`, and an
 * absent row is never turned into a guess about whether an execution is running.
 */
export function capacityResource(occupied: CapacityOccupant | null, observedAt: string): CapacityResource {
  return {
    schemaVersion: CAPACITY_RESOURCE_SCHEMA,
    readOnly: true,
    snapshotOnly: true,
    limit: 1,
    occupied: occupied
      ? { taskId: String(occupied.taskId), executor: String(occupied.executor), operationId: String(occupied.operationId) }
      : null,
    observedAt,
  };
}
