# L05 规则决策表

适用范围：桌面工作台「新建任务」里的“评估选择”（`workbuddy-executor/recommendation-1`）与确认前的重验。实现：`gateway/src/recommendation.ts`（纯函数 `recommendTask(parameters, catalog, now)`）、`gateway/workbench/dispatch.mjs`（面板与漂移门）。本表是验收口径，不是运行时策略表；任何一行都不改变原有准入、模型政策或派工授权。

判定顺序（自上而下命中即止）：硬费用上限 → 用户显式选择 → 小改 direct → 候选为空 → 候选排序。排除原因在候选筛选阶段逐个记录，不覆盖决策。

| # | 场景 | 输入与判定依据 | 结果 | 解释码 / 字段 | 明确不做 |
|---|---|---|---|---|---|
| 1 | 小改直接处理 | 无显式选择；目标 ≥10 字；范围 ≤3 项且为精确路径（无 `*`）、检查 ≤3、`maxAttempts=1` | `decision=direct`，`recommended=null` | `direct_small_change` + `direct_read_only`/`direct_exact_files`/`direct_few_checks`/`direct_single_attempt`；`attempt=null`、`nativeAttempt="none"` | 不建原生轮次、不建 attempt、不派工；用户点名执行器时本行不生效（见 #2） |
| 2 | 用户明确委派 | `constraints.selection` 命中某个可选候选 | `decision=delegate` | `user_selection_wins`；`userSelection.status="available"` | 不重新排序把用户选择换掉；不因“更便宜”改选 |
| 3 | 不可用来源 | `source.state != "online"`，或 `source.dispatchable=false` | 该候选进 `excluded`；全被排除则 `decision=wait` | `source_not_online`（文案含“在线不等于可执行”）/`source_not_dispatchable`；全排除时 `no_candidate` | 不把“在线”当“可执行”，不用声明关联补位 |
| 4 | 多候选 | 通过筛选的候选 ≥2 | `decision=delegate`，`candidates` 按 `rank.tier` 再按执行选择标识排序 | `delegate_ranked_candidates`；`rank.rule="tier_then_lexicographic"`；notes 声明非质量排名 | 不算质量分、不给 `score`、不扫项目补样本 |
| 5 | 付费与未知费用 | `pricingVerified` 与 `credits` 决定档位 | 付费已观测进候选（tier 3/4）；未核实进候选（tier 5） | `cost_observed` / `cost_unknown`；`cost.label`（“费用未知，可能计费”） | 不把未知当免费或零；不因付费自行排除（除非 #6） |
| 6 | 主动 free-only | `constraints.freeOnly=true`（或政策 `requireFree`） | 仅保留精确零费率；零个则 `wait` | `free_only_not_verified` / `policy_requires_free`；`wait` 时 `recommended=null` | 不把“未核实”当零费率；不改写任务原政策 |
| 7 | 旧 allowlist | 政策 `selectionMode != "user_choice"` 或 `allowed` 非空 | 未精确命中的候选全部排除；无剩余则 `wait` | `policy_blocked`（沿用原政策文案） | 不因为“推荐”放宽历史 allowlist；空 allowlist 不等于任意可选 |
| 8 | 硬费用上限不支持 | `constraints.hardCostCap.credits` 存在 | `decision=wait` | `hard_cost_cap_unsupported`；`constraints.hardCostCap.status="unsupported"`；`limitations+=hard_cost_cap_not_guaranteed` | 不承诺上限、不把未知价格当硬限、不静默降级成“尽量省” |
| 9 | 资源过期 | `/workbench/v1/resources/plan-reference` 的 `quota.freshness="stale"` | 候选保留但降档 | `resource_reference_stale`；`resources.status="stale"`，余量照抄快照值 | 不把过期余量当当前余量；不因过期换来源 |
| 10 | 无统计 | 无统计文档、schema 不符、无 `tasksIncluded` | `history.status="unavailable"` | `statistics_not_read` / `statistics_unreadable` / `statistics_without_sample`；`missing+=no_statistics_sample` | 不推断质量、不补 0、不宣称节省或更强（`claims` 恒 `null`） |
| 11 | 部分 coverage | 截断、未完成、无事件计数 >0 | `history.status="partial"`，保留样本量与时间窗 | `statistics_partial_coverage`；`missing` 标 `limits` | 不把部分覆盖读成“全部任务”或“零失败” |
| 12 | 用户覆盖 | 面板“采用此候选” | 回填来源/模型/档位，下一次评估带 `constraints.selection` | 提示“推荐本身不授权”；`authorization.state="none"` | 不自动预览、不自动确认、不改政策 |
| 13 | 快照变化 | 传入 `previous` 且 `digest` 不同 | `drift.codes` 列出变化，`blockedForDispatch=true` | `catalog_changed` / `policy_changed` / `selection_changed` / `snapshot_expired`（都未命中时 `snapshot_changed`） | 不按旧解释继续，不自动换新来源 |
| 14 | 确认后漂移 | 确认时以 `previous` 重评 | `drift.blockedForDispatch` → 提示并中止本次确认 | 面板提示含 `drift.codes`；确认按钮保持可用以便重新核对 | 不派工、不覆盖用户已填字段；命令缺失/网络失败**不阻断**原手工派工路径 |

## 断言

- **无模型副作用**：模块不 `fetch`、不读时钟（`now` 显式传入）、不建 attempt（`attempt=null`）、不写库；`gateway/test/recommendation.test.ts` 对源码做静态断言（无 `node:fs`/`node:net`/`node:http`/`node:child_process`/`fetch(`/`Date.now(`）。
- **无自动确认**：所有决策都返回 `authorization.state="none"` 与 `requires=["preview","confirmation"]`；面板只读解释，确认仍走原有本机窗口。
- **来源与路由**：`routingVerified` 恒 `false`；`resources.routingClaimRejected` 时清空读数，声明关联不当真实路由。
- **可审计**：`digest` 由输入与快照内容决定（不含 `generatedAt`），同输入同快照重算得到同一 digest；`explanationVersion` 随口径变化递增。
- **降级**：宿主未实现 `recommend` 动作时面板隐藏，手工选择、预览与派工不受影响。

## 对应测试

| 行 | 测试（`gateway/test/recommendation.test.ts`，除注明外） |
|---|---|
| 1 | `a small read-only or exact-file change is direct and creates no attempt` |
| 2 | `an explicit user choice wins over the ranking and over a direct suggestion` |
| 3 | `an unavailable user choice waits instead of substituting the cheapest candidate`（断言 `source_not_online`/`source_not_dispatchable`）；视图 `the explanation shows reasons, exclusions, the missing sample and no authorization` |
| 4 | `several candidates are listed with a deterministic order and no quality score` |
| 5 | `a paid rate is an observation and an unknown rate is neither free nor sufficient` |
| 6 | `a free-only policy keeps only verified zero rates and never relaxes to paid` |
| 7 | `a legacy allowlist keeps its exclusions visible and an empty allowlist waits` |
| 8 | `a required hard spending cap is refused rather than promised` |
| 9 | `a stale resource reference is named as stale and never read as a current balance`、`a resource reference is only shown for the model it names`、`a declared routing claim is reported and not trusted` |
| 10 | `no statistics leaves the sample unknown instead of zero or complete` |
| 11 | `partial statistics keep the window and sample size visible` |
| 12 | `gateway/workbench/test/recommendation-view.test.mjs`：`applying a candidate switches the fields and keeps the choice explicit` |
| 13 | `a changed snapshot is reported as drift before dispatch`；视图 `a changed snapshot blocks the confirmation instead of dispatching` |
| 14 | 视图 `an unchanged snapshot lets the confirmed dispatch proceed`、`a host without the command hides the panel and keeps the composer usable` |
| 补充 | `an expired snapshot, a disabled dispatch and an unreadable request are refused with reasons`（过期/未启用/非法请求）、`one malformed catalog row is counted, not silently dropped and not fatal`（坏行）、`the evaluator reads no filesystem, network or clock beyond its arguments`（无副作用） |
