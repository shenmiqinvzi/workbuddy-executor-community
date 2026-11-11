# WB16–WB25 资源、用量、统计与推荐：源码级验收

日期：2026-11-11。工作树 `E:/javaproject/workbuddy-forward-20261107/R-executor-plan-20261111`（分支 `feat/executor-plan-20261111`）。

本轮口径：**只标源码/夹具证据**。凡需要真实只读来源、真实上游用量或实窗的项，一律 `blocked_external`，不借用夹具结果冒充实机读数。

## 汇总

| 任务 | 状态 | 证据 |
| --- | --- | --- |
| WB16 只读资源源 | 源码完成 / 真实来源 `blocked_external` | `resource-source-capability.test.ts`、`resource-source-acceptance.test.ts`、`resource-trust-http.test.ts` |
| WB17 快照单位与新鲜度 | 源码完成 | `resource-snapshot-store.test.ts`、`plan-resource-reference.test.ts`、`resource-fault-isolation.test.ts` |
| WB18 路由证据分层 | 源码完成 | `resource-routing.test.ts`、`-ambiguity`、`-consistency`、`plan-resource-reference-conflicts.test.ts` |
| WB19 资源联调与故障隔离 | 夹具完成 / 真实联调 `blocked_external` | `resource-fault-isolation.test.ts`、`resource-attribution.test.ts` |
| WB20 请求关联与真实用量 | 适配器完成 / 真实上游 `blocked_external` | `usage-attribution-adapter.test.ts`、`statistics-contract.test.ts` |
| WB21 统计生产链 | 源码完成 | `statistics.test.ts`、`statistics-call-events.test.ts`、`statistics-harness-calls.test.ts` |
| WB22 确定性推荐规则 | 源码完成 | `recommendation.test.ts`（18 例） |
| WB23 资源/统计接入推荐 | 源码完成 | 同上 + `plan-resource-reference.test.ts` |
| WB24 推荐在两端可确认 | 源码完成 | `workbench/test/recommendation-view.test.mjs`（12 例）、`test/executor-modes-consistency.test.ts`（3 例） |
| WB25 项目模板实例化 | 源码完成 | `project-template.test.ts`、`desktop-command-template.test.ts` |

## 运行证据（本次实跑）

```
node --import tsx --test <13 个资源/统计/用量文件>   tests 152 / pass 152 / fail 0 / 3934ms
node --import tsx --test <12 个模板/通知/导出文件>   tests  92 / pass  92 / fail 0 / 4250ms
node --test workbench/test/recommendation-view.test.mjs                12/12
node --import tsx --test test/recommendation.test.ts                   18/18
node --import tsx --test test/executor-modes-consistency.test.ts        3/3
```
日志：`E:\javaproject\outputs\executor-plan-20261111\wb16-wb23.log`、`wb25-wb31.log`。

## 逐条要点

**WB16**：`capability` 表为每个来源声明自己的单位（quota/credit）、能发布什么、不能发布什么，且表本身不可被调用方改写；未配置或非回环来源在**发出请求之前**被拒；坏 schema 得到 `invalid`，缺源时间戳得到 `partial`，都不产出补 0 的观测。凭据只以“变量名”形式出现（`resource-snapshot-store` 拒绝任何凭据形状的键/值），页面只读脱敏快照。真实来源接入表与真实样本待用户提供只读连接。

**WB17**：快照带 `collectedAt/observedAt/expiresAt` 与内容摘要，改写或截断的文件按名字报错而不是被信任；`reported/estimated/unavailable` 与 `available/exhausted/unknown` 分开；同池多引用只列一次（`resource-routing.test.ts`「the same pool reported by two connections is listed once with both sources」），不跨单位求和；资源故障不影响任务 get/cancel/停止核验（`resource-fault-isolation`）。

**WB18**：证据分层固定为 `EvidenceLevel = "observed" | "expired" | "unavailable" | "unobserved"`（`src/resource-routing.ts:36`），映射带 `sourceObservedAt/expiresAt/availability/coverage/primaryConnectionId`，`routing-evidence-1` 保留 `routingVerified=false` 的保守默认；同一模型跨连接被两个来源以各自层级报告时差异保持可见，不被并成一个布尔值；过期或采集错误只降级、不升级。

**WB19**：故障注入只作用于专用测试来源；超时/过期/乱序/部分失败都保留最后一次有效读数并写明降级原因，模型请求计数不被页面刷新或轮询增加。真实的“专用任务运行 + 资源断连”联合样本属外部条件。

**WB20**：`usage-attribution-adapter` 以不透明关联（attempt/request/retry parent/role）落账，同请求同单位不可重复计数，另一角色不能改写；行不可用时金额是 `null` 而不是 0；重试挂父级并标注而非合并；无 attempt 绑定的请求明确“不计入任务合计”；覆盖率保留分母，未知分母不显示 100%。真实上游用量对账需上游提供请求/用量接口。

**WB21**：统计从原始 `tool_call_finished`/`local_check_finished` 重放，未知区间为 `null`；未观察的调用不记零；`statistics-contract` 要求导出带版本、只读、写明窗口语义，旧窗口只标 `stale` 不改日期，`100%` 只在实际计数时出现。

**WB22**：同一输入快照 + 政策产生确定结果；用户显式选择优先于排序与 direct 建议；关键能力未知不可推荐为可执行；排序变化以 drift 呈现，不静默替换；费用未知既不当免费也不当上限（`requiresHardCap` 被拒而不是被承诺）。

**WB23**：推荐绑定 catalog/snapshot 的 `catalogId`、`expiresAt`、policy 版本与统计窗口；资源引用只对它命名的模型显示；快照变化在派工前报 drift；无统计样本时 `history.status="unavailable"`、`sampleSize=null`，不出质量排行或省钱结论。

**WB24**：推荐只填回表单（`applySelection`），随后仍需预览 + 本机确认；宿主不支持该命令时面板隐藏、手动选择照常可用（`isUnsupportedRecommendation` 分支）；两端术语一致性由 `executor-modes-consistency.test.ts` 守住。

**WB25**：模板只存目标片段/范围/检查/政策建议与版本，不存 task/attempt/review/token；实例化生成新身份并重新校验目录与 CommandSpec；时限与轮次取“当前有效限制 ∩ 模板建议”，模板预算不抬高服务端政策；旧政策或模型消失时提示修订；已有任务不被模板更新改写。

## 未覆盖

- WB16/WB19 的真实只读来源读数、WB20 的真实上游用量对账：需用户提供连接或授权修改上游，当前标 `blocked_external`。
- 实窗与真机验收归 WB35/WB39。
