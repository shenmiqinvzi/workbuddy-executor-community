import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectCandidatePackage } from '../src/installation-readiness.js';
import {
  ROLLBACK_PLAN_SCHEMA, assessSchemaDowngrade, extractSchemaExpectations, identifyInstalledRelease,
  inspectTaskDatabase, planVersionRollback, rollbackOperations,
} from '../src/installation-rollback.js';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { zipDirectory } = await import(pathToFileURL(path.join(source, 'scripts', 'zip.mjs')).href);

const TASK_STORE = `
export function migrate(db: any) {
  db.exec(\`CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, message_id TEXT, objective TEXT, workspace TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (task_id TEXT NOT NULL, attempt_id TEXT, message_id TEXT, role TEXT NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL);\`);
  for (const row of db.prepare("PRAGMA table_info(tasks)").all() as any[]) columns.add(row.name);
  for (const [name, type] of Object.entries({
    cancel_note: "TEXT",
    attempt_id: "TEXT",
    session_id: "TEXT",
  })) db.exec(\`ALTER TABLE tasks ADD COLUMN \${name} \${type}\`);
}
`;

type Inspection = ReturnType<typeof inspectCandidatePackage>;

function fixture(t: { after: (fn: () => void) => void }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-rollback-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const installRoot = path.join(temp, 'installation');
  const codexHome = path.join(temp, 'codex home');
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  return { temp, installRoot, codexHome };
}

async function release(temp: string, label: string, version: string, files: Record<string, string>): Promise<Inspection> {
  const prefix = `codex-workbuddy-gateway-v${version}`;
  const dir = path.join(temp, label);
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = Buffer.from(text, 'utf8');
    fs.writeFileSync(target, bytes);
    entries.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : 1));
  fs.writeFileSync(path.join(dir, 'RELEASE_MANIFEST.json'), JSON.stringify({ project: 'codex-workbuddy-gateway', version, files: entries }, null, 2));
  const archive = path.join(temp, `${label}.zip`);
  await zipDirectory(dir, archive, prefix);
  return inspectCandidatePackage(archive);
}

async function unpackReal(inspection: Inspection, installRoot: string) {
  const { readArchiveMembers } = await import('../src/installation-readiness.js');
  const prefix = `${inspection.release.prefix}/`;
  for (const [name, bytes] of readArchiveMembers(inspection.archive.file)) {
    if (!name.startsWith(prefix)) continue;
    const relative = name.slice(prefix.length);
    if (relative === 'RELEASE_MANIFEST.json') continue;
    const filename = path.join(installRoot, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  }
}

const BASE = { 'package.json': '{"name":"codex-workbuddy-gateway","version":"0.7.1"}', 'src/task-store.ts': TASK_STORE, 'dist/server.js': '// release build\n' };

test('the installed release is identified by file bytes, not by its version string', async t => {
  const f = fixture(t);
  const older = await release(f.temp, 'older', '0.7.1', BASE);
  await unpackReal(older, f.installRoot);
  assert.equal(identifyInstalledRelease(f.installRoot, [older])[0]?.exact, true);

  fs.writeFileSync(path.join(f.installRoot, 'dist/server.js'), '// edited by hand\n');
  const drifted = identifyInstalledRelease(f.installRoot, [older])[0]!;
  assert.equal(drifted.exact, false);
  assert.deepEqual(drifted.differing, ['dist/server.js']);

  fs.rmSync(path.join(f.installRoot, 'src/task-store.ts'));
  assert.deepEqual(identifyInstalledRelease(f.installRoot, [older])[0]?.missing, ['src/task-store.ts']);
});

test('schema expectations come from the target release source, including migrated columns', async t => {
  const f = fixture(t);
  const archive = await release(f.temp, 'schema', '0.7.1', BASE);
  const expectations = extractSchemaExpectations(archive.archive.file);
  assert.equal(expectations.source, 'src/task-store.ts');
  assert.equal(expectations.complete, true);
  assert.deepEqual(expectations.tables.tasks, ['task_id', 'message_id', 'objective', 'workspace', 'state', 'created_at', 'cancel_note', 'attempt_id', 'session_id']);
  assert.deepEqual(expectations.tables.messages, ['task_id', 'attempt_id', 'message_id', 'role', 'content_json', 'created_at']);

  const missing = extractSchemaExpectations(path.join(f.temp, 'absent.zip'));
  assert.equal(missing.complete, false);
  assert.equal(missing.source, null);
  assert.match(missing.note, /could not be read|no readable/i);
});

test('the repository task store yields identifier-only column names', async t => {
  // The real schema nests parens (CHECK/defaults), so a column fragment can drag a
  // closing paren along. Every name must still be a bare identifier.
  const f = fixture(t);
  const real = fs.readFileSync(path.join(source, 'src', 'task-store.ts'), 'utf8');
  const archive = await release(f.temp, 'real', '0.7.1', { ...BASE, 'src/task-store.ts': real });
  const expectations = extractSchemaExpectations(archive.archive.file);
  assert.equal(expectations.complete, true);
  const names = Object.values(expectations.tables).flat();
  assert.ok(names.length >= 10, `only ${names.length} column names were read`);
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_]*$/, `unexpected column name ${name}`);
  assert.ok(expectations.tables.tasks?.includes('attempt_id'));
  assert.ok(expectations.tables.messages?.includes('message_id'));
});

test('the live database is only ever read, and an unreadable one is not treated as empty', async t => {
  const f = fixture(t);
  const dbFile = path.join(f.installRoot, 'data/tasks.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE tasks (task_id TEXT, state TEXT, attempt_id TEXT); CREATE TABLE messages (task_id TEXT, role TEXT);');
  db.exec("INSERT INTO tasks VALUES ('t1','working','run-1'),('t2','completed','run-2')");
  db.close();

  const observation = inspectTaskDatabase(dbFile);
  assert.equal(observation.exists, true);
  assert.equal(observation.readable, true);
  assert.equal(observation.tasks, 2);
  assert.deepEqual(observation.states, ['completed', 'working']);
  assert.deepEqual(observation.tables.messages, ['task_id', 'role']);
  // Proving it is read-only: the schema is unchanged after observation.
  const after = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(after.prepare('PRAGMA table_info(tasks)').all().length, 3);
  after.close();

  assert.equal(inspectTaskDatabase(path.join(f.temp, 'none.sqlite')).exists, false);
  const corrupt = path.join(f.temp, 'corrupt.sqlite');
  fs.writeFileSync(corrupt, Buffer.from('this is not a database'));
  const broken = inspectTaskDatabase(corrupt);
  assert.equal(broken.exists, true);
  assert.equal(broken.readable, false);
  assert.ok(broken.error);
  const verdict = assessSchemaDowngrade(broken, { source: null, tables: {}, complete: false, note: 'x' });
  assert.equal(verdict.decision, 'unknown');
  assert.match(verdict.notes.join(' '), /could not be read/i);
});

test('a downgrade is incompatible when the older build declares a column that is gone', () => {
  const f = { tables: { tasks: ['task_id', 'state'], messages: ['task_id'] }, states: ['working'], exists: true, readable: true, tasks: 1, error: null };
  const expectations = { source: 'src/task-store.ts', tables: { tasks: ['task_id', 'state', 'attempt_id'], messages: ['task_id', 'role'] }, complete: true, note: 'from source' };
  const verdict = assessSchemaDowngrade(f, expectations);
  assert.equal(verdict.decision, 'incompatible');
  assert.deepEqual(verdict.missingColumns, ['tasks.attempt_id', 'messages.role']);
  assert.ok(verdict.recovery.some(line => /backup/i.test(line)));
  assert.ok(verdict.recovery.some(line => /never/i.test(line) && /database/i.test(line)));

  const compatible = assessSchemaDowngrade(
    { tables: { tasks: ['task_id', 'state', 'attempt_id'], messages: ['task_id', 'role', 'newer_column'] }, states: [], exists: true, readable: true, tasks: 0, error: null },
    expectations,
  );
  assert.equal(compatible.decision, 'compatible');
  assert.deepEqual(compatible.missingColumns, []);

  const unknown = assessSchemaDowngrade({ tables: { tasks: ['task_id'] }, states: [], exists: true, readable: true, tasks: 0, error: null }, { source: null, tables: {}, complete: false, note: 'unreadable' });
  assert.equal(unknown.decision, 'unknown');
  const absent = assessSchemaDowngrade({ tables: {}, states: [], exists: false, readable: false, tasks: null, error: null }, expectations);
  assert.equal(absent.decision, 'not_applicable');
});

test('a native WorkBuddy database is not mistaken for a gateway task store', () => {
  const expectations = { source: 'src/task-store.ts', tables: { tasks: ['task_id', 'state'], messages: ['task_id'] }, complete: true, note: 'from source' };
  const native = { tables: { sessions: ['id', 'cwd', 'is_playground', 'deleted_at'] }, states: [], exists: true, readable: true, tasks: null, error: null };
  const verdict = assessSchemaDowngrade(native, expectations);
  assert.equal(verdict.decision, 'unknown');
  assert.deepEqual(verdict.missingColumns, []);
  assert.match(verdict.notes.join(' '), /does not look like a gateway task store/);
  assert.ok(verdict.recovery.some(line => /is not a recovery step/i.test(line)));
});

test('a rollback plan names every file difference and writes nothing itself', async t => {
  const f = fixture(t);
  const newer = await release(f.temp, 'newer', '0.7.2', { ...BASE, 'dist/server.js': '// newer build\n', 'docs/NEWER_ONLY.md': 'added by 0.7.2\n' });
  const older = await release(f.temp, 'older2', '0.7.1', BASE);
  await unpackReal(newer, f.installRoot);

  const before = identifyInstalledRelease(f.installRoot, [newer])[0]!;
  const plan = planVersionRollback({ installRoot: f.installRoot, codexHome: f.codexHome, current: newer, target: older });
  assert.equal(plan.schemaVersion, ROLLBACK_PLAN_SCHEMA);
  assert.equal(plan.readOnly, true);
  assert.equal(plan.safeToApply, true);
  assert.deepEqual(plan.counts, { replace: 1, create: 0, remove: 1, keep: 2, blocked: 0 });
  assert.equal(plan.schema.assessment.decision, 'not_applicable');
  assert.equal(plan.runtimeTarget.restartRequired, true);
  assert.equal(plan.runtimeTarget.runningProcessUnaffected, true);
  assert.match(plan.configImpact.env, /never rewrites/i);
  assert.ok(plan.steps.some(step => /backup/i.test(step)));
  assert.ok(!plan.steps.some(step => /delete the database/i.test(step)));

  // Nothing was written by planning: the installation still matches the newer release exactly.
  const after = identifyInstalledRelease(f.installRoot, [newer])[0]!;
  assert.equal(after.matched, before.matched);
  assert.equal(after.exact, true);

  const operations = rollbackOperations(plan);
  assert.equal(operations.apply, true);
  assert.deepEqual(operations.write.sort(), ['dist/server.js']);
  assert.deepEqual(operations.remove, ['docs/NEWER_ONLY.md']);
});

test('a locally changed file is blocked instead of being deleted or overwritten', async t => {
  const f = fixture(t);
  const newer = await release(f.temp, 'newer3', '0.7.2', { ...BASE, 'docs/NEWER_ONLY.md': 'added by 0.7.2\n' });
  const older = await release(f.temp, 'older3', '0.7.1', BASE);
  await unpackReal(newer, f.installRoot);
  fs.writeFileSync(path.join(f.installRoot, 'docs/NEWER_ONLY.md'), 'the user wrote this\n');

  const plan = planVersionRollback({ installRoot: f.installRoot, codexHome: f.codexHome, current: newer, target: older });
  assert.equal(plan.safeToApply, false);
  assert.ok(plan.blocked.some(item => item.path === 'docs/NEWER_ONLY.md' && item.reason === 'local_changes_would_be_lost'));
  assert.equal(rollbackOperations(plan).apply, false);
  assert.equal(fs.readFileSync(path.join(f.installRoot, 'docs/NEWER_ONLY.md'), 'utf8'), 'the user wrote this\n');
});

test('an incompatible schema blocks the plan even when every file matches', async t => {
  const f = fixture(t);
  const newer = await release(f.temp, 'newer4', '0.7.2', BASE);
  const older = await release(f.temp, 'older4', '0.7.1', BASE);
  await unpackReal(newer, f.installRoot);
  const dbFile = path.join(f.installRoot, 'data/tasks.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE tasks (task_id TEXT, state TEXT); CREATE TABLE messages (task_id TEXT, role TEXT);');
  db.close();

  const plan = planVersionRollback({ installRoot: f.installRoot, codexHome: f.codexHome, current: newer, target: older });
  assert.equal(plan.schema.assessment.decision, 'incompatible');
  assert.ok(plan.schema.assessment.missingColumns.includes('tasks.attempt_id'));
  assert.equal(plan.safeToApply, false);
  const operations = rollbackOperations(plan);
  assert.equal(operations.apply, false);
  assert.equal(operations.reason, 'schema_or_archive_not_verified');
  assert.deepEqual(operations.write, []);
});

test('skill drift and a replaced file path both stop the plan', async t => {
  const f = fixture(t);
  const newer = await release(f.temp, 'newer5', '0.7.2', BASE);
  const older = await release(f.temp, 'older5', '0.7.1', BASE);
  await unpackReal(newer, f.installRoot);
  fs.mkdirSync(path.join(f.codexHome, 'skills', 'workbuddy-executor'), { recursive: true });
  fs.writeFileSync(path.join(f.codexHome, 'skills', 'workbuddy-executor', 'SKILL.md'), 'edited\n');

  const drifted = planVersionRollback({
    installRoot: f.installRoot, codexHome: f.codexHome, current: newer, target: older,
    installedSkillFiles: { 'SKILL.md': 'a'.repeat(64) },
  });
  assert.ok(drifted.blocked.some(item => item.reason === 'installed_skill_has_local_changes'));
  assert.equal(drifted.safeToApply, false);

  fs.rmSync(path.join(f.installRoot, 'dist/server.js'));
  fs.mkdirSync(path.join(f.installRoot, 'dist/server.js'));
  const replaced = planVersionRollback({ installRoot: f.installRoot, codexHome: f.codexHome, current: newer, target: older });
  assert.ok(replaced.files.some(item => item.path === 'dist/server.js' && item.action === 'blocked' && item.reason === 'target_is_not_a_file'));
  assert.equal(replaced.safeToApply, false);
});


