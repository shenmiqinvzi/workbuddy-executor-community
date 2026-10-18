import type { StoredTask } from "./task-store.js";
import type { LocalMessage } from "./workbuddy-client.js";

export function progressDelta(task:StoredTask,messages:LocalMessage[],sinceEventSeq=0) {
  const updates=messages.filter(m=>m.metadata?.attemptId===task.attemptId && Number(m.metadata?.eventSeq)>sinceEventSeq);
  return {attemptId:task.attemptId,sinceEventSeq,lastEventSeq:task.lastEventSeq??0,changed:updates.length>0,
    updates:updates.slice(-5).map(m=>({seq:m.metadata?.eventSeq,kind:m.metadata?.type,text:m.content.map(p=>typeof p==="string"?p:JSON.stringify(p)).join("").slice(0,1000)}))};
}
