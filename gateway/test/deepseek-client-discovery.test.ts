import assert from "node:assert/strict";
import crypto from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DeepSeekClient, DeepSeekRpcError, type DeepSeekHost } from "../src/deepseek-client.js";

// Discovery snapshots are controlled here; the real HTTP client still talks to
// a real local pipe/socket. Real registration ACLs remain covered by dsh-transport.
class SnapshotClient extends DeepSeekClient {
  scans = 0;
  constructor(private readonly snapshots: DeepSeekHost[][], defaultHostId?: string) {
    super("unused-synthetic-registry", defaultHostId, 1000);
  }
  override hosts(): DeepSeekHost[] { return this.snapshots[this.scans++] ?? []; }
}

async function endpoint(t: test.TestContext, hostId = "synthetic-host", dropResponse = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-discovery-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\workbuddy-dsh-discovery-${process.pid}-${crypto.randomUUID()}`
    : path.join(directory, "host.sock");
  const token = `synthetic-token-${crypto.randomUUID()}`;
  const calls: Array<{ method: string; params: unknown }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (dropResponse) { request.socket.destroy(); return; }
    response.setHeader("Connection", "close");
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ ok: false, error: { code: "bridge/unauthorized", message: "Private bridge authentication required" } }));
      return;
    }
    response.end(JSON.stringify({ ok: true, value: { hostId, endpoint: socketPath } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const host: DeepSeekHost = { hostId, socketPath, token, pid: process.pid, processAlive: true };
  return { host, calls };
}

const selectionError = (code: string) => (error: unknown) =>
  error instanceof DeepSeekRpcError && error.code === code && error.admissionRejected === false;

test("one RPC uses one verified snapshot even when a later registry scan would be empty", async t => {
  const wire = await endpoint(t);
  const client = new SnapshotClient([[wire.host], []]);
  assert.deepEqual(await client.health(wire.host.hostId), { hostId: wire.host.hostId, endpoint: wire.host.socketPath });
  assert.equal(client.scans, 1);
  assert.equal(wire.calls.length, 1);
});

test("a registry rotation cannot replace the endpoint or token halfway through an RPC", async t => {
  const first = await endpoint(t), rotated = await endpoint(t);
  const client = new SnapshotClient([[first.host], [rotated.host]]);
  assert.deepEqual(await client.health(first.host.hostId), { hostId: first.host.hostId, endpoint: first.host.socketPath });
  assert.equal(client.scans, 1);
  assert.equal(first.calls.length, 1);
  assert.equal(rotated.calls.length, 0);
});

test("a missing explicit host never falls back to another live host", async t => {
  const other = await endpoint(t, "synthetic-other");
  const client = new SnapshotClient([[other.host]]);
  await assert.rejects(client.health("synthetic-missing"), selectionError("HOST_NOT_FOUND"));
  assert.equal(client.scans, 1);
  assert.equal(other.calls.length, 0);
});

test("multiple live hosts require an explicit choice without sending a request", async t => {
  const first = await endpoint(t, "synthetic-one"), second = await endpoint(t, "synthetic-two");
  const client = new SnapshotClient([[first.host, second.host]]);
  await assert.rejects(client.health(), selectionError("HOST_AMBIGUOUS"));
  assert.equal(first.calls.length + second.calls.length, 0);
});

test("duplicate registrations for an explicit host are ambiguous rather than first-wins", async t => {
  const first = await endpoint(t), second = await endpoint(t);
  const client = new SnapshotClient([[first.host, second.host]]);
  await assert.rejects(client.health(first.host.hostId), selectionError("HOST_AMBIGUOUS"));
  assert.equal(first.calls.length + second.calls.length, 0);
});

test("default selection ignores dead hosts and still uses only one snapshot", async t => {
  const live = await endpoint(t);
  const client = new SnapshotClient([[{ ...live.host, hostId: "synthetic-dead", processAlive: false }, live.host]]);
  assert.deepEqual(await client.health(), { hostId: live.host.hostId, endpoint: live.host.socketPath });
  assert.equal(client.scans, 1);
  assert.equal(live.calls.length, 1);
});

test("an explicit dead host is rejected even when another host is live", async t => {
  const live = await endpoint(t);
  const client = new SnapshotClient([[{ ...live.host, hostId: "synthetic-dead", processAlive: false }, live.host]]);
  await assert.rejects(client.health("synthetic-dead"), selectionError("HOST_NOT_FOUND"));
  assert.equal(live.calls.length, 0);
});

test("each new RPC discovers afresh instead of caching an earlier host selection", async t => {
  const wire = await endpoint(t);
  const client = new SnapshotClient([[wire.host], []]);
  assert.equal(client.resolveHostId(wire.host.hostId), wire.host.hostId);
  await assert.rejects(client.health(wire.host.hostId), selectionError("HOST_NOT_FOUND"));
  assert.equal(client.scans, 2);
  assert.equal(wire.calls.length, 0);
});

test("an unreadable registry produces a sanitized discovery error before any RPC", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-discovery-error-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registry = path.join(directory, "not-a-registry");
  fs.writeFileSync(registry, "synthetic-private-registry-content");
  const client = new DeepSeekClient(registry);
  assert.deepEqual(client.hosts(), []);
  await assert.rejects(client.health("synthetic-host"), error => {
    assert.ok(error instanceof DeepSeekRpcError);
    assert.equal(error.code, "HOST_DISCOVERY_UNAVAILABLE");
    assert.match(error.message, /registry_unreadable/);
    assert.equal(error.message.includes(directory), false);
    assert.equal(error.message.includes("synthetic-private-registry-content"), false);
    assert.equal(error.admissionRejected, false);
    return true;
  });
});

test("Windows ACL query failures stay excluded and expose only a sanitized reason", { skip: process.platform !== "win32" }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-acl-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "host.json"), JSON.stringify({
    hostId: "synthetic-host", socketPath: "\\\\.\\pipe\\workbuddy-dsh-synthetic-acl", token: "synthetic-private-token-do-not-return", pid: process.pid,
  }));
  let failureCode = "ETIMEDOUT";
  t.mock.method(childProcess, "execFileSync", () => {
    throw Object.assign(new Error(`synthetic-private-helper-output: ${directory}`), { code: failureCode });
  });
  syncBuiltinESMExports();
  try {
    for (const [code, reason] of [["ETIMEDOUT", "acl_query_timeout"], ["EACCES", "private_path_unverified"]]) {
      failureCode = code!;
      const client = new DeepSeekClient(directory);
      assert.deepEqual(client.hosts(), [], "an unverifiable registration is never admitted");
      await assert.rejects(client.health("synthetic-host"), error => {
        assert.ok(error instanceof DeepSeekRpcError);
        assert.equal(error.code, "HOST_DISCOVERY_UNAVAILABLE");
        assert.ok(error.message.includes(reason!));
        assert.doesNotMatch(error.message, /synthetic-private/);
        assert.equal(error.message.includes(directory), false);
        assert.equal(error.admissionRejected, false);
        return true;
      });
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("authentication failure does not rescan, switch credentials or resend", async t => {
  const wire = await endpoint(t);
  const client = new SnapshotClient([[{ ...wire.host, token: "synthetic-invalid-token" }], [wire.host]]);
  await assert.rejects(client.health(wire.host.hostId), selectionError("bridge/unauthorized"));
  assert.equal(client.scans, 1);
  assert.equal(wire.calls.length, 1);
});

test("a lost prompt response remains uncertain and is never retried against a new snapshot", async t => {
  const first = await endpoint(t, "synthetic-host", true), second = await endpoint(t);
  const client = new SnapshotClient([[first.host], [second.host]]);
  await assert.rejects(client.prompt({ hostId: first.host.hostId, sessionId: "synthetic-session", requestId: "synthetic-request", text: "synthetic prompt" }), error => {
    assert.equal(error instanceof DeepSeekRpcError && error.admissionRejected, false);
    return true;
  });
  assert.equal(client.scans, 1);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0]!.method, "prompt");
  assert.equal(second.calls.length, 0);
});
