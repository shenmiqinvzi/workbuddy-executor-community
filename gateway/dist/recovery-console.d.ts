import type { TaskApplicationService } from "./task-application-service.js";
export interface RecoveryConsoleIO {
    interactive: boolean;
    write(value: unknown): void;
    question(prompt: string): Promise<string>;
}
/** All parsing and previewing precedes the actual, interactive human authorization. */
export declare function runRecoveryConsole(service: TaskApplicationService, args: string[], io: RecoveryConsoleIO): Promise<import("./operation-recovery.js").RecoveryDecision | {
    schemaVersion: "operation-recovery-1";
    operation: import("./operation-admission.js").OperationRecord;
    operationToken: string;
    revision: string | null;
    attemptId: string | null;
    evidenceToken: string;
    preparation: {
        phaseRecorded: boolean;
        enteredAt: string | null;
        completedAt: string | null;
        dispatchEnteredAt: string | null;
        reservedSessionId: string | null;
        incomplete: boolean;
        note: string;
    };
    runEvidenceDigest: string | null;
    available: string[];
    proof: {
        reconcile: "queue_receipt" | "dsh_receipt" | null;
        close: "not_dispatched" | "native_stopped" | "declared_stop" | null;
    };
    capacity: {
        taskId: string;
        executor: string;
        operationId: string;
    } | null;
    history: import("./operation-recovery.js").RecoveryDecision[];
    declaration: {
        declarationId: string;
        actor: string;
        declaredAt: string;
        statement: string;
        source: "human_declaration";
    } | null;
    note: string;
}>;
