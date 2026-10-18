# Desktop queue reliability

This page preserves the 2026-10-15 repair notes. The subsequent implementation
fixes and completed live acceptance are documented in
[the 2026-10-16 reliability repair](RELIABILITY_REPAIR_2026-10-16.md).

The 2026-10-15 trial exposed separate native model HTTP 500 failures and local
result-report failures (`spawnSync powershell EBUSY`). This patch addresses the
local protocol and supervision. It cannot fix the remote model service.

- Windows process ancestry inspection invokes the absolute system PowerShell
  executable, avoiding PATH shims, while keeping the desktop ancestry proof.
- Claim supplies private per-attempt context, a result JSON path and a fixed
  `finish` command. Result text and artifact paths are data, not shell arguments.
  JSON is bounded to 64 KiB; paths, status and content are validated. Native
  ancestry and the original lease are still required to report.
- Identical report retries acknowledge the original result without duplicate
  journal events. Conflicting or forged reports fail.
- Worker report receipt and native stop are distinct. A completed report may
  enter needs_review with execution.state=report_received and remoteStopped=false.
  Supervision continues until native idle is observed. Rework, another claim and
  acceptance are refused before that proof; report content is preserved. Legacy
  worker stop reasons are also rechecked instead of being treated as native proof.
- The cached renderer bridge updates model policy in place, including across
  simultaneous installation requests. Refresh preserves in-flight turns, wake
  receipts and failure observations. An unrestricted client cannot clear an
  existing free-only policy. Legacy upgrade retains its activity observer and
  requires an explicit free-only policy rather than assuming an unknown policy
  can be relaxed.
- The supervisor keeps observing delivered wakes and claimed work, including pending cancellation.
  An exact wake-correlated native failure blocks promptly. A native idle state
  confirms stop only; it never supplies successful execution evidence. Idle
  without a worker report blocks after a ten-second propagation window.
- Native permission waits surface as blocked without releasing the active lease.
  Native resume restores working status. No permission is automatically granted.
- Deadlines request a cooperative stop. Queue cancellation and verified native
  stop remain separate. Busy/offline sessions cannot be declared stopped.
  Even an unclaimed task may have a running native turn after wake delivery.
  Passive observations never launch or restart WorkBuddy.
- Empty claims and completed reports end the worker turn. Report instructions
  allow only one identical retry and prohibit bridge debugging or shell switching.
  Definite wake rejection permits two submissions total; ambiguous submission
  never replays. `WORKBUDDY_MAX_TASK_ATTEMPTS` defaults to 3 (initial + two reworks).
- A stable `workerKey` (normally taskId) on `ensure_workspace` reserves a clean
  native conversation inside the same project. Repeated/uncertain calls reuse
  that identity; existing queue attempts remain bound to their original session.
  Rework stays in the same task/session. This avoids copying a project just to
  escape unrelated old conversation history.

Limits: the supervisor cannot prevent every model-internal tool retry or enforce
a model request/token ceiling with the current native protocol. Native RPC
failure evidence retained in the renderer can be lost across renderer restart;
idle-without-report and deadline handling then provide the fallback. Remote
HTTP 500 causes and complete billing totals require provider-side evidence.

The fixture validation described here uses fake RPC transports and temporary
task databases without model requests. The separately authorized 2026-10-16
desktop smoke tests subsequently verified real execution, reporting, native
stop, same-task rework and independent acceptance; see the linked update.
