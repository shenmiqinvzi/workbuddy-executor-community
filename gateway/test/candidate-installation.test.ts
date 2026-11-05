import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  inspectCandidatePackage, planCandidateInstallation, assertDrillWorkspace,
  assertArchivePath, readArchiveMembers, digest,
} from '../src/installation-readiness.js';
import { setup } from '../src/setup.js';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { zipDirectory } = await import(pathToFileURL(path.join(source, 'scripts/zip.mjs')).href);

const RELEASE = 'codex-workbuddy-gateway-v0.7.1';
const SKILL_FILES = ['SKILL.md', 'agents/openai.yaml', 'references/setup.md', 'references/execution.md', 'references/dispatch.md', 'references/agent-hub.md'];

function sha(file: string) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function treeHash(root: string) {
  const rows: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const filename = path.join(dir, item.name);
      const relative = path.relative(root, filename).replaceAll('\\', '/');
      if (item.isDirectory()) { rows.push(`d ${relative}`); walk(filename); }
      else rows.push(`f ${relative} ${sha(filename)}`);
    }
  };
  walk(root);
  return rows.join('\n');
}

/** Writes a candidate source tree, seals it with a manifest and zips it. */
async function sealCandidate(temp: string, options: { name?: string; files?: Record<string, string>; omit?: string[] } = {}) {
  const name = options.name ?? 'candidate';
  const dir = path.join(temp, name);
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'codex-workbuddy-gateway', version: '0.7.1' }, null, 2),
    'dist/server.js': 'export {};',
    'dist/setup.js': 'export {};',
    'scripts/install-skill.mjs': fs.readFileSync(path.join(source, 'scripts/install-skill.mjs'), 'utf8'),
  };
  for (const skill of SKILL_FILES) files[`skills/workbuddy-executor/${skill}`] = `fixture ${skill}\n`;
  Object.assign(files, options.files ?? {});
  for (const [relative, text] of Object.entries(files)) {
    if ((options.omit ?? []).includes(relative)) continue;
    const filename = path.join(dir, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, text);
  }
  const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
  const walk = (current: string) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const filename = path.join(current, item.name);
      if (item.isDirectory()) walk(filename);
      else {
        const relative = path.relative(dir, filename).replaceAll('\\', '/');
        entries.push({ path: relative, bytes: fs.statSync(filename).size, sha256: sha(filename) });
      }
    }
  };
  walk(dir);
  fs.writeFileSync(path.join(dir, 'RELEASE_MANIFEST.json'), JSON.stringify({ project: 'codex-workbuddy-gateway', version: '0.7.1', files: entries }, null, 2));
  const archive = path.join(temp, `${RELEASE}-${name}.zip`);
  await zipDirectory(dir, archive, RELEASE);
  return { dir, archive };
}

function fixture(t: { after: (fn: () => void) => void }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-candidate-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const drillRoot = path.join(temp, '演练 root');
  const installRoot = path.join(drillRoot, '安装 directory');
  const codexHome = path.join(drillRoot, 'codex home');
  const app = path.join(drillRoot, 'WorkBuddyAI.exe');
  const config = path.join(drillRoot, 'native config');
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(app, 'fixture, never executed');
  const db = new DatabaseSync(path.join(config, 'workbuddy.db'));
  db.exec('CREATE TABLE sessions(id TEXT,cwd TEXT,is_playground INTEGER,deleted_at TEXT)');
  db.close();
  const env = { WORKBUDDY_CLI_ELECTRON: app, WORKBUDDY_CONFIG_DIR: config };
  return { temp, drillRoot, installRoot, codexHome, app, config, env, options: { root: installRoot, codexHome, env, platform: 'win32' as const, apply: true } };
}

/** Unpacks a candidate the way a deployment would, but only into the drill root. */
function unpack(archive: string, installRoot: string) {
  const members = readArchiveMembers(archive);
  for (const [name, bytes] of members) {
    const relative = name.slice(name.indexOf('/') + 1);
    if (relative === 'RELEASE_MANIFEST.json') continue;
    const filename = path.join(installRoot, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  }
}

test('candidate archive is verified against its own manifest and tampering is reported', async t => {
  const f = fixture(t);
  const { dir, archive } = await sealCandidate(f.temp);
  const inspection = inspectCandidatePackage(archive);
  assert.equal(inspection.ok, true, inspection.problems.join('; '));
  assert.equal(inspection.release.project, 'codex-workbuddy-gateway');
  assert.equal(inspection.release.version, '0.7.1');
  assert.equal(inspection.files, inspection.entries.length);
  assert.ok(inspection.entries.some(entry => entry.path === 'dist/server.js'));
  assert.equal(inspection.readOnly, true);

  const wrong = inspectCandidatePackage(archive, { expectedSha256: 'f'.repeat(64) });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.problems.some(problem => problem.includes('expected value')));

  fs.appendFileSync(path.join(dir, 'dist/server.js'), 'tampered');
  const stale = path.join(f.temp, 'stale.zip');
  await zipDirectory(dir, stale, RELEASE);
  const tampered = inspectCandidatePackage(stale);
  assert.equal(tampered.ok, false);
  assert.ok(tampered.problems.some(problem => problem.includes('does not match its manifest entry')));

  fs.writeFileSync(path.join(dir, 'dist/server.js'), 'export {};');
  fs.writeFileSync(path.join(dir, 'extra.txt'), 'not listed anywhere');
  const extra = path.join(f.temp, 'extra.zip');
  await zipDirectory(dir, extra, RELEASE);
  const unlisted = inspectCandidatePackage(extra);
  assert.equal(unlisted.ok, false);
  assert.ok(unlisted.problems.some(problem => problem.includes('manifest does not list')));
});

test('archive paths that could escape an extraction root are rejected', () => {
  for (const name of ['../escape.txt', '/absolute.txt', 'C:/windows.txt', 'a\\b.txt', 'a/./b.txt', 'a/../b.txt', 'a//b.txt', 'a/b:c.txt', 'dir/', '']) {
    assert.throws(() => assertArchivePath(name), /archive/i, name);
  }
  assert.equal(assertArchivePath('dist/server.js'), 'dist/server.js');
  assert.equal(assertArchivePath('.env.example'), '.env.example');
});

test('installation plan writes nothing and classifies create, unchanged, update and unmanaged', async t => {
  const f = fixture(t);
  const { archive } = await sealCandidate(f.temp);
  const inspection = inspectCandidatePackage(archive);
  const before = treeHash(f.drillRoot);

  const empty = planCandidateInstallation({ inspection, installRoot: f.installRoot, codexHome: f.codexHome, env: f.env, platform: 'win32' });
  assert.equal(empty.readOnly, true);
  assert.equal(empty.counts.create, inspection.files);
  assert.equal(empty.counts.update, 0);
  assert.equal(treeHash(f.drillRoot), before, 'plan must not write into the installation root');

  unpack(archive, f.installRoot);
  fs.writeFileSync(path.join(f.installRoot, 'dist/server.js'), 'locally different');
  fs.mkdirSync(path.join(f.installRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(f.installRoot, 'data/private-history.txt'), 'keep me');
  fs.mkdirSync(path.join(f.installRoot, 'node_modules/zod'), { recursive: true });
  const settled = planCandidateInstallation({ inspection, installRoot: f.installRoot, codexHome: f.codexHome, env: f.env, platform: 'win32' });
  assert.deepEqual(settled.update, ['dist/server.js']);
  assert.equal(settled.counts.unchanged, inspection.files - 1);
  // Unmanaged trees are reported as a whole and never enumerated file by file.
  assert.ok(settled.unmanaged.includes('data/'));
  assert.ok(settled.unmanaged.includes('node_modules/'));
  assert.ok(!settled.unmanaged.some(item => item.startsWith('data/private-history')));
  assert.equal(fs.readFileSync(path.join(f.installRoot, 'data/private-history.txt'), 'utf8'), 'keep me');
  assert.equal(settled.blocked.length, 0);
});

test('links and unreadable targets are blocked, and managed local changes stop the plan', async t => {
  const f = fixture(t);
  const { archive } = await sealCandidate(f.temp);
  const inspection = inspectCandidatePackage(archive);
  unpack(archive, f.installRoot);
  fs.rmSync(path.join(f.installRoot, 'dist/server.js'));
  fs.symlinkSync(path.join(f.temp), path.join(f.installRoot, 'dist/server.js'), 'junction');
  const linked = planCandidateInstallation({ inspection, installRoot: f.installRoot, codexHome: f.codexHome, env: f.env, platform: 'win32' });
  assert.deepEqual(linked.blocked.map(item => item.reason), ['target_is_link']);
  assert.equal(linked.safeToApply, false);

  const plan = planCandidateInstallation({ inspection, installRoot: f.installRoot, codexHome: f.codexHome, env: f.env, platform: 'win32', installed: { root: f.installRoot, codexHome: f.codexHome, skillFiles: { 'SKILL.md': 'x' }, snippetHash: 'y' } });
  assert.equal(plan.managedDrift.length, 0, 'no skill tree yet, so nothing can have drifted');

  setup('install', { ...f.options, root: f.installRoot });
  const skill = path.join(f.codexHome, 'skills', 'workbuddy-executor', 'SKILL.md');
  fs.appendFileSync(skill, 'local edit');
  const drifted = planCandidateInstallation({ inspection, installRoot: f.installRoot, codexHome: f.codexHome, env: f.env, platform: 'win32' });
  assert.ok(drifted.managedDrift.some(item => item.reason === 'installed_skill_has_local_changes'));
  assert.equal(drifted.safeToApply, false);
  assert.equal(drifted.setupWrites.skill, 'refused_local_changes');
});

test('missing requirements are reported instead of assumed, and the plan is not marked safe', async t => {
  const f = fixture(t);
  const { archive } = await sealCandidate(f.temp, { name: 'without-setup', omit: ['dist/setup.js'] });
  const inspection = inspectCandidatePackage(archive);
  assert.equal(inspection.ok, true);
  const plan = planCandidateInstallation({ inspection, installRoot: f.installRoot, codexHome: f.codexHome, env: f.env, platform: 'win32' });
  const entrypoint = plan.requirements.find(item => item.id === 'gateway_entrypoint');
  assert.equal(entrypoint?.ok, false);
  const dependencies = plan.requirements.find(item => item.id === 'runtime_dependencies');
  assert.equal(dependencies?.ok, false);
  const desktop = plan.requirements.find(item => item.id === 'desktop_application');
  assert.equal(desktop?.ok, false);
  assert.equal(plan.safeToApply, false);

  const home = planCandidateInstallation({ inspection, installRoot: os.homedir(), codexHome: f.codexHome, env: f.env, platform: 'win32' });
  assert.equal(home.requirements.find(item => item.id === 'target_not_home')?.ok, false);
  const otherPlatform = planCandidateInstallation({ inspection, installRoot: f.installRoot, codexHome: f.codexHome, env: f.env, platform: 'linux' });
  assert.equal(otherPlatform.requirements.find(item => item.id === 'platform')?.ok, false);
});

test('drill workspaces must be explicit and stay inside the drill directory', t => {
  const f = fixture(t);
  const ok = assertDrillWorkspace({ drillRoot: f.drillRoot, installRoot: f.installRoot, codexHome: f.codexHome });
  assert.equal(ok.installRoot, path.resolve(f.installRoot));
  assert.throws(() => assertDrillWorkspace({ drillRoot: f.drillRoot, installRoot: os.homedir(), codexHome: f.codexHome }), /inside the drill directory/);
  assert.throws(() => assertDrillWorkspace({ drillRoot: f.drillRoot, installRoot: f.installRoot, codexHome: f.temp }), /inside the drill directory/);
  assert.throws(() => assertDrillWorkspace({ drillRoot: f.drillRoot, installRoot: f.installRoot, codexHome: f.installRoot }), /separate directories/);
  assert.throws(() => assertDrillWorkspace({ drillRoot: f.drillRoot, installRoot: f.installRoot, codexHome: f.codexHome, env: { CODEX_HOME: os.homedir() } }), /outside the drill directory/);
  assert.throws(() => assertDrillWorkspace({ drillRoot: path.join(f.temp, 'missing drill'), installRoot: f.installRoot, codexHome: f.codexHome }), /must exist/);
  assert.throws(() => assertDrillWorkspace({ drillRoot: path.parse(f.temp).root, installRoot: f.installRoot, codexHome: f.codexHome }), /inside the drill directory|drive root/);
});

test('isolated drill covers first install, repeat, upgrade and uninstall with the previous skill restored', async t => {
  const f = fixture(t);
  const { archive } = await sealCandidate(f.temp);
  unpack(archive, f.installRoot);
  // A pre-existing personal skill must be backed up and restored by uninstall.
  const personalSkill = path.join(f.codexHome, 'skills', 'workbuddy-executor', 'SKILL.md');
  fs.mkdirSync(path.dirname(personalSkill), { recursive: true });
  fs.writeFileSync(personalSkill, 'personal skill\n');
  const before = setup('plan', { ...f.options });
  assert.equal(before.changed, false);
  assert.equal(fs.existsSync(path.join(f.installRoot, '.env')), false);

  const first = setup('install', { ...f.options });
  assert.equal(first.changed, true);
  const envText = fs.readFileSync(path.join(f.installRoot, '.env'), 'utf8');
  assert.ok(envText.includes('WORKBUDDY_BACKEND="desktop-queue"'));
  assert.equal(fs.readFileSync(personalSkill, 'utf8'), 'fixture SKILL.md\n', 'candidate skill replaced the personal one');

  const repeat = setup('install', { ...f.options });
  assert.equal(repeat.unchanged, true);
  assert.equal(fs.readFileSync(path.join(f.installRoot, '.env'), 'utf8'), envText);

  // A previous personal skill must come back on uninstall.
  const { archive: next } = await sealCandidate(f.temp, { name: 'next', files: {
    'package.json': '{"name":"codex-workbuddy-gateway","version":"0.7.2"}',
    'dist/server.js': 'export {}; // next',
    'dist/setup.js': 'export {};',
    'scripts/install-skill.mjs': fs.readFileSync(path.join(source, 'scripts/install-skill.mjs'), 'utf8'),
    'skills/workbuddy-executor/SKILL.md': 'fixture SKILL.md, next release\n',
  } });
  unpack(next, f.installRoot);
  assert.throws(() => setup('install', { ...f.options }), /upgrade/);
  const upgraded = setup('upgrade', { ...f.options, apply: true });
  assert.equal(upgraded.ok, true);
  assert.equal(fs.readFileSync(path.join(f.installRoot, '.env'), 'utf8'), envText);

  fs.writeFileSync(path.join(f.installRoot, 'data/private-history.txt'), 'keep');
  setup('uninstall', { ...f.options });
  assert.equal(fs.readFileSync(personalSkill, 'utf8'), 'personal skill\n', 'previous skill is restored');
  assert.equal(fs.readFileSync(path.join(f.installRoot, '.env'), 'utf8'), envText);
  assert.equal(fs.readFileSync(path.join(f.installRoot, 'data/private-history.txt'), 'utf8'), 'keep');
});

test('an interrupted upgrade restores the previous skill, snippet and env', async t => {
  const f = fixture(t);
  const { archive } = await sealCandidate(f.temp);
  unpack(archive, f.installRoot);
  setup('install', { ...f.options });
  const skillFile = path.join(f.codexHome, 'skills', 'workbuddy-executor', 'SKILL.md');
  const installedSkill = fs.readFileSync(skillFile, 'utf8');
  const snippet = fs.readFileSync(path.join(f.installRoot, 'data/workbuddy-mcp.toml'), 'utf8');
  const envText = fs.readFileSync(path.join(f.installRoot, '.env'), 'utf8');

  // Next version changes the skill, and its installer fails halfway.
  const { archive: next } = await sealCandidate(f.temp, { name: 'broken', files: {
    'package.json': '{"name":"codex-workbuddy-gateway","version":"0.7.2"}',
    'dist/server.js': 'export {};',
    'dist/setup.js': 'export {};',
    'scripts/install-skill.mjs': 'process.exit(3)',
    'skills/workbuddy-executor/SKILL.md': 'fixture SKILL.md, broken release\n',
  } });
  unpack(next, f.installRoot);
  assert.throws(() => setup('upgrade', { ...f.options }), /Command failed|exit code/i);
  assert.equal(fs.readFileSync(skillFile, 'utf8'), installedSkill, 'previous skill is back');
  assert.equal(fs.readFileSync(path.join(f.installRoot, 'data/workbuddy-mcp.toml'), 'utf8'), snippet);
  assert.equal(fs.readFileSync(path.join(f.installRoot, '.env'), 'utf8'), envText);
  assert.equal(fs.existsSync(path.join(f.installRoot, 'data/setup-in-progress.json')), false, 'lock released');
  // The installation record still points at the version that is actually installed.
  const manifest = JSON.parse(fs.readFileSync(path.join(f.installRoot, 'data/deployment-installation.json'), 'utf8'));
  assert.equal(manifest.skillFiles['SKILL.md'], digest(installedSkill));
});

test('active tasks, unknown stop evidence and a persistent service block the drill install', async t => {
  const f = fixture(t);
  const { archive } = await sealCandidate(f.temp);
  unpack(archive, f.installRoot);
  const dbFile = path.join(f.installRoot, 'data/tasks.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE tasks(state TEXT,attempt_id TEXT)');
  db.prepare('INSERT INTO tasks VALUES(?,?)').run('working', 'run-00000000-0000-0000-0000-000000000001');
  db.close();
  assert.throws(() => setup('install', { ...f.options }), /Unclosed tasks/);
  assert.equal(fs.existsSync(path.join(f.installRoot, '.env')), false);

  const settled = new DatabaseSync(dbFile);
  settled.exec("UPDATE tasks SET state='cancelled'");
  settled.close();
  assert.throws(() => setup('install', { ...f.options }), /stop evidence|unconfirmed/i);
  assert.equal(fs.existsSync(path.join(f.installRoot, '.env')), false);

  fs.writeFileSync(path.join(f.installRoot, 'data/persistent-service.json'), '{}');
  assert.throws(() => setup('install', { ...f.options }), /persistent service/);
  assert.equal(fs.existsSync(path.join(f.installRoot, '.env')), false);
});

test('an empty or truncated candidate is refused with a readable message, never a range error', async t => {
  const f = fixture(t);
  const empty = path.join(f.temp, 'empty.zip');
  fs.writeFileSync(empty, '');
  assert.throws(() => inspectCandidatePackage(empty), /Not a ZIP archive: the file is shorter/);

  const short = path.join(f.temp, 'short.zip');
  fs.writeFileSync(short, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]));
  assert.throws(() => inspectCandidatePackage(short), (error: NodeJS.ErrnoException) => {
    assert.notEqual(error.code, 'ERR_OUT_OF_RANGE');
    assert.match(String(error.message), /Not a ZIP archive/);
    return true;
  });
});

test('an unreadable installed manifest stops the plan instead of skipping managed drift', async t => {
  const f = fixture(t);
  const { archive } = await sealCandidate(f.temp);
  const inspection = inspectCandidatePackage(archive);
  fs.mkdirSync(path.join(f.installRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(f.installRoot, 'data/deployment-installation.json'), '{ this is not json');
  const plan = planCandidateInstallation({ inspection, installRoot: f.installRoot, codexHome: f.codexHome, env: f.env, platform: 'win32' });
  assert.deepEqual(plan.blocked.map(item => item.reason), ['installed_manifest_unreadable']);
  assert.equal(plan.safeToApply, false);
  assert.equal(plan.setupWrites.skill, 'installed', 'an unreadable record cannot be assumed to have drifted');

  fs.writeFileSync(path.join(f.installRoot, 'data/deployment-installation.json'), JSON.stringify({ skillFiles: {}, snippetHash: 'x' }));
  const readable = planCandidateInstallation({ inspection, installRoot: f.installRoot, codexHome: f.codexHome, env: f.env, platform: 'win32' });
  assert.equal(readable.blocked.length, 0);
});
