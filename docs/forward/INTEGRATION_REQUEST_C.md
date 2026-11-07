# C 线集成请求（需 I 落地）

分支 `feat/forward-observability`。下列每条给：触发函数名、插入点（文件:行）、参数、事务/重试规则、去重键、失败语义、最小验证。
凡涉及 I 独占文件（`task-store.ts`、`server.ts`、`workbench-http.ts`、`workbench/app.mjs`、公共 schema）的改动，本线不自行落笔。

---

## I-1 `local_check_finished` 生产（已落地，仅确认约束）

- 状态：**已由 I 在 `caa7a5f` 实现**（`gateway/src/task-reviews.ts` 的 `publishCallFact`），本线不再改该文件。
- 生产点：`TaskReviews.runCommand()` 每真实执行一条（带 `processStarted/exitCode/cleanupConfirmed/durationSeconds` 与实测 `stdout/stderr` 字节）；`TaskReviews.checks()` 每检查一条（不带字节）。
- 去重键：`review-call:command:<commandRecordId>`、`review-call:batch:<batchId>:<checkId>`，依赖 `task_events(task_id, source_ref)` 唯一索引。
- 失败语义：`not_applicable` 不产出；`checker_error`/`unknown` → `outcome_unknown`；写入失败不得改变检查结果本身。
- 最小验证：`npx tsx --test test/check-call-events.test.ts test/task-reviews.test.ts`（本线回归批：90/90 通过）。

---

## I-2 MCP 工具通道的 `tool_call_finished`（`channel:"mcp"`）

- 触发函数名：`gateway/src/server.ts:170` 的 `guard(action, detail, options)`；建议在其外层加一个具名包装（`guard` 当前不接收工具名）。
- 插入点：`server.ts` 的工具注册处（`:40` 起，每个 `server.tool("<name>", …)` 的 handler 外层），用一次统一包装，例如：

```ts
// 需要：单个包装函数 + 一个单调序号
let guardSeq = 0;
function withCallFact<T>(name: string, requestId: string | undefined, run: () => Promise<T>): Promise<T> {
  const startedAt = new Date();
  const callId = requestId ?? null;          // 没有稳定 id 就不产生产（见下）
  return run().then(
    async (value) => { if (callId) await recordGatewayToolCall(tasks.store, {
        taskId: taskIdOf(value) ?? "unattached-task",   // 无任务上下文则不写
        attemptId: null, callId, role: "supervisor", toolName: name,
        startedAt: startedAt.toISOString(), endedAt: new Date().toISOString(),
        status: "completed" }); return value; },
    async (error) => { if (callId) { try { await recordGatewayToolCall(tasks.store, { /* 同上，status:"failed" */ }); } catch {} }
        throw error; },
  );
}
```

- 参数：`{taskId, attemptId:null, callId, role:"supervisor", toolName, startedAt, endedAt, status}`；`recordGatewayToolCall()` 已存在于 `gateway/src/statistics-call-events.ts`，`channel:"mcp"`，`sourceRef="call:v1:mcp:<callId>"`。
- 去重键：MCP 侧的稳定请求标识（`callId`）。**拿不到稳定 id 就不产生产**——宁可不产，也不写一条无法去重的调用。因此本项允许「部分工具无事件」，回执按 `calls` 覆盖不足处理，但不得用忙闲轮询或本地序号冒充。
- 事务/重试：写入与工具结果无关，单独 `appendTaskEvent`；失败吞掉并计入 limitations，绝不改变工具返回、绝不重试工具本身。
- 失败语义：工具抛错 → `status:"failed"`（`failureKind:"tool_error"`）；工具成功但记录失败 → 工具结果照常返回。
- 最小验证：`npx tsx --test test/statistics-call-events.test.ts`（现有 11/11 覆盖 `recordGatewayToolCall` 的分组与幂等）+ 新增一条 `server` 级用例：调一个无副作用的只读工具两次同一 `callId`，断言 `task_events` 只有一条 `tool_call_finished`。

---

## I-3 真实请求写入归因账本（C03 的最后一公里）

- 触发函数名：`gateway/src/dsh-coordinator.ts:116` 的 `private async dispatch(binding, feedback, prepare, scopeGuard)`，在 `:155` 的 `if (result.requestId !== binding.requestId || result.accepted !== true) throw Error("unconfirmed");` **之后**、`:156` 的 `this.store.atomic(...)` 之前。
- 参数（全部来自已经可见的字段，不推测）：

```ts
recordRequestObservation(this.store.usage, {
  requestId: result.requestId,                 // prompt 返回值，唯一可信的请求标识
  taskId: binding.taskId, attemptId: binding.attemptId,
  sessionId: binding.sessionId, executorId: "dsh", runtimeSource: "dsh",
  connectionId: null,                           // dsh 侧没有连接声明
  providerId: null,                             // 上游不发布
  modelId: binding.execution.modelId, reasoningEffort: binding.execution.reasoningEffort,
  role: "worker",
  occurredAt: new Date().toISOString(), observedAt: new Date().toISOString(),
  retryOf: binding.retryOf ?? null, retryIndex: binding.retryIndex ?? null,
  scopeKind: "unverified", scopeId: null, method: "harness_does_not_report_usage",
}, "dsh-dispatch", new Date());
```

- 前置（I 独占文件）：`gateway/src/task-store.ts:155` 的 `TaskStore` 增加一个只读字段，与既有 `quotas`/`creditBalances` 同形：

```ts
readonly usage: UsageLedger;   // 构造函数内 new UsageLedger(db) —— 与 quotas/creditBalances 同一 sqlite
```

- 事务/重试：`UsageLedger.record()` 自身按 `(requestId, unit)` 唯一键幂等，重放返回 `duplicate`；不参与任务状态事务，写入失败只记 limitation，**不得**让已经接受的派工回滚。
- 去重键：`usage_records(request_id, unit)`，`sourceKey = <sourceScope>|<requestId>|<unit>`；同一请求被多角色/多轮读取只保留首观测（`duplicate`），不双计。
- 失败语义：`tokens` 与 `credits` 各写一行 `valueKind:"unavailable"`、`value:null`（上游不发布用量）；没有金额就是 `null`，不写 0；`unallocated` 由 `summarizeUnallocated()` 统计，覆盖率由 `summarizeRequestCoverage()` 给出（分母未知 → `unknown`）。
- 最小验证：`npx tsx --test test/usage-attribution-adapter.test.ts`（6/6）+ 一条 `dsh-adapter` 级用例：一次真实 `dispatch` 后 `readUsageRecords(store.db, {taskId})` 有 2 行、`valueKind` 全 `unavailable`；重复 `dispatch` 同一 `requestId` 不增行。

---

## I-4 统计导出端点（B/D 的消费者契约出口）

- 触发函数名：新增 `handleStatisticsExportRequest(sources, pathname)`（本线可写，`statistics-*.ts` 属 C），需要 I 在 `gateway/src/workbench-http.ts` 挂路由。
- 插入点：`workbench-http.ts:322` 那一组 `pathname === "/workbench/v1/resources/..."` 附近，加 `|| pathname === "/workbench/v1/statistics/export"`，并在 GET 分支调用 `handleStatisticsExportRequest`，方法与只读约束与统计端点一致（`GET`/`HEAD`，其它 405，`Allow: GET, HEAD`）。
- 参数：`{ sources, query }`，query 复用 `parseStatisticsQuery`（`from`/`to`/`limit` 语义不变）。
- 输出：`buildStatisticsExport(overview, { generatedAt })` 的结果，`readOnly:true`、`snapshotOnly:true`、`schemaVersion:"workbuddy-executor/statistics-export-1"`、`contractVersion:"statistics-export-contract-1"`、`windowSemantics:"task_created_at_utc_start_inclusive_end_exclusive"`、`freshness`、`coverage{tasks,events,requests,tokens,amounts}`、`claims{savings:null,superiority:null}`。
- 事务/重试：只读，GET 不触发模型请求、不写任务库（已有用例：GET 前后 db sha256 不变）。
- 失败语义：查询非法 → 400（复用既有错误体）；存储不可读 → 503；不返回半份文档。
- 最小验证：`npx tsx --test test/statistics-contract.test.ts`（6/6）+ 新增一条 `workbench-http` 级用例：`GET /workbench/v1/statistics/export?limit=5` → 200 且 `coverage.requests.status==="unknown"`、`POST` → 405。

---

## I-5 公共契约与导航（文档/打包层）

- `docs/INTERFACE_CONTRACT.md` 增四行接口与字段说明：
  - `gateway/src/statistics-contract.ts` → `workbuddy-executor/statistics-export-1`（只读导出，版本/新鲜度/覆盖）。
  - `gateway/src/statistics-call-events.ts` → `workbuddy-executor/call-events-1`（调用事实）。
  - `gateway/src/statistics-harness-calls.ts` → `workbuddy-executor/harness-call-events-1`（Harness 工具调用事实）。
  - `gateway/src/resource-source-capability.ts` → `workbuddy-executor/source-capability-1`（来源能力表）。
- `docs/RESOURCE_DOCUMENT_CONTRACT.md`（本线新增）写的是 quota-2/quota-1 与消费端规则，请在 `STATUS_INDEX` 记一行状态分层，并在 `INTERFACE_CONTRACT.md` 的资源文档处指向它。
- 配置面：`WORKBUDDY_RESOURCE_CONNECTIONS_FILE`（已在 L02 记录）。
- 导航：工作台若要展示 `readings`/`ambiguities`/导出按钮，需要 `gateway/workbench/app.mjs`（I 独占）。本线已在 `resources-model.mjs` 备好 `readings[]`、`readingsSource`、`readingsMissing`、`readingsMissingText`，界面只需渲染这四个字段，不要在前端重算读数。
- 打包：`scripts/package.mjs` 的私有路径守卫只允许 `example`/`YOUR_NAME`/`Public`；本线新测试夹具已统一用 `C:\Users\example\…`，请勿回改。

---

## 附：本线已改的 A 线文件（需要 I 知晓并入集成树）

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `gateway/src/dsh-coordinator.ts` | +20 行：一个 import、一个 `openToolCalls` 私有字段、`sync()` 末尾一处 `recordHarnessToolCalls(...)` 调用 | `tool_call_finished` 的唯一真实生产点；只在 `!observeOnly && page.events.length > 0` 且事件校验通过、终止态已定之后执行 |
| `gateway/src/quota-observation.ts` | schema 升 `quota-2`，新增 `QUOTA_LEGACY_SCHEMAS`、`QuotaSourceReading`、每行 `readings` | 合并行不再独占「唯一读数」，但保持单一来源语义 |
| `gateway/workbench/resources-model.mjs` | 接受 quota-2（`readings` 必填）与 quota-1（缺失标注不伪造） | 消费端兼容，见 `docs/RESOURCE_DOCUMENT_CONTRACT.md` |
| `gateway/workbench/resources-source.mjs` | 演示文档升 quota-2 并补 `readings` | 与消费端校验一致 |
