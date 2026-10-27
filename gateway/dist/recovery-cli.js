import { createInterface } from "node:readline/promises";
import { loadDotEnv } from "./env.js";
import { loadConfig } from "./config.js";
import { TaskStore } from "./task-store.js";
import { TaskCoordinator } from "./coordinator.js";
import { TaskApplicationService } from "./task-application-service.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { configuredDshCoordinator } from "./dsh-runtime.js";
import { runsDirectory } from "./run-journal.js";
import { runRecoveryConsole } from "./recovery-console.js";
import { AdmissionError } from "./collaboration.js";
loadDotEnv();
const config = loadConfig(), store = new TaskStore(config.dbFile), runs = runsDirectory(config);
const service = new TaskApplicationService(new TaskCoordinator(config, store, new WorkBuddyClient(config)), config.maxTaskAttempts ?? 3, runs, configuredDshCoordinator(store, runs));
let terminal;
try {
    await runRecoveryConsole(service, process.argv.slice(2), { interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
        write(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); },
        async question(prompt) { terminal ??= createInterface({ input: process.stdin, output: process.stdout }); return terminal.question(prompt); } });
}
catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: error instanceof AdmissionError ? error.code : "RECOVERY_FAILED", message: error instanceof AdmissionError ? error.message : "Recovery failed; retain the original workflow and inspect local evidence." }) + "\n");
    process.exitCode = 1;
}
finally {
    terminal?.close();
    store.close();
}
//# sourceMappingURL=recovery-cli.js.map