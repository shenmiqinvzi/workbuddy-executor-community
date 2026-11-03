// Crash evidence for the desktop dispatch lease.
//
// The journal is the only durable record that the native side was asked to
// start a task. If the process that claimed a request dies, the saved row must
// stay exactly as it was ("dispatching") and the uncertainty must be derived on
// read: never rewritten to a terminal state, never freed by releasing capacity.
//
// This test uses real processes: a child claims the request and heartbeats,
// then it is killed; the parent reads the row and the read-side settlement.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const gateway = path.resolve(here, '..', '..');
const Journal = (await import(pathToFileURL(path.join(gateway, 'dist', 'desktop-dispatch-journal.js')).href)).DesktopDispatchJournal;
const { openWorkbenchReadStore } = await import(pathToFileURL(path.join(gateway, 'scripts', 'workbench-read-store.mjs')).href);

const draft = (n) => ({
  draftId: `00000000-0000-4000-8000-00000000000${n}`,
  taskId: `00000000-0000-4000-8000-10000000000${n}`,
  operationId: `00000000-0000-4000-8000-20000000000${n}`,
  workspace: 'C:/lab/workspace',
  contract: { objective: 'synthetic', allowedChanges: ['a.txt'] },
});

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-crash-'));
}

function taskDatabase(root) {
  const file = path.join(root, 'tasks.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE task_operations (operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, body_json TEXT NOT NULL)');
  db.exec('CREATE TABLE workflow_capacity (slot INTEGER PRIMARY KEY, task_id TEXT NOT NULL, executor TEXT NOT NULL, operation_id TEXT NOT NULL)');
  db.close();
  return file;
}

function holdCapacity(file, operationId) {
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO workflow_capacity (slot,task_id,executor,operation_id) VALUES (1,?,?,?)').run('task-owner', 'workbuddy', operationId);
  db.close();
}

function recordOperation(file, operationId, taskId, kind, state) {
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO task_operations (operation_id,task_id,kind,state,body_json) VALUES (?,?,?,?,?)')
    .run(operationId, taskId, kind, state, JSON.stringify({ operationId, taskId, kind, state }));
  db.close();
}

function capacityRow(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT * FROM workflow_capacity WHERE slot=1').get() ?? null; } finally { db.close(); }
}

function startOwner(journalFile, requestId) {
  const script = path.join(path.dirname(journalFile), 'owner.mjs');
  fs.writeFileSync(script, [
    "import { DesktopDispatchJournal } from " + JSON.stringify(pathToFileURL(path.join(gateway, 'dist', 'desktop-dispatch-journal.js')).href) + ";",
    'const journal = new DesktopDispatchJournal(' + JSON.stringify(journalFile) + ');',
    'const owner = { pid: process.pid, startedAt: new Date().toISOString() };',
    'const draft = journal.claim(' + JSON.stringify(requestId) + ', owner);',
    "if (!draft) { console.log('CLAIM_FAILED'); process.exit(2); }",
    "console.log('CLAIMED ' + process.pid);",
    'setInterval(() => { journal.heartbeat(' + JSON.stringify(requestId) + ', owner); }, 4000);',
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('owner did not claim in time')), 20000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.includes('CLAIMED')) { clearTimeout(timer); resolve(child); }
      if (buffer.includes('CLAIM_FAILED')) { clearTimeout(timer); reject(new Error('claim failed')); }
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function killAndWait(child) {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

test('a killed dispatch owner stays dispatching and is reported as abandoned, never rewritten or released', async () => {
  const root = tempRoot();
  const journalFile = path.join(root, 'dispatch', 'requests.sqlite');
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const journal = new Journal(journalFile);
  const request = draft(1);
  journal.enqueue(request);

  const child = await startOwner(journalFile, request.draftId);
  const claimed = journal.lease(request.draftId);
  assert.equal(claimed.state, 'dispatching');
  assert.equal(claimed.ownerPid, child.pid);
  assert.ok(claimed.claimedAt);
  assert.ok(claimed.heartbeatAt);

  await killAndWait(child);

  const tasks = taskDatabase(root);
  holdCapacity(tasks, request.operationId);
  const capacityBefore = capacityRow(tasks);
  const rowBefore = journal.lease(request.draftId);

  const store = openWorkbenchReadStore(tasks, { dispatchFile: journalFile });
  const evidence = store.operationEvidence(request.draftId);
  store.close();

  assert.equal(evidence.available, true);
  // The request was accepted and its owner died, so the effect is not excludable:
  // this is more than "there is only a dispatch record".
  assert.equal(evidence.conclusion, 'outcome_unsettled');
  assert.equal(evidence.dispatch.settlement, 'abandoned');
  assert.equal(evidence.dispatch.settlementReason, 'owner_exited');
  assert.equal(evidence.dispatch.ownerAlive, false);
  assert.equal(evidence.dispatch.state, 'dispatching');

  const rowAfter = journal.lease(request.draftId);
  assert.deepEqual(rowAfter, rowBefore, 'reading settlement must not rewrite the journal row');
  assert.equal(rowAfter.state, 'dispatching', 'a dead owner is not a terminal state on disk');
  assert.deepEqual(capacityRow(tasks), capacityBefore, 'settlement must not release execution capacity');
});

test('a live owner with an expired heartbeat is stuck, not live', async () => {
  const root = tempRoot();
  const journalFile = path.join(root, 'dispatch', 'requests.sqlite');
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const journal = new Journal(journalFile);
  const request = draft(2);
  journal.enqueue(request);
  journal.claim(request.draftId, { pid: process.pid, startedAt: new Date().toISOString() });

  const stale = new Date(Date.now() - 200_000).toISOString();
  const raw = new DatabaseSync(journalFile);
  raw.prepare('UPDATE desktop_dispatch_requests SET heartbeat_at=? WHERE request_id=?').run(stale, request.draftId);
  raw.close();

  const store = openWorkbenchReadStore(taskDatabase(root), { dispatchFile: journalFile });
  const evidence = store.operationEvidence(request.operationId);
  store.close();

  assert.equal(evidence.dispatch.settlement, 'stuck');
  assert.equal(evidence.dispatch.settlementReason, 'heartbeat_expired');
  assert.equal(evidence.dispatch.ownerAlive, true);
  assert.ok(evidence.dispatch.heartbeatAgeMs > 180_000);
});

test('a pending request without a lease record is lease_unavailable, not live', async () => {
  const root = tempRoot();
  const journalFile = path.join(root, 'dispatch', 'requests.sqlite');
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const journal = new Journal(journalFile);
  const request = draft(3);
  journal.enqueue(request);

  const store = openWorkbenchReadStore(taskDatabase(root), { dispatchFile: journalFile });
  const evidence = store.operationEvidence(request.draftId);
  store.close();

  assert.equal(evidence.dispatch.settlement, 'lease_unavailable');
  assert.equal(evidence.dispatch.settlementReason, 'no_lease_record');
  assert.equal(evidence.conclusion, 'dispatch_only');
  assert.equal(evidence.dispatch.ownerAlive, null);
});

test('without the dispatch journal the recovery evidence says so instead of pretending', async () => {
  const root = tempRoot();
  const store = openWorkbenchReadStore(taskDatabase(root));
  const evidence = store.operationEvidence('op-nothing');
  store.close();
  assert.equal(evidence.available, false);
  assert.equal(evidence.reason, 'unknown_identity');
});

// A saved operation row saying "effect_started" is not evidence of progress on its
// own: if the process that owned the dispatch is gone, the effect cannot be excluded
// and the read side must not call the operation active.
test('a dead lease owner is never reported as an active operation', async () => {
  const root = tempRoot();
  const journalFile = path.join(root, 'dispatch', 'requests.sqlite');
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const journal = new Journal(journalFile);
  const request = draft(4);
  journal.enqueue(request);
  const child = await startOwner(journalFile, request.draftId);
  await killAndWait(child);

  const tasks = taskDatabase(root);
  recordOperation(tasks, request.operationId, request.taskId, 'send', 'effect_started');
  const store = openWorkbenchReadStore(tasks, { dispatchFile: journalFile });
  const evidence = store.operationEvidence(request.operationId);
  store.close();

  assert.equal(evidence.state, 'effect_started');
  assert.equal(evidence.dispatch.settlement, 'abandoned');
  assert.equal(evidence.conclusion, 'outcome_unsettled');
});

test('a live lease keeps the operation active', async () => {
  const root = tempRoot();
  const journalFile = path.join(root, 'dispatch', 'requests.sqlite');
  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const journal = new Journal(journalFile);
  const request = draft(5);
  journal.enqueue(request);
  journal.claim(request.draftId, { pid: process.pid, startedAt: new Date().toISOString() });

  const tasks = taskDatabase(root);
  recordOperation(tasks, request.operationId, request.taskId, 'send', 'effect_started');
  const store = openWorkbenchReadStore(tasks, { dispatchFile: journalFile });
  const evidence = store.operationEvidence(request.operationId);
  store.close();

  assert.equal(evidence.dispatch.settlement, 'live');
  assert.equal(evidence.conclusion, 'active');
});
