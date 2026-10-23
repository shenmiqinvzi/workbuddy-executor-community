import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { hasProcess, sameExecutable, windowsProcessTable } from "./native-process.js";
import { latestNativeWake } from "./native-ownership.js";
// The desktop route began on macOS; these branches add the Windows equivalent
// (tasklist/netstat + WM_CLOSE relaunch) without changing the macOS behaviour.
const WINDOWS = process.platform === "win32";
// The renderer forwards requests into the desktop's existing local daemon.
// No UI controls, account tokens, CLI host or model are created by this code.
export const RENDERER_BRIDGE = String.raw `(async function(){
  const requestedFreeModel="";
  const previous=globalThis.__codexNativeQueueBridgeV2;
  if(previous?.revision===7&&previous.policyRevision===1&&previous.stopRevision===2&&previous.failureRevision===1){
    previous.configurePolicy(requestedFreeModel);
    return true;
  }
  if(globalThis.__codexNativeQueueBridgeInstall){
    await globalThis.__codexNativeQueueBridgeInstall;
    globalThis.__codexNativeQueueBridgeV2.configurePolicy(requestedFreeModel);
    return true;
  }
  const installation=(async()=>{
  // Keep a legacy bridge alive during upgrade: its pending native turn and
  // receipts must remain visible until they settle. Never close it to refresh policy.
  const legacy=previous?.revision===7?previous:undefined;
  if(previous&&!legacy)throw Error('Incompatible native bridge; inspect its active sessions before upgrade');
  if(legacy&&!requestedFreeModel)throw Error('Legacy bridge policy is unknown; an explicit free-only model policy is required for upgrade');
  let freeModel=requestedFreeModel;
  const configurePolicy=model=>{
    if(typeof model!=='string')throw Error('Invalid native model policy');
    if(freeModel&&!model)throw Error('An unrestricted client cannot relax the active free-only model policy');
    freeModel=model;
  };
  const mc=new MessageChannel(), pending=new Map(), markers=new Map(), outgoing=new Map(), failures=new Map(), lastUser=new Map();
  let sequence=0, openResolve, closed=false;
  const opened=new Promise(resolve=>openResolve=resolve);
  const marker=(sid,id)=>{if(typeof id==='string'&&/^wake-run-[a-f0-9-]{36}$/.test(id)){if(!markers.has(sid))markers.set(sid,new Set());markers.get(sid).add(id);}};
  mc.port1.onmessage=event=>{
    const frame=event.data;
    if(frame.kind==='open'){openResolve();return;}
    if(frame.kind==='close'){closed=true;for(const q of pending.values()){clearTimeout(q.timer);q.reject(Error('Native desktop transport closed'));}pending.clear();return;}
    if(frame.kind!=='message')return;
    let message=frame.json;try{message??=JSON.parse(frame.text);}catch{return;}
    if(message.type==='event'&&typeof message.channel==='string'&&message.channel.startsWith('session:event:')){
      const data=message.result||{},update=data.update||{},sid=data.sessionId||message.channel.slice(14);
      if(update.sessionUpdate==='user_message_chunk'){
        const meta=(data._meta||{})['codebuddy.ai']||{};
        let current;
        for(const key of ['requestId','userMessageId','messageRequestId'])if(typeof meta[key]==='string')current=meta[key];
        for(const key of ['requestId','userMessageId','messageRequestId'])marker(sid,meta[key]);
        const content=Array.isArray(update.content)?update.content:[update.content];
        for(const item of content){if(item?.type==='text'&&typeof item.text==='string'){const match=item.text.match(/\[CODEX_QUEUE_WAKE (wake-run-[a-f0-9-]{36})\]/);if(match){marker(sid,match[1]);current=match[1];}}}
        lastUser.set(sid,current);
      }
      return;
    }
    const q=pending.get(message.id);if(!q)return;pending.delete(message.id);clearTimeout(q.timer);
    if(message.type==='error')q.reject(Error(typeof message.error?.message==='string'?message.error.message:'Native RPC failed'));
    else q.resolve(message.result);
  };
  mc.port1.start();
  window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[mc.port2]);
  let openTimer;try{await Promise.race([opened,new Promise((_,reject)=>openTimer=setTimeout(()=>reject(Error('Native port open timed out')),10000))]);}finally{clearTimeout(openTimer);}
  const rpc=(channel,args,timeout=15000)=>new Promise((resolve,reject)=>{
    if(closed){reject(Error('Native desktop transport closed'));return;}
    const id='codex-native-'+(++sequence);
    const timer=timeout?setTimeout(()=>{pending.delete(id);reject(Error('Native RPC timed out: '+channel));},timeout):undefined;
    pending.set(id,{resolve,reject,timer});mc.port1.postMessage({kind:'message',json:{id,type:'request',channel,args}});
  });
  const inspect=async sid=>{
    const active=await rpc('daemon:getActiveSessions',[]);
    if(!Array.isArray(active))throw Error('Incompatible native activity response');
    const session=await rpc('session:get',[sid]);
    if(!session||!session.cwd)throw Error('Native worker session was not found');
    const observation={workspace:session.cwd,...lastUser.has(sid)?{latestWakeId:lastUser.get(sid)??null}:{},...Number.isFinite(session.lastBackendActivityAt)?{activityAt:session.lastBackendActivityAt}:{},...failures.has(sid)?{failure:failures.get(sid)}:{}};
    if(legacy){
      const prior=await legacy.inspect(sid);
      if(prior.state!=='idle')return prior;
      if(!observation.failure&&prior.failure)observation.failure=prior.failure;
    }
    const waiting=session.pendingInputKind||(session.pendingPermissions?.length)||(session.pendingQuestions?.length)||(session.pendingElicitations?.length);
    if(waiting)return {...observation,state:'waiting_input',reason:'WorkBuddy requires native permission or input'};
    // Native terminal status can mask hasActiveToolCalls. Retain unfinished
    // calls from the raw view history rather than trusting the derived flag.
    const tools=new Map();
    for(const event of session.eventHistory||[]){const u=event?.update;if(u&&['tool_call','tool_call_update'].includes(u.sessionUpdate)&&typeof u.toolCallId==='string')tools.set(u.toolCallId,typeof u.status==='string'?u.status:tools.get(u.toolCallId)||'pending');}
    const unfinishedTools=[...tools.values()].some(status=>!['completed','failed','cancelled'].includes(status));
    const team=session.teamRuntime;
    const unfinishedTeam=team&&(team.hasActiveMembers||team.teamTrulyIdle===false||(team.teamActive===true&&team.teamTrulyIdle!==true));
    if(outgoing.has(sid)||active.some(s=>(s.sessionId||s.id)===sid||samePath(s.cwd,session.cwd))||session.isProcessing||session.stopRequested||session.hasActiveTeamMembers||session.hasActiveToolCalls||unfinishedTools||unfinishedTeam||session.hasRunningBackgroundTasks||session.hasActiveChildAgents)return {...observation,state:'busy',reason:'Native WorkBuddy session is active'};
    if(!['completed','failed','cancelled','idle','stopped','pending','terminated'].includes(String(session.status).toLowerCase()))return {...observation,state:'busy',reason:'Native state is not confirmed idle: '+String(session.status)};
    return {...observation,state:'idle'};
  };
  const findWake=async(sid,wakeId)=>{
    if(markers.get(sid)?.has(wakeId))return true;
    const session=await rpc('session:get',[sid]);
    await rpc('session:load',[sid,{cwd:session?.cwd,forceRendererHistoryReplay:true}]);
    return markers.get(sid)?.has(wakeId)===true;
  };
  const listModels=async sid=>{
    const product=await rpc('config:getProductConfiguration',[true],30000);
    if(product?.remoteProductConfigurationStatus==='pending')throw Error('WorkBuddy model configuration is still loading; retry the query');
    if(!Array.isArray(product?.models))throw Error('Incompatible native model list');
    const allowed=Array.isArray(product.availableModels)?new Set(product.availableModels):null;
    const models=product.models.filter(m=>m&&typeof m.id==='string'&&m.id.trim()&&(!allowed?.size||allowed.has(m.id)||allowed.has(m.id.replace(/^custom-local:/,'')))).map(m=>({id:m.id,name:m.name||m.id,...m.credits!==undefined?{credits:m.credits}:{},...m.isFree!==undefined?{isFree:m.isFree}:{},...m.creditMultiplier!==undefined?{creditMultiplier:m.creditMultiplier}:{}}));
    const session=sid?await rpc('session:get',[sid]):undefined;
    return {models,currentModel:session?.model||session?.config?.model,...sid?{sessionId:sid}:{}};
  };
  const applyModel=async(sid,model)=>{
    const available=await listModels(sid);
    const selected=available.models.find(m=>m.id===model);
    if(!selected)throw Error('Model is not available in WorkBuddy: '+model);
    if(freeModel&&(model!==freeModel||!/^x0(?:\.0+)?(?: credits)?$/i.test(String(selected.credits||'').trim())))throw Error('Free-only policy blocked this model; no paid fallback is allowed: '+model);
    if(available.currentModel!==model){
      const result=await rpc('session:updateConfig',[sid,{model}],45000);
      if(result?.error||result?.errorCode||result?.success===false)throw Error('Native model configuration was rejected');
    }
    const session=await rpc('session:get',[sid]);
    const actual=session?.model||session?.config?.model;
    if(actual!==model)throw Error('Native model change was not confirmed; inspect the session before retrying');
    if(freeModel&&model!==freeModel)throw Error('Free-only policy changed during native model configuration');
    return {sessionId:sid,model:actual};
  };
  const setModel=async(sid,model)=>{
    const state=await inspect(sid);
    if(state.state!=='idle'||outgoing.has(sid))throw Error('Wait for the native WorkBuddy session to finish before changing its model');
    outgoing.set(sid,{configuration:true});
    try{return await applyModel(sid,model);}finally{outgoing.delete(sid);}
  };
  const wakeIdle=async(sid,wakeId,prompt,model)=>{
    if(freeModel)model=model||freeModel;
    if(markers.get(sid)?.has(wakeId))return {accepted:true,receipt:wakeId};
    const state=await inspect(sid);
    if(state.state!=='idle'||outgoing.has(sid))return {accepted:false};
    const operation={wakeId,error:undefined};outgoing.set(sid,operation);
    failures.delete(sid);
    // A created session is not opened in the renderer yet. Several desktop
    // builds drop session:sendMessage until the conversation is loaded, and the
    // prompt then never reaches the native history. Load it first when needed.
    try{
      const active=await rpc('daemon:getActiveSessions',[]);
      const already=Array.isArray(active)&&active.some(s=>(s&&(s.sessionId||s.id)===sid)||(s&&state.workspace&&s.cwd===state.workspace));
      if(!already){const session=await rpc('session:get',[sid]);await rpc('session:load',[sid,{cwd:state.workspace||session?.cwd,forceRendererHistoryReplay:true}],45000);}
    }catch(error){outgoing.delete(sid);return {accepted:false,error:error.message};}
    // The reservation remains held during loading and model configuration.
    try{if(model)await applyModel(sid,model);if(freeModel&&model!==freeModel)throw Error('Free-only policy changed before dispatch');}catch(error){outgoing.delete(sid);return {accepted:false,error:error.message};}
    const meta={'codebuddy.ai':{requestId:wakeId,userMessageId:wakeId,messageRequestId:wakeId,emitSyntheticUserPromptLive:true}};
    rpc('session:sendMessage',[sid,[{type:'text',text:prompt}],meta],0).then(()=>outgoing.delete(sid),error=>{operation.error=error.message;failures.set(sid,{wakeId,error:String(error.message).slice(0,2000),observedAt:new Date().toISOString(),phase:'session:sendMessage'});outgoing.delete(sid);});
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      if(markers.get(sid)?.has(wakeId))return {accepted:true,receipt:wakeId};
      if(operation.error)throw Error(operation.error);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('Native submission receipt is uncertain; do not automatically replay');
  };
  // Windows returns the native cwd with backslashes; compare normalized paths
  // instead of raw strings so a real creation is not reported as a mismatch.
  const samePath=(a,b)=>{const n=v=>String(v??'').replace(/\\/g,'/').replace(/\/+$/,'');if(n(a)===n(b))return true;return /^[a-zA-Z]:\//.test(n(a))&&n(a).toLowerCase()===n(b).toLowerCase();};
  const createWorker=async(workspace,sessionId,title)=>{
    const initialized=await rpc('workspace:initialize',[{cwd:workspace}]);
    if(!initialized?.success)throw Error(initialized?.error||'Native workspace initialization failed');
    const created=await rpc('session:create',[{cwd:workspace,sessionId,isPlayground:false}],45000);
    if(created?.sessionId!==sessionId||!samePath(created?.cwd,workspace))throw Error('Native session creation returned a different identity or workspace; do not replay');
    if(title)await rpc('session:rename',[sessionId,title]);
    return {sessionId:created.sessionId,workspace:created.cwd};
  };
  const cancelAttempt=async(sid,wakeId,workspace)=>{
    if(!/^wake-run-[a-f0-9-]{36}$/.test(wakeId))throw Error('Invalid cancellation wake identity');
    const session=await rpc('session:get',[sid],3000);
    if((session?.sessionId||session?.id)!==sid||!samePath(session?.cwd,workspace))throw Error('Cancellation session/workspace mismatch');
    const own=outgoing.get(sid);
    if(own&&own.wakeId!==wakeId)throw Error('Another operation owns this session');
    await rpc('session:load',[sid,{cwd:workspace,forceRendererHistoryReplay:true}],3000);
    if(lastUser.get(sid)!==wakeId)throw Error('Latest native user turn changed; cancellation refused');
    // The host also verifies the latest persisted user turn, not just marker existence.
    const result=await rpc('session:cancel',[sid],5000);
    if(result?.error||result?.success===false)throw Error('Native cancellation rejected');
    return {requested:true,sessionId:sid,wakeId};
  };
  globalThis.__codexNativeQueueBridgeV2={revision:7,policyRevision:1,stopRevision:2,failureRevision:1,get freeModel(){return freeModel;},configurePolicy,inspect,findWake,wakeIdle,createWorker,listModels,setModel,cancelAttempt,close:()=>{mc.port1.close();legacy?.close?.();}};
  return true;
  })();
  globalThis.__codexNativeQueueBridgeInstall=installation;
  try{return await installation;}finally{if(globalThis.__codexNativeQueueBridgeInstall===installation)delete globalThis.__codexNativeQueueBridgeInstall;}
})()`;
export function rendererBridgeForFreeModel(model) {
    return RENDERER_BRIDGE.replace('const requestedFreeModel="";', `const requestedFreeModel=${JSON.stringify(model)};`);
}
export function matchesNativeRendererFileUrl(url, archivePath) {
    if (!url)
        return false;
    try {
        const candidate = new URL(url);
        if (candidate.protocol !== "file:")
            return false;
        // Chromium escapes Unicode and spaces. Compare canonical file URLs and
        // require a child of this exact archive rather than a path substring.
        const archiveUrl = pathToFileURL(archivePath).href.toLowerCase();
        return candidate.href.toLowerCase().startsWith(archiveUrl + "/");
    }
    catch {
        return false;
    }
}
const DEFAULT_PROCESS_CONTROL = {
    run: (file, args, timeoutMs) => execFileSync(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }),
    launch(executable, cdpPort) {
        const child = spawn(executable, [], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, WORKBUDDY_REMOTE_DEBUGGING_PORT: String(cdpPort) } });
        child.on("error", () => undefined);
        child.unref();
    },
    pause: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
};
function noProcessMatch(error) {
    const failure = error;
    return failure?.status === 1 && String(failure.stdout ?? "").trim() === "";
}
export class NativeDesktopRpcTrigger {
    config;
    cdpPort;
    autoLaunch;
    processControl;
    observer;
    socket;
    sequence = 0;
    pending = new Map();
    connection;
    constructor(config, cdpPort, autoLaunch = true, processControl = DEFAULT_PROCESS_CONTROL) {
        this.config = config;
        this.cdpPort = cdpPort;
        this.autoLaunch = autoLaunch;
        this.processControl = processControl;
        if (!Number.isInteger(cdpPort) || cdpPort < 1 || cdpPort > 65535)
            throw new Error("Invalid native desktop CDP port");
    }
    portState() {
        if (WINDOWS)
            return this.portStateWindows();
        let output;
        try {
            output = this.processControl.run("/usr/sbin/lsof", ["-nP", `-iTCP:${this.cdpPort}`, "-sTCP:LISTEN", "-Fp"], 3000);
        }
        catch (error) {
            return noProcessMatch(error) ? "absent" : "unavailable";
        }
        const pids = [...output.matchAll(/^p(\d+)$/gm)].map(match => Number(match[1]));
        if (pids.length === 0)
            return output.trim() === "" ? "absent" : "unavailable";
        try {
            return pids.length === 1 && this.processControl.run("/bin/ps", ["-p", String(pids[0]), "-o", "comm="], 3000).trim() === path.resolve(this.config.cliElectronPath) ? "native" : "foreign";
        }
        catch {
            return "unavailable";
        }
    }
    /** Windows port ownership is proven by the process that listens on it. */
    portStateWindows() {
        let output;
        try {
            output = this.processControl.run("netstat", ["-ano", "-p", "tcp"], 10_000);
        }
        catch {
            return "unavailable";
        }
        const pids = [];
        for (const line of output.split(/\r?\n/)) {
            const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
            if (match && Number(match[1]) === this.cdpPort && Number(match[2]) > 0)
                pids.push(Number(match[2]));
        }
        if (pids.length === 0)
            return "absent";
        try {
            const table = windowsProcessTable();
            return pids.length === 1 && table.some((row) => row.pid === pids[0] && sameExecutable(row.exe, this.config.cliElectronPath)) ? "native" : "foreign";
        }
        catch {
            return "unavailable";
        }
    }
    ownerIsNative() {
        return this.portState() === "native";
    }
    nativePids() {
        if (WINDOWS)
            return this.nativePidsWindows();
        const executable = path.resolve(this.config.cliElectronPath);
        const output = this.processControl.run("/bin/ps", ["-axo", "pid=,command="], 3000);
        return output.split("\n").flatMap(line => { const match = line.trim().match(/^(\d+)\s+(.+)$/); const command = match?.[2] ?? ""; return match && (command === executable || command.startsWith(executable + " --")) && !/--type=|--stdio|cli\/bin|sidecar-entry|daemon-app-server/.test(command) ? [Number(match[1])] : []; });
    }
    /** Root WorkBuddy processes: the executable matches and it is not a helper child. */
    nativePidsWindows() {
        const executable = this.config.cliElectronPath;
        return windowsProcessTable()
            .filter((row) => sameExecutable(row.exe, executable) && !/--type=|--stdio|sidecar-entry|daemon-app-server|cli[\\/]bin/i.test(row.commandLine ?? ""))
            .map((row) => row.pid);
    }
    rootPidExists(pid) {
        if (WINDOWS)
            return hasProcess(pid);
        try {
            return this.processControl.run("/bin/ps", ["-p", String(pid), "-o", "pid="], 3000).trim() === String(pid);
        }
        catch (error) {
            if (noProcessMatch(error))
                return false;
            throw error;
        }
    }
    /**
     * Close the native app the way the ordinary quit command does, then wait for
     * it to disappear so the startup switch can be applied by a fresh launch.
     */
    async quitNativeWindows(pid) {
        try {
            this.processControl.run("taskkill", ["/PID", String(pid)], 10_000);
        }
        catch { /* already gone */ }
        for (let retry = 0; retry < 40 && hasProcess(pid); retry++)
            await this.processControl.pause(250);
        if (!hasProcess(pid))
            return true;
        // WM_CLOSE was ignored (for example the app is minimized to the tray). The
        // history database is WAL-journaled, so one forced restart stays recoverable.
        try {
            this.processControl.run("taskkill", ["/F", "/PID", String(pid)], 10_000);
        }
        catch { /* already gone */ }
        for (let retry = 0; retry < 20 && hasProcess(pid); retry++)
            await this.processControl.pause(250);
        return !hasProcess(pid);
    }
    canEnablePortWithoutInterruptingWork() {
        let db;
        try {
            // Initial setup can be sent from a desktop without debugging enabled.
            // Wait for its configuration turn (and every other native task) to finish
            // before the one-time graceful restart needed for the startup setting.
            db = new DatabaseSync(path.join(this.config.workbuddyConfigDir, "workbuddy.db"), { readOnly: true });
            const rows = db.prepare("SELECT status FROM sessions WHERE deleted_at IS NULL").all();
            return rows.every(row => ['completed', 'failed', 'cancelled', 'idle', 'stopped', 'archived', 'terminated', 'error'].includes(String(row.status).trim().toLowerCase()));
        }
        catch {
            return false;
        }
        finally {
            db?.close();
        }
    }
    async discover() {
        if (WINDOWS)
            return this.discoverWindows();
        const portState = this.portState();
        if (portState === "foreign" || portState === "unavailable")
            throw new Error("Registered local port is occupied by another process or its owner cannot be verified; WorkBuddy was left running");
        if (portState !== "native") {
            if (!this.autoLaunch)
                throw new Error("Native desktop is offline");
            const running = this.nativePids();
            if (running.length) {
                if (running.length !== 1 || !this.canEnablePortWithoutInterruptingWork())
                    throw new Error("Waiting for native WorkBuddy tasks to finish before enabling its persistent local port");
                const rootPid = running[0];
                const current = this.nativePids();
                if (current.length !== 1 || current[0] !== rootPid || this.portState() !== "absent")
                    throw new Error("Native WorkBuddy changed during setup; no restart was requested");
                // WorkBuddy's SIGTERM handler calls process.exit directly. The native
                // application quit event runs its ordinary before-quit teardown instead.
                this.processControl.run("/usr/bin/osascript", ["-e", 'tell application id "com.tencent.workbuddy.mac" to quit'], 15000);
                for (let retry = 0; retry < 40 && this.rootPidExists(rootPid); retry++)
                    await this.processControl.pause(250);
                if (this.rootPidExists(rootPid))
                    throw new Error("Native WorkBuddy did not finish its graceful setup restart");
                if (this.nativePids().length)
                    throw new Error("Another WorkBuddy root appeared during setup; no replacement was launched");
            }
            if (this.portState() !== "absent")
                throw new Error("Registered local port changed during setup; no replacement was launched");
            if (!fs.statSync(this.config.cliElectronPath).isFile())
                throw new Error("WorkBuddy desktop executable is missing");
            this.processControl.launch(this.config.cliElectronPath, this.cdpPort);
            for (let retry = 0; retry < 60 && !this.ownerIsNative(); retry++)
                await this.processControl.pause(250);
            if (!this.ownerIsNative())
                throw new Error("Native WorkBuddy local RPC port did not become available");
        }
        const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`, { signal: AbortSignal.timeout(4000) });
        const targets = await response.json();
        const executableRoot = path.resolve(this.config.cliElectronPath, "../../Resources/app.asar");
        const target = targets.find(item => item.type === "page" && item.url?.startsWith(`file://${executableRoot}/`) && !item.url.includes("splash") && item.webSocketDebuggerUrl);
        if (!target?.webSocketDebuggerUrl)
            throw new Error("WorkBuddy main renderer is not ready");
        const url = new URL(target.webSocketDebuggerUrl);
        if (!['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== this.cdpPort || url.protocol !== 'ws:')
            throw new Error("Native debugger target is not the registered loopback endpoint");
        return target.webSocketDebuggerUrl;
    }
    async discoverWindows() {
        const portState = this.portStateWindows();
        if (portState === "foreign" || portState === "unavailable")
            throw new Error("Registered local port is occupied by another process or its owner cannot be verified; WorkBuddy was left running");
        if (portState !== "native") {
            if (!this.autoLaunch)
                throw new Error("Native desktop is offline");
            const running = this.nativePidsWindows();
            if (running.length) {
                if (running.length !== 1 || !this.canEnablePortWithoutInterruptingWork())
                    throw new Error("Waiting for native WorkBuddy tasks to finish before enabling its persistent local port");
                const rootPid = running[0];
                if (this.nativePidsWindows().length !== 1 || this.nativePidsWindows()[0] !== rootPid || this.portStateWindows() !== "absent")
                    throw new Error("Native WorkBuddy changed during setup; no restart was requested");
                if (!await this.quitNativeWindows(rootPid))
                    throw new Error("Native WorkBuddy did not finish its graceful setup restart");
                if (this.nativePidsWindows().length)
                    throw new Error("Another WorkBuddy root appeared during setup; no replacement was launched");
            }
            if (this.portStateWindows() !== "absent")
                throw new Error("Registered local port changed during setup; no replacement was launched");
            if (!fs.statSync(this.config.cliElectronPath).isFile())
                throw new Error("WorkBuddy desktop executable is missing");
            this.processControl.launch(this.config.cliElectronPath, this.cdpPort);
            for (let retry = 0; retry < 60 && !this.ownerIsNative(); retry++)
                await this.processControl.pause(250);
            if (!this.ownerIsNative())
                throw new Error("Native WorkBuddy local RPC port did not become available");
        }
        const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`, { signal: AbortSignal.timeout(4000) });
        const targets = await response.json();
        // Windows reports the renderer as file:///D:/<app>/resources/app.asar/renderer/index.html.
        const appAsar = path.join(path.dirname(path.resolve(this.config.cliElectronPath)), "resources", "app.asar");
        const target = targets.find((item) => item.type === "page" && typeof item.url === "string" && item.webSocketDebuggerUrl && matchesNativeRendererFileUrl(item.url, appAsar) && !item.url.toLowerCase().includes("splash"));
        if (!target?.webSocketDebuggerUrl)
            throw new Error("WorkBuddy main renderer is not ready");
        const url = new URL(target.webSocketDebuggerUrl);
        if (!['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== this.cdpPort || url.protocol !== 'ws:')
            throw new Error("Native debugger target is not the registered loopback endpoint");
        return target.webSocketDebuggerUrl;
    }
    async connect(observeOnly = false) {
        if (this.socket?.readyState === WebSocket.OPEN)
            return;
        if (this.connection)
            return this.connection;
        const connecting = (async () => {
            const socket = new WebSocket(await this.discover());
            this.socket = socket;
            socket.addEventListener("message", event => {
                let frame;
                try {
                    frame = JSON.parse(String(event.data));
                }
                catch {
                    return;
                }
                if (!frame.id)
                    return;
                const request = this.pending.get(frame.id);
                if (!request)
                    return;
                this.pending.delete(frame.id);
                clearTimeout(request.timer);
                const exception = frame.result?.exceptionDetails;
                if (frame.error || exception)
                    request.reject(new Error(frame.error?.message ?? exception?.exception?.description ?? exception?.text ?? "Native RPC evaluation failed"));
                else
                    request.resolve(frame.result?.result?.value);
            });
            socket.addEventListener("close", () => { if (this.socket === socket)
                this.socket = undefined; for (const request of this.pending.values()) {
                clearTimeout(request.timer);
                request.reject(new Error("Native desktop disconnected; submission outcome may be uncertain"));
            } this.pending.clear(); });
            await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Native CDP connection timed out")), 5000); socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Native CDP connection failed")); }, { once: true }); });
            if (!observeOnly)
                await this.evaluateConnected(rendererBridgeForFreeModel(process.env.WORKBUDDY_REQUIRED_FREE_MODEL ?? ""));
        })();
        this.connection = connecting;
        try {
            await connecting;
        }
        finally {
            if (this.connection === connecting)
                this.connection = undefined;
        }
    }
    evaluateConnected(expression, timeoutMs = 22000) {
        const socket = this.socket;
        if (socket?.readyState !== WebSocket.OPEN)
            return Promise.reject(new Error("Native desktop socket is closed"));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Native evaluation timed out; never replay an uncertain submission")); }, timeoutMs); this.pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } })); });
    }
    async call(method, args, timeoutMs = 90000) {
        await this.connect();
        return this.evaluateConnected(`globalThis.__codexNativeQueueBridgeV2.${method}(...${JSON.stringify(args)})`, timeoutMs);
    }
    async listModels(sessionId) {
        return await this.call("listModels", [sessionId]);
    }
    async setModel(sessionId, model) {
        return await this.call("setModel", [sessionId, model]);
    }
    /** Inspect an existing bridge without installing/configuring it or launching the app. */
    async diagnoseReadOnly() {
        if (this.autoLaunch)
            throw new Error("Read-only diagnosis requires autoLaunch=false");
        await this.connect(true);
        return await this.evaluateConnected("(async()=>{const b=globalThis.__codexNativeQueueBridgeV2;if(b?.revision!==7||typeof b.listModels!=='function')return {bridgeReady:false};const r=await b.listModels();return {bridgeReady:true,models:r.models.map(m=>({id:m.id,credits:m.credits}))};})()", 35000);
    }
    async createWorker(workspace, sessionId, title) {
        if (!path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory())
            throw new Error("workspace must be an existing absolute directory");
        if (!/^[a-f0-9-]{36}$/.test(sessionId))
            throw new Error("A reserved native session UUID is required");
        await this.connect();
        return await this.evaluateConnected(`globalThis.__codexNativeQueueBridgeV2.createWorker(...${JSON.stringify([workspace, sessionId, title])})`, 55000);
    }
    async inspect(sessionId, options) {
        if (options?.readOnly && this.autoLaunch) {
            this.observer ??= new NativeDesktopRpcTrigger(this.config, this.cdpPort, false, this.processControl);
            return this.observer.inspect(sessionId);
        }
        try {
            const observation = await this.call("inspect", [sessionId]);
            return { ...observation, latestWakeId: latestNativeWake(this.config.workbuddyConfigDir, sessionId) ?? null };
        }
        catch (error) {
            return { state: "offline", reason: error instanceof Error ? error.message : String(error) };
        }
    }
    async findWake(sessionId, wakeId) { return await this.call("findWake", [sessionId, wakeId]) === true; }
    async cancelAttempt(sessionId, wakeId, workspace) {
        // Stop never enables a debug port, restarts the app or launches a replacement.
        if (this.autoLaunch) {
            this.observer ??= new NativeDesktopRpcTrigger(this.config, this.cdpPort, false, this.processControl);
            return this.observer.cancelAttempt(sessionId, wakeId, workspace);
        }
        if (latestNativeWake(this.config.workbuddyConfigDir, sessionId) !== wakeId)
            throw new Error("stop_unconfirmed: latest native user turn does not belong to this attempt; no session was stopped");
        await this.call("cancelAttempt", [sessionId, wakeId, workspace], 10000);
    }
    async wakeIdle(sessionId, wakeId, prompt, model) {
        if (!/^wake-run-[a-f0-9-]{36}$/.test(wakeId) || !prompt.startsWith(`[CODEX_QUEUE_WAKE ${wakeId}]`))
            throw new Error("Wake identity must match its queue marker");
        return await this.call("wakeIdle", [sessionId, wakeId, prompt, model]);
    }
    close() { this.observer?.close(); this.observer = undefined; this.socket?.close(); this.socket = undefined; }
}
export function createNativeDesktopTrigger(config, options) {
    return new NativeDesktopRpcTrigger(config, options.cdpPort);
}
//# sourceMappingURL=native-desktop-trigger.js.map