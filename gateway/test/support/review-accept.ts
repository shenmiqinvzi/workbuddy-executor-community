import crypto from "node:crypto";
import type { TaskStore } from "../../src/task-store.js";

/** Upgrade positive native transport fixtures to the real T6 gate, never production auto-review. */
export async function reviewAccept(target: unknown, taskId: string, note: string, _evidence: string[], _artifacts: string[] = []) {
  const coordinator = target as { store?: TaskStore; coordinator?: { store: TaskStore; config: { runsDir: string } }; config?: { runsDir: string }; runsDir?: string; sync(taskId: string): Promise<unknown> };
  await coordinator.sync(taskId);
  const store = coordinator.store ?? coordinator.coordinator!.store, runs = coordinator.runsDir ?? coordinator.config?.runsDir ?? coordinator.coordinator!.config.runsDir;
  const op = () => { const task = store.get(taskId)!; return { taskId, operationId: crypto.randomUUID(), expectedRevision: task.revision!, expectedAttemptId: task.attemptId! }; };
  const batch = store.reviews.checks(op(), runs);
  const review = store.reviews.review({ ...op(), machineCheckIds: batch.machineCheckIds, semanticChecks: [], note }, runs);
  return store.reviews.accept({ ...op(), reviewId: review.reviewId }).task;
}
