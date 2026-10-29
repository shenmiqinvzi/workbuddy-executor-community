// Explicitly selected synthetic data. Never a fallback for a failed live read.
const now = '2026-10-29T08:40:00.000Z';
const names = ['收紧 clamp 参数边界', '整理 HTTP 错误文案', '补齐安装路径说明', '验证事件游标恢复', '核对源文件快照', '修复输入边界校验', '同步协作接口示例', '检查原生停止证据', '归档只读验收结果', '核对旧版任务记录'];
const states = ['needs_review', 'running', 'waiting_input', 'accepted', 'waiting_stop', 'failed', 'queued', 'cancelled', 'expired', 'unknown'];
export const SCENARIOS = [['normal', '日常工作流'], ['all', '全部任务状态'], ['empty', '空工作区'], ['error', '读取失败'], ['stale', '连接中断与旧快照'], ['legacy', '历史记录缺证'], ['inconsistent', '状态与停止证明冲突'], ['long', '长标题与报告']];
function fixture(i, key) {
    const id = 'demo-task-' + (i + 1), state = states[i], stopped = !['running', 'queued', 'waiting_stop', 'waiting_input', 'unknown'].includes(state);
    const checks = [
        { id: 'demo-check-provenance', checkId: '$provenance', kind: 'provenance', status: 'passed', actor: 'program', checkedAt: now, note: '报告来源认证与本轮原生停止证据匹配。', evidenceRefs: ['demo-native-proof'], checkedFileCount: 0 },
        { id: 'demo-check-tests', checkId: 'clamp-tests', kind: 'command', status: 'passed', actor: 'program', checkedAt: now, note: '后端独立执行原约定命令。2 项通过，退出码 0；清理已确认。', evidenceRefs: ['demo-command-record'], checkedFileCount: 2 },
        { id: 'demo-check-scope', checkId: '$scope', kind: 'scope', status: 'passed', actor: 'program', checkedAt: now, note: '实际增量在约定范围内，原有用户改动和暂存索引保持不变。', evidenceRefs: ['demo-inventory'], checkedFileCount: 5 },
        { id: 'demo-check-behavior', checkId: 'behavior-and-scope', kind: 'semantic', status: i === 0 ? 'unknown' : 'passed', actor: 'independent_reviewer', checkedAt: now, note: i === 0 ? '已收到程序检查，行为与范围仍需独立审查者给出结论。' : '已阅读当前源文件和固定测试，合法输入行为保持，非法参数明确拒绝。', evidenceRefs: ['demo-inspection'], checkedFileCount: 3 },
    ];
    const record = { ok: true, taskId: id, schemaVersion: 'workbuddy-executor/panel-1', readOnly: true, snapshotOnly: true,
        view: { schemaVersion: 'workbuddy-executor/stage-2', taskId: id, revision: 'demo-revision-' + i, title: null, workspace: { displayName: null, id: null, storedPath: i < 4 ? 'examples/executor-gateway' : 'examples/acceptance-lab' }, attempt: { id: 'demo-attempt-' + i, number: i === 3 ? 2 : 1, limit: 1 + (i === 3 ? 2 : 0) }, binding: { sessionId: 'demo-session-' + i, runtimeSource: i % 2 === 0 ? 'desktop_queue' : 'dsh' }, businessState: ({ running: 'working', waiting_input: 'blocked', waiting_stop: 'needs_review', expired: 'blocked', unknown: 'blocked' })[state] || state, displayState: state, remoteStopped: stopped, allowedActions: [], timing: { createdAt: now, lastObservedAt: now, reviewedAt: state === 'accepted' ? now : null, nativeStoppedAt: stopped ? now : null }, workspaceScope: { baseline: 'present', check: { status: 'passed', changes: [{ path: 'src/clamp.mjs', kind: 'modified', category: 'deliverable' }, { path: 'artifacts/DELIVERY.md', kind: 'added', category: 'deliverable' }] }, changeCount: 2, changesTruncated: false } },
        presentation: { title: names[i], objective: '只接受有限 number 参数，并要求 min 不大于 max；保留合法输入的原有行为。README、固定测试和原有用户改动保持不变。', allowedChanges: ['src/**', 'artifacts/DELIVERY.md'], model: 'deepseek-flash', report: stopped || state === 'waiting_stop' ? { text: '已交付 src/clamp.mjs 与 artifacts/DELIVERY.md。\n\n为三个参数增加有限数字校验，并拒绝反向边界。\n执行器自测：2 项通过，退出码 0。\n\n这是一份执行报告，独立检查与验收结论单独记录。', truncated: false, authentication: 'authenticated' } : null },
        reviews: ['needs_review', 'accepted'].includes(state) ? [{ reviewId: 'demo-review-' + i, attemptId: 'demo-attempt-' + i, createdAt: now, basisRevision: 'demo-basis', committedRevision: 'demo-committed', runtimeSource: i % 2 === 0 ? 'desktop_queue' : 'dsh', note: '演示：不可变审查记录。', checks, supersedesReviewId: null, correction: null }] : [], reviewsTruncated: false, reviewMeaning: 'stored_acceptance_snapshot',
    };
    if (state === 'failed') { record.presentation.report.text = '本轮未完成。\n\n演示：输入边界测试仍有一项未通过。保留当前源码与失败记录，等待独立审查；没有自动追加执行轮次。'; record.presentation.blockingReason = '演示：固定测试仍有失败项。'; }
    if (state === 'waiting_input') record.presentation.blockingReason = '演示：执行器正在等待用户核对原生权限请求。';
    if (key === 'legacy') {
        record.reviews = [];
        record.presentation.title = null;
        delete record.view.workspaceScope;
    }
    if (key === 'inconsistent' && i === 0)
        record.view.remoteStopped = false;
    if (key === 'long' && i === 0) {
        record.presentation.title = '核对来自多执行器的跨轮次输入校验、范围保护与独立验收证据绑定';
        record.presentation.report.text = '<script>演示纯文本，不会执行</script>\n'.repeat(80);
    }
    return record;
}
export class DemoSource {
    constructor(scenario = 'normal') { this.kind = 'demo'; this.scenario = scenario; this.reads = 0; }
    async health() { return { schemaVersion: 'workbuddy-executor/stage-2', ready: true, runtime: { packageVersion: '演示', release: 'synthetic' } }; }
    async list() { if (this.scenario === 'error' || this.scenario === 'stale' && this.reads++ > 0)
        throw new Error('演示场景：无法连接数据源。'); return { schemaVersion: 'workbuddy-executor/panel-1', tasks: this.scenario === 'empty' ? [] : names.slice(0, this.scenario === 'all' ? 10 : 6).map((_, i) => fixture(i, this.scenario)), nextAfterTaskId: null }; }
    async task(id) { const i = Number(id.split('-').at(-1)) - 1; return fixture(i, this.scenario); }
    async events(id, after = 0) { const entries = ['task_created', 'attempt_started', 'report_received', 'native_stopped', ...(id === 'demo-task-4' ? ['review_created', 'task_accepted', 'task_closed'] : ['review_created'])]; const events = entries.map((type, i) => ({ eventId: i + 1, taskId: id, attemptId: 'demo-attempt-' + (Number(id.split('-').at(-1)) - 1), type, occurredAt: now, observedAt: now, payload: {} })).filter(e => e.eventId > after); return { events, nextEventId: entries.length }; }
}
