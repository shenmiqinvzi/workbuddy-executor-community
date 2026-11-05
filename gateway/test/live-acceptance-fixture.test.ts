import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareLiveAcceptanceFixtures, verifyFixtureIntegrity } from '../scripts/live-acceptance-fixture.mjs';

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'live-fixture-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, run: prepareLiveAcceptanceFixtures(parent) };
}
const checks = workspace => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // This child is a separate test invocation, not a recursive run().
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'checks/acceptance.test.mjs'], { cwd: workspace, env, encoding: 'utf8', timeout: 10000, windowsHide: true });
};

test('generation preserves caller files and repeats into separate unapproved directories', t => {
  const f = fixture(t), sentinel = path.join(f.parent, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'caller data');
  const second = prepareLiveAcceptanceFixtures(f.parent);
  assert.notEqual(f.run.root, second.root);
  assert.equal(path.dirname(second.root), fs.realpathSync(f.parent));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'caller data');
  assert.equal(second.authorized, false);
  for (const [executorId, sample] of Object.entries(second.samples)) {
    const draft = JSON.parse(fs.readFileSync(sample.draftFile, 'utf8'));
    assert.equal(draft.executorId, executorId);
    assert.equal(draft.authorized, false);
    assert.equal(draft.contractTemplate.execution, null);
    assert.equal(draft.contractTemplate.collaboration, null);
    assert.equal(draft.contractTemplate.maxAttempts, 1);
    assert.equal(draft.contractTemplate.requiredChecks.filter(x => x.kind === 'command').length, 1);
    assert.equal(path.dirname(sample.draftFile), path.join(second.root, 'contracts'));
    const command = JSON.parse(draft.contractTemplate.requiredChecks[0].definition);
    assert.equal(command.cwd, sample.workspace);
    assert.deepEqual(command.args, ['--test', '--test-reporter=tap', 'checks/acceptance.test.mjs']);
    assert.ok(command.inputs.includes('checks/acceptance.test.mjs'));
  }
});

test('both baseline code samples fail the original independent checks', t => {
  const { run } = fixture(t);
  for (const sample of Object.values(run.samples)) {
    const result = checks(sample.workspace);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /# tests 7\b/);
    assert.match(result.stdout, /fail [1-9]|not ok|✖/);
  }
  assert.equal(verifyFixtureIntegrity(run.root, run.baselineSha256).ok, true, 'failing checks do not modify prepared files');
});

test('minimal reference fixes pass without changing protected checks or agreements', t => {
  const { run } = fixture(t);
  const wb = path.join(run.samples.workbuddy.workspace, run.samples.workbuddy.sourceFile);
  const dsh = path.join(run.samples.dsh.workspace, run.samples.dsh.sourceFile);
  fs.writeFileSync(wb, fs.readFileSync(wb, 'utf8').replace('Math.max(lower, Math.max(value, upper))', 'Math.min(upper, Math.max(lower, value))'));
  fs.writeFileSync(dsh, fs.readFileSync(dsh, 'utf8').replace("order.status !== 'refunded'", "order.status === 'paid'"));
  for (const sample of Object.values(run.samples)) {
    const result = checks(sample.workspace);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# tests 7\b/);
  }
  assert.equal(verifyFixtureIntegrity(run.root, run.baselineSha256).ok, true);
});

test('tampering with checks is detected even if changed tests would pass', t => {
  const { run } = fixture(t);
  fs.writeFileSync(path.join(run.samples.workbuddy.workspace, 'checks/acceptance.test.mjs'), '');
  assert.equal(checks(run.samples.workbuddy.workspace).status, 0);
  const result = verifyFixtureIntegrity(run.root, run.baselineSha256);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(x => x.startsWith('protected_file_changed:')));
});

test('rewriting the baseline cannot erase the externally recorded digest', t => {
  const { run } = fixture(t);
  const file = path.join(run.root, 'baseline.json');
  fs.appendFileSync(file, '\n');
  assert.deepEqual(verifyFixtureIntegrity(run.root, run.baselineSha256).problems, ['baseline_changed']);
  assert.throws(() => verifyFixtureIntegrity(run.root), /external_baseline_digest_required/);
});

test('extra files or empty directories outside the allowed source change are detected', t => {
  const { run } = fixture(t);
  fs.mkdirSync(path.join(run.samples.dsh.workspace, 'extra-directory'));
  assert.ok(verifyFixtureIntegrity(run.root, run.baselineSha256).problems.includes('unexpected_file'));
});

test('linked parent directories are refused without writing through their target', t => {
  const f = fixture(t), target = path.join(f.parent, 'target'), alias = path.join(f.parent, 'alias');
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => prepareLiveAcceptanceFixtures(alias), /linked_directory_refused/);
    assert.throws(() => prepareLiveAcceptanceFixtures(path.join(alias, 'not-created', 'nested')), /linked_directory_refused/);
    assert.deepEqual(fs.readdirSync(target), []);
  } finally { fs.unlinkSync(alias); }
});

test('CLI verifies preparation only and never treats an invalid digest as authorization', t => {
  const { run } = fixture(t), script = path.resolve('scripts/live-acceptance-fixture.mjs');
  const result = spawnSync(process.execPath, [script, 'verify', '--root', run.root, '--baseline-sha256', run.baselineSha256], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).authorized, false);
  const refused = spawnSync(process.execPath, [script, 'verify', '--root', run.root, '--baseline-sha256', 'not-a-digest'], { encoding: 'utf8', windowsHide: true });
  assert.equal(refused.status, 2);
});
