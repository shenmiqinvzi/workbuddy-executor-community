import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import test from "node:test";
import { reviewFixture } from "./support/review-fixture.js";
import { DesktopControlSession } from "../src/desktop-control.js";
import { desktopControlJournal, inspectDesktopControl, runDesktopControlWorker } from "../src/desktop-control-runtime.js";

async function setup(t:test.TestContext,readyForReview=false,semantic=false,command=false) {
  const f=await reviewFixture(t,"workbuddy",{semantic,command});
  if(readyForReview){await f.finish();f.review();}
  const env={WORKBUDDY_DESKTOP_DISPATCH_ENABLED:"1",WORKBUDDY_DESKTOP_STATE_DIR:path.join(f.root,"desktop-controls"),WORKBUDDY_DSH_ENABLED:"0"};
  const journal=desktopControlJournal(f.config,env);
  const session=new DesktopControlSession({inspect:(taskId,kind)=>inspectDesktopControl(f.config,taskId,kind,env),enqueue:async draft=>journal.enqueue(draft),receipt:id=>journal.receipt(id),forAttempt:(taskId,attemptId)=>journal.forAttempt(taskId,attemptId)});
  return {...f,env,controlJournal:journal,session};
}
test("desktop cancellation persists one original request and does not create another attempt",async t=>{
  const f=await setup(t),task=f.current();
  const preview=await f.session.preview({kind:"cancel",taskId:task.taskId,attemptId:task.attemptId,revision:task.revision,feedback:null,reviewId:null,inspectionFiles:null,semanticChecks:null});
  const receipt=await f.session.commit(preview.draft.requestId,preview.digest);
  await runDesktopControlWorker(f.config,receipt.requestId,f.env);
  assert.equal(f.controlJournal.receipt(receipt.requestId)?.state,"succeeded");
  assert.equal(f.current().state,"cancelled");assert.equal(f.store.listAttempts(task.taskId).length,1);
  await runDesktopControlWorker(f.config,receipt.requestId,f.env);
  assert.equal(f.store.listAttempts(task.taskId).length,1);
});
test("desktop cancellation with a stale revision rejects without cancelling",async t=>{
  const f=await setup(t),task=f.current();
  const preview=await f.session.preview({kind:"cancel",taskId:task.taskId,attemptId:task.attemptId,revision:task.revision,feedback:null,reviewId:null,inspectionFiles:null,semanticChecks:null});
  const receipt=await f.session.commit(preview.draft.requestId,preview.digest);
  f.store.update(task.taskId,{blockingReason:"Concurrent change "+crypto.randomUUID()});
  await runDesktopControlWorker(f.config,receipt.requestId,f.env);
  assert.equal(f.controlJournal.receipt(receipt.requestId)?.state,"rejected");
  assert.notEqual(f.current().state,"cancelled");assert.equal(f.journal().cancellationRequested(),false);
});
test("an expired confirmed request cannot start a delayed effect",async t=>{
  const f=await setup(t),task=f.current();
  const preview=await f.session.preview({kind:"cancel",taskId:task.taskId,attemptId:task.attemptId,revision:task.revision,feedback:null,reviewId:null,inspectionFiles:null,semanticChecks:null});
  const expired={...preview.draft,expiresAt:new Date(Date.now()-1000).toISOString()};
  f.controlJournal.enqueue(expired);
  await runDesktopControlWorker(f.config,expired.requestId,f.env);
  assert.equal(f.controlJournal.receipt(expired.requestId)?.code,"DRAFT_EXPIRED");
  assert.notEqual(f.current().state,"cancelled");assert.equal(f.journal().cancellationRequested(),false);
});
test("desktop acceptance uses an existing independent review and survives a repeated worker invocation",async t=>{
  const f=await setup(t,true),task=f.current(),review=f.service.listReviews(task.taskId).at(-1)!;
  const preview=await f.session.preview({kind:"accept",taskId:task.taskId,attemptId:task.attemptId,revision:task.revision,feedback:null,reviewId:review.reviewId,inspectionFiles:null,semanticChecks:null});
  const receipt=await f.session.commit(preview.draft.requestId,preview.digest);
  await runDesktopControlWorker(f.config,receipt.requestId,f.env);
  assert.equal(f.controlJournal.receipt(receipt.requestId)?.state,"succeeded");assert.equal(f.current().state,"accepted");
  await runDesktopControlWorker(f.config,receipt.requestId,f.env);
  assert.equal(f.store.listTaskEvents(task.taskId).events.filter(event=>event.type==="task_closed").length,1);
});
test("desktop independent review records the user's real file inspection before explicit acceptance",async t=>{
  const f=await setup(t,false,true);await f.finish();
  const task=f.current(),terms=await f.session.requirements({taskId:task.taskId,attemptId:task.attemptId,revision:task.revision});
  assert.deepEqual(terms.requirements.map(check=>check.id),["behavior"]);
  const preview=await f.session.preview({kind:"review",taskId:task.taskId,attemptId:task.attemptId,revision:task.revision,feedback:"Read the actual source and checked the original behavior.",reviewId:null,inspectionFiles:[f.source],semanticChecks:[{checkId:"behavior",status:"passed"}]});
  const receipt=await f.session.commit(preview.draft.requestId,preview.digest);
  await runDesktopControlWorker(f.config,receipt.requestId,f.env);
  assert.equal(f.controlJournal.receipt(receipt.requestId)?.state,"succeeded");
  assert.equal(f.current().state,"needs_review","review is not final acceptance");
  const review=f.service.listReviews(task.taskId).at(-1)!;
  assert.ok(review.checks.some(check=>check.checkId==="behavior"&&check.actor==="independent_reviewer"&&check.status==="passed"));
  const current=f.current(),accept=await f.session.preview({kind:"accept",taskId:current.taskId,attemptId:current.attemptId,revision:current.revision,feedback:null,reviewId:review.reviewId,inspectionFiles:null,semanticChecks:null});
  const accepted=await f.session.commit(accept.draft.requestId,accept.digest);await runDesktopControlWorker(f.config,accepted.requestId,f.env);
  assert.equal(f.controlJournal.receipt(accepted.requestId)?.state,"succeeded");assert.equal(f.current().state,"accepted");
});
test("failed independent semantic review is preserved and cannot be accepted",async t=>{
  const f=await setup(t,false,true);await f.finish();const task=f.current();
  const preview=await f.session.preview({kind:"review",taskId:task.taskId,attemptId:task.attemptId,revision:task.revision,feedback:"The independently inspected behavior fails.",reviewId:null,inspectionFiles:[f.source],semanticChecks:[{checkId:"behavior",status:"failed"}]});
  const receipt=await f.session.commit(preview.draft.requestId,preview.digest);await runDesktopControlWorker(f.config,receipt.requestId,f.env);
  assert.equal(f.controlJournal.receipt(receipt.requestId)?.state,"succeeded");
  const review=f.service.listReviews(task.taskId).at(-1)!;assert.equal(review.checks.find(check=>check.checkId==="behavior")?.status,"failed");
  const current=f.current();await assert.rejects(()=>f.session.preview({kind:"accept",taskId:current.taskId,attemptId:current.attemptId,revision:current.revision,feedback:null,reviewId:review.reviewId,inspectionFiles:null,semanticChecks:null}),{code:"ACTION_UNAVAILABLE"});
  assert.equal(f.current().state,"needs_review");
});
test("a rejected inspection permits an explicit corrected review without hiding saved checks",async t=>{
  const f=await setup(t,false,true);await f.finish();const task=f.current();
  const preview=await f.session.preview({kind:"review",taskId:task.taskId,attemptId:task.attemptId,revision:task.revision,feedback:"Inspect the selected file.",reviewId:null,inspectionFiles:[path.join(f.root,"outside-scope.js")],semanticChecks:[{checkId:"behavior",status:"passed"}]});
  const receipt=await f.session.commit(preview.draft.requestId,preview.digest);await runDesktopControlWorker(f.config,receipt.requestId,f.env);
  assert.equal(f.controlJournal.receipt(receipt.requestId)?.state,"rejected");assert.equal(f.service.listReviews(task.taskId).length,0);
  const current=f.current(),retry=await f.session.preview({kind:"review",taskId:current.taskId,attemptId:current.attemptId,revision:current.revision,feedback:"Inspected the source.",reviewId:null,inspectionFiles:[f.source],semanticChecks:[{checkId:"behavior",status:"passed"}]});
  const corrected=await f.session.commit(retry.draft.requestId,retry.digest);await runDesktopControlWorker(f.config,corrected.requestId,f.env);
  assert.equal(f.controlJournal.receipt(corrected.requestId)?.state,"succeeded");assert.equal(f.service.listReviews(task.taskId).length,1);
});
test("desktop review executes only the original command and binds it to the current review",async t=>{
  const f=await setup(t,false,true,true);await f.finish();const task=f.current();
  const preview=await f.session.preview({kind:"review",taskId:task.taskId,attemptId:task.attemptId,revision:task.revision,feedback:"Read the source and checked the original behavior.",reviewId:null,inspectionFiles:[f.source],semanticChecks:[{checkId:"behavior",status:"passed"}]});
  const receipt=await f.session.commit(preview.draft.requestId,preview.digest);await runDesktopControlWorker(f.config,receipt.requestId,f.env);
  assert.equal(f.controlJournal.receipt(receipt.requestId)?.state,"succeeded");
  const review=f.service.listReviews(task.taskId).at(-1)!;
  assert.ok(review.checks.some(check=>check.checkId==="test"&&check.kind==="command"&&check.actor==="program"&&check.status==="passed"));
  assert.ok(review.checks.some(check=>check.checkId==="behavior"&&check.actor==="independent_reviewer"));
});
test("confirmed desktop rework retains the original model and task, and a replay cannot start another round",async t=>{
  const f=await setup(t,false,true);await f.finish();
  const inspect=async()=>{
    const task=f.current(),status=f.service.statusView(task),contract=f.store.getContract(task.taskId);
    if(contract.state!=="found")throw Error("Fixture contract missing");
    return {taskId:task.taskId,attemptId:task.attemptId!,revision:task.revision!,title:contract.record.contract.title,workspace:task.workspace!,allowedActions:status.allowedActions,remoteStopped:status.remoteStopped,model:"synthetic-user-choice",rate:"x0.00",executorId:"workbuddy",connectionId:"local-workbuddy",providerId:"workbuddy-native",reasoningEffort:null,attempt:task.attempt!,attemptLimit:contract.record.effectiveMaxAttempts,currentReviewId:null,requirements:contract.record.contract.requiredChecks};
  };
  const session=new DesktopControlSession({inspect,enqueue:async draft=>f.controlJournal.enqueue(draft),receipt:id=>f.controlJournal.receipt(id),forAttempt:(taskId,attemptId)=>f.controlJournal.forAttempt(taskId,attemptId)});
  const original=f.current();
  const preview=await session.preview({kind:"rework",taskId:original.taskId,attemptId:original.attemptId,revision:original.revision,feedback:"Correct the synthetic issue.",reviewId:null,inspectionFiles:null,semanticChecks:null});
  const receipt=await session.commit(preview.draft.requestId,preview.digest);
  const hooks={inspect,serviceFor:()=>({coordinator:f.wb,service:f.service})};
  await runDesktopControlWorker(f.config,receipt.requestId,f.env,hooks);
  assert.equal(f.controlJournal.receipt(receipt.requestId)?.state,"succeeded");
  assert.equal(f.current().taskId,original.taskId);assert.notEqual(f.current().attemptId,original.attemptId);
  assert.equal(f.current().attempt,2);assert.equal(f.journal().request().model,"synthetic-user-choice");
  await runDesktopControlWorker(f.config,receipt.requestId,f.env,hooks);
  assert.equal(f.store.listAttempts(original.taskId).length,2);
});
