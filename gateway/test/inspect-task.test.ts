import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { TaskStore } from '../src/task-store.js';
import { RunJournal } from '../src/run-journal.js';
import { inspectTask } from '../src/inspect-task.js';
import { resultForDetail } from '../src/brief-result.js';

test('offline inspector discovers an unsubmitted result without creating or changing anything', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-inspect-'));
  const config = { ...loadConfig(), dbFile: path.join(dir, 'tasks.sqlite'), runsDir: path.join(dir, 'runs') };
  const store = new TaskStore(config.dbFile);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const attemptId = RunJournal.newId();
  store.createOrGet({ taskId: 'task', messageId: attemptId, state: 'blocked', objective: 'existing task', attemptId, attempt: 1, sessionId: 'native-session' });
  const journal = new RunJournal(config.runsDir, attemptId);
  journal.save({ taskId: 'task', attemptId, sessionId: 'native-session', status: 'blocked', driver: 'desktop-queue', updatedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(journal.dir, 'worker-result.json'), JSON.stringify({ status: 'completed', text: 'File alone is not authenticated', artifacts: [] }));
  const before = store.get('task');
  const deny = () => { throw Error('read-only inspector attempted a write'); };
  const mocks = ['chmodSync', 'mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync'] as const;
  for (const method of mocks) t.mock.method(fs, method, deny);
  try {
    const result = inspectTask(config, 'task');
    assert.equal(result.readOnly, true);
    assert.equal(result.snapshotOnly, true);
    assert.equal(result.workerResult.present, true);
    assert.equal(result.workerResult.authenticated, false);
    assert.equal(result.workerResult.status, 'completed');
    assert.equal(result.task.state, 'blocked');
    assert.equal(result.execution.remoteStopped, false);
    assert.deepEqual(store.get('task'), before);
    const compact = resultForDetail(result, 'brief') as typeof result;
    assert.equal(compact.readOnly, true);
    assert.deepEqual(compact.workerResult, result.workerResult);
  } finally { t.mock.restoreAll(); }
});

test('offline inspector fails closed for a missing store without creating its parent', () => {
  const parent = path.join(os.tmpdir(), `missing-${RunJournal.newId()}`);
  assert.throws(() => inspectTask({ ...loadConfig(), dbFile: path.join(parent, 'tasks.sqlite') }, 'task'));
  assert.equal(fs.existsSync(parent), false);
});

test('a changed result file never inherits authentication from an older report digest', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-inspect-digest-'));
  const config = { ...loadConfig(), dbFile: path.join(dir, 'tasks.sqlite'), runsDir: path.join(dir, 'runs') };
  const store = new TaskStore(config.dbFile);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const attemptId = RunJournal.newId();
  store.createOrGet({ taskId: 'task', messageId: attemptId, state: 'needs_review', objective: 'real task', attemptId });
  const result = { status: 'completed', text: 'real authenticated result', artifacts: [] };
  const digest = crypto.createHash('sha256').update(JSON.stringify([result.status, result.text, result.artifacts])).digest('hex');
  const journal = new RunJournal(config.runsDir, attemptId);
  journal.save({ taskId: 'task', attemptId, status: 'needs_review', driver: 'desktop-queue', reportDigest: digest, updatedAt: new Date().toISOString() });
  const resultFile = path.join(journal.dir, 'worker-result.json');
  fs.writeFileSync(resultFile, JSON.stringify(result));
  assert.equal(inspectTask(config, 'task').workerResult.authenticated, true);
  fs.writeFileSync(resultFile, JSON.stringify({ ...result, text: 'changed after reporting' }));
  assert.equal(inspectTask(config, 'task').workerResult.authenticated, false);
});
