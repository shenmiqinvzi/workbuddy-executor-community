import fs from "node:fs";
import path from "node:path";
import type { TaskStore, StoredTask, TaskUpdate } from "./task-store.js";
import type { DshBinding } from "./dsh-bindings.js";
import type { DshTransport, DshSelection, DshSession } from "./dsh-client.js";
import type { ExecutionSelection } from "./task-contract.js";
import { validateSupportedTaskContract } from "./task-contract.js";
import { AdmissionError, defaultModelPolicy, enforceModelPolicy, type ModelObservation } from "./collaboration.js";
import { RunJournal, hasNativeStopEvidence, type RunSnapshot, writePrivateJson } from "./run-journal.js";
import { parseReport, runEvidenceDigestOf } from "./coordinator.js";
import { reportDigest } from "./report-authentication.js";
import { DeepSeekRpcError } from "./deepseek-client.js";
import { readTaskProjection } from "./task-view-reader.js";

import type { OperationOptions } from "./operation-admission.js";

type ModelRate = { credits: string | null; observedAt: string };
/** Trusted source metadata, separate from native selection verification. Missing
 * pricing stays unknown; only an explicit free-only policy requires a rate. */
export type DshRateObserver = (selection: ExecutionSelection) => Promise<ModelRate>;
/** Compatibility alias for integrations opting into a free-only policy. */
export type DshFreeRateVerifier = DshRateObserver;
const fail = (code: string, message: string): never => { throw new AdmissionError(code, message); };
const same = (a: DshSelection | null | undefined, b: DshSelection) => !!a && a.providerId === b.providerId && a.modelId === b.modelId && (a.reasoningEffort ?? null) === b.reasoningEffort;
const selection = (e: ExecutionSelection): DshSelection => ({ providerId: e.providerId, modelId: e.modelId, reasoningEffort: e.reasoningEffort });

/** Shared TaskStore owns business state. The transport owns native sessions,
 * durable request events and cancellation. No workflow/Reviewer is created. */
export class DshTaskCoordinator {
  constructor(readonly store: TaskStore, readonly client: DshTransport, readonly runsDir: string, private readonly observeRate?: DshRateObserver) {}
  policy() { return this.store.collaboration.currentPolicy(defaultModelPolicy()); }
  owns(taskId: string) { return !!this.store.dshBindings.forTask(taskId); }
  private task(taskId: string) { return this.store.get(taskId) ?? fail("TASK_NOT_FOUND", "No task has this identity."); }
  private binding(taskId: string) { return this.store.dshBindings.forTask(taskId) ?? fail("CONTRACT_INTEGRITY", "No original DSH binding is available."); }
  async discover(workspace: string, hostId?: string, sessionId?: string) {
    if (!path.isAbsolute(workspace)) return fail("WORKSPACE_CONFLICT", "Use an absolute project directory.");
    const canonical = fs.realpathSync.native(workspace), id = this.client.resolveHostId(hostId);
    const rows = await this.client.sessions(id);
    const candidates = rows.sessions.filter(item => {
      try { return item.attached === true && !!item.workspace && fs.realpathSync.native(item.workspace) === canonical; } catch { return false; }
    });
    const selected = sessionId ? candidates.find(item => item.sessionId === sessionId) : candidates.length === 1 ? candidates[0] : undefined;
    return { queriedDirectory: canonical, hostId: id, candidates, selected, reason: selected ? "matched" : sessionId ? "session_not_matched" : candidates.length ? "ambiguous" : "no_matching_session" };
  }
  async models(hostId: string) { return this.client.models(this.client.resolveHostId(hostId)); }
  private async checkedSession(binding: Pick<DshBinding, "hostId" | "sessionId">, workspace: string): Promise<DshSession> {
    const session = await this.client.session({ hostId: binding.hostId, sessionId: binding.sessionId });
    if (session.attached !== true) return fail("SESSION_NOT_LIVE", "The original DSH session is not attached; it will not be recreated or resumed automatically.");
    if (session.sessionId !== binding.sessionId || !session.workspace || fs.realpathSync.native(session.workspace) !== fs.realpathSync.native(workspace)) return fail("WORKSPACE_CONFLICT", "The original DSH session no longer matches its project.");
    if (session.busy) return fail("SESSION_BUSY", "The original DSH session has active or queued work.");
    return session;
  }
  private async observation(execution: ExecutionSelection, sessionId: string, taskId?: string): Promise<ModelObservation> {
    const requireFree = this.policy().requireFree || (taskId ? this.store.collaboration.getTaskAdmission(taskId)?.policy.requireFree === true : false);
    let rate: ModelRate = { credits: null, observedAt: new Date().toISOString() };
    if (!this.observeRate && requireFree) return fail("COST_VERIFICATION_UNAVAILABLE", "The optional free-only policy requires a trusted rate source.");
    if (this.observeRate) {
      try { rate = await this.observeRate(execution); }
      catch (error) {
        if (requireFree || !(error instanceof AdmissionError) || error.code !== "COST_VERIFICATION_UNAVAILABLE") throw error;
      }
    }
    if (!Number.isFinite(Date.parse(rate.observedAt)) || Math.abs(Date.now() - Date.parse(rate.observedAt)) > 30000) rate = { credits: null, observedAt: new Date().toISOString() };
    if (requireFree && (typeof rate.credits !== "string" || !/^x0(?:\.0+)?(?: credits)?$/i.test(rate.credits.trim()))) return fail("MODEL_UNVERIFIED", "The optional free-only policy requires a recent verified zero rate.");
    return { credits: rate.credits, observedAt: new Date().toISOString(), sessionId, modelId: execution.modelId, selectedModel: execution.modelId, providerId: execution.providerId, connectionId: execution.connectionId, reasoningEffort: execution.reasoningEffort, level: "selected" };
  }
  async send(input: { contract: unknown; sessionId: string; objective: string; hostId?: string; taskId?: string; workspace?: string } & OperationOptions) {
    input = structuredClone(input);
    const taskId = input.taskId ?? (input.contract as { taskId?: string })?.taskId;
    if (!taskId) return fail("INVALID_CONTRACT", "A stable contract taskId is required.");
    if (!input.operationId && this.store.get(taskId) && !this.store.operations.originalBinding(taskId)) return this.sendAdmitted(input);
    const { operationId, expectedRevision, expectedAttemptId, ...parameters } = input;
    return this.store.operations.run("send", taskId, "dsh", parameters, { operationId, expectedRevision, expectedAttemptId },
      { sessionId: input.sessionId, hostId: input.hostId ?? null, contract: input.contract }, () => this.sendAdmitted(input));
  }
  private async sendAdmitted(input: { contract: unknown; sessionId: string; objective: string; hostId?: string; taskId?: string; workspace?: string }) {
    if (typeof input.sessionId !== "string" || !input.sessionId.trim() || input.sessionId.length > 512) return fail("SESSION_REQUIRED", "Select an explicit original DSH session.");
    const valid = validateSupportedTaskContract(input.contract);
    if (!valid.ok || !("execution" in valid.contract) || valid.contract.execution.executorId !== "dsh") return fail("INVALID_CONTRACT", "DSH requires an explicit vnext-2 execution selection and authorized plan.");
    const { contract, contractHash } = valid;
    if (input.objective !== contract.objective || (input.taskId !== undefined && input.taskId !== contract.taskId)) return fail("TASK_CONFLICT", "The submission differs from its immutable contract.");
    const previous = this.store.get(contract.taskId);
    if (previous) {
      const saved = this.store.getContract(contract.taskId), binding = this.store.dshBindings.forTask(contract.taskId);
      if (input.workspace !== undefined && (!previous.workspace || fs.realpathSync.native(input.workspace) !== previous.workspace)) return fail("WORKSPACE_CONFLICT", "The supplied workspace differs from the original task.");
      if (saved.state !== "found" || saved.record.contractHash !== contractHash || !binding || binding.sessionId !== input.sessionId || (input.hostId && binding.hostId !== input.hostId)) return fail("TASK_CONFLICT", "The original task has different terms or session identity.");
      return { ok: true, created: false, task: previous };
    }
    const policy = this.policy(), admission = this.store.collaboration.prepare(contract, contractHash, policy, "dsh");
    if (input.workspace !== undefined && fs.realpathSync.native(input.workspace) !== admission.workspace.realPath) return fail("WORKSPACE_CONFLICT", "The supplied workspace differs from its immutable contract.");
    const hostId = this.client.resolveHostId(input.hostId ?? contract.execution.connectionId);
    if (contract.execution.connectionId !== hostId) return fail("MODEL_BINDING_CHANGED", "The selected connection is not this DSH host.");
    await this.checkedSession({ hostId, sessionId: input.sessionId }, admission.workspace.realPath);
    const catalog = await this.models(hostId), e = contract.execution;
    if (!catalog.models.some(m => m.providerId === e.providerId && m.modelId === e.modelId && (e.reasoningEffort === null || m.reasoningEfforts.includes(e.reasoningEffort)))) return fail("MODEL_UNVERIFIED", "The exact model or reasoning effort is absent from the host catalog.");
    await this.observation(e, input.sessionId);
    const binding: DshBinding = { taskId: contract.taskId, attemptId: RunJournal.newId(), requestId: "", hostId, sessionId: input.sessionId, execution: e, cursor: -1, runOpen: true, cancelRequested: false, dispatch: "preparing" };
    binding.requestId = binding.attemptId;
    const created = this.store.atomic(() => {
      const result = this.store.createTaskWithContract({ taskId: contract.taskId, messageId: `pending-${contract.taskId}`, objective: contract.objective, workspace: admission.workspace.realPath, sessionId: input.sessionId, state: "queued", submissionHash: contractHash,
        constraints: [`Allowed changes: ${JSON.stringify(contract.scope.allowedChanges)}`, `Permitted metadata: ${JSON.stringify(contract.scope.permittedMetadata)}`], acceptanceCommands: contract.requiredChecks.filter(check => check.kind === "command").map(check => check.definition) }, contract, { maxAttempts: policy.maxAttempts }, policy, "dsh");
      if (result.status === "existing_same") return false;
      if (result.status !== "created") return fail("TASK_CONFLICT", "The task could not be reserved with these terms.");
      this.store.dshBindings.reserve(binding); return true;
    });
    if (!created) return { ok: true, created: false, task: this.task(contract.taskId) };
    return this.dispatch(binding, undefined, true);
  }
  private async dispatch(binding: DshBinding, feedback?: string, prepare = false) {
    const task = this.task(binding.taskId), expected = selection(binding.execution);
    let promptCalled = false;
    try {
      enforceModelPolicy(this.policy(), binding.execution);
      const before = await this.checkedSession(binding, task.workspace!);
      this.store.operations.nativeBoundary(task.taskId, binding.attemptId);
      const ready = prepare && !same(before.selectedModel, expected) ? await this.client.selectModel({ hostId: binding.hostId, sessionId: binding.sessionId, ...expected }) : before;
      if (ready.sessionId !== binding.sessionId || !same(ready.selectedModel, expected)) return fail("MODEL_BINDING_CHANGED", "Native model readback differs; no prompt was sent.");
      await this.checkedSession(binding, task.workspace!);
      const model = await this.observation(binding.execution, binding.sessionId, binding.taskId);
      this.store.atomic(() => {
        const current = this.store.dshBindings.get(binding.attemptId)!;
        if (!current.runOpen || current.dispatch !== "preparing") return fail("READ_CONFLICT", "The preparation binding changed.");
        this.store.beginAttempt(task.taskId, { expectedRevision: task.revision ?? null, expectedAttemptId: task.attemptId ?? null, attemptId: binding.attemptId, messageId: binding.requestId, sessionId: binding.sessionId, runtimeSource: "dsh", modelObservation: model });
        this.store.dshBindings.update({ ...current, dispatch: "reserved" });
        const attempt = this.store.collaboration.getAttempt(binding.attemptId)!;
        const terms = this.store.getContract(task.taskId);
        if (terms.state !== "found") return fail("CONTRACT_INTEGRITY", "The immutable DSH contract is unavailable.");
        const journal = new RunJournal(this.runsDir, binding.attemptId);
        writePrivateJson(path.join(journal.dir, "request.json"), { taskId: task.taskId, attemptId: binding.attemptId, sessionId: binding.sessionId, workspace: task.workspace, model: binding.execution.modelId, timeoutSeconds: terms.record.contract.timeoutSeconds, deadline: attempt.deadlineAt });
        journal.save({ taskId: task.taskId, attemptId: binding.attemptId, driver: "dsh", runtimeSource: "dsh", sessionId: binding.sessionId, status: "queued", deadline: attempt.deadlineAt, dsh: { hostId: binding.hostId, requestId: binding.requestId, sessionId: binding.sessionId }, updatedAt: new Date().toISOString() });
        this.fold(task.taskId, journal);
      });
      const finalSession = await this.checkedSession(binding, task.workspace!);
      if (!same(finalSession.selectedModel, expected)) return fail("MODEL_BINDING_CHANGED", "The selection changed before prompt admission.");
      enforceModelPolicy(this.policy(), binding.execution);
      const deadline = this.store.collaboration.getAttempt(binding.attemptId)!.deadlineAt;
      if (Date.parse(deadline) <= Date.now()) return fail("DEADLINE_EXCEEDED", "The reserved deadline elapsed before admission.");
      this.store.operations.nativeBoundary(task.taskId, binding.attemptId);
      promptCalled = true;
      const result = await this.client.prompt({ hostId: binding.hostId, sessionId: binding.sessionId, requestId: binding.requestId, expectedSelection: expected,
        text: `Task ${task.taskId}; attempt ${binding.attemptId}.\n${task.objective}\n${(task.constraints ?? []).join("\n")}\nRequired checks: ${JSON.stringify(task.acceptanceCommands ?? [])}\nDeadline: ${deadline}. Do not extend or auto-retry. Use bounded foreground tools only; do not create background jobs, subagents or codex_workflow requests. Resolve permissions in the native UI; do not change permission policies. Return actual changes, checks and limitations; wait for independent review.${feedback ? `\nReview feedback: ${feedback}` : ""}` });
      if (result.requestId !== binding.requestId || result.accepted !== true) throw Error("unconfirmed");
      this.store.atomic(() => {
        const current = this.store.dshBindings.get(binding.attemptId)!;
        if (current.runOpen) this.store.dshBindings.update({ ...current, dispatch: "accepted", ...(result.turnId ? { turnId: result.turnId } : {}) });
      });
      return { ok: true, created: true, task: this.task(task.taskId) };
    } catch (error) {
      const rejected = promptCalled && error instanceof DeepSeekRpcError && error.admissionRejected;
      this.store.atomic(() => {
        const current = this.store.dshBindings.get(binding.attemptId)!;
        this.store.dshBindings.update({ ...current, dispatch: rejected ? "rejected" : "uncertain", runOpen: !rejected });
        const active = this.task(task.taskId);
        this.store.update(task.taskId, { state: "blocked", blockingReason: rejected ? "DSH rejected the request before native admission." : promptCalled ? "DSH dispatch outcome is unknown; observe the original request without resending." : "DSH model preparation did not complete; retain the original binding for inspection." });
        if (active.attemptId === binding.attemptId && rejected) {
          // Pre-admission rejection is not a fabricated native turn ending.
          const journal = new RunJournal(this.runsDir, binding.attemptId), snapshot = journal.snapshot()!;
          journal.save({ ...snapshot, status: "blocked", stopReason: "not_dispatched", nativeStopSource: "not_dispatched", nativeStoppedAt: new Date().toISOString(), dsh: { ...snapshot.dsh!, admissionRejected: true } }); this.fold(task.taskId, journal);
        }
      });
      return { ok: false, created: true, task: this.task(task.taskId), code: error instanceof AdmissionError ? error.code : rejected ? "DISPATCH_REJECTED" : "DISPATCH_UNCONFIRMED" };
    }
  }
  private fold(taskId: string, journal: RunJournal) {
    const snapshot = journal.snapshot()!;
    let cancellation: { requestedAt?: string; reason?: string } | undefined;
    try { cancellation = JSON.parse(fs.readFileSync(path.join(journal.dir, "cancel.json"), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.store.updateAttempt(taskId, journal.attemptId, { runEvidenceDigest: runEvidenceDigestOf(snapshot, cancellation) });
  }
  async sync(taskId: string, limit = 100): Promise<StoredTask> {
    const binding = this.binding(taskId), task = this.task(taskId);
    if (!binding.runOpen || !task.attemptId) return task;
    let page;
    try { page = await this.client.events({ hostId: binding.hostId, sessionId: binding.sessionId, requestId: binding.requestId, afterSeq: binding.cursor, limit: Math.max(1, Math.min(200, limit)) }); }
    catch { return this.store.updateAttempt(taskId, binding.attemptId, { blockingReason: "The original DSH source is unavailable; execution may continue. Do not resend." }).task; }
    if (!Number.isSafeInteger(page.cursor) || page.cursor < binding.cursor || !Array.isArray(page.events)) return fail("SOURCE_INVALID", "Invalid DSH event cursor.");
    let last = binding.cursor;
    for (const event of page.events) {
      if (event.requestId !== binding.requestId || !Number.isSafeInteger(event.seq) || event.seq <= last || event.seq > page.cursor) return fail("SOURCE_IDENTITY_MISMATCH", "DSH events do not belong to the original request or page order.");
      last = event.seq;
    }
    let cancelOriginal = false;
    const result = this.store.atomic(() => {
      let current = this.store.dshBindings.get(binding.attemptId)!;
      if (current.cursor !== binding.cursor || this.task(taskId).attemptId !== binding.attemptId) return fail("READ_CONFLICT", "The original DSH attempt advanced while observing.");
      const journal = new RunJournal(this.runsDir, binding.attemptId);
      let snapshot = journal.snapshot()!;
      if (snapshot?.taskId !== taskId || snapshot.attemptId !== binding.attemptId || snapshot.sessionId !== binding.sessionId || snapshot.driver !== "dsh") return fail("CONTRACT_INTEGRITY", "DSH run evidence belongs to another binding.");
      const reserved = this.store.collaboration.getAttempt(binding.attemptId);
      if (!reserved || reserved.taskId !== taskId || snapshot.deadline !== reserved.deadlineAt || snapshot.dsh?.hostId !== binding.hostId || snapshot.dsh.requestId !== binding.requestId) return fail("CONTRACT_INTEGRITY", "DSH evidence differs from its immutable request or deadline reservation.");
      for (const event of page.events) {
        if (current.turnId && event.turnId && current.turnId !== event.turnId) return fail("SOURCE_IDENTITY_MISMATCH", "The event belongs to a different native turn.");
        const data = event.data as { header?: { config?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } } | undefined;
        const config = event.rawType === "request/header" ? data?.header?.config : undefined;
        const patch: TaskUpdate = {};
        if (event.type === "started") { patch.state = "working"; snapshot.status = "working"; if (event.turnId) current = { ...current, turnId: event.turnId }; }
        if (event.type === "waiting_input") { patch.state = "blocked"; patch.inputRequested = true; patch.blockingReason = "DSH requires user input in its native UI."; snapshot.waitingInput = true; }
        if (config && typeof config.provider === "string" && typeof config.model === "string" && (config.reasoningEffort == null || typeof config.reasoningEffort === "string")) snapshot.dsh = { ...snapshot.dsh!, effectiveModel: { providerId: config.provider, modelId: config.model, reasoningEffort: config.reasoningEffort ?? null, seq: event.seq } };
        const effective = snapshot.dsh?.effectiveModel;
        const modelMatches = same(effective, selection(binding.execution));
        if (effective && !modelMatches) {
          patch.state = "blocked"; patch.blockingReason = "The native request model differs from its immutable selection."; snapshot.error = "model_binding_drift"; snapshot.status = "blocked";
          if (!current.cancelRequested) { current = { ...current, cancelRequested: true }; cancelOriginal = true; }
        }
        if (["completed", "failed", "cancelled"].includes(event.type)) {
          if ((event.rawType !== "turn/end" && !(event.type === "cancelled" && event.rawType === "agent/inbox/spliced")) || !event.timestamp || !Number.isFinite(Date.parse(event.timestamp)) || (current.turnId && event.turnId !== current.turnId)) return fail("SOURCE_IDENTITY_MISMATCH", "A terminal report is not a bound durable native stop event.");
          snapshot.nativeStoppedAt = event.timestamp; snapshot.nativeStopSource = "dsh_terminal_event"; snapshot.waitingInput = false;
          snapshot.dsh = { ...snapshot.dsh!, terminal: { seq: event.seq, type: event.type as "completed" | "failed" | "cancelled", rawType: event.rawType, at: event.timestamp, ...(event.turnId ? { turnId: event.turnId } : {}) } };
          current = { ...current, runOpen: false, terminalSeq: event.seq };
          const completed = event.type === "completed" && modelMatches && !snapshot.error && !!event.text?.trim() && !current.cancelRequested && Date.parse(event.timestamp) <= Date.parse(snapshot.deadline ?? "");
          snapshot.status = current.cancelRequested && ["deadline", "model_binding_drift"].includes(snapshot.error ?? "") ? "blocked" : current.cancelRequested || event.type === "cancelled" ? "cancelled" : completed ? "needs_review" : event.type === "failed" ? "failed" : "blocked";
          patch.state = snapshot.status;
          if (completed) {
            snapshot.text = event.text; snapshot.artifacts = []; snapshot.reportDigest = reportDigest({ status: "completed", text: event.text!, artifacts: [] });
            snapshot.reportAuthentication = { formatVersion: 2, taskId, attemptId: binding.attemptId, sessionId: binding.sessionId, runtimeSource: "dsh", reportedStatus: "completed", reportDigest: snapshot.reportDigest, authenticatedAt: new Date().toISOString(), dshProvenance: { hostId: binding.hostId, requestId: binding.requestId, eventSeq: event.seq } };
            patch.report = parseReport(event.text!); patch.artifacts = []; patch.blockingReason = null;
          } else patch.blockingReason = current.cancelRequested ? "Cancellation confirmed by the original native event." : "DSH stopped without a verified successful report and matching request model.";
        }
        if (Object.keys(patch).length) this.store.updateAttempt(taskId, binding.attemptId, patch);
        this.store.appendTaskEvent({ taskId, attemptId: binding.attemptId, type: config ? "native_request_observed" : `dsh_${event.type}`, occurredAt: event.timestamp ?? new Date().toISOString(), observedAt: new Date().toISOString(), actor: "dsh", payload: { nativeEventSeq: event.seq, requestId: binding.requestId, rawType: event.rawType ?? null, ...(event.text ? { text: event.text } : {}), ...(config ? { effectiveModel: snapshot.dsh?.effectiveModel ?? null } : {}) }, sourceRef: `${binding.attemptId}:dsh:${event.seq}` });
      }
      if (current.runOpen && !current.cancelRequested && Date.parse(snapshot.deadline ?? "") <= Date.now()) {
        current = { ...current, cancelRequested: true }; cancelOriginal = true;
        snapshot.status = "blocked"; snapshot.error = "deadline"; journal.cancel("deadline");
        this.store.updateAttempt(taskId, binding.attemptId, { state: "blocked", blockingReason: "The fixed DSH deadline elapsed; stop remains unconfirmed." });
        this.store.appendTaskEvent({ taskId, attemptId: binding.attemptId, type: "cancel_requested", occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(), actor: "supervisor", payload: { reason: "deadline" }, sourceRef: `${binding.attemptId}:deadline_cancel_requested` });
      }
      this.store.dshBindings.update({ ...current, cursor: page.cursor });
      journal.save(snapshot); this.fold(taskId, journal);
      if (hasNativeStopEvidence(snapshot)) this.store.appendTaskEvent({ taskId, attemptId: binding.attemptId, type: "native_stop_confirmed", occurredAt: snapshot.nativeStoppedAt!, observedAt: new Date().toISOString(), actor: "dsh", payload: { requestId: binding.requestId, nativeEventSeq: current.terminalSeq }, sourceRef: `${binding.attemptId}:native_stop_confirmed` });
      if (hasNativeStopEvidence(snapshot) && ["cancelled", "failed"].includes(this.task(taskId).state)) this.store.appendTaskEvent({ taskId, attemptId: binding.attemptId, type: "task_closed", occurredAt: snapshot.nativeStoppedAt!, observedAt: new Date().toISOString(), actor: "dsh", payload: { closedAs: this.task(taskId).state }, sourceRef: `${binding.attemptId}:task_closed` });
      return this.task(taskId);
    });
    if (cancelOriginal && this.binding(taskId).runOpen) { try { await this.client.cancel({ hostId: binding.hostId, sessionId: binding.sessionId, requestId: binding.requestId }); } catch { /* ownership remains until a native terminal event */ } }
    return result;
  }
  executionStatus(taskId: string) {
    const binding = this.binding(taskId), task = this.task(taskId), snapshot = task.attemptId ? new RunJournal(this.runsDir, task.attemptId).snapshot() : undefined;
    const remoteStopped = !binding.runOpen && snapshot?.dsh?.hostId === binding.hostId && snapshot.dsh.requestId === binding.requestId && hasNativeStopEvidence(snapshot);
    return { state: remoteStopped ? "stopped" : binding.cancelRequested ? "stop_unconfirmed" : snapshot?.waitingInput ? "waiting_input" : snapshot?.status ?? "unknown", remoteStopped, cancellationRequested: binding.cancelRequested, reportDigestPresent: !!snapshot?.reportDigest, observedAt: snapshot?.updatedAt, deadline: snapshot?.deadline, stopProofScope: "original_native_request" };
  }
  async cancel(taskId: string, reason?: string) {
    const task = this.task(taskId), binding = this.binding(taskId);
    if (!binding.runOpen || task.state === "accepted") return { ok: true, task, ...this.executionStatus(taskId) };
    this.store.atomic(() => {
      const current = this.binding(taskId); this.store.dshBindings.update({ ...current, cancelRequested: true });
      this.store.update(taskId, { cancelNote: reason ?? "Cancellation requested", state: "cancelled" });
      if (task.attemptId) { const journal = new RunJournal(this.runsDir, task.attemptId); journal.cancel("operator"); this.fold(taskId, journal); }
    });
    try { await this.client.cancel({ hostId: binding.hostId, sessionId: binding.sessionId, requestId: binding.requestId }); } catch { /* original native work stays owned */ }
    return { ok: true, task: this.task(taskId), ...this.executionStatus(taskId) };
  }
  async continue(input: { taskId: string; feedback: string; model?: string; timeoutSeconds?: number; acceptanceCommands?: string[] } & OperationOptions) {
    input = structuredClone(input);
    const { operationId, expectedRevision, expectedAttemptId, ...parameters } = input;
    return this.store.operations.run("rework", input.taskId, "dsh", parameters, { operationId, expectedRevision, expectedAttemptId },
      this.store.dshBindings.forTask(input.taskId), () => this.continueAdmitted(input));
  }
  private async continueAdmitted(input: { taskId: string; feedback: string; model?: string; timeoutSeconds?: number; acceptanceCommands?: string[] }) {
    if (!input.feedback.trim() || input.feedback.length > 20000) return fail("INVALID_FEEDBACK", "Provide bounded, concrete review feedback.");
    const task = await this.sync(input.taskId), previous = this.binding(input.taskId);
    const contract = this.store.getContract(task.taskId);
    if (previous.runOpen || !this.executionStatus(task.taskId).remoteStopped) return fail("STOP_UNCONFIRMED", "The original native request has not been confirmed stopped.");
    if (["accepted", "cancelled"].includes(task.state) || contract.state !== "found") return fail("TASK_CLOSED", "Closed or unbound tasks cannot be reworked.");
    if ((task.attempt ?? 0) >= Math.min(contract.record.effectiveMaxAttempts, this.policy().maxAttempts)) return fail("ATTEMPT_LIMIT", "The immutable attempt budget is exhausted.");
    if (input.model !== undefined || input.timeoutSeconds !== undefined || input.acceptanceCommands !== undefined) return fail("TASK_CONFLICT", "Rework cannot change the immutable execution terms.");
    const current = await this.checkedSession(previous, task.workspace!);
    if (!same(current.selectedModel, selection(previous.execution))) return fail("MODEL_BINDING_CHANGED", "The original session model changed; rework did not change it back.");
    const binding = { ...previous, attemptId: RunJournal.newId(), requestId: "", cursor: -1, runOpen: true, cancelRequested: false, dispatch: "preparing" as const, turnId: undefined, terminalSeq: undefined }; binding.requestId = binding.attemptId;
    this.store.atomic(() => { if (this.task(task.taskId).revision !== task.revision) return fail("READ_CONFLICT", "The task changed during rework preparation."); this.store.dshBindings.reserve(binding); });
    return this.dispatch(binding, input.feedback);
  }
  async accept(taskId: string, note: string, evidence: string[], artifactPaths: string[] = []) {
    const task = await this.sync(taskId), binding = this.binding(taskId), state = this.executionStatus(taskId);
    if (task.state === "accepted") return task;
    if (!state.remoteStopped || task.state !== "needs_review" || !state.reportDigestPresent || !task.report?.rawText.trim() || !note.trim() || !evidence.length || evidence.some(item => !item.trim()) || artifactPaths.length) return fail("REVIEW_REQUIRED", "Independent evidence for the stopped, authenticated current DSH report is required; artifact binding is not enabled here.");
    const projection = readTaskProjection({ store: this.store, runsDir: this.runsDir }, taskId);
    if (!projection.ok || projection.row.revision !== task.revision || projection.projection.facts?.report.state !== "authenticated") return fail("CONTRACT_INTEGRITY", "The current DSH report and revision could not be independently bound.");
    return this.store.atomic(() => {
      if (this.task(taskId).revision !== task.revision) return fail("READ_CONFLICT", "The task changed during review.");
      const accepted = this.store.acceptAttempt(taskId, binding.attemptId, { state: "accepted", reviewNote: note, reviewedAt: new Date().toISOString(), evidence }, { type: "task_closed", occurredAt: new Date().toISOString(), actor: "codex", payload: { closedAs: "accepted", reviewChannel: "coordinator_independent" }, sourceRef: `${binding.attemptId}:task_closed` }, { expectedStates: ["needs_review"] });
      if (!accepted.applied) return fail("READ_CONFLICT", "The current attempt changed during review.");
      return accepted.task;
    });
  }
}
