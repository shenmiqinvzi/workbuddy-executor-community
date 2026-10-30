import type { DesktopDraft, DesktopReceipt } from "./desktop-dispatch.js";
export declare class DesktopDispatchJournal {
    readonly file: string;
    constructor(file: string);
    private open;
    enqueue(draft: DesktopDraft): DesktopReceipt;
    claim(requestId: string): DesktopDraft | null;
    finish(requestId: string, state: DesktopReceipt["state"], code?: string, message?: string): void;
    receipt(requestId: string): DesktopReceipt | null;
    request(requestId: string): DesktopDraft | null;
    latest(): DesktopReceipt | null;
}
