export const STATES = {
    queued: ['等待领取', 'neutral', '任务已进入队列，等待执行器领取。'],
    running: ['正在执行', 'active', '查看最新记录；需要处理原生权限时，请前往执行器。'],
    waiting_input: ['等待你处理', 'warning', '请在原生执行器中核对输入或权限请求。面板不会代为批准。'],
    waiting_stop: ['等待停止确认', 'warning', '报告、取消或到期已被记录，仍需原生停止证明。请勿重复派工。'],
    needs_review: ['等待独立验收', 'active', '执行报告与原生停止已记录，交付仍等待独立检查。'],
    accepted: ['已验收', 'positive', '这是后端保存的验收快照，不代表重新检查了当前工作区。'],
    cancelled: ['已取消', 'neutral', '保留原任务与关闭记录；取消不是暂停。'],
    failed: ['任务未完成', 'negative', '请核对执行报告和事件。未完成不一定是模型内容错误。'],
    expired: ['已超过期限', 'warning', '原期限保持不变；迟到报告不能变成按期完成。'],
    unknown: ['状态待核查', 'neutral', '证据不足，保留原始状态，不推断已停止或已成功。'],
};
export const CHECKS = { passed: '通过', failed: '未通过', unknown: '未知', not_applicable: '不适用', checker_error: '检查器错误' };
export const ACTORS = { program: '程序检查', independent_reviewer: '独立审查', worker: '执行器自报' };
export function stateInfo(record) {
    if (!record?.ok)
        return { key: 'unknown', label: '记录读取失败', tone: 'negative', description: '该任务的记录无法读取，其他任务仍可查看。' };
    const view = record.view;
    if (view.displayState === 'needs_review' && view.remoteStopped !== true)
        return { key: 'inconsistent', label: '数据需核查', tone: 'warning', description: '待验收状态缺少对应停止证明，不能据此认定交付已就绪。' };
    const key = Object.hasOwn(STATES, view.displayState) ? view.displayState : 'unknown';
    let [label, tone, description] = STATES[key];
    // A report can arrive before the native run stops. That is progress, not a
    // result: the row says so, and the accept/rework entries stay closed until
    // the stop is confirmed.
    if (['queued', 'running', 'waiting_input'].includes(key) && record.presentation?.report) {
        label = key === 'queued' ? '报告已到，仍在排队' : '报告已到，尚未确认停止';
        description = `${description} 报告已记录，但原生停止未确认，验收与返工入口保持关闭。`;
    }
    return { key, label, tone, description };
}
export function taskName(record) { return record.presentation?.title || '未命名任务'; }
export function workspaceName(record) { return record.view?.workspace?.displayName || record.view?.workspace?.storedPath?.split(/[\\/]/).filter(Boolean).at(-1) || '工作区未提供'; }
export const EXECUTORS = ['workbuddy', 'dsh'];
export const EXECUTOR_LABELS = { workbuddy: 'WorkBuddy', dsh: 'DSH', unknown: '来源未提供' };
/** Stored execution source → stable filter key. Interactive ACP sessions are
 * still WorkBuddy desktop runs; only an explicit dsh binding selects DSH. */
export function executorKey(record) {
    const source = record?.view?.binding?.runtimeSource;
    if (source === 'dsh')
        return 'dsh';
    if (source === 'desktop_queue' || source === 'desktop_interactive')
        return 'workbuddy';
    return 'unknown';
}
export function executorName(record) { return EXECUTOR_LABELS[executorKey(record)]; }
/** Counts for the executor filter chips. Zero-count executors are dropped so
 * the toolbar never offers a filter that cannot match. */
export function executorBreakdown(records) {
    const counts = new Map();
    for (const record of Array.isArray(records) ? records : []) {
        const key = executorKey(record);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].filter(([, count]) => count > 0).map(([key, count]) => ({ key, label: EXECUTOR_LABELS[key], count }));
}
export function currentReview(record) { return record.reviews?.filter(r => r.attemptId === record.view?.attempt?.id).at(-1) ?? null; }
export function proofs(record) {
    const report = record.presentation?.report, review = currentReview(record);
    const passed = review?.checks?.length > 0 && review.checks.every(c => c.status === 'passed' && c.actor !== 'worker');
    return [
        { label: '执行报告', value: report ? '已收到' : '尚未提供', confirmed: Boolean(report), detail: report?.authentication === 'authenticated' ? '来源认证通过' : report ? '以已存报告为准' : '没有报告正文' },
        { label: '原生停止', value: record.view?.remoteStopped === true ? '已确认' : '尚未确认', confirmed: record.view?.remoteStopped === true, detail: '与执行结果分别记录' },
        { label: '独立验收', value: record.view?.businessState === 'accepted' && passed ? '已通过' : review ? '审查已记录' : '尚无审查', confirmed: record.view?.businessState === 'accepted' && passed, detail: review ? '保存的检查与审查快照' : '不以自报完成代替验收' },
    ];
}
export function filterRecords(records, { search = '', state = '', executor = '', workspace = '', group = 'all' } = {}) {
    const query = search.trim().toLocaleLowerCase();
    return records.filter(r => {
        const info = stateInfo(r);
        if (group === 'attention' && !['waiting_input', 'waiting_stop', 'needs_review', 'failed', 'expired', 'unknown', 'inconsistent'].includes(info.key))
            return false;
        if (group === 'accepted' && info.key !== 'accepted')
            return false;
        return (!state || info.key === state) && (!executor || executorKey(r) === executor) && (!workspace || workspaceName(r) === workspace) && (!query || [taskName(r), r.taskId, r.presentation?.objective, workspaceName(r)].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
    });
}
export function formatTime(value) {
    if (!value || !Number.isFinite(Date.parse(value)))
        return '未提供';
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
export function eventName(type) {
    return ({ task_created: '任务已建立', attempt_started: '开始本轮执行', task_updated: '任务记录更新', report_received: '收到执行报告', native_stopped: '原生停止已确认', task_closed: '工作流已关闭', review_created: '独立审查已保存', task_reviewed: '验收决定已保存', task_accepted: '交付已验收', input_requested: '等待原生输入', cancellation_requested: '已记录取消请求', workspace_scope_checked: '范围检查已记录', workspace_baseline_bound: '本轮基线已绑定' })[type] || type;
}
export function validateRecord(value) {
    const report = value?.presentation?.report;
    const reviewsValid = value?.reviews === null || Array.isArray(value?.reviews) && value.reviews.every(r => r && typeof r.reviewId === 'string' && typeof r.attemptId === 'string' && Array.isArray(r.checks) && r.checks.every(c => c && typeof c.checkId === 'string' && typeof c.status === 'string' && typeof c.actor === 'string' && Array.isArray(c.evidenceRefs) && c.evidenceRefs.every(v => typeof v === 'string')));
    return Boolean(value && value.ok === true && typeof value.taskId === 'string' && value.view?.taskId === value.taskId && value.view?.schemaVersion === 'workbuddy-executor/stage-2' && typeof value.view.businessState === 'string' && value.view.attempt && value.view.binding && value.view.timing && value.view.workspace && value.presentation && typeof value.presentation.objective === 'string' && [true, false, null].includes(value.view.remoteStopped) && reviewsValid && (report === null || report && typeof report.text === 'string'));
}

/** P0-4 keyboard list navigation: derive the next task id from the visible
 * rows so the browser handler stays a thin wrapper. Unknown anchors and
 * out-of-range steps return null — no wraparound guessing. */
export function taskListNavigation(visible, selectedId, step) {
    if (!Array.isArray(visible) || visible.length === 0 || !Number.isInteger(step) || step === 0)
        return null;
    const index = visible.findIndex(r => r?.taskId === selectedId);
    if (index === -1)
        return null;
    const next = index + step;
    return next >= 0 && next < visible.length ? visible[next].taskId : null;
}

/** P0-4 reconnect backoff for live reads: deterministic doubling, capped at
 * 30s. The caller owns the attempt budget (RETRY_MAX_ATTEMPTS); a bad attempt
 * value yields null so a caller bug surfaces instead of retrying blindly. */
export const RETRY_MAX_ATTEMPTS = 5;
export function nextRetryDelayMs(attempt) {
    if (!Number.isInteger(attempt) || attempt < 0)
        return null;
    return Math.min(30000, 2000 * 2 ** attempt);
}
