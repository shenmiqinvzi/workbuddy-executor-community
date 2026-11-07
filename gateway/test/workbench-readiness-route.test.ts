/**
 * The readiness read on the workbench HTTP surface.
 *
 * Five separate answers, computed per request, and nothing about it may write:
 * no configuration file, no model preparation, no session. The report itself is
 * produced by ./readiness.js and tested there; this file tests the HTTP seam 鈥? * that the route exists, refuses query parameters, reports a failed observation
 * as a 503 rather than a stale success, and disappears when no surface is bound.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Config } from "../src/config.js";
import { TaskCoordinator } from "../src/coordinator.js";
import { TaskApplicationService } from "../src/task-application-service.js";
import { TaskStore } from "../src/task-store.js";
import { WorkBuddyClient } from "../src/workbuddy-client.js";
import { WorkbenchHttpServer, workbenchHealth } from "../src/workbench-http.js";

class NoopClient extends WorkBuddyClient {}

function service(t: { after: (fn: () => void) => void }): TaskApplicationService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-readiness-"));
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
  const coordinator = new TaskCoordinator(config, store, new NoopClient(config));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return new TaskApplicationService(coordinator, 3, config.runsDir!);
}

function request(port: number, options: { method?: string; path: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: options.path, method: options.method ?? "GET" }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function start(svc: TaskApplicationService, readiness?: { observe: () => Promise<unknown> }): Promise<{ port: number; close: () => Promise<void> }> {
  const server = new WorkbenchHttpServer({
    service: svc,
    readiness,
    health: () => workbenchHealth({ runtime: { release: "test", packageVersion: "0.0.0", startedAt: "2026-11-07T00:00:00.000Z" } }),
  });
  const port = await server.listen(0);
  return { port, close: () => server.close() };
}

test("the readiness route serves the report it observed on this request", async t => {
  const svc = service(t);
  let observed = 0;
  const { port, close } = await start(svc, {
      observe: async () => {
        observed += 1;
        return {
          schema: "workbuddy-readiness/v1",
          readOnly: true,
          observedAt: "2026-11-07T00:00:00.000Z",
          selection: { state: "resolved", backend: "desktop-queue", config: { state: "detected", candidates: [] }, executable: { state: "detected", candidates: [] }, suggested: [] },
          layers: [{ layer: "nativeOnline", question: "online?", state: "unknown", observedAt: "2026-11-07T00:00:00.000Z", facts: {}, missing: ["native_online"] }],
          nextAction: { layer: "nativeOnline", action: "open WorkBuddy" },
          notes: [],
        };
      },
  });
  t.after(close);
  const first = await request(port, { path: "/workbench/v1/readiness" });
  assert.equal(first.status, 200);
  const body = JSON.parse(first.body) as { ok: boolean; value: { schema: string; readOnly: boolean; layers: { state: string }[] } };
  assert.equal(body.ok, true);
  assert.equal(body.value.schema, "workbuddy-readiness/v1");
  assert.equal(body.value.readOnly, true);
  // An unknown layer stays unknown: the route does not upgrade it into ready.
  assert.equal(body.value.layers[0]!.state, "unknown");
  await request(port, { path: "/workbench/v1/readiness" });
  assert.equal(observed, 2, "each GET observes again instead of replaying a cached report");
});

test("the readiness route refuses query parameters and write verbs", async t => {
  const svc = service(t);
  let observed = 0;
  const { port, close } = await start(svc, { observe: async () => { observed += 1; return { layers: [] }; } });
  t.after(close);
  const query = await request(port, { path: "/workbench/v1/readiness?force=1" });
  assert.equal(query.status, 400);
  assert.match(query.body, /INVALID_READINESS_QUERY/);
  assert.equal(observed, 0, "a rejected request observes nothing");
  const post = await request(port, { path: "/workbench/v1/readiness", method: "POST" });
  assert.equal(post.status, 405);
});

test("a failed observation is a 503, never a stale or partial success", async t => {
  const svc = service(t);
  const { port, close } = await start(svc, { observe: async () => { throw new Error("pipe closed"); } });
  t.after(close);
  const response = await request(port, { path: "/workbench/v1/readiness" });
  assert.equal(response.status, 503);
  assert.match(response.body, /READINESS_UNAVAILABLE/);
  assert.doesNotMatch(response.body, /pipe closed/, "the failure detail is not echoed to the client");
});

test("without the surface the route does not exist", async t => {
  const svc = service(t);
  const { port, close } = await start(svc);
  t.after(close);
  assert.equal((await request(port, { path: "/workbench/v1/readiness" })).status, 404);
});
