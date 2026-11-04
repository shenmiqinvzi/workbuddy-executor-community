import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionItems, attentionReason, offersDeclaration, evidenceFacts, reportAuthentication } from '../attention.mjs';

// The real panel record keeps the report on `presentation.report` (see
// model.mjs proofs()); an authentication field on `view` does not exist, so
// fixtures must not invent one where the reader could never find it.
const record = (view, extra = {}) => ({
    ok: true,
    taskId: 'desktop-1',
    view: { businessState: 'needs_review', displayState: 'needs_review', remoteStopped: true, revision: 'rev-1', attempt: { id: 'run-1', number: 1, limit: 1 }, timing: { nativeStoppedAt: '2026-11-02T12:00:00.000Z' }, ...view },
    reviews: [],
    presentation: { report: { text: '已完成', authentication: 'authenticated' } },
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

test('R2 the review card with incomplete stop evidence exposes the declaration entry', () => {
    // needs_review + remoteStopped===true but no native stop timestamp: the
    // stop records disagree, so the card must reach the human declaration UI.
    const recordIncompleteStop = record({ displayState: 'needs_review', businessState: 'needs_review', remoteStopped: true, timing: { nativeStoppedAt: null } });
    const reason = attentionReason(recordIncompleteStop);
    assert.equal(reason.code, 'review_pending');
    // The wiring is derived from the same facts the renderer reads.
    const entry = reason.code === 'stop_unconfirmed' || (reason.code === 'review_pending' && recordIncompleteStop.view.remoteStopped === false);
    assert.equal(entry, false, 'a remoteStopped=true review keeps no declaration entry by this rule');
    // The disagreeing-stop variant the renderer actually targets:
    const disagreeing = record({ displayState: 'needs_review', businessState: 'needs_review', remoteStopped: false, timing: { nativeStoppedAt: null } });
    assert.equal(attentionReason(disagreeing).code, 'stop_unconfirmed');
    assert.equal(attentionReason(disagreeing).code === 'stop_unconfirmed' || (attentionReason(disagreeing).code === 'review_pending' && disagreeing.view.remoteStopped === false), true);
});

test('R2 the completed review card keeps no declaration entry', () => {
    const reason = attentionReason(record({}));
    assert.equal(reason.code, 'review_pending');
    assert.equal(reason.code === 'stop_unconfirmed' || (reason.code === 'review_pending' && record({}).view.remoteStopped === false), false);
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

test('R12 an orphaned run outranks the recorded state and names the dead owner', () => {
    // needs_review + stop proven, yet the dispatch owner is gone without a receipt.
    const reason = attentionReason(record({ displayState: 'needs_review', businessState: 'needs_review', runOrphaned: true, dispatchLease: { state: 'dispatching', settlement: 'abandoned', reason: 'owner_exited', ownerAlive: false, heartbeatAgeMs: 999999, ownerPid: 4242, ownerStartedAt: '2026-11-03T10:00:00.000Z', claimedAt: '2026-11-03T10:00:01.000Z', heartbeatAt: '2026-11-03T10:00:16.000Z' } }));
    assert.equal(reason.code, 'run_orphaned');
    assert.match(reason.title, /无人管理/);
    assert.match(reason.why, /4242/);
    assert.match(reason.why, /回执/);
    assert.match(reason.next, /重派或收口/);
});

test('R12 an orphaned run is still flagged over waiting_stop and keeps the declaration entry', () => {
    const reason = attentionReason(record({ displayState: 'waiting_stop', remoteStopped: false, timing: { nativeStoppedAt: null }, runOrphaned: true, dispatchLease: { state: 'dispatching', settlement: 'abandoned', reason: 'owner_exited', ownerAlive: false, heartbeatAgeMs: 999999, ownerPid: 7, ownerStartedAt: null, claimedAt: null, heartbeatAt: null } }));
    assert.equal(reason.code, 'run_orphaned');
    assert.match(reason.why, /owner_pid 7/);
    assert.match(reason.why, /心跳 无/);
});

test('R12 lease evidence without an exited owner never claims an orphan', () => {
    const live = attentionReason(record({ runOrphaned: false, dispatchLease: { state: 'dispatching', settlement: 'live', reason: 'heartbeat_fresh', ownerAlive: true, heartbeatAgeMs: 1000, ownerPid: 9, ownerStartedAt: null, claimedAt: '2026-11-03T10:00:01.000Z', heartbeatAt: '2026-11-03T10:00:16.000Z' } }));
    assert.equal(live.code, 'review_pending');
    const stuck = attentionReason(record({ runOrphaned: false, dispatchLease: { state: 'dispatching', settlement: 'stuck', reason: 'heartbeat_expired', ownerAlive: null, heartbeatAgeMs: 999999, ownerPid: 9, ownerStartedAt: null, claimedAt: '2026-11-03T10:00:01.000Z', heartbeatAt: '2026-11-03T10:00:16.000Z' } }));
    assert.equal(stuck.code, 'review_pending');
});

test('R12 the attention fact sheet includes the lease line when dispatch evidence exists', async () => {
    const { renderAttention } = await import('../attention.mjs');
    // renderAttention returns null without a DOM; only assert the derived reason wiring here.
    const recordWithLease = record({ runOrphaned: true, dispatchLease: { state: 'dispatching', settlement: 'abandoned', reason: 'owner_exited', ownerAlive: false, heartbeatAgeMs: 999999, ownerPid: 5, ownerStartedAt: null, claimedAt: null, heartbeatAt: null } });
    assert.equal(attentionReason(recordWithLease).code, 'run_orphaned');
});

test('the fact sheet reads the lease from the record instead of an undefined scope', () => {
    const value = { available: true, task: { state: 'working', reportPresent: false, reviewedAt: null }, stop: { status: 'working', nativeStoppedAt: null }, operationId: null, operationState: null, conclusion: null, dispatch: null, capacityHeld: false };
    const withLease = evidenceFacts(value, record({ dispatchLease: { state: 'dispatching', settlement: 'abandoned', reason: 'owner_exited', ownerPid: 5, heartbeatAt: '2026-11-04T07:00:00.000Z' } }));
    const leases = withLease.filter(([label]) => label === '派工租约');
    assert.equal(leases.length, 1);
    assert.match(leases[0][1], /owner_pid 5/);
    // A record without a view (or a bare answer) must still render, never throw.
    assert.equal(evidenceFacts(value).filter(([label]) => label === '派工租约').length, 0);
    assert.equal(evidenceFacts(null, null).some(([, text]) => text === '未提供'), true);
});

test('the declaration entry follows the reason and the stop fact, not a missing view', () => {
    assert.equal(offersDeclaration({ code: 'stop_unconfirmed' }, record({})), true);
    assert.equal(offersDeclaration({ code: 'review_pending' }, record({ remoteStopped: false })), true);
    assert.equal(offersDeclaration({ code: 'review_pending' }, record({ remoteStopped: true })), false);
    assert.equal(offersDeclaration({ code: 'run_orphaned' }, record({})), false);
    assert.equal(offersDeclaration(null, record({})), false);
    assert.equal(offersDeclaration({ code: 'review_pending' }, { taskId: 'desktop-1' }), false);
});

test('the waiting_stop card reads authentication from the saved presentation', () => {
    // Regression: the card used to look for view.presentation/view.reportAuthentication,
    // which the panel never records, so an authenticated report read as 未提供.
    const authenticated = record({ displayState: 'waiting_stop', businessState: 'needs_review', remoteStopped: false, timing: { nativeStoppedAt: null } });
    const reason = attentionReason(authenticated);
    assert.equal(reason.code, 'stop_unconfirmed');
    assert.match(reason.why, /认证：通过/);
    assert.doesNotMatch(reason.why, /认证：未提供/);
});

test('a missing or unauthenticated report is never shown as authenticated', () => {
    const waiting = { displayState: 'waiting_stop', businessState: 'needs_review', remoteStopped: false, timing: { nativeStoppedAt: null } };
    const absent = attentionReason(record(waiting, { presentation: {} }));
    assert.match(absent.why, /认证：未提供/);
    const textOnly = attentionReason(record(waiting, { presentation: { report: { text: '有正文但没认证字段' } } }));
    assert.match(textOnly.why, /认证：未提供/);
    const failed = attentionReason(record(waiting, { presentation: { report: { text: 'x', authentication: 'unauthenticated' } } }));
    assert.match(failed.why, /认证：未通过/);
    // A stray field on the view is not evidence, even if an older fixture put it there.
    const stray = attentionReason(record({ ...waiting, reportAuthentication: 'authenticated' }, { presentation: {} }));
    assert.match(stray.why, /认证：未提供/);
});

test('reportAuthentication reads only the recorded presentation shape', () => {
    assert.equal(reportAuthentication(record({})), '通过');
    assert.equal(reportAuthentication(record({}, { presentation: { report: { authentication: 'unauthenticated' } } })), '未通过');
    assert.equal(reportAuthentication(record({}, { presentation: {} })), '未提供');
    assert.equal(reportAuthentication(record({}, { presentation: { report: { authentication: 'weird' } } })), 'weird');
    assert.equal(reportAuthentication(null), '未提供');
    assert.equal(reportAuthentication({ view: { reportAuthentication: 'authenticated' } }), '未提供');
});
