import { HttpSource } from './http-source.mjs';
import { DemoSource, SCENARIOS } from './demo-source.mjs';
import { taskIdFromHash } from './task-link.mjs';
import { mountDesktopDispatch } from './dispatch.mjs';
import { STATES, CHECKS, ACTORS, stateInfo, taskName, workspaceName, executorName, currentReview, proofs, filterRecords, formatTime, eventName } from './model.mjs';
const $ = id => document.getElementById(id);
function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false)
            continue;
        if (key.startsWith('on'))
            el.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'class')
            el.className = value;
        else if (key === 'value')
            el.value = value;
        else if (key === 'hidden')
            el.hidden = Boolean(value);
        else
            el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity))
        if (child !== null && child !== undefined && child !== false)
            el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    return el;
}
const paths = {
    grid: ['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'], inbox: ['M4 4h16l2 12v4H2v-4L4 4Z', 'M2 16h6l2 3h4l2-3h6'],
    check: ['m5 12 4 4L19 6'], circle: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'm8 12 3 3 5-6'], search: ['M18 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z', 'm15 15 5 5'],
    refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6 7a7 7 0 0 1 12-2l2 2M4 17l2 2a7 7 0 0 0 12-2'], chevron: ['m9 5 7 7-7 7'], back: ['m14 5-7 7 7 7', 'M7 12h14'],
    folder: ['M3 6h7l2 3h9v11H3V6Z'], file: ['M6 3h8l4 4v14H6V3Z', 'M14 3v5h4M9 12h6M9 16h6'], lock: ['M5 10h14v11H5V10Z', 'M8 10V7a4 4 0 0 1 8 0v3'],
    copy: ['M9 9h11v12H9z', 'M15 9V3H3v12h6'], menu: ['M4 6h16M4 12h16M4 18h16'], mark: ['M9 4H4v12h5M15 8h5v12h-5', 'm8 12 3 3 6-6'],
};
function icon(name, cls = '') { const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); el.setAttribute('viewBox', '0 0 24 24'); el.setAttribute('aria-hidden', 'true'); if (cls)
    el.setAttribute('class', cls); for (const d of paths[name] || paths.file) {
    const p = document.createElementNS(el.namespaceURI, 'path');
    p.setAttribute('d', d);
    el.append(p);
} return el; }
const state = { source: new HttpSource(), records: [], selected: null, detail: null, tab: 'overview', filters: { search: '', state: '', executor: '', workspace: '', group: 'all' }, cursor: null, fetchedAt: null, error: null, detailError: null, events: [], eventError: null, eventCursor: 0, eventsLoaded: false, eventsBusy: false, eventMore: false, busy: false, detailBusy: false, health: null, healthError: false, listSerial: 0, detailSerial: 0 };
let listController, detailController, eventController, toastTimer;
let linkedTask = taskIdFromHash(location.hash);
const status = record => { const info = stateInfo(record); return h('span', { class: 'status ' + info.tone }, h('span', { class: 'dot' }), info.label); };
function toast(text) { clearTimeout(toastTimer); document.querySelector('.toast')?.remove(); const el = h('div', { class: 'toast', role: 'status' }, text); document.body.append(el); toastTimer = setTimeout(() => el.remove(), 2600); }
const copyButton = value => h('button', { class: 'copy', type: 'button', 'aria-label': '复制标识 ' + value, onclick: async () => { try {
        await navigator.clipboard.writeText(String(value));
        toast('标识已复制');
    }
    catch {
        toast('复制未完成，请选中标识手动复制。');
    } } }, icon('copy'));
function option(value, text) { return h('option', { value }, text); }
function backToList() { document.body.classList.remove('mobile-detail'); requestAnimationFrame(() => { window.scrollTo(0, state.listScrollY ?? 0); document.querySelector('.task-row[aria-current=true]')?.focus({ preventScroll: true }); }); }
function navItem(group, label, glyph, count = false) { return h('button', { class: 'nav-button', type: 'button', 'data-group': group, onclick: () => { state.filters.group = group; state.filters.state = ''; $('state-filter').value = ''; document.body.classList.remove('mobile-detail'); closeMenu(); render(); } }, icon(glyph), label, count ? h('span', { class: 'count', id: 'attention-count' }, '0') : null); }
function buildShell() {
    const source = h('select', { class: 'source-select', id: 'data-source', 'aria-label': '数据来源', onchange: e => switchSource(e.target.value) }, option('live', '已保存任务 · 本地网关'), option('demo', '演示数据 · 合成样本'));
    const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': '工作台导航' }, h('div', { class: 'brand' }, icon('mark', 'brand-mark'), h('div', {}, h('div', { class: 'brand-name' }, 'WorkBuddy'), h('div', { class: 'brand-sub' }, 'Executor workbench'))), h('div', { class: 'scope-label' }, icon('folder'), '本地协作工作区'), h('div', {}, h('div', { class: 'nav-heading' }, '工作台'), h('nav', { class: 'nav' }, navItem('all', '全部任务', 'grid'), navItem('attention', '待处理', 'inbox', true), navItem('accepted', '验收记录', 'circle'))), h('div', { class: 'sidebar-foot' }, h('label', { class: 'source-label', for: 'data-source' }, '数据来源', source), h('div', { class: 'foot-line' }, icon('lock'), '只读连接'), h('div', { class: 'foot-line', id: 'runtime-label' }, '正在读取网关版本…')));
    const refresh = h('button', { class: 'button', type: 'button', id: 'refresh', onclick: () => refreshTasks(), 'aria-label': '刷新已存快照' }, icon('refresh'), h('span', {}, '刷新快照'));
    const metricLabels = [['', '已加载任务'], ['running', '执行中'], ['needs_review', '待独立验收'], ['accepted', '已验收']];
    const metrics = h('div', { class: 'metrics', 'aria-label': '已加载任务中的状态数量' }, metricLabels.map(([key, label], i) => h('button', { class: 'metric', type: 'button', 'data-state': key, onclick: () => { state.filters.state = key; $('state-filter').value = key; state.filters.group = 'all'; render(); } }, h('span', { class: 'metric-label' }, label), h('span', { class: 'metric-number', id: 'metric-' + i }, '—'))));
    const search = h('label', { class: 'search' }, h('span', { class: 'sr-only' }, '搜索任务、目标或 ID'), icon('search'), h('input', { id: 'search', type: 'search', autocomplete: 'off', placeholder: '搜索任务、目标或 ID', 'aria-label': '搜索任务、目标或 ID', oninput: e => { state.filters.search = e.target.value; render(); } }), h('kbd', {}, '/'));
    const stateFilter = h('select', { class: 'filter', id: 'state-filter', 'aria-label': '筛选任务状态', onchange: e => { state.filters.state = e.target.value; render(); } }, option('', '全部状态'), ...Object.entries(STATES).map(([key, values]) => option(key, values[0])));
    const workspaceFilter = h('select', { class: 'filter', id: 'workspace-filter', 'aria-label': '筛选工作区', onchange: e => { state.filters.workspace = e.target.value; render(); } }, option('', '全部工作区'));
    const sheet = h('main', { class: 'sheet', id: 'main', tabindex: '-1' }, h('header', { class: 'page-heading' }, h('div', {}, h('h1', { id: 'page-title' }, '任务工作台'), h('p', { class: 'page-intro' }, '执行有记录，交付有依据。')), h('div', { class: 'heading-tools' }, h('span', { class: 'source-badge', id: 'source-badge' }, '已保存任务'), refresh)), h('div', { class: 'demo-controls', id: 'demo-controls', hidden: true }, h('span', {}, '合成样本，不代表真实执行'), h('select', { class: 'filter', id: 'demo-scenario', 'aria-label': '演示场景', onchange: e => switchSource('demo', e.target.value) })), metrics, h('div', { class: 'toolbar' }, search, stateFilter, workspaceFilter, h('span', { class: 'filter-label' }, '筛选已加载的记录')), h('div', { id: 'source-notice', 'aria-live': 'polite' }), h('div', { class: 'workspace' }, h('section', { class: 'list-pane', 'aria-label': '任务列表' }, h('div', { class: 'list-heading' }, h('span', { id: 'list-count' }, '任务'), h('span', {}, '创建时间顺序')), h('div', { class: 'task-list', id: 'task-list' }), h('div', { class: 'list-foot', id: 'list-foot' })), h('section', { class: 'detail', id: 'detail', 'aria-label': '任务详情' })), h('footer', { class: 'page-foot' }, h('span', { id: 'freshness' }, '尚未获取快照'), h('span', {}, '报告收到、停止确认与独立验收，分别记录。')));
    $('app').append(h('div', { class: 'shell' }, sidebar, h('header', { class: 'topbar' }, h('div', { class: 'breadcrumbs' }, h('button', { class: 'menu-button', id: 'menu', type: 'button', 'aria-label': '打开工作台导航', 'aria-controls': 'sidebar', 'aria-expanded': 'false', onclick: toggleMenu }, icon('menu')), h('span', {}, '工作台'), icon('chevron'), h('span', {}, '本地协作')), h('div', { class: 'topbar-meta' }, h('span', { id: 'connection', role: 'status' }, '连接中'), h('span', { class: 'readonly-top' }, icon('lock'), '只读模式'))), sheet), h('button', { class: 'nav-overlay', type: 'button', 'aria-label': '关闭导航', onclick: closeMenu }));
}
function toggleMenu() { const open = document.body.classList.toggle('nav-open'); $('menu').setAttribute('aria-expanded', String(open)); if (open)
    document.querySelector('.nav-button')?.focus(); }
function closeMenu() { const open = document.body.classList.contains('nav-open'); document.body.classList.remove('nav-open'); $('menu').setAttribute('aria-expanded', 'false'); if (open)
    $('menu').focus(); }
function empty(title, description) { return h('div', { class: 'empty' }, icon('inbox'), h('h3', {}, title), h('p', {}, description)); }
function render() {
    const scoped = filterRecords(state.records, { ...state.filters, state: '', group: 'all' }), visible = filterRecords(state.records, state.filters);
    const counts = [scoped.length, scoped.filter(r => stateInfo(r).key === 'running').length, scoped.filter(r => stateInfo(r).key === 'needs_review').length, scoped.filter(r => stateInfo(r).key === 'accepted').length];
    counts.forEach((count, i) => $('metric-' + i).replaceChildren(...[!state.fetchedAt ? '—' : count, ...(i === 0 && state.fetchedAt ? [h('small', {}, '项')] : [])]));
    document.querySelectorAll('.metric').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.state === state.filters.state && state.filters.group === 'all')));
    document.querySelectorAll('.nav-button').forEach(el => { if (el.dataset.group === state.filters.group)
        el.setAttribute('aria-current', 'page');
    else
        el.removeAttribute('aria-current'); });
    $('attention-count').textContent = String(filterRecords(scoped, { group: 'attention' }).length);
    if (!document.querySelector('.sheet.composing')) $('page-title').textContent = ({ all: '任务工作台', attention: '待处理任务', accepted: '验收记录' })[state.filters.group];
    $('refresh').disabled = state.busy;
    $('source-badge').className = 'source-badge' + (state.source.kind === 'demo' ? ' demo' : '');
    $('source-badge').textContent = state.source.kind === 'demo' ? '演示数据' : '已保存任务';
    $('connection').replaceChildren(h('span', { class: 'dot' }), state.error ? state.fetchedAt ? '连接中断' : '无法读取' : state.busy ? '读取中' : state.source.kind === 'demo' ? '演示模式' : '网关可读');
    $('runtime-label').textContent = state.source.kind === 'demo' ? '合成样本 · 不调用执行器' : state.health?.runtime?.packageVersion ? '网关 v' + state.health.runtime.packageVersion : '网关版本未提供';
    $('freshness').textContent = state.fetchedAt ? '上次获取 ' + formatTime(state.fetchedAt) + (state.error ? ' · 旧快照' : ' · 手动刷新') : '尚未获取快照';
    const notice = $('source-notice');
    notice.replaceChildren();
    if (state.error)
        notice.append(h('div', { class: 'notice error', role: 'status' }, state.fetchedAt ? '无法读取新的快照，以下保留上次记录，业务状态未被改变。' : '无法读取任务。请确认运行的是支持 panel-1 的本地网关。', h('div', { class: 'small' }, state.error), h('button', { class: 'text-button', type: 'button', onclick: () => refreshTasks() }, '重试读取')));
    else if (state.healthError)
        notice.append(h('div', { class: 'notice' }, '任务可以读取，网关健康信息暂不可用。原生执行器连接状态未被确认。'));
    $('list-count').textContent = state.fetchedAt ? `${visible.length} 项任务` : '任务记录尚未读取';
    const list = $('task-list');
    list.replaceChildren();
    if (state.busy && !state.fetchedAt)
        for (let i = 0; i < 4; i++)
            list.append(h('div', { class: 'loading-card', 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton short' })));
    else if (!visible.length)
        list.append(empty(state.error ? '读取暂不可用' : state.records.length ? '没有匹配的任务' : '还没有任务记录', state.records.length ? '尝试清空搜索或调整筛选条件。' : '现有任务会在这里显示；此面板只读取记录。'));
    else
        visible.forEach(record => list.append(h('button', { class: 'task-row', type: 'button', 'aria-current': String(record.taskId === state.selected), onclick: () => selectTask(record.taskId), 'aria-label': taskName(record) + '，' + stateInfo(record).label }, h('div', { class: 'task-row-top' }, h('span', { class: 'task-name' }, taskName(record)), icon('chevron', 'row-arrow')), h('div', { class: 'task-meta' }, h('span', {}, workspaceName(record)), h('span', {}, record.view?.attempt?.number ? `第 ${record.view.attempt.number} 轮` : '轮次未提供')), h('div', { class: 'task-bottom' }, status(record), h('span', { class: 'task-source' }, executorName(record))))));
    $('list-foot').replaceChildren(h('span', {}, state.fetchedAt ? '已加载 ' + state.records.length + ' 项' + (state.cursor ? ' · 还有更多' : '') : '尚未读取记录'), state.cursor ? h('button', { class: 'text-button', type: 'button', disabled: state.busy, onclick: () => refreshTasks(true) }, '加载更多') : h('span', {}, '只读记录'));
    renderDetail();
}
function section(title, content, side = null) { return h('section', { class: 'section' }, h('div', { class: 'section-title' }, h('h3', {}, title), side ? h('small', {}, side) : null), content); }
function renderDetail() {
    const el = $('detail');
    const focusedTab = el.contains(document.activeElement) && document.activeElement.getAttribute('role') === 'tab' ? document.activeElement.id : null;
    el.replaceChildren();
    el.setAttribute('aria-busy', String(state.detailBusy));
    if (!state.selected) {
        el.append(empty('选择一项任务', '查看执行、停止与验收的分别记录。'));
        return;
    }
    el.append(h('button', { class: 'back-button', type: 'button', onclick: backToList }, icon('back'), '返回任务列表'));
    if (state.detailBusy && !state.detail) {
        el.append(h('div', { class: 'loading-card', role: 'status' }, '正在读取任务详情…', h('div', { class: 'skeleton' }), h('div', { class: 'skeleton short' })));
        return;
    }
    if (state.detailError)
        el.append(h('div', { class: 'notice error' }, state.detail ? '详情刷新失败，以下为上次详情快照。' : '这项任务的详情暂不可用。', h('div', {}, state.detailError), h('button', { class: 'text-button', type: 'button', onclick: () => selectTask(state.selected, false) }, '重试读取详情')));
    const record = state.detail;
    if (!record)
        return;
    if (!filterRecords(state.records, state.filters).some(r => r.taskId === record.taskId))
        el.append(h('p', { class: 'notice' }, '此任务不在当前筛选结果中，详情保留供对照。'));
    const view = record.view, info = stateInfo(record), number = view.attempt.number ?? '—', limit = view.attempt.limit ?? '—';
    el.append(h('div', { class: 'detail-context' }, icon('folder'), workspaceName(record), ' / ', executorName(record), ` / 第 ${number} 轮`), h('div', { class: 'detail-heading' }, h('h2', { id: 'detail-title', tabindex: '-1' }, taskName(record))), h('div', { class: 'detail-status' }, status(record)), h('p', { class: 'detail-description' }, info.description));
    if (record.presentation.blockingReason) el.append(h('p', { class: 'notice' }, '已存提示：', record.presentation.blockingReason));
    el.append(h('div', { class: 'proofs', 'aria-label': '交付凭证，三个事实分别记录' }, proofs(record).map((proof, i) => h('div', { class: 'proof' }, h('div', { class: 'proof-label' }, icon(['file', 'circle', 'check'][i]), proof.label), h('div', { class: 'proof-value' + (proof.confirmed ? ' confirmed' : '') }, proof.value), h('div', { class: 'proof-detail' }, proof.detail)))));
    const tabs = [['overview', '概况'], ['checks', '检查与审查'], ['files', '文件变化'], ['events', '事件历史']];
    el.append(h('div', { class: 'tabs', role: 'tablist', 'aria-label': '任务详情分区' }, tabs.map(([key, label], i) => h('button', { class: 'tab', role: 'tab', id: 'tab-' + key, 'aria-controls': 'detail-panel', 'aria-selected': String(state.tab === key), tabindex: state.tab === key ? '0' : '-1', type: 'button', onclick: () => activateTab(key), onkeydown: event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (i + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            activateTab(tabs[index][0]);
            $('tab-' + tabs[index][0]).focus();
        } } }, label))));
    const panel = h('div', { role: 'tabpanel', id: 'detail-panel', 'aria-labelledby': 'tab-' + state.tab });
    if (state.tab === 'overview') {
        panel.append(section('任务目标', h('div', {}, h('p', { class: 'objective' }, record.presentation.objective || '原目标正文未提供。'), h('div', { class: 'scope-tokens' }, record.presentation.allowedChanges?.map(path => h('code', { class: 'scope-token' }, path)) || h('span', { class: 'small muted' }, '允许修改范围未提供')))));
        panel.append(section('本轮记录', h('dl', { class: 'kv' }, [['执行轮次', `${number} / ${limit}`], ['原约定模型', record.presentation.model || '未提供'], ['快照写入时间', formatTime(view.timing.lastObservedAt)], ['停止记录时间', formatTime(view.timing.nativeStoppedAt)]].map(([label, value]) => h('div', { class: 'kv-item' }, h('dt', {}, label), h('dd', {}, value))))));
        const report = record.presentation.report;
        panel.append(section('执行报告', report ? h('div', {}, h('details', { class: 'report-disclosure', open: true }, h('summary', {}, '执行器原始回报'), h('pre', { class: 'report' }, report.text)), h('p', { class: 'report-caption' }, report.truncated ? '报告超过显示上限，此处仅保留前 64,000 字符。' : '执行器自报与独立检查分开保存；报告中的“通过”不等于最终验收。')) : h('p', { class: 'small muted' }, '尚未提供执行报告。没有报告不等于执行失败。')));
    }
    else if (state.tab === 'checks')
        renderChecks(panel, record);
    else if (state.tab === 'files')
        renderFiles(panel, record);
    else
        renderEvents(panel);
    el.append(panel, technical(record));
    if (focusedTab) $(focusedTab)?.focus({ preventScroll: true });
}
function activateTab(tab) { state.tab = tab; renderDetail(); if (tab === 'events' && !state.eventsLoaded && !state.eventsBusy)
    loadEvents(); }
function renderChecks(panel, record) {
    const review = currentReview(record);
    if (!review) {
        panel.append(empty('尚无本轮独立审查记录', '保留执行报告的自报来源，不以它代替独立检查。历史已验收状态也不补造 T6 审查。'));
        return;
    }
    const passed = review.checks.filter(c => c.status === 'passed').length;
    panel.append(h('p', { class: 'review-summary' }, `本轮最近一份审查：${passed} / ${review.checks.length} 项通过。`, h('br'), '这是保存的证据快照，未在页面打开时重跑检查。'));
    review.checks.forEach(check => panel.append(h('details', { class: 'check' }, h('summary', {}, h('span', { class: 'check-name' }, icon('chevron'), ({ '$provenance': '执行来源与停止证明', '$scope': '文件范围与原有改动', 'clamp-tests': '原约定测试命令', 'behavior-and-scope': '行为与交付范围' })[check.checkId] || check.checkId), h('span', { class: 'check-actor' }, ACTORS[check.actor] || '未知来源'), h('span', { class: 'check-status ' + (Object.hasOwn(CHECKS, check.status) ? check.status : 'unknown') }, CHECKS[check.status] || '未知')), h('div', { class: 'check-note' }, check.note || '没有检查说明。', h('br'), (ACTORS[check.actor] || '未知来源') + ' · ' + formatTime(check.checkedAt), h('span', { class: 'check-evidence' }, '证据引用：' + (check.evidenceRefs?.join(' · ') || '未提供'))))));
    panel.append(h('details', { class: 'review-history' }, h('summary', {}, `全部审查记录（${record.reviews.length}${record.reviewsTruncated ? '，仅最近 50 份' : ''}）`), record.reviews.slice().reverse().map(r => h('article', { class: 'review-record' }, h('div', { class: 'review-record-title' }, h('span', { class: 'mono' }, r.reviewId), h('span', { class: 'muted' }, formatTime(r.createdAt))), h('p', {}, r.note || '没有补充说明。'), h('p', {}, r.supersedesReviewId ? '更正先前审查：' + r.supersedesReviewId : '独立保存，旧记录保留。'), h('p', { class: 'mono' }, 'basis ' + r.basisRevision + ' → committed ' + r.committedRevision)))));
}
function renderFiles(panel, record) {
    const scope = record.view.workspaceScope;
    if (!scope?.check) {
        panel.append(empty('文件库存未提供', '无法判断文件是否变化；缺失信息不会显示成“没有改动”。'));
        return;
    }
    panel.append(h('p', { class: 'review-summary' }, '已存范围检查：' + (CHECKS[scope.check.status] || '未知') + '。库存包括目录与文件，记录不代表当前文件重新扫描。'));
    if (!scope.check.changes?.length)
        panel.append(h('p', { class: 'small muted' }, '这份库存检查未记录变化。'));
    else
        scope.check.changes.forEach(change => panel.append(h('div', { class: 'file-row' }, icon('file'), h('div', {}, h('div', { class: 'file-name mono' }, change.path), h('div', { class: 'file-category' }, ({ deliverable: '约定交付物', metadata: '许可元数据', unauthorized: '未授权变化，需核查' })[change.category] || '分类未提供')), h('span', { class: 'file-kind' }, ({ added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' })[change.kind] || change.kind))));
    if (scope.changesTruncated)
        panel.append(h('p', { class: 'report-caption' }, '库存变化超过显示上限，以上不是完整清单。'));
}
function renderEvents(panel) {
    if (state.eventError)
        panel.append(h('div', { class: 'notice error' }, '事件读取失败，保留已加载的事件。', h('button', { class: 'text-button', type: 'button', onclick: () => loadEvents() }, '重试读取')));
    if (!state.events.length)
        panel.append(h('p', { class: 'small muted' }, state.eventsBusy ? '正在读取已存事件…' : '尚无可显示的已存事件。'));
    const list = h('ol', { class: 'timeline' });
    state.events.forEach(event => list.append(h('li', { class: 'event' }, h('span', { class: 'event-dot' + (['task_accepted', 'task_closed'].includes(event.type) ? ' positive' : '') }), h('div', {}, h('div', { class: 'event-title' }, eventName(event.type)), h('div', { class: 'event-meta' }, event.attemptId || '轮次未提供'), event.observedAt && event.occurredAt && Date.parse(event.observedAt) - Date.parse(event.occurredAt) > 5000 ? h('div', { class: 'event-meta' }, '稍后观测于 ' + formatTime(event.observedAt)) : null, event.payload && Object.keys(event.payload).length ? h('details', {}, h('summary', {}, '事件记录'), h('pre', {}, JSON.stringify(event.payload, null, 2))) : null), h('time', { class: 'event-time', datetime: event.occurredAt || '' }, formatTime(event.occurredAt)))));
    panel.append(list);
    if (state.eventMore)
        panel.append(h('button', { class: 'text-button', type: 'button', disabled: state.eventsBusy, onclick: () => loadEvents() }, state.eventsBusy ? '正在读取…' : '加载后续事件'));
}
function technical(record) {
    const fields = { taskId: record.taskId, attemptId: record.view.attempt.id, sessionId: record.view.binding.sessionId, revision: record.view.revision, businessState: record.view.businessState, displayState: record.view.displayState, runtimeSource: record.view.binding.runtimeSource, reviewId: currentReview(record)?.reviewId };
    return h('details', { class: 'detail-tech' }, h('summary', {}, '技术标识与原始状态'), h('div', { class: 'technical-list' }, Object.entries(fields).map(([key, value]) => h('div', { class: 'technical-row' }, h('span', { class: 'muted' }, key), h('span', { class: 'mono' }, value ?? '未提供'), value ? copyButton(value) : null))));
}
function updateWorkspaces() {
    const select = $('workspace-filter');
    select.replaceChildren(option('', '全部工作区'), ...[...new Set(state.records.map(workspaceName))].map(name => option(name, name)));
    if ([...select.options].some(o => o.value === state.filters.workspace))
        select.value = state.filters.workspace;
    else {
        state.filters.workspace = '';
        select.value = '';
    }
}
async function refreshTasks(more = false) {
    listController?.abort();
    listController = new AbortController();
    const serial = ++state.listSerial, source = state.source;
    state.busy = true;
    state.error = null;
    render();
    try {
        const [page, health] = await Promise.all([source.list(more ? state.cursor : null, listController.signal), source.health(listController.signal).catch(() => null)]);
        if (serial !== state.listSerial || source !== state.source)
            return;
        state.records = more ? [...new Map([...state.records, ...page.tasks].map(r => [r.taskId, r])).values()] : page.tasks;
        state.cursor = page.nextAfterTaskId;
        state.health = health;
        state.healthError = !health;
        state.fetchedAt = new Date().toISOString();
        updateWorkspaces();
        if (!more) {
            const selected = linkedTask ?? (state.records.some(r => r.taskId === state.selected) ? state.selected : state.records.find(r => r.ok && stateInfo(r).key === 'needs_review')?.taskId ?? state.records[0]?.taskId);
            linkedTask = null;
            if (selected)
                selectTask(selected, false);
            else {
                state.selected = null;
                state.detail = null;
            }
        }
    }
    catch (error) {
        if (serial === state.listSerial && error.name !== 'AbortError')
            state.error = error.message || '连接失败。';
    }
    finally {
        if (serial === state.listSerial) {
            state.busy = false;
            render();
        }
    }
}
async function selectTask(id, mobile = true) {
    detailController?.abort();
    eventController?.abort();
    detailController = new AbortController();
    const serial = ++state.detailSerial, source = state.source;
    if (state.selected !== id)
        state.detail = null;
    state.selected = id;
    state.detailBusy = true;
    state.detailError = null;
    state.events = [];
    state.eventCursor = 0;
    state.eventsLoaded = false;
    state.eventsBusy = false;
    state.eventError = null;
    state.eventMore = false;
    if (mobile) {
        state.listScrollY = window.scrollY;
        document.body.classList.add('mobile-detail');
    }
    render();
    try {
        const record = await source.task(id, detailController.signal);
        if (serial !== state.detailSerial || source !== state.source)
            return;
        state.detail = record;
        if (state.tab === 'events')
            loadEvents();
    }
    catch (error) {
        if (serial === state.detailSerial && error.name !== 'AbortError')
            state.detailError = error.message || '读取失败。';
    }
    finally {
        if (serial === state.detailSerial) {
            state.detailBusy = false;
            renderDetail();
            if (mobile && !matchMedia('(max-width:760px)').matches && document.activeElement === document.body)
                document.querySelector('.task-row[aria-current=true]')?.focus({ preventScroll: true });
            if (mobile && matchMedia('(max-width:760px)').matches)
                $('detail-title')?.focus();
        }
    }
}
async function loadEvents() {
    if (!state.detail || state.eventsBusy)
        return;
    eventController?.abort();
    eventController = new AbortController();
    const id = state.selected, serial = state.detailSerial, source = state.source;
    state.eventsBusy = true;
    state.eventError = null;
    renderDetail();
    try {
        const page = await source.events(id, state.eventCursor, eventController.signal);
        if (serial !== state.detailSerial || source !== state.source)
            return;
        state.events = [...new Map([...state.events, ...page.events].map(e => [e.eventId, e])).values()];
        state.eventCursor = page.nextEventId;
        state.eventMore = page.events.length === 100;
        state.eventsLoaded = true;
    }
    catch (error) {
        if (serial === state.detailSerial && error.name !== 'AbortError')
            state.eventError = error.message;
    }
    finally {
        if (serial === state.detailSerial) {
            state.eventsBusy = false;
            renderDetail();
        }
    }
}
async function switchSource(kind, scenario = 'normal') {
    listController?.abort();
    detailController?.abort();
    eventController?.abort();
    state.listSerial++;
    state.detailSerial++;
    state.records = [];
    state.detail = null;
    state.selected = null;
    state.cursor = null;
    state.fetchedAt = null;
    state.error = null;
    state.detailError = null;
    state.health = null;
    state.healthError = false;
    state.detailBusy = false;
    state.eventsBusy = false;
    state.filters = { search: '', state: '', executor: '', workspace: '', group: 'all' };
    $('search').value = '';
    $('state-filter').value = '';
    state.tab = 'overview';
    document.body.classList.remove('mobile-detail');
    if (kind === 'demo') {
        state.source = new DemoSource(scenario);
        $('demo-scenario').replaceChildren(...SCENARIOS.map(([key, label]) => option(key, label)));
        $('demo-scenario').value = scenario;
    }
    else
        state.source = new HttpSource();
    $('data-source').value = kind;
    window.dispatchEvent(new CustomEvent('workbench-sourcechange', { detail: kind }));
    $('demo-controls').hidden = kind !== 'demo';
    updateWorkspaces();
    await refreshTasks();
}
buildShell();
void mountDesktopDispatch({ onTask: async taskId => { if (state.source.kind === 'demo') await switchSource('live'); linkedTask = taskId; location.hash = 'taskId=' + encodeURIComponent(taskId); await refreshTasks(); } });
window.addEventListener('hashchange', async () => {
    const taskId = taskIdFromHash(location.hash);
    if (!taskId) return;
    linkedTask = taskId;
    if (state.source.kind === 'demo') await switchSource('live');
    else if (!state.busy) { linkedTask = null; await selectTask(taskId, false); }
});
document.addEventListener('keydown', e => { if (e.key === '/' && !e.ctrlKey && !e.metaKey && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) && !document.activeElement.isContentEditable) {
    e.preventDefault();
    $('search').focus();
} if (e.key === 'Escape')
    closeMenu(); });
if (!linkedTask && new URL(location.href).searchParams.get('demo') === '1')
    switchSource('demo');
else
    refreshTasks();
