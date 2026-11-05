/**
 * 资源页的只读数据层。
 *
 * 只接受本轮冻结的两个响应结构（quota-1 / credit-balance-1），把它们解析成
 * 页面可以逐项渲染的事实。凡是多字段、少字段或枚举值超出本页支持范围的结构，
 * 一律抛出 ResourceSchemaError —— 页面据此显示“结构未受支持”，并保留上一份
 * 成功读取的快照，绝不猜测字段、绝不把 null 补成 0。
 */

export const QUOTA_SCHEMA = 'workbuddy-executor/quota-1';
export const CREDIT_SCHEMA = 'workbuddy-executor/credit-balance-1';

/** 缺值统一写法：null 就是“没有这个读数”，不是零。 */
export const NULL_TEXT = '未提供';

/** 未核验路由时页面必须原样说明的范围，不写成“DSH 独占额度”。 */
export const ROUTING_CAVEAT = '网关汇总，尚未验证为本任务可用。';

export class ResourceSchemaError extends Error {
    constructor(path, detail) {
        super('资源响应结构未受支持：' + path + ' ' + detail);
        this.name = 'ResourceSchemaError';
        this.code = 'UNKNOWN_SCHEMA';
        this.path = path;
    }
}

const QUOTA_TOP_KEYS = ['schemaVersion', 'readOnly', 'connections', 'observations', 'truncated', 'attribution', 'actualTaskCredits', 'actualTaskTokens'];
const QUOTA_CONNECTION_KEYS = ['connectionId', 'status', 'errorCode', 'snapshotId', 'collectedAt', 'sourceObservedAt', 'expiresAt', 'freshness'];
const QUOTA_OBSERVATION_KEYS = ['scopeId', 'scopeKind', 'shared', 'modelId', 'realm', 'unit', 'valueKind', 'availability', 'used', 'budget', 'remaining', 'resetAt', 'method', 'limitations', 'connectionId', 'snapshotId', 'sourceObservedAt', 'collectedAt', 'connectionIds'];
const CREDIT_TOP_KEYS = ['schemaVersion', 'readOnly', 'connections', 'balances', 'actualTaskCredits', 'attribution'];
const CREDIT_CONNECTION_KEYS = ['connectionId', 'status', 'errorCode', 'snapshotId', 'collectedAt', 'cacheFreshness'];
const CREDIT_BALANCE_KEYS = ['snapshotId', 'connectionId', 'scopeId', 'realm', 'unit', 'valueKind', 'balance', 'accountsEnabled', 'accountsWithData', 'coverage', 'latestMemberObservedAt', 'collectedAt', 'cacheExpiresAt', 'errorCode', 'connectionIds', 'shared', 'scopeKind', 'balanceFreshness', 'limitations'];

const SCOPE_ID_PATTERN = /^pool-[a-f0-9]{32}$/;
const CONNECTION_STATUS = ['observed', 'not_observed', 'unavailable'];
const QUOTA_FRESHNESS = ['fresh', 'stale', 'unavailable'];
const AVAILABILITY = ['available', 'exhausted', 'unknown'];
const QUOTA_VALUE_KIND = ['estimated', 'unavailable'];
const QUOTA_METHOD = ['source_cooling_and_historical_budget', 'historical_budget_minus_observed_usage'];
const COVERAGE = ['complete', 'partial', 'unavailable'];
const BALANCE_FRESHNESS = ['stale', 'unavailable'];

export const LIMITATION_LABELS = {
    routing_unverified: '路由未核验：网关汇总，尚未验证为本任务可用',
    shared_pool: '多账号共享同一额度池，不是本任务独占',
    budget_estimated: '预算来自历史用量推算，是估算值',
    gateway_observed_usage_only: '只统计网关观测到的用量，账号直连用量不在其中',
    task_attribution_unavailable: '无法把用量归因到具体任务',
    shared_region_pool: '区域共享池，余额不归属单个账号或任务',
    latest_member_timestamp_only: '仅有成员最新观测时间，不代表整池同步时间',
    member_freshness_unavailable: '成员级新鲜度不可用',
    // 路由证据（routing-evidence-1）随附的限制码：逐条说明证据的边界。
    model_scope_unverified: '模型作用域未核验：无法确认某个模型只由一个 Key 提供',
    declaration_only: '只是本机声明，未与上游核对',
    no_key_verification: '未验证凭据是否有效，也不读取账号里已有的密钥',
    no_upstream_probe: '不探测上游：页面读取不会触发任何真实请求',
    declaration_does_not_verify_routing: '声明不构成对实际请求路由的证明',
    diagnostics_do_not_probe_upstream: '诊断只比对已存快照，不发起上游探测',
    request_attribution_unavailable: '上游载荷没有请求标识，无法按请求归因',
    task_to_model_unverified: '任务 → 模型未核验，保持未知',
    unit_mixing_forbidden: 'token 与积分单位不同，不换算也不相加',
    no_estimate_substituted: '缺值保持 null，不用估算值顶替',
};

export const STATUS_LABELS = {
    observed: '已观测到快照',
    not_observed: '尚未观测到快照',
    unavailable: '采集不可用',
};

export function limitationLabel(code) {
    return LIMITATION_LABELS[code] ?? '未识别的限制代码（' + code + '）';
}

export function describeLimitations(codes) {
    return codes.map(code => ({ code, known: Object.hasOwn(LIMITATION_LABELS, code), label: limitationLabel(code) }));
}

export function formatStamp(value) {
    if (value === null || value === undefined || value === '') return NULL_TEXT;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return '时间不可读';
    const date = new Date(time);
    const pad = number => String(number).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 千分位；保留原始小数位，不做取整也不补零。 */
export function formatCount(value) {
    if (value === null || value === undefined) return null;
    if (!Number.isFinite(value)) return null;
    const negative = value < 0;
    const [whole, fraction] = String(Math.abs(value)).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (negative ? '-' : '') + grouped + (fraction ? '.' + fraction : '');
}

export function formatTokens(value) {
    return formatCount(value);
}

/** 积分不是货币：文本里不出现货币符号，也不与 token 相加。 */
export function formatCredits(value) {
    return formatCount(value);
}

export function formatRatio(accountsWithData, accountsEnabled) {
    if (!Number.isInteger(accountsWithData) || !Number.isInteger(accountsEnabled)) return null;
    return accountsWithData + ' / ' + accountsEnabled + ' 个已启用账号有数据';
}

const REALM_LABELS = { cn: '中国大陆（cn）', intl: '国际（intl）' };
export function realmLabel(realm) {
    return REALM_LABELS[realm] ?? '未知区域（' + realm + '）';
}

const SCOPE_KIND_LABELS = { gateway_pool: '网关账号池', gateway_region_pool: '网关区域池' };
export function scopeKindLabel(kind) {
    return SCOPE_KIND_LABELS[kind] ?? '未识别作用域（' + kind + '）';
}

const FRESHNESS_DETAIL = {
    fresh: '新鲜：本地采集在有效期内',
    stale: '陈旧：超出有效期或最近一次采集报错',
    unavailable: '不可用：没有可用的上游快照',
};
export function freshnessLabel(freshness) {
    return FRESHNESS_DETAIL[freshness] ?? '未知新鲜度（' + freshness + '）';
}
export function freshnessTone(freshness) {
    if (freshness === 'fresh') return 'positive';
    if (freshness === 'stale') return 'warning';
    return 'neutral';
}

const AVAILABILITY_LABELS = {
    available: '未观测到耗尽证据',
    exhausted: '已证实耗尽（存在触顶证据）',
    unknown: '可用性未知',
};
export function availabilityLabel(availability) {
    return AVAILABILITY_LABELS[availability] ?? '可用性未知';
}
export function availabilityTone(availability) {
    if (availability === 'exhausted') return 'negative';
    if (availability === 'unknown') return 'warning';
    return 'neutral';
}

const QUOTA_VALUE_KIND_LABELS = {
    estimated: '估算值：由上游用量与历史预算推算',
    unavailable: '未取得数值：上游没有给出可用读数',
};
export function quotaValueKindLabel(kind) {
    return QUOTA_VALUE_KIND_LABELS[kind] ?? '未知取值类型（' + kind + '）';
}

const METHOD_LABELS = {
    source_cooling_and_historical_budget: '方法：来源冷却时间 + 历史预算推算',
    historical_budget_minus_observed_usage: '方法：历史预算减去网关观测用量',
};
export function methodLabel(method) {
    return METHOD_LABELS[method] ?? '方法未识别（' + method + '）';
}

export function coverageLabel(coverage) {
    if (coverage === 'complete') return '覆盖完整：所有已启用账号都有数据';
    if (coverage === 'partial') return '部分覆盖：余额只是已知账号之和';
    if (coverage === 'unavailable') return '无成员数据：未合成余额';
    return '未知覆盖率（' + coverage + '）';
}
export function coverageTone(coverage) {
    if (coverage === 'complete') return 'positive';
    if (coverage === 'partial') return 'warning';
    return 'neutral';
}

export function cacheFreshnessLabel(freshness) {
    if (freshness === 'fresh') return '缓存新鲜：本地采集近期成功';
    if (freshness === 'stale') return '缓存陈旧：本地采集已过期或报错';
    return '缓存不可用：没有本地采集快照';
}

export function balanceFreshnessLabel(freshness) {
    if (freshness === 'stale') return '余额陈旧：成员观测时间早于缓存窗口';
    return '余额新鲜度不可用：只能确认缓存时间';
}

export function creditValueKindLabel(kind) {
    return kind === 'reported_cache' ? '上游报告的缓存余额（非实时）' : '未知取值类型（' + kind + '）';
}

function fail(path, detail) {
    throw new ResourceSchemaError(path, detail);
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectObject(value, path) {
    if (!isPlainObject(value)) fail(path, '应为对象');
    return value;
}

function expectArray(value, path) {
    if (!Array.isArray(value)) fail(path, '应为数组');
    return value;
}

function expectExactKeys(value, keys, path) {
    const actual = Object.keys(value);
    const missing = keys.filter(key => !actual.includes(key));
    const extra = actual.filter(key => !keys.includes(key));
    if (missing.length) fail(path, '缺少字段 ' + missing.join('、'));
    if (extra.length) fail(path, '出现未支持字段 ' + extra.join('、'));
    return value;
}

function expectString(value, path, { allowNull = false, pattern = null, nonEmpty = true } = {}) {
    if (value === null) {
        if (allowNull) return null;
        fail(path, '不应为 null');
    }
    if (typeof value !== 'string') fail(path, '应为字符串');
    if (nonEmpty && value.length === 0) fail(path, '不应为空字符串');
    if (pattern && !pattern.test(value)) fail(path, '取值不符合约定格式');
    return value;
}

function expectBoolean(value, path, expected) {
    if (typeof value !== 'boolean') fail(path, '应为布尔值');
    if (expected !== undefined && value !== expected) fail(path, '应为 ' + String(expected));
    return value;
}

function expectEnum(value, allowed, path) {
    if (typeof value !== 'string' || !allowed.includes(value)) fail(path, '取值不在已支持范围内（' + String(value) + '）');
    return value;
}

function expectNull(value, path) {
    if (value !== null) fail(path, '本轮应为 null');
    return null;
}

function expectInteger(value, path, { allowNull = false } = {}) {
    if (value === null && allowNull) return null;
    if (!Number.isSafeInteger(value) || value < 0) fail(path, '应为非负安全整数或 null');
    return value;
}

function expectFiniteNumber(value, path, { allowNull = false } = {}) {
    if (value === null && allowNull) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(path, '应为非负数值或 null');
    return value;
}

function expectNullableTime(value, path) {
    if (value === null) return null;
    return expectString(value, path, { pattern: /^\d{4}-\d{2}-\d{2}T/ });
}

function expectStringList(value, path) {
    return expectArray(value, path).map((item, index) => expectString(item, path + '[' + index + ']'));
}

function parseQuotaConnection(raw, path) {
    const value = expectExactKeys(expectObject(raw, path), QUOTA_CONNECTION_KEYS, path);
    return {
        connectionId: expectString(value.connectionId, path + '.connectionId'),
        status: expectEnum(value.status, CONNECTION_STATUS, path + '.status'),
        errorCode: expectString(value.errorCode, path + '.errorCode', { allowNull: true }),
        snapshotId: expectString(value.snapshotId, path + '.snapshotId', { allowNull: true }),
        collectedAt: expectNullableTime(value.collectedAt, path + '.collectedAt'),
        sourceObservedAt: expectNullableTime(value.sourceObservedAt, path + '.sourceObservedAt'),
        expiresAt: expectNullableTime(value.expiresAt, path + '.expiresAt'),
        freshness: expectEnum(value.freshness, QUOTA_FRESHNESS, path + '.freshness'),
    };
}

function parseQuotaObservation(raw, path) {
    const value = expectExactKeys(expectObject(raw, path), QUOTA_OBSERVATION_KEYS, path);
    return {
        scopeId: expectString(value.scopeId, path + '.scopeId', { pattern: SCOPE_ID_PATTERN }),
        scopeKind: expectEnum(value.scopeKind, ['gateway_pool'], path + '.scopeKind'),
        shared: expectBoolean(value.shared, path + '.shared', true),
        modelId: expectString(value.modelId, path + '.modelId'),
        realm: expectEnum(value.realm, ['cn', 'intl'], path + '.realm'),
        unit: expectEnum(value.unit, ['tokens'], path + '.unit'),
        valueKind: expectEnum(value.valueKind, QUOTA_VALUE_KIND, path + '.valueKind'),
        availability: expectEnum(value.availability, AVAILABILITY, path + '.availability'),
        used: expectInteger(value.used, path + '.used', { allowNull: true }),
        budget: expectInteger(value.budget, path + '.budget', { allowNull: true }),
        remaining: expectInteger(value.remaining, path + '.remaining', { allowNull: true }),
        resetAt: expectNullableTime(value.resetAt, path + '.resetAt'),
        method: expectEnum(value.method, QUOTA_METHOD, path + '.method'),
        limitations: expectStringList(value.limitations, path + '.limitations'),
        connectionId: expectString(value.connectionId, path + '.connectionId'),
        snapshotId: expectString(value.snapshotId, path + '.snapshotId'),
        sourceObservedAt: expectNullableTime(value.sourceObservedAt, path + '.sourceObservedAt'),
        collectedAt: expectNullableTime(value.collectedAt, path + '.collectedAt'),
        connectionIds: expectStringList(value.connectionIds, path + '.connectionIds'),
    };
}

export function parseQuotaDocument(raw) {
    const value = expectExactKeys(expectObject(raw, 'quota'), QUOTA_TOP_KEYS, 'quota');
    if (value.schemaVersion !== QUOTA_SCHEMA) fail('quota.schemaVersion', '不是 ' + QUOTA_SCHEMA);
    expectBoolean(value.readOnly, 'quota.readOnly', true);
    expectNull(value.actualTaskCredits, 'quota.actualTaskCredits');
    expectNull(value.actualTaskTokens, 'quota.actualTaskTokens');
    const connections = expectArray(value.connections, 'quota.connections').map((item, index) => parseQuotaConnection(item, 'quota.connections[' + index + ']'));
    const observations = expectArray(value.observations, 'quota.observations').map((item, index) => parseQuotaObservation(item, 'quota.observations[' + index + ']'));
    return {
        schemaVersion: QUOTA_SCHEMA,
        readOnly: true,
        connections,
        observations,
        truncated: expectBoolean(value.truncated, 'quota.truncated'),
        attribution: expectEnum(value.attribution, ['connection_only'], 'quota.attribution'),
        actualTaskCredits: null,
        actualTaskTokens: null,
    };
}

function parseCreditConnection(raw, path) {
    const value = expectExactKeys(expectObject(raw, path), CREDIT_CONNECTION_KEYS, path);
    return {
        connectionId: expectString(value.connectionId, path + '.connectionId'),
        status: expectEnum(value.status, CONNECTION_STATUS, path + '.status'),
        errorCode: expectString(value.errorCode, path + '.errorCode', { allowNull: true }),
        snapshotId: expectString(value.snapshotId, path + '.snapshotId', { allowNull: true }),
        collectedAt: expectNullableTime(value.collectedAt, path + '.collectedAt'),
        cacheFreshness: expectEnum(value.cacheFreshness, QUOTA_FRESHNESS, path + '.cacheFreshness'),
    };
}

function parseCreditBalance(raw, path) {
    const value = expectExactKeys(expectObject(raw, path), CREDIT_BALANCE_KEYS, path);
    const accountsEnabled = expectInteger(value.accountsEnabled, path + '.accountsEnabled');
    const accountsWithData = expectInteger(value.accountsWithData, path + '.accountsWithData');
    if (accountsWithData > accountsEnabled) fail(path + '.accountsWithData', '不应大于已启用账号数');
    const balance = expectFiniteNumber(value.balance, path + '.balance', { allowNull: true });
    const coverage = expectEnum(value.coverage, COVERAGE, path + '.coverage');
    const expectedCoverage = accountsWithData === 0 ? 'unavailable' : accountsWithData === accountsEnabled ? 'complete' : 'partial';
    // 覆盖率是后端按成员数推导的；不一致说明结构已经变了，不当成可渲染的余额。
    if (coverage !== expectedCoverage) fail(path + '.coverage', '与账号数据数量不一致');
    // 没有成员数据时余额必须为 null；有数据时也允许 null（单项未知），
    // 但绝不把 null 解释成 0。
    if (accountsWithData === 0 && balance !== null) fail(path + '.balance', '无成员数据时余额应为 null');
    return {
        snapshotId: expectString(value.snapshotId, path + '.snapshotId'),
        connectionId: expectString(value.connectionId, path + '.connectionId'),
        scopeId: expectString(value.scopeId, path + '.scopeId'),
        realm: expectEnum(value.realm, ['cn', 'intl'], path + '.realm'),
        unit: expectEnum(value.unit, ['credit'], path + '.unit'),
        valueKind: expectEnum(value.valueKind, ['reported_cache'], path + '.valueKind'),
        balance,
        accountsEnabled,
        accountsWithData,
        coverage,
        latestMemberObservedAt: expectNullableTime(value.latestMemberObservedAt, path + '.latestMemberObservedAt'),
        collectedAt: expectNullableTime(value.collectedAt, path + '.collectedAt'),
        cacheExpiresAt: expectNullableTime(value.cacheExpiresAt, path + '.cacheExpiresAt'),
        errorCode: expectString(value.errorCode, path + '.errorCode', { allowNull: true }),
        connectionIds: expectStringList(value.connectionIds, path + '.connectionIds'),
        shared: expectBoolean(value.shared, path + '.shared', true),
        scopeKind: expectEnum(value.scopeKind, ['gateway_region_pool'], path + '.scopeKind'),
        balanceFreshness: expectEnum(value.balanceFreshness, BALANCE_FRESHNESS, path + '.balanceFreshness'),
        limitations: expectStringList(value.limitations, path + '.limitations'),
    };
}

export function parseCreditDocument(raw) {
    const value = expectExactKeys(expectObject(raw, 'credit'), CREDIT_TOP_KEYS, 'credit');
    if (value.schemaVersion !== CREDIT_SCHEMA) fail('credit.schemaVersion', '不是 ' + CREDIT_SCHEMA);
    expectBoolean(value.readOnly, 'credit.readOnly', true);
    expectNull(value.actualTaskCredits, 'credit.actualTaskCredits');
    const connections = expectArray(value.connections, 'credit.connections').map((item, index) => parseCreditConnection(item, 'credit.connections[' + index + ']'));
    const balances = expectArray(value.balances, 'credit.balances').map((item, index) => parseCreditBalance(item, 'credit.balances[' + index + ']'));
    return {
        schemaVersion: CREDIT_SCHEMA,
        readOnly: true,
        connections,
        balances,
        actualTaskCredits: null,
        attribution: expectEnum(value.attribution, ['connection_only'], 'credit.attribution'),
    };
}

function connectionFacts(connection, freshnessKey) {
    return {
        connectionId: connection.connectionId,
        status: connection.status,
        statusLabel: STATUS_LABELS[connection.status],
        errorCode: connection.errorCode,
        errorText: connection.errorCode ? '最近一次采集错误：' + connection.errorCode : null,
        snapshotId: connection.snapshotId,
        collectedAt: connection.collectedAt,
        collectedAtText: formatStamp(connection.collectedAt),
        sourceObservedAt: connection.sourceObservedAt ?? null,
        sourceObservedAtText: connection.sourceObservedAt === undefined ? null : formatStamp(connection.sourceObservedAt),
        expiresAt: connection.expiresAt ?? null,
        expiresAtText: connection.expiresAt === undefined ? null : formatStamp(connection.expiresAt),
        freshness: connection[freshnessKey],
        freshnessLabel: freshnessKey === 'cacheFreshness' ? cacheFreshnessLabel(connection[freshnessKey]) : freshnessLabel(connection[freshnessKey]),
        freshnessTone: freshnessTone(connection[freshnessKey]),
    };
}

/** 页面按 modelId + 区域稳定排序；后端已排好时保持原顺序。 */
function stableOrder(rows) {
    return rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
            const left = a.row.modelId + '|' + a.row.realm;
            const right = b.row.modelId + '|' + b.row.realm;
            const compared = left.localeCompare(right);
            return compared === 0 ? a.index - b.index : compared;
        })
        .map(entry => entry.row);
}

export function buildQuotaView(document, { now = Date.now } = {}) {
    void now;
    const byConnection = new Map(document.connections.map(connection => [connection.connectionId, connection]));
    const rows = stableOrder(document.observations.map(observation => {
        const connection = byConnection.get(observation.connectionId);
        const freshness = connection?.freshness ?? 'unavailable';
        return {
            key: observation.scopeId + ':' + observation.modelId,
            connectionId: observation.connectionId,
            connectionIds: observation.connectionIds,
            modelId: observation.modelId,
            realm: observation.realm,
            realmLabel: realmLabel(observation.realm),
            scopeId: observation.scopeId,
            scopeLabel: scopeKindLabel(observation.scopeKind),
            shared: true,
            unit: 'tokens',
            unitLabel: 'token',
            valueKind: observation.valueKind,
            valueKindLabel: quotaValueKindLabel(observation.valueKind),
            availability: observation.availability,
            availabilityLabel: availabilityLabel(observation.availability),
            availabilityTone: availabilityTone(observation.availability),
            used: observation.used,
            budget: observation.budget,
            remaining: observation.remaining,
            usedText: formatTokens(observation.used),
            budgetText: formatTokens(observation.budget),
            remainingText: formatTokens(observation.remaining),
            resetAt: observation.resetAt,
            resetText: formatStamp(observation.resetAt),
            method: observation.method,
            methodLabel: methodLabel(observation.method),
            sourceObservedAt: observation.sourceObservedAt,
            sourceObservedAtText: formatStamp(observation.sourceObservedAt),
            collectedAt: observation.collectedAt,
            collectedAtText: formatStamp(observation.collectedAt),
            freshness,
            freshnessLabel: freshnessLabel(freshness),
            freshnessTone: freshnessTone(freshness),
            limitations: describeLimitations(observation.limitations),
            routingVerified: false,
        };
    }));
    return {
        schemaVersion: QUOTA_SCHEMA,
        readOnly: true,
        attribution: document.attribution,
        attributionText: '按连接归因：网关汇总，未归因到任务',
        truncated: document.truncated,
        connections: document.connections.map(connection => connectionFacts(connection, 'freshness')),
        rows,
        stats: {
            connections: document.connections.length,
            observed: document.connections.filter(connection => connection.status === 'observed').length,
            unavailable: document.connections.filter(connection => connection.status === 'unavailable').length,
            notObserved: document.connections.filter(connection => connection.status === 'not_observed').length,
            rows: rows.length,
            exhausted: rows.filter(row => row.availability === 'exhausted').length,
            stale: rows.filter(row => row.freshness === 'stale').length,
        },
    };
}

export function buildCreditView(document) {
    const byConnection = new Map(document.connections.map(connection => [connection.connectionId, connection]));
    const rows = document.balances
        .map((balance, index) => ({ balance, index }))
        .sort((a, b) => {
            const compared = (a.balance.scopeId + '|' + a.balance.realm).localeCompare(b.balance.scopeId + '|' + b.balance.realm);
            return compared === 0 ? a.index - b.index : compared;
        })
        .map(entry => entry.balance)
        .map(balance => {
            const connection = byConnection.get(balance.connectionId);
            return {
                key: balance.scopeId,
                connectionId: balance.connectionId,
                connectionIds: balance.connectionIds,
                scopeId: balance.scopeId,
                scopeLabel: scopeKindLabel(balance.scopeKind),
                shared: true,
                realm: balance.realm,
                realmLabel: realmLabel(balance.realm),
                unit: 'credit',
                unitLabel: '积分',
                valueKind: balance.valueKind,
                valueKindLabel: creditValueKindLabel(balance.valueKind),
                balance: balance.balance,
                balanceText: formatCredits(balance.balance),
                accountsEnabled: balance.accountsEnabled,
                accountsWithData: balance.accountsWithData,
                coverage: balance.coverage,
                coverageLabel: coverageLabel(balance.coverage),
                coverageTone: coverageTone(balance.coverage),
                coverageRatio: formatRatio(balance.accountsWithData, balance.accountsEnabled),
                latestMemberObservedAt: balance.latestMemberObservedAt,
                latestMemberObservedAtText: formatStamp(balance.latestMemberObservedAt),
                collectedAt: balance.collectedAt,
                collectedAtText: formatStamp(balance.collectedAt),
                cacheExpiresAt: balance.cacheExpiresAt,
                cacheExpiresAtText: formatStamp(balance.cacheExpiresAt),
                errorCode: balance.errorCode,
                errorText: balance.errorCode ? '最近一次采集错误：' + balance.errorCode : null,
                cacheFreshness: connection?.cacheFreshness ?? 'unavailable',
                cacheFreshnessLabel: cacheFreshnessLabel(connection?.cacheFreshness ?? 'unavailable'),
                cacheFreshnessTone: freshnessTone(connection?.cacheFreshness ?? 'unavailable'),
                balanceFreshness: balance.balanceFreshness,
                balanceFreshnessLabel: balanceFreshnessLabel(balance.balanceFreshness),
                balanceFreshnessTone: freshnessTone(balance.balanceFreshness),
                limitations: describeLimitations(balance.limitations),
                routingVerified: false,
            };
        });
    return {
        schemaVersion: CREDIT_SCHEMA,
        readOnly: true,
        attribution: document.attribution,
        attributionText: '按连接归因：网关汇总，未归因到任务',
        connections: document.connections.map(connection => connectionFacts(connection, 'cacheFreshness')),
        rows,
        stats: {
            connections: document.connections.length,
            observed: document.connections.filter(connection => connection.status === 'observed').length,
            unavailable: document.connections.filter(connection => connection.status === 'unavailable').length,
            notObserved: document.connections.filter(connection => connection.status === 'not_observed').length,
            rows: rows.length,
            partial: rows.filter(row => row.coverage === 'partial').length,
            unknownBalance: rows.filter(row => row.balance === null).length,
        },
    };
}

/**
 * 一个资源分区该显示哪种空状态。调用方据此决定渲染方式，避免把
 * “未配置”“尚未观测”“本次没有记录”混成同一句“暂无数据”。
 */
export function emptyStateOf(view) {
    if (!view) return 'unavailable';
    if (view.connections.length === 0) return 'unconfigured';
    if (!view.connections.some(connection => connection.status === 'observed')) return 'not_observed';
    if (view.rows.length === 0) return 'empty';
    return 'ready';
}

/**
 * 竞态保护：每次读取拿到一张票据。开始新读取会中止旧的请求；
 * 旧结果即使晚到，isCurrent() 也已经是 false，只能被丢弃。
 */
export function createReadGuard() {
    let serial = 0;
    let controller = null;
    return {
        begin() {
            controller?.abort();
            controller = new AbortController();
            const ticket = ++serial;
            return {
                signal: controller.signal,
                isCurrent: () => ticket === serial,
                finish: () => { if (ticket === serial) controller = null; },
            };
        },
        cancel() {
            serial += 1;
            controller?.abort();
            controller = null;
        },
        get serial() {
            return serial;
        },
    };
}

/** 两个接口的 snapshotId 是否指向同一批快照；无法比较时返回 null。 */
// 两个接口各自维护快照，快照编号天然不同，不能拿来判定采集轮次；
// 只有同一连接的采集时间相差到 SNAPSHOT_DRIFT_MS 以上，才提示分区数据可能来自不同轮次。
export const SNAPSHOT_DRIFT_MS = 5 * 60 * 1000;

export function compareSnapshots(quotaDocument, creditDocument) {
    if (!quotaDocument || !creditDocument) return { consistent: null, drifted: [], maxDriftMs: 0 };
    const quotaTimes = new Map(quotaDocument.connections.map(connection => [connection.connectionId, connection.collectedAt]));
    const drifted = [];
    let maxDriftMs = 0;
    for (const connection of creditDocument.connections) {
        if (!quotaTimes.has(connection.connectionId)) continue;
        const quotaAt = quotaTimes.get(connection.connectionId);
        const creditAt = connection.collectedAt;
        if (!quotaAt || !creditAt) continue;
        const delta = Math.abs(Date.parse(quotaAt) - Date.parse(creditAt));
        if (!Number.isFinite(delta) || delta < SNAPSHOT_DRIFT_MS) continue;
        drifted.push({ connectionId: connection.connectionId, driftMs: delta });
        maxDriftMs = Math.max(maxDriftMs, delta);
    }
    return { consistent: drifted.length === 0, drifted, maxDriftMs };
}

/* ------------------------------------------------------------------ *
 * 路由证据（routing-evidence-1）
 *
 * 三层证据各说各话，页面只做转写：
 *   1. 配置层：哪个连接声明了哪些池和模型 —— 来自本机声明文件，仅声明；
 *   2. 执行选择层：某次执行选了哪个连接/池/模型 —— 来自本机关联文件，仅声明；
 *   3. 实际请求路由：上游到底把哪次请求送到哪个账号 —— 上游载荷没有请求标识，
 *      这一层恒为不可用。
 * 任何一层都不得升级成“已验证”，也不得因为声明互相匹配就宣称实际命中。
 * ------------------------------------------------------------------ */

export const ROUTING_SCHEMA = 'workbuddy-executor/routing-evidence-1';

export const TRUST_LAYER_IDS = ['configuration', 'executionSelection', 'requestRouting'];

export const TRUST_LEVEL_LABELS = {
    observed: '观测到快照',
    expired: '快照已过期',
    unavailable: '不可用',
    unobserved: '尚未观测',
    gateway_observation_only: '仅网关观测',
    declaration_only: '仅声明',
};

export const TRUST_LEVEL_TONES = {
    observed: 'ok',
    expired: 'warn',
    unavailable: 'warn',
    unobserved: 'neutral',
    gateway_observation_only: 'info',
    declaration_only: 'info',
};

export const TRUST_LAYER_TITLES = {
    configuration: '配置：连接 → 池 → 模型',
    executionSelection: '执行选择（声明）',
    requestRouting: '实际请求路由',
};

export const TRUST_LAYER_SOURCES = {
    configuration: 'WORKBUDDY_RESOURCE_CONNECTIONS_FILE',
    executionSelection: 'WORKBUDDY_RESOURCE_LINKS_FILE',
    requestRouting: 'upstream_usage_payload',
};

export const REGISTRY_STATUS_LABELS = {
    not_declared: '尚未声明固定连接',
    declared: '已声明固定连接',
    invalid_file: '声明文件不可用',
};

export const DECLARATION_STATUS_LABELS = {
    declared: '声明有效',
    ambiguous: '声明有歧义',
    invalid: '声明无效',
};

export const CONFLICT_LABELS = {
    duplicate_connection: '同一 connectionId 被声明多次',
    duplicate_pool_declaration: '同一个池被多个连接重复声明',
    realm_conflict: '同一个池被声明到不同区域',
    shared_flag_conflict: '同一个池的共享标记互相矛盾',
};

export const DIAGNOSTIC_LABELS = {
    declaration_invalid: '声明无效，不能据此推断可用',
    declaration_ambiguous: '声明有歧义，不代为择一',
    credential_absent: '声明引用的凭据变量在当前进程里未设置',
    declared_not_configured: '已声明，但本进程未配置对应采集连接',
    declared_and_observed: '声明与观测一致（只说明两边对上了，不代表请求命中）',
    declared_no_snapshot: '已声明，但还没有任何快照',
    observed_pool_outside_declaration: '观测到的池不在声明里',
    declared_pool_not_observed: '声明的池没有观测到',
    realm_mismatch: '声明区域与观测区域不同',
    declared_model_not_observed: '声明的模型没有观测到',
    // 声明文件解析期诊断：这些码来自网关，页面必须逐条给出中文说明，不能落到“未识别的诊断码”。
    credential_reference_missing: '声明缺少凭据引用，只登记连接但无法采集',
    credential_reference_invalid: '凭据引用必须写成环境变量名，不能内联凭据值',
    credential_presence_only: '只知道凭据变量是否已设置，不知道它是否有效',
    models_not_supported: '这类连接不支持模型限制，声明里的 models 被忽略',
    models_not_array: 'models 必须是数组',
    pools_not_array: 'pools 必须是数组',
    pool_id_invalid: '池标识必须形如 pool-<32 位小写十六进制>',
    model_id_invalid: '模型标识不可用',
    connection_id_invalid: '连接标识不可用',
    resource_invalid: 'resource 必须是 quota 或 credit',
    connection_not_object: '连接条目必须是对象',
    source_url_invalid: '来源地址必须是本机回环 HTTP 源',
    realm_invalid: '区域必须是 cn 或 intl',
    shared_invalid: 'shared 必须是布尔值',
    declared_at_invalid: '声明时间不可解析',
    duplicate_connection: '同一 connectionId 被声明多次',
    duplicate_pool_declaration: '同一个池被多个连接重复声明',
    realm_conflict: '同一个池被声明到不同区域',
    shared_flag_conflict: '同一个池的共享标记互相矛盾',
};

export const ATTRIBUTION_STATUS_LABELS = {
    unavailable: '上游未提供请求归因',
};

export const ATTRIBUTION_FIELD_LABELS = {
    requestId: '请求编号',
    taskId: '任务编号',
    sessionId: '会话编号',
    role: '角色',
    unit: '单位',
    usageLevel: '用量层级',
    value: '用量数值',
    taskToModel: '任务 → 模型',
    sessionToProvider: '会话 → 提供方',
    requestToAccount: '请求 → 账号',
};

export const KNOWN_AT_LABELS = {
    connection: '连接',
    pool: '池',
    modelAggregate: '账号×模型汇总',
    task: '任务',
    session: '会话',
    request: '单次请求',
};

export function trustLevelLabel(level) {
    return TRUST_LEVEL_LABELS[level] ?? '未识别的证据层级（' + level + '）';
}

export function trustLevelTone(level) {
    return TRUST_LEVEL_TONES[level] ?? 'neutral';
}

/** 诊断码带参数时拆成 “基础码 + 参数”，保证新增上游错误码不会退化成未知。 */
export function diagnosticLabel(code) {
    if (Object.hasOwn(DIAGNOSTIC_LABELS, code)) return DIAGNOSTIC_LABELS[code];
    const [head, ...rest] = String(code).split(':');
    if (head === 'observed_source_error') return '观测侧采集报错：' + (rest.join(':') || '未提供错误码');
    return '未识别的诊断码（' + code + '）';
}

function requireObject(value, path) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResourceSchemaError(path, '必须是对象');
    return value;
}

function requireArray(value, path) {
    if (!Array.isArray(value)) throw new ResourceSchemaError(path, '必须是数组');
    return value;
}

function requireBoolean(value, path) {
    if (typeof value !== 'boolean') throw new ResourceSchemaError(path, '必须是布尔值');
    return value;
}

/** 只校验本页真正会读的字段；缺失即整份文档不受支持，绝不补默认值。 */
export function parseRoutingDocument(raw) {
    const document = requireObject(raw, 'routing');
    if (document.schemaVersion !== ROUTING_SCHEMA) throw new ResourceSchemaError('routing.schemaVersion', '期望 ' + ROUTING_SCHEMA);
    requireBoolean(document.readOnly, 'routing.readOnly');
    if (document.readOnly !== true) throw new ResourceSchemaError('routing.readOnly', '只读视图不应为 false');
    requireBoolean(document.routingVerified, 'routing.routingVerified');
    if (document.routingVerified !== false) throw new ResourceSchemaError('routing.routingVerified', '本页不支持已核验的路由声明');
    if (typeof document.generatedAt !== 'string' || !Number.isFinite(Date.parse(document.generatedAt))) {
        throw new ResourceSchemaError('routing.generatedAt', '必须是可解析的时间');
    }
    requireArray(document.connections, 'routing.connections');
    requireArray(document.mappings, 'routing.mappings');
    requireArray(document.limitations, 'routing.limitations');
    const layers = requireObject(document.layers, 'routing.layers');
    for (const id of TRUST_LAYER_IDS) {
        const layer = requireObject(layers[id], 'routing.layers.' + id);
        if (layer.code !== undefined && typeof layer.code !== 'string') throw new ResourceSchemaError('routing.layers.' + id + '.code', '必须是字符串');
        if (!Object.hasOwn(TRUST_LEVEL_LABELS, layer.level)) throw new ResourceSchemaError('routing.layers.' + id + '.level', '未知层级 ' + String(layer.level));
        requireBoolean(layer.verified, 'routing.layers.' + id + '.verified');
        if (layer.verified !== false) throw new ResourceSchemaError('routing.layers.' + id + '.verified', '三层证据都不允许标记为已验证');
    }
    const registry = requireObject(document.connectionRegistry, 'routing.connectionRegistry');
    if (!Object.hasOwn(REGISTRY_STATUS_LABELS, registry.status)) throw new ResourceSchemaError('routing.connectionRegistry.status', '未知状态 ' + String(registry.status));
    requireArray(registry.connections, 'routing.connectionRegistry.connections');
    requireArray(registry.conflicts, 'routing.connectionRegistry.conflicts');
    const diagnostics = requireObject(document.connectionDiagnostics, 'routing.connectionDiagnostics');
    requireArray(diagnostics.connections, 'routing.connectionDiagnostics.connections');
    requireObject(diagnostics.summary, 'routing.connectionDiagnostics.summary');
    const attribution = requireObject(document.requestAttribution, 'routing.requestAttribution');
    if (!Object.hasOwn(ATTRIBUTION_STATUS_LABELS, attribution.status)) throw new ResourceSchemaError('routing.requestAttribution.status', '未知状态 ' + String(attribution.status));
    requireArray(attribution.integrationTodo, 'routing.requestAttribution.integrationTodo');
    return document;
}

function layerFact(id, layer) {
    const fact = {
        id,
        title: TRUST_LAYER_TITLES[id],
        source: layer.source ?? TRUST_LAYER_SOURCES[id],
        level: layer.level,
        levelLabel: trustLevelLabel(layer.level),
        tone: trustLevelTone(layer.level),
        verified: false,
        verifiedText: '未核验',
    };
    if (id === 'configuration') {
        fact.summary = '声明文件只说明“想怎么连”，不说明请求实际走了哪条路。';
    }
    else if (id === 'executionSelection') {
        fact.summary = '执行选择来自本机关联文件；关联匹配不等于请求命中，也不给出额度保证。';
    }
    else {
        fact.summary = '上游用量载荷没有请求标识，无法把任何一次调用归因到任务、会话或具体模型。';
        fact.reasonLabel = layer.reason ? '原因：' + layer.reason : null;
    }
    if (typeof layer.status === 'string') fact.statusText = layer.status;
    return fact;
}

/**
 * 把路由证据整理成页面可渲染的事实。所有 “已核验” 字样都不出现；
 * 声明、观测、实际路由分三块，互不推导。
 */
export function buildTrustView(document) {
    const layers = TRUST_LAYER_IDS.map(id => layerFact(id, document.layers[id]));
    const registry = document.connectionRegistry;
    const connections = registry.connections.map(item => ({
        connectionId: item.connectionId,
        resource: item.resource,
        resourceLabel: item.resource === 'quota' ? 'token 用量' : item.resource === 'credit' ? '积分余额' : String(item.resource),
        declaration: item.status,
        declarationLabel: DECLARATION_STATUS_LABELS[item.status] ?? String(item.status),
        realm: item.realm,
        realmLabel: realmLabel(item.realm),
        pools: Array.isArray(item.pools) ? item.pools : [],
        models: Array.isArray(item.models) ? item.models : [],
        shared: item.shared === true,
        credentials: (Array.isArray(item.credentials) ? item.credentials : []).map(credential => ({
            purpose: credential.purpose === 'panel_token' ? '面板令牌' : credential.purpose === 'api_key' ? 'API Key' : String(credential.purpose),
            envVar: credential.envVar,
            present: credential.present === true,
            presentLabel: credential.present === true ? '进程中已设置' : '进程中未设置',
        })),
        diagnostics: (Array.isArray(item.diagnostics) ? item.diagnostics : []).map(diagnostic => diagnosticLabel(diagnostic.code)),
    }));
    const conflicts = registry.conflicts.map(conflict => ({
        code: conflict.code,
        label: CONFLICT_LABELS[conflict.code] ?? '未识别的冲突（' + conflict.code + '）',
        connectionIds: Array.isArray(conflict.connectionIds) ? conflict.connectionIds : [],
        scopeId: conflict.scopeId ?? null,
        detail: conflict.detail ?? null,
    }));
    const summary = document.connectionDiagnostics.summary;
    const rows = document.connectionDiagnostics.connections.map(row => ({
        connectionId: row.connectionId,
        resource: row.resource,
        declaration: row.declaration,
        codes: (Array.isArray(row.codes) ? row.codes : []).map(code => ({ code, label: diagnosticLabel(code) })),
        notes: Array.isArray(row.notes) ? row.notes : [],
    }));
    const undeclaredIds = (Array.isArray(document.connectionDiagnostics.undeclaredObserved) ? document.connectionDiagnostics.undeclaredObserved : [])
        .map(item => (item && typeof item === 'object' ? item.connectionId : item))
        .filter(item => typeof item === 'string' && item.length > 0);
    const attribution = document.requestAttribution;
    const attributionFields = attribution.fields && typeof attribution.fields === 'object' ? attribution.fields : {};
    const knownAt = attribution.knownAt && typeof attribution.knownAt === 'object' ? attribution.knownAt : {};
    return {
        schemaVersion: document.schemaVersion,
        generatedAt: document.generatedAt,
        readOnly: true,
        routingVerified: false,
        basis: document.basis ?? null,
        layers,
        configuration: {
            status: registry.status,
            statusLabel: REGISTRY_STATUS_LABELS[registry.status],
            declaredVia: registry.source === 'file' ? (registry.declaredVia ?? 'WORKBUDDY_RESOURCE_CONNECTIONS_FILE') : registry.status === 'not_declared' ? '未提供声明文件' : (registry.declaredVia ?? 'WORKBUDDY_RESOURCE_CONNECTIONS_FILE'),
            connections,
            conflicts,
            restrictions: registry.restrictions ?? null,
            fileDiagnostics: Array.isArray(registry.fileDiagnostics) ? registry.fileDiagnostics.map(item => diagnosticLabel(item.code)) : [],
        },
        diagnostics: {
            summary: {
                declared: summary.declared ?? 0,
                usable: summary.usable ?? 0,
                flagged: summary.flagged ?? 0,
                observed: summary.observed ?? 0,
                undeclaredObserved: summary.undeclaredObserved ?? 0,
                conflicts: summary.conflicts ?? 0,
            },
            rows,
            // 网关这一项是连接诊断对象列表；页面只需要可读的连接标识，不能把对象直接拼进文案。
            undeclaredObserved: undeclaredIds,
        },
        attribution: {
            status: attribution.status,
            statusLabel: ATTRIBUTION_STATUS_LABELS[attribution.status],
            reason: attribution.reason ?? null,
            fields: Object.entries(ATTRIBUTION_FIELD_LABELS)
                .filter(([key]) => Object.hasOwn(attributionFields, key) || ['requestId', 'taskId', 'sessionId', 'role', 'unit', 'usageLevel'].includes(key))
                .map(([key, label]) => ({ key, label, value: attributionFields[key] ?? null })),
            knownAt: Object.entries(KNOWN_AT_LABELS).map(([key, label]) => ({ key, label, known: knownAt[key] === true })),
            todo: attribution.integrationTodo.map(item => String(item)),
            doesNotProve: Array.isArray(attribution.doesNotProve) ? attribution.doesNotProve.map(item => String(item)) : [],
        },
        limitations: describeLimitations(document.limitations),
    };
}
