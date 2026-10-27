/**
 * Composition root for the stage-1 read-only workbench HTTP server.
 *
 * Run with the built dist: `node dist/workbench-entry.js`.
 *
 * It constructs the same shared service the MCP server builds (config, store,
 * coordinator) and binds the read-only adapter on the loopback port. It
 * starts no native work, no dispatch and no model request; nothing else in
 * this process writes to the task store.
 */

import { loadConfig } from "./config.js";
import { TaskStore } from "./task-store.js";
import { TaskCoordinator } from "./coordinator.js";
import { TaskApplicationService } from "./task-application-service.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { runtimeVersion } from "./runtime-version.js";
import { runsDirectory } from "./run-journal.js";
import { WorkbenchHttpServer, workbenchHealth, workbenchPortFromEnv } from "./workbench-http.js";

const config = loadConfig();
const store = new TaskStore(config.dbFile);
const client = new WorkBuddyClient(config);
const coordinator = new TaskCoordinator(config, store, client);
// The runs directory resolves exactly like the rest of the execution chain:
// WORKBUDDY_RUNS_DIR when set, otherwise the runs directory next to the task
// database. An empty fallback here would make the read paths resolve run
// records against the process working directory and silently misread them.
const service = new TaskApplicationService(coordinator, config.maxTaskAttempts ?? 3, runsDirectory(config));
const server = new WorkbenchHttpServer({
  service,
  health: () => workbenchHealth({
    runtime: { release: runtimeVersion.release, packageVersion: runtimeVersion.packageVersion, startedAt: runtimeVersion.startedAt },
  }),
});

const port = workbenchPortFromEnv();
try {
  const bound = await server.listen(port);
  console.log(JSON.stringify({ ok: true, event: "workbench_http_listening", port: bound, backend: config.backend, readOnly: true }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, event: "workbench_http_bind_failed", message: error instanceof Error ? error.message : String(error) }));
  store.close();
  process.exit(1);
}

process.once("SIGINT", () => { void server.close().then(() => { store.close(); process.exit(0); }); });
process.once("SIGTERM", () => { void server.close().then(() => { store.close(); process.exit(0); }); });
