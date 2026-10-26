import type { DatabaseSync } from "node:sqlite";
import type { ExecutionSelection } from "./task-contract.js";
export interface DshBinding {
    taskId: string;
    attemptId: string;
    hostId: string;
    sessionId: string;
    requestId: string;
    execution: ExecutionSelection;
    cursor: number;
    runOpen: boolean;
    cancelRequested: boolean;
    dispatch: "preparing" | "reserved" | "accepted" | "uncertain" | "rejected";
    terminalSeq?: number;
    turnId?: string;
}
export declare class DshBindingStore {
    private readonly db;
    constructor(db: DatabaseSync);
    get(attemptId: string): DshBinding | null;
    forTask(taskId: string): DshBinding | null;
    assertNoOpen(exceptTaskId: string): void;
    /** Called under TaskStore.atomic, before native model preparation. */
    reserve(binding: DshBinding): void;
    update(binding: DshBinding): void;
}
