# 旧记录 → TaskView 事实的只读映射

本文固定 `gateway/src/task-view-adapter.ts` 的映射规则。实现前先固定来源与成立条件；
表中未列出的来源一律不使用。缺失事实不补默认值。

## 1. 范围与非目标

本轮是**旧记录的只读投影准备**。现有存储没有 vNext `reviewId`、结构化必需检查、约定版本、
当前源码摘要和持久化 `revision`，因此输出**不得**称为完整 `TaskView` 或可执行的 vNext 服务。

不做：约定/审查持久化、源码哈希扫描、范围基线、操作幂等、执行锁、报告认证、实时在线判定。
这些记为能力缺口（第 7 节），不在适配器里临时实现第二套系统。

适配函数只处理调用方传入的普通对象：不实例化 `TaskStore`/`RunJournal`/原生适配器，
不访问文件、数据库、网络，不读进程环境与当前时钟，不发送控制命令。

## 2. 输入来源与归属校验

| 输入字段 | 生产入口 | 归属校验 |
|---|---|---|
| `task: StoredTask` | `TaskStore.get(taskId)` / `TaskStore.listTasks()` | 由调用方按 `taskId` 取得 |
| `attempt?: StoredAttempt` | `TaskStore.listAttempts(taskId)`，取 `attemptId === task.attemptId` 的行 | `attempt.taskId === task.taskId`；`attempt.attemptId === task.attemptId` |
| `snapshot?: RunSnapshot` | `RunJournal(runsDirectory(config), attemptId).snapshot()` | `snapshot.taskId`、`snapshot.attemptId`、`snapshot.sessionId`、`snapshot.runtimeSource` 必须与 task/attempt 一致 |
| `cancellation?: {requestedAt?, reason?}` | `<journal dir>/cancel.json`；存在性即 `RunJournal.cancellationRequested()`，内容由 `RunJournal.cancel(reason)` 以 `flag:"wx"` 写入 | 该文件位于本次 attempt 的 journal 目录内，因此天然属于该 attempt |
| `liveObservation?: LiveNativeObservation` | 可选。来自真正的实时观测路径（例如 `AcpLiveClient.listSessions()` 或 `desktop-queue.observeNative()` 的调用方） | 观察者必须自证 `identityMatches`；本函数不自行判定有效期 |

`cancel.json` 的 `reason` 取值来源：`RunJournal.cancel(reason = "operator")` 默认写 `"operator"`。
`DesktopQueue.expire()` 的实际顺序是**先** `journal.save({...snapshot, status:"blocked", error})`，
**再**在存在 claim/wake 且尚无取消请求时调用 `journal.cancel("deadline")`；因此截止情形的
`blocked` 状态先落盘，取消记录后写入。

`flag:"wx"` 证明的是：**取消原因一旦写入就不会被后续取消请求覆盖**（同类记录之间的首次优先），
它**不**证明取消记录与其他种类终态之间的全局先后顺序。适配器因此按"记录权威性"而非时间排序，
见第 3.2 节。

取消记录可能存在但 `reason` 缺失（输入类型允许只带 `requestedAt`）。这仍是"已请求取消"的事实，
不等于"没有终态决定"，见第 3.3 节。

### 关联先于取用

顺序固定：**先完成 task / attempt / snapshot 的关联校验，再读取任何记录中的事实**。
归属不正确的记录不贡献验收、终态、停止或报告事实，无论其内容为何。

逐对比较 `taskId`、`attemptId`、`sessionId`、`runtimeSource`：

| 情况 | 处理 |
|---|---|
| 两侧都有值且不同 | **不一致**：该记录整体不可用，`trust.identityMatches = false`，记录 `*_mismatch` 缺口 |
| 一侧有值、另一侧缺失 | **缺失**：记录 `session_missing` / `runtime_source_missing`，`trust.identityMatches = null`。**缺失不当作匹配** |
| 两侧都缺失（session / runtimeSource） | 同样视为缺失，不当作匹配 |

比较三对：`task↔attempt`、`task↔snapshot`、**`attempt↔snapshot`**。

最后一对不可省略：`attempt` 与 `snapshot` 的 `taskId`、`attemptId` 都属于当前轮次时，还要直接比较
二者已知的 `sessionId` 与 `runtimeSource`。否则 `task` 恰好缺这两个字段时，两条记录之间的明确冲突
会被掩盖，冲突快照的停止证明就会被误用（缺口 `attempt_snapshot_mismatch`）。

第三对只在前两条记录**都未被判为不一致**时执行：已经判为外来的 `attempt` 不得用来污染
另一条独立匹配的合法 `snapshot`。

- `attemptUsable = attempt 存在且无任何不一致`；`snapshotUsable = snapshot 存在且无任何不一致`。
- `attemptState` 只在 `attemptUsable` 时读取，因此外来 attempt 的 `accepted`/`cancelled`/`failed` 不产生本任务的验收或终态事实。
- **当前 attempt 只能来自 `task.attemptId`**。任务缺少该字段时不得把任何历史 attempt 行提升为当前轮次（见 `attemptId` 行）。
- `not_dispatched` 是"从未派发"，本就没有原生 session，因此该情形下 session 缺失不计为身份不完整。

`identityMatches` 的成立条件（存储一致与实时核验是两件事）：

1. 任一记录不一致 → `false`；
2. 否则若提供实时观测 → **直接采用 `liveObservation.identityMatches`**（`true`/`false`/`null` 原样，不因存储字段齐全而提升为 `true`）；
3. 否则若记录完整一致 → `true`；
4. 否则 → `null`。

## 3. TaskDisplayFacts 字段映射

| 字段 | 来源 | 成立条件 | 缺失/冲突时 |
|---|---|---|---|
| `attemptId` | **仅** `task.attemptId` | 非空白 | 缺失 → `facts: null` + `attempt_missing`，**不回退到历史 attempt 行**。`task.state="accepted"` 时例外：`displayState: "accepted"`、`facts: null`（见第 3.1 节） |
| `acceptance.decision` | `task.state === "accepted"`；`attemptState === "accepted"`（仅当 attempt 可用） | 存储中的真实最终验收决定即持久事实 | 否则 `"not_accepted"`。**外来 attempt 的 accepted 永不生效** |
| `acceptance.conflict` | 上述决定与可用 attempt、关联校验结果比对 | 任一处不一致即 `true` | 不一致另列缺口，**不抹去 accepted** |
| `terminalDecision.decided` | 首次原因记录 `cancel.json`；否则 `task.state` / `attemptState` 的 `cancelled`/`failed` | 见第 3.2 节优先级 | 无法判定 → `null` + `terminal_decision_undetermined` |
| `terminalDecision.cause` | `reason="deadline"`→`deadline`；其他 `reason`→`cancellation`；否则 `cancelled`→`cancellation`、`failed`→`failure` | 见第 3.2 节优先级 | 有决定但原因无法排序 → `null` + `terminal_cause_conflict` |
| `terminalDecision.deadlineReached` | `reason="deadline"` → `true`；否则取 `liveObservation.deadlineReached` | 结构化记录或观察者声明 | 否则 `null`（本函数不读时钟） |
| `stop.proven` | `hasNativeStopEvidence(snapshot)`（复用现有纯判定） | 快照可用 | 无快照 → `null`；快照不可用 → `null`；有快照但无证据 → `false` |
| `stop.at` | `snapshot.nativeStoppedAt` | 可被 `Date.parse` 解析 | 否则 `null`；**停止已确认但无可靠时间仍为已确认**（+`stop_time_unavailable`） |
| `stop.attemptId` | 当前 `attemptId` | 仅在快照可用时写入 | 否则 `null`，使停止证据无法被本 attempt 使用 |
| `report.state` | `task.report?.rawText` / **可用**快照的 `text` / `reportDigest` | 存在即"有报告" | 无报告 → `"absent"`；有报告 → **`"unknown"`** + `report_authentication_unverified`（见第 4 节） |
| `report.attemptId` | 当前 `attemptId` | 仅在认证成立时写入 | 未认证 → `null` |
| `nativeWaitingForInput` | `liveObservation.phase === "waiting_input"` | 仅实时观测 | 否则 `null`。**不用** `snapshot.waitingInput`（持久标志不是实时观测） |
| `nativePhase` | `liveObservation.phase`；`waiting_input`→`idle`（等待人工不是在执行），`offline`→`unknown` | 仅实时观测 | 否则 `"unknown"` + `live_observation_absent` |
| `trust.identityMatches` | 第 2 节 | 见上 | `null`/`false` |
| `trust.observationCurrent` | `liveObservation.observationCurrent` | 仅实时观测 | 否则 `null`。`snapshot.updatedAt` **只是保存时间**，不能证明当前 |
| `trust.connected` | `liveObservation.connected` | 仅实时观测 | 否则 `null` |

### 3.1 accepted 的结果语义

`facts` 与 `displayState` 通常同有同无。唯一例外：任务自身记录 `accepted` 但无法建立当前 attempt
身份时，返回 `facts: null` 且 `displayState: "accepted"`。理由是验收决定属于任务级持久事实，
不需要 attempt 编号；此时**不生成虚构 attemptId**，`actionFacts` 仍为 `null`。
调用方必须读 `displayState`，不能假定它由 `facts` 推导而来。

### 3.2 终态原因优先级

依据现有源码：`RunJournal.cancel(reason)` 以 `flag:"wx"` 写 `cancel.json`，**只有第一次写入生效**。
这只证明**取消原因**在同类记录之间首次优先；`DesktopQueue.expire()` 是先 `save(blocked)` 再
`cancel("deadline")`，所以不能据此宣称取消记录先于所有其他终态。因此本节按**记录权威性**排序：
只有 `cancel.json` 携带显式原因，`task.state`/`attempt.state` 只是不带原因的粗粒度状态，
后者不能给前者改名。

优先级：

1. `cancel.json` 存在且 `reason="deadline"` → `deadline`；
2. `cancel.json` 存在且 `reason` 为其他非空值（含默认 `"operator"`）→ `cancellation`；
3. `cancel.json` 存在但 `reason` 缺失 → `decided: true`、`cause: null` + `cancellation_reason_missing`（见 3.3）；
4. 无 `cancel.json`：`cancelled` 与 `failed` 只有一方成立 → 取该方；
5. 无 `cancel.json`：`cancelled` 与 `failed` 同时成立 → `decided: true`、`cause: null` + `terminal_cause_conflict`（**证据不足以排序，不猜**）；
6. 无 `cancel.json` 且两者都不成立 → 按任务状态判断是否有决定。

迟到报告不参与原因判定，因此不能覆盖已确定的原因。

### 3.3 取消记录存在但原因缺失

输入类型允许 `cancellation` 只带 `requestedAt`。该记录由调用方从本次 attempt 的 journal 目录读出，
归属已由调用方保证，因此"取消请求已存在"是可用事实，**不能**当作"没有终态决定"。

- `decided: true`，`cause: null`，缺口 `cancellation_reason_missing`；
- **不**把缺原因默认成 `operator` 或 `deadline`；
- 无停止证明 → 显示 `waiting_stop`；停止已确认而原因仍未知 → 显示 `unknown`；
- 已持久化的 `accepted` 仍按规则 1 优先保留。

### 停止判定的边界（对应任务规则 3）

`hasNativeStopEvidence` 只认：`driver === "desktop-queue"` 且
（`nativeStoppedAt` 可解析 + `nativeStopSource ∈ {native_idle, not_dispatched}`，
或 `stopReason ∈ {native_idle_verified, native_failure_verified, native_idle_without_report}`）。
单独存在 `nativeStoppedAt`、`stopReason="end_turn"`、worker 完成报告、取消请求或 idle 标签
**都不构成停止证明**。

### 报告认证的边界（对应任务规则 4）

`DesktopQueue.report()` 计算
`reportDigest = sha256(JSON.stringify([status, text, artifacts]))`，并在 `validationRecords` **非空**时
把该数组追加为第四个元素，因此摘要覆盖的字段取决于提交时是否带了验证记录。
身份与租约由 `mutateClaim()`/`verifyActor()` 核验，`verifyValidationEvidence()` 另核验引用记录。
这些都无法从 `StoredTask` 离线复现：报告提交时的 `status` 未单独保存，租约、actor 校验与
`validationRecords` 是否参与摘要都不留痕。
因此本轮**不把** `state=needs_review`、`rawText` 非空或 `reportDigest` 存在提升为"已认证"，
只记为"有报告、认证未知"。`needs_review` 显示状态本轮因此不可达，属预期缺口。

## 4. TaskActionFacts 映射（本轮恒为 null）

任务不强制生成 `TaskActionFacts`。现有存储缺少其全部绑定输入，故 `actionFacts: null`，
并按字段记录缺口。**不使用**空字符串、默认 `true` 或"猜测没有必需项"的空数组代替。

| 字段 | 现有存储中的近似物 | 为何不能采用 |
|---|---|---|
| `review.reviewId` | `reviewNote` / `reviewedAt` | 它们是验收备注与时间，不是不可变 `reviewId` |
| `review.taskId` / `attemptId` | 可取自 task/attempt | 无 `reviewId` 时无意义 |
| `agreementVersion` | `submissionHash` | 它是规范化初始提交摘要，不是 vNext 约定版本 |
| `currentSourceSummary` | 无 | 本轮不做源码扫描 |
| `requiredCheckIds` | `acceptanceCommands` | 是命令列表，不是结构化必需检查；空数组不等于"没有必需项" |
| `rework.attemptLimit` / `attemptNumber` | `task.attempt` | 只有已用轮次，没有上限与政策结论 |
| `rework.modelVerified` / `modelPolicySatisfied` | 模型 ID / 免费目录标签 | 标签不是刚完成的模型校验 |
| `cancellationAvailable` | 无 | 归属与控制条件未持久化 |

`allowedActions` 本轮**恒为 `["export"]`**：写操作统一不开放，这是适配覆盖范围的限制，
不是 `deriveTaskAllowedActions` 的行为改变。

## 5. 缺口代码

| 代码 | 含义 |
|---|---|
| `attempt_missing` | task 无持久 attempt id；不提升历史行，不生成编号 |
| `attempt_identity_mismatch` | attempt 行指向另一个 attempt |
| `attempt_task_mismatch` | attempt 行属于另一个 task |
| `attempt_session_mismatch` | attempt 行指向另一个 session |
| `attempt_runtime_source_mismatch` | attempt 行属于另一个 runtimeSource |
| `attempt_record_missing` | 有 attemptId 但未提供 attempt 行 |
| `attempt_snapshot_mismatch` | attempt 与 snapshot 彼此冲突（session / runtimeSource），冲突快照证据不采用 |
| `snapshot_missing` | 未提供运行快照，停止状态未知 |
| `snapshot_identity_mismatch` | 快照不属于本 task/attempt/session/runtimeSource，证据不采用 |
| `session_missing` | 一侧或两侧缺 sessionId；缺失不当作匹配 |
| `runtime_source_missing` | 一侧或两侧缺 runtimeSource；缺失不当作匹配 |
| `stop_proof_absent` | 有快照但无原生停止证据 |
| `stop_time_unavailable` | 停止证据成立但无可信停止时刻 |
| `report_authentication_unverified` | 有报告，但认证未建立 |
| `terminal_decision_undetermined` | 无法判定是否已有终态决定 |
| `terminal_cause_conflict` | 有决定，但 cancelled/failed 并存且无原因记录可排序 |
| `cancellation_reason_missing` | 取消记录存在但缺 reason；仍算已决定，原因不默认 |
| `acceptance_conflict` | accepted 决定与 attempt 行或关联校验不一致（决定仍保留） |
| `live_observation_absent` | 无实时观测，不产生可信实时状态 |
| `review_id_unavailable` / `agreement_version_unavailable` / `source_summary_unavailable` / `required_checks_unavailable` / `model_verification_unavailable` | 第 4 节所列 vNext 输入缺失 |
| `action_facts_not_constructible` | 上述缺失导致 `TaskActionFacts` 不可构造 |

## 6. 能表达与不能表达

可表达（有结构化来源时）：`accepted`、`cancelled`、`failed`、`expired`、`waiting_stop`、
`unknown`；`queued`/`running`/`waiting_input` 仅在调用方提供实时观测时可表达。

不可表达：`needs_review`（缺报告认证）。本轮不为此编造数据。

## 7. 测试覆盖矩阵

| 测试 | 证明的边界 |
|---|---|
| 无 attempt id | 不生成虚构身份，`facts: null`，仅 `export` |
| 无 attempt id + 提供历史 attempt 行 | **不提升**历史行，`facts: null` |
| 无 attempt id + task 自身 accepted | `facts: null`、`displayState: "accepted"`，不造编号 |
| attempt 身份不一致 | 当前 attempt 仍取自 task；外来行不贡献事实，`identityMatches = false` |
| attempt 属于其他 task | 其 accepted 不使本任务 accepted；其 cancelled/failed 不产生本任务终态 |
| accepted + attempt 冲突 | accepted 保留，`acceptance.conflict = true` |
| attempt runtimeSource 冲突 | 该行不可用，`attempt_runtime_source_mismatch` |
| attempt session 冲突 / 单侧缺失 / 双侧缺失 | 分别记录不一致或缺失；缺失不当作匹配 |
| task 缺 session、attempt 与 snapshot 的 session 互相冲突 | 直接比较二者，冲突快照的停止证明不采用（`attempt_snapshot_mismatch`） |
| task 缺 runtimeSource、attempt 与 snapshot 的 runtimeSource 互相冲突 | 同上 |
| 外来 attempt + 独立匹配的合法 snapshot | 外来 attempt 不污染该快照，其停止证明仍可用 |
| 无快照 | `stop.proven = null`，不当作已停止 |
| 快照归属不一致 | 停止/报告证据不采用，`identityMatches = false` |
| 仅 worker 自报完成 / `end_turn` | 不算停止已确认，不算 accepted |
| 真实程序停止证据 | `stop.proven = true`，`stop.at` 取 `nativeStoppedAt` |
| 旧停止证据无时间 | `stop.proven = true` 且 `stop.at = null` |
| `not_dispatched` 无原生 session | 停止仍可确认；不要求 session，不报 `session_missing` |
| 过期的 working 快照无实时观测 | 不显示为可信活跃状态（`unknown`） |
| 实时 `identityMatches` 为 `null`/`false` | 不产生 `running`/`queued`/`waiting_input` |
| 实时 `identityMatches` 为 `true` | 正常路径仍为 `running` |
| 首次 `deadline` + 后续 `cancelled` 状态 | 原因仍为 `deadline`（`expired`） |
| 首次 `deadline` + 后续 `failed` 状态 | 原因仍为 `deadline` |
| `cancelled`/`failed` 并存且无原因记录 | `cause: null` + `terminal_cause_conflict` |
| 取消记录只有 `requestedAt`、无停止证明 | `decided: true`、`cause: null`、显示 `waiting_stop`，不显示 `running` |
| 取消记录只有 `requestedAt`、停止已确认 | 显示 `unknown` |
| 取消记录只有 `requestedAt` + 已持久化 accepted | 仍显示 `accepted` |
| 带 reason 的正常取消记录 | `cause: "cancellation"`，无 `cancellation_reason_missing` |
| 完全没有取消记录 + 实时观测 | 仍可为可信 `running`（对照） |
| 明确取消决定 + 迟到报告 | 决定不被改写，原因保持 `cancellation` |
| accepted + 断线/证据冲突 | accepted 保留，冲突显式返回 |
| 缺 vNext 审查/约定/源码 | `actionFacts: null`，逐项缺口，`allowedActions` 仅 `export` |
| 输入不被修改 / 结果确定 / 缺口顺序稳定 | 纯函数性质 |
