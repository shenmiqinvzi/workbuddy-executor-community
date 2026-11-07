/**
 * 自动政策视图（L07）的回归：只读投影、状态文案、失败态与销毁后不落盘。
 *
 * 用真实视图模块 + 最小 DOM + 只读接口桩，只断言渲染文本与请求地址，
 * 不模拟浏览器布局，也不假装这里能保存政策或派工。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHost, installMiniDom } from './support/mini-dom.mjs';

installMiniDom();
const {
    mountAutomation, auditLine, blockLines, costLine, decisionLine, decisionStatusLabel, layerLine, layerLines,
    operationLine, policyLine, policyStatusLabel, probeLine, probeSourceLines, taskLink, waitingLine,
} = await import('../automation.mjs');

const tick = () => new Promise(resolve => setImmediate(resolve));

function snapshot(overrides = {}) {
    return {
        schemaVersion: 1,
        enabled: false,
        armed: false,
        writeEntry: 'local_cli_only',
        httpWrites: false,
        policies: [{
            policyId: 'policy-demo',
            revision: 'policy-1',
            status: 'active',
            workspaceId: 'project',
            executor: { executorId: 'workbuddy', connectionId: 'local-workbuddy', providerId: 'workbuddy-native', modelId: 'synthetic-user-choice', reasoningEffort: null },
            cost: { mode: 'known_cost', unit: 'credit', ceiling: 25, requiresHardCap: true },
            scope: { allowedChanges: ['src/**'], permittedMetadata: [] },
            maxTasksPerWindow: 2,
            windowSeconds: 3600,
            maxTimeoutSeconds: 600,
            maxAttempts: 3,
            expiresAt: '2026-11-07T00:00:00.000Z',
            createdAt: '2026-11-06T00:00:00.000Z',
            revokedAt: null,
            authorizationSource: 'user:operator',
            supersedes: null,
        }],
        decisions: [{
            decisionId: 'decision-demo',
            policyId: 'policy-demo',
            policyRevision: 'policy-1',
            taskId: 'task-demo',
            status: 'blocked',
            decision: 'wait',
            blocks: [{ code: 'QUOTA_UNAVAILABLE', field: 'cost', message: 'The quota snapshot is stale.' }],
            limits: ['cost_unknown_not_a_hard_cap'],
            cost: { mode: 'known_cost', unit: 'credit', ceiling: 25, evidence: 'unavailable', remaining: null, hardCapSupported: false, note: 'x' },
            rounds: { used: 0, limit: 2, windowSeconds: 3600 },
            planId: null,
            operationId: null,
            blockedCode: 'QUOTA_UNAVAILABLE',
            createdAt: '2026-11-06T00:00:00.000Z',
            updatedAt: '2026-11-06T00:00:00.000Z',
        }],
        audit: [{ seq: 1, action: 'policy_created', policyId: 'policy-demo', decisionId: null, actor: 'operator', source: 'user:operator', at: '2026-11-06T00:00:00.000Z', detail: { revision: 'policy-1' } }],
        readOnly: true,
        snapshotOnly: true,
        ...overrides,
    };
}

test('labels never invent a status the server did not record', () => {
    assert.equal(policyStatusLabel('active'), '生效中');
    assert.equal(policyStatusLabel('revoked'), '已撤回');
    assert.equal(policyStatusLabel('something_new'), 'something_new');
    assert.equal(policyStatusLabel(null), 'NA');
    assert.equal(decisionStatusLabel('outcome_unknown'), '结果不明（只观察原操作）');
    assert.equal(decisionStatusLabel(undefined), 'NA');
});

test('a policy line names the workspace, the exact model, the rounds and the status', () => {
    const line = policyLine(snapshot().policies[0]);
    assert.match(line, /project/);
    assert.match(line, /synthetic-user-choice/);
    assert.match(line, /推理默认/);
    assert.match(line, /2 次\/窗口/);
    assert.match(line, /生效中/);
    assert.equal(policyLine(null), 'NA');
});

test('cost lines keep unknown prices away from free and away from a hard cap', () => {
    assert.match(costLine({ mode: 'free_only', unit: 'credit' }), /x0\.00/);
    assert.match(costLine({ mode: 'known_cost', unit: 'credit', ceiling: 25 }), /不超过 25 credit/);
    const unknown = costLine({ mode: 'unknown_allowed', unit: 'credit', ceiling: null });
    assert.match(unknown, /未知价格不当作零/);
    assert.match(unknown, /不当作硬上限/);
    assert.equal(costLine(null), 'NA');
});

test('a recorded decision shows its code, its blocks and the original operation', () => {
    const decision = snapshot().decisions[0];
    assert.match(decisionLine(decision), /QUOTA_UNAVAILABLE/);
    assert.match(decisionLine(decision), /已阻塞（未派工）/);
    assert.match(decisionLine(decision), /0\/2 次/);
    assert.deepEqual(blockLines(decision), ['QUOTA_UNAVAILABLE（cost）：The quota snapshot is stale.']);
    assert.deepEqual(blockLines({ blocks: [] }), []);
    assert.match(auditLine(snapshot().audit[0]), /policy_created · user:operator · operator · policy-demo/);
});

test('the view renders the read-only facts and never offers a write', async () => {
    const requested = [];
    const host = createHost();
    mountAutomation({ root: host, fetchJson: async path => { requested.push(path); return snapshot(); } });
    await tick();
    const text = host.textContent;
    assert.deepEqual(requested, ['/workbench/v1/automation']);
    assert.match(text, /本机命令行（scripts\/automation\.mjs）/);
    assert.match(text, /没有；此页只读/);
    assert.match(text, /未启用（默认）/);
    assert.match(text, /未武装：即使有政策也不会派工/);
    assert.match(text, /project · synthetic-user-choice/);
    assert.match(text, /policy_created/);
    assert.equal(host.querySelectorAll('input').length, 0);
    assert.equal(host.querySelectorAll('form').length, 0);
});

test('policy history and decision detail are fetched from the read-only prefix', async () => {
    const requested = [];
    const host = createHost();
    const view = mountAutomation({
        root: host,
        fetchJson: async path => {
            requested.push(path);
            if (path === '/workbench/v1/automation') return snapshot();
            if (path.startsWith('/workbench/v1/automation/policies/')) {
                return { policy: snapshot().policies[0], status: 'active', current: true, revisions: [{ revision: 'policy-1', current: true, status: 'active', createdAt: '2026-11-06T00:00:00.000Z', revokedAt: null }] };
            }
            return { decision: { ...snapshot().decisions[0], evaluation: { decision: 'wait', blocks: snapshot().decisions[0].blocks, limits: ['cost_unknown_not_a_hard_cap'], cost: { mode: 'known_cost' } } } };
        },
    });
    await tick();
    const historyButton = host.descendants().find(node => node.textContent === '版本历史');
    assert.ok(historyButton, 'the policy row offers its history');
    historyButton.click();
    await tick();
    assert.match(host.textContent, /policy-1 · 生效中 · 当前/);
    assert.match(host.textContent, /到期 2026-11-07T00:00:00.000Z · 授权来源 user:operator/);
    const detailButton = host.descendants().find(node => node.textContent === '决定详情');
    assert.ok(detailButton);
    detailButton.click();
    await tick();
    assert.match(host.textContent, /QUOTA_UNAVAILABLE（cost）/);
    assert.match(host.textContent, /结果不明时只能观察原操作/);
    assert.deepEqual(requested.filter(path => path.includes('/policies/') || path.includes('/decisions/')), [
        '/workbench/v1/automation/policies/policy-demo',
        '/workbench/v1/automation/decisions/decision-demo',
    ]);
    view.dispose();
});

test('a read failure is shown as a failure, not as an empty policy list', async () => {
    const host = createHost();
    mountAutomation({ root: host, fetchJson: async () => { throw new Error('HTTP 503'); } });
    await tick();
    assert.match(host.textContent, /政策快照读取失败：HTTP 503/);
    assert.match(host.textContent, /政策列表未能读取。/);
    assert.doesNotMatch(host.textContent, /project · synthetic-user-choice/);
});

test('a late response after dispose does not paint', async () => {
    const host = createHost();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const view = mountAutomation({ root: host, fetchJson: async () => { await gate; return snapshot(); } });
    view.dispose();
    release();
    await tick();
    await tick();
    assert.doesNotMatch(host.textContent, /本机命令行/);
    assert.doesNotMatch(host.textContent, /policy_created/);
});

test('the six layers are shown as six separate facts, never folded into one switch', () => {
    const layers = [
        { layer: 'installation_enabled', enabled: true, source: 'automation_meta.enabled' },
        { layer: 'process_armed', armed: false, dispatcherWired: false, probeKind: 'read_only_local' },
        { layer: 'policy_authorization', writeEntry: 'local_cli_only', acceptedSources: ['user:', 'local-operator:', 'desktop:'], policiesCurrent: 1 },
        { layer: 'per_task_selection', mode: 'per_task_confirmed', note: 'Controlled policy execution' },
        { layer: 'recorded_decision', pending: 1, blocked: 2, executing: 0, dispatched: 3, outcomeUnknown: 0, revoked: 1 },
        { layer: 'actual_dispatch', guardedService: 'TaskApplicationService.send', capacity: 'single_shared_slot' },
    ];
    const lines = layerLines({ layers });
    assert.equal(lines.length, 6);
    assert.match(lines[0], /① 安装级启用：是/);
    assert.match(lines[1], /② 进程内武装：武装 否 · 派工器已接 否 · 观测 read_only_local/);
    assert.match(lines[2], /接受来源 user:\/local-operator:\/desktop:/);
    assert.match(lines[3], /per_task_confirmed — Controlled policy execution/);
    assert.match(lines[4], /待派工 1 · 阻塞 2 · 派工中 0 · 已派工 3 · 结果不明 0 · 撤回未派工 1/);
    assert.match(lines[5], /TaskApplicationService\.send · 容量 single_shared_slot/);
    assert.deepEqual(layerLines({}), []);
    assert.equal(layerLine(null), 'NA');
    assert.equal(layerLine({ layer: 'unknown_layer' }), 'unknown_layer');
});

test('a waiting condition names what the decision is waiting for, not just a code', () => {
    assert.match(waitingLine({ blocks: [{ code: 'QUOTA_UNAVAILABLE', field: 'cost' }] }), /等新的额度观测/);
    assert.match(waitingLine({ evaluation: { blocks: [{ code: 'EXECUTOR_BUSY' }] } }), /等唯一容量位释放/);
    assert.equal(waitingLine({ blocks: [{ code: 'SOMETHING_NEW' }] }), 'SOMETHING_NEW：等该阻塞原因消失');
    assert.equal(waitingLine({ blocks: [] }), '没有记录等待条件。');
    assert.equal(waitingLine(null), '没有记录等待条件。');
});

test('the observation a decision used is shown with its sources, and an absent one is not free', () => {
    const probe = {
        probeVersion: 'workbuddy-executor/automation-probe-1',
        observedAt: '2026-11-07T00:00:00.000Z',
        coverage: { executors: 'observed', catalog: 'observed', costEvidence: 'gateway_pool', taskAttribution: 'unavailable' },
        sources: [{ source: 'catalog', status: 'ok', entries: 2, detail: '2 catalog rows' }, { source: 'quota', status: 'stale', entries: 1, detail: 'old snapshot' }],
    };
    assert.match(probeLine(probe), /观测 2026-11-07T00:00:00\.000Z/);
    assert.match(probeLine(probe), /费用证据 gateway_pool/);
    assert.match(probeSourceLines(probe)[0], /^catalog：ok（2 条）— 2 catalog rows$/);
    assert.deepEqual(probeSourceLines(null), []);
    assert.match(probeLine(null), /未声明的观测不等于免费/);
});

test('a task link uses the shell deep link form and refuses a non-identifier', () => {
    assert.equal(taskLink('task-demo'), '#taskId=task-demo');
    assert.equal(taskLink('task demo/x'), '#taskId=task%20demo%2Fx');
    assert.equal(taskLink(''), null);
    assert.equal(taskLink(null), null);
});

test('the view shows the layers, the observation and the original task link without any write control', async () => {
    const host = createHost();
    const decision = {
        ...snapshot().decisions[0],
        requestedBy: 'synthetic-operator',
        probe: {
            probeVersion: 'workbuddy-executor/automation-probe-1',
            observedAt: '2026-11-07T00:00:00.000Z',
            coverage: { executors: 'observed', catalog: 'observed', costEvidence: 'gateway_pool', taskAttribution: 'unavailable' },
            sources: [{ source: 'catalog', status: 'ok', entries: 1, detail: '1 catalog row' }],
        },
    };
    mountAutomation({
        root: host,
        fetchJson: async path => {
            if (path === '/workbench/v1/automation') {
                return snapshot({
                    probeKind: 'read_only_local',
                    layers: [{ layer: 'installation_enabled', enabled: false, source: 'automation_meta.enabled' }],
                });
            }
            return { decision: { ...decision, evaluation: { decision: 'wait', blocks: decision.blocks, limits: [], cost: { mode: 'known_cost' } } } };
        },
    });
    await tick();
    assert.match(host.textContent, /六层边界/);
    assert.match(host.textContent, /① 安装级启用：否/);
    assert.match(host.textContent, /本机只读组合观测/);
    const detailButton = host.descendants().find(node => node.textContent === '决定详情');
    detailButton.click();
    await tick();
    assert.match(host.textContent, /实际请求身份 synthetic-operator/);
    assert.match(host.textContent, /等待条件/);
    assert.match(host.textContent, /等新的额度观测/);
    assert.match(host.textContent, /当时的观测/);
    assert.match(host.textContent, /catalog：ok（1 条）/);
    const link = host.descendants().find(node => node.tagName === 'A' && node.textContent === '查看原任务');
    assert.ok(link, 'a recorded decision links to its original task');
    assert.equal(link.getAttribute('href'), '#taskId=task-demo');
    assert.equal(host.querySelectorAll('input').length, 0);
    assert.equal(host.querySelectorAll('form').length, 0);
});

test('an original operation line reports its state, and says so when there is none', () => {
    assert.match(
        operationLine({
            operationId: 'operation-demo',
            operation: {
                operationId: 'operation-demo', kind: 'send', state: 'succeeded', taskId: 'task-demo', attemptId: 'attempt-1',
                effectStartedAt: '2026-11-07T00:00:00.000Z', createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:01.000Z', error: null,
            },
        }),
        /操作 operation-demo · succeeded · send · 任务 task-demo · 生效开始 2026-11-07T00:00:00.000Z/,
    );
    assert.match(operationLine({ operationId: null, operation: null, note: 'This decision never reserved an operation.' }), /没有原操作可查：This decision never reserved an operation/);
    assert.equal(operationLine(null), '没有查询到原操作。');
});

test('the decision detail can ask the read-only prefix for the original operation', async () => {
    const requested = [];
    const host = createHost();
    const decision = { ...snapshot().decisions[0], operationId: 'operation-demo', status: 'outcome_unknown' };
    mountAutomation({
        root: host,
        fetchJson: async path => {
            requested.push(path);
            if (path === '/workbench/v1/automation') return snapshot();
            if (path.endsWith('/operation')) {
                return {
                    readOnly: true,
                    decisionId: 'decision-demo',
                    status: 'outcome_unknown',
                    operationId: 'operation-demo',
                    operation: { operationId: 'operation-demo', kind: 'send', state: 'unknown', taskId: 'task-demo', attemptId: 'attempt-1', effectStartedAt: '2026-11-07T00:00:00.000Z', createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:02.000Z', error: { code: 'ERESET', message: 'socket reset' } },
                    note: 'Read-only.',
                };
            }
            return { decision: { ...decision, evaluation: { decision: 'wait', blocks: [], limits: [], cost: { mode: 'unknown_allowed' } } } };
        },
    });
    await tick();
    host.descendants().find(node => node.textContent === '决定详情').click();
    await tick();
    const button = host.descendants().find(node => node.textContent === '查询原操作');
    assert.ok(button, 'a decision with an operation offers its operation state');
    button.click();
    await tick();
    assert.ok(requested.includes('/workbench/v1/automation/decisions/decision-demo/operation'));
    assert.match(host.textContent, /操作 operation-demo · unknown · send · 任务 task-demo/);
    assert.match(host.textContent, /错误 ERESET/);
});
