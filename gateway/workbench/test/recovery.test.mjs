import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { openWorkbenchReadStore } from '../../scripts/workbench-read-store.mjs';
import { desktopCommandHandler } from '../../scripts/workbench-desktop-commands.mjs';

const OPERATION = 'desktop-send-11111111-2222-3333-4444-555555555555';
const REQUEST = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function fixture({ state = 'outcome_unknown', dispatchState = 'dispatching', capacity = true, body } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-recovery-')), file = path.join(dir, 'tasks.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE task_operations (operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, body_json TEXT NOT NULL);
        CREATE TABLE desktop_dispatch_requests (request_id TEXT PRIMARY KEY, task_id TEXT UNIQUE NOT NULL, operation_id TEXT UNIQUE NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, code TEXT, message TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE workflow_capacity (slot INTEGER PRIMARY KEY CHECK(slot=1), task_id TEXT NOT NULL, executor TEXT NOT NULL, operation_id TEXT NOT NULL);`);
    const record = body ?? { operationId: OPERATION, taskId: 'task', kind: 'send', state, createdAt: '2026-11-01T01:00:00.000Z', updatedAt: '2026-11-01T01:05:00.000Z', preparationEnteredAt: '2026-11-01T01:01:00.000Z', error: { code: 'OUTCOME_UNKNOWN', message: 'The original outcome is not settled.' } };
    db.prepare('INSERT INTO task_operations VALUES (?,?,?,?,?)').run(OPERATION, 'task', 'send', state, JSON.stringify(record));
    db.prepare('INSERT INTO desktop_dispatch_requests VALUES (?,?,?,?,?,?,?,?,?)').run(REQUEST, 'task', OPERATION, 'a'.repeat(64), '{}', dispatchState, null, null, '2026-11-01T01:06:00.000Z');
    if (capacity) db.prepare('INSERT INTO workflow_capacity VALUES (1,?,?,?)').run('task', 'workbuddy', OPERATION);
    db.close();
    return { dir, file };
}

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const withStore = (file, run) => { const store = openWorkbenchReadStore(file); try { return run(store); } finally { store.close(); } };

test('recovery evidence reports what the saved records prove and nothing more', () => {
    const { dir, file } = fixture();
    const before = hash(file);
    try {
        withStore(file, store => {
            const evidence = store.operationEvidence(OPERATION);
            assert.equal(evidence.available, true);
            assert.equal(evidence.operationId, OPERATION);
            assert.equal(evidence.state, 'outcome_unknown');
            assert.equal(evidence.integrity, 'verified');
            assert.equal(evidence.conclusion, 'outcome_unsettled');
            assert.equal(evidence.preparationEnteredAt, '2026-11-01T01:01:00.000Z');
            assert.equal(evidence.dispatchEnteredAt, null);
            assert.equal(evidence.attemptId, null);
            assert.equal(evidence.dispatch.requestId, REQUEST);
            assert.equal(evidence.dispatch.state, 'dispatching');
            assert.equal(evidence.capacityHoldsOperation, true);
            assert.equal(evidence.capacityTaskId, 'task');
        });
        assert.equal(hash(file), before);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an original dispatch request identity resolves to the same operation evidence', () => {
    const { dir, file } = fixture();
    try {
        withStore(file, store => {
            const byRequest = store.operationEvidence(REQUEST), byOperation = store.operationEvidence(OPERATION);
            assert.equal(byRequest.operationId, byOperation.operationId);
            assert.equal(byRequest.dispatch.requestId, REQUEST);
            assert.equal(byRequest.state, 'outcome_unknown');
        });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an identity with no saved record is reported as unknown, never guessed', () => {
    const { dir, file } = fixture();
    try {
        withStore(file, store => {
            const evidence = store.operationEvidence('desktop-send-not-saved');
            assert.equal(evidence.available, false);
            assert.equal(evidence.reason, 'unknown_identity');
            assert.equal(evidence.operationId, null);
            assert.equal(evidence.state, undefined);
            assert.throws(() => store.operationEvidence(''), /identity/);
            assert.throws(() => store.operationEvidence('x'.repeat(201)), /identity/);
            assert.throws(() => store.operationEvidence('bad\u0000identity'), /identity/);
        });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stored evidence that disagrees with its columns is surfaced as a mismatch', () => {
    const { dir, file } = fixture({ body: { operationId: OPERATION, taskId: 'task', kind: 'send', state: 'succeeded' } });
    try {
        withStore(file, store => {
            const evidence = store.operationEvidence(OPERATION);
            assert.equal(evidence.integrity, 'mismatch');
            assert.equal(evidence.state, 'outcome_unknown');
            assert.equal(evidence.settled, false);
        });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the desktop host answers recovery evidence over its own private channel', async () => {
    const { dir, file } = fixture();
    const before = hash(file);
    const gateway = path.resolve(import.meta.dirname, '..', '..');
    const child = spawn(process.execPath, ['scripts/workbench-desktop-host.mjs'], {
        cwd: gateway, env: { ...process.env, WORKBUDDY_DB_FILE: file, WORKBUDDY_CLI_ELECTRON: path.join(dir, 'WorkBuddy.exe'), WORKBUDDY_CONFIG_DIR: path.join(dir, 'config') }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = [], waiters = [];
    let error = '';
    const exited = new Promise(resolve => child.once('exit', () => resolve()));
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        for (const line of chunk.split('\n')) {
            if (!line.trim()) continue;
            const value = JSON.parse(line); lines.push(value);
            for (const waiter of [...waiters]) if (waiter.match(value)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); }
        }
    });
    const next = match => new Promise((resolve, reject) => {
        const hit = lines.find(match); if (hit) return resolve(hit);
        const timer = setTimeout(() => reject(new Error('Timed out waiting for the desktop host. ' + error)), 20000);
        waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
    try {
        const ready = await next(value => value.event === 'desktop_host_ready');
        assert.equal(ready.readOnly, true);
        assert.equal(ready.desktopCommands, true);
        const id = crypto.randomUUID();
        child.stdin.write(JSON.stringify({ id, method: 'recovery_show', parameters: { identity: REQUEST } }) + '\n');
        const reply = await next(value => value.event === 'desktop_command_result' && value.id === id);
        assert.equal(reply.ok, true, error);
        assert.equal(reply.value.available, true);
        assert.equal(reply.value.operationId, OPERATION);
        assert.equal(reply.value.state, 'outcome_unknown');
        assert.equal(reply.value.conclusion, 'outcome_unsettled');
        assert.equal(reply.value.dispatch.requestId, REQUEST);
        assert.equal(hash(file), before);
    } finally {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the desktop channel answers recovery evidence read-only and rejects extra parameters', async () => {
    const seen = [];
    const handle = desktopCommandHandler({}, null, { show: identity => { seen.push(identity); return { available: true, operationId: identity }; } });
    const value = await handle('recovery_show', { identity: OPERATION });
    assert.equal(value.operationId, OPERATION);
    assert.deepEqual(seen, [OPERATION]);
    await assert.rejects(() => handle('recovery_show', { identity: OPERATION, force: true }), /请求字段/);
    await assert.rejects(() => handle('recovery_show', { identity: 42 }), /Invalid operation identity/);
    await assert.rejects(() => handle('recovery_show', { identity: '' }), /Invalid operation identity/);
    const withoutRecovery = desktopCommandHandler({}, null);
    await assert.rejects(() => withoutRecovery('recovery_show', { identity: OPERATION }), /Unsupported desktop command/);
});
