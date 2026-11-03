#!/usr/bin/env node
// A desktop-owned, read-only composition root. No native worker, sync, quota
// collector, dispatch or model preparation is started by opening the window.
import fs from 'node:fs';
import { loadConfig } from '../dist/config.js';
import { TaskApplicationService } from '../dist/task-application-service.js';
import { openWorkbenchReadStore } from './workbench-read-store.mjs';
import { TaskStore } from '../dist/task-store.js';
import { readRunSnapshot } from '../dist/native-stop-declaration.js';
import { WorkbenchHttpServer, workbenchHealth } from '../dist/workbench-http.js';
import { runtimeVersion } from '../dist/runtime-version.js';
import { runsDirectory } from '../dist/run-journal.js';
import { loadDotEnv } from '../dist/env.js';
import { createDesktopDispatchSession, desktopJournal } from '../dist/desktop-dispatch-runtime.js';
import { createDesktopControlSession } from '../dist/desktop-control-runtime.js';
import { installDesktopCommands } from './workbench-desktop-commands.mjs';

loadDotEnv();
if (process.env.WORKBUDDY_WORKBENCH_DIAGNOSTICS === '1') console.error('[host] PATH=' + (process.env.PATH ?? '<unset>') + ' SystemRoot=' + (process.env.SystemRoot ?? '<unset>') + ' temp=' + (process.env.TEMP ?? '<unset>'));
const config = loadConfig();
// Never create an empty database because the launcher selected the wrong path.
if (!fs.statSync(config.dbFile).isFile()) throw new Error('The configured task database must exist.');
const store = openWorkbenchReadStore(config.dbFile, { dispatchFile: desktopJournal(config).file, runsDir: runsDirectory(config) });
const coordinator = Object.freeze({ store });
const service = new TaskApplicationService(coordinator, config.maxTaskAttempts ?? 3, runsDirectory(config));
const server = new WorkbenchHttpServer({ service, health: () => workbenchHealth({ runtime: runtimeVersion }) });
try {
    const port = await server.listen(0);
    console.log(JSON.stringify({ event: 'desktop_host_ready', port, readOnly: true, desktopCommands: true }));
} catch (error) { store.close(); throw error; }
let closing;
// Recovery evidence is read-only by construction: it reads saved records and
// returns them, and it never resolves, closes, re-dispatches or frees capacity.
const recovery = Object.freeze({ show: identity => store.operationEvidence(identity) });
// 待处理核对走同一个只读存储：给出一句原因所需的事实，不解决、不重派、不释放容量。
const attention = Object.freeze({ verify: taskId => store.taskEvidence(taskId) });
// A declaration is the only write this host performs, and it is created lazily:
// opening the window must still leave the database byte-identical. The record
// is a human assertion, never native evidence, and it moves no task state.
let declarationWriter;
const declarations = Object.freeze({
    declare(input) {
        declarationWriter ??= new TaskStore(config.dbFile);
        const task = declarationWriter.get(input.taskId);
        const snapshot = task ? readRunSnapshot(runsDirectory(config), task.attemptId) : null;
        return declarationWriter.stopDeclarations.declare({ ...input, snapshot });
    }
});
installDesktopCommands(createDesktopDispatchSession(config),process.stdin,process.stdout,createDesktopControlSession(config),recovery,attention,declarations);
const close = () => closing ??= server.close().finally(() => store.close()).then(() => process.exit(0));
// The desktop process owns stdin. A closed window or dead parent closes this
// pipe, including when no OS signal was delivered to the child process.
process.stdin.on('end', () => void close());
process.stdin.resume();
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
