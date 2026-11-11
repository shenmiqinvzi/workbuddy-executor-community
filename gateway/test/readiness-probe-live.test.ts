import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeToolStdio } from "../src/readiness-probes.js";

/**
 * WB06: the readiness report may only claim "ready" from a probe that ran in the
 * observing process. This test runs the real probe against the built server so the
 * claim rests on an actual round trip, not on a stub.
 */

const gatewayRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(gatewayRoot, "dist", "server.js");
const hasDist = fs.existsSync(serverEntry);

test("the probe reaches the built tool process and reads its own health answer", { skip: hasDist ? false : "dist/server.js is not built in this worktree", timeout: 180_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-probe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const answer = await probeToolStdio({
    gatewayRoot,
    timeoutMs: 120_000,
    env: {
      ...process.env,
      WORKBUDDY_BACKEND: "desktop-queue",
      WORKBUDDY_DB_FILE: path.join(dir, "tasks.sqlite"),
      WORKBUDDY_RUNS_DIR: path.join(dir, "runs"),
      WORKBUDDY_SERVICE_CONFIG: path.join(dir, "persistent-service.json"),
      WORKBUDDY_CONFIG_DIR: path.join(dir, "config"),
      WORKBUDDY_GATEWAY_URL: "http://127.0.0.1:0",
    },
  });
  assert.equal(answer.responsive, true, `the tool process did not answer: ${answer.detail}`);
  assert.match(String(answer.detail), /workbuddy_health/);
  assert.equal(typeof answer.native?.bridgeReady, "boolean");
});

test("a tool process that cannot start is reported as unavailable, never as ready", { timeout: 60_000 }, async t => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-no-build-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const answer = await probeToolStdio({ gatewayRoot: empty, timeoutMs: 20_000 });
  assert.equal(answer.responsive, false);
  assert.match(String(answer.detail), /the tool process did not answer/);
  assert.equal(answer.native, undefined);
});
