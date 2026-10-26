import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPrivatePath } from "../deepseek-plugin/private-path.mjs";
import { DshClient } from "../src/dsh-client.js";

test("real local transport and DSH client use a private authenticated endpoint", { timeout: 60000 }, async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-wire-")), root = path.join(parent, "bridge");
  const modulePath = new URL("../deepseek-plugin/transport.mjs", import.meta.url).href;
  const { startTransport } = await import(modulePath);
  const hostId = "dsh-synthetic-wire";
  const bridge = await startTransport({ root, hostId, identity: { profile: "desktop", version: "0.2.1-rc.2" }, invoke: async (method: string, params: Record<string, unknown>) => {
    assert.deepEqual(params, {}); if (method === "health") return { hostId, capabilities: { automaticReview: false } };
    if (method === "models") return { models: [], pricingVerified: false };
    throw Error("not allowed");
  } });
  t.after(async () => { await bridge.close(); fs.rmSync(parent, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  const client = new DshClient(path.join(root, "hosts"), hostId);
  assert.equal(client.resolveHostId(), hostId);
  assert.deepEqual(await client.models(hostId), { models: [], pricingVerified: false });
  assert.deepEqual(await client.health(hostId), { hostId, capabilities: { automaticReview: false } });
  const registration = JSON.parse(fs.readFileSync(bridge.registryPath, "utf8"));
  fs.writeFileSync(bridge.registryPath, JSON.stringify({ ...registration, token: "synthetic-invalid-token" }));
  await assert.rejects(client.health(hostId), { code: "bridge/unauthorized" });
  fs.writeFileSync(bridge.registryPath, JSON.stringify(registration));
  if (process.platform === "win32") { windowsPrivatePath(root, { directory: true }); windowsPrivatePath(bridge.registryPath); assert.match(registration.socketPath, /^\\\\\.\\pipe\\workbuddy-dsh-/); }
  else assert.equal(fs.statSync(bridge.registryPath).mode & 0o777, 0o600);
});

test("bridge refuses symlinked registration roots without modifying their targets", async t => {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dsh-link-"))), target = path.join(parent, "target"), alias = path.join(parent, "alias");
  fs.mkdirSync(target); fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => { fs.unlinkSync(alias); fs.rmSync(parent, { recursive: true, force: true }); });
  const modulePath = new URL("../deepseek-plugin/transport.mjs", import.meta.url).href;
  const { privateDirectory } = await import(modulePath);
  await assert.rejects(privateDirectory(alias), { code: "bridge/insecure-path" });
  assert.deepEqual(fs.readdirSync(target), []);
});
