# 31 项任务台账（本轮口径）

证据等级定义见 `README.md`：`source`（代码与测试）/ `synthetic`（合成夹具）/ `window`（真实窗口）/ `live`（真实执行器与真实模型）/ `installed`（真实安装）/ `machine`（本机可复现命令输出）/ `CI` / `release`。

本轮**没有**任何一项达到 `window`、`live`、`installed`、`CI`、`release`。下表「等级」列写的是本轮实际取得的最高等级；「缺口」列写清为什么没上去。

| 任务 | 本轮实现 | 等级 | 证据指针 | 缺口 |
| --- | --- | --- | --- | --- |
| D0-01 版本与包/技能核对 | 候选包重建（734 文件）、技能六文件一致性沿用上轮结论 | source + machine | `I\candidate-cp2-extract\…\` 解压根、`docs/forward/I_CHECKPOINT_2.md` §5 | 安装后运行身份 codeHash 对齐需要真装 |
| D0-02 53 项矩阵 | 新建 `SCENARIO_INDEX.md` 逐项挂本轮证据 | source | `docs/forward/SCENARIO_INDEX.md` | 大量项只能挂 source/synthetic |
| D0-03 边界与旧任务裁决 | `README.md` 七档等级与禁止说法、旧任务三层分类沿用 A 线结论 | source | `docs/forward/README.md`、`A_LINE_RECEIPT.md` | `rc2-live-20261106b` 仍需人裁决 |
| D1-01 安装器与回退 | A04 有界锁文件安装 + 首跑内联；隔离安装根自举/重复/升级/回退全 exit 0 | machine | `A\bootstrap-*.json`、`A\drill\`、`A\desktop-build.log` | 未在本机或异机真实安装当前候选 |
| D1-02 双端真实代码任务 | 未做 | — | — | 需真实派工确认（外部条件 A1/A4/A5） |
| D1-03 返工取消恢复 | A03 补 `UnreadableJournalError` 与输入答案只消费一次 | source | `A_LINE_RECEIPT.md`、`test/run-journal.test.ts` | 真实取消/期限路径需 window/live |
| D1-04 不确定任务围栏 | 原裁决保持，未重开 | source | 原 `F-CONTRACT-1` 记录 | 真实异常卡不补做（已决定） |
| D2-01 项目登记与会话诊断 | A01 五层诊断 + `selection.state` 三态；降级启动真实可跑 | machine + source | `shared\degraded-*.json`、`test/readiness.test.ts` 27/27 | 桌面壳 WebView 仍失败，页面层不可达 |
| D2-02 模型目录与价格 | 目录统一新鲜度与可用性；缺报价不编造 | source + synthetic | `docs/forward/B_LINE_RECEIPT.md` | 实时报价上游超时（外部条件 A3） |
| D2-03 方案预览/确认/消费 | 完整预览/修改/确认/过期/并发消费路径复核；重复回答映射 `INPUT_ALREADY_ANSWERED` | source + synthetic | `src/server.ts`、`test/task-application-service.test.ts` | 无真实确认窗口 |
| D2-04 direct/推荐/派工 | 拒绝 vs 不确定派工定型；模板实例化真实接线（时限只取存储政策） | source | `test/desktop-command-template.test.ts` 5/5、`test/desktop-dispatch.test.ts` | 未真实派工 |
| D3-01 固定来源适配 | 来源能力声明与载荷校验、陈旧标注 | source | `test/resource-source-capability.test.ts` | 真实服务联调未开（外部条件 A6） |
| D3-02 路由证据三层次 | 明确可取得的路由证据与不可证明边界 | source | `test/resource-routing.test.ts`、`resource-routing-ambiguity` | 缺真实请求标识，归因仍部分 unknown |
| D3-03 方案资源视图 | 冲突/共享池/区域/缺值处理 | source | `test/plan-resource-reference.test.ts` | 缺真实数据源实测 |
| D3-04 故障隔离 | 错误隔离/乱序/缓存/生产者边界 | source | `test/resource-fault-isolation.test.ts` | 跨能力组合仍需真实链路 |
| D4-01 规则推荐 | 推荐/排除理由与用户覆盖 | source | `test/recommendation.test.ts` | 未在真实窗口确认 |
| D4-02 资源引用结构 | 消费新鲜观测；过期/未知不变充足 | source | `test/plan-resource-reference-conflicts.test.ts` | 真实观测仍缺 |
| D4-03 技能/桌面推荐入口 | 确认闭环、失效重验、不回复不派工 | source | `workbench/dispatch.mjs`、`test/...dispatch` | 无真实桌面会话 |
| D5-01 政策 CRUD 与审计 | 六层披露、版本/期限/撤回 | source | `test/automation-policy.test.ts` | 真实授权来源仍为常量声明 |
| D5-02 只读 probe 与竞态 | 正式只读 probe 接入 MCP 组合根；`pending→executing` 事务线性化 | source | `src/server.ts`、`src/automation.ts:834-861` | 真实自动模式 arming 未开（外部条件 A7） |
| D5-03 自动页面只读 | 页面真实状态 + 审计 + 只读路由 | source | `test/automation-http.test.ts`、`test/automation-probe.test.ts` | 页面未在真实窗口渲染 |
| D6-01 归因账本 | 真实上游请求写入账本，覆盖率分子分母 | source | `test/usage-attribution-adapter.test.ts` | 不能关联的请求保留 unknown |
| D6-02 统计生产链 | **I 线补 `local_check_finished` 真实生产**；C 的 harness 事件生产者仍无调用者 | source | `test/check-call-events.test.ts` 5/5、`docs/CALL_EVENT_CONTRACT.md` | `tool_call_finished` 未接线 → calls 只覆盖一半 |
| D6-03 模板实例化 | 版本化模板 + 真实实例化接线 + 预算裁剪 | source | `test/project-template.test.ts`、`test/desktop-command-template.test.ts` | 未在真实窗口实例化 |
| D6-04 通知/脱敏导出 | 导出统计整事件流、bytes 与预览一致；通知失败原因透传 | source | `test/delivery-export.test.ts`、`test/notification-center.test.ts` | 窗口未就绪不写通过 |
| D6-05 统计页面 | 样本/时间窗/覆盖/检查器错误显示 | source | `test/statistics-page.test.ts`、`test/statistics.test.ts` | 无实证省钱结论仍禁止 |
| D7-01 打包/安装/回退 | 最终候选 745 条目、`verify-release` 744/744 hashesMatch、安装前置自检 `ok:true`；隔离安装根 drill/upgrade-drill 全 exit 0 | machine | `I\candidate-final-verify.txt`、`I\candidate-final-check.json`、`I\candidate-final-manifest.json`、`A\drill\` | 未真实安装、未升级旧安装 |
| D7-02 异机 | 未做 | — | — | 需第二台 Windows 与独立操作者（A8） |
| D7-03 许可与授权说明 | 未做 | — | — | 需权利人决定（A9） |
| D7-04 CI 与远端 | 未做 | — | — | 未获推送/CI 授权 |
| D7-05 回执与索引 | 本轮交付总回执、RESUME、53 项索引 | source | 本文件、`SCENARIO_INDEX.md`、`TOTAL_RECEIPT.md` | 发行仍待授权 |

## 一句话结论

源码层：31 项中的 28 项有本轮代码/测试推进；`D1-02`、`D7-02`、`D7-04` 无任何本轮推进（全部卡在外部条件）。
真实可用层：0 项。本机唯一真实运行证据是 `workbench-entry` 的降级启动（进程存活 + 三个只读端点），不含桌面页渲染、不含真实派工。
