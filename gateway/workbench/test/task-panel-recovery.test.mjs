import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionReason, reportAuthentication } from '../attention.mjs';
import { stateInfo, formatTime } from '../model.mjs';
import { controlCandidates, unavailableReasons } from '../controls.mjs';

// Same shape the panel really receives: the report lives on presentation.report
// and the review carries both the basis and the committed revision.
const record = (view = {}, extra = {}) => ({
    ok: true,
    taskId: 'desktop-1',
    view: {
        businessState: 'needs_review', displayState: 'needs_review', remoteStopped: true, revision: 'rev-2',
        attempt: { id: 'run-1', number: 1, limit: 2 }, timing: { nativeStoppedAt: '2026-11-02T12:00:00.000Z' }, ...view,
    },
    reviews: [],
    presentation: { report: { text: '已完成', authentication: 'authenticated' } },
    ...extra,
});
const review = (over = {}) => ({ attemptId: 'run-1', reviewId: 'review-1', basisRevision: 'rev-1', committedRevision: 'rev-2', checks: [{ checkId: 'check-1', status: 'passed', actor: 'independent_reviewer' }], ...over });

test('a report that arrives while the run is still busy is not a result', () => {
    for (const [state, label] of [['running', /尚未确认停止/], ['queued', /仍在排队/], ['waiting_input', /尚未确认停止/]]) {
        const info = stateInfo(record({ displayState: state, businessState: state === 'waiting_input' ? 'working' : 'working' }));
        assert.equal(info.key, state, 'the group and the filters keep the recorded state');
        assert.match(info.label, label);
        assert.match(info.description, /验收与返工入口保持关闭/);
    }
    // And nothing offers accept or rework, even though a report exists.
    const view = { displayState: 'running', businessState: 'working', remoteStopped: false, revision: 'rev-2', attempt: { id: 'run-1', number: 1, limit: 2 } };
    assert.deepEqual(controlCandidates(record(view, { reviews: [review()] })), ['cancel']);
    const codes = unavailableReasons(record(view, { reviews: [review()] })).map(reason => reason.code);
    assert.equal(codes.includes('review_incomplete'), false);
});

test('the pending-review card names the one fact that blocks acceptance', () => {
    const missing = attentionReason(record({}));
    assert.equal(missing.code, 'review_pending');
    assert.match(missing.why, /没有独立审查记录/);

    const stale = attentionReason(record({}, { reviews: [review({ committedRevision: 'rev-1' })] }));
    assert.equal(stale.code, 'review_pending');
    assert.match(stale.why, /提交在版本 rev-1/);
    assert.match(stale.why, /当前记录已是版本 rev-2/);
    assert.match(stale.why, /重新审查/);

    const self = attentionReason(record({}, { reviews: [review({ checks: [{ checkId: 'check-9', status: 'passed', actor: 'worker' }] })] }));
    assert.match(self.why, /执行器自报/);
    assert.match(self.why, /check-9/);

    const broken = attentionReason(record({}, { reviews: [review({ checks: [{ checkId: 'check-2', status: 'failed', actor: 'independent_reviewer' }, { checkId: 'check-3', status: 'passed', actor: 'independent_reviewer' }] })] }));
    assert.match(broken.why, /check-2（failed）/);
    assert.equal(/check-3/.test(broken.why), false);

    const clean = attentionReason(record({}, { reviews: [review()] }));
    assert.match(clean.why, /检查项全部通过/);
    assert.match(clean.why, /由人来提交/);
    assert.equal(/不一致/.test(clean.why), false, 'a current, passing review is not described as stale');
});

test('a review of the current revision does offer accept', () => {
    const view = { displayState: 'needs_review', businessState: 'needs_review', remoteStopped: true, revision: 'rev-2', attempt: { id: 'run-1', number: 1, limit: 2 } };
    assert.deepEqual(controlCandidates(record(view, { reviews: [review()] })), ['rework', 'accept']);
});

test('unreadable timestamps are named, never echoed raw', () => {
    assert.equal(formatTime('not-a-time'), '未提供');
    const stopped = attentionReason(record({ displayState: 'waiting_stop', businessState: 'needs_review', remoteStopped: false, timing: { nativeStoppedAt: 'not-a-time' } }));
    assert.equal(stopped.code, 'stop_unconfirmed');
    assert.match(stopped.why, /无法识别/);
    const absent = attentionReason(record({ displayState: 'waiting_stop', businessState: 'needs_review', remoteStopped: false, timing: { nativeStoppedAt: null } }));
    assert.match(absent.why, /停止记录时间 无/);
    const orphan = attentionReason(record({ runOrphaned: true, dispatchLease: { ownerPid: 'seven', heartbeatAt: 'yesterday' } }));
    assert.equal(orphan.code, 'run_orphaned');
    assert.match(orphan.why, /owner_pid 未提供/);
    assert.match(orphan.why, /无法识别/);
});

test('authentication is read from the one recorded place', () => {
    assert.equal(reportAuthentication(record()), '通过');
    assert.equal(reportAuthentication(record({}, { presentation: { report: { authentication: 'unauthenticated' } } })), '未通过');
    assert.equal(reportAuthentication(record({}, { presentation: { report: {} } })), '未提供');
    // An authentication-looking field anywhere else is not evidence of a report.
    assert.equal(reportAuthentication(record({ authentication: 'authenticated' }, { presentation: {} })), '未提供');
    assert.equal(reportAuthentication({ ok: false }), '未提供');
});

test('a future state stays unknown and keeps its own card', () => {
    const info = stateInfo(record({ displayState: 'settling_v2', businessState: 'working' }));
    assert.equal(info.key, 'unknown');
    const reason = attentionReason(record({ displayState: 'settling_v2', businessState: 'working', remoteStopped: null }));
    assert.equal(reason.code, 'unknown_state');
    assert.match(reason.why, /不替它选择一种解释/);
});
