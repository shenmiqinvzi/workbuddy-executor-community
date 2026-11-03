/** Read-side settlement for a desktop dispatch request.
 *
 * The dispatch journal is the only durable record of "we asked the native
 * side to start the original task". A worker that claims a request stamps a
 * lease on the row and refreshes a heartbeat while it works. Nothing here
 * changes `task_operations`, releases execution capacity or re-dispatches:
 * these values are derived on read so that a stale row is described as
 * uncertain instead of being silently "in progress" or "finished".
 */
export type DispatchSettlement = "live" | "stuck" | "abandoned" | "lease_unavailable";
export declare const DISPATCH_HEARTBEAT_MS = 15000;
export declare const DISPATCH_LEASE_TTL_MS = 180000;
export interface DispatchLease {
    state: string;
    ownerPid: number | null;
    ownerStartedAt: string | null;
    claimedAt: string | null;
    heartbeatAt: string | null;
}
export type DispatchSettlementReason = "not_pending" | "no_lease_record" | "owner_exited" | "heartbeat_expired" | "heartbeat_fresh";
export interface DispatchSettlementView {
    settlement: DispatchSettlement;
    reason: DispatchSettlementReason;
    ownerAlive: boolean | null;
    heartbeatAgeMs: number | null;
}
/** `alive` may return null when the process table cannot be inspected. A dead
 * owner is conclusive; a live one still needs a fresh heartbeat, because a
 * reused pid must never make a silent worker look healthy. */
export declare function settleDispatch(lease: DispatchLease, options: {
    now: number;
    alive?: (pid: number) => boolean | null;
    ttlMs?: number;
}): DispatchSettlementView;
