#!/usr/bin/env node
// A desktop-owned, read-only composition root. No native worker, sync, quota
// collector, dispatch or model preparation is started by opening the window.
import fs from 'node:fs';
import { loadConfig } from '../dist/config.js';
import { TaskApplicationService } from '../dist/task-application-service.js';
import { openWorkbenchReadStore } from './workbench-read-store.mjs';
import { WorkbenchHttpServer, workbenchHealth } from '../dist/workbench-http.js';
import { runtimeVersion } from '../dist/runtime-version.js';
import { runsDirectory } from '../dist/run-journal.js';
import { loadDotEnv } from '../dist/env.js';
import { createDesktopDispatchSession } from '../dist/desktop-dispatch-runtime.js';
import { installDesktopCommands } from './workbench-desktop-commands.mjs';

loadDotEnv();
const config = loadConfig();
// Never create an empty database because the launcher selected the wrong path.
if (!fs.statSync(config.dbFile).isFile()) throw new Error('The configured task database must exist.');
const store = openWorkbenchReadStore(config.dbFile);
const coordinator = Object.freeze({ store });
const service = new TaskApplicationService(coordinator, config.maxTaskAttempts ?? 3, runsDirectory(config));
const server = new WorkbenchHttpServer({ service, health: () => workbenchHealth({ runtime: runtimeVersion }) });
try {
    const port = await server.listen(0);
    console.log(JSON.stringify({ event: 'desktop_host_ready', port, readOnly: true, desktopCommands: true }));
} catch (error) { store.close(); throw error; }
let closing;
installDesktopCommands(createDesktopDispatchSession(config));
const close = () => closing ??= server.close().finally(() => store.close()).then(() => process.exit(0));
// The desktop process owns stdin. A closed window or dead parent closes this
// pipe, including when no OS signal was delivered to the child process.
process.stdin.on('end', () => void close());
process.stdin.resume();
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
