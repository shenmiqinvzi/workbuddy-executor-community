# T3a：任务约定接入派工准入

日期：2026-10-25。状态：已实现内部服务及兼容 MCP 参数，验证以对应提交记录为准；真实 WorkBuddy 桌面验收、DSH、额度采集和 HTTP 写操作不在本阶段交付内。

## 已实现的路径

`TaskApplicationService.send({objective, contract, ...})` 进入契约派工分支：校验版本与参数 → 核对已登记目录、模型政策与用户已确认的方案 → 同事务保存任务/约定/准入和方案消费 → 由获胜创建者准备原生会话 → 观察精确 session/model 与可得费率 → 原子预留轮次、固定 deadline → 写入原桌面队列。

重复 taskId 和相同约定只返回原任务，不重新准备模型或派工。创建后准备失败保留 blocked 及原身份；结果不明不能换键自动重试。本阶段尚无 T4 的完整操作回执/恢复流程，未开始的保留任务也不由重复 send 自动补发。

| 能力 | 具体行为 |
|---|---|
| 工作区登记 | ID 绑定真实绝对目录及设备/文件身份；拒绝同 ID 改绑和目录替换 |
| 模型政策 | 默认用户选择，无固定模型或免费要求；可主动设置白名单/免费限定。付费和费用未知模型须用户了解后确认 |
| 模型证据 | 明确只达到 `selected` 层级；不宣称已取得实际模型推理请求或代理后的物理模型证据 |
| 约定版本 | vnext-1 旧解析器与摘要原样保留；显式版本分派接受 vnext-2 的 execution/collaboration，拒绝混合字段 |
| 方案 | 手动/推荐两模式的记录、固定条款摘要、期限和真实授权后的确认；同一方案不能用于两个 taskId |
| 原子性 | 任务、约定、准入、方案消费在同一 SQLite 连接/事务；任一步故障整体回滚 |
| 轮次 | beginAttempt 与 continue 使用持久 effectiveMaxAttempts；提高全局配置不提高旧预算 |
| 固定模型与期限 | 返工不能改变约定模型/期限/检查；每个新轮次保存自己的绝对 deadline，队列接收不顺延它 |
| 唤醒复核 | 原生服务正式唤醒前复核约定、目录、轮次/期限、原始与当前政策、会话模型；免费限定时另查零费率，目录查询期间撤销政策也拒绝唤醒 |
| 完整性 | 派工标记防止删除准入后退回存储兼容路径；缺准入/坏摘要明确失败，不降级为无约定 |

## 服务与 MCP 接入

原 MCP 工具名称保持不变，新增可选参数：

- `workbuddy_ensure_workspace` 的 `workspaceId`：将该目录登记为约定项目，原工作会话准备仍按原语义执行。未传时维持原行为，不猜测项目 ID。
- `workbuddy_send_task` 的 `contract`：完整 vnext-1 或 vnext-2 对象；objective/taskId/model/timeout 若同时提供须与约定一致。不得同时传 constraints 或 acceptanceCommands；它们从约定范围/检查派生。

默认用户选择政策下，新的契约派工必须使用 vnext-2，引用内部服务保存、经实际用户确认的方案；vnext-1 不可绕过确认。已有显式免费白名单部署仍兼容 vnext-1 派工，旧任务约定和原始限制不改写。MCP 无契约兼容入口与会话准备入口也必须显式给出用户选定的 model，不再省略后沿用会话默认模型。

`TaskApplicationService` 提供 `registerWorkspace`、`createCollaborationPlan`、`authorizeCollaborationPlan`、`getCollaborationPlan` 作为可信本地应用入口。create 的输入为完整 vnext-2 提案，提案里的 collaboration 引用可用占位符；实际创建后的 planId/revision 用于最终提交。条款摘要排除 taskId 和 collaboration 引用，避免循环摘要，但保留目标、工作区、执行选择、范围、检查与预算；最终消费绑定确切 taskId。

`authorizeCollaborationPlan` 只能在应用已取得真实用户授权后调用。source 字符串用于审计，不能当作授权证据或公开给客户端自批。本阶段不新增外部方案确认工具、自动审批、HTTP 写路由或前端按钮；交互授权、鉴权与操作幂等在 T4/T7 实现。

`CollaborationRegistry.setPolicy` 是服务端本地配置入口，支持 `selectionMode=user_choice|allowlist` 和可选 `requireFree`，仍限制轮次与期限。历史政策无 selectionMode 时按原白名单解释；新默认无预选模型。WorkBuddy 适配器不能执行 DSH 或非本地 WorkBuddy 来源；DSH 由独立适配器处理，自动授权仍未开放。

## 存储、兼容与部署边界

新增 collaboration_workspaces、collaboration_policy、collaboration_plans、task_admissions、task_attempt_admissions 表，以及 tasks.contract_dispatch 标记。准入保存工作区/模型选择/政策快照/约定摘要/方案引用；轮次准入保存 session 绑定的选中模型观察和 deadline。表记录带摘要，读取不修复、不补写；没有连接凭据和原始账号数据。

旧无约定任务保留原路径。旧 vnext-1 存储约定仍可读取，摘要与 agreementVersion 不变；没有真实派工准入的历史约定不能经 continue 自动升级成已核验任务。新版本支持的 vnext-2 不会被转换成 vnext-1。旧二进制不支持新版约定，升级前必须备份并按部署流程处理活动任务；禁止混用新旧写入进程，降级须先确认没有不兼容活动任务。本轮未升级任何运行安装或真实数据库。

stage-2 HTTP 响应保持原样：workspaces/export 仍为 501，所有 HTTP 写操作仍不存在。新准入的目录名称、模型证据与期限目前从内部记录核查，不把它们悄悄填入旧 DTO 或改写 unavailable。全局跨入口容量、operationId、模型准备结果不明的恢复与安全迁移门禁仍依赖 T4。

## 验证与下一阶段

回归入口：`gateway/test/t3-admission.test.ts`，并纳入专项类型检查与 Windows CI。覆盖真实 SQLite 双进程争用同一方案、同任务并发提交、失败回滚、目录替换、模型/会话不符、费率未知/付费、政策在准备和目录查询期间变化、轮次不扩张、固定期限、重启读取及准入损坏。

这些测试使用合成原生注册库、原桌面队列、替身模型观察和替身唤醒；没有真实模型调用，不代表真实桌面或 DSH 验收。旧 vnext-1 的固定摘要来自实现基线 `6b278d0`，不是当前算法自算的预期。

T3b 接入 DSH 的原生目录/会话/模型接口与真实停止证明；T3c 接入 WorkBuddy2API 的后台只读资源快照。T3a 通过不表示两者完成，也不自动开放新 HTTP 写入口。
