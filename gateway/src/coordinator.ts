import fs from "node:fs";
import { ensureWorkspace, listModels } from "./workspace-manager.js";
import { readDesktopSession } from "./desktop-runtime.js";
import { readWorkspaceWorkers } from "./workspace-workers.js";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.js";
import { TaskStore, type StoredTask, type TaskReport, type TaskState, type TaskUpdate } from "./task-store.js";
import { WorkBuddyClient, messageText } from "./workbuddy-client.js";
import { RunJournal, runsDirectory, hasNativeStopEvidence, type RunSnapshot } from "./run-journal.js";
import { readServiceRegistration } from "./persistent-service.js";
import { PersistentDesktopService, reconcileReportedAttempt, registeredServiceConfig } from "./persistent-service.js";
import { NativeDesktopRpcTrigger } from "./native-desktop-trigger.js";
import { verifyValidationEvidence } from "./worker-result.js";
import { snapshotReportDigest } from "./report-authentication.js";
import { validateSupportedTaskContract, contractExecution } from "./task-contract.js";
import { AdmissionError, defaultModelPolicy, enforceModelPolicy, type ModelObservation } from "./collaboration.js";

import type { OperationOptions } from "./operation-admission.js";

export interface SendTaskInput extends OperationOptions {
  taskId?: string; objective: string; workspace?: string; constraints?: string[]; acceptanceCommands?: string[];
  timeoutSeconds?: number; sessionId?: string; model?: string; sessionMode?: "existing" | "new";
  contract?: unknown;
}

async function observeSelectedModel(config: Config, sessionId: string, model: string): Promise<ModelObservation> {
  const result = await listModels(config, sessionId) as unknown as { models?: Array<{ id: string; credits?: unknown }>; currentModel?: string; sessionId?: string };
  const entry = result.models?.find(candidate => candidate.id === model);
  if (!entry || result.sessionId !== sessionId || result.currentModel !== model) throw new AdmissionError("MODEL_UNVERIFIED", "The selected native session, model catalog entry could not be verified.");
  return { sessionId, modelId: entry.id, selectedModel: result.currentModel, credits: typeof entry.credits === "string" ? entry.credits : null, observedAt: new Date().toISOString(), level: "selected" };
}
export class TaskCoordinator {
  constructor(private readonly config: Config, readonly store: TaskStore, private readonly client: WorkBuddyClient,
    private readonly resolveWorkspace: (config: Config, input: { workspace: string; sessionId?: string; title?: string; model?: string; workerKey?: string; admissionTaskId?: string }) => Promise<{ workspace: string; sessionId: string }> = ensureWorkspace,
    private readonly observeModel: (config: Config, sessionId: string, model: string) => Promise<ModelObservation> = observeSelectedModel) {}
  modelPolicy() { return this.store.collaboration.currentPolicy(defaultModelPolicy(this.config.maxTaskAttempts ?? 3)); }
  private requireDesktop(): void {
    if (!["desktop-acp", "desktop-queue"].includes(this.config.backend)) throw new Error("Desktop supervision requires WORKBUDDY_BACKEND=desktop-queue or desktop-acp. CLI and hidden gateway execution do not prove execution in your WorkBuddy desktop conversation.");
  }
  async send(input: SendTaskInput) {
    this.requireDesktop();
    input = structuredClone(input);
    const contractId = (input.contract as { taskId?: string } | undefined)?.taskId;
    const taskId = input.taskId ?? contractId ?? (input.operationId ? `codex-${crypto.createHash("sha256").update(input.operationId).digest("hex").slice(0, 32)}` : undefined);
    if (!taskId) throw new AdmissionError("OPERATION_REQUIRED", "Provide a stable taskId or operationId before dispatch.");
    // Historical same-task replay is a pure read, even when another workflow owns capacity.
    if (!input.operationId && this.store.get(taskId) && !this.store.operations.originalBinding(taskId)) return this.sendAdmitted({ ...input, taskId });
    const { operationId, expectedRevision, expectedAttemptId, ...terms } = input;
    const parameters = { ...terms, taskId, workspace: input.workspace ? path.resolve(input.workspace) : undefined, sessionMode: input.sessionMode ?? "existing", timeoutSeconds: input.timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 1800 };
    return this.store.operations.run("send", taskId, "workbuddy", parameters, { operationId, expectedRevision, expectedAttemptId },
      { backend: this.config.backend, sessionId: input.sessionId ?? null, contract: input.contract ?? null, model: input.model ?? null, maxAttempts: this.config.maxTaskAttempts ?? 3, timeoutSeconds: input.timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 1800 }, () => this.sendAdmitted({ ...input, taskId }));
  }
  private async sendAdmitted(input: SendTaskInput) {
    this.requireDesktop();
    if (input.contract !== undefined) return this.sendWithContract(input);
    const taskId = input.taskId ?? `codex-${crypto.randomUUID()}`;
    // Hash the caller's initial contract before automatic workspace/session routing.
    const submissionHash = crypto.createHash("sha256").update(JSON.stringify({
      objective: input.objective, workspace: input.workspace ? path.resolve(input.workspace) : null,
      sessionId: input.sessionId ?? null, constraints: input.constraints ?? [], acceptanceCommands: input.acceptanceCommands ?? [],
      model: input.model ?? null, sessionMode: input.sessionMode ?? "existing", timeoutSeconds: input.timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 1800,
    })).digest("hex");
    const reuse = (previous: StoredTask) => {
      // Legacy rows have no original fingerprint: reject observable conflicts,
      // never invent a contract from the mutable current rework attempt.
      const conflict = previous.submissionHash ? previous.submissionHash !== submissionHash :
        previous.objective !== input.objective ||
        (input.workspace !== undefined && path.resolve(input.workspace) !== (previous.workspace ? path.resolve(previous.workspace) : undefined)) ||
        (input.sessionId !== undefined && input.sessionId !== previous.sessionId) ||
        (input.constraints !== undefined && JSON.stringify(input.constraints) !== JSON.stringify(previous.constraints ?? []));
      if (conflict) throw new Error("Task ID conflicts with its original submission; inspect the existing task with get/wait and use continue after verified stop for corrections. Do not change keys to bypass unresolved work.");
      return { ok: true, created: false, task: previous, message: "Task already exists; no second prompt was dispatched. Use get/wait or continue after review." };
    };
    const previous = this.store.get(taskId);
    if (previous) return reuse(previous);
    if (input.workspace && (!path.isAbsolute(input.workspace) || !fs.statSync(input.workspace).isDirectory())) throw new Error("workspace must be an existing absolute directory");
    if (this.config.backend === "desktop-queue"&&input.sessionMode!=='new') {
      const registration = readServiceRegistration(this.config.serviceConfigFile ?? path.join(path.dirname(this.config.dbFile), "persistent-service.json"));
      if (registration && path.resolve(registration.dbFile) === path.resolve(this.config.dbFile)) {
        if(!input.workspace&&!input.sessionId&&new Set(readWorkspaceWorkers(this.config,registration).filter(worker=>worker.selected).map(worker=>worker.workspace)).size>1)throw new Error("Several project workspaces are registered; provide workspace or sessionId instead of silently using the legacy default");
        const workspace=input.workspace??(input.sessionId?readDesktopSession(this.config.workbuddyConfigDir,input.sessionId).cwd:registration.workspace);
        if(!workspace)throw new Error("Cannot determine the chosen native session workspace");
        this.store.operations.nativeBoundary(taskId);
        const selected=await this.resolveWorkspace(this.config,{workspace,sessionId:input.sessionId,admissionTaskId:taskId});
        input={...input,workspace:selected.workspace,sessionId:selected.sessionId};
      } else if(input.workspace&&!input.sessionId) {
        this.store.operations.nativeBoundary(taskId);
        const selected=await this.resolveWorkspace(this.config,{workspace:input.workspace,admissionTaskId:taskId});
        input={...input,workspace:selected.workspace,sessionId:selected.sessionId};
      }
    }
    const initial = this.store.createOrGet({ taskId, submissionHash, messageId: `pending-${taskId}`, objective: input.objective, workspace: input.workspace, constraints: input.constraints, acceptanceCommands: input.acceptanceCommands, state: "queued", sessionId: input.sessionId });
    if (!initial.created) return reuse(initial.task);
    return this.dispatch(initial.task, buildTaskPrompt({ ...input, taskId, timeoutSeconds: input.timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 1800 }), input);
  }
  private async sendWithContract(input: SendTaskInput) {
    if (this.config.backend !== "desktop-queue") throw new AdmissionError("EXECUTOR_CAPABILITY_MISSING", "Contract dispatch requires the verified desktop-queue adapter.");
    const validated = validateSupportedTaskContract(input.contract);
    if (!validated.ok) throw new AdmissionError("INVALID_CONTRACT", `${validated.rejection.code}: ${validated.rejection.field}`);
    const { contract, contractHash } = validated;
    const execution = contractExecution(contract);
    if ((input.taskId !== undefined && input.taskId !== contract.taskId) || input.objective !== contract.objective ||
        (input.model !== undefined && input.model !== execution.modelId) || (input.timeoutSeconds !== undefined && input.timeoutSeconds !== contract.timeoutSeconds) ||
        input.constraints !== undefined || input.acceptanceCommands !== undefined || input.sessionMode === "new") throw new AdmissionError("TASK_CONFLICT", "Legacy overrides cannot change contract terms.");
    const previous = this.store.get(contract.taskId);
    if (previous) {
      const saved = this.store.getContract(contract.taskId);
      if (saved.state !== "found" || saved.record.contractHash !== contractHash || (input.sessionId !== undefined && previous.sessionId !== input.sessionId)) throw new AdmissionError("TASK_CONFLICT", "The task already has different or unavailable contract terms.");
      return { ok: true, created: false, task: previous, message: "The original task is retained; no model preparation or dispatch was repeated." };
    }
    const policy = this.modelPolicy();
    const admission = this.store.collaboration.prepare(contract, contractHash, policy);
    if (input.workspace !== undefined && fs.realpathSync.native(input.workspace) !== admission.workspace.realPath) throw new AdmissionError("WORKSPACE_CONFLICT", "The supplied directory differs from the registered project.");
    const commands = contract.requiredChecks.filter(check => check.kind === "command").map(check => check.definition);
    const constraints = [`Allowed changes: ${JSON.stringify(contract.scope.allowedChanges)}`, `Permitted metadata: ${JSON.stringify(contract.scope.permittedMetadata)}`];
    const initial = this.store.createTaskWithContract({ taskId: contract.taskId, messageId: `pending-${contract.taskId}`, objective: contract.objective,
      workspace: admission.workspace.realPath, constraints, acceptanceCommands: commands, sessionId: input.sessionId, state: "queued", submissionHash: contractHash },
    contract, { maxAttempts: policy.maxAttempts }, policy);
    if (initial.status === "existing_same") return { ok: true, created: false, task: initial.task };
    if (initial.status !== "created") throw new AdmissionError("TASK_CONFLICT", "The task could not be created with these immutable terms.");
    // The winning creator persists its terms BEFORE model preparation. A crash
    // or unknown preparation result never permits a replay to prepare again.
    try {
      this.store.operations.nativeBoundary(contract.taskId);
      const selected = await this.resolveWorkspace(this.config, { workspace: admission.workspace.realPath, sessionId: input.sessionId, title: contract.title, model: execution.modelId, workerKey: contract.taskId, admissionTaskId: contract.taskId });
      if (fs.realpathSync.native(selected.workspace) !== admission.workspace.realPath) throw new AdmissionError("WORKSPACE_CONFLICT", "Native routing returned a different project.");
      this.store.update(contract.taskId, { sessionId: selected.sessionId });
      const modelObservation = await this.observeModel(this.config, selected.sessionId, execution.modelId);
      const task = this.requireTask(contract.taskId);
      return await this.dispatch(task, buildTaskPrompt({ taskId: task.taskId, objective: task.objective, workspace: task.workspace, constraints, acceptanceCommands: commands, timeoutSeconds: contract.timeoutSeconds }),
        { sessionId: selected.sessionId, model: execution.modelId, timeoutSeconds: contract.timeoutSeconds, acceptanceCommands: commands, modelObservation });
    } catch (error) {
      const task = this.requireTask(contract.taskId);
      if (!task.attemptId) this.store.update(task.taskId, { state: "blocked", blockingReason: "Contract preparation failed; inspect the original task before any recovery." });
      throw error;
    }
  }

  private async dispatch(task: StoredTask, prompt: string, input: { timeoutSeconds?: number; sessionId?: string; model?: string; sessionMode?: "existing" | "new"; acceptanceCommands?: string[]; modelObservation?: ModelObservation }) {
    const attemptId = RunJournal.newId();
    this.store.beginAttempt(task.taskId, { expectedRevision: task.revision ?? null, expectedAttemptId: task.attemptId ?? null, attemptId, messageId: attemptId, sessionId: input.sessionId, acceptanceCommands: input.acceptanceCommands, modelObservation: input.modelObservation });
    const reserved = this.store.collaboration.getAttempt(attemptId);
    // A reservation is not execution provenance. The actual worker supplies it.
    this.store.updateAttempt(task.taskId, attemptId, { runtimeSource: null });
    try {
      if(this.config.backend==='desktop-queue'&&input.sessionMode==='new')throw new Error("Use workspace or ensure_workspace for native project routing; sessionMode:new is not supported by the queue");
      this.store.operations.nativeBoundary(task.taskId, attemptId);
      await this.client.sendMessage(prompt, task.workspace, input.timeoutSeconds, input.sessionId ?? task.sessionId, { taskId: task.taskId, attemptId, model: input.model, sessionMode: input.sessionMode, deadline: reserved?.deadlineAt });
      // T2-R1 round 3: the queue writes the attempt's state.json during
      // dispatch, so the row must not be persisted BEHIND its own run file —
      // otherwise a plain read of a freshly dispatched task would refuse the
      // file's (dispatch-stage or later) facts against a revision persisted
      // before they existed. Fold the just-written snapshot's evidence into
      // the row now; the folded queued digest carries stopped:false, so it
      // can never suppress the new round's native_stop_confirmed.
      const dispatched = this.store.get(task.taskId);
      if (dispatched) return { ok: true, created: true, task: this.recordRunEvidence(dispatched), next: "Use bounded workbuddy_wait calls. Stop on errors, permission waits or deadline; do not redispatch or ask the worker to debug the gateway. Inspect artifacts and accept only with independent evidence." };
      throw new Error("The reserved task disappeared during dispatch.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const journal = new RunJournal(runsDirectory(this.config), attemptId);
      journal.save({ ...journal.snapshot(), attemptId, taskId: task.taskId, status: "blocked", sessionId: input.sessionId ?? task.sessionId, error: message, updatedAt: new Date().toISOString() });
      journal.append("result", `TASK_STATUS: blocked\n${message}`, { status: "blocked", blockedReason: message, sessionId: input.sessionId ?? task.sessionId });
      const result = this.store.updateAttempt(task.taskId, attemptId, { state: "blocked", blockingReason: message });
      return { ok: false, task: result.task, error: message };
    }
  }
  async sync(taskId: string, limit = 100): Promise<StoredTask> {
    const task = this.requireTask(taskId);
    // Terminal business states keep their protection (no re-dispatch, no new
    // business-state writes — updateAttempt/preserveTerminal still guard
    // that), but T2-R3: real evidence for the same attempt that arrives after
    // a cancel/accept must still be collected, mirrored, and its consumption
    // position persisted. Skipping the cursor advance left a terminal task
    // re-reading the same first page forever, so later journal events (the
    // worker's cancelled report, the native stop proof) were never delivered
    // and the task never closed.
    const terminal = task.state === "accepted" || task.state === "cancelled";
    // Historical closed tasks can retain their durable report/messages after
    // their run directory was removed. Do not turn reading that history into
    // an attempt to consume a nonexistent journal. Later evidence is still
    // collected whenever a snapshot exists for the same attempt.
    if (terminal && (!task.attemptId || !/^run-[a-f0-9-]{36}$/.test(task.attemptId) || !this.client.runSnapshot(task.attemptId))) return task;
    const messages = await this.client.messages({ afterMessageId: task.lastMessageId, limit });
    if (!messages.length) {
      // Nothing new on the wire; still reconcile run-file evidence (a stop
      // proof may have appeared without any message) and, for terminal tasks
      // whose evidence is complete, close the task exactly once.
      const evidenced = this.recordRunEvidence(task);
      return terminal ? this.closeTerminalTask(evidenced) : evidenced;
    }
    this.store.addMessages(taskId, messages);
    // Mirror per-attempt journal events into the persistent task event stream.
    // Dedup is by attempt+type+journal seq, so replaying the same native event
    // never produces a second logical event. This mirrors only; it fabricates
    // no events for gaps and writes nothing on plain reads without messages.
    const journalEvents = messages
      .filter((message) => {
        const meta = message.metadata ?? {};
        return typeof meta.eventSeq === "number" && typeof meta.type === "string" &&
          (!task.attemptId || !meta.attemptId || meta.attemptId === task.attemptId);
      })
      .map((message) => {
        const meta = message.metadata ?? {};
        // T2-R2: each journal event carries the text of the message that
        // reported it, so mirrored payloads never borrow another message's
        // content (a batch may hold the permission request AND the report).
        return { seq: Number(meta.eventSeq), type: String(meta.type), createdAt: message.created_at ?? new Date(0).toISOString(), metadata: meta, contentText: messageText(message) };
      });
    if (journalEvents.length && task.attemptId) {
      // T2-R2: preserve the source message content when the journal metadata
      // carries no text of its own (e.g. synthetic permission requests).
      this.store.mirrorJournalEvents(taskId, journalEvents, {
        attemptId: task.attemptId,
        actor: "workbuddy",
        contentText: messages.map((message) => messageText(message)).find((text) => text.trim()) ?? undefined,
      });
    }
    if (terminal) {
      // Same-attempt evidence after the terminal decision: mirror only. No
      // business-state patch is applied; the attempt guard below refuses
      // state writes anyway. T2-R3: the consumption cursor still advances
      // (persisted, never regressed) so the next sync reads past what this
      // one already mirrored, and the stop proof closes the task once.
      const cursor: TaskUpdate = {};
      const lastMessage = messages[messages.length - 1]!;
      if (lastMessage.message_id !== task.lastMessageId) cursor.lastMessageId = lastMessage.message_id;
      const seqs = messages.map((message) => (message.metadata ?? {}).eventSeq).filter((value): value is number => typeof value === "number");
      const highestSeq = seqs.length ? Math.max(...seqs) : null;
      if (highestSeq !== null && highestSeq > (task.lastEventSeq ?? 0)) cursor.lastEventSeq = highestSeq;
      const current = task.attemptId
        ? this.store.updateAttempt(taskId, task.attemptId, cursor).task
        : Object.keys(cursor).length ? this.store.update(taskId, cursor) : task;
      return this.closeTerminalTask(this.recordRunEvidence(current));
    }
    // T2-R2: apply each message as its own patch instead of merging the
    // whole batch. Merging collapsed intermediate facts (a waiting_input
    // that was answered later in the same batch never produced
    // input_requested/input_resolved), and it attributed one shared
    // contentText to every mirrored journal event. Per-message writes keep
    // event semantics and source text bound to the exact message.
    for (const message of messages) {
      const meta = message.metadata ?? {};
      if (task.attemptId && meta.attemptId && meta.attemptId !== task.attemptId) continue;
      const patch: TaskUpdate = { lastMessageId: message.message_id };
      if (typeof meta.eventSeq === "number") patch.lastEventSeq = meta.eventSeq;
      if (typeof meta.sessionId === "string") patch.sessionId = meta.sessionId;
      if (typeof meta.runtimeSource === "string") patch.runtimeSource = meta.runtimeSource;
      if (meta.type === "status" && meta.reportPreserved === true && task.attemptId) {
        const snapshot = this.client.runSnapshot(task.attemptId);
        if (snapshot?.status !== "needs_review" || !snapshot.reportDigest || !snapshot.postReportFailure ||
            snapshot.taskId !== task.taskId || snapshot.sessionId !== task.sessionId || snapshot.runtimeSource !== "desktop_queue" || !snapshot.text?.trim()) throw Error("Preserved report does not match the authenticated task attempt");
        patch.state = "needs_review"; patch.blockingReason = null;
        patch.report = parseReport(snapshot.text); patch.artifacts = snapshot.artifacts ?? [];
      }
      if (meta.status === "waiting_input") {
        patch.state = "blocked";
        patch.blockingReason = messageText(message);
        // The worker explicitly asked for input: this is the only source the
        // event stream may label input_requested (T2-R2).
        patch.inputRequested = true;
      } else if (meta.status === "working" || meta.status === "queued") { patch.state = meta.status; patch.blockingReason = null; }
      if (meta.type === "result" || message.role === "assistant") {
        const report = parseReport(messageText(message));
        patch.report = report;
        const declared = typeof meta.status === "string" ? meta.status : report.status;
        patch.state = declared === "completed" || declared === "needs_review" ? "needs_review" : ["blocked", "failed", "cancelled"].includes(declared ?? "") ? declared as TaskState : "blocked";
        // A blocked report is a worker failure unless the metadata explicitly
        // names it as an input request; the report text itself is not proof
        // of an input request (T2-R2).
        patch.blockingReason = typeof meta.blockedReason === "string" ? meta.blockedReason : patch.state === "blocked" ? report.rawText : null;
        // T2-R2 round 3: blockedReason is a generic failure reason (claim
        // timeouts, dispatch errors and worker failures all carry it), so it
        // never proves the worker asked for user input. Only the explicit
        // waiting_input status above may set inputRequested; a timeout keeps
        // its failure facts without a fabricated input request.
        patch.inputRequested = false;
        if (Array.isArray(meta.artifacts)) patch.artifacts = meta.artifacts.filter((value): value is string => typeof value === "string");
      }
      const stepped = task.attemptId ? this.store.updateAttempt(taskId, task.attemptId, patch).task : this.store.update(taskId, patch);
      void stepped;
    }
    const updated = this.requireTask(taskId);
    return this.recordRunEvidence(updated);
  }

  /**
   * Close a cancelled/accepted task exactly once (T2-R3): once the business
   * terminal decision AND the native stop proof are both on record, record
   * the durable closure event. Dedup is by sourceRef (attempt+type), so
   * repeated syncs never duplicate it; no business state changes here and no
   * worker is re-dispatched. A terminal task without stop evidence stays
   * open until that proof arrives.
   */
  private closeTerminalTask(task: StoredTask): StoredTask {
    if (task.state !== "accepted" && task.state !== "cancelled") return task;
    if (!task.attemptId || !/^run-[a-f0-9-]{36}$/.test(task.attemptId)) return task;
    if (!hasNativeStopEvidenceFromDigest(task.runEvidenceDigest)) return task;
    this.store.appendTaskEvent({
      taskId: task.taskId, attemptId: task.attemptId, type: "task_closed",
      occurredAt: task.updatedAt, observedAt: new Date().toISOString(), actor: task.state === "accepted" ? "codex" : "gateway",
      payload: { closedAs: task.state, attempt: task.attempt ?? null },
      sourceRef: `${task.attemptId}:task_closed`,
    });
    return task;
  }

  /**
   * Fold the current run snapshot's stop/authentication evidence into the
   * task row (T2-R1): the digest is part of the fact signature, so stop
   * evidence appearing or changing regenerates the revision without any task
   * business field changing. First-time confirmed stop proof also records the
   * contract's native_stop_confirmed event, deduplicated by sourceRef.
   * Plain reads without a snapshot write nothing.
   */
  private recordRunEvidence(task: StoredTask): StoredTask {
    if (!task.attemptId || !/^run-[a-f0-9-]{36}$/.test(task.attemptId)) return task;
    const snapshot = this.client.runSnapshot(task.attemptId);
    // A reused or corrupt journal is not this task's evidence.
    if (!snapshot || snapshot.taskId !== task.taskId || snapshot.attemptId !== task.attemptId ||
        (task.sessionId && snapshot.sessionId !== task.sessionId)) return task;
    let cancellation: { requestedAt?: string; reason?: string } | undefined;
    try {
      cancellation = JSON.parse(fs.readFileSync(path.join(runsDirectory(this.config), task.attemptId, "cancel.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const digest = runEvidenceDigestOf(snapshot, cancellation);
    const stopped = JSON.parse(digest).stopped === true;
    const current = this.requireTask(task.taskId);
    // T2-R2: the stop event is emitted once per ATTEMPT. The stored digest is
    // bound to its attemptId, so a previous round's stop proof can never
    // suppress this round's confirmation.
    if (stopped && !digestRecordsStopFor(current.runEvidenceDigest, current.attemptId)) {
      this.store.appendTaskEvent({
        taskId: task.taskId, attemptId: task.attemptId, type: "native_stop_confirmed",
        occurredAt: snapshot.nativeStoppedAt ?? snapshot.updatedAt ?? new Date().toISOString(),
        observedAt: new Date().toISOString(), actor: "workbuddy",
        payload: { stopReason: snapshot.stopReason ?? null, nativeStoppedAt: snapshot.nativeStoppedAt ?? null, digest },
        sourceRef: `${task.attemptId}:native_stop:${snapshot.nativeStoppedAt ?? "evidence"}`,
      });
    }
    if (digest === current.runEvidenceDigest) return current;
    // The evidence digest is a fact: changing it regenerates the revision.
    // No business field (state/report/session) changes here; terminal tasks
    // keep their state because the patch carries no state change.
    return task.attemptId ? this.store.updateAttempt(task.taskId, task.attemptId, { runEvidenceDigest: digest }).task : current;
  }
  async continue(input: { taskId: string; feedback: string; acceptanceCommands?: string[]; timeoutSeconds?: number; model?: string } & OperationOptions) {
    input = structuredClone(input);
    const { operationId, expectedRevision, expectedAttemptId, ...parameters } = input;
    const task = this.store.get(input.taskId);
    return this.store.operations.run("rework", input.taskId, "workbuddy", parameters, { operationId, expectedRevision, expectedAttemptId },
      { sessionId: task?.sessionId ?? null, admission: this.store.collaboration.getTaskAdmission(input.taskId) }, () => this.continueAdmitted(input));
  }
  private async continueAdmitted(input: { taskId: string; feedback: string; acceptanceCommands?: string[]; timeoutSeconds?: number; model?: string }) {
    this.requireDesktop();
    const task = await this.sync(input.taskId);
    if (task.state === "cancelled") throw new Error("Cancelled tasks cannot be continued; create a new task");
    const storedContract = this.store.getContract(task.taskId);
    if (storedContract.state === "integrity_failure") throw new AdmissionError("CONTRACT_INTEGRITY", "The task contract failed integrity verification.");
    const original = this.store.operations.originalBinding(task.taskId) as { model?: string; maxAttempts?: number; timeoutSeconds?: number; backend?: string } | null;
    if (original?.backend && original.backend !== this.config.backend) throw new AdmissionError("EXECUTOR_UNAVAILABLE", "Rework must use the original native adapter.");
    const originalSession = this.store.operations.originalSession(task.taskId);
    if (originalSession && task.sessionId !== originalSession) throw new AdmissionError("MODEL_BINDING_CHANGED", "Rework cannot change its original native session.");
    const attemptLimit = storedContract.state === "found" ? storedContract.record.effectiveMaxAttempts : Math.min(this.config.maxTaskAttempts ?? 3, original?.maxAttempts ?? this.config.maxTaskAttempts ?? 3);
    if ((task.attempt ?? 0) >= attemptLimit) throw new Error("Task attempt limit reached. Stop retrying and review the failure and existing files before changing the configured budget.");
    if (!task.sessionId) throw new Error("No verified desktop session is bound. Inspect the old run and start a new task with an explicit WorkBuddy sessionId.");
    if (task.attemptId) {
      const snapshot = this.client.runSnapshot(task.attemptId);
      if (snapshot && ["queued", "working"].includes(snapshot.status)) throw new Error(snapshot.waitingInput ? "WorkBuddy is waiting for input. Use workbuddy_respond_task; a new prompt would overlap the active turn." : "This task still has an active worker; wait or cancel before sending rework.");
      if (!hasNativeStopEvidence(snapshot) && (task.runtimeSource === "desktop_queue" ||
          (snapshot?.driver === "desktop-queue" && ["claim.json", "wake.json"].some(file => fs.existsSync(path.join(runsDirectory(this.config), task.attemptId!, file)))))) throw new Error("The desktop attempt stopped reporting but its execution has not been confirmed stopped. Inspect the native session before rework.");
    }
    if (storedContract.state === "absent" && input.model !== undefined && input.model !== original?.model) throw new AdmissionError("MODEL_BINDING_CHANGED", "Rework cannot change the originally selected model.");
    if (storedContract.state === "absent") {
      if (original?.timeoutSeconds && input.timeoutSeconds !== undefined && input.timeoutSeconds > original.timeoutSeconds) throw new AdmissionError("TASK_CONFLICT", "Rework cannot extend its original duration budget.");
      input = { ...input, model: original?.model ?? input.model, timeoutSeconds: input.timeoutSeconds ?? original?.timeoutSeconds };
    }
    let modelObservation: ModelObservation | undefined;
    if (storedContract.state === "found") {
      const execution = contractExecution(storedContract.record.contract);
      if (!this.store.collaboration.getTaskAdmission(task.taskId)) throw new AdmissionError("MODEL_UNVERIFIED", "This historical storage-only contract has no trusted dispatch admission; it cannot be promoted by rework.");
      if ((input.model !== undefined && input.model !== execution.modelId) || (input.timeoutSeconds !== undefined && input.timeoutSeconds !== storedContract.record.contract.timeoutSeconds) || input.acceptanceCommands !== undefined) throw new AdmissionError("TASK_CONFLICT", "Rework cannot change the original model, duration or required checks.");
      input = { ...input, model: execution.modelId, timeoutSeconds: storedContract.record.contract.timeoutSeconds };
      const admission = this.store.collaboration.getTaskAdmission(task.taskId);
      if (admission) {
        enforceModelPolicy(this.store.collaboration.currentPolicy(admission.policy), execution);
        modelObservation = await this.observeModel(this.config, task.sessionId, execution.modelId);
      }
    }
    const current = { ...task, acceptanceCommands: [...new Set([...(task.acceptanceCommands ?? []), ...(input.acceptanceCommands ?? [])])] };
    const prompt = buildTaskPrompt({ taskId: current.taskId, objective: current.objective, workspace: current.workspace, constraints: current.constraints, acceptanceCommands: current.acceptanceCommands, timeoutSeconds: input.timeoutSeconds ?? this.config.taskTimeoutSeconds ?? 1800 }, input.feedback);
    return this.dispatch(current, prompt, { ...input, modelObservation, sessionId: current.sessionId, sessionMode: "existing" });
  }
  async accept(taskId: string, note: string, evidence: string[], artifactPaths: string[] = []) {
    this.requireDesktop();
    const task = await this.sync(taskId);
    if (task.state !== "needs_review" && task.state !== "completed") throw new Error("WorkBuddy must finish the turn before acceptance");
    if (task.attemptId) {
      const snapshot = this.client.runSnapshot(task.attemptId);
      if ((snapshot?.driver === "desktop-queue" || task.runtimeSource === "desktop_queue") && !hasNativeStopEvidence(snapshot)) throw new Error("The worker report was received but native execution has not been confirmed stopped; wait before acceptance");
      if (snapshot?.driver === "desktop-queue" || task.runtimeSource === "desktop_queue") {
        if (!snapshot || snapshot.taskId !== task.taskId || snapshot.attemptId !== task.attemptId || snapshot.sessionId !== task.sessionId ||
            snapshot.status !== "needs_review" || !snapshot.reportDigest || snapshot.runtimeSource !== "desktop_queue") throw new Error("Acceptance requires the current authenticated desktop queue report and matching task/attempt/session identity");
        verifyValidationEvidence(this.config, task.attemptId, snapshot.validationRecords ?? []);
      }
    }
    if (!task.sessionId || !["desktop_interactive", "desktop_queue"].includes(task.runtimeSource ?? "") || !task.report?.rawText.trim()) throw new Error("Acceptance requires a verified desktop session and a real WorkBuddy result");
    if (!evidence.length || evidence.some((value) => !value.trim())) throw new Error("Provide concrete evidence from independent verification, including the command/output or inspected source/artifact");
    const artifactEvidence = artifactPaths.map((file) => {
      if (!path.isAbsolute(file)) throw new Error("Acceptance artifact paths must be absolute");
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0) throw new Error(`Artifact is missing or empty: ${file}`);
      return `Inspected artifact: ${file} (${stat.size} bytes)`;
    });
    if (!task.attemptId) throw new Error("Legacy tasks cannot be accepted without a durable desktop execution attempt");
    // T2-R4: the accepted state, review facts and the terminal task_closed
    // event commit in one transaction — a crash between them can no longer
    // leave an accepted task whose closure event was never written.
    const accepted = this.store.acceptAttempt(taskId, task.attemptId, { state: "accepted", evidence: [...evidence, ...artifactEvidence], artifacts: [...new Set([...(task.artifacts ?? []), ...artifactPaths])], reviewNote: note, reviewedAt: new Date().toISOString() }, {
      type: "task_closed",
      occurredAt: new Date().toISOString(), actor: "codex",
      payload: { closedAs: "accepted", attempt: task.attempt ?? null },
      // T2-R3: the same logical-closure identity closeTerminalTask dedups
      // on. Acceptance and post-acceptance syncs must share one closure
      // event per attempt; a null sourceRef here would let the later sync
      // write a second task_closed for the same logical close.
      sourceRef: `${task.attemptId}:task_closed`,
    }, { expectedStates: ["needs_review", "completed"] });
    if (!accepted.applied) throw new Error("Task changed during review; inspect the current attempt before acceptance");
    return accepted.task;
  }
  respond(taskId: string, decision: "allow_once" | "reject_once" | "cancel" | "submit", content?: Record<string, unknown>) {
    this.requireDesktop();
    const task = this.requireTask(taskId);
    if (!task.attemptId) throw new Error("This legacy task has no durable input channel");
    this.client.respond(task.attemptId, decision, content);
    return { ok: true, taskId, message: "Input delivered to the active WorkBuddy request; call wait for its response." };
  }
  executionStatus(taskId: string) {
    const task = this.requireTask(taskId);
    if (!task.attemptId || !/^run-[a-f0-9-]{36}$/.test(task.attemptId)) return { state: "unknown", remoteStopped: false };
    const snapshot = task.attemptId ? this.client.runSnapshot(task.attemptId) : undefined;
    if (!snapshot) return { state: "unknown", remoteStopped: false };
    // A reused or corrupt journal cannot prove that this task's native turn stopped.
    if (snapshot.taskId !== task.taskId || snapshot.attemptId !== task.attemptId ||
        (task.sessionId && snapshot.sessionId !== task.sessionId)) return { state: "unknown", remoteStopped: false };
    const remoteStopped = (snapshot.driver === "desktop-queue" || task.runtimeSource === "desktop_queue" ? hasNativeStopEvidence(snapshot) : Boolean(snapshot.stopReason)) && ["needs_review", "blocked", "failed", "cancelled"].includes(snapshot.status);
    const cancellationRequested = task.attemptId ? new RunJournal(runsDirectory(this.config), task.attemptId).cancellationRequested() : false;
    return {
      state: remoteStopped ? "stopped" : cancellationRequested || snapshot.nativeFailure ? "stop_unconfirmed" : snapshot.nativeHealth?.state === "offline" ? "session_offline" : snapshot.waitingInput ? "waiting_input" : snapshot.reportDigest ? "report_received" : snapshot.status,
      remoteStopped, cancellationRequested, reportDigestPresent: Boolean(snapshot.reportDigest), stopReason: snapshot.stopReason, observedAt: snapshot.nativeStoppedAt ?? snapshot.updatedAt,
      deadline: snapshot.deadline, claimDeadline: snapshot.claimDeadline,
      reportBy: snapshot.reportBy, progress: snapshot.progress, stopControl: snapshot.stopControl,
      nativeHealth:snapshot.nativeHealth, nativeRateLimit:snapshot.nativeRateLimit, postReportFailure:snapshot.postReportFailure,
      nativeStopCheck:snapshot.nativeStopCheck,
    };
  }
  async reconcileReport(input: {taskId:string;attemptId:string;reason:string}) {
    this.requireDesktop();
    const task = this.requireTask(input.taskId);
    if (task.attemptId !== input.attemptId || !task.sessionId || !task.workspace) throw Error("Use the current task attempt and original session/workspace for reconciliation");
    const registration = readServiceRegistration(this.config.serviceConfigFile ?? path.join(path.dirname(this.config.dbFile), "persistent-service.json"));
    if (!registration) throw Error("No managed native service registration is available for bounded reconciliation");
    if (path.resolve(registration.dbFile) !== path.resolve(this.config.dbFile)) throw Error("The native service belongs to another task database; report reconciliation refused");
    const bound = registeredServiceConfig(this.config, registration);
    const trigger = new NativeDesktopRpcTrigger(bound, registration.cdpPort, false);
    try {
      const result = await reconcileReportedAttempt(this.config,{...registration,sessionId:task.sessionId,workspace:task.workspace},trigger,input);
      return {...result,task:await this.sync(task.taskId),execution:this.executionStatus(task.taskId)};
    } finally {trigger.close();}
  }
  async cancel(taskId: string, reason?: string) {
    const task = this.requireTask(taskId);
    if (task.state === "accepted") return {ok:true,task, ...this.executionStatus(taskId),message:"Already accepted; no cancellation dispatched"};
    const requested = this.client.cancel(task.messageId);
    // Preserve uncertainty: cancellation requested does not prove remote execution stopped.
    const snapshot = task.attemptId ? this.client.runSnapshot(task.attemptId) : undefined;
    const updated = this.store.update(taskId, { state: snapshot?.error ? "blocked" : "cancelled", cancelNote: task.cancelNote ?? reason ?? "Cancellation requested by Codex." });
    if (this.config.backend === "desktop-queue" && task.sessionId && task.workspace) {
      const registration = readServiceRegistration(this.config.serviceConfigFile ?? path.join(path.dirname(this.config.dbFile), "persistent-service.json"));
      if (registration && path.resolve(registration.dbFile) === path.resolve(this.config.dbFile)) {
        const trigger = new NativeDesktopRpcTrigger(this.config,registration.cdpPort,false);
        try { await new PersistentDesktopService(this.config,{...registration,sessionId:task.sessionId,workspace:task.workspace},trigger,this.store).pump(); }
        finally {trigger.close();}
      }
    }
    const execution = this.executionStatus(taskId);
    return { ok: true, cancellationRequested: execution.cancellationRequested || requested, remoteStopped: execution.remoteStopped, executionState: execution.remoteStopped ? "stopped" : "stop_unconfirmed", execution, task: updated };
  }
  requireTask(taskId: string): StoredTask {
    const task = this.store.get(taskId);
    if (!task) throw new Error(`Unknown task_id: ${taskId}`);
    return task;
  }
}

export function parseReport(rawText: string): TaskReport {
  const status = rawText.match(/TASK_STATUS:\s*(completed|blocked|failed|working|needs_review|cancelled)/i)?.[1]?.toLowerCase();
  const section = (field: string) => (rawText.match(new RegExp(`${field}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|\\n\\[/|$)`, "i"))?.[1] ?? "").split("\n").map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
  const value = (field: string) => rawText.match(new RegExp(`${field}:\\s*(.*)`, "i"))?.[1]?.trim();
  return { status, filesChanged: section("FILES_CHANGED"), commandsRun: section("COMMANDS_RUN"), testResult: value("TEST_RESULT"), remainingProblems: value("REMAINING_PROBLEMS"), rawText };
}

export function buildTaskPrompt(input: SendTaskInput & { taskId: string }, feedback?: string): string {
  return `[CODEX_TASK]\ntask_id: ${input.taskId}\n目标：\n${input.objective}\n工作目录：${input.workspace ?? "当前绑定桌面会话的目录"}\n约束（每轮继续有效）：\n${input.constraints?.map((item) => `- ${item}`).join("\n") || "按目标范围执行"}\n验收要求：\n${input.acceptanceCommands?.map((item) => `- ${item}`).join("\n") || "运行相关检查并报告真实结果"}\n超时（秒）：${input.timeoutSeconds ?? 1800}\n${feedback ? `Codex 本轮验收反馈（逐项修正，保留已有有效成果）：\n${feedback}\n` : ""}执行要求：使用 WorkBuddy 当前会话和自身工具完成任务。遇到输入、权限、素材或能力阻碍时如实报告。不要把计划或请求受理当成成品，也不要宣称别的 Agent 完成的文件是本轮成果。最终给出实际产物路径、用到的工具/技能、运行的命令和结果。\n最终格式：\nTASK_STATUS: completed | blocked | failed\nARTIFACTS:\nFILES_CHANGED:\nCOMMANDS_RUN:\nTEST_RESULT:\nREMAINING_PROBLEMS:\n[/CODEX_TASK]`;
}

/**
 * Pure evidence-digest builder (T2-R1/R2): the digest covers every
 * run-file fact the projection reads — stop proof, full report
 * authentication object (not just its presence), report digest and status —
 * and is bound to the attemptId so a previous round's evidence can never be
 * mistaken for this round's. The projection reader recomputes it from the
 * run file to detect "file facts ahead of the persisted revision".
 *
 * T2-R1 round 3: the digest also binds the report's ACTUAL content. A
 * snapshot can carry an unchanged declared reportDigest while its text or
 * artifacts were altered on disk; the recomputed content digest diverges and
 * the evidence identity changes, so the reader refuses the stale revision
 * and the next sync regenerates it.
 */
export function runEvidenceDigestOf(snapshot: RunSnapshot, cancellation?: { requestedAt?: string | null; reason?: string | null }): string {
  const stopped = hasNativeStopEvidence(snapshot);
  // The digest the snapshot's own bytes support right now (null when the
  // snapshot lacks a report or a usable authentication status). Comparing
  // this against the DECLARED digest is the adapter's authentication check;
  // here it only has to be part of the identity so any content change moves
  // the evidence.
  let contentDigest: string | null = null;
  try {
    contentDigest = snapshotReportDigest(snapshot);
  } catch {
    contentDigest = null;
  }
  return JSON.stringify({
    taskId: snapshot.taskId,
    attemptId: snapshot.attemptId,
    sessionId: snapshot.sessionId ?? null,
    runtimeSource: snapshot.runtimeSource ?? null,
    driver: snapshot.driver ?? null,
    stopped, nativeStoppedAt: snapshot.nativeStoppedAt ?? null,
    nativeStopSource: snapshot.nativeStopSource ?? null,
    stopReason: snapshot.stopReason ?? null,
    stopProofDigest: crypto.createHash("sha256").update(JSON.stringify([
      snapshot.nativeFailure ?? null, snapshot.stopControl ?? null, snapshot.nativeStopCheck ?? null,
    ])).digest("hex"),
    rawContentDigest: crypto.createHash("sha256").update(JSON.stringify([
      snapshot.text ?? null, snapshot.artifacts ?? null, snapshot.validationRecords ?? null,
    ])).digest("hex"),
    cancellation: cancellation ? { requestedAt: cancellation.requestedAt ?? null, reason: cancellation.reason ?? null } : null,
    reportDigest: snapshot.reportDigest ?? null,
    // Actual on-disk report content binding: changes whenever text,
    // artifacts, validation records or the reported status change.
    contentDigest,
    auth: snapshot.reportAuthentication ?? null,
    status: snapshot.status,
    ...(snapshot.dsh ? { dsh: snapshot.dsh } : {}),
  });
}

/**
 * Whether a stored digest records confirmed stop proof FOR THIS ATTEMPT
 * (T2-R2): digests without an attemptId (legacy rows) only count when the
 * caller passes no attemptId to bind; per-attempt callers treat them as
 * "not recorded for this round", so rework rounds are never suppressed.
 */
export function digestRecordsStopFor(digest: string | undefined, attemptId: string | undefined): boolean {
  if (!digest) return false;
  try {
    const parsed = JSON.parse(digest) as { stopped?: unknown; attemptId?: unknown };
    if (parsed.stopped !== true) return false;
    // Legacy digest (no attemptId): treat as recorded only when we cannot
    // bind — the replay-dedup sourceRef still guards against duplicates.
    if (typeof parsed.attemptId !== "string") return !attemptId;
    return !attemptId || parsed.attemptId === attemptId;
  } catch {
    return false;
  }
}

/** Whether a stored run-evidence digest already recorded confirmed stop proof. */
function hasNativeStopEvidenceFromDigest(digest: string | undefined): boolean {
  return digestRecordsStopFor(digest, undefined);
}
