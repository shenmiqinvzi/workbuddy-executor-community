import { AdmissionError } from "./collaboration.js";
/** All parsing and previewing precedes the actual, interactive human authorization. */
export async function runRecoveryConsole(service, args, io) {
    const [action, target, ...flags] = args;
    if (!["show", "observe", "reconcile", "close"].includes(action ?? "") || !target)
        throw new AdmissionError("INVALID_RECOVERY", "Usage: recovery show|observe|reconcile|close <original-operation-id> [--operation-id <stable-id> --reason <reason>]");
    const options = new Map();
    for (let n = 0; n < flags.length; n += 2) {
        const flag = flags[n], value = flags[n + 1];
        if (!flag || !["--operation-id", "--reason"].includes(flag) || !value || options.has(flag))
            throw new AdmissionError("INVALID_RECOVERY", "Use only one --operation-id and one --reason; approval flags are not supported.");
        options.set(flag, value);
    }
    if (action === "show" || action === "observe") {
        if (flags.length)
            throw new AdmissionError("INVALID_RECOVERY", "Read and observation commands do not accept decision flags.");
        const view = action === "show" ? service.readOperationRecovery(target) : await service.observeOperationRecovery(target);
        io.write(view);
        return view;
    }
    if (action !== "reconcile" && action !== "close")
        throw new AdmissionError("INVALID_RECOVERY", "Choose reconcile or close.");
    const operationId = options.get("--operation-id"), reason = options.get("--reason");
    if (!operationId || !reason)
        throw new AdmissionError("INVALID_RECOVERY", "Provide a stable --operation-id and concrete --reason before confirmation.");
    const prior = service.getOperationRecoveryDecision(operationId);
    if (prior) {
        if (prior.targetOperationId !== target || prior.action !== action || prior.reason !== reason)
            throw new AdmissionError("OPERATION_CONFLICT", "The recovery operationId already has different terms.");
        io.write(prior);
        return prior;
    }
    if (!io.interactive)
        throw new AdmissionError("AUTHORIZATION_REQUIRED", "Run the recovery console interactively to preview and confirm the exact original operation.");
    const view = service.readOperationRecovery(target);
    if (!view.available.includes(action))
        throw new AdmissionError("RECOVERY_UNPROVEN", "The stored original evidence does not prove this action is safe. Observe the original source or investigate without resending.");
    const input = { operationId, targetOperationId: target, action, reason,
        expectedRevision: view.revision, expectedAttemptId: view.attemptId, expectedOperationToken: view.operationToken, expectedEvidenceToken: view.evidenceToken };
    io.write({ action, operationId, originalOperationId: target, taskId: view.operation.taskId, attemptId: view.attemptId,
        executor: view.operation.executor, originalBinding: view.operation.binding, proof: view.proof[action], reason,
        effect: action === "close" ? "Permanently close the original workflow and release its shared slot. Delivery is not accepted." : "Reconcile the original receipt; retain its workflow slot. No prompt is resent." });
    const confirmation = `${action} ${target} ${operationId}`;
    if (await io.question(`Type exactly '${confirmation}' to confirm, or anything else to leave it unchanged: `) !== confirmation)
        throw new AdmissionError("AUTHORIZATION_REQUIRED", "Recovery was not confirmed; the original workflow is unchanged.");
    const authorization = service.authorizeOperationRecovery(input, "local-interactive-user");
    const decision = service.resolveOperationRecovery(input, authorization);
    io.write(decision);
    return decision;
}
//# sourceMappingURL=recovery-console.js.map