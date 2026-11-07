/**
 * Isolated page boot: real workbench modules, real stylesheets, stubbed host.
 *
 * The harness exists so a page can be measured on its own (viewport, focus,
 * accessible names) without the desktop shell. It answers the same JSON
 * envelopes the host answers, and it never dispatches anything: `dispatch`
 * returns a pending receipt whose request id is the draft id, which is what the
 * page shows while it polls.
 */
import { mountDesktopDispatch, sourceKey } from '../../../dispatch.mjs';
import { renderDesktopControls, renderControlUnavailable } from '../../../controls.mjs';
import { renderAttention } from '../../../attention.mjs';

const projectPath = 'C:/synthetic/a-very-long-project-directory-name-for-layout/project';
const projectId = 'project-' + 'a'.repeat(32);
const wb = { key: 'wbkey', execution: { executorId: 'workbuddy', connectionId: 'local-workbuddy', providerId: 'workbuddy-native', modelId: 'synthetic-model', reasoningEffort: null }, credits: 'x0.00', pricingVerified: true, blockedReason: null };
const dsh = { key: 'dshkey', execution: { executorId: 'dsh', connectionId: 'synthetic-host', providerId: 'synthetic-provider', modelId: 'synthetic-dsh-model-with-a-long-name', reasoningEffort: 'high' }, credits: null, pricingVerified: false, blockedReason: null };

const catalog = () => ({
  catalogId: 'catalog-1',
  models: [wb, dsh],
  sessions: [{ hostId: 'synthetic-host', sessionId: 'session-1', workspace: projectPath, attached: true, busy: false }],
  policy: { version: 'policy-1', maxAttempts: 3, maxTimeoutSeconds: 3600, requiredFreeModel: null },
  errors: [],
  dispatchEnabled: true,
  sources: [
    { sourceId: sourceKey(wb.execution), executorId: 'workbuddy', connectionId: 'local-workbuddy', providerId: 'workbuddy-native', label: 'WorkBuddy · 本机原生来源', state: 'online', stateReason: null, dispatchable: true, stoppable: 'unknown', models: [wb] },
    { sourceId: sourceKey(dsh.execution), executorId: 'dsh', connectionId: 'synthetic-host', providerId: 'synthetic-provider', label: 'DSH · synthetic-provider · synthetic-host', state: 'disabled', stateReason: 'DSH 来源未启用；如需使用，请检查现有连接配置。', dispatchable: false, stoppable: 'unknown', models: [dsh] }],
  projects: [{ projectId, realPath: projectPath, displayName: 'project', state: 'unverified', observedAt: '2026-11-05T00:00:00.000Z' }],
  projectIssues: []
});

const draft = (revision, warnings) => ({
  draftId: 'draft-1', taskId: 'desktop-' + '0'.repeat(8) + '-0000-4000-8000-' + '1'.repeat(12), operationId: 'desktop-send-' + '0'.repeat(8) + '-0000-4000-8000-' + '2'.repeat(12), revision,
  projectId, workspace: { realPath: projectPath, device: '1', inode: '2' }, sessionId: null, digest: 'digest-' + revision,
  quote: { credits: null, pricingVerified: false, observedAt: '2026-11-05T00:00:00.000Z' }, policyVersion: 'policy-1',
  expiresAt: '2026-11-05T23:59:59.000Z',
  warnings: warnings ?? [{ code: 'scope_not_declared', message: '目标看起来要改动文件，但允许修改范围为空：派工后按只读执行，越界改动会被拒绝。如果确实要改文件，请在下方的范围里显式填写精确路径或 目录/**。' }],
  contract: {
    schemaVersion: 'workbuddy-executor/vnext-2', taskId: 'desktop-task-1', workspaceId: 'desktop-1', title: '把结算模块的超时与重试策略改成显式配置，并补齐对应检查',
    objective: '在 src/settlement/ 下把硬编码的超时与重试次数改成显式配置，补一个覆盖超时路径的检查，并在 docs/settlement.md 里记录新的默认值。',
    execution: wb.execution, collaboration: { planId: 'pending', expectedPlanRevision: 'pending' }, timeoutSeconds: 600, maxAttempts: 2,
    scope: { allowedChanges: ['src/settlement/**', 'checks/timeout.test.mjs'], permittedMetadata: ['.gitignore'] },
    requiredChecks: [{ id: 'check-1', kind: 'semantic', definition: '独立运行 checks/timeout.test.mjs，确认超时路径被真实覆盖' }, { id: 'check-2', kind: 'semantic', definition: '确认默认值写在文档里且与实际行为一致' }]
  }
});

let previewCount = 0;
const answer = { ok: true, value: null };
const respond = (action, parameters) => {
  if (action === 'latest') return { ok: true, value: null };
  if (action === 'catalog') return { ok: true, value: catalog() };
  if (action === 'preview') { previewCount++; return { ok: true, value: draft(previewCount) }; }
  if (action === 'recommend') return { ok: true, value: null };
  if (action === 'dispatch') return { ok: true, value: { requestId: 'draft-1', taskId: 'desktop-task-1', operationId: 'desktop-send-1', state: 'submitted' } };
  if (action === 'status') return { ok: true, value: { requestId: parameters?.requestId ?? 'draft-1', taskId: 'desktop-task-1', operationId: 'desktop-send-1', state: 'submitted' } };
  if (action === 'recovery_show') return { ok: true, value: { available: true, facts: [{ label: '结论', value: '派工已受理，原操作编号保持不变。' }] } };
  if (action === 'control_list') return { ok: true, value: [] };
  if (action === 'control_requirements') return { ok: true, value: [] };
  return null;
};

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith('/workbench/desktop/capabilities')) return new Response(JSON.stringify({ ok: true, value: { available: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  // The saved resource reference: a snapshot with a caveat, never a promise.
  if (target.includes('/workbench/v1/resources/plan-reference')) {
    const execution = new URL(target, 'http://local/').searchParams;
    return new Response(JSON.stringify({
      execution: { executorId: execution.get('executorId'), connectionId: execution.get('connectionId'), providerId: execution.get('providerId'), modelId: execution.get('modelId'), reasoningEffort: execution.get('reasoningEffort') || null },
      status: 'linked', quota: { connectionId: 'usage-connection', remaining: 128000, used: 41000, budget: 169000, valueKind: 'estimated', availability: 'shared', sourceObservedAt: '2026-11-05T09:40:00.000Z', collectedAt: '2026-11-05T09:41:00.000Z', expiresAt: '2026-11-05T10:41:00.000Z', freshness: 'stale', snapshotId: 'snapshot-1', limitations: ['budget_estimated', 'shared_pool'] },
      credit: { connectionId: 'credit-connection', balance: 42.5, coverage: 'partial', accountsWithData: 1, accountsEnabled: 2, latestMemberObservedAt: '2026-11-05T09:30:00.000Z', cacheFreshness: 'fresh', balanceFreshness: 'stale' },
      attribution: 'snapshot'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  const { action, parameters } = JSON.parse(init.body);
  return new Response(JSON.stringify(respond(action, parameters)), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const settle = async (check, label) => {
  for (let index = 0; index < 200; index++) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('页面没有稳定下来：' + label);
};

await mountDesktopDispatch({ onTask: async () => {} });

/** One task record in the state the panel has to explain. */
function record(overrides = {}) {
  const base = {
    ok: true, taskId: 'desktop-task-1', businessState: 'needs_review',
    presentation: { objective: '把结算模块的超时与重试策略改成显式配置', report: { authentication: 'authenticated' } },
    view: { schemaVersion: 'workbuddy-executor/stage-2', displayState: 'needs_review', businessState: 'needs_review', revision: 'rev-7', remoteStopped: true, attempt: { id: 'attempt-1', number: 1, limit: 2 }, timing: { nativeStoppedAt: '2026-11-05T10:00:00.000Z' } },
    reviews: [{ reviewId: 'review-1', attemptId: 'attempt-1', committedRevision: 'rev-7', basisRevision: 'rev-7', checks: [{ checkId: 'check-1', status: 'passed', actor: 'program' }] }]
  };
  return { ...base, ...overrides };
}

const controlsSlot = document.getElementById('controls-slot');
const panelSlot = document.getElementById('panel-slot');
const attentionSlot = document.getElementById('attention-slot');
controlsSlot.append(renderDesktopControls(record(), { refresh: async () => {} }));
attentionSlot.append(renderAttention(record({ view: { ...record().view, remoteStopped: false, displayState: 'waiting_stop', businessState: 'working', timing: { nativeStoppedAt: null } } }), { refresh: async () => {} }));
// A control panel can legitimately have nothing to say (no unavailable reason);
// only append a node when there is one, otherwise the page prints "null".
const unavailable = renderControlUnavailable(record({ view: { ...record().view, remoteStopped: false, displayState: 'waiting_stop', businessState: 'working' } }), { desktopAvailable: true, live: true, capacity: { limit: 1, occupiedByTaskId: 'another-task' } });
if (unavailable) panelSlot.append(unavailable);

const harness = {
  ready: true,
  async openEditor() {
    document.getElementById('new-task').click();
    await settle(() => document.getElementById('compose-source') && !document.getElementById('compose-source').disabled, 'editor');
    return true;
  },
  fill() {
    const set = (id, value) => { const node = document.getElementById(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); };
    set('compose-workspace', projectPath);
    set('compose-source', sourceKey(wb.execution));
    set('compose-model', 'synthetic-model');
    set('compose-effort', '__none__');
    set('compose-title', '把结算模块的超时与重试策略改成显式配置，并补齐对应检查');
    set('compose-objective', '在 src/settlement/ 下把硬编码的超时与重试次数改成显式配置，补一个覆盖超时路径的检查，并在 docs/settlement.md 里记录新的默认值。');
    set('compose-checks', '独立运行 checks/timeout.test.mjs\n确认默认值写在文档里且与实际行为一致');
    set('compose-allowedChanges', 'src/settlement/**\nchecks/timeout.test.mjs');
    return true;
  },
  async review() {
    const form = document.querySelector('#task-compose form') ?? document.querySelector('form');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle(() => document.getElementById('confirm-task'), 'review');
    return true;
  },
  async receipt() {
    document.getElementById('confirm-task').click();
    await settle(() => document.querySelector('.dispatch-receipt'), 'receipt');
    return true;
  },
  stage() { return document.querySelector('.dispatch-receipt') ? 'receipt' : document.getElementById('confirm-task') ? 'review' : 'edit'; }
};

globalThis.harness = harness;
