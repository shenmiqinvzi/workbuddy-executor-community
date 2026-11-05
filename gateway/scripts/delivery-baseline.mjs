#!/usr/bin/env node
// Read-only observations, never an installation or dispatch preflight approval.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const boundedText = value => typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const failure = error => ({ status: error?.code === 'ENOENT' ? 'absent' : 'unreadable', code: ['ENOENT', 'EPERM', 'EACCES', 'ENOTDIR', 'EISDIR'].includes(error?.code) ? error.code : 'READ_FAILED' });

function bytes(file, limit = 16 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Object.assign(new Error('input refused'), { code: 'INPUT_REFUSED' });
  return fs.readFileSync(file);
}
function json(file) {
  if (!file) return { status: 'not_supplied' };
  try { return { status: 'observed', value: JSON.parse(bytes(file, 1024 * 1024).toString('utf8')) }; }
  catch (error) { return error instanceof SyntaxError ? { status: 'invalid', code: 'INVALID_JSON' } : failure(error); }
}
function fingerprint(file, limit) {
  try { const value = bytes(file, limit); return { status: 'observed', sha256: sha(value), bytes: value.length }; }
  catch (error) { return failure(error); }
}

// Only release-code paths may be hashed. A supplied manifest cannot turn this
// command into a reader of live .env, databases, MCP config or account files.
function publicPath(value) {
  if (typeof value !== 'string' || !/^[\w./-]+$/.test(value) || value.split('/').some(x => !x || x === '.' || x === '..')) return false;
  if (value.split('/').some(x => ['data', 'outputs', 'logs', 'node_modules', '.git', '.codex', '.workbuddy', 'accounts'].includes(x))) return false;
  if (['.env.example', '.gitignore', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'WINDOWS_ENV.example', 'README.md', 'RESTORE.md'].includes(value)) return true;
  return /^(?:src|test)\/[\w./-]+\.ts$/.test(value)
    || /^dist\/[\w./-]+\.(?:js|js\.map|d\.ts)$/.test(value)
    || /^scripts\/[\w./-]+\.(?:mjs|ps1)$/.test(value)
    || /^(?:workbench|skills|deepseek-plugin|desktop|docs)\/[\w./-]+\.(?:mjs|js|css|html|md|yaml|yml|json|cs|csproj|manifest|ico|txt|woff2|patch\.yml|d\.mts)$/.test(value)
    || /^bin\/workbuddy-[\w-]+(?:\.cmd)?$/.test(value)
    || ['bin/deepseek-gateway', 'bin/agent-hub', 'bin/agent-hub-mcp', 'test/support/typescript-loader.mjs', 'test/support/read-zip.mjs'].includes(value);
}
function manifest(file) {
  const input = json(file);
  if (input.status !== 'observed') return input;
  const value = input.value;
  if (!value || value.project !== 'codex-workbuddy-gateway' || !Array.isArray(value.files) || !value.files.length || value.files.length > 2000) return { status: 'invalid', code: 'INVALID_MANIFEST' };
  const seen = new Set();
  for (const entry of value.files) {
    if (!entry || !publicPath(entry.path) || !hex(entry.sha256) || seen.has(entry.path)) return { status: 'invalid', code: 'UNSAFE_MANIFEST' };
    seen.add(entry.path);
  }
  return { status: 'observed', version: boundedText(value.version), files: value.files.map(({ path, sha256 }) => ({ path, sha256 })) };
}
function compare(root, expected, sourceOnly = false) {
  if (!root) return { status: 'not_supplied' };
  if (expected.status !== 'observed') return { status: 'unavailable', code: 'CANDIDATE_MANIFEST_UNAVAILABLE' };
  const result = { status: 'observed', compared: 0, matched: 0, changed: [], absent: [], unreadable: [] };
  for (const entry of expected.files) {
    if (sourceOnly && entry.path.startsWith('dist/')) continue;
    const actual = fingerprint(path.join(root, entry.path));
    result.compared++;
    if (actual.status === 'absent') result.absent.push(entry.path);
    else if (actual.status !== 'observed') result.unreadable.push({ file: entry.path, code: actual.code });
    else if (actual.sha256 === entry.sha256) result.matched++;
    else result.changed.push(entry.path);
  }
  return result;
}
function sourceVersion(root) {
  if (!root) return { status: 'not_supplied' };
  try {
    const options = { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], options).trim();
    const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], options).trim();
    const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain'], options).length > 0;
    return { status: 'observed', head: /^[a-f0-9]{40}$/.test(head) ? head : null, branch: boundedText(branch), dirty };
  } catch { return { status: 'unavailable', code: 'GIT_UNAVAILABLE' }; }
}
function runtimeCodeHash(root) {
  if (!root) return { status: 'not_supplied' };
  const directory = path.join(root, 'dist'), files = [];
  try {
    function visit(current) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('linked runtime');
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('linked runtime');
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.name.endsWith('.js')) files.push(file);
        if (files.length > 2000) throw new Error('runtime too large');
      }
    }
    visit(directory);
    if (!files.length) return { status: 'unavailable', code: 'NO_RUNTIME_FILES' };
    const hash = crypto.createHash('sha256');
    for (const file of files.sort()) hash.update(path.relative(directory, file).replaceAll('\\', '/')).update(bytes(file));
    return { status: 'observed', codeHash: hash.digest('hex'), files: files.length };
  } catch (error) { return failure(error); }
}

export function readPolicyDatabase(file, scratchRoot) {
  if (!file) return { status: 'not_supplied', policy: null, capacity: { status: 'unknown' } };
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'invalid', policy: null, capacity: { status: 'unknown' } }; }
  catch (error) { return { ...failure(error), policy: null, capacity: { status: 'unknown' } }; }
  if (!scratchRoot || !path.isAbsolute(scratchRoot)) return { status: 'unavailable', code: 'POLICY_SCRATCH_REQUIRED', policy: null, capacity: { status: 'unknown' } };
  let db, scratch, realScratchRoot, result;
  try {
    // SQLite OPEN_READONLY can still update the source WAL shared-memory read
    // marks. Open only an owned temporary copy, never the source database.
    realScratchRoot = fs.realpathSync(scratchRoot);
    let ancestor = path.resolve(scratchRoot);
    while (true) {
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('linked scratch');
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const readStore = () => {
      // A rollback journal can hold the committed state while the database
      // contains uncommitted pages. Refuse it rather than copying a false view.
      try { if (fs.lstatSync(`${file}-journal`).size > 0) throw new Error('rollback journal present'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const database = bytes(file, 64 * 1024 * 1024);
      let wal = null;
      try { wal = bytes(`${file}-wal`, 64 * 1024 * 1024); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { database, wal };
    };
    const first = readStore(), second = readStore();
    if (!first.database.equals(second.database) || (first.wal === null) !== (second.wal === null) || (first.wal !== null && !first.wal.equals(second.wal))) return { status: 'unavailable', code: 'POLICY_SOURCE_CHANGED', policy: null, capacity: { status: 'unknown' } };
    scratch = fs.mkdtempSync(path.join(realScratchRoot, 'delivery-baseline-policy-'));
    const copy = path.join(scratch, 'snapshot.sqlite');
    fs.writeFileSync(copy, first.database, { flag: 'wx', mode: 0o600 });
    if (first.wal !== null) fs.writeFileSync(`${copy}-wal`, first.wal, { flag: 'wx', mode: 0o600 });
    db = new DatabaseSync(copy, { readOnly: true });
    db.exec('BEGIN');
    const has = name => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
    let policy = { status: 'not_recorded' };
    if (has('collaboration_policy')) {
      const row = db.prepare('SELECT body_json,digest FROM collaboration_policy WHERE id=1').get();
      if (row) {
        const value = JSON.parse(String(row.body_json));
        if (sha(JSON.stringify(value)) !== row.digest) policy = { status: 'invalid', code: 'POLICY_INTEGRITY' };
        else if (!value || !['user_choice', 'allowlist', undefined].includes(value.selectionMode) || typeof value.requireFree !== 'boolean' || !Array.isArray(value.allowed) || value.allowed.length > 100) policy = { status: 'invalid', code: 'POLICY_SHAPE' };
        else policy = {
          status: 'observed', version: boundedText(value.version), selectionMode: value.selectionMode ?? 'allowlist', selectionModeStored: value.selectionMode !== undefined,
          requireFree: value.requireFree, maxAttempts: positive(value.maxAttempts), maxTimeoutSeconds: positive(value.maxTimeoutSeconds),
          allowed: value.allowed.map(item => ({ executorId: ['workbuddy', 'dsh'].includes(item.executorId) ? item.executorId : null, connectionId: boundedText(item.connectionId), providerId: boundedText(item.providerId), modelId: boundedText(item.modelId), reasoningEffort: boundedText(item.reasoningEffort) })),
        };
      }
    }
    const occupant = has('workflow_capacity') ? db.prepare('SELECT slot FROM workflow_capacity WHERE slot=1').get() : undefined;
    const capacity = { status: !has('workflow_capacity') ? 'unknown' : occupant ? 'recorded_occupant' : 'no_saved_occupant', closureEvaluated: false };
    db.exec('ROLLBACK');
    return result = { status: 'observed', policy, capacity, effectivePolicyVerified: false, sourceReadMethod: 'stable_db_wal_copy', sourceDatabaseOpened: false, sourceSnapshotIsAtomic: false };
  } catch { return result = { status: 'unreadable', code: 'POLICY_STORE_UNAVAILABLE', policy: null, capacity: { status: 'unknown' } }; }
  finally {
    try {
      db?.close();
      // This is the unique directory created above, never a caller directory.
      if (scratch && path.dirname(scratch) === realScratchRoot && path.basename(scratch).startsWith('delivery-baseline-policy-')) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
    } catch {
      if (result) { result.status = 'unavailable'; result.code = 'POLICY_SCRATCH_CLEANUP_FAILED'; result.policy = null; result.capacity = { status: 'unknown' }; }
    }
  }
}

const FLAG_NAMES = ['WORKBUDDY_BACKEND', 'WORKBUDDY_REQUIRED_FREE_MODEL', 'WORKBUDDY_REQUIRE_ZERO_RATE', 'WORKBUDDY_MAX_TASK_ATTEMPTS', 'WORKBUDDY_TASK_TIMEOUT_SECONDS', 'WORKBUDDY_DESKTOP_DISPATCH_ENABLED', 'WORKBUDDY_DSH_ENABLED'];
function flags(file) {
  const input = json(file);
  if (input.status !== 'observed') return input;
  const value = input.value?.fields;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid', code: 'INVALID_FLAGS_SNAPSHOT' };
  return { status: 'observed', source: boundedText(input.value.source), fields: Object.fromEntries(FLAG_NAMES.filter(key => Object.hasOwn(value, key)).map(key => [key, boundedText(value[key])])), effectivePolicyVerified: false };
}
function runtime(value) {
  return value && typeof value === 'object' ? { release: boundedText(value.release), packageVersion: boundedText(value.packageVersion), pid: positive(value.pid), startedAt: iso(value.startedAt), codeHash: hex(value.codeHash) } : null;
}
function runtimeSnapshot(file) {
  const input = json(file);
  if (input.status !== 'observed') return input;
  if (!input.value || typeof input.value !== 'object' || Array.isArray(input.value)) return { status: 'invalid', code: 'INVALID_RUNTIME_SNAPSHOT' };
  return { status: 'observed', collectedAt: iso(input.value?.collectedAt), runtime: runtime(input.value?.runtime), online: typeof input.value?.online === 'boolean' ? input.value.online : null, ready: typeof input.value?.ready === 'boolean' ? input.value.ready : null, serviceInstalled: typeof input.value?.persistentService?.installed === 'boolean' ? input.value.persistentService.installed : null };
}
function serviceSnapshot(file, installedRoot, database) {
  const input = json(file);
  if (input.status !== 'observed') return input;
  const value = input.value;
  if (!value || value.version !== 1 || typeof value.projectDir !== 'string' || typeof value.dbFile !== 'string') return { status: 'invalid', code: 'INVALID_SERVICE_REGISTRATION', loadedCodeVerified: false };
  const same = (left, right) => right ? path.resolve(left) === path.resolve(right) : null;
  return { status: 'observed', kind: 'disk_registration', version: 1, installedAt: iso(value.installedAt), gatewayMatchesInstalled: same(value.projectDir, installedRoot), databaseMatchesConfigured: same(value.dbFile, database), runtime: null, loadedCodeVerified: false };
}
function desktopSnapshot(file) {
  const input = json(file);
  if (input.status !== 'observed') return input;
  if (input.value?.queryStatus !== 'observed') return { status: 'unavailable', code: 'PROCESS_QUERY_UNAVAILABLE' };
  if (!Array.isArray(input.value?.processes) || input.value.processes.length > 100) return { status: 'invalid', code: 'INVALID_PROCESS_SNAPSHOT' };
  return { status: 'observed', collectedAt: iso(input.value.collectedAt), processes: input.value.processes.map(item => ({ pid: positive(item.pid), startedAt: iso(item.startedAt), fileHash: hex(item.fileHash), classification: ['installed_desktop', 'other_desktop'].includes(item.classification) ? item.classification : 'unknown', gatewayTarget: ['installed_gateway', 'other_gateway', 'unspecified'].includes(item.gatewayTarget) ? item.gatewayTarget : 'unknown', databaseTarget: ['configured_mcp_database', 'other_database', 'unspecified'].includes(item.databaseTarget) ? item.databaseTarget : 'unknown', loadedCodeVerified: false })) };
}

export function captureDeliveryBaseline(options = {}) {
  const candidate = manifest(options.candidateManifest);
  const candidateRuntime = runtimeCodeHash(options.candidateRoot), installedRuntime = runtimeCodeHash(options.installedRoot), mcp = runtimeSnapshot(options.runtimeSnapshot);
  const packageInput = options.installedRoot ? json(path.join(options.installedRoot, 'package.json')) : { status: 'not_supplied' };
  const skillFiles = ['SKILL.md', 'agents/openai.yaml', 'references/agent-hub.md', 'references/dispatch.md', 'references/execution.md', 'references/setup.md'];
  return {
    schemaVersion: 'workbuddy-executor/delivery-baseline-1', observedAt: new Date().toISOString(), readOnly: true, authorizesDispatch: false,
    source: { ...sourceVersion(options.sourceRoot), candidateSourceFiles: compare(options.sourceRoot && path.join(options.sourceRoot, 'gateway'), candidate, true) },
    candidate: { status: candidate.status, code: candidate.code ?? null, version: candidate.version ?? null, files: candidate.files?.length ?? null, expandedFiles: compare(options.candidateRoot, candidate), runtime: candidateRuntime, archive: options.candidateArchive ? (/\.zip$/i.test(options.candidateArchive) ? fingerprint(options.candidateArchive, 256 * 1024 * 1024) : { status: 'invalid', code: 'ZIP_REQUIRED' }) : { status: 'not_supplied' } },
    installed: { package: { status: packageInput.status, version: packageInput.status === 'observed' ? boundedText(packageInput.value?.version) : null }, candidateFiles: compare(options.installedRoot, candidate), runtime: installedRuntime },
    skills: skillFiles.map(file => {
      const source = options.sourceRoot ? fingerprint(path.join(options.sourceRoot, file)) : { status: 'not_supplied' };
      const bundle = options.sourceRoot ? fingerprint(path.join(options.sourceRoot, 'gateway/skills/workbuddy-executor', file)) : { status: 'not_supplied' };
      const installed = options.skillRoot ? fingerprint(path.join(options.skillRoot, file)) : { status: 'not_supplied' };
      return { file, source: source.status, bundle: bundle.status, installed: installed.status, sourceBundleEqual: source.status === 'observed' && bundle.status === 'observed' ? source.sha256 === bundle.sha256 : null, sourceInstalledEqual: source.status === 'observed' && installed.status === 'observed' ? source.sha256 === installed.sha256 : null };
    }),
    policyDatabase: readPolicyDatabase(options.database, options.policyScratchRoot), deploymentFlags: flags(options.flagsSnapshot), mcp, service: serviceSnapshot(options.serviceState, options.installedRoot, options.database), desktop: desktopSnapshot(options.desktopSnapshot),
    runtimeComparison: { mcpMatchesInstalledDisk: mcp.runtime?.codeHash && installedRuntime.codeHash ? mcp.runtime.codeHash === installedRuntime.codeHash : null, mcpMatchesCandidate: mcp.runtime?.codeHash && candidateRuntime.codeHash ? mcp.runtime.codeHash === candidateRuntime.codeHash : null },
    limitations: ['observations_are_not_dispatch_authorization', 'disk_files_do_not_prove_loaded_code', 'stored_policy_is_not_all_historical_task_policies', 'capacity_row_is_not_a_native_stop_proof', 'caller_supplied_snapshots_require_provenance'],
  };
}

export function main(argv = process.argv.slice(2)) {
  const names = { '--source-root': 'sourceRoot', '--candidate-manifest': 'candidateManifest', '--candidate-root': 'candidateRoot', '--candidate-archive': 'candidateArchive', '--installed-root': 'installedRoot', '--skill-root': 'skillRoot', '--database': 'database', '--policy-scratch-root': 'policyScratchRoot', '--flags-snapshot': 'flagsSnapshot', '--runtime-snapshot': 'runtimeSnapshot', '--service-state': 'serviceState', '--desktop-snapshot': 'desktopSnapshot' };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!names[argv[index]] || !argv[index + 1] || argv[index + 1].startsWith('--') || Object.hasOwn(options, names[argv[index]])) {
      process.stderr.write('Use explicit delivery-baseline input paths; unknown, duplicate or incomplete options are refused.\n');
      return 2;
    }
    options[names[argv[index]]] = path.resolve(argv[index + 1]);
  }
  process.stdout.write(`${JSON.stringify(captureDeliveryBaseline(options), null, 2)}\n`);
  return 0; // Capture completion only; observations may explicitly be unavailable.
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
