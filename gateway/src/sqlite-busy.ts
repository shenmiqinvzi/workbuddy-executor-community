/**
 * Lock-acquisition budget for local SQLite files.
 *
 * Every connection opens in WAL mode and writes are short transactions, so a
 * busy timeout is a wait budget, not a work budget: when it expires the caller
 * still gets the real error. Under concurrent load (several gateway processes,
 * a desktop host and a worker sharing one disk) the previous 3-5s budgets were
 * exceeded by fsync/WAL checkpoint latency alone, which surfaced as
 * ERR_SQLITE_ERROR far away from the statement that waited.
 *
 * The default is deliberately larger than any single statement should take,
 * and an operator can tighten it with WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS.
 */
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 15000;
const MIN_SQLITE_BUSY_TIMEOUT_MS = 1000;
const MAX_SQLITE_BUSY_TIMEOUT_MS = 120000;

export function sqliteBusyTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS;
  // An unset or blank value keeps the default; Number("") is 0 and would
  // otherwise be clamped up to the floor and read as "someone chose 1s".
  if (raw === undefined || raw.trim() === "") return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  const configured = Number(raw);
  if (!Number.isFinite(configured)) return DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  return Math.min(MAX_SQLITE_BUSY_TIMEOUT_MS, Math.max(MIN_SQLITE_BUSY_TIMEOUT_MS, Math.round(configured)));
}
