# WorkBuddy Executor vNext 接口契约

契约版本：`workbuddy-executor/vnext-1`。状态：完整目标契约尚未实现；现有MCP只有基础statusView，不能等同于本文的完整TaskView。本次仅同步实现状态，未改变协议语义。具体阶段见[开发进度](PROGRESS.md)，前端合成样本任务见[Issue #6](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/6)。服务实现、mock与客户端共同依据本文件；改动enum、字段含义、动作或指标口径时先更新本文及对应fixture，再合并实现。可选字段用null明示未知，不使用字符串NA或0替代未知。

## 1. 入口与兼容方式

新增本地接口前缀为 `/workbench/v1`，不是已有 `/v1/runs`。MCP 保留现有工具名及兼容返回字段，新增的统一任务视图放入 `view` 字段；两个入口均经 TaskApplicationService。旧调用不得绕过同一排他、预算和验收规则。

默认监听 `127.0.0.1:18493`，计划增加 `WORKBUDDY_WORKBENCH_PORT` 配置。它不是当前已经可用的端口。认证、Host/Origin 与内容类型检查由 HTTP 层负责；业务正确性由共享服务负责。

| 方法与路径 | 输入/作用 |
|---|---|
| GET `/health` | 版本、就绪状态、运行/磁盘哈希及 capabilities；健康检查不派工 |
| GET `/workspaces` | 已登记项目列表及可显示的项目名/路径；任务只选择已登记 workspaceId |
| GET `/tasks?limit=50&afterTaskId=...` | createdAt、taskId 稳定排序的列表；limit 上限 100 |
| POST `/tasks` | SubmitTask；created=true 返回 202，相同请求复用返回 200 |
| GET `/tasks/:taskId` | TaskView，本地快照，不触发模型请求 |
| GET `/tasks/:taskId/events?afterEventId=0&limit=100` | 跨轮次稳定事件游标；上限 200 |
| POST `/tasks/:taskId/rework` | 重用同一任务和原生会话，建立下一轮 |
| POST `/tasks/:taskId/cancel` | 正式取消并观察，不把请求成功当停止 |
| POST `/tasks/:taskId/reviews` | 提交独立语义/检查记录；不执行验收 |
| POST `/tasks/:taskId/accept` | 引用 reviewId 进行当前轮次最终验收 |
| GET `/tasks/:taskId/export` | 返回脱敏 JSON 统计与交付清单，不打包任意本机路径 |

以上路径均需加前缀。首版不新增网页权限批准接口。项目登记继续走经核验的本机设置/CLI，安装指南需明确这一步；HTTP 提交接口不能凭任意目录字符串绕过登记。

响应形状统一：health 返回 `{schemaVersion,ready,runtime,capacity,modelPolicy,capabilities}`；capacity 为 `{limit:1,occupiedByTaskId:string|null}`；capabilities 至少有 nativePermissionResponse=false、nativeSessionNavigation=false（验证后才可变 true）。workspaces 返回 `{workspaces:[{id,displayName,displayPath}]}`；列表返回 `{tasks:TaskView[],nextAfterTaskId:string|null}`；详情直接返回 TaskView；事件返回 `{events:Event[],nextEventId:number}`。事件游标语义：`nextEventId` 是**本次返回页的续读游标**（本页最后一条 `eventId`；空页保持请求的 `afterEventId`；空流为 `0`），逐页续读拼接即全流；它不是全流高水位标记。详情读取同时受证据一致性约束：若 run 文件事实领先于任务行持久化的证据摘要，详情返回 400 `EVIDENCE_STALE`（提示执行 sync 后重试），不返回"新事实+旧 revision"的混合答案。

所有 POST 成功返回 `{schemaVersion,created,view,operation,reviewId}`，无关字段为 null。operation 为 `{id,status}`，status 为 in_progress/succeeded/failed/outcome_unknown；任务接收成功不代表执行完成。GET export 返回 MetricSummary 及交付清单，不包含原生历史。

## 2. 任务提交

下面 JSON 为合成的设计示例，不是真实任务或已存在的原生绑定。

```json
{
  "schemaVersion": "workbuddy-executor/vnext-1",
  "taskId": "example-fix-001",
  "workspaceId": "example-project",
  "title": "修复折扣边界",
  "objective": "修复折扣计算并补充边界测试",
  "model": "deepseek-v4.1-flash",
  "timeoutSeconds": 1800,
  "maxAttempts": 3,
  "scope": {
    "allowedChanges": ["src/Discount.java", "test/DiscountTest.java"],
    "permittedMetadata": []
  },
  "requiredChecks": [
    {"id": "discount-contract", "kind": "command", "definition": "运行项目已登记的折扣测试检查"},
    {"id": "normal-behavior", "kind": "semantic", "definition": "原有效输入行为保持不变"}
  ]
}
```

- `taskId` 在首次提交前由客户端生成，重连和不明确结果时复用。服务端保存规范化后的 immutable contract hash；相同 taskId 不同初始约定返回冲突。
- `scope` 使用相对路径的精确文件或 `directory/**` 两种模式；首版不支持其他 glob、取反或工作区外路径。新文件必须匹配已声明路径；重命名同时验证旧、新路径。
- `maxAttempts` 是请求上限，取请求值与服务端政策的较小值；默认 3。客户端不能增加已存在任务的上限。
- 超时起点是服务端建立当前 attempt 的时间，deadline 固定后返回；精确 claim/report/hard deadlines 由后端政策给出，前端不得重新计算并替换它们。
- command 类型引用已登记的检查配置，网页不提交任意可执行命令。检查由验证适配器解析；无法可靠自动执行的检查返回 unknown 并要求显式复核，不能假装运行过。
- 服务端确认模型目录费率和本地免费模型政策，不信任客户端传入“免费”结论。未知或不符时不派工。
- 标题 1–120 字符，目标 1–100000 字符；scope/requiredChecks 各不超过 100 项；HTTP JSON 不超过 1 MiB。超限、未知字段及不支持的 schemaVersion 在派工前拒绝。

## 3. TaskView 与按钮状态

```json
{
  "taskId": "example-fix-001",
  "revision": "example-revision-7",
  "title": "修复折扣边界",
  "workspace": {"id": "example-project", "displayName": "课程项目"},
  "attempt": {"id": "example-attempt-1", "number": 1, "limit": 3},
  "binding": {"sessionId": "example-session", "runtimeSource": "desktop_queue"},
  "businessState": "blocked",
  "displayState": "waiting_input",
  "remoteStopped": false,
  "allowedActions": ["cancel", "export"],
  "blocker": {
    "kind": "native_permission",
    "summary": "需要在 WorkBuddy 中确认操作",
    "detailsStatus": "unavailable",
    "toolName": null,
    "commandSummary": null,
    "targetPath": null,
    "sessionTitle": "执行：课程项目",
    "resolutionChannel": "native_ui",
    "canRespondViaGateway": false
  },
  "timing": {
    "createdAt": "2026-10-18T08:00:00.000Z",
    "attemptDeadlineAt": "2026-10-18T08:30:00.000Z",
    "terminalDecisionAt": null,
    "nativeStoppedAt": null,
    "reviewedAt": null,
    "closedAt": null,
    "lastObservedAt": "2026-10-18T08:01:00.000Z"
  }
}
```

`revision` 是持久化、不可猜测的视图修订标识；必须随影响操作条件的任务、轮次、原生证据或验收状态改变而变化。客户端只回传它，不自行递增或用本地时间构造。

`remoteStopped=true` 只表示已取得当前轮次的停止证明；false 表示未证实停止，不能单凭 false 推断仍在运行。显示是否活跃还须结合原生观测时间、健康状态与归属。

TaskView 还须包含下列字段；上例为突出阻塞而省略它们：`checks:CheckResult[]`、`changes:[{path,kind,category,status}]`、`artifacts:[{artifactId,relativePath,bytes,sha256}]`、`metrics:MetricSummary|null`。空集合为 []，尚未观测的 bytes/hash 为 null；category 为 deliverable/metadata/unauthorized。scope 检查另标 coverage=workspace_inventory，可附 mediated_tool_paths，不声称覆盖完整进程文件系统。TaskView 不返回可由客户端任意替换的绝对产物下载路径。

`displayState` 枚举：queued、running、waiting_input、waiting_stop、needs_review、accepted、cancelled、failed、expired、unknown。原始业务/原生事实保留，不能为展示直接改写旧数据库状态。

显示与允许动作按以下顺序确定：

1. 已有真实最终验收决定显示 accepted；身份或证据冲突另报错误，不凭客户端缓存创建决定。
2. 到期/取消/失败已作决定：尚无原生停止证明时显示 waiting_stop，不释放排他，只可观察、重复观察取消请求及导出；停止已确认时直接显示 expired/cancelled/failed。以下规则仅适用于没有这些终态决定的任务，迟到报告不改变此优先级。
3. 原生正在等待输入且未到期：显示 waiting_input，可取消及导出；只有 native_ui 恢复输入，不允许 rework/accept。
4. 报告已到但未停止：waiting_stop；报告已认证且停止确认：needs_review。
5. 原生与记录一致且活跃：queued/running；断线、身份冲突或事实不够：unknown，并保留排他。
6. needs_review 保留当前工作流排他，直到 accepted 或用户明确结束。

`allowedActions` 为服务端建议，动作枚举 submit/rework/cancel/review/accept/export；view 中不放 submit，submit 由 health/capacity 决定。服务端执行时必须重新核验；不能因按钮此前启用就执行过期操作。

已取消任务不能 rework。expired 的迟到报告可以查阅但不能验收；本版不提供从 expired 直接续期的 UI。因用户目标变化确需新任务时，先明确结束原流程和停止归属，再由用户显式创建新约定，不作为自动重试机制。

会话导航能力由 health.capabilities.nativeSessionNavigation 声明。未验证时 false，面板显示定位说明；不得生成未经验证的应用 deep link。

## 4. 变更操作、幂等与排他

rework、cancel、reviews、accept 请求都有 `operationId`、`expectedRevision` 和 `expectedAttemptId`。rework 额外带 feedback 与精确 model；accept 带 reviewId。cancel 可带 reason，但不会改变首次取消/截止原因。

reviews 额外提交 `{machineCheckIds:string[],semanticChecks:[{checkId,status,note,evidenceRefs}],note}`。machineCheckIds 只能引用后端已经验证的本轮机器记录；客户端不能提交 actor=program 或伪造机器检查的 passed。semanticChecks 的 checkId 必须在原约定中、类型必须为 semantic；actor 与调用通道由服务端根据实际入口记录。成功时 reviewId 非 null，其余动作 reviewId 为 null。

服务端以 SQLite 事务预留 operationId 与执行容量，保存参数摘要。同 operationId、同参数重放原结果；不同参数返回 OPERATION_CONFLICT。并发旧 revision 返回 STALE_REVISION。操作结果不明时返回 OUTCOME_UNKNOWN 和原 operationId，客户端只查原任务，不换 ID 重发。

原生副作用前持久化意图，结果后持久化回执。进程在中间崩溃时以原任务身份恢复观察，不能把“数据库未写成功”推断为“原生未派发”。待观察的不确定操作继续占有容量。

共享网关数据目录的容量为 1。MCP、HTTP、CLI、多个进程共同遵守同一个持久锁/租约；仅 JavaScript Promise 队列不够。锁不因简单 TTL 或浏览器关闭释放，只有工作流已关闭、停止证据明确后才能释放。不得在旧 HubEngine 另分配第二份同执行器容量。

原生停止与文件证据不是 SQLite 内部事实：事务预留后、实际副作用前需再核对当前归属/证据摘要；变化时停止操作、刷新 revision，保留意图与错误，不能跨轮次使用旧校验。

## 5. 检查与验收记录

CheckResult 必有 checkId、kind（provenance/scope/command/semantic）、status、attemptId、evidenceRefs、inputHashes、checkedAt、checkerVersion、actor（program/independent_reviewer/worker）。status 为 passed/failed/unknown/not_applicable/checker_error。worker 记录不能充当独立验收记录。

证据引用必须能关联到真实命令记录、文件快照或明确的人工检查记录；不接受网页仅提交“测试通过”字符串。reviews 生成不可变 reviewId 并关联约定版本、attempt、源码摘要和全部必需检查。旧记录不覆盖新记录。

accept 要求：当前 needs_review、匹配身份与认证报告、remoteStopped=true、必需检查均通过、scope 无冲突、reviewId 属于当前约定与当前源码。not_applicable 仅适用于约定预先声明的非必需项。

checker_error 的处理：保留原结果，提交引用原任务的独立复核或修复后的检查记录。只有内容/格式等约定解释允许独立复核；来源、停止、目录归属和验证哈希不能人工豁免。更正是 reviewer_error，不伪造 worker 失败或擦去已经发出的返工。

## 6. 事件与指标

事件 Event 为 `{eventId, taskId, attemptId, type, occurredAt, observedAt, actor, payload, sourceRef}`。eventId 在同一 task 跨 attempt 单调递增并持久化，原生每轮 seq 另保留为 payload.nativeEventSeq。重复同步同一原生事件不能生成第二个逻辑事件。

必需事件包括 task_received、attempt_queued、native_claimed、input_requested、input_resolved、report_received、native_stop_confirmed、review_recorded、rework_requested、cancel_requested、deadline_exceeded、task_closed、tool_call_finished、recovery_recorded。仅凭 elapsed time 不能编造缺失事件。

- terminalDecisionAt：取消、失败或截止决定的实际事件时间。
- nativeStoppedAt：原生停止证据所证明的时间；不拿报告时间替代。
- closedAt：accepted 时为 reviewedAt；其他终态在决定和停止都明确时，为两者较晚的实际时间。旧证据缺少可靠时间则为 null。
- lastObservedAt：最近观察时间，不能覆盖上述事实时间。
- wallElapsedSeconds：`closedAt - createdAt`；queue/input 等子时段仅在两端证据存在时计算。额外输出观察滞后，不把离线时段称为活跃监督。

MetricSummary 必含 schemaVersion、taskId、complete、timing、calls、acceptance、rework、recovery、interventions、usage、limitations。数值未知为 null，CSV 导出为 NA。

calls 按 channel 与 outcome 分组；channel 为 mcp/cli/native/local_check，outcome 为 succeeded/failed/outcome_unknown。捕获字节注明 stdout/stderr/combined/wire 及测量层；不同层不能重复相加成“总传输量”。

rework 统计真实已发送的外部反馈轮数，reason 为 worker_content/worker_scope/reviewer_error/unknown；被拒绝而未发送的 continuation 记操作失败/恢复，不增加 worker 返工轮数。worker 自纠仅在有证据时另记，否则 null。

interventions 以 episodeId 去重，记录 requested/resolved/rejected/expired、requestedAt/resolvedAt；一次请求与一次回复不算两次。仅从原生“user cancelled”标签无法确定操作者时，actor 保持 unknown。

usage 区分目录费率标签、实耗额度、token 与活跃推理时间。未取得真实计量时 actualCredits/tokens/activeReasoningSeconds 为 null；免费标签不等于整个 Codex+WorkBuddy 工作流零成本。

## 7. 错误与 mock 清单

错误 envelope：`{error:{code,message,retryable,taskId,attemptId,operationId},view}`。敏感信息不进入 message。已知业务冲突返回 409，政策/权限拒绝 403，参数错误 400，无法观察执行器 503；业务“等待用户”通常是 200 TaskView，不伪装为成功交付。

必需 code：TASK_CONFLICT、OPERATION_CONFLICT、STALE_REVISION、STALE_ATTEMPT、EXECUTOR_BUSY、MODEL_UNVERIFIED、MODEL_POLICY_BLOCKED、INPUT_REQUIRED、STOP_UNCONFIRMED、ATTEMPT_LIMIT、CANCELLED_TERMINAL、DEADLINE_EXCEEDED、SCOPE_VIOLATION、WORKSPACE_CONFLICT、EVIDENCE_STALE、CHECKS_INCOMPLETE、OUTCOME_UNKNOWN。

首批 mock 必覆盖全部 10 个 displayState，并至少包含：权限详情未知、报告先于停止、过期 revision、3 轮耗尽、断线重连、取消后仍未停止、成本未知、checker_error、严格范围失败、用户旧改动冲突。mock 数据使用合成项目和身份，不含账号、真实运行目录或私有历史。
