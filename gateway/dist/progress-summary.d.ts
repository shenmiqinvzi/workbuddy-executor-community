import type { StoredTask } from "./task-store.js";
import type { LocalMessage } from "./workbuddy-client.js";
export declare function progressDelta(task: StoredTask, messages: LocalMessage[], sinceEventSeq?: number): {
    attemptId: string | undefined;
    sinceEventSeq: number;
    lastEventSeq: number;
    changed: boolean;
    updates: {
        seq: unknown;
        kind: unknown;
        text: string;
    }[];
};
