# 后端开发进度

更新日期：2026-10-31。本页区分源码能力、自动验证和运行部署。

## 本分支 T7B

T7A 已由 PR #19 合入 main `4037112`。T7B 增加独立桌面任务准备、明确来源/模型/推理选择、未知费率披露、原生确认和持久唯一回执。执行仍通过原有准入、共享容量和范围保护，公共 HTTP 不开放写入口，详见 [T7B 流程与边界](T7B_DESKTOP_DISPATCH.md)。

本轮使用标记的隔离项目、任务库和假执行器完成真实 WinForms/WebView2 窗口流程：取消不调用，明确确认后立即关窗，独立后台完成一次合成派工；重开丢弃浏览器存储后仍恢复原任务/操作，显式观察不重复准备或投递。实窗发现并修复中文 stdio 编码与 DPI 下确认按钮裁切。合成原生确认不代表真实模型验收；未升级原桥接、技能或既有政策，派工默认关闭，真实部署和补验另行确认。

10月31日后续：经本轮模型/范围明确授权，在独立现代库完成 WorkBuddy 单次真实补验，任务 accepted、closed、原生停止确认，五项独立检查通过。关窗重开保持原身份，没有重复派工，见[脱敏补验记录](T7B_LIVE_ACCEPTANCE_2026-10-31.md)。检查器路径错误保留并修正；受理回执提示已改为不随最终验收状态失真的说明。旧库和独立库的技能查看定位采用显式只读路由，原模型政策保持不变；源码合并和本机入口切换分别核验。

T4A/T4B 及前序依赖已通过 PR #10–#15 按序合入 main，最终 T4 合并提交为 `b37e972`，文件树与已验收的 `0bce733` 完全一致。真实领取提示的 validationRecords 修复、WorkBuddy 原队列恢复后交付、DSH 按时交付和共享容量/关闭证据均保留，详见 [集成交付记录](T4_COMPLETION_2026-10-27.md)及[脱敏验收摘要](T4B_LIVE_ACCEPTANCE_2026-10-27.md)。源码阶段、仓库合并、正式发布和安装部署分别登记。

T5 工作区文件保护源码及 WorkBuddy/DSH 本机真实补验已完成，两端均 accepted 并关闭，详见 [实现边界](T5_WORKSPACE_PROTECTION.md)和[脱敏验收摘要](T5_LIVE_ACCEPTANCE_2026-10-27.md)。两端真实样本分别绑定各自候选，政策路由修复的最终回归、远端 CI 与主干合并独立登记。仓库集成与验证归属见[T5 交付记录](T5_COMPLETION_2026-10-28.md)及 PR #16。T6 后端审查与最终验收已随 PR #17 合入 main `0e9d96b`；WorkBuddy 与 DSH 官方来源在该运行代码上完成新的本机补验，均 accepted 并关闭，见[T6 交付记录](T6_COMPLETION_2026-10-29.md)和[脱敏补验摘要](T6_LIVE_ACCEPTANCE_2026-10-28.md)。原代理失败及检查器错误保留；源码、自动验证、仓库集成和真实补验分别登记。正式发布部署及异机另验，T7 尚未交付。

## 本分支 T7A

真实只读工作台已实现：同源静态界面、独立版本 panel-1 视图、任务列表/详情、已存报告与不可变审查、文件范围和跨轮次事件。默认读取网关保存的事实，明确区分收到报告、原生停止和最终验收；演示数据需主动切换。桌面主从视图、窄屏分区、搜索/筛选/游标加载及旧快照保留已接入，见[运行与接口说明](T7A_READONLY_WORKBENCH.md)。stage-2 的未知字段保持原语义，GET 不触发同步、检查、模型或数据库写入。

本机浏览器读取的是 T6 历史库的独立备份，原库只读，未重新派工模型。合成截图、临时 SQLite/HTTP 测试和真实历史读取分别记录，不称为新的原生执行验收。仓库 CI、合并和正式部署独立核验；T7 的用户模式、自动调度、计量与发布验证仍未交付。

## 已合并基础

main 已在原 `7c9bece`（PR #9）基础上整合 T1/T2、T3 的协作基础及 T4A/T4B。原有 Windows 路径、启动、共享任务、只读投影、报告认证和初始 TaskContract 保留；契约准入、持久操作、共享容量和人工恢复已接入受控执行链。T5 增加文件保护，T6 增加共用独立检查、不可变审查与最终验收；完整面板和自动策略属于 T7，不代表完整 vNext 已交付。

## 本分支 T1 / T2

| 阶段 | 实现 | 边界 |
|---|---|---|
| T1 统一只读查询与 HTTP | 稳定 createdAt/taskId 游标列表、详情、health；loopback 绑定、Host/Origin 校验、失败保留 | 不包装 MCP get_task 的同步入口，不启动原生执行 |
| T2 持久事件 | SQLite 跨轮次 eventId、原生日志去重、逐条消息内容与语义事件；终态后持久推进原生消费游标 | 来源依赖受控同步，不是原生推送；缺少真实来源的事件不伪造 |
| T2 revision | 创建即保存随机 token；任务、验收条件及运行证据变化更新版本；无变化同步稳定 | GET 零写入，证据领先返回 EVIDENCE_STALE，同轮次并发更新返回 READ_CONFLICT |
| 关闭一致性 | 验收状态、review 事实及 task_closed 同事务提交；重复终态同步共享去重键 | 取消请求不等于原生停止，须有停止证明后关闭 |

HTTP schema 为 `workbuddy-executor/stage-2`，不是完整 `workbuddy-executor/vnext-1`。接口、游标、错误和未知字段见[阶段说明](WORKBENCH_STAGE_HTTP.md)，完整目标见[接口契约](INTERFACE_CONTRACT.md)。export/workspaces 仍为 501，HTTP 没有派工、返工、取消、审查或验收写入口。

## 验证与构建

`gateway/test/evidence-consistency.test.ts` 将独立验收标准纳入仓库：真实 HTTP 的证据领先拒绝、首次同步前执行完成、第二 SQLite 连接并发写入、同步后版本前移和稳定性、取消记录版本绑定、已绑定文件缺失、身份变更。它与事件、游标、原子回滚、报告认证回归一起进入 Windows CI。

标准检查：

```powershell
cd gateway
npm run build
npm run typecheck:task-view
node --import ./test/support/typescript-loader.mjs --test test/evidence-consistency.test.ts test/task-store.test.ts test/coordinator.test.ts test/task-application-service.test.ts test/workbench-http.test.ts
node scripts/workbench-smoke.mjs
node verify-snapshot.mjs
```

本次集成实际重新构建 dist、生成清单并核对重复构建，支持干净检出直接运行已提交入口。清单保留上游 provenance，不把本次提交冒充上游版本。检查结果属于具体提交，远端 CI 是否通过以对应运行记录为准。Windows Job/进程清理等环境敏感测试的历史失败不删除，未运行项目不计为通过。

## 后续顺序

2026-10-25 源码阶段记录：T3a 契约准入与 T3c 只读资源基础已实现，详见[T3a 边界](T3A_DISPATCH_ADMISSION.md)、[token 观测](T3C_QUOTA_OBSERVATION.md)和[积分缓存](T3C_CREDIT_BALANCE.md)。积分链路当时已完成本机真实只读联调，token 管理统计尚未验证。T3b 共享任务适配与 Windows 桥接源码已实现，见[T3b 说明](T3B_DSH_ADAPTER.md)；随后另行获批安装与真实会话执行的结果见上方 10月27日更新。T4A 持久操作与共享容量见[T4A 边界](T4A_OPERATION_ADMISSION.md)；T4B 原操作恢复见 [T4B 边界](T4B_OPERATION_RECOVERY.md)；T5–T7 仍待独立交付。总体目标见[协作设计](COLLABORATION_DESIGN.md)、[接口扩展](INTERFACE_CONTRACT.md#8-多-agent-扩展草案vnext-2待实现)与[验收场景](ACCEPTANCE.md)。

1. T3a：初始契约接入真实派工，绑定 workspaceId、有效轮次预算、固定期限；新增协作方案和版本化模型政策。旧 vnext-1 摘要保留，vnext-2 由显式版本分派解析。
2. T3b：共享 TaskStore 的 DSH 适配、精确会话发现、Windows named pipe、模型读回/请求层证据和取消/返工/独立验收的受控 SDK 已实现；宿主隔离加载与合成执行不替代真实模型验收。新增 HTTP 写入口、完整恢复和前端未交付；插件自动审查故障保留。
3. T3c：token 估算 quota-1 与独立的 credit-balance-1 缓存汇总接口已实现；[积分链路](T3C_CREDIT_BALANCE.md)已用本机 DSH 四个既有来源完成真实只读联调，去重为两个区域池。真实 token 统计、完整 Key 路由、前端及单任务费用仍未验收；不把共享缓存称为独占/实时余额。
4. T4A：SQLite 操作准入、显式 send/rework 预期版本、元数据方案操作、模型准备前共同占用、跨连接/进程竞争与保守崩溃状态已实现。cancel/respond/reconcile_report/accept 尚未具备完整新版操作契约；原生回执和人工恢复由 T4B 补充。HTTP 继续只读；本机共享容量结果见本次真实验收摘要。
5. T4B：原队列/DSH 回执恢复、人工授权审计、原子关闭/释放、永久关闭围栏及本地交互控制台已接入；历史缺证和停止不明仍保留占用。MCP 仅查询/显式观察，HTTP 无新写入口。本机原队列恢复续跑、人工关闭及幂等已有真实证据；不等于每个真实 DSH 恢复故障均已触发。
6. T5：文件范围清单、越界变更检查与用户原有改动保护源码已实现，两执行器采用相同准入与验收规则；真实补验、部署另记，不宣称 OS 沙箱。
7. T6：共用持久不可变 reviewId、独立程序/人工检查、当前约定/attempt/执行来源/文件证据绑定与最终 accept 已实现并合入主干；受控 SDK/MCP 可用，HTTP 继续只读。新的 WorkBuddy 与 DSH 官方来源本机小样本均 accepted 并关闭；原代理失败及检查器错误单列，正式部署和异机未执行，见[T6 阶段说明](T6_INDEPENDENT_REVIEW.md)、[交付记录](T6_COMPLETION_2026-10-29.md)和[补验摘要](T6_LIVE_ACCEPTANCE_2026-10-28.md)。
8. T7：面板真实读取、手动/推荐/自动三种模式、可解释调度、完整请求归因后单任务计量、发布版本核验与真实桌面/异机验证。

任何 HTTP 写入口及停止、费用、预算、排他、范围规则变更，须在对应约束具备后单独验收。源码提交不自动升级已安装技能或运行网关。

模型选择采用用户优先：先展示实际可用模型及已知费用，再由用户选择、确认后派工；不默认固定模型，不强制免费。付费或费用未知均须用户了解后确认；历史任务和已有部署主动设置的免费限制不自动取消。后端默认政策与仓库技能同步落实此规则，完整面板选择器仍属 T7。额度来自目标 DSH → WorkBuddy2API → 上游账号池链路，不把网关总量视作 DSH 独占余额。自动模式不授权提交、推送、部署或原生权限批准；这些仍按用户实际授权执行。

## 外部验证

[前端 Issue #6](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/6)和[异机验收 Issue #3](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/3)独立跟踪。已有历史正常任务/同任务返工反馈不能替代当前版本完整安装、取消后停止、执行中重连、升级卸载和登录自启的证据。

会话导航可见性、旧离线诊断及真实环境验证仍需按实际样本核对。本分支的合成 native actor、SQLite 和 HTTP 测试不代表真实桌面或异机验收。

## T7A 桌面外壳补充

已实现 Windows x64 独立窗口、技能启动入口、单实例任务定位及桌面专用 SQLite 只读服务。源码构建和基础测试通过；正常用户目录中的预览安装已通过真实 WebView2 渲染、同窗口定位、导航和写请求限制、窗口关闭及自有查看服务退出检查。本机技能已接入独立查看入口，保留原有执行与模型规则，原执行网关未升级。异机安装仍待验证。见 [桌面运行与边界](../gateway/docs/WORKBENCH.md)。
