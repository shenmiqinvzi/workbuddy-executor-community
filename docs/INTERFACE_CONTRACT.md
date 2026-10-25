# WorkBuddy Executor vNext 接口契约

修订日期：2026-10-25。第 1–7 节保留 `workbuddy-executor/vnext-1` 完整目标语义；HTTP 当前为 `workbuddy-executor/stage-2` 的部分只读能力，准确响应见[阶段说明](WORKBENCH_STAGE_HTTP.md)。第 8 节为 `workbuddy-executor/vnext-2` 多 Agent 目标；T3a 已实现显式版本分派和内部派工准入，其余目标尚未实现，不给旧 vnext-1 偷加字段。阶段状态见[进度](PROGRESS.md)，产品政策见[协作设计](COLLABORATION_DESIGN.md)。服务实现、mock 与客户端按对应版本核对；未知数值用 null，不用字符串 NA 或 0 替代。

## 1. 入口与兼容方式

新增本地接口前缀为 `/workbench/v1`，不是已有 `/v1/runs`。MCP 保留现有工具名及兼容返回字段，新增的统一任务视图放入 `view` 字段；两个入口均经 TaskApplicationService。旧调用不得绕过同一排他、预算和验收规则。

stage-2 已支持监听 `127.0.0.1:18493` 与 `WORKBUDDY_WORKBENCH_PORT` 配置；是否已有运行服务取决于实际启动/部署。下表是完整目标，不代表全部已实现；写操作、workspaces/export 的当前边界见阶段说明。认证、Host/Origin 与内容类型检查由 HTTP 层负责，业务正确性由共享服务负责。

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

## 8. 多 Agent 扩展草案（vnext-2，待实现）

T3a 更新：vnext-2 的校验/持久化、工作区与政策准入、方案绑定、固定轮次/期限已在内部服务和兼容 MCP 参数实现，见[实现说明](T3A_DISPATCH_ADMISSION.md)。本节的发现/额度/方案 HTTP、新 TaskView、自动调度与 DSH 仍为目标；不能据此宣称整节已实现。

本节规定新设计边界，不声明新增端点已经可用。启用前须同时提交 schema、类型、合成 fixture、旧版本兼容和对应验收。stage-2 端口、响应和 GET 零任务写入规则保持不变；旧 vnext-1 解析器继续拒绝未知字段与 vnext-2。

### 8.1 版本与派工约定

vnext-2 保留目标/工作区/范围/检查/期限/轮次字段；把 vnext-1 顶层 `model` 替换为 `execution`，不得同时提交两套模型字段：

```json
{
  "schemaVersion": "workbuddy-executor/vnext-2",
  "execution": {
    "executorId": "dsh",
    "connectionId": "example-gateway",
    "providerId": "example-registered-provider",
    "modelId": "example-model",
    "reasoningEffort": null
  },
  "collaboration": {
    "planId": "example-plan",
    "expectedPlanRevision": "example-plan-revision"
  }
}
```

上例仅为扩展字段片段，不是可提交的完整任务。`connectionId` 指本机登记的模型来源连接，`providerId` 指执行器内对应的原生来源路由；WorkBuddy 连接与 DSH 代理连接分别登记。ID 必须经服务端解析，不能由请求指定任意 URL、凭据或会话文件。

有效模型政策快照、工作区解析、原生会话绑定、方案确认者与时间、额度准入引用均由服务端保存，不接受客户端自报 verified/free/approved 结论。模型与执行器首期在同 task 内固定，返工重新核验原绑定，不允许旧 rework 的 model 参数绕过约定。vnext-1 保持原精确免费政策与既有摘要，旧记录不由 GET 迁移。

### 8.2 协作方案与确认

`CollaborationPlan` 包含 planId、revision、decision=direct/delegate、mode=manual/recommend/automatic、workspaceId、目标摘要、建议 execution、理由与候选拒绝原因、policyVersion、quotaSnapshotRefs、confirmation、createdAt/expiresAt。`direct` 的 execution 为 null，不建立原生 attempt。confirmation 区分 required/authorized/rejected/expired；授权主体由可信入口记录，客户端不能通过字段自批。

方案不确定时返回候选与缺口，不默认选最新 DSH 会话。manual 模式遵守已授权的明确选择；recommend 等待真实确认；automatic 必须引用有效的预授权政策。政策只授权派工范围，不授权提交、推送、部署或批准原生权限。

提交引用确切方案 revision；过期、政策撤回、参数被改或方案已绑定不同 task 时拒绝。准入重新验证来源、模型与容量，持久记录 task 绑定和意图；同一已确认方案不能被两个 taskId 消费来重复派工。模型准备与派工结果不明继续保留原 operationId 和占用。

### 8.3 执行器发现与模型证据

候选接口（均加 `/workbench/v1` 前缀）：

| 方法与路径 | 目标职责与边界 |
|---|---|
| GET `/executors` | 已登记执行器、兼容版本、独立能力和最后观测；不激活会话或派工 |
| GET `/executors/:id/models` | 已采集的来源/模型目录、支持档位、核验级别与新鲜度；不切模型、不探测请求 |
| GET `/resources/quotas` | 已保存的脱敏额度快照；不直接代理任意网关接口 |
| GET `/collaboration-plans/:planId` | 已保存方案，未找到不代建 |
| POST `/collaboration-plans` | 生成/保存方案；只读本地上下文和缓存元数据，不调用 worker 或额外模型 |
| POST `/collaboration-plans/:planId/confirm` | 确认指定方案 revision；不立即开始 worker |
| POST `/tasks`（vnext-2） | 引用方案并完成持久准入；实际模型准备/派工在受控意图后发生 |

以上 POST 依赖 T4 及写操作关口，不随文档发布开放。方案创建/确认也需要鉴权、稳定 operationId、参数摘要和重放规则；并发确认使用 expectedPlanRevision，不能套用不存在的 task attempt。新的只读发现/额度接口以独立资源版本发布，不能假装 stage-2 DTO 已增加字段。

执行器能力分别声明 modelCatalog/selectModel/observeEffectiveModel/cancel/proveStopped/navigateSession/automaticReview/usageAttribution。未知能力为 unavailable，不能根据模型目录推导停止或审查可用。

目标 TaskView 新增 collaboration 方案引用、execution（请求/选择/实际请求模型及核验层级）、policySnapshotRef、quotaAdmissionRefs。原生 binding 含 executorId、nativeWorkflowId（无则 null）与当前 session；runtimeSource 必须来自已验证适配器标识，DSH 不能填写 desktop_queue。草案不新增 displayState；停止不明与 unknown 继续按第 3 节规则降级。

### 8.4 额度快照与计量

`QuotaSnapshot` 目标字段：snapshotId、connectionId、scopeId、scopeKind（gateway_pool/routed_pool/unverified）、shared、modelId、unit（tokens/credits/currency）、currency（无则 null）、valueKind（reported/estimated/unavailable）、availability（available/exhausted/unknown）、freshness（fresh/stale/unavailable）、used/budget/remaining、resetAt、sourceObservedAt、collectedAt、expiresAt、method、limitations。

scopeId 是匿名稳定标识，不是密钥或原始账号。gateway_pool 只能标网关汇总；只有核验当前连接的 Key 区域/模型/账号路由后才可称 routed_pool。不同单位分行，不相加；同池引用按 scopeId 去重。耗尽状态必须有来源证据，不能由 null 或一次请求失败推断。

来源观察时间无法取得时 sourceObservedAt=null，不能以采集时间冒充。freshness 按明确的最大陈旧期限计算；失联保留末次快照并标 stale。资源快照自身变化不重写已绑定 task 的 revision；新派工准入保存实际使用的快照引用和政策。快照没有原子预留上游额度的效果。

单任务 usage 增加 attribution=exact/connection_only/unavailable、coverage、来源请求引用及 limitations。exact 仅在任务与请求、重试、计量记录完整关联且去重后使用；关联不全为 null，不用网关余额差代替。共享池其他客户端消耗不计为当前任务消耗；Planner/Reviewer 与 worker 分项统计。

资源采集是单独后台动作，有超时、缓存、退避与凭据隔离；GET 只读本地资源快照。主动模型探测不属于 GET，也不因浏览器刷新启用。上游估算不满足硬费用限制时不可提交需要该保证的付费任务。

### 8.5 事件、错误与迁移

新增目标事件：collaboration_plan_recorded、collaboration_plan_authorized、execution_binding_verified、execution_binding_changed、quota_admission_recorded。派工前方案事件属于 plan 自身日志；关联 task 后引用原记录，不能假造 task attempt。额度后台采集有独立资源日志，不把每次轮询塞入任务事件。绑定变化来自实际观察，不以配置文件值充当运行证据。

新增目标错误：EXECUTOR_UNAVAILABLE、EXECUTOR_CAPABILITY_MISSING、SESSION_AMBIGUOUS、MODEL_BINDING_CHANGED、PLAN_STALE、PLAN_CONFIRMATION_REQUIRED、POLICY_CHANGED、QUOTA_UNAVAILABLE、QUOTA_EXHAUSTED、COST_CONTROL_UNAVAILABLE。模型/政策/费用拒绝为 403；方案/绑定/耗尽冲突为 409；来源或必要观测不可用为 503。等待确认或额度恢复可以是合法方案状态，不一律包装为任务失败。错误 message 不含连接凭据、原始账号或私有路径。

兼容验收须覆盖旧客户端对新 schema 的明确拒绝、旧报告来源保留、未绑定模型/额度的旧任务显示 null、写入迁移事务与失败回滚、备份与降级限制。不得从旧 model 字符串反推 DSH 来源、实际模型或历史额度；新增能力须逐项开关，不以 schema 名称代表执行器已通过真实验收。
