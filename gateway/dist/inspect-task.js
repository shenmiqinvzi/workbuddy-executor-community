import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.js';
import { loadDotEnv } from './env.js';
import { rowToTask } from './task-store.js';
import { RunJournal, runsDirectory, hasNativeStopEvidence } from './run-journal.js';
import { resultForDetail } from './brief-result.js';
/** Offline diagnostic snapshot. No constructors that create/migrate stores,
 * no permissions changes, native RPC, task claims, or worker result submission. */
export function inspectTask(config, taskId) {
    if (!taskId.trim())
        throw Error('taskId is required');
    const db = new DatabaseSync(config.dbFile, { readOnly: true });
    try {
        const row = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
        if (!row)
            throw Error(`Unknown task_id: ${taskId}`);
        const task = rowToTask(row);
        const journal = task.attemptId ? new RunJournal(runsDirectory(config), task.attemptId) : undefined;
        const snapshot = journal?.snapshot();
        const messages = db.prepare('SELECT raw_json FROM (SELECT rowid AS n, raw_json FROM messages WHERE task_id = ? AND attempt_id = ? ORDER BY rowid DESC LIMIT 3) ORDER BY n')
            .all(taskId, task.attemptId ?? '').map(row => JSON.parse(String(row.raw_json)));
        const resultFile = journal ? path.join(journal.dir, 'worker-result.json') : undefined;
        let workerResult = { present: false, authenticated: false };
        if (resultFile && fs.existsSync(resultFile)) {
            const stat = fs.lstatSync(resultFile);
            workerResult = { present: true, authenticated: false, file: resultFile, bytes: stat.size };
            if (stat.isFile() && stat.size <= 64 * 1024) {
                try {
                    const value = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, ''));
                    workerResult.status = typeof value?.status === 'string' ? value.status : undefined;
                    if (typeof value?.text === 'string' && Array.isArray(value.artifacts)) {
                        const digest = crypto.createHash('sha256').update(JSON.stringify([value.status, value.text, value.artifacts])).digest('hex');
                        workerResult.authenticated = digest === snapshot?.reportDigest;
                    }
                }
                catch { /* A file being written is not an authenticated report. */ }
            }
        }
        const stopped = hasNativeStopEvidence(snapshot);
        return {
            ok: true, readOnly: true, snapshotOnly: true, checkedAt: new Date().toISOString(), task, messages,
            execution: {
                state: stopped ? 'stopped' : journal?.cancellationRequested() ? 'stop_unconfirmed' : snapshot?.status ?? 'unknown',
                remoteStopped: stopped, observedAt: snapshot?.nativeStoppedAt ?? snapshot?.updatedAt,
                cancellationRequested: journal?.cancellationRequested() ?? false,
                deadline: snapshot?.deadline, claimDeadline: snapshot?.claimDeadline,
            },
            workerResult,
            next: 'This is saved state, not a fresh native observation. An unauthenticated result file is evidence to inspect, not completion. Resume the same task through the normal MCP connection; do not redispatch.',
        };
    }
    finally {
        db.close();
    }
}
export function runInspect(argument) {
    try {
        if (!argument)
            throw Error('Usage: workbuddy-inspect.mjs @arguments.json (taskId, optional detail)');
        const input = JSON.parse(argument.startsWith('@') ? fs.readFileSync(argument.slice(1), 'utf8').replace(/^\uFEFF/, '') : argument);
        if (typeof input.taskId !== 'string')
            throw Error('taskId must be a string');
        if (input.detail !== undefined && !['brief', 'full'].includes(input.detail))
            throw Error('detail must be brief or full');
        loadDotEnv();
        console.log(JSON.stringify(resultForDetail(inspectTask(loadConfig(), input.taskId), input.detail ?? 'brief'), null, 2));
    }
    catch (error) {
        console.log(JSON.stringify({ ok: false, readOnly: true, error: error instanceof Error ? error.message : String(error) }));
        process.exitCode = 1;
    }
}
//# sourceMappingURL=inspect-task.js.map