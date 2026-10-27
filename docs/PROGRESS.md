# 后端开发进度

更新日期：2026-10-26。本页区分源码能力、自动验证和运行部署。

## 已合并基础

main 的集成基线为 `7c9bece`（PR #9）；PR #8 的 Windows 路径、UTF-8、启动及受限恢复修复已合并，PR #4/#7 的共享任务服务、只读投影、报告认证和不可变初始 TaskContract 已整合。存储契约尚未接入真实派工，不代表完整 vNext 已交付。

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

2026-10-25：T3a 契约准入与 T3c 只读资源基础已实现，详见[T3a 边界](T3A_DISPATCH_ADMISSION.md)、[token 观测](T3C_QUOTA_OBSERVATION.md)和[积分缓存](T3C_CREDIT_BALANCE.md)。积分链路已完成本机真实只读联调；未部署、未取得真实桌面或 token 管理统计证据。T3b 共享任务适配与 Windows 桥接源码已实现，见[T3b 说明](T3B_DSH_ADAPTER.md)；真实会话执行仍待新桥接安装后验收。T4 及以下后续阶段仍待交付。总体目标见[协作设计](COLLABORATION_DESIGN.md)、[接口扩展](INTERFACE_CONTRACT.md#8-多-agent-扩展草案vnext-2待实现)与[验收场景](ACCEPTANCE.md)。

1. T3a：初始契约接入真实派工，绑定 workspaceId、有效轮次预算、固定期限；新增协作方案和版本化模型政策。旧 vnext-1 摘要保留，vnext-2 由显式版本分派解析。
2. T3b：共享 TaskStore 的 DSH 适配、精确会话发现、Windows named pipe、模型读回/请求层证据和取消/返工/独立验收的受控 SDK 已实现；宿主隔离加载与合成执行不替代真实模型验收。新增 HTTP 写入口、完整恢复和前端未交付；插件自动审查故障保留。
3. T3c：token 估算 quota-1 与独立的 credit-balance-1 缓存汇总接口已实现；[积分链路](T3C_CREDIT_BALANCE.md)已用本机 DSH 四个既有来源完成真实只读联调，去重为两个区域池。真实 token 统计、完整 Key 路由、前端及单任务费用仍未验收；不把共享缓存称为独占/实时余额。
4. T4：operationId、expectedRevision/AttemptId、方案消费、模型准备与跨入口持久意图/回执；WorkBuddy/DSH 共用容量 1。
5. T5：文件范围清单、越界变更检查与用户原有改动保护，两执行器采用相同准入与验收规则。
6. T6：独立检查、不可变 reviewId、源码/证据/执行来源绑定与最终验收。
7. T7：面板真实读取、手动/推荐/自动三种模式、可解释调度、完整请求归因后单任务计量、发布版本核验与真实桌面/异机验证。

任何 HTTP 写入口及停止、费用、预算、排他、范围规则变更，须在对应约束具备后单独验收。源码提交不自动升级已安装技能或运行网关。

模型选择采用用户优先：先展示实际可用模型及已知费用，再由用户选择、确认后派工；不默认固定模型，不强制免费。付费或费用未知均须用户了解后确认；历史任务和已有部署主动设置的免费限制不自动取消。后端默认政策与仓库技能同步落实此规则，完整面板选择器仍属 T7。额度来自目标 DSH → WorkBuddy2API → 上游账号池链路，不把网关总量视作 DSH 独占余额。自动模式不授权提交、推送、部署或原生权限批准；这些仍按用户实际授权执行。

## 外部验证

[前端 Issue #6](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/6)和[异机验收 Issue #3](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/3)独立跟踪。已有历史正常任务/同任务返工反馈不能替代当前版本完整安装、取消后停止、执行中重连、升级卸载和登录自启的证据。

会话导航可见性、旧离线诊断及真实环境验证仍需按实际样本核对。本分支的合成 native actor、SQLite 和 HTTP 测试不代表真实桌面或异机验收。
