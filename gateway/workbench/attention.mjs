/** Every task in the 待处理 list owes the reader two things: the recorded
 * reason it is here, and a way to re-check the evidence without repeating the
 * work. Both are derived from saved facts only; a missing record is reported as
 * missing, never filled with a guess. */
import { desktopRequest } from './dispatch.mjs';
import { stateInfo, currentReview, formatTime } from './model.mjs';

const el = (tag, props = {}, ...children) => { const node = document.createElement(tag); for (const [key, value] of Object.entries(props)) { if (key.startsWith('on')) node.addEventListener(key.slice(2), value); else if (key === 'class') node.className = value; else if (key === 'hidden') node.hidden = Boolean(value); else if (key === 'disabled') node.disabled = Boolean(value); else node.setAttribute(key, String(value)); } for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child))); return node; };

const ATTENTION_STATES = ['waiting_input', 'waiting_stop', 'needs_review', 'blocked', 'failed', 'expired', 'unknown', 'inconsistent'];
const ATTENTION_DISPLAY = ['waiting_stop', 'waiting_input', 'unknown', 'inconsistent'];

const near = {
    stop_unconfirmed: '先核对证据，不要重派：没有停止证明不等于原效果已经结束。',
    input_waiting: '执行器在等输入；回复原会话，或按人工收口处理。',
    review_pending: '报告已收到且停止已确认；还缺一份独立审查，不能当成验收完成。',
    review_pending_unstopped: '报告已收到，但停止证据不完整；先核对停止，再谈独立审查。',
    blocked: '先看阻塞原因；若涉及停止或身份，只做核对，不做自动重试。',
    failed: '失败不等于工作区没有变化；按允许修改范围核对后再决定。',
    unknown_state: '状态本身无法判定；以证据为准，不要用界面上的空白推断结果。',
    run_orphaned: '派工进程已退出且没有回执；先核对它做了什么，再决定重派或收口。',
};

/** Report authentication as the panel actually records it: the field lives on
 * `record.presentation.report.authentication` (see model.mjs). Kept pure and
 * exported so a wrong path is caught by a test instead of by a card claiming
 * "未提供" over an authenticated report. */
export function reportAuthentication(record) {
    const value = record?.presentation?.report?.authentication;
    if (value === 'authenticated') return '通过';
    if (value === 'unauthenticated') return '未通过';
    return typeof value === 'string' && value.trim() ? value : '未提供';
}

/** A missing timestamp reads as 无; a value that is present but unparseable is
 * named as such instead of being echoed raw into a sentence. */
function timeOrMissing(value) {
    if (value === null || value === undefined || value === '') return '无';
    return Number.isFinite(Date.parse(value)) ? formatTime(value) : `无法识别（${String(value).slice(0, 40)}）`;
}

/** Which saved fact keeps a review from carrying an acceptance. The card names
 * that one fact instead of a generic "有未通过项": a review of an older
 * revision is a different problem from a failed check, and a current review
 * with every check passed is not blocked by the review at all. */
function reviewBlocking(view, review) {
    if (!review) return '本轮没有独立审查记录；执行报告的自报不能代替它。';
    const started = review.basisRevision && review.basisRevision !== view?.revision ? `（审查开始时的版本 ${review.basisRevision}）` : '';
    if (review.committedRevision && view?.revision && review.committedRevision !== view.revision)
        return `最近一份审查提交在版本 ${review.committedRevision}${started}，当前记录已是版本 ${view.revision}；需要针对当前版本重新审查。`;
    const checks = Array.isArray(review.checks) ? review.checks : [];
    if (!checks.length) return '本轮审查没有保存任何检查项，不能作为验收依据。';
    const selfReported = checks.filter(check => check.actor === 'worker');
    if (selfReported.length) return `本轮检查项由执行器自报（${selfReported.map(check => check.checkId).join('、')}），不能算作独立检查。`;
    const failed = checks.filter(check => check.status !== 'passed');
    if (failed.length) return `本轮审查有未通过项：${failed.map(check => `${check.checkId}（${check.status}）`).join('、')}；修正后需要重新审查。`;
    return `当前版本 ${view?.revision ?? '未提供'} 已有独立审查且检查项全部通过${started}；确认验收需要由人来提交。`;
}

/** IR-A5: a damaged run journal is its own reason, never a generic block.
 * The record says why this attempt's events cannot be read; the card must not
 * suggest a retry or a close, because either one would turn "unknown" into a
 * conclusion the evidence does not support. */
export const UNREADABLE_JOURNAL = 'journal_unreadable';

/** Which saved fact puts this task here, in the reader's words. */
export function attentionReason(record) {
    const view = record?.view;
    if (!view) return null;
    const info = stateInfo(record);
    const display = view.displayState;
    if (!ATTENTION_STATES.includes(info.key) && !ATTENTION_DISPLAY.includes(display)) return null;
    const business = view.businessState;
    const review = currentReview(record);
    const stopMissing = view.remoteStopped === false || view.timing?.nativeStoppedAt == null;
    // R12: the lease evidence outranks every other reading — a dead owner with
    // no receipt means nobody is managing this run, whatever the state says.
    if (view.runOrphaned === true) {
        const lease = view.dispatchLease;
        const pid = Number.isInteger(view.dispatchLease?.ownerPid) ? view.dispatchLease.ownerPid : '未提供';
        return { code: 'run_orphaned', title: '运行已无人管理（派工进程已退出）', why: `派工租约显示主人进程已退出（owner_pid ${pid}，心跳 ${timeOrMissing(lease?.heartbeatAt)}），且没有任何回执。这个状态可能出现在报告已到或尚未到时；先核对证据，再决定重派或收口。`, next: near.run_orphaned };
    }
    if (display === 'waiting_stop') return { code: 'stop_unconfirmed', title: '报告已到，原生停止未确认', why: `执行报告已记录（认证：${reportAuthentication(record)}），但停止证据缺失：停止记录时间 ${timeOrMissing(view.timing?.nativeStoppedAt)}。停止未确认时，返工、审查与验收都不能提交。`, next: near.stop_unconfirmed };
    if (display === 'waiting_input') return { code: 'input_waiting', title: '执行器在等待输入', why: '原会话停在等待输入，没有继续执行；这里没有替它作答的入口。', next: near.input_waiting };
    if (info.key === 'inconsistent') return { code: 'stop_unconfirmed', title: '待验收记录缺少停止证明', why: '记录写着待验收，但原生停止没有确认；这两个事实不能互相顶替。', next: near.stop_unconfirmed };
    if (business === 'blocked' || info.key === 'blocked') {
        if (String(record.presentation?.blockingReason ?? '').trim() === UNREADABLE_JOURNAL) {
            return {
                code: UNREADABLE_JOURNAL,
                title: '这一轮的执行记录读不出来',
                why: '这一轮的事件记录损坏，读不到内容——这既不是任务完成，也不是任务失败。记录不可读时不能重派、不能重试、也不能关闭任务，那样会把「不知道」写成结论。',
                next: '按原目录人工检查该轮次的事件文件（来源 unreadable-journal），确认发生了什么之后再决定是否重开一轮；本页不提供重试或关闭入口。',
                retryable: false,
                dismissible: false,
            };
        }
        return { code: 'blocked', title: '任务受阻', why: `已记录阻塞原因：${record.presentation?.blockingReason || '未提供'}。`, next: near.blocked };
    }
    if (info.key === 'needs_review') return { code: 'review_pending', title: stopMissing ? '待复核，但停止证据不完整' : '等待独立验收', why: reviewBlocking(view, review), next: stopMissing ? near.review_pending_unstopped : near.review_pending };
    if (info.key === 'failed' || info.key === 'expired') return { code: 'failed', title: info.label || '执行未完成', why: '本轮以未完成收场，执行容量与工作区需要按证据核对。', next: near.failed };
    if (ATTENTION_DISPLAY.includes(display) || ['unknown', 'inconsistent'].includes(info.key)) return { code: 'unknown_state', title: '状态无法判定', why: '状态与停止证明不一致或缺少必要记录；界面不替它选择一种解释。', next: near.unknown_state };
    return null;
}

export function attentionItems(records = []) {
    return records.map(record => ({ record, reason: attentionReason(record) })).filter(item => item.reason);
}

const FACT_LABELS = {
    conclusion: '结论', identity: '核对的身份', available: '证据是否可读', reason: '不可读原因',
    operationId: '原操作', taskId: '任务', kind: '操作类型', state: '操作状态', integrity: '记录完整性',
    preparationEnteredAt: '进入准备', dispatchEnteredAt: '进入派工', attemptId: '执行轮次',
};

/** Re-check the saved evidence for this task through the desktop channel.
 * Read-only: it opens the ledger read-only and never resolves or retries. */
export function renderAttention(record, { refresh } = {}) {
    const reason = attentionReason(record);
    if (!reason) return null;
    const root = el('section', {
        class: 'attention-card', 'aria-label': '待处理原因与核对入口', 'data-reason': reason.code,
        ...(reason.retryable === false ? { 'data-retryable': 'false' } : {}),
        ...(reason.dismissible === false ? { 'data-dismissible': 'false' } : {}),
    });
    root.append(el('h3', {}, reason.title), el('p', { class: 'attention-why' }, reason.why), el('p', { class: 'attention-next' }, '下一步：' + reason.next));
    const facts = el('div', { class: 'attention-facts', hidden: true });
    const button = el('button', { class: 'button', type: 'button', onclick: async () => {
        button.disabled = true;
        button.textContent = '正在核对…';
        try {
            const value = await desktopRequest('attention_verify', { taskId: record.taskId });
            facts.hidden = false;
            facts.replaceChildren(...factRows(value, record));
            // Deliberately no refresh here: re-rendering the record rebuilds the
            // card and throws away the evidence the reader just asked to see.
            // The saved records did not change, so the reader stays on the answer.
        } catch (error) {
            facts.hidden = false;
            facts.replaceChildren(el('p', { class: 'attention-error' }, '核对没有完成：' + (error?.message || '桌面通道不可用') + '。已保存的证据没有改变。'));
        } finally {
            button.disabled = false;
            button.textContent = '核对当前证据';
        }
    } }, '核对当前证据');
    root.append(button, facts);
    // R2: the human stop-declaration entry belongs wherever the card says the
    // stop evidence is incomplete — the waiting_stop card and the review card
    // whose stop records disagree. A completed review keeps no entry.
    if (offersDeclaration(reason, record)) {
        const declared = declarationBlock(record, { refresh });
        if (declared) root.append(declared);
    }
    return root;
}

/** A declaration is the weakest possible proof, so it is fenced three ways:
 * the reader must type the exact sentence built from the identity on screen,
 * the record says `human_declaration` forever, and nothing here releases a slot. */
function declarationBlock(record, { refresh }) {
    const attemptId = record.view?.attempt?.id, revision = record.view?.revision;
    if (!attemptId || !revision) return null;
    const sentence = `declare native stop ${record.taskId} ${attemptId} ${revision}`;
    const statement = el('textarea', { rows: '3', 'aria-label': '说明你如何确认原生已停', placeholder: '例如：我在原生窗口看到会话已结束，任务栏没有运行中的会话。' });
    const confirm = el('input', { type: 'text', 'aria-label': '输入确认句', autocomplete: 'off', placeholder: '按下面这句原样输入' });
    const feedback = el('p', { class: 'attention-error', hidden: true });
    const submit = el('button', { class: 'button', type: 'button', disabled: true }, '声明原生已停');
    confirm.addEventListener('input', () => { submit.disabled = confirm.value !== sentence; });
    submit.addEventListener('click', async () => {
        submit.disabled = true;
        submit.textContent = '正在记录…';
        try {
            const value = await desktopRequest('declare_native_stop', { taskId: record.taskId, attemptId, revision, statement: statement.value, confirmation: confirm.value });
            feedback.hidden = false;
            feedback.replaceChildren('已记录人工声明 ', el('code', {}, value.declarationId), '。它不等于原生证据，收口仍需单独确认。');
            if (typeof refresh === 'function') refresh(record.taskId);
        } catch (error) {
            feedback.hidden = false;
            feedback.replaceChildren('声明没有记录：' + (error?.message || '桌面通道不可用') + '。任务与证据都没有改变。');
        } finally {
            submit.disabled = confirm.value !== sentence;
            submit.textContent = '声明原生已停';
        }
    });
    const block = el('details', { class: 'attention-declare' },
        el('summary', {}, '我已在原生窗口确认它停了（人工声明）'),
        el('p', { class: 'attention-next' }, '这条记录会一直标明「人工声明」，不会被当成原生证据；它只让收口命令多一个可用依据，不会释放容量，也不会改变任务状态。'),
        el('label', { class: 'attention-label' }, '你怎么确认的', statement),
        el('label', { class: 'attention-label' }, '按原样输入：', el('code', { class: 'attention-sentence' }, sentence), confirm),
        submit, feedback);
    return block;
}

/** Whether this card owes the reader a human stop declaration. Kept pure so
 * the rule is testable without a DOM: it used to read `view` from a scope that
 * never had one, which threw whenever a 待复核 card lacked stop evidence. */
export function offersDeclaration(reason, record) {
    if (!reason) return false;
    return reason.code === 'stop_unconfirmed' || (reason.code === 'review_pending' && record?.view?.remoteStopped === false);
}

/** Label/value pairs of the 核对 result, including the R12 dispatch lease that
 * lives on the record rather than in the evidence answer. Pure, so a wrong
 * scope is caught by a unit test instead of by an operator clicking 核对. */
export function evidenceFacts(value, record = null) {
    const stop = value?.stop || {};
    const dispatch = value?.dispatch || null;
    const lease = record?.view?.dispatchLease ?? null;
    return [
        ['任务状态', value?.task?.state ?? '未提供'],
        ['报告', value?.task?.reportPresent ? '已记录' : '未记录'],
        ['独立审查', value?.task?.reviewedAt ? value.task.reviewedAt : '未记录'],
        ['原生停止', stop.nativeStoppedAt ? stop.nativeStoppedAt : '没有停止证据'],
        ['运行状态', stop.status ?? '未提供'],
        ['原操作', value?.operationId ?? '未记录'],
        ['操作状态', FACT_LABELS.state ? `${value?.operationState ?? '未提供'}（${value?.conclusion ?? '未知'}）` : ''],
        ['派工', dispatch ? `${dispatch.state} / ${dispatch.settlement}` : '无派工记录'],
        lease ? ['派工租约', `${lease.state} · ${lease.settlement}/${lease.reason} · owner_pid ${lease.ownerPid ?? '未知'} · 心跳 ${lease.heartbeatAt ?? '无'}`] : null,
        value?.declaration ? ['人工声明', `${value.declaration.actor} · ${value.declaration.declaredAt} · ${value.declaration.declarationId}`] : ['人工声明', '没有'],
        ['执行容量', value?.capacityHeld ? `仍由任务 ${value.capacityTaskId} 占用` : '未占用'],
    ].filter(Boolean);
}

function factRows(value, record) {
    if (!value || value.available === false) {
        return [el('p', { class: 'attention-error' }, `没有可读的证据：${(value && value.reason) || '未知原因'}。这不代表原效果没有发生。`)];
    }
    return evidenceFacts(value, record).map(([label, text]) => el('div', { class: 'attention-fact' }, el('span', { class: 'attention-fact-label' }, label), el('span', { class: 'attention-fact-value' }, text)));
}
