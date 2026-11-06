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
    mountAutomation, auditLine, blockLines, costLine, decisionLine, decisionStatusLabel, policyLine, policyStatusLabel,
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
