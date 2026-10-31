import assert from "node:assert/strict";
import test from "node:test";
import { DesktopControlSession, type DesktopControlSnapshot } from "../src/desktop-control.js";
import type { DesktopControlDraft, DesktopControlReceipt } from "../src/desktop-control-journal.js";

function fixture() {
  let snapshot:DesktopControlSnapshot={taskId:"task",attemptId:"attempt",revision:"revision",title:"Example",workspace:"project",allowedActions:["cancel","rework","review","accept"],remoteStopped:true,model:"model-a",rate:"x0.00",executorId:"workbuddy",connectionId:"local",providerId:"native",reasoningEffort:null,attempt:1,attemptLimit:2,currentReviewId:"review-1",requirements:[{id:"semantic-1",kind:"semantic",definition:"Keep behavior"}]};
  const sent:DesktopControlDraft[]=[];
  const session=new DesktopControlSession({inspect:async()=>structuredClone(snapshot),enqueue:async draft=>{sent.push(draft);return {requestId:draft.requestId,operationId:draft.operationId,kind:draft.kind,taskId:draft.taskId,attemptId:draft.attemptId,revision:draft.revision,state:"requested"} satisfies DesktopControlReceipt;},receipt:()=>null,forAttempt:()=>[]});
  const input={kind:"rework",taskId:"task",attemptId:"attempt",revision:"revision",feedback:"Fix the boundary",reviewId:null,inspectionFiles:null,semanticChecks:null};
  return {session,input,sent,update:(patch:Partial<DesktopControlSnapshot>)=>snapshot={...snapshot,...patch}};
}
test("desktop control previews never perform an effect; confirmation binds exact terms",async()=>{
  const f=fixture(), preview=await f.session.preview(f.input);
  assert.equal(f.sent.length,0);
  assert.throws(()=>f.session.review(preview.draft.requestId,"different"),{code:"DRAFT_CHANGED"});
  const [first,second]=await Promise.all([f.session.commit(preview.draft.requestId,preview.digest),f.session.commit(preview.draft.requestId,preview.digest)]);
  assert.equal(f.sent.length,1);assert.deepEqual(first,second);assert.equal(f.sent[0].parameters.feedback,"Fix the boundary");
});
test("desktop control refuses stale attempts, changed rates, missing stop proof and changed review",async()=>{
  const f=fixture();let preview=await f.session.preview(f.input);
  f.update({revision:"new"});await assert.rejects(()=>f.session.commit(preview.draft.requestId,preview.digest),{code:"STALE_REVISION"});
  f.update({revision:"revision"});preview=await f.session.preview(f.input);f.update({rate:"x0.50"});
  await assert.rejects(()=>f.session.commit(preview.draft.requestId,preview.digest),{code:"QUOTE_CHANGED"});
  f.update({remoteStopped:false});await assert.rejects(()=>f.session.preview(f.input),{code:"STOP_UNCONFIRMED"});
  f.update({remoteStopped:true});await assert.rejects(()=>f.session.preview({...f.input,kind:"accept",feedback:null,reviewId:"old-review"}),{code:"REVIEW_REQUIRED"});
  assert.equal(f.sent.length,0);
});
test("independent review requires all original semantic decisions and actual inspection files",async()=>{
  const f=fixture(),base={...f.input,kind:"review",feedback:"Read the actual source.",inspectionFiles:["src/file.js"],semanticChecks:[{checkId:"semantic-1",status:"failed"}]};
  const terms=await f.session.requirements({taskId:"task",attemptId:"attempt",revision:"revision"});
  assert.deepEqual(terms.requirements.map(check=>check.id),["semantic-1"]);
  await assert.rejects(()=>f.session.preview({...base,inspectionFiles:[]}),{code:"INVALID_REQUEST"});
  await assert.rejects(()=>f.session.preview({...base,semanticChecks:[{checkId:"other",status:"passed"}]}),{code:"INVALID_REQUEST"});
  await assert.rejects(()=>f.session.preview({...base,semanticChecks:[{checkId:"semantic-1",status:"fabricated"}]}),{code:"INVALID_REQUEST"});
  const preview=await f.session.preview(base);assert.deepEqual(preview.draft.parameters.semanticChecks,[{checkId:"semantic-1",status:"failed"}]);
  f.update({requirements:[{id:"semantic-1",kind:"semantic",definition:"Changed requirement"}]});
  await assert.rejects(()=>f.session.commit(preview.draft.requestId,preview.digest),{code:"CONTRACT_INTEGRITY"});assert.equal(f.sent.length,0);
});
