/**
 * Embedded panel contract.
 *
 * The repository ships the mechanism, not a page: with nothing configured the
 * workbench frames nothing and the shell keeps cancelling sub-frames. These
 * cases pin that default so a personal dashboard URL can never quietly become
 * the shipped behaviour, and pin the parser so an installer's typo cannot
 * widen the frame policy.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Config } from "../src/config.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { parseEmbedOrigins, parseEmbedUrl, readEmbedConfig } from "../src/embed-panel.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { WorkbenchHttpServer, workbenchHealth } from "../src/workbench-http.js";

class NoopClient extends WorkBuddyClient {}

test("an unconfigured install embeds nothing", () => {
  const config = readEmbedConfig({});
  assert.equal(config.panel, null);
  assert.deepEqual(config.origins, []);
});

test("a loopback panel URL supplies its own origin", () => {
  const config = readEmbedConfig({
    WORKBUDDY_WORKBENCH_EMBED_URL: "http://127.0.0.1:3000/dash",
    WORKBUDDY_WORKBENCH_EMBED_TITLE: "本地面板",
  });
  assert.deepEqual(config.panel, { url: "http://127.0.0.1:3000/dash", title: "本地面板", origin: "http://127.0.0.1:3000" });
  assert.deepEqual(config.origins, ["http://127.0.0.1:3000"]);
});

test("the panel title falls back and is capped", () => {
  assert.equal(readEmbedConfig({ WORKBUDDY_WORKBENCH_EMBED_URL: "http://127.0.0.1:3000/" }).panel?.title, "嵌入面板");
  assert.equal(readEmbedConfig({ WORKBUDDY_WORKBENCH_EMBED_URL: "http://127.0.0.1:3000/", WORKBUDDY_WORKBENCH_EMBED_TITLE: "   " }).panel?.title, "嵌入面板");
  assert.equal(readEmbedConfig({ WORKBUDDY_WORKBENCH_EMBED_URL: "http://127.0.0.1:3000/", WORKBUDDY_WORKBENCH_EMBED_TITLE: "标".repeat(60) }).panel?.title.length, 40);
});

test("only plain HTTP on loopback can be framed", () => {
  assert.equal(parseEmbedUrl("https://127.0.0.1:3000/"), null);
  assert.equal(parseEmbedUrl("http://10.0.0.5:3000/"), null);
  assert.equal(parseEmbedUrl("http://user:pass@127.0.0.1:3000/"), null);
  assert.equal(parseEmbedUrl("http://127.0.0.1:3000/?token=1"), null);
  assert.equal(parseEmbedUrl("http://127.0.0.1:3000/#tab"), null);
  assert.equal(parseEmbedUrl("file:///etc/passwd"), null);
  assert.equal(parseEmbedUrl("not a url"), null);
  assert.equal(parseEmbedUrl(undefined), null);
  assert.deepEqual(parseEmbedUrl("http://localhost:3000/"), { url: "http://localhost:3000/", origin: "http://localhost:3000" });
});

test("extra origins are parsed strictly and deduplicated", () => {
  assert.deepEqual(parseEmbedOrigins("http://127.0.0.1:3000, http://127.0.0.1:3000,https://127.0.0.1:4000,http://127.0.0.1:5000/path"), ["http://127.0.0.1:3000"]);
  assert.deepEqual(parseEmbedOrigins(undefined), []);
  assert.deepEqual(parseEmbedOrigins(""), []);
});

test("a configured panel origin is always in the allowlist", () => {
  const config = readEmbedConfig({ WORKBUDDY_WORKBENCH_EMBED_URL: "http://127.0.0.1:3000/", WORKBUDDY_WORKBENCH_EMBED_ORIGINS: "http://127.0.0.1:4000" });
  assert.deepEqual(config.origins, ["http://127.0.0.1:3000", "http://127.0.0.1:4000"]);
});

function server(embed: { panel: null } | { panel: { url: string; title: string; origin: string } }): { port: Promise<number>; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "embed-panel-"));
  const config: Config = {
    backend: "desktop-queue",
    apiBaseUrl: "http://127.0.0.1/unreachable",
    tokenFile: path.join(dir, "credentials.json"),
    dbFile: path.join(dir, "tasks.sqlite"),
    oauthRedirectUri: "http://127.0.0.1:0/oauth",
    oauthPort: 0,
    oauthScopes: "test",
    requestTimeoutMs: 1000,
    cliElectronPath: path.join(dir, "no-electron.exe"),
    cliScriptPath: path.join(dir, "no-cli"),
    cliPermissionMode: "deny",
    acpPermissionMode: "deny",
    gatewayUrl: "http://127.0.0.1:0",
    workbuddyConfigDir: path.join(dir, "workbuddy-config"),
    runsDir: path.join(dir, "runs"),
    taskTimeoutSeconds: 600,
    claimTimeoutSeconds: 60,
    maxTaskAttempts: 3,
    serviceConfigFile: path.join(dir, "persistent-service.json"),
  };
  const store = new TaskStore(config.dbFile);
  const service = new TaskApplicationService(new TaskCoordinator(config, store, new NoopClient(config)), 3, config.runsDir!);
  const origins = embed.panel === null ? [] : [embed.panel.origin];
  const httpServer = new WorkbenchHttpServer({
    service,
    health: () => workbenchHealth({ runtime: { release: "test", packageVersion: "0.0.0", startedAt: "2026-10-23T00:00:00.000Z" } }),
    embed: { panel: embed.panel, origins },
  });
  return { port: httpServer.listen(0), close: () => { httpServer.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("the page learns about the panel from the gateway, not from a hardcoded URL", async () => {
  const bare = server({ panel: null });
  try {
    const response = await fetch(`http://127.0.0.1:${await bare.port}/workbench/v1/embed`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, value: { panel: null } });
  } finally { bare.close(); }

  const configured = server({ panel: { url: "http://127.0.0.1:3000/", title: "本地面板", origin: "http://127.0.0.1:3000" } });
  try {
    const response = await fetch(`http://127.0.0.1:${await configured.port}/workbench/v1/embed`);
    assert.deepEqual(await response.json(), { ok: true, value: { panel: { url: "http://127.0.0.1:3000/", title: "本地面板", origin: "http://127.0.0.1:3000" } } });
  } finally { configured.close(); }
});

test("the page CSP frames nothing unless an origin was configured", async () => {
  const bare = server({ panel: null });
  try {
    const response = await fetch(`http://127.0.0.1:${await bare.port}/workbench/`);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-src 'none'/);
  } finally { bare.close(); }

  const configured = server({ panel: { url: "http://127.0.0.1:3000/", title: "本地面板", origin: "http://127.0.0.1:3000" } });
  try {
    const response = await fetch(`http://127.0.0.1:${await configured.port}/workbench/`);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-src http:\/\/127\.0\.0\.1:3000/);
  } finally { configured.close(); }
});

test("the embed endpoint stays read-only", async () => {
  const bare = server({ panel: null });
  try {
    const response = await fetch(`http://127.0.0.1:${await bare.port}/workbench/v1/embed`, { method: "POST" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
  } finally { bare.close(); }
});
