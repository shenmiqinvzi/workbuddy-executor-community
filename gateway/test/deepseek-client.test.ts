import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DeepSeekClient, DeepSeekRpcError } from "../src/deepseek-client.js";

// These fixtures bind a real Unix-domain socket at a *.sock path. Windows hosts
// are named pipes (`\\.\pipe\workbuddy-dsh-*`, covered by dsh-transport.test.ts)
// and `net` cannot listen on a socket path there, so the fixture is POSIX-only.
const posixSocket = process.platform === "win32"
  ? "POSIX-only: the fixture binds a real Unix-domain socket in a temp directory; Windows hosts are named pipes. Run on Linux or macOS."
  : false;
// The registry privacy rule is stat.mode/uid on POSIX and an ACL check on
// Windows, so fixed-mode *.sock registrations only reachable on POSIX.
const posixRegistry = process.platform === "win32"
  ? "POSIX-only: the fixture relies on mode/uid privacy for *.sock registrations; Windows hosts are ACL-checked named pipes. Run on Linux or macOS."
  : false;

test("authenticated Unix socket RPC selects the host without exposing registry credentials", { skip: posixSocket }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-rpc-")); const socketPath = path.join(dir, "host.sock"); const token = "private-token-for-test-only";
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = http.createServer((request, response) => {
    assert.equal(request.method, "POST"); assert.equal(request.url, "/rpc"); assert.equal(request.headers.authorization, `Bearer ${token}`);
    let raw = ""; request.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    request.on("end", () => { const value = JSON.parse(raw) as { method: string; params: Record<string, unknown> }; requests.push(value);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value.method === "health" ? { ok: true, value: { hostId: "test-host", ready: true } } : { ok: false, error: { code: "UNKNOWN_SESSION", message: "Session does not exist" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, "host.json"), JSON.stringify({ hostId: "test-host", socketPath, token }), { mode: 0o600 });
  const client = new DeepSeekClient(dir);
  assert.deepEqual(await client.health(), { hostId: "test-host", ready: true });
  assert.deepEqual(requests[0], { method: "health", params: {} });
  await assert.rejects(client.session({ sessionId: "missing" }), (error: unknown) => error instanceof DeepSeekRpcError && error.code === "UNKNOWN_SESSION" && !error.message.includes(token));
});
test("registry selection rejects public files and requires explicit host when multiple exist", { skip: posixRegistry }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-reg-"));
  try {
    const host = (hostId: string) => ({ hostId, socketPath: path.join(dir, `${hostId}.sock`), token: "private-test-token-12345" });
    fs.writeFileSync(path.join(dir, "public.json"), JSON.stringify(host("public")), { mode: 0o644 });
    const client = new DeepSeekClient(dir); assert.deepEqual(client.hosts(), []); assert.throws(() => client.resolveHostId(), /No Harness bridge/);
    for (const name of ["one", "two"]) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(host(name)), { mode: 0o600 });
    assert.throws(() => client.resolveHostId(), /Multiple Harness hosts/); assert.equal(client.resolveHostId("two"), "two");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("socket timeout does not retry or send another prompt", { skip: posixSocket }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-timeout-")); const socketPath = path.join(dir, "host.sock"); let requests = 0;
  const server = http.createServer(() => { requests++; }); await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, "host.json"), JSON.stringify({ hostId: "test-host", socketPath, token: "private-test-token-12345" }), { mode: 0o600 });
  const client = new DeepSeekClient(dir, "test-host", 25);
  await assert.rejects(client.prompt({ hostId: "test-host", sessionId: "session", requestId: "request", text: "task" }), /timed out/); assert.equal(requests, 1);
});

test("stale registry from a dead pid stays discoverable but does not block default live-host selection", { skip: posixRegistry }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-stale-"));
  try {
    for (const [hostId, pid] of [["live", process.pid], ["stale", 2147483647]] as const) {
      fs.writeFileSync(path.join(dir, `${hostId}.json`), JSON.stringify({ hostId, pid, socketPath: path.join(dir, `${hostId}.sock`), token: "private-test-token-12345" }), { mode: 0o600 });
    }
    const client = new DeepSeekClient(dir); assert.equal(client.hosts().length, 2); assert.equal(client.hosts().find((host) => host.hostId === "stale")?.processAlive, false); assert.equal(client.resolveHostId(), "live");
    assert.throws(() => client.resolveHostId("stale"), /No registered DeepSeek host/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
