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

/**
 * FC01: an answer the probe cannot read must never be upgraded to "ready".
 * Each case is a real stdio round trip against a fixture entry that answers the
 * health call with something a healthy tool would not send.
 */
function fakeGatewayRoot(t: test.TestContext, toolResult: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "readiness-fake-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  const result = JSON.stringify(toolResult);
  fs.writeFileSync(path.join(root, "dist", "health-entry.js"), `
import readline from 'node:readline';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : message.method === 'tools/call' ? ${result} : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});
`);
  return root;
}

const healthyBody = (dbFile: string) => ({
  ok: true,
  online: true,
  ready: true,
  backend: "desktop-queue",
  observer: { pid: 1234, dataRoot: path.dirname(dbFile), dbFile, codeHash: "abc" },
});

test("an unreadable health answer is not responsive", { timeout: 120_000 }, async t => {
  const cases: { name: string; result: unknown; pattern: RegExp }[] = [
    { name: "text that is not JSON", result: { content: [{ type: "text", text: "not JSON" }] }, pattern: /was not JSON/ },
    { name: "no text content", result: { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }, pattern: /no text content/ },
    { name: "a JSON array", result: { content: [{ type: "text", text: "[1,2,3]" }] }, pattern: /not a JSON object/ },
    { name: "an error result", result: { isError: true, content: [{ type: "text", text: JSON.stringify(healthyBody("C:/x/tasks.sqlite")) }] }, pattern: /error result/ },
  ];
  for (const item of cases) {
    const root = fakeGatewayRoot(t, item.result);
    const answer = await probeToolStdio({ gatewayRoot: root, timeoutMs: 20_000 });
    assert.equal(answer.responsive, false, `${item.name} was reported as responsive`);
    assert.match(String(answer.detail), item.pattern, `${item.name}: ${answer.detail}`);
    assert.equal(answer.native?.bridgeReady, false, `${item.name} claimed a bridge`);
    assert.equal(answer.identity, undefined, `${item.name} invented an identity`);
  }
});

test("a health answer that does not name its database is not responsive", { timeout: 60_000 }, async t => {
  const unbound = {
    content: [{ type: "text", text: JSON.stringify({ ok: true, online: true, ready: true, backend: "desktop-queue", observer: { pid: 99 } }) }],
  };
  const answer = await probeToolStdio({ gatewayRoot: fakeGatewayRoot(t, unbound), timeoutMs: 20_000 });
  assert.equal(answer.responsive, false);
  assert.match(String(answer.detail), /did not name the database/);
});

test("a readable answer that names its database is responsive and carries its identity", { timeout: 60_000 }, async t => {
  const dbFile = path.join(os.tmpdir(), "readiness-identity", "tasks.sqlite");
  const answer = await probeToolStdio({ gatewayRoot: fakeGatewayRoot(t, { content: [{ type: "text", text: JSON.stringify(healthyBody(dbFile)) }] }), timeoutMs: 20_000 });
  assert.equal(answer.responsive, true, String(answer.detail));
  assert.equal(answer.identity?.pid, 1234);
  assert.equal(path.resolve(String(answer.identity?.dbFile)), path.resolve(dbFile));
  assert.equal(answer.native?.bridgeReady, true);
});
