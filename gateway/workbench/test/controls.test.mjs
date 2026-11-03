import test from 'node:test';
import assert from 'node:assert/strict';
import {controlCandidates,unavailableReasons} from '../controls.mjs';

const task=(state,stopped,number=1,limit=2,reviews=[])=>({taskId:'task',view:{revision:'rev',businessState:state,remoteStopped:stopped,attempt:{id:'attempt',number,limit}},reviews});
test('task controls distinguish a stop request, a stopped review and final acceptance',()=>{
 assert.deepEqual(controlCandidates(task('working',false)),['cancel']);
 assert.deepEqual(controlCandidates(task('cancelled',false)),[]);
 assert.deepEqual(controlCandidates(task('cancelled',true)),[]);
 assert.deepEqual(controlCandidates(task('needs_review',false)),[]);
 assert.deepEqual(controlCandidates(task('needs_review',true)),['rework','review']);
 assert.deepEqual(controlCandidates(task('needs_review',true,2,2)),['review']);
 const review={reviewId:'r',attemptId:'attempt',committedRevision:'rev',checks:[{status:'passed',actor:'program'}]};
 assert.deepEqual(controlCandidates(task('needs_review',true,1,2,[review])),['rework','accept']);
 assert.deepEqual(controlCandidates(task('needs_review',true,1,2,[{...review,checks:[{status:'passed',actor:'worker'}]}])),['rework','review']);
 assert.deepEqual(controlCandidates(task('accepted',true,1,2,[review])),[]);
});

const codes = (record, options) => unavailableReasons(record, options).map(reason => reason.code);

test('a task with nothing to click states why instead of staying silent', () => {
    assert.deepEqual(codes({taskId: 't', view: {revision: 'rev', businessState: 'working', remoteStopped: false, attempt: null}}), ['attempt_missing']);
    assert.deepEqual(codes({taskId: 't', view: {revision: null, businessState: 'working', remoteStopped: false, attempt: {id: 'attempt', number: 1, limit: 2}}}), ['revision_missing']);
    assert.deepEqual(codes(task('working', false), {desktopAvailable: false}), ['desktop_unavailable']);
    assert.deepEqual(codes(task('working', false), {live: false}), ['not_live']);
    assert.deepEqual(codes({taskId: 't', view: {revision: 'rev', businessState: 'working', remoteStopped: false, attempt: null}}, {desktopAvailable: false, live: false}), ['desktop_unavailable', 'not_live', 'attempt_missing']);
});

test('an unconfirmed native stop is named as such, never presented as a finished task', () => {
    assert.deepEqual(codes(task('needs_review', false)), ['native_stop_unconfirmed']);
    assert.equal(unavailableReasons(task('needs_review', false))[0].text.includes('尚未确认原生停止'), true);
    assert.deepEqual(codes(task('working', true)), ['already_stopped']);
    assert.deepEqual(codes(task('accepted', true, 1, 2, [{reviewId: 'r', attemptId: 'attempt', committedRevision: 'rev', checks: [{status: 'passed', actor: 'program'}]}])), ['state_not_actionable']);
});

test('a task with candidate controls never claims it is unavailable', () => {
    assert.deepEqual(unavailableReasons(task('working', false)), []);
    assert.deepEqual(unavailableReasons(task('needs_review', true)), []);
});

test('the execution capacity slot is a separate reason, never read as this task', () => {
    const other = {schemaVersion: 'workbuddy-executor/capacity-1', readOnly: true, limit: 1, occupied: {taskId: 'other-task', executor: 'workbuddy', operationId: 'desktop-send-1'}};
    const idle = {...other, occupied: null};
    const self = {...other, occupied: {taskId: 'task', executor: 'workbuddy', operationId: 'desktop-send-1'}};
    assert.deepEqual(codes(task('accepted', true)), ['state_not_actionable'], 'an idle slot adds no reason');
    assert.deepEqual(codes(task('accepted', true), {capacity: idle}), ['state_not_actionable']);
    assert.deepEqual(codes(task('accepted', true), {capacity: other}), ['capacity_occupied_other', 'state_not_actionable']);
    assert.equal(unavailableReasons(task('accepted', true), {capacity: other})[0].text.includes('other-task'), true);
    assert.deepEqual(codes(task('accepted', true), {capacity: self}), ['state_not_actionable'], 'holding the slot is not a blocker for its own task');
});

test('an unread capacity record is reported as unknown, not as a free slot', () => {
    assert.deepEqual(codes(task('accepted', true), {capacity: 'unreadable'}), ['capacity_unknown', 'state_not_actionable']);
    assert.equal(unavailableReasons(task('accepted', true), {capacity: 'unreadable'})[0].text.includes('不等于容量空闲'), true);
    assert.deepEqual(codes(task('working', false), {capacity: 'unreadable'}), [], 'candidate controls still render; capacity never blocks a candidate');
});
