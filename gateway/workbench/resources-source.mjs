/**
 * 资源页的读取层：只调用两个已冻结的只读 GET，带超时、取消和结构校验。
 *
 * 真实读取失败时只把失败交给页面，绝不换成演示数据；演示数据只有用户在工作台
 * 数据来源里主动选择“演示数据”后才会出现，并且整页会明确标注。
 */
import { ResourceSchemaError, buildCreditView, buildQuotaView, buildTrustView, compareSnapshots, parseCreditDocument, parseQuotaDocument, parseRoutingDocument } from './resources-model.mjs';

// 相对段用于拼接 baseUrl；完整端点导出给页面文案与交付记录使用。
export const RESOURCE_PATHS = {
    quotas: '/quotas',
    creditBalances: '/credit-balances',
    routing: '/routing',
};

export const RESOURCE_ENDPOINTS = {
    quotas: '/workbench/v1/resources/quotas',
    creditBalances: '/workbench/v1/resources/credit-balances',
    routing: '/workbench/v1/resources/routing',
};

const DEFAULT_TIMEOUT_MS = 8000;

export class ResourceReadError extends Error {
    constructor(code, message, { httpStatus = null, detail = null } = {}) {
        super(message);
        this.name = 'ResourceReadError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.detail = detail;
    }
}

const ERROR_TEXT = {
    INVALID_RESOURCE_QUERY: '网关拒绝了资源查询参数。',
    RESOURCE_STORE_UNAVAILABLE: '网关的资源缓存暂不可读；这不表示额度为零。',
    RESOURCE_TIMEOUT: '网关在规定时间内没有返回资源数据。',
    INVALID_RESPONSE: '资源接口返回了无法解析的数据。',
    UNKNOWN_SCHEMA: '资源接口返回的结构超出本页支持的版本。',
    NETWORK_ERROR: '无法连接本地网关。',
    HTTP_STATUS: '资源接口返回了错误状态。',
};

function abortError() {
    return new DOMException('已取消读取', 'AbortError');
}

export class ResourceSource {
    kind = 'live';

    constructor({ baseUrl = '/workbench/v1/resources', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = (url, init) => globalThis.fetch(url, init), now = () => new Date() } = {}) {
        this.baseUrl = baseUrl;
        this.timeoutMs = timeoutMs;
        this.fetchImpl = fetchImpl;
        this.now = now;
    }

    async request(path, signal) {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        let response;
        try {
            response = await this.fetchImpl(this.baseUrl + path, {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { accept: 'application/json' },
                signal: combined,
            });
        }
        catch (error) {
            // 外部取消是调用方的决定，原样抛出让调用方忽略它。
            if (signal?.aborted) throw abortError();
            if (error?.name === 'TimeoutError') throw new ResourceReadError('RESOURCE_TIMEOUT', ERROR_TEXT.RESOURCE_TIMEOUT, { detail: error.message });
            throw new ResourceReadError('NETWORK_ERROR', ERROR_TEXT.NETWORK_ERROR, { detail: error?.message ?? String(error) });
        }
        let body = null;
        let readable = false;
        try {
            body = await response.json();
            readable = true;
        }
        catch { readable = false; }
        if (!response.ok) {
            const code = readable ? body?.error?.code ?? 'HTTP_STATUS' : 'HTTP_STATUS';
            throw new ResourceReadError(code, ERROR_TEXT[code] ?? '资源接口返回了 HTTP ' + response.status + '。', {
                httpStatus: response.status,
                detail: readable ? body?.error?.message ?? null : null,
            });
        }
        if (!readable) throw new ResourceReadError('INVALID_RESPONSE', ERROR_TEXT.INVALID_RESPONSE, { httpStatus: response.status });
        return body;
    }

    async readQuota(signal) {
        const raw = await this.request(RESOURCE_PATHS.quotas, signal);
        let document;
        try {
            document = parseQuotaDocument(raw);
        }
        catch (error) {
            if (error instanceof ResourceSchemaError) throw new ResourceReadError('UNKNOWN_SCHEMA', ERROR_TEXT.UNKNOWN_SCHEMA, { detail: error.message });
            throw error;
        }
        return { document, view: buildQuotaView(document) };
    }

    async readCredit(signal) {
        const raw = await this.request(RESOURCE_PATHS.creditBalances, signal);
        let document;
        try {
            document = parseCreditDocument(raw);
        }
        catch (error) {
            if (error instanceof ResourceSchemaError) throw new ResourceReadError('UNKNOWN_SCHEMA', ERROR_TEXT.UNKNOWN_SCHEMA, { detail: error.message });
            throw error;
        }
        return { document, view: buildCreditView(document) };
    }

    /**
     * 路由证据单独读取：它与额度/积分分区互不牵连 —— 证据读不到时，
     * 额度与积分照常显示，只在证据分区给出失败卡片。
     */
    async readRouting(signal) {
        const raw = await this.request(RESOURCE_PATHS.routing, signal);
        let document;
        try {
            document = parseRoutingDocument(raw);
        }
        catch (error) {
            if (error instanceof ResourceSchemaError) throw new ResourceReadError('UNKNOWN_SCHEMA', ERROR_TEXT.UNKNOWN_SCHEMA, { detail: error.message });
            throw error;
        }
        return { document, view: buildTrustView(document) };
    }

    /**
     * 两个分区并行读取。一侧失败不阻止另一侧显示；结果里明确记录哪一侧失败。
     * 返回值永不包含合成数据。
     */
    async readAll({ signal } = {}) {
        const readAt = this.now().toISOString();
        const settle = async read => {
            try {
                return { status: 'ok', ...(await read(signal)) };
            }
            catch (error) {
                if (error?.name === 'AbortError') throw error;
                return {
                    status: 'error',
                    code: error?.code ?? 'NETWORK_ERROR',
                    message: error?.message ?? ERROR_TEXT.NETWORK_ERROR,
                    httpStatus: error?.httpStatus ?? null,
                    detail: error?.detail ?? null,
                };
            }
        };
        const [quota, credit] = await Promise.all([settle(signal_ => this.readQuota(signal_)), settle(signal_ => this.readCredit(signal_))]);
        const consistency = compareSnapshots(quota.status === 'ok' ? quota.document : null, credit.status === 'ok' ? credit.document : null);
        return {
            ok: quota.status === 'ok' && credit.status === 'ok',
            partial: (quota.status === 'ok') !== (credit.status === 'ok'),
            readAt,
            kind: this.kind,
            demo: false,
            quota,
            credit,
            consistency,
        };
    }
}

const POOL_CN = 'pool-11111111111111111111111111111111';
const POOL_INTL = 'pool-22222222222222222222222222222222';

/**
 * 与真实响应同构的合成样本：用于演示与浏览器检查。
 * 它是“读出来”的同一批结构与常量，不是真实额度；页面必须整页标注演示。
 */
export function demoDocuments(now = () => new Date()) {
    const at = minutes => new Date(now().getTime() + minutes * 60000).toISOString();
    const quotaConnections = [
        {
            connectionId: 'demo-conn-cn',
            status: 'observed',
            errorCode: null,
            snapshotId: 'demo-snapshot-cn',
            collectedAt: at(-2),
            sourceObservedAt: at(-6),
            expiresAt: at(+28),
            freshness: 'fresh',
        },
        {
            connectionId: 'demo-conn-intl',
            status: 'unavailable',
            errorCode: 'UPSTREAM_TIMEOUT',
            snapshotId: 'demo-snapshot-intl',
            collectedAt: at(-240),
            sourceObservedAt: at(-241),
            expiresAt: at(-150),
            freshness: 'stale',
        },
    ];
    const observations = [
        {
            scopeId: POOL_CN,
            scopeKind: 'gateway_pool',
            shared: true,
            modelId: 'sample-model-alpha',
            realm: 'cn',
            unit: 'tokens',
            valueKind: 'estimated',
            availability: 'available',
            used: 1200000,
            budget: 5000000,
            remaining: 3800000,
            resetAt: at(360),
            method: 'historical_budget_minus_observed_usage',
            limitations: ['routing_unverified', 'shared_pool', 'budget_estimated', 'gateway_observed_usage_only', 'task_attribution_unavailable'],
            connectionId: 'demo-conn-cn',
            snapshotId: 'demo-snapshot-cn',
            sourceObservedAt: at(-6),
            collectedAt: at(-2),
            connectionIds: ['demo-conn-cn'],
        },
        {
            scopeId: POOL_INTL,
            scopeKind: 'gateway_pool',
            shared: true,
            modelId: 'sample-model-beta',
            realm: 'intl',
            unit: 'tokens',
            valueKind: 'unavailable',
            availability: 'unknown',
            used: null,
            budget: null,
            remaining: null,
            resetAt: null,
            method: 'source_cooling_and_historical_budget',
            limitations: ['routing_unverified', 'shared_pool', 'budget_estimated', 'gateway_observed_usage_only', 'task_attribution_unavailable'],
            connectionId: 'demo-conn-intl',
            snapshotId: 'demo-snapshot-intl',
            sourceObservedAt: at(-241),
            collectedAt: at(-240),
            connectionIds: ['demo-conn-intl'],
        },
    ];
    const creditConnections = [
        { connectionId: 'demo-conn-cn', status: 'observed', errorCode: null, snapshotId: 'demo-credit-cn', collectedAt: at(-2), cacheFreshness: 'fresh' },
        { connectionId: 'demo-conn-intl', status: 'observed', errorCode: null, snapshotId: 'demo-credit-intl', collectedAt: at(-240), cacheFreshness: 'stale' },
    ];
    const balances = [
        {
            snapshotId: 'demo-credit-cn',
            connectionId: 'demo-conn-cn',
            scopeId: POOL_CN,
            realm: 'cn',
            unit: 'credit',
            valueKind: 'reported_cache',
            balance: 1234.5,
            accountsEnabled: 3,
            accountsWithData: 3,
            coverage: 'complete',
            latestMemberObservedAt: at(-5),
            collectedAt: at(-2),
            cacheExpiresAt: at(+28),
            errorCode: null,
            connectionIds: ['demo-conn-cn'],
            shared: true,
            scopeKind: 'gateway_region_pool',
            balanceFreshness: 'unavailable',
            limitations: ['shared_region_pool', 'routing_unverified', 'latest_member_timestamp_only', 'member_freshness_unavailable', 'task_attribution_unavailable'],
        },
        {
            snapshotId: 'demo-credit-intl',
            connectionId: 'demo-conn-intl',
            scopeId: POOL_INTL,
            realm: 'intl',
            unit: 'credit',
            valueKind: 'reported_cache',
            balance: 80,
            accountsEnabled: 2,
            accountsWithData: 1,
            coverage: 'partial',
            latestMemberObservedAt: at(-238),
            collectedAt: at(-240),
            cacheExpiresAt: at(-150),
            errorCode: null,
            connectionIds: ['demo-conn-intl'],
            shared: true,
            scopeKind: 'gateway_region_pool',
            balanceFreshness: 'stale',
            limitations: ['shared_region_pool', 'routing_unverified', 'latest_member_timestamp_only', 'member_freshness_unavailable', 'task_attribution_unavailable'],
        },
    ];
    return {
        quota: {
            schemaVersion: 'workbuddy-executor/quota-1',
            readOnly: true,
            connections: quotaConnections,
            observations,
            truncated: false,
            attribution: 'connection_only',
            actualTaskCredits: null,
            actualTaskTokens: null,
        },
        credit: {
            schemaVersion: 'workbuddy-executor/credit-balance-1',
            readOnly: true,
            connections: creditConnections,
            balances,
            actualTaskCredits: null,
            attribution: 'connection_only',
        },
    };
}

/**
 * 与真实响应同构的路由证据样本：三层证据都在，且都没有被标成“已验证”。
 * 它演示的是“声明与观测对上了、实际请求仍然未知”这件事实，不是真实调用记录。
 */
export function demoRouting(now = () => new Date()) {
    const at = minutes => new Date(now().getTime() + minutes * 60000).toISOString();
    return {
        schemaVersion: 'workbuddy-executor/routing-evidence-1',
        readOnly: true,
        snapshotOnly: true,
        generatedAt: at(0),
        routingVerified: false,
        basis: 'gateway_observation_only',
        connections: [
            { resource: 'quota', connectionId: 'demo-conn-cn', status: 'observed', errorCode: null, level: 'observed', reason: 'snapshot_fresh', snapshotId: 'demo-snapshot-cn', sourceObservedAt: at(-6), collectedAt: at(-2), expiresAt: at(+28) },
            { resource: 'quota', connectionId: 'demo-conn-intl', status: 'unavailable', errorCode: 'UPSTREAM_TIMEOUT', level: 'unavailable', reason: 'source_error', snapshotId: 'demo-snapshot-intl', sourceObservedAt: at(-241), collectedAt: at(-240), expiresAt: at(-150) },
            { resource: 'credit', connectionId: 'demo-conn-cn', status: 'observed', errorCode: null, level: 'observed', reason: 'snapshot_fresh', snapshotId: 'demo-credit-cn', sourceObservedAt: at(-5), collectedAt: at(-2), expiresAt: at(+28) },
        ],
        mappings: [
            { scopeId: POOL_CN, scopeKind: 'gateway_pool', realm: 'cn', modelId: 'sample-model-alpha', unit: 'tokens', level: 'observed', evidenceReason: 'snapshot_fresh', primaryConnectionId: 'demo-conn-cn', connectionIds: ['demo-conn-cn'], sources: [{ resource: 'quota', connectionId: 'demo-conn-cn', level: 'observed', reason: 'snapshot_fresh' }], availability: 'available', memberFreshness: 'fresh' },
            { scopeId: POOL_CN, scopeKind: 'gateway_region_pool', realm: 'cn', modelId: 'sample-model-alpha', unit: 'credit', level: 'observed', evidenceReason: 'snapshot_fresh', primaryConnectionId: 'demo-conn-cn', connectionIds: ['demo-conn-cn'], sources: [{ resource: 'credit', connectionId: 'demo-conn-cn', level: 'observed', reason: 'snapshot_fresh' }], coverage: 'complete', memberFreshness: 'unavailable' },
        ],
        unresolved: [
            '上游载荷只有账号×模型聚合，没有请求编号，无法把用量归因到任务',
            '会话与提供方的对应关系不可见',
            'API Key 的作用域无法从载荷推断',
            '是否存在独占预留无法证实',
        ],
        invalidatesOn: ['connection_fingerprint_change', 'snapshot_expiry', 'source_error', 'configuration_change'],
        limitations: ['routing_unverified', 'shared_region_pool', 'task_attribution_unavailable', 'model_scope_unverified'],
        layers: {
            configuration: { code: 'connection_pool_model', source: 'WORKBUDDY_RESOURCE_CONNECTIONS_FILE', status: 'declared', verified: false, level: 'gateway_observation_only' },
            executionSelection: { code: 'execution_selection_declaration', source: 'WORKBUDDY_RESOURCE_LINKS_FILE', status: 'linked', verified: false, level: 'declaration_only' },
            requestRouting: { code: 'actual_request_routing', source: 'upstream_usage_payload', verified: false, level: 'unavailable', reason: 'upstream_payload_lacks_request_identity' },
        },
        connectionRegistry: {
            schemaVersion: 'workbuddy-executor/resource-connections-1',
            status: 'declared',
            source: 'file',
            declaredVia: 'WORKBUDDY_RESOURCE_CONNECTIONS_FILE',
            connections: [
                { connectionId: 'demo-conn-cn', resource: 'quota', sourceUrl: 'http://127.0.0.1:8788', realm: 'cn', pools: [POOL_CN], models: ['sample-model-alpha'], shared: true, declaredAt: at(-1440), hasNote: true, status: 'declared', credentials: [{ purpose: 'api_key', envVar: 'WORKBUDDY_QUOTA_API_KEY', present: true }, { purpose: 'panel_token', envVar: 'WORKBUDDY_QUOTA_PANEL_TOKEN', present: true }], diagnostics: [] },
                { connectionId: 'demo-conn-intl', resource: 'quota', sourceUrl: 'http://127.0.0.1:8788', realm: 'intl', pools: [POOL_INTL], models: ['sample-model-beta'], shared: true, declaredAt: at(-1440), hasNote: false, status: 'declared', credentials: [{ purpose: 'api_key', envVar: 'WORKBUDDY_QUOTA_API_KEY', present: true }], diagnostics: [] },
            ],
            conflicts: [],
            fileDiagnostics: [],
            restrictions: { loopbackOriginOnly: true, fixedReadPathsOnly: true, arbitraryUrlProxy: false, browserManagerKey: false, credentialValuesExposed: false, credentialSource: 'environment_reference_only' },
            limitations: ['declaration_only', 'no_key_verification', 'no_upstream_probe', 'declaration_does_not_verify_routing'],
        },
        connectionDiagnostics: {
            readOnly: true,
            declarationStatus: 'declared',
            attribution: 'connection_only',
            connections: [
                { connectionId: 'demo-conn-cn', resource: 'quota', declaration: 'declared', observation: { status: 'observed', errorCode: null, snapshotId: 'demo-snapshot-cn', pools: [POOL_CN], models: ['sample-model-alpha'] }, codes: ['declared_and_observed'], notes: [] },
                { connectionId: 'demo-conn-intl', resource: 'quota', declaration: 'declared', observation: { status: 'unavailable', errorCode: 'UPSTREAM_TIMEOUT', snapshotId: 'demo-snapshot-intl', pools: [POOL_INTL], models: ['sample-model-beta'] }, codes: ['observed_source_error:UPSTREAM_TIMEOUT'], notes: [] },
            ],
            undeclaredObserved: [],
            summary: { declared: 2, usable: 2, flagged: 0, observed: 2, undeclaredObserved: 0, conflicts: 0 },
            limitations: ['declaration_only', 'diagnostics_do_not_probe_upstream'],
        },
        requestAttribution: {
            schemaVersion: 'workbuddy-executor/request-attribution-1',
            status: 'unavailable',
            reason: 'upstream_payload_lacks_request_identity',
            tokenFields: ['account', 'model', 'used', 'budget', 'reset_at', 'generated_at'],
            creditFields: ['account', 'realm', 'balance', 'accounts_enabled', 'accounts_with_data', 'observed_at'],
            fields: { requestId: null, taskId: null, sessionId: null, role: null, unit: null, usageLevel: null, value: null },
            optionalLinks: { taskToModel: null, sessionToProvider: null, requestToAccount: null },
            knownAt: { connection: true, pool: true, modelAggregate: true, task: false, session: false, request: false },
            doesNotProve: [
                '不能证明某次任务请求使用了某个池或模型',
                '不能证明额度由本任务独占',
                '不能证明代理背后的真实模型',
                '不能把账号×模型聚合摊派到单个请求',
            ],
            integrationTodo: [
                '上游载荷补充 request id 并落盘',
                '补齐 taskId / sessionId 关联字段',
                '记录实际提供方与真实模型标识',
                '为每条用量声明单位（token / credit）',
                '为每条用量声明层级（request / task / session / pool）',
                '保留上游侧观察时间与采集时间两个字段',
                '提供只读游标分页，避免整包聚合',
                '在代理响应中保留 attribution 标记',
                '面板令牌轮换状态可观测',
                '取得真机授权后在窗口内复跑一次',
            ],
            limitations: ['request_attribution_unavailable', 'task_to_model_unverified', 'unit_mixing_forbidden', 'no_estimate_substituted'],
        },
    };
}

export class DemoResourceSource {
    kind = 'demo';

    constructor({ now = () => new Date() } = {}) {
        this.now = now;
    }

    async readAll({ signal } = {}) {
        if (signal?.aborted) throw abortError();
        const documents = demoDocuments(this.now);
        const quota = parseQuotaDocument(documents.quota);
        const credit = parseCreditDocument(documents.credit);
        return {
            ok: true,
            partial: false,
            readAt: new Date(this.now()).toISOString(),
            kind: 'demo',
            demo: true,
            quota: { status: 'ok', document: quota, view: buildQuotaView(quota) },
            credit: { status: 'ok', document: credit, view: buildCreditView(credit) },
            consistency: compareSnapshots(quota, credit),
        };
    }

    async readRouting(signal) {
        if (signal?.aborted) throw abortError();
        const document = parseRoutingDocument(demoRouting(this.now));
        return { document, view: buildTrustView(document) };
    }
}
