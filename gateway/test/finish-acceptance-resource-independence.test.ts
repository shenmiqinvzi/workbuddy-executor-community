/**
 * L08 acceptance line — task supervision and stop stay independent of a broken
 * resource/statistics read.
 *
 * The fault is synthetic: every statistics read throws. The task list, the task
 * detail and the user's cancellation must still answer from the durable store,
 * and the failure must surface as a bounded 503 instead of a task disappearing.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { WorkbenchHttpServer, workbenchHealth } from "../src/workbench-http.js";
import type { StatisticsStore } from "../src/statistics-service.js";
import { acceptanceFixture } from "./support/finish-acceptance-fixture.js";

const READ_FAILURE = "synthetic resource read failure";

function brokenStore(): StatisticsStore {
  return {
    get: () => { throw new Error(READ_FAILURE); },
    listAttempts: () => { throw new Error(READ_FAILURE); },
    listTaskEvents: () => { throw new Error(READ_FAILURE); },
    getContract: () => { throw new Error(READ_FAILURE); },
    listTasksByCreatedCursor: () => { throw new Error(READ_FAILURE); },
    reviews: { list: () => { throw new Error(READ_FAILURE); } },
  };
}

test("L08 a resource fault never hides supervision or blocks a user stop", async t => {
  const f = await acceptanceFixture(t, "workbuddy");
  await f.finish();
  assert.equal(f.store().get(f.taskId)?.state, "needs_review");

  const server = new WorkbenchHttpServer({
    service: f.service,
    statistics: { store: brokenStore() },
    health: () => workbenchHealth({ runtime: { release: "synthetic", packageVersion: "test", startedAt: "test" } }),
  });
  const port = await server.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;

  const broken = await fetch(`${base}/workbench/v1/statistics`);
  assert.equal(broken.status, 503, "a broken store is reported as unavailable, not as zero");
  const envelope = await broken.json() as { error?: { code?: string; retryable?: boolean } };
  assert.ok(["STORE_UNAVAILABLE", "EVENT_STREAM_UNREADABLE"].includes(String(envelope.error?.code)), `unexpected statistics error ${JSON.stringify(envelope)}`);

  const list = await fetch(`${base}/workbench/v1/tasks`);
  assert.equal(list.status, 200, "the task list still answers while statistics are down");
  const listBody = await list.json() as { tasks?: Array<{ taskId?: string }> };
  assert.ok(Array.isArray(listBody.tasks));
  assert.equal(listBody.tasks.some(task => task.taskId === f.taskId), true, "the supervised task is still listed");

  const detail = await fetch(`${base}/workbench/v1/tasks/${f.taskId}`);
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as { displayState?: string; taskId?: string };
  assert.equal(detailBody.taskId, f.taskId);
  assert.equal(detailBody.displayState, "needs_review");

  const cancelled = await f.service.cancel(f.taskId, "Synthetic user stop during a resource fault");
  assert.equal(cancelled.task.state, "cancelled", "the user can still stop the task");

  const after = await fetch(`${base}/workbench/v1/tasks/${f.taskId}`);
  assert.equal(after.status, 200);
  const afterBody = await after.json() as { displayState?: string };
  assert.equal(afterBody.displayState, "cancelled", "the stop is visible without any statistics read");
});
