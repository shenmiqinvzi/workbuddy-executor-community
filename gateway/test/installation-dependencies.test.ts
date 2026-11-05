import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  diagnoseInstallationDependencies, inspectProductionDependencies, DEPENDENCY_REPORT_SCHEMA,
} from '../src/installation-dependencies.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-dependencies-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const installRoot = path.join(temp, 'installation');
  const config = path.join(temp, 'native config');
  fs.mkdirSync(installRoot, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const db = new DatabaseSync(path.join(config, 'workbuddy.db'));
  db.exec('CREATE TABLE sessions(id TEXT,cwd TEXT,is_playground INTEGER,deleted_at TEXT)');
  db.close();
  const app = path.join(temp, 'WorkBuddyAI.exe');
  fs.writeFileSync(app, 'fixture, never executed');
  return { temp, installRoot, config, app };
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** A root that satisfies every required row, so a single change can be isolated. */
function prepared(t: { after: (fn: () => void) => void }) {
  const f = fixture(t);
  writeJson(path.join(f.installRoot, 'package.json'), { name: 'codex-workbuddy-gateway', version: '0.7.1' });
  writeJson(path.join(f.installRoot, 'package-lock.json'), {
    name: 'codex-workbuddy-gateway',
    packages: { '': { dependencies: { zod: '^3.25.76' } }, 'node_modules/zod': { version: '3.25.76' }, 'node_modules/tsx': { version: '4.20.5', dev: true } },
  });
  writeJson(path.join(f.installRoot, 'node_modules/zod/package.json'), { name: 'zod', version: '3.25.76' });
  for (const name of ['dist/server.js', 'dist/setup.js']) {
    fs.mkdirSync(path.dirname(path.join(f.installRoot, name)), { recursive: true });
    fs.writeFileSync(path.join(f.installRoot, name), 'export {};');
  }
  const probes = {
    dotnet: () => ({ ok: true, runtimes: ['Microsoft.NETCore.App 10.0.1 [C:\\Program Files\\dotnet\\shared]', 'Microsoft.WindowsDesktop.App 10.0.1 [C:\\Program Files\\dotnet\\shared]'] }),
    webview2: () => ({ ok: true, version: '156.0.4314.58' }),
  };
  return { ...f, probes, options: { installRoot: f.installRoot, env: { WORKBUDDY_CLI_ELECTRON: f.app, WORKBUDDY_CONFIG_DIR: f.config }, platform: 'win32' as const, arch: 'x64', nodeVersion: '24.19.0', workbuddyApp: f.app, workbuddyConfig: f.config, probes } };
}

test('a gateway release is reported as incomplete until its build, dependencies and selections exist', t => {
  const f = fixture(t);
  const report = diagnoseInstallationDependencies({
    installRoot: f.installRoot, env: {}, platform: 'win32', arch: 'x64', nodeVersion: '24.19.0',
    probes: { dotnet: () => ({ ok: false, error: 'fixture: dotnet absent' }), webview2: () => ({ ok: false, error: 'fixture: not found' }) },
  });
  assert.equal(report.schemaVersion, DEPENDENCY_REPORT_SCHEMA);
  assert.equal(report.readOnly, true);
  assert.equal(report.offline, true);
  assert.equal(report.networkProbes, 0);
  assert.equal(report.blocksInstall, true);
  const ids = report.gaps.map(item => item.id);
  for (const id of ['gateway_build', 'production_dependencies', 'workbuddy_application', 'workbuddy_data']) assert.ok(ids.includes(id), id);
  const byId = new Map(report.probes.map(probe => [probe.id, probe]));
  assert.equal(byId.get('node_version')?.status, 'ok');
  assert.equal(byId.get('dotnet_desktop_runtime')?.status, 'unknown', 'an unobservable runtime is unknown, never ok');
  assert.ok(report.unknown.includes('dotnet_desktop_runtime'));
  assert.equal(byId.get('code_signing')?.status, 'not_applicable');
  assert.match(String(byId.get('code_signing')?.detail), /unsigned/i);
  assert.equal(byId.get('desktop_shell')?.status, 'not_applicable', 'the gateway release carries no desktop shell');
  assert.equal(report.artifact.kind, 'unknown');
  assert.ok(report.probes.every(probe => probe.remediation === null || typeof probe.remediation === 'string'));
});

test('a prepared root with injected probes has no gaps and blocks nothing', t => {
  const f = prepared(t);
  const report = diagnoseInstallationDependencies(f.options);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.blocksInstall, false);
  assert.deepEqual(report.unknown, []);
  assert.equal(report.productionDependencies.required, 1, 'the dev-only package is not counted');
  assert.equal(report.productionDependencies.present, 1);
  assert.equal(report.artifact.kind, 'source_tree');
  const dotnet = report.probes.find(probe => probe.id === 'dotnet_desktop_runtime');
  assert.equal(dotnet?.status, 'ok');
  assert.equal(dotnet?.observed, '10.0.1');
  assert.equal(report.probes.find(probe => probe.id === 'webview2_runtime')?.observed, '156.0.4314.58');
});

test('a production package of the wrong version is a missing dependency, not a pass', t => {
  const f = fixture(t);
  writeJson(path.join(f.installRoot, 'package-lock.json'), { packages: { 'node_modules/zod': { version: '3.25.76' } } });
  writeJson(path.join(f.installRoot, 'node_modules/zod/package.json'), { version: '9.0.0' });
  const observed = inspectProductionDependencies(f.installRoot);
  assert.equal(observed.required, 1);
  assert.equal(observed.present, 0);
  assert.match(observed.missing.join(' '), /zod@3\.25\.76 \(found 9\.0\.0\)/);

  writeJson(path.join(f.installRoot, 'package-lock.json'), { packages: { 'node_modules/zod': { version: '3.25.76' } } });
  fs.rmSync(path.join(f.installRoot, 'node_modules'), { recursive: true, force: true });
  assert.match(inspectProductionDependencies(f.installRoot).missing.join(' '), /zod@3\.25\.76 \(absent\)/);

  fs.rmSync(path.join(f.installRoot, 'package-lock.json'));
  assert.deepEqual(inspectProductionDependencies(f.installRoot).missing, ['package-lock.json']);
});

test('an unverified architecture and an unsigned release are stated as such', t => {
  const f = prepared(t);
  const arm = diagnoseInstallationDependencies({ ...f.options, arch: 'arm64' });
  assert.equal(arm.probes.find(probe => probe.id === 'architecture')?.status, 'mismatch');
  assert.ok(arm.gaps.some(item => item.id === 'architecture'));
  assert.equal(arm.blocksInstall, true);

  const linux = diagnoseInstallationDependencies({ ...f.options, platform: 'linux' });
  assert.equal(linux.probes.find(probe => probe.id === 'platform')?.status, 'mismatch');
  assert.ok(linux.unknown.includes('dotnet_desktop_runtime') === false, 'an injected probe still answers for its own runtime');
  assert.equal(linux.blocksInstall, true);

  const stale = diagnoseInstallationDependencies({ ...f.options, nodeVersion: '22.12.0' });
  assert.equal(stale.probes.find(probe => probe.id === 'node_version')?.status, 'mismatch');
  assert.ok(stale.gaps.some(item => item.id === 'node_version'));
});
