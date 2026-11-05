import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hasNativeStopEvidence } from "./run-journal.js";

/** Refuse installation/service changes while any saved workflow is unclosed or unproven. */
export function assertTaskRecordsStopped(dbFile: string, runsDir = path.join(path.dirname(dbFile),"runs")) {
  if (!fs.existsSync(dbFile)) return;
  let db: DatabaseSync | undefined;
  try {
    try { db=new DatabaseSync(dbFile,{readOnly:true}); } catch(error) {
      throw new Error(`Task records are unreadable; installation was left unchanged. ${(error as Error).message}`);
    }
    for(const row of db.prepare("SELECT state, attempt_id FROM tasks").all()){
      if(row.state==="accepted")continue;
      if(["queued","working","completed","needs_review"].includes(String(row.state)))throw new Error("Unclosed tasks exist; finish or explicitly end them before changing this installation.");
      if(!row.attempt_id||!/^run-[a-f0-9-]{36}$/.test(String(row.attempt_id)))throw new Error("Task stop evidence is unavailable; inspect the original task first.");
      // A missing journal is unknown state, not an idle installation: refuse.
      let state: Parameters<typeof hasNativeStopEvidence>[0];
      try { state=JSON.parse(fs.readFileSync(path.join(runsDir,String(row.attempt_id),"state.json"),"utf8")); }
      catch(error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Native stopping is unconfirmed; installation was left unchanged.");
        throw new Error(`Task stop evidence is unreadable; installation was left unchanged. ${(error as Error).message}`);
      }
      if(!hasNativeStopEvidence(state))throw new Error("Native stopping is unconfirmed; installation was left unchanged.");
    }
  }finally{db?.close();}
}
