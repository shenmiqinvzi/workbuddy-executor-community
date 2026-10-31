import test from 'node:test';
import assert from 'node:assert/strict';
import {controlCandidates} from '../controls.mjs';

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
