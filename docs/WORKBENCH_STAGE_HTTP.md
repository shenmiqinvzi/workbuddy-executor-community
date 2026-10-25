# Workbench 只读 HTTP 阶段说明(stage-2,T2)

2026-10-25 修订：本文记录的任务 stage-2 响应保持不变，不能按 vnext-2 草案解码。DSH、完整协作面板和 HTTP 写操作仍为[后续目标](COLLABORATION_DESIGN.md)；独立额度资源的 T3c 实现另见下文。

T3c 更新：任务 stage-2 DTO 保持原样，另新增独立 `quota-1` 的 GET `/workbench/v1/resources/quotas` 及显式配置后的后台采集，准确行为见[T3c 说明](T3C_QUOTA_OBSERVATION.md)。GET 只读缓存，不触发采集；没有新增 HTTP 写操作、模型探测或派工。

更新日期:2026-10-25。对应实现:`gateway/src/workbench-http.ts`、`gateway/src/task-view-stage.ts`、`gateway/src/task-application-service.ts` 的只读查询、`gateway/src/task-store.ts` 的持久任务事件/revision(T2)。契约依据:[INTERFACE_CONTRACT.md](INTERFACE_CONTRACT.md)。本文描述**本阶段**实际交付的能力与限制;完整 `workbuddy-executor/vnext-1` 契约的其余部分仍待后续阶段实现,不得把本阶段响应当作完整 TaskView。

## 1. 阶段响应与完整目标 TaskView 的区别

阶段 schema 标记为 `workbuddy-executor/stage-2`(自本阶段起由 stage-1 升级),与契约的 `workbuddy-executor/vnext-1` 显式区分。逐字段对齐:

| 字段 | 契约目标 | 本阶段实际 | 缺口归属 |
|---|---|---|---|
| `revision` | 持久、不可猜测的视图修订 | **已交付(T2)**:`randomBytes(12)` base64url 持久 token,随任务/轮次/报告/验收/取消/输入阻塞/原生绑定/停止证据/验收条件(constraints、acceptanceCommands)等事实变化在**受控写/同步路径**重新生成;纯只读轮询不改变它。历史行(升级前创建、未再发生事实变化)可能仍为 `null`,直到下一次真实事实写发生 | T2 已交付,兼容策略如上 |
| `title` | 任务标题 | 恒为 `null`。存储无标题字段,objective 不改标签顶替 | T3 |
| `workspace` | `{id, displayName}` | `{id:null, displayName:null, storedPath:存储的工作区目录或 null}`。无登记绑定,不伪造项目身份 | T3 |
| `attempt.limit` | 有效轮次上限 | 仅来自已验证存储契约的 `effectiveMaxAttempts`;无契约任务为 `null`(不默认 3) | T3 接入真实派工 |
| `binding` | `{sessionId, runtimeSource}` | 存储值原样,可为 `null` | — |
| `businessState` | 原始业务状态 | 存储的 `tasks.state` 原样 | — |
| `displayState` | 10 态枚举 | 投影纯推导值(`deriveTaskDisplayState`),无法建立时 `null` | — |
| `remoteStopped` | 当前轮次停止证明 | 投影事实:证明绑定当前轮次为 `true`,证明不存在为 `false`,投影失败为 `null`。`false` 不表示"仍在运行" | — |
| `allowedActions` | rework/cancel/review/accept/export 建议 | 恒为 `[]`。本阶段不开任何动作;export 依赖 T6 产物来源 | T6 |
| `blocker` | 原生阻塞详情 | 恒为 `null`(无实时观测,不猜权限类型) | T7 联调 |
| `checks/changes/artifacts` | 检查/变更/产物列表 | 恒为 `[]`,配合 `unavailable` 标记;投影 gaps(`required_checks_unavailable` 等)说明"无法建立",空数组不表示"没有要求" | T5/T6 |
| `metrics` | MetricSummary | 恒为 `null`(未计量) | T7 |
| `timing.createdAt` | 创建时间 | 存储值 | — |
| `timing.attemptDeadlineAt` | 固定截止 | 恒为 `null`(无持久绑定截止) | T3 |
| `timing.terminalDecisionAt` | 终态决定时间 | 恒为 `null`(事件流已具备推导素材,DTO 字段待 T3 接入) | T3 |
| `timing.nativeStoppedAt` | 原生停止时刻 | 仅当停止证明绑定当前轮次时取证据时刻,否则 `null` | — |
| `timing.reviewedAt` | 验收决定时间 | 存储值原样;**它不声明存在独立 reviewId 或完整验收记录** | T6 |
| `timing.closedAt` | 派生关闭时间 | 恒为 `null`(task_closed 事件已落库,DTO 字段待后续接入) | T3 |
| `timing.lastObservedAt` | 最近观察时间 | 任务行自身 `updated_at`(最后一次写库时间)。这是保存时间,**不是实时原生观测** | T7 联调 |

`unavailable` 数组(阶段响应与 health 共用)逐项命名本阶段不可建立的字段族;客户端应据此渲染"不可用"而不是把 null 解释为 0 或空语义。

保留未知原则:全部缺字段以 `null`/`[]` 表达,不使用 0、NA、当前时间、假 revision、假 reviewId、假检查结果、伪造工作区身份或原生状态补齐。

## 2. 只读查询语义

两个入口(MCP 工具与 HTTP)都调用 `TaskApplicationService` 的同一组阶段查询;它们复用 `readProjection` 的存储与 run 文件读取,保持其全部保证:

- **纯快照**:HTTP 查询不调用 `sync`、`executionStatus`、`checkWorker` 或任何同步/派工入口;读取前后任务库与 run 文件不变(有测试断言)。快照不等于实时状态。事件读取同样只读:`listTaskEvents` 不写任何表、不产生事件、不初始化任务状态(历史无 revision 记录不会因 GET 而补写)。
- **失败可区分**:`task_not_found`、`state_corrupt`、`state_unreadable`、`cancel_corrupt`、`cancel_unreadable`、`store_unavailable`、`contract_integrity`、`read_conflict`、`invalid_attempt_id`、`invalid_task_id`、`invalid_cursor` 逐个保留,绝不把权限错误、坏 JSON、完整性失败或跨轮次冲突当成"没有任务"。
- **unknown/null 原样保留**:报告认证缺失/篡改/绑定冲突保持 report unknown;displayState 随投影规则降级(如 unknown),不提升。

### 列表分页

- 顺序:`created_at ASC, task_id ASC`(契约的稳定游标序)。
- 游标:`afterTaskId`(最后一个任务的 taskId);服务端按锚点行做 keyset 过滤,并发更新不会移动行位置。
- `limit`:1–100,默认 50。
- `nextAfterTaskId`:仅在游标行之后确实还有任务时返回(存在性探测),否则 `null`;整页短于 limit 同样以探测为准。
- 非法游标(空、超长、不存在的 taskId)返回 400 `INVALID_CURSOR`,不返回空页。
- **与旧 MCP 列表的区别是明确的**:MCP `workbuddy_list_tasks` 保持 `updated_at DESC + offset` 行为不变,两条读取路径不互换、不静默统一。

### 事件流分页(T2 新增)

- 顺序:`event_id ASC`(单任务内单调递增,跨轮次/轮内事件共用一条流)。
- 游标:`afterEventId` 排他(从该 eventId 之后开始;`0` 或缺省=从头)。
- `limit`:1–200,默认 100。
- `nextEventId`:**恒为 number**(契约 :27),是**本次返回页的续读游标**:本页最后一条 `eventId`;本页为空时原样返回请求的 `afterEventId`(该位置之后确实没有更多事件);空流(从未有过事件)返回 `0`。逐页以 `nextEventId` 作为下一次 `afterEventId` 续读,拼接结果即全流,不跳过、不重复;耗尽后追加读取稳定返回空页+同一游标。它是分页游标,**不是**全流高水位标记——用流尾最大 eventId 当游标会静默跳过最后一段未读事件(T2-R6 修复的缺陷)。缺任务返回 404 `TASK_NOT_FOUND`(不为不存在的任务伪造空流)。
- 去重:同一来源事实(镜像 journal 事件按 `attemptId:type:journal:seq` 的 sourceRef;停止证明按 `attemptId:native_stop:<时刻>`)只落一条;幂等重放不产生重复事件。
- GET 永不写入:读取事件流不触发镜像、不补写、不初始化。

### 证据与 revision 一致性

任务行、当前轮次和 run 文件必须对应同一个持久 revision。报告正文/认证、身份、原生停止证明或取消记录改变后，GET 返回 `400 EVIDENCE_STALE`，不拼接新文件事实与旧 revision，也不在读取中执行 sync。调用者通过既有受控同步入口刷新后再查。同轮次任务 revision 在读取期间改变时返回 `503 READ_CONFLICT`。

同步会把实际报告内容摘要、task/attempt/session/source 身份、停止证明和取消原因纳入持久证据摘要，事实变化与 revision 在任务写入事务中提交；无变化同步保持 revision。历史没有 revision 的记录按旧快照语义兼容；新记录的运行证据未绑定时明确拒绝，不由 GET 初始化。已绑定 run 文件消失时同样拒绝，不冒充缺少报告。

## 3. HTTP 端点

默认 `127.0.0.1:18493`,可用 `WORKBUDDY_WORKBENCH_PORT` 覆盖(1–65535 整数,非法值启动失败)。只绑定 loopback。计划端口此前未实现;不自动替换当前运行网关。

| 方法与路径 | 状态 | 说明 |
|---|---|---|
| GET `/workbench/v1/health` | 200 | `{schemaVersion, ready, runtime, capacity, modelPolicy, capabilities, unavailable}`。`ready` 仅表示本进程共享服务已打开存储;`capabilities.nativePermissionResponse/nativeSessionNavigation` 恒 `false`(未独立验证);`modelPolicy.nativeModelBound` 恒 `false`(无已验证模型绑定);`capacity.occupiedByTaskId` 为 `null`(排他租约属 T4,不猜测占用者)。健康检查不派工 |
| GET `/workbench/v1/tasks?limit=&afterTaskId=` | 200 | `{schemaVersion, unavailable, tasks: StageListItem[], nextAfterTaskId}`。每个条目是二选一:成功 `{ok:true, taskId, view: StageTaskView}`;该任务投影失败时保留原样 `{ok:false, taskId, code, field, message}`(如 `state_corrupt`),绝不抹成空视图。页级失败(存储不可读、非法游标)仍走错误 envelope,`store_unavailable`→503、`invalid_cursor`→400,HTTP 错误码大写(`STORE_UNAVAILABLE`),服务层错误码小写(`store_unavailable`) |
| GET `/workbench/v1/tasks/:taskId` | 200 | 单个 `StageTaskView` 快照 |
| GET `/workbench/v1/tasks/:taskId/events?afterEventId=&limit=` | 200 | **T2 已交付**:`{events: Event[], nextEventId: number}`。Event 含 `eventId/attemptId/type/occurredAt/observedAt/actor/payload/sourceRef`(payload 原样 JSON;sourceRef 仅在事件来自可去重来源时非 null)。游标语义见 §2"事件流分页";`afterEventId` 非法→400 `INVALID_CURSOR`;任务不存在→404 `TASK_NOT_FOUND`。GET 不写库、不镜像、不初始化 |
| GET `/workbench/v1/tasks/:taskId/export` | 501 | `EXPORT_NOT_IMPLEMENTED`:待真实产物来源(T6) |
| GET `/workbench/v1/workspaces` | 501 | `WORKSPACES_NOT_IMPLEMENTED`:待真实登记绑定(T3) |
| POST/PUT/DELETE 等(已知路径) | 405 | `METHOD_NOT_ALLOWED`,带 `Allow: GET, HEAD`。不新增派工/返工/取消/审查/验收写入口 |
| 未知路径 / 非 workbench 前缀(含旧 `/v1/runs`) | 404 | — |

错误 envelope:`{error:{code,message,retryable:false,taskId,attemptId,operationId}, view:null}`;message 不含路径、存储内容或数据库文本。状态码:404 任务不存在、400 参数/游标/坏记录、503 存储不可读/读冲突/契约完整性、500 内部。

### 访问边界(全部有测试)

- 远端地址必须是 loopback(127.0.0.1 / ::1 / ::ffff:127.0.0.1),否则 403。
- `Host` 头必须是 loopback 字面量(127.0.0.1 / ::1,可带端口);`localhost` 等名字即使解析到本机也 403。
- `Origin` 存在时必须是 loopback 的 http(s) 源,否则 403(拒绝跨源浏览器读取)。
- 本阶段不读取任何请求体;HEAD 与 GET 等价(无响应体)。

## 4. 与 MCP get_task 的边界

MCP `workbuddy_get_task` 是**同步**处理器(调用 `sync` 拉取原生消息)。本阶段的 HTTP 详情不包装它;GET 详情走 `readStageView` → `readProjection` 的纯存储快照,二者语义不同且各自保留。MCP 的只读投影工具 `workbuddy_get_task_projection` 与 HTTP 共享同一投影事实,但响应形状不同(MCP 返回投影原样含 gaps;HTTP 返回 stage-2 DTO)。`sync` 产生的持久事件(任务事实、journal 镜像、原生停止证明)通过同一事件流对 MCP 与 HTTP 双侧可见。

## 5. 验证方式

- 类型/构建:`npm run build`、`npx tsc --noEmit -p tsconfig.task-view.json`。
- 测试:`test/workbench-http.test.ts`(HTTP 边界、分页、事件 GET、501/405、读取不变性)、`test/task-application-service.test.ts`(阶段查询、降级矩阵、游标稳定性、事件幂等/续读)、`test/task-store.test.ts`(revision/事件持久层)、`test/coordinator.test.ts`(同步/验收/取消生命周期)。
- 冒烟:`node gateway/scripts/workbench-smoke.mjs`,在隔离临时样本(合成库+run 目录)上启动真实 HTTP 服务,访问 health/列表/详情/分页/事件流(含 `nextEventId` number 断言与游标耗尽续读)/错误路径,并核对读取前后文件哈希不变。
- 手动启动(可选):`WORKBUDDY_WORKBENCH_PORT=18493 node dist/workbench-entry.js`。

## 6. 本阶段明确的未覆盖项

- export(501)、workspaces(501)。
- 一切写操作(POST 派工/返工/取消/审查/验收)——不存在于 HTTP 层,不是"暂时禁用"(受控写路径在存储层/协调层实现,不经 HTTP 暴露)。
- 实时观测:任何端点都不反映"此刻"原生状态;`displayState` 是存储事实的推导。
- `reviewId`、检查结果、工作区绑定、原生权限详情:均不生成。`revision` 已交付,历史 null 记录的兼容策略见 §1。
- 完整 vNext TaskView、面板联调、真实部署、异机验收:见交接文档 T3–T7。
