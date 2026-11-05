#!/usr/bin/env node
/**
 * Read-only candidate inspection and isolated installation drill.
 *
 *   node scripts/candidate-installation.mjs check   --package <zip> [--expect-sha256 <hex>]
 *   node scripts/candidate-installation.mjs preview --package <zip> --install-root <dir> --codex-home <dir>
 *   node scripts/candidate-installation.mjs drill   --package <zip> --drill-root <dir> [--apply]
 *
 * `check` and `preview` never write. `drill` writes only under the explicit
 * drill root it was given; a missing path is an error, never a fallback to the
 * real installation, the real CODEX_HOME or the user profile.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const moduleFile = path.join(root, 'dist', 'installation-readiness.js');
if (!fs.existsSync(moduleFile)) {
  console.error(JSON.stringify({ ok: false, error: 'Build the gateway first: npm run build' }, null, 2));
  process.exit(2);
}
const readiness = await import(`file:///${moduleFile.replaceAll('\\', '/')}`);
const { inspectCandidatePackage, planCandidateInstallation, assertDrillWorkspace, readArchiveMembers, assertArchivePath } = readiness;

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

function inspect(packageFile, expectedSha256) {
  const archive = path.resolve(packageFile);
  if (!fs.existsSync(archive)) fail('Candidate package does not exist.', archive);
  const inspection = inspectCandidatePackage(archive, expectedSha256 ? { expectedSha256 } : {});
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

async function drill(inspection, drillRootInput, options) {
  const drillRoot = path.resolve(drillRootInput);
  const installRoot = path.join(drillRoot, 'installation');
  const codexHome = path.join(drillRoot, 'codex-home');
  const workspace = assertDrillWorkspace({ drillRoot, installRoot, codexHome, env: { ...process.env, CODEX_HOME: codexHome } });
  fs.mkdirSync(workspace.installRoot, { recursive: true });
  fs.mkdirSync(workspace.codexHome, { recursive: true });
  const written = unpackInto(inspection, workspace.installRoot);

  // Synthetic desktop fixtures so the drill never reads the real WorkBuddy install.
  const app = path.join(drillRoot, 'WorkBuddyAI.exe');
  const config = path.join(drillRoot, 'native-config');
  fs.writeFileSync(app, 'drill fixture; never executed');
  fs.mkdirSync(config, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(config, 'workbuddy.db'));
  db.exec('CREATE TABLE IF NOT EXISTS sessions(id TEXT,cwd TEXT,is_playground INTEGER,deleted_at TEXT)');
  db.close();

  const setupModule = await import(`file:///${path.join(root, 'dist', 'setup.js').replaceAll('\\', '/')}`);
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

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    package: { type: 'string' },
    'expect-sha256': { type: 'string' },
    'install-root': { type: 'string' },
    'codex-home': { type: 'string' },
    'drill-root': { type: 'string' },
    report: { type: 'string' },
    apply: { type: 'boolean' },
    json: { type: 'boolean' },
  },
});
const command = parsed.positionals[0];
const values = parsed.values;
if (!command || !['check', 'preview', 'drill'].includes(command)) {
  fail('Usage: candidate-installation.mjs check|preview|drill --package <zip> [--install-root <dir>] [--codex-home <dir>] [--drill-root <dir>] [--apply] [--report <file>]');
}
if (!values.package) fail('--package is required.');

const inspection = inspect(values.package, values['expect-sha256']);
const reportBase = {
  generatedAt: new Date().toISOString(),
  // Deliberately omits the user's home path: reports leave this machine only as summaries.
  host: { platform: process.platform, node: process.versions.node },
  archive: inspection.archive,
  release: inspection.release,
  files: inspection.files,
  totalBytes: inspection.totalBytes,
};

if (command === 'check') {
  const report = { schemaVersion: 'workbuddy-candidate-check/v1', readOnly: true, ...reportBase, ok: inspection.ok, problems: inspection.problems };
  writeReport(report, values.report ?? values['report']);
  console.log(JSON.stringify(report, null, 2));
  process.exit(inspection.ok ? 0 : 1);
}

if (command === 'preview') {
  if (!values['install-root'] || !values['codex-home']) fail('--install-root and --codex-home are required for preview.');
  const plan = planCandidateInstallation({ inspection, installRoot: values['install-root'], codexHome: values['codex-home'], env: process.env, platform: process.platform });
  const report = { schemaVersion: 'workbuddy-candidate-preview/v1', readOnly: true, ...reportBase, plan };
  writeReport(report, values.report ?? values['report']);
  console.log(JSON.stringify(values.json ? report : { ...reportBase, summary: requirementSummary(plan), plan }, null, 2));
  process.exit(plan.safeToApply ? 0 : 1);
}

if (!values['drill-root']) fail('--drill-root is required for drill; there is no fallback to the real installation.');
const drillReport = await drill(inspection, values['drill-root'], { apply: Boolean(values.apply) });
const report = { schemaVersion: 'workbuddy-candidate-drill/v1', readOnly: !values.apply, ...reportBase, drill: drillReport };
writeReport(report, values.report ?? values['report']);
console.log(JSON.stringify(report, null, 2));
process.exit(drillReport.steps.every(step => step.ok) ? 0 : 1);
