import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import type { Config } from "../src/config.js";
import { NativeDesktopRpcTrigger, RENDERER_BRIDGE, rendererBridgeForFreeModel, type NativeDesktopProcessControl } from "../src/native-desktop-trigger.js";

type Envelope = { id: string; type: string; channel: string; args: unknown[]; result?: unknown; error?: { message: string } };
type Frame = { kind: string; json?: Envelope; text?: string };
type RequestHandler = (request: Envelope, native: NativeFixture) => unknown | Promise<unknown>;
type Bridge = {
  listModels(sessionId?:string):Promise<{models:Array<{id:string;name:string}>;currentModel?:string}>;
  setModel(sessionId:string,model:string):Promise<{sessionId:string;model:string}>;
  createWorker(workspace:string,sessionId:string,title?:string):Promise<{sessionId:string;workspace:string}>;
  inspect(sessionId: string): Promise<{ state: string; workspace?: string; [key: string]: unknown }>;
  findWake(sessionId: string, wakeId: string): Promise<boolean>;
  wakeIdle(sessionId: string, wakeId: string, prompt: string, model?:string): Promise<{ accepted: boolean; [key: string]: unknown }>;
};

class FakePort {
  peer?: FakePort;
  onmessage: ((event: { data: Frame }) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  closed = false;
  start() {}
  close() { this.closed = true; }
  postMessage(data: Frame) {
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.onmessage?.({ data });
    });
  }
}

class FakeMessageChannel {
  port1 = new FakePort();
  port2 = new FakePort();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; }
}

class NativeFixture {
  private context!: vm.Context;
  readonly requests: Envelope[] = [];
  readonly ports: FakePort[] = [];
  readonly sessionId = "pinned-desktop-session";
  readonly workspace = "/tmp/native-protocol-fixture";
  session: Record<string, unknown> = { id: this.sessionId, sessionId: this.sessionId, cwd: this.workspace, status: "completed" };
  active: unknown[] = [];
  replay: Array<{ channel: string; result: unknown }> = [];
  handler?: RequestHandler;
  bridge!: Bridge;
  readonly ready: Promise<void>;

  constructor(script = RENDERER_BRIDGE) {
    const fixture = this;
    const window = {
      postMessage(message: unknown, target: string, transfer: FakePort[]) {
        assert.equal(target, "*");
        assert.equal(JSON.stringify(message), JSON.stringify({ type: "workbuddy:open-local-daemon-transport-port", target: { transportType: "local" } }));
        const nativePort = transfer[0]!;
        fixture.ports.push(nativePort);
        nativePort.onmessage = (event) => {
          const envelope = event.data.json ?? JSON.parse(event.data.text ?? "null") as Envelope;
          if (event.data.kind !== "message" || envelope.type !== "request") return;
          fixture.requests.push(envelope);
          Promise.resolve().then(() => fixture.handle(envelope)).then(
            (result) => nativePort.postMessage({ kind: "message", json: { id: envelope.id, type: "response", channel: envelope.channel, args: [], result } }),
            (error: Error) => nativePort.postMessage({ kind: "message", json: { id: envelope.id, type: "error", channel: envelope.channel, args: [], error: { message: error.message } } }),
          );
        };
        nativePort.postMessage({ kind: "open" });
      },
    };
    let clock = 0;
    class FixtureDate extends Date { static now() { return clock; } }
    const fixtureTimeout = (callback: () => void, delay = 0) => setTimeout(() => {
      if (delay === 100) clock += 100;
      callback();
    }, delay === 100 ? 0 : delay);
    const context = vm.createContext({ window, MessageChannel: FakeMessageChannel, crypto: webcrypto, Date: FixtureDate, setTimeout: fixtureTimeout, clearTimeout, console });
    this.context = context;
    this.ready = Promise.resolve(vm.runInContext(script, context)).then(() => {
      this.bridge = vm.runInContext("globalThis.__codexNativeQueueBridgeV2", context) as Bridge;
      assert.ok(this.bridge, "renderer bridge must install its explicit native protocol entry point");
    });
  }
  async evaluate(script: string) { return await vm.runInContext(script, this.context); }
  seedLegacy(bridge: unknown) { this.context.__codexNativeQueueBridgeV2 = bridge; }

  async handle(request: Envelope): Promise<unknown> {
    if (this.handler) return this.handler(request, this);
    return this.defaultResponse(request);
  }

  defaultResponse(request: Envelope): unknown {
    switch (request.channel) {
      case "config:getProductConfiguration": return {models:[{id:'fast',name:'Fast'},{id:'deep',name:'Deep'},{id:'hidden',name:'Hidden'},{id:'custom-local:own',name:'Own'}],availableModels:['fast','deep','own']};
      case "session:updateConfig": this.session.model=(request.args[1] as {model:string}).model;return {config:{model:this.session.model}};
      case "session:get": return this.session;
      case "daemon:getActiveSessions": return this.active;
      case "session:load":
        for (const event of this.replay) this.event(event.channel, event.result);
        return { ...this.session, loaded: true, rendererHistoryReplayComplete: true };
      case "session:sendMessage": return { stopReason: "end_turn" };
      default: throw new Error(`Unexpected native channel: ${request.channel}`);
    }
  }

  event(channel: string, result: unknown, id = "unrelated-event") {
    for (const port of this.ports) port.postMessage({ kind: "message", json: { id, type: "event", channel, args: [], result } });
  }

  userEvent(wakeId: string, sessionId = this.sessionId) {
    this.event(`session:event:${sessionId}`, {
      sessionId,
      update: { sessionUpdate: "user_message_chunk", content: [{ type: "text", text: `[CODEX_QUEUE_WAKE ${wakeId}] protocol fixture` }] },
      _meta: { "codebuddy.ai": { requestId: wakeId, userMessageId: wakeId, messageRequestId: wakeId } },
    });
  }

  sends() { return this.requests.filter((request) => request.channel === "session:sendMessage"); }

  close() { for (const port of this.ports) port.postMessage({ kind: "close" }); }
}

test("native creation initializes the directory and creates a real session without prompts or model overrides",async()=>{
  const f=new NativeFixture();await f.ready;
  const id='11111111-1111-4111-8111-111111111111';
  f.handler=request=>{
    if(request.channel==='workspace:initialize')return{success:true};
    if(request.channel==='session:create')return{sessionId:id,cwd:f.workspace};
    if(request.channel==='session:rename')return{};
    return f.defaultResponse(request);
  };
  const result=await f.bridge.createWorker(f.workspace,id,'Project worker');
  assert.equal(result.sessionId,id);assert.equal(result.workspace,f.workspace);
  assert.deepEqual(f.requests.map(r=>r.channel),['workspace:initialize','session:create','session:rename']);
  assert.equal(JSON.stringify(f.requests[1]!.args),JSON.stringify([{cwd:f.workspace,sessionId:id,isPlayground:false}]));
  assert.equal(f.sends().length,0);
});

test("native creation refuses another session identity; a newly created pending session is idle",async()=>{
  const f=new NativeFixture();await f.ready;
  f.handler=request=>request.channel==='workspace:initialize'?{success:true}:request.channel==='session:create'?{sessionId:'wrong',cwd:f.workspace}:f.defaultResponse(request);
  await assert.rejects(f.bridge.createWorker(f.workspace,'requested'),/different identity/);
  assert.equal(f.sends().length,0);f.session.status='Pending';
  assert.equal((await f.bridge.inspect(f.sessionId)).state,'idle');
});

const WAKE_A = "wake-run-11111111-1111-1111-1111-111111111111";
const WAKE_B = "wake-run-22222222-2222-2222-2222-222222222222";
const wakePrompt = (wakeId: string) => `[CODEX_QUEUE_WAKE ${wakeId}] Native protocol fixture only`;

test("cached bridge refreshes free-only policy without replacing the transport and rejects policy downgrades", async t => {
  const f = await fixture(t);
  f.handler = request => request.channel === "config:getProductConfiguration"
    ? { models: [{ id: "fast", credits: "x0.00" }, { id: "deep", credits: "x0.00" }, { id: "paid", credits: "x0.03" }] }
    : f.defaultResponse(request);
  await f.evaluate(rendererBridgeForFreeModel("fast"));
  assert.equal(f.ports.length, 1);
  assert.equal(f.ports[0]!.closed, false);
  await f.bridge.setModel(f.sessionId, "fast");
  await assert.rejects(() => f.bridge.setModel(f.sessionId, "paid"), /Free-only/);
  await f.evaluate(rendererBridgeForFreeModel("deep"));
  await assert.rejects(() => f.bridge.setModel(f.sessionId, "fast"), /Free-only/);
  await f.bridge.setModel(f.sessionId, "deep");
  await assert.rejects(() => f.evaluate(RENDERER_BRIDGE), /cannot relax/);
  await assert.rejects(() => f.bridge.setModel(f.sessionId, "paid"), /Free-only/);
  assert.equal(f.ports.length, 1);
  assert.equal(f.sends().length, 0);
});

test("policy refresh preserves an acknowledged in-flight turn, its busy exclusion and later native failure", async t => {
  const f = await fixture(t);
  let rejectTurn!: (error: Error) => void;
  f.handler = request => {
    if (request.channel !== "session:sendMessage") return f.defaultResponse(request);
    f.userEvent(WAKE_A);
    return new Promise((_, reject) => { rejectTurn = reject; });
  };
  assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A))).accepted, true);
  await f.evaluate(rendererBridgeForFreeModel("fast"));
  assert.equal((await f.bridge.inspect(f.sessionId)).state, "busy");
  assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_B, wakePrompt(WAKE_B))).accepted, false);
  rejectTurn(new Error("500 retained after policy refresh"));
  await new Promise(resolve => setImmediate(resolve));
  const observed = await f.bridge.inspect(f.sessionId);
  assert.match((observed.failure as { error: string }).error, /retained/);
  assert.equal(f.ports.length, 1);
  assert.equal(f.sends().length, 1);
});

test("upgrade retains legacy native activity instead of closing its transport", async t => {
  const f = await fixture(t); let closed = false; let busy = true;
  const old = f.bridge;
  f.seedLegacy({ revision: 7, inspect: async () => ({ state: busy ? "busy" : "idle", workspace: f.workspace }), close: () => { closed = true; } });
  await assert.rejects(() => f.evaluate(RENDERER_BRIDGE), /explicit free-only model policy/);
  assert.equal(f.ports.length, 1);
  await f.evaluate(rendererBridgeForFreeModel("fast"));
  const current = await f.evaluate("globalThis.__codexNativeQueueBridgeV2") as Bridge;
  assert.equal(closed, false);
  assert.equal((await current.inspect(f.sessionId)).state, "busy");
  assert.equal((await current.wakeIdle(f.sessionId, WAKE_B, wakePrompt(WAKE_B))).accepted, false);
  busy = false;
  assert.equal((await current.inspect(f.sessionId)).state, "idle");
  assert.notEqual(current, old);
  assert.equal(f.sends().length, 0);
});

test("concurrent first installation shares one bridge and cannot race away the free-only policy", async t => {
  const f = await fixture(t);
  f.seedLegacy(undefined);
  await Promise.all([f.evaluate(rendererBridgeForFreeModel("fast")), f.evaluate(rendererBridgeForFreeModel("fast"))]);
  assert.equal(f.ports.length, 2, "one original fixture port plus exactly one new installation");
  await assert.rejects(() => f.evaluate(RENDERER_BRIDGE), /cannot relax/);
  const current = await f.evaluate("globalThis.__codexNativeQueueBridgeV2") as Bridge;
  await assert.rejects(() => current.setModel(f.sessionId, "deep"), /Free-only/);
  assert.equal(f.sends().length, 0);
});

test("passive supervision never launches or restarts an offline native desktop", async () => {
  let launches = 0;
  const processControl: NativeDesktopProcessControl = { run: () => "", launch: () => { launches++; }, pause: async () => {} };
  const trigger = new NativeDesktopRpcTrigger({ cliElectronPath: path.join(os.tmpdir(), "fixture.exe") } as Config, 18491, true, processControl);
  try {
    assert.equal((await trigger.inspect("fixture-session", { readOnly: true })).state, "offline");
    assert.equal(launches, 0);
  } finally { trigger.close(); }
});

test("a failed acknowledged native turn retains its exact wake identity for supervision", async t => {
  const f = await fixture(t);
  let rejectTurn!: (error: Error) => void;
  f.handler = request => {
    if (request.channel !== "session:sendMessage") return f.defaultResponse(request);
    f.userEvent(WAKE_A);
    return new Promise((_, reject) => { rejectTurn = reject; });
  };
  assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A))).accepted, true);
  assert.equal((await f.bridge.inspect(f.sessionId)).state, "busy");
  rejectTurn(new Error("500 internal server error"));
  await new Promise(resolve => setImmediate(resolve));
  const native = await f.bridge.inspect(f.sessionId);
  assert.equal(native.state, "idle");
  assert.equal((native.failure as { wakeId: string }).wakeId, WAKE_A);
  assert.match((native.failure as { error: string }).error, /500/);
  assert.equal(f.sends().length, 1);
  f.session.pendingPermissions = [{}];
  assert.equal((await f.bridge.inspect(f.sessionId)).state, "waiting_input", "failure evidence cannot clear native pending permission");
});

async function fixture(t: { after(callback: () => void): void }) {
  const native = new NativeFixture();
  t.after(() => native.close());
  await native.ready;
  return native;
}

test('native model discovery filters unavailable models and switching verifies persisted selection without prompts',async t=>{
  const f=await fixture(t);f.session.model='fast';
  const available=await f.bridge.listModels(f.sessionId);
  assert.equal(available.currentModel,'fast');assert.deepEqual(Array.from(available.models,m=>m.id),['fast','deep','custom-local:own']);
  assert.equal((await f.bridge.setModel(f.sessionId,'deep')).model,'deep');assert.equal(f.session.model,'deep');assert.equal(f.sends().length,0);
  await assert.rejects(()=>f.bridge.setModel(f.sessionId,'missing'),/not available/);assert.equal(f.session.model,'deep');
  f.active=[{sessionId:f.sessionId}];await assert.rejects(()=>f.bridge.setModel(f.sessionId,'fast'),/finish/);assert.equal(f.session.model,'deep');
});

test('native model switch never reports success when configuration readback disagrees',async t=>{
  const f=await fixture(t);f.session.model='fast';f.handler=r=>r.channel==='session:updateConfig'?{}:f.defaultResponse(r);
  await assert.rejects(()=>f.bridge.setModel(f.sessionId,'deep'),/not confirmed/);assert.equal(f.sends().length,0);
});

test('invalid task model is rejected before sending any native prompt',async t=>{
  const f=await fixture(t);const response=await f.bridge.wakeIdle(f.sessionId,WAKE_A,wakePrompt(WAKE_A),'missing');
  assert.equal(response.accepted,false);assert.match(String(response.error),/not available/);assert.equal(f.sends().length,0);
});

test('wake switches model before dispatch and cannot overlap another configuration',async t=>{
  const f=await fixture(t);f.session.model='fast';
  f.handler=r=>{if(r.channel==='session:sendMessage'){assert.equal(f.session.model,'deep');f.userEvent(WAKE_A);}return f.defaultResponse(r);};
  assert.equal((await f.bridge.wakeIdle(f.sessionId,WAKE_A,wakePrompt(WAKE_A),'deep')).accepted,true);
  assert.equal(f.sends().length,1);assert.ok(f.requests.findIndex(r=>r.channel==='session:updateConfig')<f.requests.findIndex(r=>r.channel==='session:sendMessage'));
});

test("cold persisted session is busy when the native activity list has the pinned session", async (t) => {
  const f = await fixture(t);
  f.active = [{ sessionId: f.sessionId, cwd: f.workspace, status: "working", isProcessing: true }];
  const state = await f.bridge.inspect(f.sessionId);
  assert.equal(state.state, "busy");
  assert.equal(state.workspace, f.workspace);
  assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A))).accepted, false);
  assert.equal(f.sends().length, 0);
  assert.ok(f.requests.some((request) => request.channel === "daemon:getActiveSessions" && request.args.length === 0));
});

test("activity in the same workspace also excludes a wake for the pinned session", async (t) => {
  const f = await fixture(t);
  f.active = [{ sessionId: "other-native-session", cwd: f.workspace, status: "planning" }];
  assert.equal((await f.bridge.inspect(f.sessionId)).state, "busy");
  assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A))).accepted, false);
  assert.equal(f.sends().length, 0);
});

test("native pending input and tool or team activity cannot be cleared by a queue wake", async (t) => {
  const f = await fixture(t);
  for (const busy of [
    { pendingInputKind: "permission" },
    { pendingPermissions: [{ requestId: "native-permission" }] },
    { pendingQuestions: [{ toolCallId: "native-question" }] },
    { pendingElicitations: [{ elicitationId: "native-input" }] },
    { hasActiveToolCalls: true },
    { hasActiveTeamMembers: true },
    { isProcessing: true },
    { stopRequested: true },
    { status: "unknown" },
  ]) {
    f.session = { id: f.sessionId, sessionId: f.sessionId, cwd: f.workspace, status: "completed", ...busy };
    assert.notEqual((await f.bridge.inspect(f.sessionId)).state, "idle");
    assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A))).accepted, false);
  }
  assert.equal(f.sends().length, 0);
});

test("native acknowledgement admits exactly one send even for simultaneous duplicate wake calls", async (t) => {
  const f = await fixture(t);
  f.handler = (request) => {
    if (request.channel === "session:sendMessage") {
      f.userEvent(WAKE_A);
      return { stopReason: "end_turn" };
    }
    return f.defaultResponse(request);
  };
  const attempts = await Promise.all([
    f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A)),
    f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A)),
  ]);
  assert.ok(attempts.some((result) => result.accepted));
  assert.equal(f.sends().length, 1);
  assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A))).accepted, true);
  assert.equal(f.sends().length, 1, "completed backend response must not erase the wake acknowledgement");
  const send = f.sends()[0]!;
  assert.equal(send.args[0], f.sessionId);
  assert.equal(JSON.stringify(send.args[1]), JSON.stringify([{ type: "text", text: wakePrompt(WAKE_A) }]));
  const meta = send.args[2] as { "codebuddy.ai": Record<string, unknown> };
  assert.equal(meta["codebuddy.ai"].requestId, WAKE_A);
  assert.equal(meta["codebuddy.ai"].emitSyntheticUserPromptLive, true);
  assert.equal(meta["codebuddy.ai"].model, undefined);
});

test("history lookup loads exactly the pinned session and accepts its own replayed user marker", async (t) => {
  const f = await fixture(t);
  f.replay = [{ channel: `session:event:${f.sessionId}`, result: {
    sessionId: f.sessionId,
    update: { sessionUpdate: "user_message_chunk", content: [{ type: "text", text: wakePrompt(WAKE_A) }] },
    _meta: { "codebuddy.ai/rendererHistoryReplay": true },
  } }];
  assert.equal(await f.bridge.findWake(f.sessionId, WAKE_A), true);
  assert.equal(await f.bridge.findWake(f.sessionId, WAKE_B), false);
  for (const request of f.requests.filter((request) => ["session:get", "session:load"].includes(request.channel))) assert.equal(request.args[0], f.sessionId);
  const load = f.requests.find((request) => request.channel === "session:load")!;
  assert.equal((load.args[1] as { cwd: string }).cwd, f.workspace);
  assert.equal((load.args[1] as { forceRendererHistoryReplay: boolean }).forceRendererHistoryReplay, true);
  assert.equal(f.sends().length, 0);
  assert.equal(f.requests.some((request) => request.channel === "session:create"), false);
});

test("an acknowledged wake keeps the outgoing exclusion until the real native prompt completes", async (t) => {
  const f = await fixture(t);
  f.handler = (request) => {
    if (request.channel === "session:sendMessage") {
      f.userEvent(WAKE_A);
      return new Promise(() => {});
    }
    return f.defaultResponse(request);
  };
  assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A))).accepted, true);
  assert.equal((await f.bridge.inspect(f.sessionId)).state, "busy");
  assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_B, wakePrompt(WAKE_B))).accepted, false);
  assert.equal((await f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A))).accepted, true);
  assert.equal(f.sends().length, 1);
});

test("unrelated sessions and non-user events cannot acknowledge a native wake", async (t) => {
  const f = await fixture(t);
  f.userEvent(WAKE_A, "unrelated-session");
  f.event(`session:event:${f.sessionId}`, {
    sessionId: f.sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: wakePrompt(WAKE_A) }] },
    _meta: { "codebuddy.ai": { requestId: WAKE_A } },
  });
  await Promise.resolve();
  assert.equal(await f.bridge.findWake(f.sessionId, WAKE_A), false);
  assert.equal(f.sends().length, 0);
});

test("native send response without a matching user event remains uncertain", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A)), /receipt is uncertain/);
  assert.equal(f.sends().length, 1);
  assert.equal(await f.bridge.findWake(f.sessionId, WAKE_A), false);
});

test("native handler error is correlated and does not count as dispatch acceptance", async (t) => {
  const f = await fixture(t);
  f.handler = (request) => {
    if (request.channel === "session:sendMessage") throw new Error("Native session was deleted");
    return f.defaultResponse(request);
  };
  await assert.rejects(f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A)), /Native session was deleted/);
  assert.equal(f.sends().length, 1);
  assert.equal(await f.bridge.findWake(f.sessionId, WAKE_A), false);
});

test("uncorrelated response IDs do not resolve the current inspection", async (t) => {
  const f = await fixture(t);
  f.handler = (request) => {
    if (request.channel === "session:get") {
      for (const port of f.ports) port.postMessage({ kind: "message", json: { id: "unrelated-response", type: "response", channel: request.channel, args: [], result: { cwd: "/wrong-workspace", status: "working" } } });
    }
    return f.defaultResponse(request);
  };
  const result = await f.bridge.inspect(f.sessionId);
  assert.equal(result.state, "idle");
  assert.equal(result.workspace, f.workspace);
});

test("missing native session rejects before send or creation", async (t) => {
  const f = await fixture(t);
  f.session = {};
  await assert.rejects(f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A)), /session was not found/);
  assert.equal(f.sends().length, 0);
  assert.equal(f.requests.some((request) => request.channel === "session:create"), false);
});

class LifecycleFixture implements NativeDesktopProcessControl {
  readonly dir: string;
  readonly config: Config;
  readonly calls: Array<{ file: string; args: string[] }> = [];
  readonly launches: Array<{ executable: string; cdpPort: number; rootsAtLaunch: number[] }> = [];
  roots = [41001];
  port: "absent" | "foreign" | "multiple" | "unverifiable" = "absent";
  quitEffect: "exit" | "refuse" | "replacement" | "foreign" = "exit";
  pauses = 0;

  constructor(t: { after(callback: () => void): void }, statuses = ["completed"]) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-lifecycle-policy-"));
    const executable = path.join(this.dir, "WorkBuddy-fixture");
    fs.writeFileSync(executable, "Policy fixture, never executed");
    this.config = {
      backend: "desktop-queue", apiBaseUrl: "", tokenFile: "", dbFile: "", oauthRedirectUri: "", oauthPort: 1,
      oauthScopes: "", requestTimeoutMs: 1000, cliElectronPath: executable, cliScriptPath: "", cliPermissionMode: "",
      acpPermissionMode: "deny", gatewayUrl: "", workbuddyConfigDir: this.dir,
    };
    const db = new DatabaseSync(path.join(this.dir, "workbuddy.db"));
    db.exec("CREATE TABLE sessions(status TEXT, deleted_at INTEGER)");
    for (const status of statuses) db.prepare("INSERT INTO sessions VALUES (?, NULL)").run(status);
    db.close();
    t.after(() => fs.rmSync(this.dir, { recursive: true, force: true }));
  }

  run(file: string, args: string[]): string {
    this.calls.push({ file, args: [...args] });
    const absent = () => { throw Object.assign(new Error("No matching process"), { status: 1, stdout: "" }); };
    if (file === "/usr/sbin/lsof") {
      if (this.port === "absent") return absent();
      return this.port === "multiple" ? "p41001\np52001\n" : "p52001\n";
    }
    if (file === "/bin/ps" && args[0] === "-axo") return this.roots.map((pid) => `${pid} ${this.config.cliElectronPath}`).join("\n");
    if (file === "/bin/ps" && args[3] === "comm=") {
      if (this.port === "unverifiable") return absent();
      return "/Applications/Foreign-service.app/Contents/MacOS/Foreign-service\n";
    }
    if (file === "/bin/ps" && args[3] === "pid=") return this.roots.includes(Number(args[1])) ? `${args[1]}\n` : absent();
    if (file === "/usr/bin/osascript") {
      assert.deepEqual(args, ["-e", 'tell application id "com.tencent.workbuddy.mac" to quit']);
      if (this.quitEffect !== "refuse") this.roots = this.quitEffect === "replacement" ? [41002] : [];
      if (this.quitEffect === "foreign") this.port = "foreign";
      return "";
    }
    throw new Error(`Unexpected lifecycle command: ${file} ${args.join(" ")}`);
  }

  launch(executable: string, cdpPort: number) {
    this.launches.push({ executable, cdpPort, rootsAtLaunch: [...this.roots] });
    // The fixture never creates a native debugger. Discovery must report that
    // unavailable endpoint after recording the authorized lifecycle decision.
  }
  async pause() { this.pauses++; }
  quits() { return this.calls.filter((call) => call.file === "/usr/bin/osascript"); }
  discover() {
    const trigger = new NativeDesktopRpcTrigger(this.config, 18491, true, this);
    return (trigger as unknown as { discover(): Promise<string> }).discover();
  }
}

test("foreign, multiple, or unverifiable local port owners never cause native quit or launch", async (t) => {
  for (const port of ["foreign", "multiple", "unverifiable"] as const) {
    const f = new LifecycleFixture(t);
    f.port = port;
    await assert.rejects(f.discover(), /owner cannot be verified/);
    assert.equal(f.quits().length, 0);
    assert.equal(f.launches.length, 0);
    assert.deepEqual(f.roots, [41001]);
  }
});

test("setup restart uses the native application quit event and launches after the original root exits", { skip: process.platform === "win32" && "macOS lifecycle fixture" }, async (t) => {
  const f = new LifecycleFixture(t);
  await assert.rejects(f.discover(), /local RPC port did not become available/);
  assert.equal(f.quits().length, 1);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0]!.rootsAtLaunch, []);
  assert.equal(f.launches[0]!.executable, f.config.cliElectronPath);
  assert.equal(f.launches[0]!.cdpPort, 18491);
});

test("a native root refusing quit prevents replacement launch", { skip: process.platform === "win32" && "macOS lifecycle fixture" }, async (t) => {
  const f = new LifecycleFixture(t);
  f.quitEffect = "refuse";
  await assert.rejects(f.discover(), /did not finish its graceful setup restart/);
  assert.equal(f.quits().length, 1);
  assert.equal(f.launches.length, 0);
  assert.deepEqual(f.roots, [41001]);
  assert.equal(f.pauses, 40);
});

test("a replacement native root or newly occupied port prevents another launch", { skip: process.platform === "win32" && "macOS lifecycle fixture" }, async (t) => {
  for (const effect of ["replacement", "foreign"] as const) {
    const f = new LifecycleFixture(t);
    f.quitEffect = effect;
    await assert.rejects(f.discover(), /no replacement was launched/);
    assert.equal(f.quits().length, 1);
    assert.equal(f.launches.length, 0);
  }
});

test("active or unavailable persisted status evidence keeps the running desktop untouched", { skip: process.platform === "win32" && "macOS lifecycle fixture" }, async (t) => {
  for (const statuses of [["completed", "working"], ["pending"], ["unknown"]]) {
    const f = new LifecycleFixture(t, statuses);
    await assert.rejects(f.discover(), /Waiting for native WorkBuddy tasks/);
    assert.equal(f.quits().length, 0);
    assert.equal(f.launches.length, 0);
  }
  const f = new LifecycleFixture(t);
  fs.rmSync(path.join(f.dir, "workbuddy.db"));
  await assert.rejects(f.discover(), /Waiting for native WorkBuddy tasks/);
  assert.equal(f.quits().length, 0);
  assert.equal(f.launches.length, 0);
});

test("an initialized empty desktop history permits first-time port setup without manually creating a chat",{ skip: process.platform === "win32" && "macOS lifecycle fixture" },async t=>{
  const f=new LifecycleFixture(t,[]);
  await assert.rejects(f.discover(),/local RPC port did not become available/);
  assert.equal(f.quits().length,1);assert.equal(f.launches.length,1);
});

test("archived, terminated, and error historical sessions do not block an otherwise idle setup", { skip: process.platform === "win32" && "macOS lifecycle fixture" }, async (t) => {
  const f = new LifecycleFixture(t, ["Completed", "archived", "terminated", "error"]);
  await assert.rejects(f.discover(), /local RPC port did not become available/);
  assert.equal(f.quits().length, 1);
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0]!.rootsAtLaunch, []);
});


test('free-only deployment rejects paid, unknown-price and changed-price models before native execution', async t => {
  const f = new NativeFixture(rendererBridgeForFreeModel('deepseek-v4.1-flash'));
  t.after(() => f.close()); await f.ready;
  let credits = 'x0.00';
  f.handler = r => r.channel === 'config:getProductConfiguration'
    ? {models:[{id:'deepseek-v4.1-flash',name:'Flash',credits},{id:'deepseek-v4.1-flash-sg',name:'Flash',credits:'x0.03'}]}
    : f.defaultResponse(r);
  await f.bridge.setModel(f.sessionId,'deepseek-v4.1-flash');
  assert.equal(f.session.model,'deepseek-v4.1-flash');
  const updates = () => f.requests.filter(r => r.channel === 'session:updateConfig').length;
  const before = updates();
  await assert.rejects(() => f.bridge.setModel(f.sessionId,'deepseek-v4.1-flash-sg'), /Free-only policy/);
  for (const price of ['', 'x0.03']) {
    credits = price;
    await assert.rejects(() => f.bridge.setModel(f.sessionId,'deepseek-v4.1-flash'), /Free-only policy/);
    const result = await f.bridge.wakeIdle(f.sessionId, WAKE_A, wakePrompt(WAKE_A));
    assert.equal(result.accepted,false); assert.match(String(result.error), /Free-only policy/);
  }
  assert.equal(updates(),before); assert.equal(f.sends().length,0);
});


test('normal application restart leaves terminated sessions reusable only when native execution is idle', async t => {
  const f=await fixture(t); f.session.status='terminated';
  assert.equal((await f.bridge.inspect(f.sessionId)).state,'idle');
  f.active=[{sessionId:f.sessionId}];
  assert.equal((await f.bridge.inspect(f.sessionId)).state,'busy');
  f.active=[]; f.session.isProcessing=true;
  assert.equal((await f.bridge.inspect(f.sessionId)).state,'busy');
});


test("native cancellation targets only the verified latest session turn",async()=>{
 const f=new NativeFixture();await f.ready;
 const wake="wake-run-00000000-0000-0000-0000-000000000001";
 f.userEvent(wake);await new Promise(r=>setTimeout(r,0));
 f.handler=(request)=>request.channel==="session:cancel"?{success:true}:f.defaultResponse(request);
 await (f.bridge as any).cancelAttempt(f.sessionId,wake,f.workspace);
 assert.equal(JSON.stringify(f.requests.filter(r=>r.channel==="session:cancel").map(r=>r.args)),JSON.stringify([[f.sessionId]]));
 await assert.rejects(()=>(f.bridge as any).cancelAttempt(f.sessionId,wake,"/other"),/mismatch/);
 f.event(`session:event:${f.sessionId}`,{sessionId:f.sessionId,update:{sessionUpdate:"user_message_chunk",content:[{type:"text",text:"manual unrelated task"}]}});await new Promise(r=>setTimeout(r,0));
 await assert.rejects(()=>(f.bridge as any).cancelAttempt(f.sessionId,wake,f.workspace),/user turn changed/);
 assert.equal(f.requests.filter(r=>r.channel==="session:cancel").length,1);f.close();
});
