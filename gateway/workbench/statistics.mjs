/**
 * Read-only statistics page (L03).
 *
 * What this page does:
 *   - GET /workbench/v1/statistics and GET /workbench/v1/statistics/tasks/:id
 *   - renders the numbers the server actually measured, with "NA" for every
 *     value it could not measure and an explicit list of limitations
 *
 * What this page does not do:
 *   - no model request, no POST/PUT/DELETE, no task state written
 *   - it keeps no local total of its own: every number rendered comes from the
 *     response, so the page can never disagree with the recomputable API
 *   - it renders user-visible text with textContent only (no innerHTML)
 *
 * Mounting: `mountStatistics({ root, fetchJson })` where fetchJson(url) returns
 * the parsed GET body. The shell decides where the panel lives.
 */

const NA = 'NA';
const SCHEMA = 'workbuddy-executor/statistics-1';

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'onclick') el.addEventListener('click', value);
    else if (key === 'value') el.value = value;
    else if (key === 'title') el.title = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** A measured number, or the literal NA. Never 0 for an unmeasured value. */
export function amount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : NA;
}

/** Seconds rendered as an exact duration; null stays NA (no rounding to zero). */
export function seconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NA;
  const total = Math.max(0, Math.round(value));
  const h2 = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h2 > 0 ? `${h2}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s` : `${m}m${String(s).padStart(2, '0')}s`;
}

/** Per unit/currency groups, never added across units. */
export function usageLines(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return [NA];
  return groups.map(group => {
    const unit = group.currency ? `${group.unit} ${group.currency}` : String(group.unit);
    const measured = typeof group.amount === 'number' ? String(group.amount) : NA;
    return `${unit}: ${measured} (记录 ${amount(group.records)}，已测量 ${amount(group.measuredRecords)}，估算 ${amount(group.estimatedRecords)}，不可用 ${amount(group.unavailableRecords)})`;
  });
}

export function attributionLabel(level) {
  return level === 'exact' ? 'exact（任务-请求-重试完整关联）' : level === 'connection_only' ? 'connection_only（只关联到连接）' : 'unavailable（未取得可归属计量）';
}

function coverageLine(coverage) {
  if (!coverage) return NA;
  const ratio = typeof coverage.ratio === 'number' ? `${Math.round(coverage.ratio * 100)}%` : NA;
  return `覆盖 ${ratio}（记录 ${amount(coverage.records)}，已测量 ${amount(coverage.measuredRecords)}，绑定到本轮 ${amount(coverage.attemptBoundRecords)}）`;
}

/** Total calls of one row; an empty list stays NA, not zero. */
export function callsTotal(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  return calls.reduce((sum, call) => sum + (typeof call.count === 'number' ? call.count : 0), 0);
}

function metric(label, value) {
  return h('div', { class: 'metric' }, h('dt', { class: 'metric-label' }, label), h('dd', { class: 'metric-number mono num' }, value));
}

function list(title, items, empty = NA) {
  const rows = Array.isArray(items) && items.length ? items : [empty];
  return h('div', { class: 'section' }, h('h3', {}, title), h('ul', { class: 'technical-list' }, rows.map(text => h('li', { class: 'technical-row mono' }, String(text)))));
}

/** The overview body, rendered as text nodes only. */
export function renderOverview(body) {
  if (!body || body.schemaVersion !== SCHEMA) return h('p', { class: 'notice error' }, '统计响应版本未知；本页不推测数值。');
  const totals = body.totals ?? {};
  const coverage = body.coverage ?? {};
  const claims = body.claims ?? {};
  return h('div', { class: 'sheet' },
    h('header', { class: 'page-heading' }, h('h2', {}, '用量与调用统计'), h('p', { class: 'page-intro' }, `schema ${body.schemaVersion} · 只读快照 · 时间窗 ${body.window?.from ?? '不限'} → ${body.window?.to ?? '不限'}`), h('p', { class: 'page-intro mono' }, `任务 ${amount(coverage.tasksIncluded)}/${amount(coverage.tasksRead)}，事件 ${amount(coverage.eventsRead)}，窗口外 ${amount(coverage.tasksExcludedOutsideWindow)}，不完整 ${amount(coverage.tasksIncomplete)}`)),
    h('dl', { class: 'metrics' },
      metric('有约定任务', amount(totals.acceptance?.tasksWithContract)),
      metric('已验收', amount(totals.acceptance?.accepted)),
      metric('必需检查通过', `${amount(totals.acceptance?.requiredCheckPassed)}/${amount(totals.acceptance?.requiredCheckTotal)}`),
      metric('检查器故障', amount(totals.acceptance?.requiredCheckCheckerError)),
      metric('未知检查', amount(totals.acceptance?.requiredCheckUnknown)),
      metric('返工轮数', amount(totals.rework?.rounds)),
      metric('有返工任务', amount(totals.rework?.tasksWithRework)),
      metric('恢复事件', amount(totals.recovery?.events)),
      metric('人工 episode', amount(totals.interventions?.episodes))),
    h('div', { class: 'section' },
      h('h3', {}, '调用（按通道 × 结果）'),
      totals.calls?.length
        ? h('ul', { class: 'technical-list' }, totals.calls.map(call => h('li', { class: 'technical-row mono' }, `${call.channel}/${call.outcome}: ${amount(call.count)}；stdout ${amount(call.stdoutBytes)} · stderr ${amount(call.stderrBytes)} · combined ${amount(call.combinedBytes)} · wire ${amount(call.wireBytes)}`)))
        : h('p', { class: 'muted' }, '本数据目录没有工具调用记录；这不是 0 次调用，而是未采集。')),
    h('div', { class: 'section' },
      h('h3', {}, '用量（按单位与币种分列，绝不跨单位相加）'),
      h('ul', { class: 'technical-list' }, usageLines(totals.usage).map(line => h('li', { class: 'technical-row mono' }, line))),
      h('p', { class: 'muted mono' }, `归因：exact ${amount(totals.attribution?.exact)} · connection_only ${amount(totals.attribution?.connection_only)} · unavailable ${amount(totals.attribution?.unavailable)}`)),
    h('div', { class: 'section' },
      h('h3', {}, '未测量的结论'),
      h('ul', { class: 'technical-list' },
        h('li', { class: 'technical-row mono' }, `节省：${claims.savings === null ? '未测量（不写 0）' : amount(claims.savings)}`),
        h('li', { class: 'technical-row mono' }, `更优：${claims.superiority === null ? '未测量（样本与对照不足）' : amount(claims.superiority)}`))),
    list('局限', body.limitations),
    h('div', { class: 'section' },
      h('h3', {}, '任务行（可逐条复算）'),
      Array.isArray(body.rows) && body.rows.length
        ? h('table', { class: 'technical-list' },
          h('thead', {}, h('tr', {}, ['任务', '状态', '调用', '返工', '归因', '局限'].map(title => h('th', { class: 'mono' }, title)))),
          h('tbody', {}, body.rows.map(row => h('tr', { class: 'task-row' },
            h('td', { class: 'mono' }, row.taskId),
            h('td', { class: 'mono' }, row.state ?? NA),
            h('td', { class: 'mono num' }, amount(callsTotal(row.calls))),
            h('td', { class: 'mono num' }, amount(row.rework?.rounds)),
            h('td', { class: 'mono' }, row.attribution ?? NA),
            h('td', { class: 'mono' }, Array.isArray(row.limitations) && row.limitations.length ? `见任务详情（${row.limitations.length}）` : NA)))))
        : h('p', { class: 'muted' }, '时间窗内没有任务；空集合不等于零成本。')),
    h('p', { class: 'page-foot muted' }, '本页只读：不触发模型请求，不写任务状态。数值与 /workbench/v1/statistics 完全一致。'));
}

/** The per-task body. */
export function renderTask(body) {
  if (!body || body.schemaVersion !== SCHEMA) return h('p', { class: 'notice error' }, '统计响应版本未知；本页不推测数值。');
  const metrics = body.metrics ?? {};
  const attribution = body.attribution;
  return h('div', { class: 'sheet' },
    h('header', { class: 'page-heading' }, h('h2', { class: 'mono' }, body.taskId), h('p', { class: 'page-intro' }, `${body.state ?? NA} · 事件 ${amount(body.sources?.events)} · 轮次 ${amount(body.sources?.attempts)} · 评审 ${amount(body.sources?.reviews)}${body.sources?.eventsTruncated ? ' · 事件流被截断' : ''}`)),
    h('dl', { class: 'metrics' },
      metric('墙钟秒数', seconds(metrics.timing?.wallElapsedSeconds)),
      metric('排队', seconds(metrics.timing?.queueSeconds)),
      metric('等待输入', seconds(metrics.timing?.inputWaitSeconds)),
      metric('报告→停止', seconds(metrics.timing?.reportToStopSeconds)),
      metric('停止→验收', seconds(metrics.timing?.stopToAcceptanceSeconds)),
      metric('观察滞后', seconds(metrics.timing?.observationLagSeconds)),
      metric('返工轮数', amount(metrics.rework?.rounds)),
      metric('恢复事件', amount(metrics.recovery?.events)),
      metric('人工 episode', amount(metrics.interventions?.episodes)),
      metric('token', amount(metrics.usage?.tokens)),
      metric('额度', amount(metrics.usage?.actualCredits)),
      metric('目录费率标签', metrics.usage?.catalogRateLabel ?? '未取得')),
    h('div', { class: 'section' },
      h('h3', {}, '调用（按通道 × 结果）'),
      metrics.calls?.length
        ? h('ul', { class: 'technical-list' }, metrics.calls.map(call => h('li', { class: 'technical-row mono' }, `${call.channel}/${call.outcome}: ${amount(call.count)}；stdout ${amount(call.stdoutBytes)} · stderr ${amount(call.stderrBytes)} · combined ${amount(call.combinedBytes)} · wire ${amount(call.wireBytes)}`)))
        : h('p', { class: 'muted' }, '该任务没有工具调用记录。')),
    h('div', { class: 'section' },
      h('h3', {}, '用量归因'),
      h('p', { class: 'mono' }, attribution ? attributionLabel(attribution.attribution) : 'unavailable（未读用量账本）'),
      h('p', { class: 'mono muted' }, `覆盖：${coverageLine(attribution?.coverage)}`),
      h('ul', { class: 'technical-list' }, usageLines(attribution?.totals ?? []).map(line => h('li', { class: 'technical-row mono' }, line))),
      h('ul', { class: 'technical-list' }, (attribution?.byRole ?? []).map(role => h('li', { class: 'technical-row mono' }, `${role.role}: ${amount(role.records)} 条 / ${amount(role.distinctRequests)} 个请求 / 重试 ${amount(role.retryRecords)}`)))),
    list('局限', metrics.limitations || body.limitations),
    h('p', { class: 'page-foot muted' }, '本页只读：数值来自已存事件、评审与用量账本，可逐条复算。'));
}

/** Mount the page. fetchJson performs GET only; the caller owns authentication. */
export function mountStatistics({ root, fetchJson }) {
  const state = { body: null, error: null, task: null, taskError: null, from: '', to: '', limit: '50' };
  const out = h('div', { class: 'statistics' });
  root.append(out);

  const input = (label, props) => h('label', { class: 'kv-item' }, h('span', { class: 'metric-label' }, label), h('input', { class: 'mono', ...props }));
  const controls = h('div', { class: 'section' },
    h('div', { class: 'kv' },
      input('起始（UTC ISO）', { value: state.from, placeholder: '2026-01-01T00:00:00.000Z', oninput: event => { state.from = event.target.value; } }),
      input('结束（UTC ISO）', { value: state.to, placeholder: '2026-12-31T00:00:00.000Z', oninput: event => { state.to = event.target.value; } }),
      input('行数上限', { value: state.limit, oninput: event => { state.limit = event.target.value; } })),
    h('button', { class: 'copy', type: 'button', onclick: () => void load() }, '刷新统计'),
    h('p', { class: 'muted' }, '只发 GET 请求；不触发模型调用，不写任务状态。'));

  function query() {
    const params = new URLSearchParams();
    if (state.from.trim()) params.set('from', state.from.trim());
    if (state.to.trim()) params.set('to', state.to.trim());
    if (state.limit.trim()) params.set('limit', state.limit.trim());
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  async function load() {
    state.error = null;
    try {
      state.body = await fetchJson(`/workbench/v1/statistics${query()}`);
    } catch (error) {
      state.body = null;
      state.error = error?.code ? `${error.code}: ${error.message ?? ''}` : '统计读取失败';
    }
    draw();
  }

  async function loadTask(taskId) {
    state.taskError = null;
    try {
      state.task = await fetchJson(`/workbench/v1/statistics/tasks/${encodeURIComponent(taskId)}`);
    } catch (error) {
      state.task = null;
      state.taskError = error?.code ? `${error.code}: ${error.message ?? ''}` : '任务统计读取失败';
    }
    draw();
  }

  function draw() {
    out.replaceChildren(
      controls,
      state.error ? h('p', { class: 'notice error' }, state.error) : state.body ? renderOverview(state.body) : h('p', { class: 'muted' }, '尚未加载。'),
      h('div', { class: 'section' },
        h('h3', {}, '按任务查看'),
        h('form', {
          class: 'kv', onsubmit: event => { event.preventDefault(); const value = event.target.elements.taskId.value.trim(); if (value) void loadTask(value); },
        },
        h('input', { name: 'taskId', class: 'mono', placeholder: '已存任务标识', 'aria-label': '任务标识' }),
        h('button', { class: 'copy', type: 'submit' }, '读取'))),
      state.taskError ? h('p', { class: 'notice error' }, state.taskError) : state.task ? renderTask(state.task) : null);
  }

  draw();
  void load();
  return { reload: load };
}
