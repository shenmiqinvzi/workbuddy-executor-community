import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionItems, attentionReason } from '../attention.mjs';

const record = (view, extra = {}) => ({
    ok: true,
    taskId: 'desktop-1',
    view: { businessState: 'needs_review', displayState: 'needs_review', remoteStopped: true, revision: 'rev-1', attempt: { id: 'run-1', number: 1, limit: 1 }, timing: { nativeStoppedAt: '2026-11-02T12:00:00.000Z' }, reportAuthentication: 'authenticated', ...view },
    reviews: [],
    presentation: {},
    ...extra
});

test('a stopped-but-unconfirmed report says so instead of looking finished', () => {
    const reason = attentionReason(record({ displayState: 'waiting_stop', businessState: 'needs_review', remoteStopped: false, timing: { nativeStoppedAt: null } }));
    assert.equal(reason.code, 'stop_unconfirmed');
    assert.match(reason.title, /停止未确认/);
    assert.match(reason.why, /停止证据缺失/);
    assert.match(reason.next, /不要重派/);
});

test('needs_review without a review is a pending duty, not a failure', () => {
    const reason = attentionReason(record({}));
    assert.equal(reason.code, 'review_pending');
    assert.match(reason.why, /没有独立审查记录/);
});

test('a pending review whose stop records disagree never says the stop was confirmed', () => {
    const reason = attentionReason(record({ displayState: 'needs_review', businessState: 'needs_review', remoteStopped: true, timing: { nativeStoppedAt: null } }));
    assert.equal(reason.code, 'review_pending');
    assert.match(reason.title, /停止证据不完整/);
    assert.match(reason.next, /先核对停止/);
    assert.doesNotMatch(reason.next, /停止已确认/);
});

test('an outdated review is described by its basis revision, never as passing', () => {
    const reason = attentionReason(record({}, { reviews: [{ attemptId: 'run-1', basisRevision: 'rev-0', committedRevision: 'rev-0', checks: [{ status: 'passed', actor: 'independent_reviewer' }] }] }));
    assert.equal(reason.code, 'review_pending');
    assert.match(reason.why, /rev-0/);
});

test('inconsistent evidence keeps its own reason', () => {
    const reason = attentionReason(record({ displayState: 'needs_review', businessState: 'needs_review', remoteStopped: false, timing: { nativeStoppedAt: null } }));
    assert.equal(reason.code, 'stop_unconfirmed');
    assert.match(reason.title, /缺少停止证明/);
});

test('accepted tasks are not pending', () => {
    assert.equal(attentionReason(record({ displayState: 'accepted', businessState: 'accepted' })), null);
});

test('waiting_for_input and blocked keep their own wording', () => {
    assert.equal(attentionReason(record({ displayState: 'waiting_input', businessState: 'working' })).code, 'input_waiting');
    const blocked = attentionReason(record({ displayState: 'blocked', businessState: 'blocked' }, { presentation: { blockingReason: '原生停止未确认' } }));
    assert.equal(blocked.code, 'blocked');
    assert.match(blocked.why, /原生停止未确认/);
});

test('the pending list keeps only rows with a recorded reason', () => {
    const rows = [record({}), record({ displayState: 'accepted', businessState: 'accepted' }), record({ displayState: 'waiting_stop', remoteStopped: false, timing: { nativeStoppedAt: null } })];
    const items = attentionItems(rows);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.reason.code), ['review_pending', 'stop_unconfirmed']);
});
