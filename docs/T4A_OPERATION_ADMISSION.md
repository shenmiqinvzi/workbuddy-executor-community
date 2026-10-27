# T4A：持久操作与共享容量

本阶段只交付操作准入，不开放 HTTP 写接口，不执行真实模型。本设计先于实现固定；验收遵循 ACCEPTANCE C02/C05/C07/C16。

## 操作与事务

SQLite `task_operations` 保存 operationId、类型、task/attempt、完整规范参数的 SHA-256、预期 revision/attempt、执行器和原绑定、时间、结果或脱敏错误。状态为 `reserved`（已取得执行权）、`effect_started`（原生副作用可能开始）、`succeeded`（保存应用返回结果）、`rejected`（确认未进入副作用）、`outcome_unknown`（已可能发生副作用）。进程退出留下的前两种状态也必须向客户端报告 OUTCOME_UNKNOWN 和原 operationId，不自动恢复执行。

BEGIN IMMEDIATE 内先查重放/冲突，再核对预期状态，再取得容量并插入操作。已完成的重放先于版本检查，原结果不会被后续 revision 变化覆盖。同步元数据操作（方案创建、实际用户确认）与结果在同一事务；原生调用在事务外，调用前另行提交 effect_started，回执另行提交。回执事务失败不能删除意图或伪称未派工。

参数摘要涵盖所有传入行为字段，包括完整约定、执行选择、期限、反馈、工作区、会话、方案引用和预期版本；对象键排序，数组保序。客户端 approved/verified/free 不作为事实。方案确认只能由已有可信应用动作调用；expectedPlanRevision 与 task attempt 分开。

## 容量生命周期

同库唯一容量行保存工作流 taskId 和原执行器；与准入同事务提交。原生准备前取得，返工沿用，不在轮次结束或 needs_review 释放。每次准入同时检查旧任务：只有当前 attempt 的持久停止摘要与匹配 task_closed、真实终态同时存在才视为关闭；无 attempt 的旧任务同样阻塞。多条旧未关闭记录不擅自选一条忽略其余。

取消请求、idle、超时、TTL、客户端关闭和进程退出均不释放。保守保留准备/投递不明的容量。明确在副作用标记前拒绝、且未创建任务的首次准入可以释放；已创建的任务保留，等待后续受控关闭。关闭释放在写事务中验证，不由 GET 或 TTL 清理器触发。

## 接入与兼容

TaskApplicationService 与直接使用 TaskCoordinator / DshTaskCoordinator 的旧 SDK 共享 TaskStore 的准入实现；MCP 和 CLI 的官方 MCP 调用最终落到这些协调器。显式 operationId 的新 send 使用 expectedRevision=null、expectedAttemptId=null；rework 必须带两个实际预期 token。新建方案无 task attempt；确认使用 expectedPlanRevision。

旧 send 使用稳定 taskId 派生操作键；旧 rework 使用完整参数派生键，在事务内捕获当前 revision/attempt，重复相同反馈只重放；需要再次执行相同反馈时必须显式提供新 operationId 和预期版本。这是可见的受保护兼容方式，旧客户端没有提供的版本不能被宣称为客户端过期检测。无稳定 taskId/operationId 的新 send 拒绝。底层 queue 与持久服务的原生准备/唤醒也须检查共同占用，不能由旧公开入口取得第二份容量。独立模型准备入口应拒绝并引导到授权派工。

cancel、respond、报告同步、reconcile 与 accept 保留原有身份/停止/验收规则；本阶段不宣称它们已具备完整 operationId/revision 契约。GET 保持只读。vnext-1 摘要、原政策和历史记录不改写。保证仅覆盖连接同一 TaskStore 的受控入口，无法控制独立旧网关、手工启动的外部应用。

## T4B 边界

原生回执恢复、人工处理/关闭不确定操作、恢复界面及其授权审计留给 T4B。T4A 不按猜测重发、不换模型/会话/任务键，不增加新业务状态机。历史未知任务可能使服务保持阻塞；这比制造停止证明或迁移后重派更符合本阶段安全约定。

## 已实现入口与验收

- `TaskApplicationService.send/continue`、`TaskCoordinator.send/continue`、`DshTaskCoordinator.send/continue` 使用同一 SQLite 操作机制。TaskStore.beginAttempt 再次事务核对已读取的 revision/attempt，防止原生观察期间发生取消或并发换轮次。
- `server.ts` 的 send/continue 接收操作参数；`workbuddy_get_operation` 只读原记录。SDK 异常和 brief 响应保留原 operationId 与不确定状态；首次已知拒绝原因可与 outcomeCode=OUTCOME_UNKNOWN 并存。succeeded 仅表示应用返回值已保存（包括明确的派工拒绝），不表示业务验收成功。
- `DesktopQueue.start` 有自己的持久 enqueue 回执并沿用父工作流容量；PersistentDesktopService 在原生模型准备与新唤醒前检查占用和完整的派工回执。`workspace-manager.ensureWorkspace` 的原生创建/模型配置重新检查同一准入；旧 MCP ensure_workspace 和 Hub bind 明确返回 OPERATION_REQUIRED。官方 CLI 使用 MCP；旧 Hub submit/rework 调到同一协调器，不用 HubRun 另开名额。
- 迁移只增加操作/容量表。历史相同 send 可以纯读返回原任务，不为重放准备模型或补造停止证明；历史未关闭任务阻止任何新工作流。stage-2 health 的 occupiedByTaskId 暂仍为 null，内部真实占用可通过可信存储入口读取，不把旧 DTO 改称完整 vNext。

自动验收入口：`gateway/test/t4a-operation-admission.test.ts`，使用真实临时 SQLite、双连接与独立子进程；另运行旧模型政策、用户选择、队列/持久服务、只读 HTTP 和格式 1/2 报告回归。基线缺陷复现与修复验收分别保存，不提交本机原始日志。所有原生执行器均为可计数合成替身；真实安装、真实收费模型与真实停止恢复未验证。

独立验收重点：故障后原操作和占用是否仍在；不同连接/执行器是否在准备前竞争；旧页或旧轮次是否被事务拒绝；needs_review 和未知历史是否仍挡住新任务；显式重放是否返回原保存结果；旧客户端兼容键是否符合预期。T4B 必须设计人工结束准备失败工作流、原生回执归因、恢复授权/审计与恢复动作的自身幂等，不能靠删除 SQLite 行解除未知执行。

## 独立验收后的边界修正

首次独立验收发现六类缺陷，旧失败证据与修复验证分开保存在仓库外；此前构建和回归通过不足以证明这些边界成立。修正约定如下：

- 队列领取须在 SQLite 写事务内核对已有共同占用、当前 attempt 及其成功的 enqueue 回执，再取得文件租约。没有原操作的迁移队列保持可读，不自动领取，也不在领取时补造准入；两个 runsDir 连接同库仍受此约束。持久服务在模型配置和唤醒前再次核对原目录、会话及模型。
- 返工必须取得当前 task/attempt/session 的停止证据；缺失 run 文件、空 runtimeSource、blocked 标签或已有 wake 文件都不能替代停止。只有持久回执明确证明在任何副作用前拒绝了该 attempt，才允许按未派工处理。
- 模型准备保存原 operationId 与具体目录、请求会话、模型、workerKey、标题；适配器入口只可进入一次，并保存首次解析的原生会话。仅借用 taskId、修改绑定或重复进入均拒绝。指定已有会话时不再携带用于创建会话的 workerKey。
- 直接协调器 SDK 的新任务也必须显式提供模型；历史相同 send 的纯读重放保留，不为旧记录补选模型。
- WorkBuddy 与 DSH 的显式返工在内部同步后仍校验调用者原始 revision/attempt，不能用新报告的版本替换旧 token。旧兼容返工先观察再事务捕获版本；已保存操作的重放先于同步。
- 相同 send 重放的默认期限取自原操作，当前配置变化不能使未变的请求冲突；显式修改期限仍属于不同参数。

新增 `gateway/test/t4a-boundaries.test.ts` 覆盖生产 SDK、迁移队列、丢失停止证据、准备绑定的正反路径、内部同步版本竞争和配置变化重放；DSH 回归也覆盖同步时收到新报告。正向旧样本显式提供合成模型选择及相应原生读回；缺失选择的反向样本仍使用生产客户端。验证不连接真实桌面或真实模型。
