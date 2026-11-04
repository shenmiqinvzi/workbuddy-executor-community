import test from 'node:test';
import assert from 'node:assert/strict';
import { CREDIT_SCHEMA, NULL_TEXT, QUOTA_SCHEMA, ResourceSchemaError, buildCreditView, buildQuotaView, compareSnapshots, createReadGuard, emptyStateOf, formatCredits, formatRatio, formatStamp, formatTokens, parseCreditDocument, parseQuotaDocument } from '../resources-model.mjs';

const POOL = 'pool-0123456789abcdef0123456789abcdef';
const SNAPSHOT = 'snap-0123456789abcdef0123456789';

const quotaFixture = () => ({
    schemaVersion: QUOTA_SCHEMA,
    readOnly: true,
    connections: [{
        connectionId: 'conn-a', status: 'observed', errorCode: null, snapshotId: SNAPSHOT,
        collectedAt: '2026-11-04T08:00:00.000Z', sourceObservedAt: '2026-11-04T07:59:00.000Z',
        expiresAt: '2026-11-04T09:00:00.000Z', freshness: 'fresh',
    }],
    observations: [{
        scopeId: POOL, scopeKind: 'gateway_pool', shared: true, modelId: 'model-x', realm: 'cn',
        unit: 'tokens', valueKind: 'estimated', availability: 'available',
        used: 1000, budget: 5000, remaining: 4000, resetAt: '2026-11-05T00:00:00.000Z',
        method: 'source_cooling_and_historical_budget',
        limitations: ['routing_unverified', 'shared_pool'],
        connectionId: 'conn-a', snapshotId: SNAPSHOT,
        sourceObservedAt: '2026-11-04T07:59:00.000Z', collectedAt: '2026-11-04T08:00:00.000Z',
        connectionIds: ['conn-a'],
    }],
    truncated: false, attribution: 'connection_only', actualTaskCredits: null, actualTaskTokens: null,
});

const creditFixture = () => ({
    schemaVersion: CREDIT_SCHEMA,
    readOnly: true,
    connections: [{
        connectionId: 'conn-a', status: 'observed', errorCode: null, snapshotId: SNAPSHOT,
        collectedAt: '2026-11-04T08:00:00.000Z', cacheFreshness: 'fresh',
    }],
    balances: [{
        snapshotId: SNAPSHOT, connectionId: 'conn-a', scopeId: POOL, realm: 'cn', unit: 'credit',
        valueKind: 'reported_cache', balance: 120, accountsEnabled: 3, accountsWithData: 2, coverage: 'partial',
        latestMemberObservedAt: '2026-11-04T07:30:00.000Z', collectedAt: '2026-11-04T08:00:00.000Z',
        cacheExpiresAt: '2026-11-04T08:30:00.000Z', errorCode: null, connectionIds: ['conn-a'],
        shared: true, scopeKind: 'gateway_region_pool', balanceFreshness: 'stale',
        limitations: ['shared_region_pool', 'routing_unverified', 'latest_member_timestamp_only', 'member_freshness_unavailable', 'task_attribution_unavailable'],
    }],
    actualTaskCredits: null, attribution: 'connection_only',
});

test('quota-1：解析真实结构并保留连接与统计', () => {
    const document = parseQuotaDocument(quotaFixture());
    const view = buildQuotaView(document);
    assert.equal(view.schemaVersion, QUOTA_SCHEMA);
    assert.equal(view.connections.length, 1);
    assert.equal(view.rows.length, 1);
    assert.equal(view.stats.observed, 1);
    assert.equal(view.stats.rows, 1);
    assert.equal(view.rows[0].unitLabel, 'token');
    assert.equal(view.rows[0].routingVerified, false);
    assert.equal(view.rows[0].remainingText, formatTokens(4000));
});

test('quota-1：null 保持未提供，不补零', () => {
    const raw = quotaFixture();
    raw.observations[0].used = null;
    raw.observations[0].budget = null;
    raw.observations[0].remaining = null;
    raw.observations[0].resetAt = null;
    raw.observations[0].valueKind = 'unavailable';
    const view = buildQuotaView(parseQuotaDocument(raw));
    assert.equal(view.rows[0].remaining, null);
    // 数值缺失时视图保留 null，由页面显示“未提供”；这里不写 0，也不写空字符串。
    assert.equal(view.rows[0].remainingText, null);
    assert.equal(view.rows[0].budgetText, null);
    assert.equal(view.rows[0].usedText, null);
    assert.equal(formatTokens(null), null);
    assert.equal(view.rows[0].resetText, NULL_TEXT);
});

test('quota-1：真零与 null 分开', () => {
    const raw = quotaFixture();
    raw.observations[0].remaining = 0;
    const view = buildQuotaView(parseQuotaDocument(raw));
    assert.equal(view.rows[0].remainingText, '0');
    assert.notEqual(view.rows[0].remainingText, NULL_TEXT);
});

test('quota-1：已证实耗尽、未知与可用三种状态文案不同', () => {
    const labels = new Set();
    for (const availability of ['available', 'unknown', 'exhausted']) {
        const raw = quotaFixture();
        raw.observations[0].availability = availability;
        const row = buildQuotaView(parseQuotaDocument(raw)).rows[0];
        labels.add(row.availabilityLabel);
        assert.equal(row.availability, availability);
    }
    assert.equal(labels.size, 3);
    const exhausted = quotaFixture();
    exhausted.observations[0].availability = 'exhausted';
    assert.match(buildQuotaView(parseQuotaDocument(exhausted)).rows[0].availabilityLabel, /耗尽/);
});

test('quota-1：未知 schema 版本与未知字段都被拒绝', () => {
    const wrongVersion = quotaFixture();
    wrongVersion.schemaVersion = 'workbuddy-executor/quota-2';
    assert.throws(() => parseQuotaDocument(wrongVersion), error => error instanceof ResourceSchemaError && error.code === 'UNKNOWN_SCHEMA');
    const extra = quotaFixture();
    extra.observations[0].region = 'cn';
    assert.throws(() => parseQuotaDocument(extra), ResourceSchemaError);
    const missing = quotaFixture();
    delete missing.observations[0].method;
    assert.throws(() => parseQuotaDocument(missing), ResourceSchemaError);
});

test('quota-1：未识别的限制代码不冒充已知限制', () => {
    const raw = quotaFixture();
    raw.observations[0].limitations = ['routing_unverified', 'future_limit_code'];
    const limits = buildQuotaView(parseQuotaDocument(raw)).rows[0].limitations;
    assert.equal(limits.length, 2);
    assert.equal(limits[1].known, false);
    assert.equal(limits[1].code, 'future_limit_code');
    assert.match(limits[1].label, /未识别/);
});

test('credit-balance-1：部分覆盖、缓存新鲜度与积分单位', () => {
    const view = buildCreditView(parseCreditDocument(creditFixture()));
    const row = view.rows[0];
    assert.equal(row.unitLabel, '积分');
    assert.equal(row.coverage, 'partial');
    assert.match(row.coverageLabel, /部分/);
    assert.equal(row.coverageRatio, formatRatio(2, 3));
    assert.equal(row.balanceText, formatCredits(120));
    assert.equal(row.cacheFreshnessLabel.length > 0, true);
    assert.equal(row.balanceFreshness, 'stale');
    assert.equal(view.stats.partial, 1);
});

test('credit-balance-1：零个成员数据时必须为 null，且覆盖率必须自洽', () => {
    const empty = creditFixture();
    empty.balances[0].accountsWithData = 0;
    empty.balances[0].balance = null;
    empty.balances[0].coverage = 'unavailable';
    empty.balances[0].latestMemberObservedAt = null;
    const view = buildCreditView(parseCreditDocument(empty));
    assert.equal(view.rows[0].balanceText, null);
    assert.equal(formatCredits(null), null);
    assert.equal(view.stats.unknownBalance, 1);

    const lying = creditFixture();
    lying.balances[0].coverage = 'complete';
    assert.throws(() => parseCreditDocument(lying), ResourceSchemaError);

    const zeroWithBalance = creditFixture();
    zeroWithBalance.balances[0].accountsWithData = 0;
    zeroWithBalance.balances[0].coverage = 'unavailable';
    assert.throws(() => parseCreditDocument(zeroWithBalance), ResourceSchemaError);
});

test('credit-balance-1：积分不会被当成货币或与 token 合并', () => {
    const view = buildCreditView(parseCreditDocument(creditFixture()));
    const row = view.rows[0];
    assert.equal(row.unit, 'credit');
    assert.equal(view.schemaVersion, CREDIT_SCHEMA);
    assert.equal(Object.hasOwn(row, 'totalText'), false);
    assert.doesNotMatch(row.balanceText, /[¥$€]/);
});

test('空状态区分未配置、未观测与本次无记录', () => {
    assert.equal(emptyStateOf(null), 'unavailable');
    assert.equal(emptyStateOf({ connections: [], rows: [] }), 'unconfigured');
    assert.equal(emptyStateOf({ connections: [{ status: 'not_observed' }], rows: [] }), 'not_observed');
    assert.equal(emptyStateOf({ connections: [{ status: 'observed' }], rows: [] }), 'empty');
    assert.equal(emptyStateOf({ connections: [{ status: 'observed' }], rows: [{}] }), 'ready');
});

test('时间戳：null 与坏值都不写成 0 或当天', () => {
    assert.equal(formatStamp(null), NULL_TEXT);
    assert.equal(formatStamp('not-a-time'), '时间不可读');
    assert.match(formatStamp('2026-11-04T08:00:00.000Z'), /^2026-11-04 \d{2}:\d{2}$/);
});

test('竞态保护：新读取令旧票据失效并中止旧请求', () => {
    const guard = createReadGuard();
    const first = guard.begin();
    assert.equal(first.isCurrent(), true);
    const second = guard.begin();
    assert.equal(first.isCurrent(), false);
    assert.equal(first.signal.aborted, true);
    assert.equal(second.isCurrent(), true);
    second.finish();
    guard.cancel();
    assert.equal(second.isCurrent(), false);
});

test('compareSnapshots 只在采集时间相差较大时提示轮次不同', () => {
    const quota = parseQuotaDocument(quotaFixture());
    const sameRound = compareSnapshots(quota, parseCreditDocument(creditFixture()));
    assert.deepEqual(sameRound.drifted, []);
    assert.equal(sameRound.consistent, true);
    assert.equal(sameRound.maxDriftMs, 0);
    const later = creditFixture();
    later.connections[0].collectedAt = '2026-11-04T09:30:00.000Z';
    const drifted = compareSnapshots(quota, parseCreditDocument(later));
    assert.equal(drifted.consistent, false);
    assert.deepEqual(drifted.drifted.map(item => item.connectionId), ['conn-a']);
    assert.equal(drifted.maxDriftMs, 90 * 60 * 1000);
});
