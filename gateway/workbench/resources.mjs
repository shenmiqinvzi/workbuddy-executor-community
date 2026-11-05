/**
 * 资源页的 DOM 视图。
 *
 * 只读：这里不提供探测上游额度、刷新上游积分、修改账号或模型的入口，
 * 唯一的手动动作是重新读取网关已存的缓存。所有文本都走 textContent，
 * 不使用 innerHTML。
 */
import { NULL_TEXT, ROUTING_CAVEAT, createReadGuard, emptyStateOf, formatStamp, trustLevelTone } from './resources-model.mjs';
import { DemoResourceSource, ResourceSource } from './resources-source.mjs';

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'hidden') node.hidden = Boolean(value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

const missing = () => el('dd', { class: 'resource-missing' }, NULL_TEXT);

function field(list, label, value, options = {}) {
    let detail;
    if (value === null || value === undefined || value === '') detail = missing();
    else if (options.mono) detail = el('dd', { class: 'mono resource-break' }, value);
    else detail = el('dd', {}, value, options.unit ? el('span', { class: 'resource-unit' }, options.unit) : null);
    list.append(el('div', { class: 'resource-field' }, el('dt', {}, label), detail));
}

function tag(text, tone = 'neutral') {
    return el('span', { class: 'resource-tag resource-tag-' + tone }, text);
}

function limitsBlock(limits) {
    if (!limits?.length) return null;
    const list = el('ul', { class: 'resource-limits-list' });
    for (const limit of limits) {
        list.append(el('li', { class: limit.known ? null : 'resource-unknown' }, limit.label, limit.known ? null : el('span', { class: 'mono resource-limit-code' }, limit.code)));
    }
    return el('details', { class: 'resource-limits' }, el('summary', {}, '限制与说明（' + limits.length + '）'), list);
}

function sourceLine(row) {
    return el('p', { class: 'resource-source-line' },
        '来源连接 ',
        el('span', { class: 'mono' }, row.connectionId),
        ' · ',
        row.realmLabel,
        ' · ',
        row.scopeLabel,
        row.connectionIds.length > 1 ? el('span', { class: 'resource-merged' }, '合并 ' + row.connectionIds.length + ' 个连接') : null);
}

function quotaCard(row) {
    const list = el('dl', { class: 'resource-fields' });
    field(list, '剩余 token', row.remainingText, { unit: 'token' });
    field(list, '估算预算', row.budgetText, { unit: 'token' });
    field(list, '估算已用', row.usedText, { unit: 'token' });
    field(list, '重置时间', row.resetText);
    field(list, '来源时间', row.sourceObservedAtText);
    field(list, '采集时间', row.collectedAtText);
    field(list, '共享范围', '网关共享池，多账号共用');
    // quota-1 没有 coverage 字段：这里如实说明，不借用积分侧的覆盖率。
    field(list, '覆盖率', '接口未提供覆盖率');
    field(list, '推算方法', row.methodLabel);
    field(list, '作用域', row.scopeId, { mono: true });
    return el('article', { class: 'resource-card', dataset: { model: row.modelId } },
        el('div', { class: 'resource-card-head' },
            el('div', { class: 'resource-card-title' },
                el('h3', {}, row.modelId),
                sourceLine(row)),
            el('div', { class: 'resource-tags' },
                tag(row.unitLabel),
                tag(row.valueKindLabel, row.valueKind === 'estimated' ? 'warning' : 'neutral'),
                tag(row.availabilityLabel, row.availabilityTone),
                tag(row.freshnessLabel, row.freshnessTone))),
        list,
        el('p', { class: 'resource-route' }, '路由验证：', tag('未核验', 'warning'), ' 本行只说明网关侧看到的上游余额，未确认本任务可用。'),
        limitsBlock(row.limitations));
}

function creditCard(row) {
    const list = el('dl', { class: 'resource-fields' });
    field(list, '余额（积分）', row.balanceText);
    field(list, '覆盖率', row.coverageLabel);
    field(list, '账号数据', row.coverageRatio);
    field(list, '成员最新观测', row.latestMemberObservedAtText);
    field(list, '采集时间', row.collectedAtText);
    field(list, '缓存过期', row.cacheExpiresAtText);
    field(list, '缓存新鲜度', row.cacheFreshnessLabel);
    field(list, '余额新鲜度', row.balanceFreshnessLabel);
    field(list, '共享范围', '网关区域池，余额不归属单个账号');
    field(list, '作用域', row.scopeId, { mono: true });
    return el('article', { class: 'resource-card', dataset: { scope: row.scopeId } },
        el('div', { class: 'resource-card-head' },
            el('div', { class: 'resource-card-title' },
                el('h3', {}, row.scopeLabel + ' · ' + row.realmLabel),
                sourceLine(row)),
            el('div', { class: 'resource-tags' },
                tag(row.unitLabel),
                tag(row.valueKindLabel, 'warning'),
                tag(row.coverageLabel, row.coverageTone),
                tag(row.cacheFreshnessLabel, row.cacheFreshnessTone),
                tag(row.balanceFreshnessLabel, row.balanceFreshnessTone))),
        list,
        el('p', { class: 'resource-route' }, '路由验证：', tag('未核验', 'warning'), ' 余额是区域共享池读数，未确认本任务可用；积分不是货币，也不与 token 相加。'),
        limitsBlock(row.limitations));
}

const EMPTY_TEXT = {
    unconfigured: ['尚未配置资源采集', '网关没有返回任何资源连接。本页不会自动探测账号或额度，也不会为此新建连接。'],
    not_observed: ['连接已配置，但还没有观测到快照', '网关侧尚未成功采集到上游快照。缺少读数不等于零额度。'],
    empty: ['本次快照没有可用记录', '连接有快照，但其中没有可展示的记录。'],
};

function emptyBlock(kind) {
    const [title, description] = EMPTY_TEXT[kind] ?? EMPTY_TEXT.empty;
    return el('div', { class: 'resource-empty' }, el('h3', {}, title), el('p', {}, description));
}

function failureText(code) {
    if (code === 'UNKNOWN_SCHEMA') return ['资源接口结构未受支持', '网关返回的结构与本页支持的两个版本不一致，未渲染任何未知字段；本页不会猜测字段含义。'];
    if (code === 'RESOURCE_TIMEOUT') return ['读取超时', '网关在规定时间内没有返回数据。'];
    if (code === 'RESOURCE_STORE_UNAVAILABLE') return ['网关资源缓存不可读', '这表示缓存暂时无法读取，不表示额度为零。'];
    if (code === 'INVALID_RESOURCE_QUERY') return ['查询被拒绝', '网关拒绝了本次只读查询参数。'];
    if (code === 'NETWORK_ERROR') return ['无法连接本地网关', '工作台与网关之间的只读请求没有建立。'];
    return ['资源读取失败', '网关返回了错误状态。'];
}

function failureCard(label, failure, retained) {
    const [title, description] = failureText(failure.code);
    return el('div', { class: 'resource-failure', role: 'group', 'aria-label': label + '读取失败' },
        el('h3', {}, label + '：' + title),
        el('p', {}, description),
        el('p', { class: 'resource-failure-meta' },
            el('span', { class: 'mono' }, failure.code || 'HTTP_ERROR'),
            failure.httpStatus ? el('span', {}, 'HTTP ' + failure.httpStatus) : null,
            failure.detail ? el('span', { class: 'mono resource-break' }, failure.detail) : null),
        el('p', { class: 'small muted' }, retained?.at
            ? '此分区保留 ' + retained.at + ' 的成功快照，未用演示数据替代。'
            : '此分区本次没有可展示的快照；读取失败不等于零额度，也不会替换成演示数据。'));
}

function tile(label, value, note) {
    return el('div', { class: 'resource-tile' },
        el('span', { class: 'resource-tile-label' }, label),
        el('span', { class: 'resource-tile-value' }, value),
        note ? el('span', { class: 'resource-tile-note' }, note) : null);
}

export function mountResources(host, { now = () => new Date() } = {}) {
    let destroyed = false;
    let visible = false;
    const source = new ResourceSource({ now });
    const demoSource = new DemoResourceSource({ now });
    const guard = createReadGuard();
    // attempted 只表示“完成过一次读取尝试”，不代表成功；
    // 成功时间按分区各自记录，失败的分区不会覆盖自己的成功时间。
    const state = {
        mode: 'live',
        loading: false,
        attempted: false,
        needsReload: true,
        quota: null,
        credit: null,
        quotaError: null,
        creditError: null,
        // 证据分层单独读取、单独失败：它读不到不影响额度与积分两个分区。
        routing: null,
        routingError: null,
        attemptAt: null,
        snapshotDrift: [],
        maxDriftMs: 0,
    };

    const stamp = el('p', { class: 'resource-stamp', id: 'resource-read-stamp' }, '尚无读取尝试');
    const modeBadge = el('span', { class: 'resource-mode', id: 'resource-mode' }, '真实读取');
    const refreshButton = el('button', {
        type: 'button',
        class: 'button resource-refresh',
        id: 'resource-refresh',
        title: '重新读取网关已存的缓存，不会触发上游探测',
        onclick: () => { void refresh(); },
    }, '重新读取缓存');
    const notice = el('div', { class: 'resource-notice', id: 'resource-notice', role: 'status', 'aria-live': 'polite' });
    const summary = el('div', { class: 'resource-tiles', id: 'resource-summary' });
    const body = el('div', { class: 'resource-body', id: 'resource-body' });

    const root = el('div', { class: 'resource-root', id: 'resources-root' },
        el('div', { class: 'resource-bar' },
            el('div', { class: 'resource-bar-main' },
                el('p', { class: 'resource-bar-title' }, '只读资源视图'),
                stamp),
            el('div', { class: 'resource-bar-actions' },
                modeBadge,
                refreshButton)),
        el('p', { class: 'resource-bar-help' }, '手动刷新只重新读取网关缓存（GET 额度、积分、证据分层三个只读接口）；本页不自动轮询、不探测上游额度。'),
        notice,
        summary,
        body,
        el('footer', { class: 'resource-foot' },
            el('p', {}, '接口：',
                el('span', { class: 'mono' }, 'GET /workbench/v1/resources/quotas'),
                ' · ',
                el('span', { class: 'mono' }, 'GET /workbench/v1/resources/credit-balances'),
                ' · ',
                el('span', { class: 'mono' }, 'GET /workbench/v1/resources/routing')),
            el('p', { class: 'small muted' }, '三个接口都只读网关已存的快照。token 与积分分别展示，不合并成一个总余额；null 保持“未提供”，不补零。')));
    root.setAttribute('aria-label', '资源额度与积分');
    root.tabIndex = -1;

    function currentSource() {
        return state.mode === 'demo' ? demoSource : source;
    }

    /** 最近一次读取尝试；它既不是成功时间，也不证明曾经有快照。 */
    function attemptText() {
        return state.attemptAt ? '本次读取尝试 ' + state.attemptAt : '尚无读取尝试';
    }

    /** 单个分区自己的成功时间；只在它成功读到时才存在。 */
    function retainedText(entry) {
        return entry?.at ? '保留了 ' + entry.at + ' 的成功快照' : '没有可展示的快照';
    }

    function notices() {
        const nodes = [];
        if (state.mode === 'demo') {
            nodes.push(el('div', { class: 'resource-demo-banner' },
                el('strong', {}, '演示数据'),
                ' 当前显示的是与真实响应同构的合成样本，不代表任何真实额度。在工作台左侧数据来源中选择“真实网关”可返回实际读取。'));
        }
        if (state.quotaError && state.creditError) {
            const hasSnapshot = Boolean(state.quota || state.credit);
            nodes.push(el('div', { class: 'resource-alert' },
                el('strong', {}, '资源读取失败'),
                ' ' + (state.quotaError.code === state.creditError.code
                    ? (failureText(state.quotaError.code)[0] + '：' + state.quotaError.message)
                    : 'quota 与 credit 两个接口都失败了：' + state.quotaError.message + ' / ' + state.creditError.message),
                ' ' + attemptText() + ' 未取得新数据。',
                hasSnapshot
                    ? el('span', {}, ' token 分区' + retainedText(state.quota) + '；积分分区' + retainedText(state.credit) + '。未用演示数据替代。')
                    : el('span', {}, ' 两个分区都没有可展示的快照；本页不会用演示数据替代，也不会把没有读数当成零。')));
        }
        else if (state.quotaError || state.creditError) {
            const failedQuota = Boolean(state.quotaError);
            const label = failedQuota ? 'token 额度' : '积分';
            const failure = failedQuota ? state.quotaError : state.creditError;
            const retained = failedQuota ? state.quota : state.credit;
            const other = failedQuota ? state.credit : state.quota;
            nodes.push(el('div', { class: 'resource-alert' },
                el('strong', {}, label + '接口读取失败'),
                ' ' + failure.message,
                ' ' + attemptText() + '：该分区' + retainedText(retained) + '；',
                other?.at ? '另一分区已在本次读取中更新（' + other.at + '）。' : '另一分区本次没有可用结果。',
                ' 失败分区没有替换成演示数据。'));
        }
        if (state.snapshotDrift.length) {
            nodes.push(el('div', { class: 'resource-alert' }, '两个接口的采集时间相差 ' + Math.round(state.maxDriftMs / 60000) + ' 分钟（' + state.snapshotDrift.join('、') + '），分区数据可能来自不同采集轮次。'));
        }
        return nodes;
    }

    function tiles() {
        const quota = state.quota?.view ?? null;
        const credit = state.credit?.view ?? null;
        const nodes = [
            tile('数据来源', state.mode === 'demo' ? '演示样本' : '网关只读接口', state.mode === 'demo' ? '合成样本' : '不带探测'),
            tile('连接', (quota ?? credit)?.stats ? String((quota ?? credit).stats.observed) + ' / ' + String((quota ?? credit).stats.connections) : NULL_TEXT, '已观测 / 已配置'),
            tile('token 记录', quota ? String(quota.rows.length) : NULL_TEXT, quota?.truncated ? '已截断' : '模型维度'),
            tile('积分池', credit ? String(credit.rows.length) : NULL_TEXT, credit ? (credit.stats.partial ? '含部分覆盖' : '区域池') : NULL_TEXT),
            tile('证据分层', state.routing ? String(state.routing.view.layers.length) + ' 层' : NULL_TEXT, '声明 ≠ 实际路由'),
        ];
        return nodes;
    }

    function quotaSection() {
        const view = state.quota?.view ?? null;
        const section = el('section', { class: 'resource-section', 'aria-labelledby': 'resource-quota-title' },
            el('div', { class: 'resource-section-head' },
                el('h2', { id: 'resource-quota-title' }, 'Token 额度'),
                el('p', { class: 'resource-section-meta' }, '单位 token · 网关共享池 · 估算值')));
        section.append(el('p', { class: 'resource-caveat' }, ROUTING_CAVEAT + ' 下面每行都是网关侧看到的上游余额推算，不是本任务独占额度，也不能与积分相加。'));
        section.append(el('p', { class: 'resource-section-status', id: 'resource-quota-status' },
            state.quota?.at ? '上次成功读取 ' + state.quota.at : '本次读取没有取得 token 快照'));
        if (state.quotaError) section.append(failureCard('token 额度', state.quotaError, state.quota));
        if (!view) {
            if (!state.quotaError) section.append(emptyBlock('unavailable'));
            return section;
        }
        const emptyState = emptyStateOf(view);
        if (emptyState !== 'ready') section.append(emptyBlock(emptyState));
        else section.append(el('div', { class: 'resource-cards' }, view.rows.map(quotaCard)));
        if (view.truncated) section.append(el('p', { class: 'resource-caption' }, '记录数超过接口上限，以上不是完整清单。'));
        section.append(el('p', { class: 'resource-caption' }, '连接：' + view.connections.map(connection => connection.connectionId + '（' + connection.statusLabel + '）').join('、')));
        return section;
    }

    function creditSection() {
        const view = state.credit?.view ?? null;
        const section = el('section', { class: 'resource-section', 'aria-labelledby': 'resource-credit-title' },
            el('div', { class: 'resource-section-head' },
                el('h2', { id: 'resource-credit-title' }, '积分'),
                el('p', { class: 'resource-section-meta' }, '单位 credit（页面写作“积分”）· 网关区域池 · 上游报告缓存')));
        section.append(el('p', { class: 'resource-caveat' }, '积分不是货币，也不是可花的钱；它与 token 分开结算口径，单独展示，不换算、不相加。' + ROUTING_CAVEAT));
        section.append(el('p', { class: 'resource-section-status', id: 'resource-credit-status' },
            state.credit?.at ? '上次成功读取 ' + state.credit.at : '本次读取没有取得积分快照'));
        if (state.creditError) section.append(failureCard('积分', state.creditError, state.credit));
        if (!view) {
            if (!state.creditError) section.append(emptyBlock('unavailable'));
            return section;
        }
        const emptyState = emptyStateOf(view);
        if (emptyState !== 'ready') section.append(emptyBlock(emptyState));
        else section.append(el('div', { class: 'resource-cards' }, view.rows.map(creditCard)));
        section.append(el('p', { class: 'resource-caption' }, '连接：' + view.connections.map(connection => connection.connectionId + '（' + connection.statusLabel + '）').join('、')));
        return section;
    }

    function layerCard(layer) {
        const node = el('div', { class: 'resource-layer', dataset: { layer: layer.id } },
            el('div', { class: 'resource-layer-head' },
                el('h3', {}, layer.title),
                tag(layer.levelLabel, trustLevelTone(layer.level)),
                el('span', { class: 'resource-layer-flag' }, '未核验')),
            el('p', { class: 'resource-layer-summary' }, layer.summary),
            el('p', { class: 'small muted' }, '来源：', el('span', { class: 'mono' }, layer.source)));
        if (layer.reasonLabel) node.append(el('p', { class: 'small muted' }, layer.reasonLabel));
        return node;
    }

    function connectionRow(connection) {
        const details = [];
        if (connection.pools.length) details.push('池：' + connection.pools.join('、'));
        if (connection.models.length) details.push('模型：' + connection.models.join('、'));
        details.push('区域：' + connection.realmLabel);
        details.push(connection.shared ? '共享池' : '未声明共享');
        const credentials = connection.credentials.map(credential => credential.purpose + ' ← ' + credential.envVar + '（' + credential.presentLabel + '）');
        return el('div', { class: 'resource-kv' },
            el('div', { class: 'resource-kv-key' }, connection.connectionId),
            el('div', { class: 'resource-kv-value' },
                el('span', {}, connection.resourceLabel + ' · ' + connection.declarationLabel),
                el('span', { class: 'small muted' }, details.join(' · ')),
                credentials.length ? el('span', { class: 'small muted' }, '凭据引用：' + credentials.join('；')) : null,
                connection.diagnostics.length ? el('span', { class: 'small muted' }, '声明诊断：' + connection.diagnostics.join('；')) : null));
    }

    function diagnosticRow(row) {
        return el('div', { class: 'resource-kv' },
            el('div', { class: 'resource-kv-key' }, row.connectionId),
            el('div', { class: 'resource-kv-value' },
                el('span', {}, row.declaration === 'declared' ? '声明有效' : row.declaration === 'ambiguous' ? '声明有歧义' : '声明无效'),
                row.codes.length ? el('span', { class: 'small muted' }, row.codes.map(code => code.label).join('；')) : el('span', { class: 'small muted' }, '没有发现矛盾'),
                row.notes.length ? el('span', { class: 'small muted' }, row.notes.join('；')) : null));
    }

    function knownAtRow(item) {
        return tag(item.label + (item.known ? '：已知' : '：未知'), item.known ? 'ok' : 'neutral');
    }

    function trustSection() {
        const view = state.routing?.view ?? null;
        const section = el('section', { class: 'resource-section resource-trust', 'aria-labelledby': 'resource-trust-title' },
            el('div', { class: 'resource-section-head' },
                el('h2', { id: 'resource-trust-title' }, '证据分层'),
                el('p', { class: 'resource-section-meta' }, '配置声明 · 执行选择声明 · 实际请求路由')));
        section.append(el('p', { class: 'resource-caveat' }, '三层证据来自不同来源，页面逐层转写、互不推导：声明对上观测，不表示请求真的走了那条路；代理背后的模型保持未知。'));
        section.append(el('p', { class: 'resource-section-status', id: 'resource-trust-status' },
            state.routing?.at ? '上次成功读取 ' + state.routing.at : '本次读取没有取得证据文档'));
        if (state.routingError) section.append(failureCard('证据分层', state.routingError, state.routing));
        if (!view) {
            if (!state.routingError) section.append(el('div', { class: 'resource-empty' },
                el('h3', {}, '尚无证据文档'),
                el('p', {}, '本次没有读到路由证据；这既不代表没有配置连接，也不代表额度为零。')));
            return section;
        }
        section.append(el('div', { class: 'resource-layers' }, view.layers.map(layerCard)));

        const configuration = view.configuration;
        const configBlock = el('div', { class: 'resource-block' },
            el('h3', {}, '固定连接声明（' + configuration.statusLabel + '）'),
            el('p', { class: 'small muted' }, '声明文件：', el('span', { class: 'mono' }, configuration.declaredVia),
                ' · 登记 ' + String(view.diagnostics.summary.declared) + ' 条 · 可用 ' + String(view.diagnostics.summary.usable) + ' 条 · 需核对 ' + String(view.diagnostics.summary.flagged) + ' 条'));
        if (configuration.fileDiagnostics.length) {
            configBlock.append(el('p', { class: 'resource-alert-inline' }, '声明文件问题：' + configuration.fileDiagnostics.join('；')));
        }
        if (configuration.connections.length === 0) {
            configBlock.append(el('p', { class: 'small muted' }, configuration.status === 'not_declared' ? '未提供固定连接声明文件。' : '声明文件里没有可用连接。'));
        }
        else configBlock.append(el('div', { class: 'resource-kv-list' }, configuration.connections.map(connectionRow)));
        if (configuration.conflicts.length) {
            configBlock.append(el('div', { class: 'resource-alert-inline' },
                el('strong', {}, '声明冲突：'),
                configuration.conflicts.map(conflict => conflict.label + '（' + conflict.connectionIds.join(' / ') + '）').join('；')));
        }
        if (view.diagnostics.rows.length) {
            configBlock.append(el('h3', {}, '声明与观测对比'));
            configBlock.append(el('div', { class: 'resource-kv-list' }, view.diagnostics.rows.map(diagnosticRow)));
        }
        if (view.diagnostics.undeclaredObserved.length) {
            configBlock.append(el('p', { class: 'small muted' }, '已观测到但未声明的连接：' + view.diagnostics.undeclaredObserved.join('、')));
        }
        section.append(configBlock);

        const attribution = view.attribution;
        const attributionBlock = el('div', { class: 'resource-block' },
            el('h3', {}, '请求归因（' + attribution.statusLabel + '）'),
            el('p', { class: 'small muted' }, attribution.reason === 'upstream_payload_lacks_request_identity'
                ? '上游用量载荷只有账号×模型聚合，没有请求编号、任务或会话字段；本页保持 null，不推断、不平均、不摊派。'
                : '上游没有提供可用的请求归因字段。'),
            el('div', { class: 'resource-chips' }, attribution.knownAt.map(knownAtRow)),
            el('div', { class: 'resource-kv-list' }, attribution.fields.map(field => el('div', { class: 'resource-kv' },
                el('div', { class: 'resource-kv-key' }, field.label),
                el('div', { class: 'resource-kv-value' }, el('span', { class: 'resource-missing' }, field.value === null ? NULL_TEXT : String(field.value)))))));
        if (attribution.todo.length) {
            attributionBlock.append(el('h3', {}, '待办（' + String(attribution.todo.length) + ' 条，转 10 真实验收）'));
            attributionBlock.append(el('ol', { class: 'resource-todo' }, attribution.todo.map(item => el('li', {}, item))));
        }
        if (attribution.doesNotProve.length) {
            attributionBlock.append(el('p', { class: 'small muted' }, '不能据此证明：' + attribution.doesNotProve.join('；')));
        }
        section.append(attributionBlock);

        if (view.limitations.length) {
            section.append(el('p', { class: 'resource-caption' }, '限制：' + view.limitations.map(item => item.label).join('；')));
        }
        return section;
    }

    function render() {
        if (destroyed) return;
        stamp.textContent = attemptText();
        modeBadge.textContent = state.mode === 'demo' ? '演示数据' : '真实读取';
        modeBadge.className = 'resource-mode' + (state.mode === 'demo' ? ' resource-mode-demo' : '');
        refreshButton.disabled = state.loading;
        refreshButton.textContent = state.loading ? '正在读取…' : '重新读取缓存';
        notice.replaceChildren(...notices());
        if (!state.attempted) {
            summary.replaceChildren();
            body.replaceChildren(el('div', { class: 'resource-skeleton', 'aria-hidden': 'true' },
                el('div', { class: 'resource-skeleton-line' }),
                el('div', { class: 'resource-skeleton-line short' }),
                el('div', { class: 'resource-skeleton-line' }),
                el('div', { class: 'resource-skeleton-line short' })));
            body.append(el('p', { class: 'small muted' }, state.loading ? '正在读取网关已存的资源快照…' : '尚未读取。点“重新读取缓存”读取一次。'));
        }
        else {
            summary.replaceChildren(...tiles());
            body.replaceChildren(quotaSection(), creditSection(), trustSection());
        }
        body.setAttribute('aria-busy', state.loading ? 'true' : 'false');
    }

    // 只有该分区本次真的读到数据，才更新它自己的成功时间；失败只记录错误。
    function applyQuota(side, readAt) {
        if (side.status === 'ok') {
            state.quota = { view: side.view, at: readAt ?? null };
            state.quotaError = null;
        }
        else state.quotaError = side;
    }

    function applyCredit(side, readAt) {
        if (side.status === 'ok') {
            state.credit = { view: side.view, at: readAt ?? null };
            state.creditError = null;
        }
        else state.creditError = side;
    }

    // 证据文档独立记账：它失败不擦掉额度/积分，也不把自己的失败算到那两分区头上。
    function applyRouting(side, readAt) {
        if (side.status === 'ok') {
            state.routing = { view: side.view, at: readAt ?? null };
            state.routingError = null;
        }
        else if (side.status === 'aborted') return;
        else state.routingError = side;
    }

    async function refresh() {
        if (destroyed) return;
        const ticket = guard.begin();
        state.loading = true;
        state.needsReload = false;
        render();
        try {
            let result;
            // 证据分层与额度/积分并行读取，但彼此隔离：任一侧失败只影响自己的分区。
            const routingRead = (async () => {
                try {
                    return { status: 'ok', ...(await currentSource().readRouting(ticket.signal)) };
                }
                catch (error) {
                    if (error?.name === 'AbortError') return { status: 'aborted' };
                    return {
                        status: 'error',
                        code: error?.code ?? 'NETWORK_ERROR',
                        message: error?.message ?? '无法连接本地网关。',
                        httpStatus: error?.httpStatus ?? null,
                        detail: error?.detail ?? null,
                    };
                }
            })();
            try {
                result = await currentSource().readAll({ signal: ticket.signal });
            }
            catch (error) {
                await routingRead;
                // 取消是离页、切换来源或销毁视图的结果，不写回任何界面状态。
                if (error?.name === 'AbortError' || !ticket.isCurrent() || destroyed) return;
                const attemptAt = formatStamp(now().toISOString());
                const failure = { code: 'NETWORK_ERROR', message: String(error?.message ?? error), httpStatus: null, detail: null };
                state.attemptAt = attemptAt;
                state.quotaError = state.quotaError ?? failure;
                state.creditError = state.creditError ?? failure;
                state.attempted = true;
                return;
            }
            const routingSide = await routingRead;
            // 迟到结果一律丢弃：票据失效或视图已销毁时不碰界面，也不更新时间。
            if (!ticket.isCurrent() || destroyed) return;
            const attemptAt = formatStamp(result.readAt);
            state.attemptAt = attemptAt;
            applyQuota(result.quota, attemptAt);
            applyCredit(result.credit, attemptAt);
            applyRouting(routingSide, attemptAt);
            state.snapshotDrift = (result.consistency?.drifted ?? []).map(item => item.connectionId);
            state.maxDriftMs = result.consistency?.maxDriftMs ?? 0;
            state.attempted = true;
            // 失败已经写在页面上：不自动重试，也不切换到演示数据。
        }
        finally {
            // 只有这张票据仍然有效时才收尾，避免取消后把隐藏页改回“正在读取”。
            if (ticket.isCurrent() && !destroyed) {
                state.loading = false;
                ticket.finish();
                render();
            }
        }
    }

    function setMode(kind) {
        const next = kind === 'demo' ? 'demo' : 'live';
        if (next === state.mode) return;
        state.mode = next;
        guard.cancel();
        state.loading = false;
        state.attempted = false;
        state.quota = null;
        state.credit = null;
        state.quotaError = null;
        state.creditError = null;
        state.routing = null;
        state.routingError = null;
        state.snapshotDrift = [];
        state.maxDriftMs = 0;
        state.attemptAt = null;
        state.needsReload = true;
        render();
        if (visible) void refresh();
    }

    function setVisible(next) {
        const nextVisible = Boolean(next);
        if (nextVisible === visible) return;
        visible = nextVisible;
        if (!visible) {
            // 离页：票据立即失效并取消在途请求，复位“正在读取”；返回页面时重新读取。
            const interrupted = state.loading;
            guard.cancel();
            state.loading = false;
            if (interrupted) state.needsReload = true;
            render();
            return;
        }
        if (state.needsReload && !state.loading) void refresh();
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        visible = false;
        state.loading = false;
        guard.cancel();
        host.replaceChildren();
    }

    host.replaceChildren(root);
    render();
    return { element: root, refresh, setMode, setVisible, destroy, get state() { return state; } };
}
