/** Read-side settlement for a desktop dispatch request.
 *
 * The dispatch journal is the only durable record of "we asked the native
 * side to start the original task". A worker that claims a request stamps a
 * lease on the row and refreshes a heartbeat while it works. Nothing here
 * changes `task_operations`, releases execution capacity or re-dispatches:
 * these values are derived on read so that a stale row is described as
 * uncertain instead of being silently "in progress" or "finished".
 */
export const DISPATCH_HEARTBEAT_MS = 15_000;
export const DISPATCH_LEASE_TTL_MS = 180_000;
const pending = new Set(["launch_requested", "dispatching"]);
/** `alive` may return null when the process table cannot be inspected. A dead
 * owner is conclusive; a live one still needs a fresh heartbeat, because a
 * reused pid must never make a silent worker look healthy. */
export function settleDispatch(lease, options) {
    const ttlMs = options.ttlMs ?? DISPATCH_LEASE_TTL_MS;
    const state = String(lease.state);
    if (!pending.has(state))
        return { settlement: "lease_unavailable", reason: "not_pending", ownerAlive: null, heartbeatAgeMs: null };
    if (lease.ownerPid === null || lease.heartbeatAt === null || lease.claimedAt === null) {
        return { settlement: "lease_unavailable", reason: "no_lease_record", ownerAlive: null, heartbeatAgeMs: null };
    }
    const heartbeatAt = Date.parse(lease.heartbeatAt);
    const heartbeatAgeMs = Number.isFinite(heartbeatAt) ? Math.max(0, options.now - heartbeatAt) : null;
    const ownerAlive = lease.ownerPid !== null && options.alive ? options.alive(lease.ownerPid) : null;
    if (ownerAlive === false)
        return { settlement: "abandoned", reason: "owner_exited", ownerAlive, heartbeatAgeMs };
    if (heartbeatAgeMs === null || heartbeatAgeMs > ttlMs)
        return { settlement: "stuck", reason: "heartbeat_expired", ownerAlive, heartbeatAgeMs };
    return { settlement: "live", reason: "heartbeat_fresh", ownerAlive, heartbeatAgeMs };
}
//# sourceMappingURL=dispatch-settlement.js.map