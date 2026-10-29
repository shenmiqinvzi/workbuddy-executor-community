import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { TaskStore } from '../dist/task-store.js';
import { operationDigest } from '../dist/operation-admission.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A narrow query facade over a genuinely read-only SQLite connection. Reuse
 * the existing public pure-query implementations, never their migrating store
 * constructor or any native/execution object. SQLite rejects unexpected writes.
 */
export function openWorkbenchReadStore(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    const has = name => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
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
    for (const name of ['get', 'getContract', 'listAttempts', 'listTasksByCreatedCursor', 'hasTaskAfterCursor', 'listTaskEvents'])
        store[name] = (...args) => TaskStore.prototype[name].apply(context, args);
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
    return Object.freeze(store);
}
