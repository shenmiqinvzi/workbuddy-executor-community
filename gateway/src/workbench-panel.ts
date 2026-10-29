import type { TaskStore } from "./task-store.js";
import { readTaskProjection } from "./task-view-reader.js";
import { stageTaskViewFromProjection } from "./task-view-stage.js";

export const PANEL_SCHEMA = "workbuddy-executor/panel-1" as const;

/** A separate, additive read DTO. Stage-2 retains its existing meaning. */
export function readPanelTask(store: TaskStore, runsDir: string, taskId: string, detail = true) {
  if (!taskId || taskId.length > 200) return { ok: false as const, taskId, code: "invalid_task_id", field: "taskId", message: "Use a task identifier from the task list." };
  const projection = readTaskProjection({ store, runsDir }, taskId);
  if (!projection.ok) return projection;
  const task = projection.row, contract = projection.contract?.contract;
  try {
    // These reads verify saved record digests only. They never inspect current
    // source files, run a check, sync a worker, or decide whether accept is safe.
    const saved = detail ? store.reviews.list(taskId) : [];
    const reviews = saved.slice(-50).map(review => ({
      reviewId: review.reviewId, attemptId: review.attemptId, createdAt: review.createdAt,
      basisRevision: review.basisRevision, committedRevision: review.committedRevision,
      runtimeSource: review.runtimeSource, note: review.note,
      supersedesReviewId: review.supersedesReviewId, correction: review.correction,
      checks: review.checks.map(check => ({
        id: check.id, checkId: check.checkId, kind: check.kind, status: check.status,
        actor: check.actor, checkedAt: check.checkedAt, note: check.note,
        evidenceRefs: check.evidenceRefs, checkedFileCount: Object.keys(check.fileHashes).length,
      })),
    }));
    const current = store.get(taskId);
    if (!current || current.revision !== task.revision || current.attemptId !== task.attemptId) {
      return { ok: false as const, taskId, code: "read_conflict", field: "revision", message: "The task changed while its saved review was being read. Refresh this snapshot." };
    }
    return {
      ok: true as const, taskId, schemaVersion: PANEL_SCHEMA, readOnly: true, snapshotOnly: true,
      view: stageTaskViewFromProjection({ task, projection, contract: projection.contract }),
      presentation: {
        // A verified agreement supplies a title. A worker objective is never
        // silently promoted into the stage title or a fabricated registration.
        title: contract?.title ?? null, objective: task.objective,
        blockingReason: task.blockingReason ?? null,
        allowedChanges: contract?.scope.allowedChanges ?? null,
        model: contract && "execution" in contract ? contract.execution.modelId : contract?.model ?? null,
        report: detail && task.report ? { status: task.report.status ?? null, authentication: projection.projection.facts?.report.state ?? "unknown", text: task.report.rawText.slice(0, 64000), truncated: task.report.rawText.length > 64000 } : null,
      },
      reviews: detail ? reviews : null,
      reviewsTruncated: detail && saved.length > 50,
      reviewMeaning: "stored_acceptance_snapshot" as const,
    };
  } catch {
    return { ok: false as const, taskId, code: "review_unavailable", field: "reviews", message: "Saved review records could not be verified. They are not reported as an empty review history." };
  }
}
