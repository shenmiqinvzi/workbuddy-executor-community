import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { captureDeliveryBaseline, readPolicyDatabase } from '../scripts/delivery-baseline.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-baseline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  return { root, write };
}
const policy = { version: 'synthetic-policy', maxAttempts: 2, maxTimeoutSeconds: 600, requireFree: true, allowed: [{ executorId: 'workbuddy', connectionId: 'local-workbuddy', providerId: 'workbuddy-native', modelId: 'synthetic-model', reasoningEffort: null }], privateCredential: 'SECRET_POLICY_FIELD' };

test('equal version numbers do not hide changed, absent or unreadable installed code', t => {
  const f = fixture(t);
  const manifest = f.write('candidate.manifest.json', { project: 'codex-workbuddy-gateway', version: '0.7.1', files: ['src/one.ts', 'src/two.ts', 'src/three.ts'].map(file => ({ path: file, sha256: sha('candidate') })) });
  f.write('installed/package.json', { version: '0.7.1' });
  f.write('installed/src/one.ts', 'older');
  fs.mkdirSync(path.join(f.root, 'installed/src/three.ts'));
  const before = fs.readdirSync(path.join(f.root, 'installed/src'));
  const result = captureDeliveryBaseline({ candidateManifest: manifest, installedRoot: path.join(f.root, 'installed') });
  assert.equal(result.installed.package.version, result.candidate.version);
  assert.deepEqual(result.installed.candidateFiles.changed, ['src/one.ts']);
  assert.deepEqual(result.installed.candidateFiles.absent, ['src/two.ts']);
  assert.equal(result.installed.candidateFiles.unreadable[0].file, 'src/three.ts');
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'installed/src')), before);
  assert.equal(result.authorizesDispatch, false);
});

test('a supplied manifest cannot select private state or traverse outside the code root', t => {
  const f = fixture(t);
  f.write('installed/.env', 'API_KEY=SECRET_ENV_VALUE');
  for (const file of ['.env', '../private.json', 'data/tasks.sqlite', 'accounts/settings.json']) {
    const manifest = f.write('candidate.manifest.json', { project: 'codex-workbuddy-gateway', version: '0.7.1', files: [{ path: file, sha256: sha('SECRET_ENV_VALUE') }] });
    const result = captureDeliveryBaseline({ candidateManifest: manifest, installedRoot: path.join(f.root, 'installed') });
    assert.equal(result.candidate.status, 'invalid');
    assert.equal(result.installed.candidateFiles.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(result), /SECRET_ENV_VALUE/);
  }
});

test('loaded MCP fingerprint is compared to compiled disk code without executing that code', t => {
  const f = fixture(t);
  f.write('installed/dist/a.js', "throw new Error('must not execute installed code');");
  f.write('candidate/dist/a.js', "throw new Error('must not execute candidate code');");
  const installedHash = sha(Buffer.concat([Buffer.from('a.js'), fs.readFileSync(path.join(f.root, 'installed/dist/a.js'))]));
  const runtimeSnapshot = f.write('runtime.json', { runtime: { codeHash: installedHash, pid: 123, startedAt: '2026-11-05T00:00:00Z' } });
  const result = captureDeliveryBaseline({ installedRoot: path.join(f.root, 'installed'), candidateRoot: path.join(f.root, 'candidate'), runtimeSnapshot });
  assert.equal(result.runtimeComparison.mcpMatchesInstalledDisk, true);
  assert.equal(result.runtimeComparison.mcpMatchesCandidate, false);
});

test('policy observation preserves WAL and schema while projecting only approved non-secret fields', t => {
  const f = fixture(t), file = path.join(f.root, 'policy.sqlite'), db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE collaboration_policy(id INTEGER PRIMARY KEY,body_json TEXT,digest TEXT); CREATE TABLE workflow_capacity(slot INTEGER PRIMARY KEY,task_id TEXT); CREATE TABLE private_accounts(token TEXT)');
  db.prepare('INSERT INTO collaboration_policy VALUES (1,?,?)').run(JSON.stringify(policy), sha(JSON.stringify(policy)));
  db.exec("INSERT INTO workflow_capacity VALUES(1,'synthetic-occupied'); INSERT INTO private_accounts VALUES('SECRET_ACCOUNT_TOKEN')");
  const hashes = () => [file, `${file}-wal`, `${file}-shm`].map(p => sha(fs.readFileSync(p)));
  // Fixture SQL itself may update WAL read marks. Finish it before measuring
  // the collector; no source connection query runs inside that window.
  const schema = db.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all(), before = hashes();
  try {
    const result = readPolicyDatabase(file, f.root);
    assert.equal(result.policy.status, 'observed');
    assert.equal(result.policy.selectionMode, 'allowlist');
    assert.equal(result.policy.selectionModeStored, false);
    assert.equal(result.policy.requireFree, true);
    assert.equal(result.policy.maxAttempts, 2);
    assert.equal(result.capacity.status, 'recorded_occupant');
    assert.equal(result.capacity.closureEvaluated, false);
    assert.equal(result.effectivePolicyVerified, false);
    assert.equal(result.sourceDatabaseOpened, false);
    assert.equal(result.sourceReadMethod, 'stable_db_wal_copy');
    assert.doesNotMatch(JSON.stringify(result), /SECRET_|privateCredential|synthetic-occupied/);
    assert.deepEqual(hashes(), before);
    assert.deepEqual(db.prepare('SELECT sql FROM sqlite_schema ORDER BY name').all(), schema);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('delivery-baseline-policy-')), false);
  } finally { db.close(); }
});

test('missing and legacy databases remain missing or unknown and never get initialized', t => {
  const f = fixture(t), missing = path.join(f.root, 'missing.sqlite');
  assert.equal(readPolicyDatabase(missing).status, 'absent');
  assert.equal(fs.existsSync(missing), false);
  const legacy = path.join(f.root, 'legacy.sqlite'), db = new DatabaseSync(legacy);
  db.exec('CREATE TABLE original(x INTEGER)'); db.close();
  const before = fs.readFileSync(legacy), result = readPolicyDatabase(legacy, f.root);
  assert.equal(result.policy.status, 'not_recorded');
  assert.equal(result.capacity.status, 'unknown');
  assert.deepEqual(fs.readFileSync(legacy), before);
});

test('an invalid policy digest is not displayed as an authentic policy', t => {
  const f = fixture(t), file = path.join(f.root, 'policy.sqlite'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE collaboration_policy(id INTEGER PRIMARY KEY,body_json TEXT,digest TEXT)');
  db.prepare('INSERT INTO collaboration_policy VALUES(1,?,?)').run(JSON.stringify(policy), '0'.repeat(64)); db.close();
  const result = readPolicyDatabase(file, f.root);
  assert.deepEqual(result.policy, { status: 'invalid', code: 'POLICY_INTEGRITY' });
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|synthetic-model/);
});

test('policy capture requires owned scratch and refuses linked scratch without opening the source', t => {
  const f = fixture(t), file = path.join(f.root, 'policy.sqlite'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE original(x INTEGER)'); db.close();
  const before = fs.readFileSync(file);
  assert.equal(readPolicyDatabase(file).code, 'POLICY_SCRATCH_REQUIRED');
  const target = path.join(f.root, 'target'), alias = path.join(f.root, 'linked');
  fs.mkdirSync(target); fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.equal(readPolicyDatabase(file, alias).status, 'unreadable');
    assert.deepEqual(fs.readdirSync(target), []);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { fs.unlinkSync(alias); }
});

test('a source rollback journal is refused rather than reading possibly uncommitted policy pages', t => {
  const f = fixture(t), file = path.join(f.root, 'policy.sqlite'), db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE original(x INTEGER); INSERT INTO original VALUES(1); BEGIN IMMEDIATE; UPDATE original SET x=2');
  try {
    assert.ok(fs.statSync(`${file}-journal`).size > 0);
    const before = fs.readFileSync(`${file}-journal`), result = readPolicyDatabase(file, f.root);
    assert.equal(result.status, 'unreadable');
    assert.equal(result.policy, null);
    assert.deepEqual(fs.readFileSync(`${file}-journal`), before);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('delivery-baseline-policy-')), false);
  } finally { db.exec('ROLLBACK'); db.close(); }
});

test('runtime, flag and desktop snapshots retain unknown states without exporting unrelated fields', t => {
  const f = fixture(t);
  const runtimeSnapshot = f.write('runtime.json', { runtime: { release: 'synthetic', packageVersion: '0.7.1', codeHash: 'a'.repeat(64), pid: 123, startedAt: '2026-11-05T00:00:00Z', token: 'SECRET_RUNTIME' }, ready: false, online: false, sessions: [{ text: 'SECRET_SESSION' }] });
  const flagsSnapshot = f.write('flags.json', { source: 'synthetic', fields: { WORKBUDDY_REQUIRED_FREE_MODEL: 'synthetic-model', WORKBUDDY_ACCESS_TOKEN: 'SECRET_ACCESS' } });
  const desktopSnapshot = f.write('processes.json', { queryStatus: 'unavailable', processes: [], stderr: 'SECRET_PROCESS_ERROR' });
  const result = captureDeliveryBaseline({ runtimeSnapshot, flagsSnapshot, desktopSnapshot });
  assert.equal(result.mcp.runtime.pid, 123);
  assert.equal(result.mcp.ready, false);
  assert.equal(result.desktop.status, 'unavailable');
  assert.deepEqual(result.deploymentFlags.fields, { WORKBUDDY_REQUIRED_FREE_MODEL: 'synthetic-model' });
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|sessions|stderr|ACCESS_TOKEN/);
  f.write('processes.json', { queryStatus: 'observed', collectedAt: '2026-11-05T00:00:00Z', processes: [] });
  assert.deepEqual(captureDeliveryBaseline({ desktopSnapshot }).desktop.processes, []);
});

test('CLI reads inputs without modifying them and refuses unknown options without echoing values', t => {
  const f = fixture(t), file = f.write('runtime.json', { ready: false, online: false, token: 'SECRET_INPUT' });
  const script = path.resolve('scripts/delivery-baseline.mjs'), before = fs.readFileSync(file);
  const result = spawnSync(process.execPath, [script, '--runtime-snapshot', file], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).authorizesDispatch, false);
  assert.doesNotMatch(result.stdout, /SECRET_INPUT/);
  assert.deepEqual(fs.readFileSync(file), before);
  const refused = spawnSync(process.execPath, [script, '--token', 'SECRET_BAD_ARGUMENT'], { encoding: 'utf8', windowsHide: true });
  assert.equal(refused.status, 2);
  assert.doesNotMatch(refused.stderr, /SECRET_BAD_ARGUMENT/);
});

test('disk service registration does not pretend to identify a running service', t => {
  const f = fixture(t), installedRoot = path.join(f.root, 'installed'), database = path.join(f.root, 'state.sqlite');
  const serviceState = f.write('service.json', { version: 1, projectDir: installedRoot, dbFile: database, sessionId: 'SECRET_SESSION', token: 'SECRET_SERVICE', installedAt: '2026-11-05T00:00:00Z' });
  const result = captureDeliveryBaseline({ serviceState, installedRoot, database }).service;
  assert.equal(result.kind, 'disk_registration');
  assert.equal(result.gatewayMatchesInstalled, true);
  assert.equal(result.databaseMatchesConfigured, true);
  assert.equal(result.runtime, null);
  assert.equal(result.loadedCodeVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|projectDir|dbFile/);
});
