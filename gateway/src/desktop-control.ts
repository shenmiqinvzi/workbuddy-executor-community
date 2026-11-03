import crypto from "node:crypto";
import { AdmissionError } from "./collaboration.js";
import { desktopExact } from "./desktop-dispatch.js";
import type { DesktopControlDraft, DesktopControlKind, DesktopControlReceipt } from "./desktop-control-journal.js";

export interface DesktopControlSnapshot {
  taskId: string; attemptId: string; revision: string; title: string; workspace: string;
  allowedActions: DesktopControlKind[]; remoteStopped: boolean;
  model: string | null; rate: string | null; attempt: number; attemptLimit: number;
  executorId: string; connectionId: string; providerId: string; reasoningEffort: string | null;
  currentReviewId: string | null;
  requirements: Array<{id:string;kind:"command"|"semantic";definition:string}>;
}
export interface DesktopControlPreview {
  draft: DesktopControlDraft; digest: string; expiresAt: string; snapshot: DesktopControlSnapshot;
}
export interface DesktopControlDependencies {
  inspect(taskId: string, kind: DesktopControlKind): Promise<DesktopControlSnapshot>;
  enqueue(draft: DesktopControlDraft): Promise<DesktopControlReceipt>;
  receipt(requestId: string): DesktopControlReceipt | null;
  forAttempt(taskId: string, attemptId: string): DesktopControlReceipt[];
  observe?(taskId: string, attemptId: string): Promise<{taskId:string;attemptId:string}>;
  now?: () => number;
}
const hash=(value: unknown)=>crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=(code:string,message:string):never=>{throw new AdmissionError(code,message);};
function value(input:unknown,max:number):string {
  if(typeof input!=="string"||!input.trim()||input.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input)) return fail("INVALID_REQUEST","请填写有效的任务操作内容。");
  return input.trim();
}

/** Only the native host may commit a preview. A page can request and inspect a
 * proposal but cannot change it after the native confirmation is displayed. */
export class DesktopControlSession {
  private readonly previews=new Map<string,DesktopControlPreview>();
  private readonly commits=new Map<string,Promise<DesktopControlReceipt>>();
  private readonly now:()=>number;
  constructor(private readonly dependencies:DesktopControlDependencies) {this.now=dependencies.now??Date.now;}
  async preview(input:unknown):Promise<DesktopControlPreview> {
    desktopExact(input,["kind","taskId","attemptId","revision","feedback","reviewId","inspectionFiles","semanticChecks"]);
    const kind=value(input.kind,20) as DesktopControlKind;
    if(!["cancel","rework","review","accept"].includes(kind))return fail("INVALID_REQUEST","不支持此任务操作。");
    const taskId=value(input.taskId,200),attemptId=value(input.attemptId,200),revision=value(input.revision,200);
    const feedback=input.feedback===null?null:value(input.feedback,4000),reviewId=input.reviewId===null?null:value(input.reviewId,200);
    if((kind==="rework"||kind==="review")?!feedback:feedback!==null)return fail("INVALID_REQUEST","请填写具体返工要求或独立审查说明。");
    if(kind==="accept"?!reviewId:reviewId!==null)return fail("INVALID_REQUEST","最终验收需要当前审查记录。");
    const snapshot=await this.dependencies.inspect(taskId,kind);
    this.assertCurrent(snapshot,{kind,taskId,attemptId,revision,feedback,reviewId});
    let inspectionFiles:string[]|null=null,semanticChecks:Array<{checkId:string;status:string}>|null=null;
    if(kind==="review") {
      if(!Array.isArray(input.inspectionFiles)||input.inspectionFiles.length>100||!Array.isArray(input.semanticChecks)||input.semanticChecks.length>100)return fail("INVALID_REQUEST","请填写有界的检查文件和验收结果。");
      inspectionFiles=input.inspectionFiles.map(file=>value(file,2000));
      semanticChecks=input.semanticChecks.map(check=>{desktopExact(check,["checkId","status"]);const checkId=value(check.checkId,100),status=value(check.status,20);if(!["passed","failed","unknown"].includes(status))return fail("INVALID_REQUEST","请选择每项验收的实际结果。");return {checkId,status};});
      const expected=snapshot.requirements.filter(check=>check.kind==="semantic").map(check=>check.id).sort();
      if(JSON.stringify(semanticChecks.map(check=>check.checkId).sort())!==JSON.stringify(expected)||(expected.length&&!inspectionFiles.length))return fail("INVALID_REQUEST","请逐项判断原验收要求，并填写实际检查的文件。");
    } else if(input.inspectionFiles!==null||input.semanticChecks!==null)return fail("INVALID_REQUEST","此操作不接受审查文件或验收结果。");
    const createdAt=this.now(),expiresAt=new Date(createdAt+300_000).toISOString();
    const draft:DesktopControlDraft={requestId:crypto.randomUUID(),operationId:"desktop-"+kind+"-"+crypto.randomUUID(),kind,taskId,attemptId,revision,
      parameters:{feedback,reviewId,inspectionFiles,semanticChecks,requirements:snapshot.requirements,model:snapshot.model,rate:snapshot.rate,executorId:snapshot.executorId,connectionId:snapshot.connectionId,providerId:snapshot.providerId,reasoningEffort:snapshot.reasoningEffort},createdAt:new Date(createdAt).toISOString(),expiresAt};
    const item={draft,snapshot:structuredClone(snapshot),expiresAt};
    const preview={...item,digest:hash(item)};
    if(this.previews.size>=16)this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(draft.requestId,preview);
    return structuredClone(preview);
  }
  review(requestId:string,digest:string):DesktopControlPreview {
    const preview=this.previews.get(requestId);
    if(!preview||preview.digest!==digest)return fail("DRAFT_CHANGED","操作确认已失效，请重新核对。");
    if(Date.parse(preview.expiresAt)<=this.now())return fail("DRAFT_EXPIRED","确认时间已过，请重新核对。");
    return structuredClone(preview);
  }
  commit(requestId:string,digest:string):Promise<DesktopControlReceipt> {
    const preview=this.review(requestId,digest);
    const existing=this.commits.get(requestId);if(existing)return existing;
    const promise=this.commitOnce(preview);this.commits.set(requestId,promise);return promise;
  }
  private async commitOnce(preview:DesktopControlPreview) {
    const current=await this.dependencies.inspect(preview.draft.taskId,preview.draft.kind);
    this.assertCurrent(current,{...preview.draft,feedback:preview.draft.parameters.feedback as string|null,reviewId:preview.draft.parameters.reviewId as string|null});
    if(preview.draft.kind==="review"&&hash(current.requirements)!==hash(preview.snapshot.requirements))return fail("CONTRACT_INTEGRITY","原验收要求已变化，请重新核对。");
    if(preview.draft.kind==="rework"&&(["model","rate","executorId","connectionId","providerId","reasoningEffort"] as const).some(key=>current[key]!==preview.snapshot[key]))return fail("QUOTE_CHANGED","原模型、来源或观察费率已变化，请重新核对。");
    if(Date.parse(preview.expiresAt)<=this.now())return fail("DRAFT_EXPIRED","确认时间已过，请重新核对。");
    return this.dependencies.enqueue(preview.draft);
  }
  receipt(requestId:string) {return this.dependencies.receipt(requestId);}
  forAttempt(taskId:string,attemptId:string) {return this.dependencies.forAttempt(taskId,attemptId);}
  async requirements(input:unknown) {
    desktopExact(input,["taskId","attemptId","revision"]);
    const taskId=value(input.taskId,200),attemptId=value(input.attemptId,200),revision=value(input.revision,200);
    const snapshot=await this.dependencies.inspect(taskId,"review");
    this.assertCurrent(snapshot,{kind:"review",taskId,attemptId,revision,feedback:null,reviewId:null});
    return snapshot;
  }
  observe(taskId:string,attemptId:string) {
    value(taskId,200);value(attemptId,200);
    if(!this.dependencies.observe)return fail("ACTION_UNAVAILABLE","当前安装不能更新执行状态。");
    return this.dependencies.observe(taskId,attemptId);
  }
  private assertCurrent(snapshot:DesktopControlSnapshot,request:{kind:DesktopControlKind;taskId:string;attemptId:string;revision:string;feedback:string|null;reviewId:string|null}) {
    if(snapshot.taskId!==request.taskId||snapshot.attemptId!==request.attemptId)return fail("STALE_ATTEMPT","任务已进入其他轮次，请刷新。");
    if(snapshot.revision!==request.revision)return fail("STALE_REVISION","任务状态已变化，请刷新后重新核对。");
    if(!snapshot.allowedActions.includes(request.kind))return fail("ACTION_UNAVAILABLE","当前任务状态不允许此操作，请刷新并查看停止与验收状态。");
    if(request.kind!=="cancel"&&!snapshot.remoteStopped)return fail("STOP_UNCONFIRMED","原生执行尚未确认停止。");
    if(request.kind==="rework"&&(!snapshot.model||snapshot.attempt>=snapshot.attemptLimit))return fail("BUDGET_EXCEEDED","原模型或剩余轮次无法核实。");
    if(request.kind==="accept"&&snapshot.currentReviewId!==request.reviewId)return fail("REVIEW_REQUIRED","审查记录已变化，请重新核对。");
  }
}
