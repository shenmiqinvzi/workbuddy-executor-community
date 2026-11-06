# 容量与身份（RC6 准备，含纠偏）

## 1. 两个字段必须分开

上一版把「独立库是空的」当成「原生侧没有重叠」，这是错的。下面两个判断独立成立、独立取证：

| 字段 | 含义 | 怎么取 | 当前状态 |
| --- | --- | --- | --- |
| `databaseSlotFree` | 该库 `workflow_capacity` 无占用行，或占用行指向已关闭任务 | 只读复制 `tasks.sqlite(+wal,+shm)` 查表 | 可证（见 §3） |
| `nativeOverlapProven` | 原生宿主/会话侧确认无同一工作区、同一任务的未结束执行 | **需原生侧可观测证据**；库内为空不能推出这一条 | **不可证**（客户端当前起不来，见 `UI_AND_SECOND_MACHINE_PLAN.md`） |

独立库只能证明前者。任何「新库天然为空 ⇒ 可以派」的推断都缺后者，写文档时必须两行都写，不能合并成一句「容量空闲」。

## 2. 关于 RC2 那条 `needs_review`

`rc2-live-20261106b` 不是「永远无法处理」的任务。它的实际状态是：`state=needs_review`、`attempt=1`、`attemptId=run-de1afbd3-…`、`run_evidence_digest.stopped=true`、**没有** `task_closed`、容量行指向它。这意味着：

- 原生侧已停止（`stopped=true` 是原生停止证据），**不是** `outcome_unknown`；
- 它缺的是验收链的后半段：服务端命令复跑 → 程序批次 → 不可变 reviewId → accept；
- 按原约定（`docs/delivery/RC2_LIVE_RUN.md` 记录的范围、`allowedChanges`、停止时间、审查证据）可以核对，也可以走既有 `check_task`/`review_task` 补完；能否补由**那份契约当时的字段**决定，不由我改判。
- 上一版写「容量被历史任务占死、无法处理」属口径错误，已删。

## 3. 三个库的实测（只读复制后查询，`read-capacity.mjs`）

| 库 | 大小 | 任务数 | 占用行指向 | 该任务状态 | 能否 `isClosed` |
| --- | --- | --- | --- | --- | --- |
| RC1 `gateway-v0.7.1-rc1\data\tasks.sqlite` | 933,888 B / 25 表 | 6 | `d1-workbuddy-2cc8e262-54f5-43a0-8511-b3febf0d4101` | `blocked`、`attempt_id=null`、无 `task_closed`、`stopped=null` | 否（缺 attempt 与关闭证据） |
| RC2 `gateway-v0.7.1-rc2\data\tasks.sqlite` | 258,048 B | 1 | `rc2-live-20261106b` | `needs_review`、`attemptId=run-de1afbd3-…`、`stopped=true`、无 `task_closed` | 否（缺 `task_closed`） |
| 当前聊天 MCP `outputs\t7b-live-acceptance-20261031\state\tasks.sqlite` | 237,568 B | 2 | 指向已 `accepted` 且有 `task_closed` 的任务 | 已关闭 | 是（`claim()` 会自行清行） |

结论：
1. RC1 库、RC2 库各有一行真实占用，且都缺关闭证据；不能靠时间、TTL、换库、换身份或第二台机消除。
2. 聊天 MCP 侧的库并没有被历史占死。

## 4. 身份与不重叠的取证要求

要宣称「独立样本已验收且不解除旧占用」，至少要能给出：

1. 该次派工使用的 `taskId`、`sessionId`、`attemptId`、`operationId` 四件，且能回读；
2. 该次派工落在**哪个库、哪个 runs 目录、哪个原生会话**（三者都要有可读记录）；
3. 与旧占用任务在 `workspace`、`sessionId`、`attemptId`、原生进程上的**逐项不等**证明，而不是「它们在另一个库」；
4. 若原生侧不可观测，评估结论只能写 `nativeOverlapProven=false`，并在索引与回执里保留这一行。

## 5. 处置边界（本轮不变）

- 不关闭、不重派、不释放 P0-1 的原未知任务（T7D 决定继续有效）。
- 不用新安装根、新数据库、第二台机、替代会话消除旧占用。
- `recovery-cli reconcile/close` 只允许在**副本**上演练；真实库不动。
