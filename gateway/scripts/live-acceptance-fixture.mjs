#!/usr/bin/env node
// Produces unapproved samples only. No gateway, login, model or dispatch imports.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const schema = 'workbuddy-executor/live-acceptance-fixture-1';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const read = file => {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('fixture_file_refused');
  return fs.readFileSync(file);
};
function realDirectory(directory) {
  if (!path.isAbsolute(directory)) fail('absolute_directory_required');
  let current = path.resolve(directory);
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) fail('linked_directory_refused');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!fs.statSync(directory).isDirectory()) fail('directory_required');
  return fs.realpathSync(directory);
}

function refuseLinkedAncestors(directory) {
  let current = path.resolve(directory);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('linked_directory_refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

const samples = {
  workbuddy: {
    file: 'src/clamp.mjs',
    title: '修复有限数字区间夹取',
    objective: '修复 clamp 的合法输入区间夹取；保留有限 number 校验、反向区间的 RangeError 和无副作用行为。只修改 src/clamp.mjs，不修改独立检查或约定。',
    semantic: '区间内保留原数值，越界返回相应端点；负数、小数、相等端点正确；非法类型和非有限值抛 TypeError，lower 大于 upper 抛 RangeError。',
    source: `export function clamp(value, lower, upper) {
  if (![value, lower, upper].every(item => typeof item === 'number' && Number.isFinite(item))) throw new TypeError('finite numbers required');
  if (lower > upper) throw new RangeError('invalid range');
  return Math.max(lower, Math.max(value, upper));
}
`,
    checks: `import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from '../src/clamp.mjs';
test('区间内值保持不变', () => { assert.equal(clamp(5, 0, 10), 5); });
test('低于区间返回下端点', () => { assert.equal(clamp(-2, 0, 10), 0); });
test('高于区间返回上端点', () => { assert.equal(clamp(12, 0, 10), 10); });
test('负数和小数', () => { assert.equal(clamp(-1.25, -2, -1), -1.25); });
test('边界与零宽度区间', () => { assert.equal(clamp(0, 0, 10), 0); assert.equal(clamp(10, 0, 10), 10); assert.equal(clamp(2, 3, 3), 3); });
test('拒绝非有限值与错误类型', () => { for (const bad of [NaN, Infinity, -Infinity, '5', null, undefined]) { assert.throws(() => clamp(bad, 0, 10), TypeError); assert.throws(() => clamp(5, bad, 10), TypeError); assert.throws(() => clamp(5, 0, bad), TypeError); } });
test('拒绝反向区间', () => { assert.throws(() => clamp(5, 10, 0), RangeError); });
`,
  },
  dsh: {
    file: 'src/paid-summary.mjs',
    title: '修复已支付订单汇总的状态过滤',
    objective: '修复 summarizePaid，把 paidCount 和 totalCents 限定为 status 严格等于 paid 的订单；保留金额与状态校验，不修改输入。只修改 src/paid-summary.mjs。',
    semantic: 'pending/refunded 不计入已支付数量或金额；空数组、零金额和混合状态正确；输入不被修改，非法状态及非负安全整数以外的金额被拒绝。',
    source: `export function summarizePaid(orders) {
  if (!Array.isArray(orders)) throw new TypeError('orders must be an array');
  let paidCount = 0, totalCents = 0;
  for (const order of orders) {
    if (!order || typeof order !== 'object' || !['paid', 'pending', 'refunded'].includes(order.status) || !Number.isSafeInteger(order.amountCents) || order.amountCents < 0) throw new TypeError('invalid order');
    if (order.status !== 'refunded') { paidCount++; totalCents += order.amountCents; }
    if (!Number.isSafeInteger(totalCents)) throw new RangeError('total overflow');
  }
  return { paidCount, totalCents };
}
`,
    checks: `import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePaid } from '../src/paid-summary.mjs';
test('空数组', () => { assert.deepEqual(summarizePaid([]), { paidCount: 0, totalCents: 0 }); });
test('混合状态只计算 paid', () => { assert.deepEqual(summarizePaid([{status:'paid',amountCents:125},{status:'pending',amountCents:900},{status:'refunded',amountCents:500},{status:'paid',amountCents:75}]), { paidCount: 2, totalCents: 200 }); });
test('没有 paid 时保持真正的零', () => { assert.deepEqual(summarizePaid([{status:'pending',amountCents:42},{status:'refunded',amountCents:11}]), { paidCount: 0, totalCents: 0 }); });
test('已支付的零金额也计数量', () => { assert.deepEqual(summarizePaid([{status:'paid',amountCents:0}]), { paidCount: 1, totalCents: 0 }); });
test('不修改输入', () => { const orders = Object.freeze([Object.freeze({status:'paid',amountCents:1})]); assert.deepEqual(summarizePaid(orders), { paidCount: 1, totalCents: 1 }); });
test('拒绝非法状态和金额', () => { for (const amountCents of [-1,0.5,NaN,Infinity,'2']) assert.throws(() => summarizePaid([{status:'paid',amountCents}]), TypeError); assert.throws(() => summarizePaid([{status:'PAID',amountCents:1}]), TypeError); assert.throws(() => summarizePaid(null), TypeError); });
test('累计溢出被拒绝', () => { assert.throws(() => summarizePaid([{status:'paid',amountCents:Number.MAX_SAFE_INTEGER},{status:'paid',amountCents:1}]), RangeError); });
`,
  },
};

export function prepareLiveAcceptanceFixtures(parent) {
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) fail('absolute_parent_required');
  // No overwrite/reset/cleanup operation exists. The caller's files stay outside
  // the unique run directory, even when it already contains an older fixture.
  refuseLinkedAncestors(parent);
  fs.mkdirSync(parent, { recursive: true });
  const realParent = realDirectory(parent);
  const root = fs.mkdtempSync(path.join(realParent, 'live-acceptance-'));
  const manifest = { schemaVersion: schema, root, createdAt: new Date().toISOString(), authorized: false, dispatchPrepared: false, entries: [], samples: {} };
  function write(relative, content, mutable = false) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: 'wx' });
    manifest.entries.push({ path: relative, sha256: digest(Buffer.from(content)), mutable });
  }
  write('owner.json', JSON.stringify({ schemaVersion: schema, ownerId: crypto.randomUUID() }));
  for (const [executorId, sample] of Object.entries(samples)) {
    const workspace = path.join(root, executorId);
    const command = { executable: process.execPath, args: ['--test', '--test-reporter=tap', 'checks/acceptance.test.mjs'], cwd: workspace, timeoutSeconds: 30, inputs: [sample.file, 'checks/acceptance.test.mjs'] };
    const draft = {
      schemaVersion: 'workbuddy-executor/live-acceptance-draft-1', authorized: false, executorId, proposedOperationId: `d1-${executorId}-send-${crypto.randomUUID()}`,
      contractTemplate: {
        schemaVersion: 'workbuddy-executor/vnext-2', taskId: `d1-${executorId}-${crypto.randomUUID()}`, workspaceId: `d1-${executorId}-${path.basename(root)}`,
        title: sample.title, objective: sample.objective, execution: null, collaboration: null, timeoutSeconds: 600, maxAttempts: 1,
        scope: { allowedChanges: [sample.file], permittedMetadata: [] },
        requiredChecks: [{ id: 'independent-command', kind: 'command', definition: JSON.stringify(command) }, { id: 'behavior', kind: 'semantic', definition: sample.semantic }, { id: 'protected-checks', kind: 'semantic', definition: '独立检查、约定和说明与派工前哈希一致；没有超出唯一源码文件的改动。' }],
      },
      requiredBeforeExecution: ['actual_user_execution_selection', 'authorized_plan_and_revision', 'verified_installed_skill_and_mcp', 'exact_idle_session', 'shared_capacity_and_original_unknown_task_check'],
    };
    write(`${executorId}/${sample.file}`, sample.source, true);
    write(`${executorId}/checks/acceptance.test.mjs`, sample.checks);
    write(`${executorId}/README.md`, `# ${sample.title}\n\n这是未授权的真实链路验收样本。只允许修改 ${sample.file}。\n运行 node --test --test-reporter=tap checks/acceptance.test.mjs。修复前应失败。\n模型、来源、推理与费用尚未选择；不得把本目录当成已派工任务。\n`);
    write(`contracts/${executorId}.json`, `${JSON.stringify(draft, null, 2)}\n`);
    manifest.samples[executorId] = { workspace, sourceFile: sample.file, draftFile: path.join(root, 'contracts', `${executorId}.json`) };
  }
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(root, 'baseline.json'), body, { flag: 'wx' });
  return { root, baselineSha256: digest(Buffer.from(body)), preparedOnly: true, authorized: false, samples: manifest.samples };
}

function inventory(root) {
  const result = [];
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory)) {
      if (result.length >= 128) fail('fixture_inventory_limit');
      const file = path.join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('fixture_link_refused');
      if (stat.isDirectory()) { result.push(`${relative}/`); visit(file, relative); }
      else if (stat.isFile()) result.push(relative);
      else fail('fixture_file_refused');
    }
  }
  visit(root);
  return result;
}
export function verifyFixtureIntegrity(root, expectedBaselineSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedBaselineSha256 ?? '')) fail('external_baseline_digest_required');
  root = realDirectory(root);
  const body = read(path.join(root, 'baseline.json'));
  if (digest(body) !== expectedBaselineSha256) return { ok: false, preparedOnly: true, problems: ['baseline_changed'] };
  const manifest = JSON.parse(body.toString('utf8'));
  if (manifest.schemaVersion !== schema || manifest.root !== root || manifest.authorized !== false || !Array.isArray(manifest.entries) || manifest.entries.length > 128) fail('fixture_manifest_invalid');
  const problems = [];
  const expected = new Set(['baseline.json']);
  for (const entry of manifest.entries) {
    if (typeof entry.path !== 'string' || !/^[\w./-]+$/.test(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..')) fail('fixture_manifest_invalid');
    expected.add(entry.path);
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index++) expected.add(`${segments.slice(0, index).join('/')}/`);
    try {
      const value = read(path.join(root, entry.path));
      if (!entry.mutable && digest(value) !== entry.sha256) problems.push(`protected_file_changed:${entry.path}`);
    } catch { problems.push(`file_unreadable:${entry.path}`); }
  }
  if (inventory(root).some(file => !expected.has(file))) problems.push('unexpected_file');
  return { ok: problems.length === 0, preparedOnly: true, authorized: false, problems };
}

export function main(argv = process.argv.slice(2)) {
  try {
    const action = argv[0], options = {};
    const allowed = action === 'create' ? ['--parent'] : action === 'verify' ? ['--root', '--baseline-sha256'] : [];
    if (!allowed.length) fail('invalid_action');
    for (let index = 1; index < argv.length; index += 2) {
      if (!allowed.includes(argv[index]) || !argv[index + 1] || argv[index + 1].startsWith('--') || Object.hasOwn(options, argv[index])) fail('invalid_options');
      options[argv[index]] = argv[index + 1];
    }
    if (allowed.some(key => !Object.hasOwn(options, key))) fail('missing_options');
    const result = action === 'create' ? prepareLiveAcceptanceFixtures(options['--parent']) : verifyFixtureIntegrity(options['--root'], options['--baseline-sha256']);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok === false ? 1 : 0;
  } catch (error) {
    const code = typeof error?.code === 'string' && /^fixture_|^absolute_|^linked_|^directory_|^external_|^invalid_|^missing_/.test(error.code) ? error.code : 'fixture_operation_failed';
    process.stderr.write(`${JSON.stringify({ error: { code }, authorized: false })}\n`);
    return 2;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
