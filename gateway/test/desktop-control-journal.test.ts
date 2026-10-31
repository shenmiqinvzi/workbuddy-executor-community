import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DesktopControlJournal, type DesktopControlDraft } from "../src/desktop-control-journal.js";

function fixture(t: test.TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"desktop-control-test-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,"private","controls.sqlite");
  const draft: DesktopControlDraft={requestId:crypto.randomUUID(),operationId:"stop-"+crypto.randomUUID(),kind:"cancel",taskId:"task-one",attemptId:"run-one",revision:"revision-one",parameters:{reason:"stop"},createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300_000).toISOString()};
  return {file,draft,first:new DesktopControlJournal(file),second:new DesktopControlJournal(file)};
}
test("desktop controls preserve one original request and never replay a claimed effect",t=>{
  const {file,draft,first,second}=fixture(t);
  assert.equal(first.receipt(draft.requestId),null);
  assert.equal(fs.existsSync(file),false,"a read must not create a state store");
  assert.equal(first.enqueue(draft).state,"requested");
  assert.deepEqual(second.enqueue(draft),first.receipt(draft.requestId));
  assert.throws(()=>second.enqueue({...draft,parameters:{reason:"changed"}}),{code:"CONTROL_CONFLICT"});
  assert.throws(()=>second.enqueue({...draft,requestId:crypto.randomUUID(),operationId:"another"}),{code:"CONTROL_ALREADY_EXISTS"});
  assert.deepEqual(first.claim(draft.requestId),draft);
  assert.equal(second.claim(draft.requestId),null,"another process must not reclaim an effect");
  assert.equal(second.receipt(draft.requestId)?.state,"started");
  first.finish(draft.requestId,"outcome_unknown","OUTCOME_UNKNOWN","Inspect the original task.");
  second.finish(draft.requestId,"succeeded");
  assert.equal(second.receipt(draft.requestId)?.state,"outcome_unknown");
  assert.equal(second.claim(draft.requestId),null,"unknown effects are not automatically retried");
});
test("an explicitly rejected request can be replaced and tampered receipts are refused",t=>{
  const {file,draft,first,second}=fixture(t);
  first.enqueue(draft);first.claim(draft.requestId);first.finish(draft.requestId,"rejected","STALE_REVISION","Refresh before retrying.");
  const replacement={...draft,requestId:crypto.randomUUID(),operationId:"stop-"+crypto.randomUUID(),revision:"new-revision"};
  assert.equal(second.enqueue(replacement).state,"requested");
  assert.equal(second.forAttempt(draft.taskId,draft.attemptId).length,2);
  const db=new DatabaseSync(file);db.prepare("UPDATE desktop_control_requests SET body=? WHERE request_id=?").run('{}',replacement.requestId);db.close();
  assert.throws(()=>first.receipt(replacement.requestId),/integrity/);
  assert.throws(()=>first.claim(replacement.requestId),/integrity/);
});
test("a later revision may receive another review while unresolved actions remain fenced",t=>{
  const {draft,first,second}=fixture(t);
  const review={...draft,kind:"review" as const};first.enqueue(review);first.claim(review.requestId);first.finish(review.requestId,"succeeded");
  const later={...review,requestId:crypto.randomUUID(),operationId:"review-"+crypto.randomUUID(),revision:"revision-two"};
  assert.equal(second.enqueue(later).state,"requested");
  assert.throws(()=>second.enqueue({...later,requestId:crypto.randomUUID(),operationId:"duplicate"}),{code:"CONTROL_ALREADY_EXISTS"});
  assert.throws(()=>second.enqueue({...later,requestId:crypto.randomUUID(),operationId:"other-revision",revision:"revision-three"}),{code:"CONTROL_ALREADY_EXISTS"},"unresolved review remains fenced across revisions");
});
