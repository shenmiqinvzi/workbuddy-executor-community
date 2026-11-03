import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TaskStore } from '../dist/task-store.js';
import { operationDigest } from '../dist/operation-admission.js';
import { settleDispatch } from '../dist/dispatch-settlement.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Liveness is evidence, not permission: a dead owner never revives a row and
 * a live pid still has to show a fresh heartbeat. */
function aliveCheck(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === 'ESRCH' ? false : null; } }
function text(value) { return value == null ? null : String(value); }
function describeDispatch(row) {
    if (!row) return null;
    const lease = settleDispatch({
        state: String(row.state), ownerPid: row.owner_pid == null ? null : Number(row.owner_pid),
        ownerStartedAt: text(row.owner_started_at), claimedAt: text(row.claimed_at), heartbeatAt: text(row.heartbeat_at),
    }, { now: Date.now(), alive: aliveCheck });
    return { requestId: String(row.request_id), state: String(row.state), code: text(row.code), message: text(row.message), updatedAt: String(row.updated_at), settlement: lease.settlement, settlementReason: lease.reason, heartbeatAgeMs: lease.heartbeatAgeMs, ownerAlive: lease.ownerAlive };
}
/** A narrow query facade over a genuinely read-only SQLite connection. Reuse
 * the existing public pure-query implementations, never their migrating store
 * constructor or any native/execution object. SQLite rejects unexpected writes.
 */
export function openWorkbenchReadStore(file, options = {}) {
    const db = new DatabaseSync(file, { readOnly: true });
    const has = name => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
    /** The dispatch journal is a separate SQLite file, one per gateway/database
     * pair. Opening it read-only keeps the lease evidence next to the operation
     * it belongs to, without migrating or writing either database. */
    function journalRow(identity) {
        const journalFile = typeof options.dispatchFile === 'string' ? options.dispatchFile : null;
        if (!journalFile || !fs.existsSync(journalFile)) return undefined;
        let journal;
        try { journal = new DatabaseSync(journalFile, { readOnly: true }); } catch { return undefined; }
        try {
            return journal.prepare('SELECT * FROM desktop_dispatch_requests WHERE request_id=?').get(identity)
                ?? journal.prepare('SELECT * FROM desktop_dispatch_requests WHERE operation_id=?').get(identity);
        } catch { return undefined; } finally { journal.close(); }
    }
    const context = { db, collaboration: {
        getTaskAdmission(taskId) {
            if (!has('task_admissions')) return null;
            const row = db.prepare('SELECT body_json,digest FROM task_admissions WHERE task_id=?').get(taskId);
            if (!row) return null;
            const value = JSON.parse(row.body_json);
            if (digest(value) !== row.digest) throw new Error('Stored admission integrity failure.');
            return value;
        },
    } };
    const store = { file, close: () => db.close() };
    for (const name of ['get', 'listAttempts', 'listTasksByCreatedCursor', 'hasTaskAfterCursor', 'listTaskEvents'])
        store[name] = (...args) => TaskStore.prototype[name].apply(context, args);
    store.getContract = taskId => {
        if (has('task_contracts')) return TaskStore.prototype.getContract.call(context, taskId);
        // Pre-contract deployments have neither contract dispatch nor view
        // revision columns. Missing storage in a newer schema remains a read
        // failure; it must never silently erase a persisted agreement.
        const columns = new Set(db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name));
        if (columns.has('revision') || columns.has('contract_dispatch')) throw new Error('Contract storage is missing from a newer task schema.');
        return { state: 'absent' };
    };
    store.reviews = { list(taskId) {
        if (!has('task_review_records')) return [];
        return db.prepare("SELECT digest,body FROM task_review_records WHERE task_id=? AND kind='review' ORDER BY rowid").all(taskId).map(row => {
            const value = JSON.parse(row.body);
            if (operationDigest(value) !== row.digest) throw new Error('Stored review integrity failure.');
            return value;
        });
    } };
    store.workspaceProtection = { readView(taskId, attemptId) {
        const empty = baseline => ({ scope: null, version: 'workspace-scope/1', baseline, mode: null, baselineDigest: null, protectedCount: null, coverage: 'workspace_inventory', excludedPaths: [], check: null, changeCount: null, changesTruncated: false });
        try {
            if (!has('workspace_scope_baselines')) return empty('missing');
            const row = db.prepare('SELECT digest,body FROM workspace_scope_baselines WHERE task_id=?').get(taskId);
            if (!row) return empty('missing');
            const value = JSON.parse(row.body), task = db.prepare('SELECT submission_hash FROM tasks WHERE task_id=?').get(taskId);
            if (digest(value) !== row.digest || value.taskId !== taskId || value.version !== 'workspace-scope/1' || task?.submission_hash && task.submission_hash !== value.bindingHash) return empty('integrity_failure');
            const checkRow = attemptId ? db.prepare('SELECT digest,body FROM workspace_scope_checks WHERE task_id=? AND attempt_id=? ORDER BY check_id DESC LIMIT 1').get(taskId, attemptId) : null;
            const check = checkRow ? JSON.parse(checkRow.body) : null;
            if (check && (digest(check) !== checkRow.digest || check.taskId !== taskId || check.attemptId !== attemptId || check.baselineDigest !== row.digest)) return empty('integrity_failure');
            return { scope: value.scope, version: 'workspace-scope/1', baseline: 'present', mode: value.mode, baselineDigest: row.digest, protectedCount: value.protectedPaths.length, coverage: 'workspace_inventory', excludedPaths: ['.git', 'node_modules (unless explicitly inventoried)', ...value.excludedPaths], check: check ? { ...check, changes: check.changes.slice(0,100) } : null, changeCount: check?.changes.length ?? null, changesTruncated: (check?.changes.length ?? 0) > 100 };
        } catch { return empty('integrity_failure'); }
    } };
    /** Read-only evidence about one original operation, for the desktop channel.
     * It answers what the saved records prove about an operation whose outcome
     * is unknown. It never resolves, closes, re-dispatches or releases capacity.
     */
    store.operationEvidence = identity => {
        if (typeof identity !== 'string' || identity.length < 1 || identity.length > 200 || /[\u0000-\u001f]/.test(identity)) throw new Error('An operation or dispatch identity of 1-200 printable characters is required.');
        const dispatchRow = has('desktop_dispatch_requests')
            ? db.prepare('SELECT * FROM desktop_dispatch_requests WHERE request_id=?').get(identity) ?? db.prepare('SELECT * FROM desktop_dispatch_requests WHERE operation_id=?').get(identity)
            : journalRow(identity);
        if (!has('task_operations')) return { available: false, reason: 'no_operation_storage', identity, operationId: null, taskId: dispatchRow ? String(dispatchRow.task_id) : null };
        const operationRow = db.prepare('SELECT * FROM task_operations WHERE operation_id=?').get(identity)
            ?? (dispatchRow ? db.prepare('SELECT * FROM task_operations WHERE operation_id=?').get(String(dispatchRow.operation_id)) : undefined);
        if (!operationRow && !dispatchRow) return { available: false, reason: 'unknown_identity', identity, operationId: null, taskId: null };
        let record = null, integrity = 'unreadable';
        if (operationRow) {
            try {
                record = JSON.parse(String(operationRow.body_json));
                const agrees = record && typeof record === 'object' && record.operationId === String(operationRow.operation_id)
                    && record.taskId === String(operationRow.task_id) && record.kind === String(operationRow.kind) && record.state === String(operationRow.state);
                integrity = agrees ? 'verified' : 'mismatch';
            } catch { integrity = 'unreadable'; }
        }
        const operationId = operationRow ? String(operationRow.operation_id) : String(dispatchRow.operation_id);
        const state = operationRow ? String(operationRow.state) : null;
        const capacity = has('workflow_capacity') ? db.prepare('SELECT * FROM workflow_capacity WHERE slot=1').get() : undefined;
        const dispatch = describeDispatch(dispatchRow);
        // A lease owner that died or went silent cannot be described as active. The
        // request was accepted, so its effect is not excludable until a human reconciles it.
        const dispatchLost = Boolean(dispatch && (dispatch.settlement === 'abandoned' || dispatch.settlement === 'stuck'));
        // Evidence that cannot be read, or a started effect with no dispatch record,
        // is not evidence of an operation that is still running: say unsettled instead.
        const evidenceMissing = integrity !== 'verified';
        const dispatchUnrecorded = state === 'effect_started' && !dispatch;
        return {
            available: true,
            identity,
            operationId,
            taskId: String(operationRow ? operationRow.task_id : dispatchRow.task_id),
            kind: operationRow ? String(operationRow.kind) : null,
            state,
            integrity,
            preparationEnteredAt: record?.preparationEnteredAt ?? null,
            dispatchEnteredAt: record?.dispatchEnteredAt ?? null,
            attemptId: record?.attemptId ?? null,
            createdAt: record?.createdAt ?? null,
            updatedAt: record?.updatedAt ?? null,
            error: record?.error ?? null,
            settled: Boolean(record && (record.result !== undefined || record.error !== undefined)),
            conclusion: state === 'outcome_unknown' ? 'outcome_unsettled' : state === 'succeeded' ? 'succeeded' : state === 'rejected' ? 'rejected' : dispatchLost || dispatchUnrecorded ? 'outcome_unsettled' : state && evidenceMissing ? 'outcome_unsettled' : state ? 'active' : 'dispatch_only',
            dispatch,
            capacityHoldsOperation: Boolean(capacity && String(capacity.operation_id) === operationId),
            capacityTaskId: capacity ? String(capacity.task_id) : null,
        };
    };
    /** The stop proof lives in the run journal, not in the ledger. Reading it is
     * the only way to tell "报告已到" from "报告已到且原生停了". */
    const runsDir = typeof options.runsDir === 'string' ? options.runsDir : null;
    function runSnapshot(attemptId) {
        if (!runsDir || typeof attemptId !== 'string' || !/^run-[a-f0-9-]{36}$/.test(attemptId)) return null;
        try {
            const file = path.join(runsDir, attemptId, 'state.json');
            if (!fs.existsSync(file)) return null;
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch { return null; }
    }
    /** One task's current evidence, for the 待处理 card. Same rules as
     * operationEvidence: read-only, derived, and it never resolves anything. */
    store.taskEvidence = taskId => {
        if (typeof taskId !== 'string' || taskId.length < 1 || taskId.length > 200 || /[\u0000-\u001f]/.test(taskId)) throw new Error('A task identity of 1-200 printable characters is required.');
        if (!has('tasks')) return { available: false, reason: 'no_task_storage', taskId };
        const task = db.prepare('SELECT task_id,state,attempt_id,report_json,reviewed_at,blocking_reason,updated_at FROM tasks WHERE task_id=?').get(taskId);
        if (!task) return { available: false, reason: 'unknown_task', taskId };
        const operationRow = has('task_operations') ? db.prepare("SELECT * FROM task_operations WHERE task_id=? AND kind='send' ORDER BY rowid DESC LIMIT 1").get(taskId) : null;
        const operationId = operationRow ? String(operationRow.operation_id) : null;
        const evidence = operationId ? store.operationEvidence(operationId) : null;
        const snapshot = runSnapshot(task.attempt_id);
        const capacity = has('workflow_capacity') ? db.prepare('SELECT * FROM workflow_capacity WHERE slot=1').get() : undefined;
        let declaration = null;
        if (has('native_stop_declarations')) {
            try {
                const row = db.prepare('SELECT body_json FROM native_stop_declarations WHERE task_id=? AND attempt_id=?').get(taskId, String(task.attempt_id));
                const value = row ? JSON.parse(String(row.body_json)) : null;
                if (value) declaration = { declarationId: value.declarationId, actor: value.actor, declaredAt: value.declaredAt, statement: value.statement, source: 'human_declaration' };
            } catch { declaration = null; }
        }
        return {
            available: true,
            taskId,
            task: {
                state: String(task.state),
                attemptId: text(task.attempt_id),
                reportPresent: Boolean(task.report_json && String(task.report_json).trim() && String(task.report_json).trim() !== 'null'),
                reviewedAt: text(task.reviewed_at),
                blockingReason: text(task.blocking_reason),
                updatedAt: String(task.updated_at),
            },
            operationId,
            operationState: operationRow ? String(operationRow.state) : null,
            conclusion: evidence ? evidence.conclusion : null,
            dispatch: evidence ? evidence.dispatch : null,
            stop: {
                available: Boolean(snapshot),
                status: snapshot?.status ?? null,
                nativeStoppedAt: snapshot?.nativeStoppedAt ?? null,
                stopReason: snapshot?.stopReason ?? null,
                reportDigest: snapshot?.reportDigest ?? null,
                updatedAt: snapshot?.updatedAt ?? null,
            },
            capacityHeld: Boolean(capacity && String(capacity.task_id) === taskId),
            capacityTaskId: capacity ? String(capacity.task_id) : null,
            declaration,
        };
    };
    return Object.freeze(store);
}
