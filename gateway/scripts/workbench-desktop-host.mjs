#!/usr/bin/env node
// A desktop-owned, read-only composition root. No native worker, sync, quota
// collector, dispatch or model preparation is started by opening the window.
// L06 writes only inside WORKBUDDY_CONFIG_DIR (templates, notification ledger,
// user-chosen export folder); the task database still changes only through a
// human stop declaration.
import fs from 'node:fs';
import { loadConfig } from '../dist/config.js';
import { TaskApplicationService } from '../dist/task-application-service.js';
import { openWorkbenchReadStore } from './workbench-read-store.mjs';
import { TaskStore } from '../dist/task-store.js';
import { readRunSnapshot } from '../dist/native-stop-declaration.js';
import { WorkbenchHttpServer, workbenchHealth } from '../dist/workbench-http.js';
import { runtimeVersion } from '../dist/runtime-version.js';
// The window is the place where "why is nothing dispatchable" gets asked, so the same
// read-only five-layer diagnosis the CLI prints has to answer here too. It only reads.
import { observeReadiness } from '../dist/readiness.js';
// The window polls this route; the probe pair is memoized so each answer does not
// spawn another MCP process. A probe that cannot answer says so, never "ready".
import { createReadinessProbes } from '../dist/readiness-probes.js';
import { runsDirectory } from '../dist/run-journal.js';
import { loadDotEnv } from '../dist/env.js';
import { createDesktopDispatchSession, desktopJournal } from '../dist/desktop-dispatch-runtime.js';
import { createDesktopControlSession } from '../dist/desktop-control-runtime.js';
import { installDesktopCommands } from './workbench-desktop-commands.mjs';
import { statisticsSources } from '../dist/statistics-http.js';
import { exportStatisticsFrom, openProductivityRuntime } from '../dist/productivity-runtime.js';
import { runProductivityCommand } from '../dist/desktop-productivity.js';

loadDotEnv();
if (process.env.WORKBUDDY_WORKBENCH_DIAGNOSTICS === '1') console.error('[host] PATH=' + (process.env.PATH ?? '<unset>') + ' SystemRoot=' + (process.env.SystemRoot ?? '<unset>') + ' temp=' + (process.env.TEMP ?? '<unset>'));
const config = loadConfig();
const readinessProbes = createReadinessProbes({ moduleUrl: import.meta.url });
// Never create an empty database because the launcher selected the wrong path.
// A first install legitimately has no database, so name the variable that chose
// this path and the one command that creates it, instead of failing with a bare
// stat error that the window can only render as "not connected".
const databasePath = config.dbFile;
let databasePresent = false;
try { databasePresent = fs.statSync(databasePath).isFile(); } catch { databasePresent = false; }
if (!databasePresent) {
    for (const line of [
        '[host] The configured task database does not exist yet:',
        '       ' + databasePath,
        '       WORKBUDDY_DB_FILE chooses this path (unset means <install>/data/tasks.sqlite).',
        '       On a first install, create it once from this folder:',
        '         node scripts/init-state.mjs',
        '       That helper refuses an existing file and creates nothing else.',
        '       If this is not the ledger you meant, point WORKBUDDY_DB_FILE at the real one.'
    ]) console.error(line);
    console.error(JSON.stringify({ event: 'desktop_host_blocked', reason: 'task_database_missing', databasePath, hint: 'node scripts/init-state.mjs' }));
    process.exit(2);
}
const store = openWorkbenchReadStore(config.dbFile, { dispatchFile: desktopJournal(config).file, runsDir: runsDirectory(config) });
const coordinator = Object.freeze({ store });
// R12: read-side dispatch-lease evidence from the same journal the read store
// already opened. The journal file may be absent; reads then return null.
const service = new TaskApplicationService(coordinator, config.maxTaskAttempts ?? 3, runsDirectory(config), undefined, taskId => desktopJournal(config).leaseByTask(taskId));
// L06: saved templates, the notification ledger and the export preview live in
// the config directory, not in the task database. Nothing here mutates task
// state; the only task write is still the stop declaration below.
const productivity = openProductivityRuntime({
    configDir: config.workbuddyConfigDir,
    store,
    // Desktop-only delivery: one line per notification on the same private pipe
    // the window already owns. The ledger, not this frame, is the record.
    deliver: notification => process.stdout.write(JSON.stringify({ event: 'desktop_notification', notification }) + '\n'),
    statistics: exportStatisticsFrom(statisticsSources(store)),
});
const server = new WorkbenchHttpServer({
    service,
    health: () => workbenchHealth({ runtime: runtimeVersion }),
    statistics: statisticsSources(store),
    productivity: productivity.sources,
    readiness: { observe: () => observeReadiness({ config, origin: 'scripts/workbench-desktop-host.mjs', probes: readinessProbes }) },
});
try {
    const port = await server.listen(0);
    console.log(JSON.stringify({ event: 'desktop_host_ready', port, readOnly: true, desktopCommands: true, productivity: true }));
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
const productivityCommands = Object.freeze({
    run: (method, parameters) => Promise.resolve(runProductivityCommand(productivity.commands, method, parameters)),
});
installDesktopCommands(createDesktopDispatchSession(config),process.stdin,process.stdout,createDesktopControlSession(config),recovery,attention,declarations,productivityCommands);
// Notification episodes are polled on a timer, never pushed by the page: the
// centre reads saved events, dedupes by event identity and throttles per reason.
// A failed poll leaves the ledger untouched and is retried on the next tick.
const pollNotifications = async () => {
    try { await productivity.sources.notifications.poll(); }
    catch { /* recorded as an issue by the next read; nothing is marked delivered */ }
};
void pollNotifications();
const notificationTimer = setInterval(() => { void pollNotifications(); }, 15_000);
notificationTimer.unref?.();
const close = () => closing ??= server.close().finally(() => { clearInterval(notificationTimer); store.close(); }).then(() => process.exit(0));
// The desktop process owns stdin. A closed window or dead parent closes this
// pipe, including when no OS signal was delivered to the child process.
process.stdin.on('end', () => void close());
process.stdin.resume();
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
