#!/usr/bin/env node
/**
 * Candidate inspection, dependency diagnosis and isolated installation drills.
 *
 *   node scripts/candidate-installation.mjs check          --package <zip> [--expect-sha256 <hex>]
 *   node scripts/candidate-installation.mjs preview        --package <zip> --install-root <dir> --codex-home <dir>
 *   node scripts/candidate-installation.mjs drill          --package <zip> --drill-root <dir> [--apply]
 *   node scripts/candidate-installation.mjs upgrade-drill  --package <zip> --drill-root <dir> [--apply]
 *   node scripts/candidate-installation.mjs dependencies   --install-root <dir> [--package <zip>] [--workbuddy-app <exe>] [--workbuddy-config <dir>]
 *   node scripts/candidate-installation.mjs version-check  --install-root <dir> --package <zip>
 *   node scripts/candidate-installation.mjs rollback-plan  --package <zip> --to <zip> --install-root <dir> --codex-home <dir>
 *
 * `check`, `preview`, `dependencies`, `version-check` and `rollback-plan` never
 * write into an installation. `drill` and `upgrade-drill` write only under the
 * explicit drill root they were given, using synthetic releases and synthetic
 * WorkBuddy state; a missing path is an error, never a fallback to the real
 * installation, the real CODEX_HOME or the user profile. Neither drill performs
 * a production switch, starts WorkBuddy, calls a model or deploys anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const distFile = name => path.join(root, 'dist', name);
for (const name of ['installation-readiness.js', 'setup.js', 'installation-dependencies.js', 'installation-rollback.js']) {
  if (!fs.existsSync(distFile(name))) {
    console.error(JSON.stringify({ ok: false, error: 'Build the gateway first: npm run build', missing: `dist/${name}` }, null, 2));
    process.exit(2);
  }
}
const load = name => import(`file:///${distFile(name).replaceAll('\\', '/')}`);
const readiness = await load('installation-readiness.js');
const dependenciesModule = await load('installation-dependencies.js');
const rollbackModule = await load('installation-rollback.js');
const { inspectCandidatePackage, planCandidateInstallation, assertDrillWorkspace, readArchiveMembers, assertArchivePath, digest } = readiness;
const { diagnoseInstallationDependencies } = dependenciesModule;
const { identifyInstalledRelease, planVersionRollback } = rollbackModule;
const { zipDirectory } = await import(`file:///${path.join(here, 'zip.mjs').replaceAll('\\', '/')}`);

function fail(message, detail) {
  console.error(JSON.stringify({ ok: false, error: message, detail }, null, 2));
  process.exit(1);
}
function writeReport(report, filename) {
  if (!filename) return;
  const target = path.resolve(filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
}
function sha256File(file) { return digest(fs.readFileSync(file)); }

function inspect(packageFile, expectedSha256) {
  const archive = path.resolve(packageFile);
  if (!fs.existsSync(archive)) fail('Candidate package does not exist.', archive);
  // A truncated or non-ZIP input is a refused candidate, not a crash: the report
  // stays machine readable so the caller can record the failure.
  let inspection;
  try { inspection = inspectCandidatePackage(archive, expectedSha256 ? { expectedSha256 } : {}); }
  catch (error) { fail('Candidate package could not be inspected.', String(error?.message ?? error)); }
  return inspection;
}

function requirementSummary(plan) {
  return {
    safeToApply: plan.safeToApply,
    counts: plan.counts,
    failedRequirements: plan.requirements.filter(item => !item.ok).map(item => ({ id: item.id, detail: item.detail })),
    managedDrift: plan.managedDrift,
    blocked: plan.blocked,
  };
}

function unpackInto(inspection, installRoot) {
  const members = readArchiveMembers(inspection.archive.file);
  const prefix = inspection.release.prefix ? `${inspection.release.prefix}/` : '';
  let written = 0;
  for (const [name, bytes] of members) {
    assertArchivePath(name);
    if (!name.startsWith(prefix)) continue;
    const relative = name.slice(prefix.length);
    if (!relative || relative === 'RELEASE_MANIFEST.json') continue;
    const filename = path.join(installRoot, relative);
    const resolved = path.resolve(filename);
    if (!resolved.startsWith(path.resolve(installRoot) + path.sep)) throw new Error(`Refusing to unpack outside the installation root: ${relative}`);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, bytes);
    written += 1;
  }
  return written;
}

/** Rebuild a candidate archive from an existing one, with explicit edits, under the drill root. */
async function synthesise(inspection, stageRoot, label, options = {}) {
  const prefix = inspection.release.prefix || 'candidate';
  const stage = path.join(stageRoot, `stage-${label}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  const source = readArchiveMembers(inspection.archive.file);
  const basePrefix = `${inspection.release.prefix}/`;
  const edits = options.edits ?? {};
  const drop = new Set(options.drop ?? []);
  const entries = [];
  for (const [name, bytes] of source) {
    const relative = name.slice(basePrefix.length);
    if (!relative || relative === 'RELEASE_MANIFEST.json' || drop.has(relative)) continue;
    const content = edits[relative] === undefined ? bytes : Buffer.from(edits[relative], 'utf8');
    const filename = path.join(stage, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    entries.push({ path: relative, bytes: content.length, sha256: digest(content) });
  }
  for (const [relative, text] of Object.entries(options.add ?? {})) {
    const content = Buffer.from(text, 'utf8');
    const filename = path.join(stage, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
    entries.push({ path: relative, bytes: content.length, sha256: digest(content) });
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const version = options.version ?? inspection.release.version;
  fs.writeFileSync(path.join(stage, 'RELEASE_MANIFEST.json'), JSON.stringify({ project: inspection.release.project, version, files: entries }, null, 2));
  const archive = path.join(stageRoot, `${prefix}-${label}.zip`);
  fs.rmSync(archive, { force: true });
  await zipDirectory(stage, archive, prefix);
  const synthetic = inspectCandidatePackage(archive);
  if (!synthetic.ok) throw new Error(`Synthetic drill release ${label} failed its own check: ${synthetic.problems.join('; ')}`);
  return { archive, inspection: synthetic, version };
}

function syntheticDesktopFixture(drillRoot) {
  // Synthetic desktop fixtures so no drill ever reads the real WorkBuddy install.
  const app = path.join(drillRoot, 'WorkBuddyAI.exe');
  const config = path.join(drillRoot, 'native-config');
  fs.writeFileSync(app, 'drill fixture; never executed');
  fs.mkdirSync(config, { recursive: true });
  return { app, config };
}

async function seedNativeConfig(config) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(config, 'workbuddy.db'));
  db.exec('CREATE TABLE IF NOT EXISTS sessions(id TEXT,cwd TEXT,is_playground INTEGER,deleted_at TEXT)');
  db.close();
}

async function drill(inspection, drillRootInput, options) {
  const drillRoot = path.resolve(drillRootInput);
  const installRoot = path.join(drillRoot, 'installation');
  const codexHome = path.join(drillRoot, 'codex-home');
  const workspace = assertDrillWorkspace({ drillRoot, installRoot, codexHome, env: { ...process.env, CODEX_HOME: codexHome } });
  fs.mkdirSync(workspace.installRoot, { recursive: true });
  fs.mkdirSync(workspace.codexHome, { recursive: true });
  const written = unpackInto(inspection, workspace.installRoot);

  const { app, config } = syntheticDesktopFixture(drillRoot);
  await seedNativeConfig(config);

  const setupModule = await load('setup.js');
  const env = { ...process.env, CODEX_HOME: workspace.codexHome, WORKBUDDY_CLI_ELECTRON: app, WORKBUDDY_CONFIG_DIR: config };
  const base = { root: workspace.installRoot, codexHome: workspace.codexHome, env, platform: 'win32' };
  const steps = [];
  const attempt = (name, fn) => {
    try {
      const value = fn();
      steps.push({ step: name, ok: true, result: value });
      return { ok: true, value };
    } catch (error) {
      steps.push({ step: name, ok: false, error: String(error?.message ?? error) });
      return { ok: false, error };
    }
  };
  const refuse = (name, pattern, fn) => {
    try {
      fn();
      steps.push({ step: name, ok: false, error: 'expected a refusal, the action succeeded' });
      return false;
    } catch (error) {
      const message = String(error?.message ?? error);
      const ok = pattern.test(message);
      steps.push({ step: name, ok, error: ok ? undefined : `refused for a different reason: ${message}`, refusedWith: message });
      return ok;
    }
  };

  attempt('plan', () => setupModule.setup('plan', base));
  if (!options.apply) {
    return { schemaVersion: 'workbuddy-candidate-drill/v1', applied: false, drillRoot, unpacked: written, steps, note: 'Plan only. Re-run with --apply to execute the isolated install drill.' };
  }
  const first = attempt('install', () => setupModule.setup('install', { ...base, apply: true }));
  const repeat = first.ok ? attempt('install_repeat', () => setupModule.setup('install', { ...base, apply: true })) : { ok: false };
  const uninstall = attempt('uninstall', () => setupModule.setup('uninstall', { ...base, apply: true }));
  return {
    schemaVersion: 'workbuddy-candidate-drill/v1',
    applied: true,
    drillRoot,
    unpacked: written,
    steps,
    checks: {
      installed: Boolean(first.ok),
      idempotent: Boolean(first.ok && repeat.ok && repeat.value?.unchanged === true),
      uninstalled: Boolean(uninstall.ok),
      envPreservedAfterUninstall: fs.existsSync(path.join(workspace.installRoot, '.env')),
      skillRemovedAfterUninstall: !fs.existsSync(path.join(workspace.codexHome, 'skills', 'workbuddy-executor')),
    },
  };
}

/**
 * Upgrade, protected-change refusal and rollback, using two synthetic releases
 * derived from the candidate. Proves the difference plan against real bytes.
 */
async function upgradeDrill(inspection, drillRootInput, options) {
  const drillRoot = path.resolve(drillRootInput);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stageRoot = path.join(drillRoot, `upgrade-${stamp}`);
  const installRoot = path.join(stageRoot, 'installation');
  const codexHome = path.join(stageRoot, 'codex-home');
  const workspace = assertDrillWorkspace({ drillRoot, installRoot, codexHome, env: { ...process.env, CODEX_HOME: codexHome } });
  fs.mkdirSync(workspace.installRoot, { recursive: true });
  fs.mkdirSync(workspace.codexHome, { recursive: true });
  const { app, config } = syntheticDesktopFixture(drillRoot);
  await seedNativeConfig(config);
  const setupModule = await load('setup.js');
  const env = { ...process.env, CODEX_HOME: workspace.codexHome, WORKBUDDY_CLI_ELECTRON: app, WORKBUDDY_CONFIG_DIR: config };
  const base = { root: workspace.installRoot, codexHome: workspace.codexHome, env, platform: 'win32' };
  const steps = [];
  const record = (step, ok, detail) => { steps.push({ step, ok, ...detail }); return ok; };

  const skillRelative = 'skills/workbuddy-executor/SKILL.md';
  const serverRelative = 'dist/server.js';
  const newerOnly = 'docs/DRILL_NEWER_ONLY.md';
  const previous = await synthesise(inspection, stageRoot, 'previous', {
    version: `${inspection.release.version}-drillprev`,
    edits: {
      ...(inspection.entries.some(entry => entry.path === skillRelative) ? { [skillRelative]: 'drill legacy skill\n' } : {}),
      ...(inspection.entries.some(entry => entry.path === serverRelative) ? { [serverRelative]: '// drill legacy build\nexport {};\n' } : {}),
    },
  });
  const next = await synthesise(inspection, stageRoot, 'next', {
    version: `${inspection.release.version}-drillnext`,
    add: { [newerOnly]: 'added by the newer release; a downgrade must remove it\n' },
  });

  if (!options.apply) {
    return {
      schemaVersion: 'workbuddy-upgrade-drill/v1', applied: false, drillRoot: stageRoot,
      synthetic: { previous: previously(previous), next: previously(next) },
      steps, note: 'Plan only: synthetic releases were prepared but nothing was installed. Re-run with --apply.',
    };
  }

  unpackInto(previous.inspection, workspace.installRoot);
  const install = (() => { try { return { ok: true, value: setupModule.setup('install', { ...base, apply: true }) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; } })();
  record('install_previous', install.ok, install.ok ? { version: previous.version } : { error: install.error });
  const repeat = install.ok ? (() => { try { return { ok: true, value: setupModule.setup('install', { ...base, apply: true }) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; } })() : { ok: false };
  record('repeat_install_is_idempotent', Boolean(repeat.ok && repeat.value?.unchanged === true), { unchanged: repeat.value?.unchanged ?? null });

  unpackInto(next.inspection, workspace.installRoot);
  let refused = false;
  try { setupModule.setup('install', { ...base, apply: true }); }
  catch (error) { refused = /upgrade/i.test(String(error?.message ?? error)); }
  record('install_on_installed_root_is_refused', refused, {});
  const upgraded = (() => { try { return { ok: true, value: setupModule.setup('upgrade', { ...base, apply: true }) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; } })();
  record('upgrade_applies', upgraded.ok, upgraded.ok ? { unchanged: upgraded.value?.unchanged ?? null } : { error: upgraded.error });
  const addedFile = path.join(workspace.installRoot, newerOnly);
  record('newer_file_present_after_upgrade', fs.existsSync(addedFile), {});
  const serverBytes = fs.readFileSync(path.join(workspace.installRoot, serverRelative));
  record('gateway_file_is_newer_bytes', digest(serverBytes) === next.inspection.entries.find(entry => entry.path === serverRelative)?.sha256, {});

  // A protected local edit must stop the installer instead of being overwritten.
  const skillFile = path.join(workspace.codexHome, 'skills', 'workbuddy-executor', 'SKILL.md');
  if (fs.existsSync(skillFile)) fs.appendFileSync(skillFile, '\nlocal edit that must be protected\n');
  let protectedRefusal = false;
  try { setupModule.setup('upgrade', { ...base, apply: true }); }
  catch (error) { protectedRefusal = /local changes/i.test(String(error?.message ?? error)); }
  record('local_skill_change_is_refused', protectedRefusal, {});
  // Restore the installed bytes exactly as the release published them, so the
  // drill does not turn its own fixture into an unresolved local change.
  if (fs.existsSync(skillFile)) {
    const installedSkill = readArchiveMembers(next.inspection.archive.file).get(`${next.inspection.release.prefix}/${skillRelative}`);
    if (installedSkill) fs.writeFileSync(skillFile, installedSkill);
  }
  record('protected_change_removed_for_the_drill', fs.existsSync(skillFile), {});

  const plan = planVersionRollback({ installRoot: workspace.installRoot, codexHome: workspace.codexHome, current: next.inspection, target: previous.inspection, env });
  record('rollback_plan_is_read_only', plan.readOnly === true && plan.safeToApply === true, { counts: plan.counts, schema: plan.schema.assessment.decision });

  const operations = rollbackModule.rollbackOperations(plan);
  let applied = { ok: false, error: operations.apply ? 'not attempted' : operations.reason };
  if (operations.apply) {
    try {
      const members = readArchiveMembers(previous.inspection.archive.file);
      const prefix = `${previous.inspection.release.prefix}/`;
      for (const relative of operations.write) {
        const bytes = members.get(`${prefix}${relative}`);
        if (!bytes) throw new Error(`Synthetic previous release lacks ${relative}`);
        const filename = path.join(workspace.installRoot, relative);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, bytes);
      }
      for (const relative of operations.remove) {
        const filename = path.join(workspace.installRoot, relative);
        const expected = next.inspection.entries.find(entry => entry.path === relative)?.sha256;
        if (expected && sha256File(filename) !== expected) throw new Error(`Refusing to remove a locally changed file: ${relative}`);
        fs.rmSync(filename);
      }
      const reconciled = setupModule.setup('upgrade', { ...base, apply: true });
      applied = { ok: true, unchanged: reconciled.unchanged ?? null };
    } catch (error) { applied = { ok: false, error: String(error?.message ?? error) }; }
  }
  record('rollback_applies', applied.ok, applied.error ? { error: applied.error } : {});
  record('rolled_back_gateway_bytes', digest(fs.readFileSync(path.join(workspace.installRoot, serverRelative))) === previous.inspection.entries.find(entry => entry.path === serverRelative)?.sha256, {});
  record('newer_file_removed_by_rollback', !fs.existsSync(addedFile), {});
  record('skill_restored_to_previous', fs.readFileSync(skillFile, 'utf8') === 'drill legacy skill\n', {});

  const envFile = path.join(workspace.installRoot, '.env');
  const envText = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : null;
  fs.mkdirSync(path.join(workspace.installRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(workspace.installRoot, 'data/drill-history.txt'), 'keep');
  const uninstall = (() => { try { return { ok: true, value: setupModule.setup('uninstall', { ...base, apply: true }) }; } catch (error) { return { ok: false, error: String(error?.message ?? error) }; } })();
  record('uninstall_after_downgrade', uninstall.ok, uninstall.ok ? {} : { error: uninstall.error });
  record('env_preserved_after_uninstall', envText !== null && fs.existsSync(envFile) && fs.readFileSync(envFile, 'utf8') === envText, {});
  record('history_preserved_after_uninstall', fs.readFileSync(path.join(workspace.installRoot, 'data/drill-history.txt'), 'utf8') === 'keep', {});
  record('skill_removed_after_uninstall', !fs.existsSync(path.join(workspace.codexHome, 'skills', 'workbuddy-executor')), {});

  return {
    schemaVersion: 'workbuddy-upgrade-drill/v1',
    applied: true,
    drillRoot: stageRoot,
    synthetic: { previous: previously(previous), next: previously(next) },
    steps,
    rollbackPlan: { counts: plan.counts, blocked: plan.blocked, schema: plan.schema.assessment.decision, runtimeTarget: plan.runtimeTarget.packageVersionAfter, steps: plan.steps },
    checks: Object.fromEntries(steps.map(step => [step.step, step.ok])),
    note: 'Both releases are synthetic derivatives of the candidate and every path stays inside the drill root. No production switch, service change, model call or real WorkBuddy installation is involved.',
  };
}

function previously(synthetic) {
  return { file: synthetic.archive, version: synthetic.version, sha256: synthetic.inspection.archive.sha256, files: synthetic.inspection.files };
}

/** Busy service, unclosed task, unconfirmed stop, missing build: each must be refused. */
async function drillNegatives(inspection, drillRootInput) {
  const drillRoot = path.resolve(drillRootInput);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(drillRoot, `negatives-${stamp}`);
  const setupModule = await load('setup.js');
  const { DatabaseSync } = await import('node:sqlite');
  const cases = [];
  const make = async name => {
    const dir = path.join(base, name);
    const installRoot = path.join(dir, 'installation');
    const codexHome = path.join(dir, 'codex-home');
    fs.mkdirSync(installRoot, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    assertDrillWorkspace({ drillRoot: base, installRoot, codexHome, env: { ...process.env, CODEX_HOME: codexHome } });
    const { app, config } = syntheticDesktopFixture(dir);
    await seedNativeConfig(config);
    return { dir, installRoot, codexHome, app, config };
  };
  const run = (name, pattern, setupFn) => {
    try { setupFn(); cases.push({ case: name, ok: false, error: 'expected a refusal, the action succeeded' }); }
    catch (error) {
      const message = String(error?.message ?? error);
      cases.push({ case: name, ok: pattern.test(message), refusedWith: message });
    }
  };
  const opts = item => ({ root: item.installRoot, codexHome: item.codexHome, platform: 'win32', env: { ...process.env, CODEX_HOME: item.codexHome, WORKBUDDY_CLI_ELECTRON: item.app, WORKBUDDY_CONFIG_DIR: item.config }, apply: true });

  // Missing build: no dist/server.js in the target root.
  const buildCase = await make('missing-build');
  run('missing_gateway_build', /Build the gateway/i, () => setupModule.setup('install', opts(buildCase)));

  // A persistent service registered against this installation.
  const serviceCase = await make('persistent-service');
  unpackInto(inspection, serviceCase.installRoot);
  fs.mkdirSync(path.join(serviceCase.installRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(serviceCase.installRoot, 'data/persistent-service.json'), '{}');
  run('registered_service_blocks_install', /persistent service/i, () => setupModule.setup('install', opts(serviceCase)));

  // An unclosed task record.
  const openCase = await make('unclosed-task');
  unpackInto(inspection, openCase.installRoot);
  fs.mkdirSync(path.join(openCase.installRoot, 'data'), { recursive: true });
  const openDb = new DatabaseSync(path.join(openCase.installRoot, 'data/tasks.sqlite'));
  openDb.exec('CREATE TABLE tasks(state TEXT,attempt_id TEXT)');
  openDb.prepare('INSERT INTO tasks VALUES(?,?)').run('working', 'run-00000000-0000-0000-0000-000000000001');
  openDb.close();
  run('unclosed_task_blocks_install', /Unclosed tasks/i, () => setupModule.setup('install', opts(openCase)));

  // A finished task without native stop evidence.
  const stopCase = await make('unconfirmed-stop');
  unpackInto(inspection, stopCase.installRoot);
  fs.mkdirSync(path.join(stopCase.installRoot, 'data'), { recursive: true });
  const stopDb = new DatabaseSync(path.join(stopCase.installRoot, 'data/tasks.sqlite'));
  stopDb.exec('CREATE TABLE tasks(state TEXT,attempt_id TEXT)');
  stopDb.prepare('INSERT INTO tasks VALUES(?,?)').run('cancelled', 'run-00000000-0000-0000-0000-000000000002');
  stopDb.close();
  run('unconfirmed_stop_blocks_install', /stop evidence|unconfirmed/i, () => setupModule.setup('install', opts(stopCase)));

  // A truncated candidate archive is refused with a readable message.
  const truncated = path.join(base, 'truncated.zip');
  fs.writeFileSync(truncated, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
  try { inspectCandidatePackage(truncated); cases.push({ case: 'truncated_archive', ok: false, error: 'expected a refusal' }); }
  catch (error) {
    const code = error?.code;
    cases.push({ case: 'truncated_archive', ok: code !== 'ERR_OUT_OF_RANGE' && /Not a ZIP archive/i.test(String(error?.message)), refusedWith: String(error?.message ?? error) });
  }
  cases.push({ case: 'digest_mismatch_reported', ok: inspect(inspection.archive.file, 'f'.repeat(64)).ok === false });
  return { base, cases, ok: cases.every(item => item.ok) };
}

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    package: { type: 'string' },
    to: { type: 'string' },
    'expect-sha256': { type: 'string' },
    'install-root': { type: 'string' },
    'codex-home': { type: 'string' },
    'drill-root': { type: 'string' },
    'workbuddy-app': { type: 'string' },
    'workbuddy-config': { type: 'string' },
    'task-db': { type: 'string' },
    arch: { type: 'string' },
    platform: { type: 'string' },
    report: { type: 'string' },
    apply: { type: 'boolean' },
    json: { type: 'boolean' },
  },
});
const command = parsed.positionals[0];
const values = parsed.values;
const commands = ['check', 'preview', 'drill', 'upgrade-drill', 'dependencies', 'version-check', 'rollback-plan'];
if (!command || !commands.includes(command)) {
  fail(`Usage: candidate-installation.mjs ${commands.join('|')} [--package <zip>] [--to <zip>] [--install-root <dir>] [--codex-home <dir>] [--drill-root <dir>] [--apply] [--report <file>]`);
}
const needsPackage = ['check', 'preview', 'drill', 'upgrade-drill', 'version-check', 'rollback-plan'].includes(command);
if (needsPackage && !values.package) fail('--package is required.');

const host = { platform: process.platform, arch: process.arch, node: process.versions.node };
const reportHeader = { generatedAt: new Date().toISOString(), host };

if (command === 'dependencies') {
  if (!values['install-root']) fail('--install-root is required for dependencies; there is no fallback to a real installation.');
  const report = {
    schemaVersion: 'workbuddy-candidate-dependencies/v1',
    readOnly: true,
    ...reportHeader,
    artifact: values.package ? { file: path.resolve(values.package) } : null,
    diagnosis: diagnoseInstallationDependencies({
      installRoot: values['install-root'],
      env: process.env,
      platform: values.platform ?? process.platform,
      arch: values.arch ?? process.arch,
      workbuddyApp: values['workbuddy-app'],
      workbuddyConfig: values['workbuddy-config'],
      ...(values.package ? { inspection: inspect(values.package, values['expect-sha256']) } : {}),
    }),
    note: '--platform/--arch only relabel the observation for triage; they never widen what the installer accepts.',
  };
  writeReport(report, values.report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.diagnosis.blocksInstall ? 1 : 0);
}

const inspection = inspect(values.package, values['expect-sha256']);
const reportBase = {
  ...reportHeader,
  // Deliberately omits the user's home path: reports leave this machine only as summaries.
  archive: inspection.archive,
  release: inspection.release,
  files: inspection.files,
  totalBytes: inspection.totalBytes,
};

if (command === 'check') {
  const report = { schemaVersion: 'workbuddy-candidate-check/v1', readOnly: true, ...reportBase, ok: inspection.ok, problems: inspection.problems };
  writeReport(report, values.report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(inspection.ok ? 0 : 1);
}

if (command === 'preview') {
  if (!values['install-root'] || !values['codex-home']) fail('--install-root and --codex-home are required for preview.');
  const plan = planCandidateInstallation({ inspection, installRoot: values['install-root'], codexHome: values['codex-home'], env: process.env, platform: process.platform });
  const report = { schemaVersion: 'workbuddy-candidate-preview/v1', readOnly: true, ...reportBase, plan };
  writeReport(report, values.report);
  console.log(JSON.stringify(values.json ? report : { ...reportBase, summary: requirementSummary(plan), plan }, null, 2));
  process.exit(plan.safeToApply ? 0 : 1);
}

if (command === 'version-check') {
  if (!values['install-root']) fail('--install-root is required for version-check.');
  const identities = identifyInstalledRelease(path.resolve(values['install-root']), [inspection]);
  const report = { schemaVersion: 'workbuddy-candidate-version-check/v1', readOnly: true, ...reportBase, identities, matches: identities.some(item => item.exact) };
  writeReport(report, values.report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.matches ? 0 : 1);
}

if (command === 'rollback-plan') {
  if (!values.to) fail('--to is required for rollback-plan: the older release must be named explicitly.');
  if (!values['install-root'] || !values['codex-home']) fail('--install-root and --codex-home are required for rollback-plan.');
  const target = inspect(values.to);
  const plan = planVersionRollback({
    installRoot: values['install-root'], codexHome: values['codex-home'],
    current: inspection, target, env: process.env,
    ...(values['task-db'] ? { taskDatabase: values['task-db'] } : {}),
  });
  const report = {
    schemaVersion: 'workbuddy-candidate-rollback/v1', readOnly: true, ...reportHeader,
    from: { file: inspection.archive.file, version: inspection.release.version, sha256: inspection.archive.sha256 },
    to: { file: target.archive.file, version: target.release.version, sha256: target.archive.sha256, ok: target.ok, problems: target.problems },
    plan,
  };
  writeReport(report, values.report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(plan.safeToApply ? 0 : 1);
}

if (command === 'drill' || command === 'upgrade-drill') {
  if (!values['drill-root']) fail(`--drill-root is required for ${command}; there is no fallback to the real installation.`);
  let drillReport;
  let negatives;
  try {
    drillReport = command === 'drill'
      ? await drill(inspection, values['drill-root'], { apply: Boolean(values.apply) })
      : await upgradeDrill(inspection, values['drill-root'], { apply: Boolean(values.apply) });
    negatives = values.apply ? await drillNegatives(inspection, values['drill-root']) : null;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), `Drill stopped before producing a report; nothing outside ${values['drill-root']} was touched.`);
  }
  const report = {
    schemaVersion: command === 'drill' ? 'workbuddy-candidate-drill/v1' : 'workbuddy-upgrade-drill/v1',
    readOnly: !values.apply, ...reportBase,
    drill: drillReport,
    ...(negatives ? { negatives } : {}),
  };
  writeReport(report, values.report);
  console.log(JSON.stringify(report, null, 2));
  const stepsOk = drillReport.steps.every(step => step.ok);
  process.exit(stepsOk && (!negatives || negatives.ok) ? 0 : 1);
}
