---
name: workbuddy-executor
description: 将适合的本地开发、修复、测试及资料整理交给桌面 WorkBuddy，由 Codex 定义范围、监督并验收。小改默认直接处理；用户指定委派或测试协作时照常使用。用户要求自行执行、纯原理问答及核心算法设计时不委派。
---

# WorkBuddy 执行官

通过 `workbuddy` MCP 的 Windows desktop-queue 派工。Codex 定义目标、边界与验收，WorkBuddy 定位、实现、自测和常规修错。模型政策与本机入口见 [连接与恢复](references/setup.md#本机部署与模型政策)；本技能不路由到 Agent Hub。

## 桌面工作台

实际开始使用本技能处理任务时，按连接与恢复说明中的网关目录运行 `node <网关目录>/scripts/open-workbench.mjs`，自动打开独立桌面窗口。已有或新取得 taskId 后再用 `--task-id <taskId>` 激活同一窗口并定位任务。启动结果 `launch_requested` 仅表示已请求打开，不证明窗口就绪或任务执行成功。桌面程序未安装、数据目录未找到或启动失败时简短说明，继续原有任务流程；不为打开窗口准备模型、重派任务或修改账号与网关配置。构建与运行要求见网关的 `docs/WORKBENCH.md`。

若本机同时保留旧 MCP 任务库和新版独立任务库，应使用已配置的 `scripts/open-workbench-router.mjs --routes-file <本机绝对配置路径>`，并以同一入口附加 `--task-id <taskId>`。它仅在声明的库中只读定位任务；库内复用窗口，跨库分别定位。编号冲突或库不可读时停止定位，不迁移、复制或重新派工。自动打开/定位本身不调用模型，桌面手动派工仍须另行明确选择和原生确认。

### 准备任务与核对

“新建任务”只读目录：列出来源、精确模型、推理档位、原会话与观察费率，不准备模型、不创建原生会话、不自动选最新会话或最新项目。目录读取失败时按来源分别说明原因，来源为空不等于没有可用执行器。

项目按目录身份选择：`projectId` 由目录的设备与 inode 派生，也可以直接填写绝对路径；预览时会重新核验，目录被替换（`PROJECT_IDENTITY_CHANGED`）、链接无法解析或同名歧义都会明确拒绝，不会退回最近使用或“最新”目录。

核对后选“返回修改”保留原 taskId 与操作编号，再次核对生成下一版（`revision` 加一），旧版本的摘要立即失效且有效期不延长；换来源、模型或档位不算修订，必须重新读目录并重新确认费用（`MODEL_SWITCH_REQUIRES_PREVIEW`）。同一份约定（同项目、同模型、同范围、同验收、同预算与费率）只派工一次，第二个 taskId 会被 `PLAN_ALREADY_CONSUMED` 拒绝。

派工仍须在本机确认窗口明确同意；确认前失败或被取消不产生原生轮次，结果不明时按原编号查询回执与恢复证据，不换编号重派。

## 执行器选择

派工前先确认这台网关能接哪种执行器：`workbuddy_list_executors` 返回 WorkBuddy 的后端类型和 DSH 适配器状态（`adapter_disabled` 表示网关没开 DSH，`native_bridge_not_registered` 表示没有活着的桥）。选择由契约的 `execution.executorId` 决定：`workbuddy` 走桌面队列，`dsh` 走 DeepSeek Harness。用户指定具体执行器时照办；没说时按任务性质默认 WorkBuddy，并在报告里写明实际执行器——面板的列表行、详情和筛选都按这个字段显示，不要凭任务名或会话猜。

选 DSH 时先用 `workbuddy_list_dsh_sessions`（参数为该项目的绝对路径，可带精确 `sessionId`）取实时会话：返回 `matched` 才拿到可用 sessionId，`ambiguous` 要用户指定，`no_matching_live_session` 表示该项目当前没有活着的会话，`registry_missing` 表示这台机器没装 DSH。DSH 只接受 `workbuddy-executor/vnext-2` 契约，且计划必须已经由本机的 `node scripts/plan.mjs` 创建并授权——那是本地操作者的动作，不是工具能力：agent 可以起草 `execution` 与提案，但不能自己授权，也不要绕过它改用非契约派工。契约必须显式带 sessionId，且不能带 constraints/acceptanceCommands/scope/model/timeoutSeconds 或 `sessionMode: "new"`（这些由 DSH 自己管理，带了会被判 TASK_CONFLICT）；模型选择仍要先让用户确认真实可用与费用。发现是只读的：列会话不租约、不激活、不发模型请求，看到可用不等于已经派出去。

## 1. 判断与准备

按已有需求判断，不为估算交接成本扫描整套代码。目标和位置清楚、低风险的一次局部修改默认直接处理；用户指定 WorkBuddy 或测试协作时照常委派，不重复劝阻。已有 taskId 先恢复原任务，不能因工作量小而重派或直接接管。

复用已答复信息，只对改变功能含义、权限或数据处理范围的实质歧义问一轮必要问题。普通可逆细节沿项目惯例，代码位置等技术问题交 WorkBuddy 调查。

一次交付一个可独立验收的功能或完整阶段，一次只派一个任务，不与 WorkBuddy 同时编辑业务代码。网关或技能自修由 Codex 在隔离副本完成，不委派给正在修复的链路；普通业务故障不自动扩大成网关改造。

## 2. 派工

- 每个新任务先展示实际可用模型及已知费用，让用户选择精确模型；不得默认某个模型或要求必须免费。费用未知时明示未知，付费或未知费用均须用户了解后确认。用户尚未选择时只查询，不准备模型或派工；明确选定且已授权的同一任务无需重复询问。
- WorkBuddy 任务在 send_task 顶层显式传用户选定的 model；DSH 任务的模型只写在契约的 `execution`（`providerId`/`modelId`/`reasoningEffort`），顶层的 model/scope/constraints/acceptanceCommands/timeoutSeconds 一律不传，带了会被判 TASK_CONFLICT。返工沿用原任务已授权模型。不可用、限流或模型读回不符时阻塞，不擅自换模型；更换选择须重新确认且不能绕过旧任务的停止与预算限制。“只用免费模型”仅在用户主动设置时生效，已有任务或部署的限制不自动取消。
- 新任务使用稳定 taskId，直接向 send_task 提交真实项目目录与已选模型；模型准备在持久操作和共享容量准入之后进行。独立 ensure_workspace/Hub bind 已拒绝原生准备。已有身份先 get_task/wait；OUTCOME_UNKNOWN 用原 operationId 查询 get_operation，不换键、复制项目或换会话重发。
- 显式操作使用稳定 operationId；新 send 的 expectedRevision/expectedAttemptId 均为 null，返工带当前实际 revision/attemptId。旧参数调用仍经过持久兼容准入；重复相同反馈只重放，需要再执行同一反馈须提供新的操作身份和当前版本。needs_review 仍占用名额，直到真实关闭与停止证明齐备。
- 约定目标、可改范围、可观察的验收、必要假设及期限，保留用户已有改动。关键歧义以 blocked 回报；常规修错由 WorkBuddy 完成。
- 编辑任务须在新 send 的 scope 或完整契约中提供精确文件/directory/** 与最小 permittedMetadata；自由文本不授予写权限，未声明 scope 的新调用只读。原有 dirty/暂存/未跟踪文件仍受保护，不在返工后扩大范围或刷新原基线。

首次编写派工约定或需要完整工具示例时读 [正常派工示例](references/dispatch.md)。执行、回报与验证格式见 [执行规范](references/execution.md)。

## 3. 监督

默认 `detail: brief`，用45–55秒有界 wait；重连可用 sinceEventSeq 延续游标，不以反复 get 和扫文件替代进度。queued 是排队，working 且 runtimeSource 与契约执行器一致（WorkBuddy 为 desktop_queue，DSH 为 dsh）才是原生接单，needs_review 是待验收，accepted 才是独立验收通过。runtimeSource 与契约不符说明任务被换到别的执行器，按归属不明处理，不当成同一轮进度。

使用返回的 claimDeadline、reportBy、deadline；休眠和失联不延长绝对期限，不能擅自重试。阶段变化或约60秒有意义进展时由 WorkBuddy 回报，不靠文件修改频率判断挂起。

取消用 cancel_task。cancellationRequested 只是请求，remoteStopped 才是停止证明；stop_unconfirmed 时禁止新派工、重叠返工和验收。失联、查询锁冲突、启动超时或归属不明时读 [连接与恢复](references/setup.md)，不按进程名清理或重启整个 WorkBuddy。

## 4. 验收与返工

仅 needs_review、认证报告与绑定本轮的原生停止证据都存在时验收。核对 taskId、attemptId、sessionId、runtimeSource 与契约执行器一致，以及 executionStatus 的 remoteStopped=true。WorkBuddy 的停止证据是 nativeStoppedAt 且 nativeStopSource 为 `native_idle`（原生会话经检查确认空闲后写入）或 `not_dispatched`（从未被原生领取，含领取前取消）；原生失败路径还须有 nativeFailure 到 stopControl 的完整时间链和至少两次空闲观察。worker 报告的 end_turn/blocked/failed/cancelled 只结束本轮租约，队列取消与 cancellationRequested 只是请求，都不能单独证明停止。DSH 要核对绑定原请求的终态事件：requestId 与 attemptId、sessionId、hostId 三者与快照一致，terminal 带 seq 与时间，rawType 为 `turn/end` 或 type=cancelled 且 rawType=`agent/inbox/spliced`，且 nativeStoppedAt 与该事件时间相等、nativeStopSource=`dsh_terminal_event`；只认事件名称不算。结果文件存在、进程消失或面板显示停止都不算。Codex 不代领、代写或代交成功报告。

检查本次实际增量与相关边界，区分源码检查、Mock、本地浏览器样本和真实环境。基线检查不替代改动后验证；核对命令退出码、证据与当前源码。修改后重跑受影响检查，可信且对应当前修改的验证无需整套重跑。网关能检查所引用记录的状态和哈希，验证覆盖是否足够、功能是否正确仍由 Codex 判断。

先用 check_task 保存服务端程序批次；需要语义检查时，以 record_inspection 记录实际文件检查，再用 review_task 引用原约定的 semantic 项和检查证据，取得不可变 reviewId。accept_task 只接受该 reviewId 和当前 operationId/revision/attempt；旧 note/evidence/artifactPaths 调用不能绕过。命令必需项须有可匹配的真实命令记录，原约定为精确 JSON CommandSpec 时可显式调用 run_review_command 复核，不调用模型。详情见 [派工与审查示例](references/dispatch.md)。需要修正且确认原生停止后，沿原任务 continue_task，保留会话与失败历史；默认首次加两轮返工，不换键绕过限制。超时的认证迟到报告可供审查，任务仍是 blocked，不能直接验收。

最终报告真实交付状态、成果入口、实际验证及影响使用的遗留问题。评估效率时记录监督调用、回报字节数、耗时和人工干预；没有对照实测，不宣称节省 token 或时间。
