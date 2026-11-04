import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoResourceSource, ResourceReadError, ResourceSource, RESOURCE_ENDPOINTS } from '../resources-source.mjs';

const POOL = 'pool-0123456789abcdef0123456789abcdef';
const SNAPSHOT = 'snap-0123456789abcdef0123456789';

const quotaDocument = () => ({
    schemaVersion: 'workbuddy-executor/quota-1',
    readOnly: true,
    connections: [{
        connectionId: 'conn-a', status: 'observed', errorCode: null, snapshotId: SNAPSHOT,
        collectedAt: '2026-11-04T08:00:00.000Z', sourceObservedAt: '2026-11-04T07:59:00.000Z',
        expiresAt: '2026-11-04T09:00:00.000Z', freshness: 'fresh',
    }],
    observations: [{
        scopeId: POOL, scopeKind: 'gateway_pool', shared: true, modelId: 'model-x', realm: 'cn',
        unit: 'tokens', valueKind: 'estimated', availability: 'available',
        used: 1000, budget: 5000, remaining: 4000, resetAt: null,
        method: 'source_cooling_and_historical_budget',
        limitations: ['routing_unverified', 'shared_pool'],
        connectionId: 'conn-a', snapshotId: SNAPSHOT,
        sourceObservedAt: '2026-11-04T07:59:00.000Z', collectedAt: '2026-11-04T08:00:00.000Z',
        connectionIds: ['conn-a'],
    }],
    truncated: false, attribution: 'connection_only', actualTaskCredits: null, actualTaskTokens: null,
});

const creditDocument = () => ({
    schemaVersion: 'workbuddy-executor/credit-balance-1',
    readOnly: true,
    connections: [{
        connectionId: 'conn-a', status: 'observed', errorCode: null, snapshotId: SNAPSHOT,
        collectedAt: '2026-11-04T08:00:00.000Z', cacheFreshness: 'fresh',
    }],
    balances: [{
        snapshotId: SNAPSHOT, connectionId: 'conn-a', scopeId: POOL, realm: 'cn', unit: 'credit',
        valueKind: 'reported_cache', balance: 40, accountsEnabled: 2, accountsWithData: 2, coverage: 'complete',
        latestMemberObservedAt: '2026-11-04T07:30:00.000Z', collectedAt: '2026-11-04T08:00:00.000Z',
        cacheExpiresAt: '2026-11-04T08:30:00.000Z', errorCode: null, connectionIds: ['conn-a'],
        shared: true, scopeKind: 'gateway_region_pool', balanceFreshness: 'unavailable',
        limitations: ['shared_region_pool'],
    }],
    actualTaskCredits: null, attribution: 'connection_only',
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function router(routes) {
    return async (url, init) => {
        const path = new URL(url, 'http://127.0.0.1').pathname;
        const handler = routes[path];
        if (!handler) throw new Error('unexpected request ' + path);
        return handler(init);
    };
}

const source = (routes, options = {}) => new ResourceSource({ fetchImpl: router(routes), ...options });

test('两个只读接口都成功时给出完整结果', async () => {
    const result = await source({
        [RESOURCE_ENDPOINTS.quotas]: () => json(quotaDocument()),
        [RESOURCE_ENDPOINTS.creditBalances]: () => json(creditDocument()),
    }).readAll();
    assert.equal(result.ok, true);
    assert.equal(result.partial, false);
    assert.equal(result.demo, false);
    assert.equal(result.kind, 'live');
    assert.equal(result.quota.view.rows.length, 1);
    assert.equal(result.credit.view.rows.length, 1);
    assert.deepEqual(result.consistency.drifted, []);
    assert.equal(result.consistency.consistent, true);
});

test('一侧失败不阻止另一侧显示，且失败侧不返回合成数据', async () => {
    const result = await source({
        [RESOURCE_ENDPOINTS.quotas]: () => json(quotaDocument()),
        [RESOURCE_ENDPOINTS.creditBalances]: () => json({ ok: false, error: { code: 'RESOURCE_STORE_UNAVAILABLE', message: '缓存不可读' } }, 503),
    }).readAll();
    assert.equal(result.ok, false);
    assert.equal(result.partial, true);
    assert.equal(result.quota.status, 'ok');
    assert.equal(result.credit.status, 'error');
    assert.equal(result.credit.code, 'RESOURCE_STORE_UNAVAILABLE');
    assert.equal(result.credit.httpStatus, 503);
    assert.equal(Object.hasOwn(result.credit, 'view'), false);
    assert.equal(Object.hasOwn(result.credit, 'document'), false);
});

test('未知 schema 归为 UNKNOWN_SCHEMA，不是空资源', async () => {
    const shifted = quotaDocument();
    shifted.schemaVersion = 'workbuddy-executor/quota-3';
    const result = await source({
        [RESOURCE_ENDPOINTS.quotas]: () => json(shifted),
        [RESOURCE_ENDPOINTS.creditBalances]: () => json(creditDocument()),
    }).readAll();
    assert.equal(result.quota.status, 'error');
    assert.equal(result.quota.code, 'UNKNOWN_SCHEMA');
    assert.equal(result.credit.status, 'ok');
});

test('非 JSON 响应归为 INVALID_RESPONSE', async () => {
    const result = await source({
        [RESOURCE_ENDPOINTS.quotas]: () => new Response('<html>不可读</html>', { status: 200 }),
        [RESOURCE_ENDPOINTS.creditBalances]: () => json(creditDocument()),
    }).readAll();
    assert.equal(result.quota.status, 'error');
    assert.equal(result.quota.code, 'INVALID_RESPONSE');
});

test('连接中断归为 NETWORK_ERROR', async () => {
    const result = await source({
        [RESOURCE_ENDPOINTS.quotas]: () => { throw new TypeError('fetch failed'); },
        [RESOURCE_ENDPOINTS.creditBalances]: () => json(creditDocument()),
    }).readAll();
    assert.equal(result.quota.code, 'NETWORK_ERROR');
});

test('超时归为 RESOURCE_TIMEOUT，而不是抛给页面', async () => {
    const hang = init => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    const result = await source({
        [RESOURCE_ENDPOINTS.quotas]: hang,
        [RESOURCE_ENDPOINTS.creditBalances]: hang,
    }, { timeoutMs: 15 }).readAll();
    assert.equal(result.ok, false);
    assert.equal(result.partial, false);
    assert.equal(result.quota.code, 'RESOURCE_TIMEOUT');
    assert.equal(result.credit.code, 'RESOURCE_TIMEOUT');
});

test('外部取消抛出 AbortError，不写成读取失败', async () => {
    const controller = new AbortController();
    const hang = init => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    const pending = source({
        [RESOURCE_ENDPOINTS.quotas]: hang,
        [RESOURCE_ENDPOINTS.creditBalances]: hang,
    }).readAll({ signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
});

test('演示来源整份标记 demo，且与真实结构同构', async () => {
    const result = await new DemoResourceSource().readAll();
    assert.equal(result.demo, true);
    assert.equal(result.kind, 'demo');
    assert.equal(result.ok, true);
    assert.equal(result.quota.view.rows.length > 0, true);
    assert.equal(result.credit.view.rows.length > 0, true);
    assert.equal(result.quota.view.rows.every(row => row.routingVerified === false), true);
});

test('ResourceReadError 保留状态码与错误码', () => {
    const error = new ResourceReadError('RESOURCE_STORE_UNAVAILABLE', '缓存不可读', { httpStatus: 503 });
    assert.equal(error.code, 'RESOURCE_STORE_UNAVAILABLE');
    assert.equal(error.httpStatus, 503);
    assert.equal(error.name, 'ResourceReadError');
});
