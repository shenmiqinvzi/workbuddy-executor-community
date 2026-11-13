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
/**
 * The single configuration a dispatch will read for one already prepared session.
 *
 * Preparation binds to the persistent service's registration (`registeredServiceConfig`),
 * while a dispatch reads this process's own WorkBuddy directory. When those two name
 * different directories the same task would be prepared against one native history and
 * dispatched against another, so the disagreement is refused here — before an attempt
 * exists — instead of surfacing as a blocked attempt after the native boundary. The
 * native registration of the session is checked in the same place for the same reason:
 * a missing, unreadable or session-less history can never become a dispatchable route.
 */
export function assertDispatchConfiguration(config: Config, sessionId: string): void {
  // Read the registration without judging it first: a registration that belongs to
  // another data directory says nothing about a session this one never prepared, and
  // treating it as a mismatch here would refuse sessions that route fine today.
  const registration = readServiceRegistration(config.serviceConfigFile ?? path.join(path.dirname(config.dbFile), "persistent-service.json"));
  const preparedHere = registration?.sessionId === sessionId || readWorkspaceWorkers(config).some(worker => worker.sessionId === sessionId);
  if (!preparedHere) return;
  // Only a governed session has to agree with its registration: the same database,
  // the same WorkBuddy directory, and a native history that still knows the session.
  workerRegistration(config);
  const configured = path.resolve(config.workbuddyConfigDir);
  if (registration) {
    const bound = path.resolve(registeredServiceConfig(config, registration).workbuddyConfigDir);
    if (bound !== configured) throw new AdmissionError("BRIDGE_CONFIG_MISMATCH", `The persistent service reads WorkBuddy history from ${bound}, but this process is configured for ${configured}. Preparation would bind ${bound} while the dispatch would read ${configured}; set WORKBUDDY_CONFIG_DIR to ${bound} (or rewrite the registration for this data directory) before dispatching again.`);
  }
  const evidence = readDesktopSession(configured, sessionId);
  if (evidence.state === "unverifiable") throw new AdmissionError("BRIDGE_HISTORY_UNREADABLE", `The WorkBuddy desktop history at ${configured} could not be read (${evidence.reason}); the attempt was not started. Fix WORKBUDDY_CONFIG_DIR or the desktop profile, then retry the same task.`);
  if (!evidence.registered) throw new AdmissionError("BRIDGE_SESSION_ABSENT", `WorkBuddy session ${sessionId} is not registered in ${configured}; the desktop service cannot route to it. Reopen that session, or prepare a workspace for this data directory, before retrying.`);
}
export async function ensureWorkspace(config: Config, input: {workspace:string;sessionId?:string;title?:string;model?:string;workerKey?:string;admissionTaskId?:string;admissionOperationId?:string}) {
  if(config.backend!=="desktop-queue")throw new Error("Automatic native workspaces require desktop-queue");
  const target = { taskId: input.admissionTaskId ?? "", workspace: input.workspace, sessionId: input.sessionId ?? null, model: input.model ?? "", workerKey: input.workerKey ?? null, title: input.title ?? null };
  // The registration pairs the persistent native service with this task database.
  // Resolving it before the preparation boundary keeps a fixable configuration
  // mistake in front of the native adapter instead of after it (FC11-D1/D2).
  const registration=workerRegistration(config);
  // An existing session already has a native route, so its registration and history
  // are checked before the preparation boundary is written: a wrong directory must
  // leave no operation behind, not an effect that only a recovery decision can close.
  if (input.sessionId) assertDispatchConfiguration(config, input.sessionId);
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
