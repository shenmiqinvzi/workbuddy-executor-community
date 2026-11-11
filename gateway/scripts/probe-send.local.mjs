import { loadConfig } from "../dist/config.js";
import { loadDotEnv } from "../dist/env.js";
import { TaskStore } from "../dist/task-store.js";
import { WorkBuddyClient } from "../dist/workbuddy-client.js";
import { TaskCoordinator } from "../dist/coordinator.js";
import { TaskApplicationService } from "../dist/task-application-service.js";
import { runsDirectory } from "../dist/run-journal.js";

loadDotEnv();
const config = loadConfig();
const store = new TaskStore(config.dbFile);
const client = new WorkBuddyClient(config);
const coordinator = new TaskCoordinator(config, store, client);
const tasks = new TaskApplicationService(coordinator, config.maxTaskAttempts ?? 3, runsDirectory(config));

import fs from "node:fs";
const arg = process.argv[2];
const input = JSON.parse(arg.startsWith("@") ? fs.readFileSync(arg.slice(1), "utf8") : arg);
try {
  const result = await tasks.send(input);
  console.log("SEND_OK", JSON.stringify(result).slice(0, 600));
} catch (error) {
  console.log("SEND_FAILED code=", error?.code, "name=", error?.name, "message=", String(error?.message));
  console.log((error?.stack ?? "").split("\n").slice(0, 14).join("\n"));
} finally {
  store.close?.();
}
