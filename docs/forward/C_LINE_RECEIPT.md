# C 线回执（资源、事件生产、归因、统计）

分支 `feat/forward-observability`，工作树 `E:\javaproject\workbuddy-forward-20261107\C-data`，起点 `134cdc7`。
本回执只记本线真实做了什么、在哪验的、验到哪一档，以及明确不成立的结论。

## 0. 证据档位（六档，逐项对齐）

| 档位 | 本线状态 |
| --- | --- |
| 实现（代码在分支上） | 达到：`1e9108b`、`ee96277`、`b6edd38`、`25787e8`、`e49c5ea`、`9e00fee`、`7af4515` |
| 合成（夹具真跑，含真实子进程/真实 sqlite/真实 HTTP 回环） | 达到：见第 3 节每个命令的 tests/pass/fail |
| 窗口（本机固定窗口跑一遍） | 部分达到：资源/统计端点回环 GET 与 `dsh-coordinator.sync` 夹具运行；没有真实派工窗口 |
| 真实（真实来源/真实模型请求） | **未达到**：没有真实来源授权、没有真实模型调用、没有真实派工 |
| 安装（装到本机可用） | 未做（本线不授权安装） |
| 发行（打包/候选包） | 不由本线负责（I 线候选包 734 文件 / 2,459,060 B / SHA-256 `61dc0456…a8017`） |

结论基调：本线把「网关侧真正可观察的东西」做成了可信事件与可信统计，并把「上游根本不发布的东西」明确标成不可观察，而不是等接 Key 就有了。

## 1. 固定来源能力表（C01）

配置面：`WORKBUDDY_RESOURCE_CONNECTIONS_FILE`（连接声明）、`baseUrl` 必须是显式回环 HTTP（`http://127.0.0.1`/`[::1]`，无 path/query/userinfo），凭据只接受环境变量名。
代码：`gateway/src/resource-source-capability.ts`（`SOURCE_CAPABILITY_SCHEMA="workbuddy-executor/source-capability-1"`），三个端点全部 `GET`、`pagination.mode="none"`、`requestIdField: null`。

| 端点 | 路径 | 认证位置 | 区域 | 单位 | 行身份 | 来源时间 | 读取时间 | 余额/用量/模型字段 | 行上限 | 错误映射 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `usage_remaining` | `/usage/remaining` | `Authorization: Bearer`（必填）、`X-Panel-Token`（可选） | 有，`cn`/`intl` | `tokens` | `uid`+`model` | `generated_at`（秒） | 采集器时钟，独立字段 | 余额类 `remaining`/`used`/`budget`/`reset_at`/`cooling`；模型 `model` | 2000 | 401/403→`source_unauthorized`，404/501→`source_unsupported`，其余→`source_unavailable` |
| `balance_summary` | `/v1/balance-summary` | 同上 | 有，`cn`/`intl` | `credit` | `realm` | `updated_at`（秒） | 同上 | `balance`/`accounts_enabled`/`accounts_with_data`/`updated_at` | 1 | 同上 |
| `models` | `/v1/models` | 仅 `Authorization: Bearer` | 无 | `none` | `id` | 无 | 同上 | `id` | 500 | 同上 |

配套校验：

- `checkSourceConfiguration()`：`source_unconfigured` / `invalid_source_url` / `source_credential_missing`（带 `field`）。
- `checkPayloadConformance()`：`complete|partial|invalid` + `rowsRead`/`rowsRejected`/`missingFields`/`rejectedReasons`；配额行必须 `uid`+`model`+`realm∈{cn,intl}`+布尔 `cooling`；缺 `generated_at` → `partial`；容器缺失或全部行被拒 → `invalid` (`rows_container_missing`)；超上限 → `invalid` (`rows_exceed_cap:2000`)；余额端点报 `unit` 不是 `credit` → `invalid` (`unit_mismatch:balance_summary_reports_credit`)。
- `sourceFreshness()`：`fresh|stale|unavailable` + `ageSeconds`/`sourceSkewSeconds`/`reason`。可靠旧数据返回 `stale` 而不是清空，也不变成 `fresh`。
- 单位严格分离：配额只用 `tokens`，余额只用 `credit`，模型列表 `unit: "none"`；没有倍率/货币换算字段，也没有把积分当 token、把 token 当金额的路径。

字段改动与陈旧行为（C06 也在验）：字段改名后旧值保留并标陈旧或连接转 `source_invalid`，**绝不产生 0**；未认证不产生 0；部分行被拒只降低覆盖计数。

## 2. 路由证据三层（C02）

`gateway/src/resource-routing.ts` 的 `buildRoutingEvidence()` 固定输出三层，全部 `verified:false`，顶层 `routingVerified:false`：

- `configuration`：`connection_pool_model`，来源 `WORKBUDDY_RESOURCE_CONNECTIONS_FILE`，观测等级 `gateway_observation_only`。
- `executionSelection`：`execution_selection_declaration`，来源 `WORKBUDDY_RESOURCE_LINKS_FILE`，等级 `declaration_only`。
- `requestRouting`：`actual_request_routing`，来源 `upstream_usage_payload`，等级 `unavailable`，原因 `upstream_payload_lacks_request_identity`。

新增 `ambiguities`（`routing_ambiguous` limitation 同步追加），冲突码：`multiple_connections`、`level_disagreement`、`availability_disagreement`、`source_time_disagreement`、`realm_conflict`、`unit_conflict`，每项带 `{code, scopeId, unit, modelId, unresolved:true}`。

关键取舍：**多来源合并时不在合并行上取数组第一项**。合并行仍是一个具名来源的读数（L02 冻结语义），每个来源自己的读数原样保留在 `observations[].readings[]`（quota-2），不一致由 `ambiguities` 表达。跨区域、同池多模型、单位冲突都按 scope 级冲突覆盖该 scope 的所有行。

## 3. C01–C06 逐项：缺口 → 实现 → 复验

### C01 固定来源适配与采集闭环
- 缺口：来源能提供什么只散落在采集器代码里；坏字段/缺来源时间/单位混用没有统一判定；陈旧的旧数据与失败没有分开表达。
- 实现：`gateway/src/resource-source-capability.ts`（能力表、配置校验、载荷一致性、新鲜度）；`quota-observation.ts` 文档版本升 `quota-2` 并保留 `quota-1` 只读兼容；`credit-balance.ts` 未配置≠损坏（返回 `balances: []`，损坏才向配额侧抛 `resource_corrupt`）。
- 复验：`npx tsx --test test/resource-source-capability.test.ts` → **tests 9 / pass 9 / fail 0**；`test/quota-observation.test.ts` + `test/desktop-readonly-resources.test.ts` + `test/resource-routing.test.ts` → **tests 42 / pass 42 / fail 0**。

### C02 路由证据与方案资源关联
- 缺口：三层只写在文档里，代码只有一层；多来源合并时没有歧义表达，容易退化成「取第一项」。
- 实现：`resource-routing.ts` 增加 `RoutingAmbiguity`/`RoutingMapping.conflict`/`ambiguities`；`quota-observation.ts` 增加 `QuotaSourceReading` 与每行 `readings`（按 connectionId 排序）；`plan-resource-reference.ts` 沿用同一读取，不新增推断。
- 复验：`npx tsx --test test/resource-routing-ambiguity.test.ts` → **6/6**；`test/resource-routing.test.ts test/resource-routing-consistency.test.ts` → **24/24**（需先 `npx tsc -p tsconfig.json` 生成 `gateway/dist`，否则只读门面用例读到旧 dist）。

### C03 请求归因账本真实接线
- 缺口：账本有解析与归因，但没有把真实可见字段写进账本的适配器；覆盖率没有分子分母；总请求数未知时容易被写成 100%。
- 实现（`gateway/src/usage-attribution.ts`）：`REQUEST_OBSERVATION_SCHEMA="workbuddy-executor/request-observation-1"`、`buildRequestObservationRows()`（`tokens` 与 `credits` 各一行，`valueKind:"unavailable"`、`value:null`、`method:"harness_does_not_report_usage"`）、`recordRequestObservation()`（每行先过 `parseUpstreamUsageEnvelope` 严格校验，再 `ledger.record`）、`summarizeUnallocated()`（`no_task`/`no_attempt`/`task_mismatch`，同一请求多单位只算一个请求）、`summarizeRequestCoverage()`（分母未知→`unknown`，分母小于分子→`unknown` + `denominator_smaller_than_numerator`，否则 `partial|complete` 并给比率）。
- 去重与不双计：账本 `(requestId, unit)` 唯一；重放→`duplicate`，不同角色同 `requestId` 也是 `duplicate`（首观测保行），测试断言 `ledger.count()===2`（两单位各一行）。
- 复验：`npx tsx --test test/usage-attribution-adapter.test.ts` → **6/6**。
- 未接线：`recordRequestObservation` 目前**没有 src 调用者**，见第 6 节集成请求 I-3。

### C04 tool/check 可信事件生产链（最高优先）
- 缺口：`calls` 恒为空。全仓只有事件类型定义，没有 `tool_call_finished` / `local_check_finished` 的生产者。
- 实现：
  - 本线新增 `gateway/src/statistics-call-events.ts`（`CALL_EVENT_SCHEMA="workbuddy-executor/call-events-1"`）：稳定 `eventId` 由 `task_events` 主键给出；`sourceRef="call:v1:<channel>:<operationId>"` 幂等；`CallIdentity` 带 `taskId/attemptId/operationId/role/checkId`；`classifyCommandOutcome()` 把 `processStarted`/`cleanupConfirmed`/`exitCode`/`cancelled` 映射成 `succeeded|failed|outcome_unknown` + `failureKind`；`redactCallText()` 抹 `sk-*`、`Bearer`、`token|api_key|password|secret|cookie|authorization`、`C:\Users\<name>`、`/home/<name>`；字节只来自 `fs.statSync` 实测，缺失为 `null`（`wire` 恒 `null`）。
  - 本线新增 `gateway/src/statistics-harness-calls.ts`：把 DSH Harness 事件流里的 `tool/call` 与 `tool/result` 按 `callId` 配对成一条事实，`sourceRef="tool-call:<executorId>:<attemptId>:<harnessEventSeq>"`；跨页 `carry`/`open` 保证「一页只有 call、下一页才有 result」不丢调用；只有 `final` 才把未配对调用写成 `outcome_unknown`。
  - 真实接线：`gateway/src/dsh-coordinator.ts` 的 `sync()` 末尾调用 `recordHarnessToolCalls(this.store, …)`（`observeOnly` 路径不写）。
- 复验：`test/statistics-call-events.test.ts` **11/11**、`test/statistics-harness-calls.test.ts` **9/9**、`test/dsh-harness-call-events.test.ts` **4/4**（真实 `sync` 路径：写一条、二次不增、未终止不写、`isError` → `failed`、`observeOnly` 不写）；I 侧 `test/check-call-events.test.ts` 5/5 + `test/task-reviews.test.ts` 通过。
- 可复算链路（合成档）：产品检查入口（`workbuddy_run_review_command` → `TaskReviews.runCommand` → `runBounded`）→ `local_check_finished` 进 `task_events` → `readTaskStatistics().metrics.calls` → `readStatisticsOverview().totals.calls` → `GET /workbench/v1/statistics`。本线另提供同形替身入口 `runSurrogateCheckCommand()`（`producer:"surrogate_entry"`、`surrogate:true`、`realEntry:"workbuddy_run_review_command"`、limitation `producer_is_surrogate`），在 I 未接线前用于链路复算，并**明确标注是替身**。

### C05 可复算统计与消费者契约
- 缺口：统计只有页面视图，没有给 B/D 的只读契约；覆盖率、新鲜度、未知原因没有机器可读表达；窗口语义只有代码里隐含。
- 实现：`gateway/src/statistics-contract.ts`（`STATISTICS_EXPORT_SCHEMA="workbuddy-executor/statistics-export-1"`、`STATISTICS_EXPORT_CONTRACT="statistics-export-contract-1"`、`STATISTICS_WINDOW_SEMANTICS="task_created_at_utc_start_inclusive_end_exclusive"`）；`coverageOf()`/`usageCoverage()`（requests 分母恒 `null` + `upstream_does_not_publish_request_count`；tokens `token_count_not_published`；amounts `price_not_published`）；`freshnessOf()`（默认 900 s，`fresh|stale|unknown`）；`buildStatisticsExport()` 输出 schema/contractVersion/readOnly/snapshotOnly/window/windowSemantics/freshness/coverage/totals/limitations/claims（`savings:null`、`superiority:null`）/consumerRules；`describeStatisticsExportContract()` 给 B/D。
- 既有指标语义保持冻结（未改 `task-metrics.ts`）：wall time、排队/输入等待/报告到停止/停止到验收、返工轮次、恢复事件、人工 episode、检查器失败（`checker_error`）分开计数，未知不填 0。
- 复验：`npx tsx --test test/statistics-contract.test.ts` → **6/6**；`test/statistics.test.ts test/statistics-page.test.ts` 在回归批中通过（见下）。

### C06 联合故障
- 缺口：只有单个故障点的手工说法，没有「来源挂起 + 缓存损坏 + 字段变化」与任务侧并发的用例。
- 实现：`gateway/test/resource-fault-isolation.test.ts`（5 用例）+ 采集器的 `flight` 去重、指数退避（≤300 s）、`generation` 乐观锁、`publish` 拒绝更旧 `sourceObservedAt`。
- 复验：`npx tsx --test-force-exit --test test/resource-fault-isolation.test.ts` → **5/5**。断言含：来源超时后连接 `unavailable` + `errorCode` 匹配 `/timeout/`、读数 `[]`、`actualTaskTokens=null`，任务查询/事件流/`native_stop_confirmed`/统计 200 全不受影响；缓存损坏 → 配额侧 `resource_corrupt`、余额侧 `balances: []`；字段改名不产生 0；统计 GET 前后任务库 sha256 不变（页面 GET 不触发模型请求、不写任务库）；健康源与悬挂源并存时健康源仍 `observed`。

## 4. 生产者链路与可观察边界（C04 细目）

真正可观察（有生产者）：

1. **服务端检查命令生命周期**：`TaskReviews.runCommand()` → `runBounded()` 返回 `processStarted/startedAt/endedAt/exitCode/reason/cleanupConfirmed/stdout/stderr` → `local_check_finished`（`channel:"local_check"`，`sourceRef="review-call:command:<commandRecordId>"`，带实测字节与 `durationSeconds`）。生产者在 `gateway/src/task-reviews.ts` 的 `publishCallFact`（I 属主，commit `caa7a5f`）。
2. **独立检查批次**：`TaskReviews.checks()` 产出的每个检查一条（不带字节，`sourceRef="review-call:batch:<batchId>:<checkId>"`），`not_applicable` 不产出，`checker_error`/`unknown` → `outcome_unknown`。
3. **DSH Harness 工具调用**：事件流里的 `tool/call` + `tool/result` 配对 → `tool_call_finished`（`channel:"native"`，`sourceRef="tool-call:dsh:<attemptId>:<harnessEventSeq>"`），生产点在 `gateway/src/dsh-coordinator.ts` 的 `sync()` 末尾（本线 `7af4515`）。Harness 不发布字节，因此 `bytes` 键**不存在**，`limitations` 写 `harness_bytes_unmeasured`。

不可观察（明确不生产，不用布尔推断冒充）：

- **WorkBuddy 原生桌面会话内的工具调用**：只在渲染进程的 `session.eventHistory` 里可见（`native-desktop-trigger.ts` 用 `sessionUpdate∈{tool_call,tool_call_update}` 判忙闲与权限），不跨越进 Node 进程；网关侧只有 `hasActiveToolCalls` 布尔。把忙闲轮询当调用计数就是伪造，因此 `recordNativeToolObservation()` 在未桥接时直接抛 `native_unbridged`，`src` 内没有调用者。
- **原生模型内部工具**（模型自己在会话里调用的工具）同理不可见。
- **token/费用**：`dsh-client`/`deepseek-client` 的 transport 不返回任何 usage 字段（全仓 `prompt_tokens|completion_tokens|total_tokens|input_tokens|output_tokens` 零命中），因此归因账本只写 `valueKind:"unavailable"`、`value:null`。

替身与未接线（诚实清单）：

| 入口 | 状态 |
| --- | --- |
| `runSurrogateCheckCommand()`（`channel:"local_check"`，`producer:"surrogate_entry"`） | **替身**，只在测试里用，`surrogate:true` + `realEntry` + limitation `producer_is_surrogate` 三处标注 |
| `recordGatewayToolCall()`（`channel:"mcp"`） | 库函数存在，**src 无调用者**（见 I-2） |
| `recordNativeToolObservation()` | 桥接前不可用，**不接线**，抛 `native_unbridged` |
| `observeAttemptHarnessCalls()` | 便捷读取封装，**src 无调用者**（`sync()` 直接用 `recordHarnessToolCalls`） |
| `recordRequestObservation()` | 库函数存在，**src 无调用者**（见 I-3） |
| `buildStatisticsExport()` | 契约实现完成，**无 HTTP 端点调用**（见 I-4） |

## 5. 上游根本不提供的数据（能力不支持，不是「等接 Key」）

来源能力表 `notProvided` 的并集（`unprovidedFacts()`）：`per_request_identity`、`per_task_usage`、`prompt_and_completion_token_split`、`request_latency`、`price_or_currency_amount`、`account_level_total`、`model_price`、`per_account_breakdown`、`credit_to_currency_rate`、`context_window`、`reasoning_effort_support`、`availability_window`。

推论（写死进输出，避免下游误解）：

- 请求级路由永远 `routing_unverified`：没有任何端点发布请求标识。
- token 与金额覆盖率永远 `unknown`（分母不存在），不是 0%、不是 100%。
- 任务级 token/积分恒 `null`；区域积分只能是「缓存余额 + 共享池」的 `connection_only` 归因。
- 原生会话内部的工具调用不计入 `calls`。

## 6. 需要 I 落地的钩子

见 `docs/forward/INTEGRATION_REQUEST_C.md`（I-1…I-5）。

## 7. 本轮实际命令与计数

工作目录 `E:\javaproject\workbuddy-forward-20261107\C-data\gateway`；需要 `WORKBUDDY_CLI_ELECTRON=C:\example\WorkBuddy.exe`、`WORKBUDDY_CONFIG_DIR=%TEMP%\wb-cfg-fixture` 两处环境（本机存在多份安装，`src/config.ts:55` 会因歧义拒绝）。

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npx tsx --test test/statistics-call-events.test.ts test/statistics-harness-calls.test.ts test/dsh-harness-call-events.test.ts test/usage-attribution-adapter.test.ts test/resource-source-capability.test.ts test/resource-routing-ambiguity.test.ts test/statistics-contract.test.ts` | tests 51 / pass 51 / fail 0 |
| `npx tsx --test-force-exit --test test/statistics.test.ts test/statistics-page.test.ts test/resource-routing.test.ts test/resource-routing-consistency.test.ts test/quota-observation.test.ts test/credit-balance.test.ts test/resource-fault-isolation.test.ts test/desktop-readonly-resources.test.ts test/resource-connections.test.ts test/resource-attribution.test.ts test/resource-snapshot-store.test.ts test/resource-trust-http.test.ts` | tests 140 / pass 140 / fail 0 |
| `npx tsx --test test/quota-observation.test.ts test/desktop-readonly-resources.test.ts test/resource-routing.test.ts` | tests 42 / pass 42 / fail 0 |
| `npx tsx --test-force-exit --test test/dsh-adapter.test.ts test/deepseek-coordinator.test.ts test/check-call-events.test.ts test/task-reviews.test.ts` | tests 90 / pass 90 / fail 0 |
| `node --test workbench/test/resources-model.test.mjs workbench/test/resources-source.test.mjs workbench/test/resources-view.test.mjs workbench/test/resources-trust.test.mjs` | tests 42 / pass 42 / fail 0 |

证据原文已抄到 `E:\javaproject\outputs\forward-delivery-20261107\C\`：`test-c-new-suites.txt`、`test-c-regression-suites.txt`、`test-c-quota-document.txt`、`test-c-dsh-integration.txt`、`test-c-workbench-resources.txt`、`tsc.txt`。

未跑的部分：全量 1301 套件由 I 负责（本线只跑专项，避免与集成树抢占）。

## 8. 明确不成立的结论

- 不成立：「calls 已经完整」。`local_check` 与 DSH Harness 两半有了；WorkBuddy 原生工具调用与 MCP 工具通道仍未接入，`channel:"mcp"` 为零。
- 不成立：「归因已真实接线」。适配器与账本逻辑完成，但请求发出点（`dsh-coordinator.dispatch` 的 `client.prompt()`）尚未调用 `recordRequestObservation`。
- 不成立：「真实来源已验证」。只有回环夹具；没有真实 Key、没有真实派工窗口。
- 不成立：「导出契约已对外可用」。`buildStatisticsExport()` 没有 HTTP 端点，B/D 暂时读不到。

## 9. 提交

```
1e9108b  feat(statistics): produce trusted call facts from bounded commands and the DSH harness stream
ee96277  feat(statistics): observe real upstream requests into the usage ledger without inventing amounts
b6edd38  feat(resources): state what each fixed source publishes, check payloads against it and label stale data
25787e8  feat(resources): keep every reading of a merged scope and surface routing ambiguity
e49c5ea  feat(statistics): read one attempt harness batch in a single idempotent call
9e00fee  feat(statistics): export a versioned, coverage-labelled contract and prove resource faults stay isolated
7af4515  feat(resources): version the quota document as quota-2 and produce call facts from the DSH sync path
f831924  chore: drop scratch files a test run left in the gateway directory
```
