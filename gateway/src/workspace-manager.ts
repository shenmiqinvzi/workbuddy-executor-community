import { AdmissionError } from "./collaboration.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { NativeDesktopRpcTrigger } from "./native-desktop-trigger.js";
import { readServiceRegistration, registeredServiceConfig } from "./persistent-service.js";
import { installService } from "./service-cli.js";
import { WorkspaceWorkers, readWorkspaceWorkers } from "./workspace-workers.js";
import { readDesktopSession } from "./desktop-runtime.js";
import { TaskStore } from "./task-store.js";
import { RunJournal, runsDirectory, hasNativeStopEvidence } from "./run-journal.js";
import fs from "node:fs";

/** The auto-start entry is a convenience, never part of the dispatch effect
 * boundary: a login-item or profile failure must not turn an already prepared
 * native session into an unknown outcome. */
export type AutostartAttempt = { installed: boolean; reused: boolean; error?: string; startupWarning?: string };
export function installAutostartIfNeeded(registration: unknown, install: () => void): AutostartAttempt {
  if (registration) return { installed: false, reused: true };
  try { install(); return { installed: true, reused: false }; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return { installed: false, reused: false, error: `${code ?? (error as Error)?.name ?? "Error"}: ${String((error as Error)?.message ?? error)}` };
  }
}
export function workerRegistration(config: Config) {
  const file = config.serviceConfigFile??path.join(path.dirname(config.dbFile),"persistent-service.json");
  const registration = readServiceRegistration(file);
  // A registration written by another data directory is a configuration mistake the
  // caller can fix, so it must arrive as its own code with both paths named. A plain
  // Error would be flattened into OPERATION_FAILED, leaving the operator with no clue.
  if(registration && path.resolve(registration.dbFile)!==path.resolve(config.dbFile))throw new AdmissionError("BRIDGE_DATABASE_MISMATCH", `The persistent service registered for ${path.resolve(registration.dbFile)} is not the database this process uses (${path.resolve(config.dbFile)}); fix ${file} or point WORKBUDDY_SERVICE_CONFIG at the registration that belongs to this data directory`);
  return registration;
}
export async function ensureWorkspace(config: Config, input: {workspace:string;sessionId?:string;title?:string;model?:string;workerKey?:string;admissionTaskId?:string;admissionOperationId?:string}) {
  if(config.backend!=="desktop-queue")throw new Error("Automatic native workspaces require desktop-queue");
  const target = { taskId: input.admissionTaskId ?? "", workspace: input.workspace, sessionId: input.sessionId ?? null, model: input.model ?? "", workerKey: input.workerKey ?? null, title: input.title ?? null };
  // The registration pairs the persistent native service with this task database.
  // Resolving it before the preparation boundary keeps a fixable configuration
  // mistake in front of the native adapter instead of after it (FC11-D1/D2).
  const registration=workerRegistration(config);
  const gate = new TaskStore(config.dbFile);
  try {
    if (!input.admissionTaskId) throw new AdmissionError("OPERATION_REQUIRED", "Use a durable authorized task operation for native workspace preparation.");
    gate.operations.preparationBoundary(input.admissionOperationId, target, undefined, true);
    gate.workspaceProtection.verifyPreparation(input.admissionTaskId, input.workspace);
  } finally { gate.close(); }
  if(process.env.WORKBUDDY_REQUIRED_FREE_MODEL&&!input.model)input={...input,model:process.env.WORKBUDDY_REQUIRED_FREE_MODEL};
  const bound=registration?registeredServiceConfig(config,registration):config;
  const workers=new WorkspaceWorkers(bound);
  const trigger=new NativeDesktopRpcTrigger(bound,registration?.cdpPort??18491);
  try {
    if(registration)workers.seed(registration);
    const result=await workers.ensure(input,{
      createWorker:(...args)=>{
        const gate = new TaskStore(bound.dbFile);
        try { gate.operations.preparationBoundary(input.admissionOperationId, target, args[1]); } finally { gate.close(); }
        return trigger.createWorker(...args);
      },
      async setModel(sessionId,model){
        // Configuration must not change the model underneath queued or unclosed attempts.
        const store=new TaskStore(bound.dbFile);
        try {
          store.operations.preparationBoundary(input.admissionOperationId, target, sessionId);
          for(let offset=0;;offset+=500){
            const tasks=store.listTasks({limit:500,offset});
            for(const task of tasks){
              if(task.sessionId!==sessionId||!task.attemptId)continue;
              const journal=new RunJournal(runsDirectory(bound),task.attemptId),snapshot=journal.snapshot();
              if(snapshot&&(['queued','working'].includes(snapshot.status)||(!hasNativeStopEvidence(snapshot)&&['claim.json','wake.json'].some(file=>fs.existsSync(path.join(journal.dir,file))))))throw new Error('The session has queued or unfinished tasks; wait before changing its bound model, or bind another idle session');
            }
            if(tasks.length<500)break;
          }
        } finally {store.close();}
        return trigger.setModel(sessionId,model);
      },
    },{
      // The reserved identity is written before the native call. A preparation cut
      // off by a client timeout then still names exactly one session, so its
      // native existence can be observed instead of guessed at.
      onReserved(sessionId){
        const identity=new TaskStore(bound.dbFile);
        try { identity.operations.preparationIdentity(input.admissionOperationId, sessionId); } finally { identity.close(); }
      },
    });
    let startupWarning: string | undefined;
    const persistentService = installAutostartIfNeeded(registration, () => {
      const projectDir=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
      const installed=installService({config,projectDir,workspace:result.worker.workspace,sessionId:result.worker.sessionId,cdpPort:18491});
      startupWarning=installed.startupWarning;
    });
    if (startupWarning) persistentService.startupWarning=startupWarning;
    if (persistentService.error && process.env.WORKBUDDY_WORKBENCH_DIAGNOSTICS === "1") console.error("[workspace] auto-start not installed: " + persistentService.error);
    return {ok:true,...result,workspace:result.worker.workspace,sessionId:result.worker.sessionId,persistentService,next:"Pass this workspace to send_task; the persistent service routes and wakes its native WorkBuddy session automatically."};
  } finally {workers.close();trigger.close();}
}
export async function listModels(config:Config,sessionId?:string){
  if(config.backend!=="desktop-queue")throw new Error("Native model discovery requires desktop-queue");
  const registration=workerRegistration(config),bound=registration?registeredServiceConfig(config,registration):config;
  const trigger=new NativeDesktopRpcTrigger(bound,registration?.cdpPort??18491);
  try{return {ok:true,...await trigger.listModels(sessionId)};}finally{trigger.close();}
}
export function listWorkspaces(config: Config) {
  const registration=workerRegistration(config);
  const bound=registration?registeredServiceConfig(config,registration):config;
  return readWorkspaceWorkers(bound,registration).map(worker=>({...worker,desktopRegistered:readDesktopSession(bound.workbuddyConfigDir,worker.sessionId).registered}));
}
