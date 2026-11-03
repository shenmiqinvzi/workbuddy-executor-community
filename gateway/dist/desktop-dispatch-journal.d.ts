import type { DesktopDraft, DesktopReceipt } from "./desktop-dispatch.js";
export declare class DesktopDispatchJournal {
    readonly file: string;
    constructor(file: string);
    private open;
    enqueue(draft: DesktopDraft): DesktopReceipt;
    claim(requestId: string, owner?: {
        pid: number;
        startedAt: string;
    } | null): DesktopDraft | null;
    /** Only the exact owner may refresh a lease; a late heartbeat from a
     * superseded worker must never revive the row. */
    heartbeat(requestId: string, owner: {
        pid: number;
        startedAt: string;
    }): boolean;
    lease(requestId: string): {
        state: string;
        ownerPid: number | null;
        ownerStartedAt: string | null;
        claimedAt: string | null;
        heartbeatAt: string | null;
    } | null;
    finish(requestId: string, state: DesktopReceipt["state"], code?: string, message?: string): void;
    receipt(requestId: string): DesktopReceipt | null;
    request(requestId: string): DesktopDraft | null;
    latest(): DesktopReceipt | null;
}
