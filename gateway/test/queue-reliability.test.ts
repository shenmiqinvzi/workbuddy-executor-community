import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, type Config } from '../src/config.js';
import { DesktopQueue } from '../src/desktop-queue.js';
import { TaskStore } from '../src/task-store.js';
import { WorkBuddyClient } from '../src/workbuddy-client.js';
import { TaskCoordinator } from '../src/coordinator.js';
import { RunJournal, hasNativeStopEvidence } from '../src/run-journal.js';
import { WorkspaceWorkers } from '../src/workspace-workers.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-reliability-'));
  const config: Config = { ...loadConfig(), backend: 'desktop-queue', dbFile: path.join(dir, 'tasks.sqlite'), workbuddyConfigDir: dir, runsDir: path.join(dir, 'runs') };
  const native = new DatabaseSync(path.join(dir, 'workbuddy.db'));
  native.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, is_playground INTEGER, deleted_at INTEGER)');
  native.prepare('INSERT INTO sessions VALUES (?, ?, 1, NULL)').run('session', dir);
  native.close();
  const store = new TaskStore(config.dbFile);
  const coordinator = new TaskCoordinator(config, store, new WorkBuddyClient(config));
  const queue = new DesktopQueue(config, () => ({ desktopPid: process.pid }));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, store, coordinator, queue };
}

async function claimTask(t: { after: (fn: () => void) => void }) {
  const f = fixture(t);
  await f.coordinator.send({ taskId: 'task', objective: 'reliability fixture', workspace: f.dir, sessionId: 'session', timeoutSeconds: 120 });
  const claim = await f.queue.claim('session', 0);
  if (claim.status !== 'task') throw Error('Expected claim');
  return { ...f, claim, journal: new RunJournal(f.queue.root, claim.attemptId) };
}

test('reading a live task never competes for its write lock before the deadline', async t => {
  const f = await claimTask(t);
  const lock = path.join(f.journal.dir, 'queue-write.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  try {
    const task = await f.coordinator.sync('task');
    assert.equal(task.state, 'working');
    assert.equal(fs.existsSync(lock), true);
    assert.equal(f.journal.cancellationRequested(), false);
  } finally { fs.unlinkSync(lock); }
});

test('a real report survives a brief write lock held by another process', async t => {
  const f = await claimTask(t);
  const lock = path.join(f.journal.dir, 'queue-write.lock');
  const code = `const fs=require('fs');const file=process.argv[1];fs.writeFileSync(file,JSON.stringify({pid:process.pid}));process.stdout.write('ready');setTimeout(()=>{fs.unlinkSync(file);},250);`;
  const child = spawn(process.execPath, ['-e', code, lock], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await once(child.stdout!, 'data');
  const result = f.queue.report({ ...f.claim, status: 'completed', text: 'Real report after contention', artifacts: [] });
  assert.equal(result.status, 'needs_review');
  assert.equal(f.journal.snapshot()?.text, 'Real report after contention');
  assert.equal(f.coordinator.executionStatus('task').remoteStopped, false);
});

test('Windows report retries a retiring lock without stealing it', {skip: process.platform !== 'win32'}, async t => {
  const f = await claimTask(t);
  const lock = path.join(f.journal.dir, 'queue-write.lock');
  const original = fs.openSync.bind(fs);
  let attempts = 0;
  const mocked = t.mock.method(fs, 'openSync', (...args: any[]) => {
    if (args[0] === lock && args[1] === 'wx' && attempts++ === 0) {
      throw Object.assign(new Error('Synthetic delete-pending lock'), {code:'EPERM'});
    }
    return (original as (...values: any[]) => number)(...args);
  });
  try {
    const result = f.queue.report({...f.claim,status:'completed',text:'Report after transient lock retirement',artifacts:[]});
    assert.equal(result.status, 'needs_review');
    assert.equal(attempts, 2);
  } finally { mocked.mock.restore(); }
});

test('Windows permanent lock access denial remains a bounded failure', {skip: process.platform !== 'win32'}, async t => {
  const f = await claimTask(t);
  const lock = path.join(f.journal.dir, 'queue-write.lock');
  const original = fs.openSync.bind(fs);
  const mocked = t.mock.method(fs, 'openSync', (...args: any[]) => {
    if (args[0] === lock && args[1] === 'wx') {
      throw Object.assign(new Error('Synthetic persistent access denial'), {code:'EPERM'});
    }
    return (original as (...values: any[]) => number)(...args);
  });
  try {
    assert.throws(() => f.queue.report({...f.claim,status:'completed',text:'Must not bypass denied lock',artifacts:[]}),
      error => (error as NodeJS.ErrnoException).code === 'EPERM');
    assert.equal(f.journal.snapshot()?.status, 'working');
  } finally { mocked.mock.restore(); }
});

test('an authenticated late report is retained as blocked and cannot manufacture completion', async t => {
  const f = await claimTask(t);
  f.journal.save({ ...f.journal.snapshot()!, deadline: new Date(Date.now() - 1000).toISOString() });
  f.queue.checkDeadline(f.claim.attemptId);
  const report = { ...f.claim, status: 'completed' as const, text: 'Actual partial changes and checks', artifacts: [path.join(f.dir, 'result.txt')] };
  fs.writeFileSync(report.artifacts[0]!, 'preserved');
  const response = f.queue.report(report);
  assert.equal(response.status, 'blocked');
  const after = await f.coordinator.sync('task');
  assert.equal(after.state, 'blocked');
  assert.deepEqual(after.artifacts, report.artifacts);
  assert.match(after.report!.rawText, /Actual partial changes and checks/);
  assert.equal(f.coordinator.executionStatus('task').remoteStopped, false);
  const count = f.journal.events(0, Infinity).length;
  assert.equal(f.queue.report(report).status, 'blocked');
  assert.equal(f.journal.events(0, Infinity).length, count);
  assert.throws(() => f.queue.report({ ...report, text: 'conflicting report' }), /conflicting/);
  f.queue.observeNative(f.claim.attemptId, { state: 'idle', workspace: f.dir });
  assert.equal(hasNativeStopEvidence(f.journal.snapshot()), true);
  await assert.rejects(() => f.coordinator.accept('task', 'cannot accept a deadline failure', ['inspected']), /finish/);
});

test('a report after deadline cannot become successful just because no observer polled', async t => {
  const f = await claimTask(t);
  f.journal.save({ ...f.journal.snapshot()!, deadline: new Date(Date.now() - 1000).toISOString() });
  assert.equal(f.queue.report({ ...f.claim, status: 'completed', text: 'late without polling', artifacts: [] }).status, 'blocked');
  assert.equal((await f.coordinator.sync('task')).state, 'blocked');
});

test('an operator cancellation retains its cancelled status when a late worker reports', async t => {
  const f = await claimTask(t);
  f.coordinator.cancel('task');
  assert.equal(f.queue.report({ ...f.claim, status: 'completed', text: 'Stopped and preserved files', artifacts: [] }).status, 'cancelled');
  assert.equal(f.coordinator.executionStatus('task').remoteStopped, false);
  f.queue.observeNative(f.claim.attemptId, { state: 'idle', workspace: f.dir });
  assert.equal(f.coordinator.executionStatus('task').remoteStopped, true);
});

test('opening Windows task and routing databases preserves their existing permissions', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  // Simulate a context that permits data access but refuses chmod, as the
  // sandbox did. Both existing database constructors must still work.
  t.mock.method(fs, 'chmodSync', () => { throw Error('chmod must not be called on Windows'); });
  const reader = new TaskStore(f.config.dbFile);
  const workers = new WorkspaceWorkers(f.config);
  try {
    assert.deepEqual(reader.listTasks(), []);
    assert.deepEqual(workers.list(), []);
  } finally { reader.close(); workers.close(); }
});

test('an unclaimed task blocks at its startup deadline instead of waiting for the whole task budget', async t => {
  const f = fixture(t);
  await f.coordinator.send({ taskId: 'task', objective: 'not claimed', workspace: f.dir, sessionId: 'session', timeoutSeconds: 1800 });
  const task = f.store.get('task')!;
  const journal = new RunJournal(f.queue.root, task.attemptId!);
  journal.save({ ...journal.snapshot()!, claimDeadline: new Date(Date.now() - 1).toISOString() });
  const after = await f.coordinator.sync('task');
  assert.equal(after.state, 'blocked');
  assert.match(after.blockingReason!, /did not claim/);
  assert.equal((await f.queue.claim('session', 0)).status, 'retry');
  assert.equal(f.store.listAttempts('task').length, 1);
  assert.equal(fs.existsSync(path.join(journal.dir, 'claim.json')), false);
});

test('the startup deadline stops applying after a verified native claim', async t => {
  const f = await claimTask(t);
  f.journal.save({ ...f.journal.snapshot()!, claimDeadline: new Date(Date.now() - 1).toISOString() });
  assert.equal((await f.coordinator.sync('task')).state, 'working');
  assert.equal(f.queue.report({ ...f.claim, status: 'completed', text: 'real result within the task deadline', artifacts: [] }).status, 'needs_review');
});

test('a claimed task carries its own reporting destination and exact finish command', async t => {
  const f = await claimTask(t);
  assert.ok(f.claim.prompt.includes(f.claim.reporting.resultFile));
  assert.ok(f.claim.prompt.includes(f.claim.reporting.command));
  assert.ok(!f.claim.prompt.includes(f.claim.leaseToken));
});
