---
name: workbuddy-executor
description: 将适合的本地开发、修复、测试及资料整理交给桌面 WorkBuddy，由 Codex 定义范围、监督并验收。小改默认直接处理；用户指定委派或测试协作时照常使用。用户要求自行执行、纯原理问答及核心算法设计时不委派。
---

# WorkBuddy 执行官

通过 `workbuddy` MCP 的 Windows desktop-queue 派工。Codex 定义目标、边界与验收，WorkBuddy 定位、实现、自测和常规修错。模型政策与本机入口见 [连接与恢复](references/setup.md#本机部署与模型政策)；本技能不路由到 Agent Hub。

## 1. 判断与准备

按已有需求判断，不为估算交接成本扫描整套代码。目标和位置清楚、低风险的一次局部修改默认直接处理；用户指定 WorkBuddy 或测试协作时照常委派，不重复劝阻。已有 taskId 先恢复原任务，不能因工作量小而重派或直接接管。

复用已答复信息，只对改变功能含义、权限或数据处理范围的实质歧义问一轮必要问题。普通可逆细节沿项目惯例，代码位置等技术问题交 WorkBuddy 调查。

一次交付一个可独立验收的功能或完整阶段，一次只派一个任务，不与 WorkBuddy 同时编辑业务代码。网关或技能自修由 Codex 在隔离副本完成，不委派给正在修复的链路；普通业务故障不自动扩大成网关改造。

## 2. 派工

- 每个新任务先展示实际可用模型及已知费用，让用户选择精确模型；不得默认某个模型或要求必须免费。费用未知时明示未知，付费或未知费用均须用户了解后确认。用户尚未选择时只查询，不准备模型或派工；明确选定且已授权的同一任务无需重复询问。
- send_task 显式传用户选定的 model，返工沿用原任务已授权模型。不可用、限流或模型读回不符时阻塞，不擅自换模型；更换选择须重新确认且不能绕过旧任务的停止与预算限制。“只用免费模型”仅在用户主动设置时生效，已有任务或部署的限制不自动取消。
- 新任务使用稳定 taskId，直接向 send_task 提交真实项目目录与已选模型；模型准备在持久操作和共享容量准入之后进行。独立 ensure_workspace/Hub bind 已拒绝原生准备。已有身份先 get_task/wait；OUTCOME_UNKNOWN 用原 operationId 查询 get_operation，不换键、复制项目或换会话重发。
- 显式操作使用稳定 operationId；新 send 的 expectedRevision/expectedAttemptId 均为 null，返工带当前实际 revision/attemptId。旧参数调用仍经过持久兼容准入；重复相同反馈只重放，需要再执行同一反馈须提供新的操作身份和当前版本。needs_review 仍占用名额，直到真实关闭与停止证明齐备。
- 约定目标、可改范围、可观察的验收、必要假设及期限，保留用户已有改动。关键歧义以 blocked 回报；常规修错由 WorkBuddy 完成。

首次编写派工约定或需要完整工具示例时读 [正常派工示例](references/dispatch.md)。执行、回报与验证格式见 [执行规范](references/execution.md)。

## 3. 监督

默认 `detail: brief`，用45–55秒有界 wait；重连可用 sinceEventSeq 延续游标，不以反复 get 和扫文件替代进度。queued 是排队，working 且 runtimeSource=desktop_queue 才是原生接单，needs_review 是待验收，accepted 才是独立验收通过。

使用返回的 claimDeadline、reportBy、deadline；休眠和失联不延长绝对期限，不能擅自重试。阶段变化或约60秒有意义进展时由 WorkBuddy 回报，不靠文件修改频率判断挂起。

取消用 cancel_task。cancellationRequested 只是请求，remoteStopped 才是停止证明；stop_unconfirmed 时禁止新派工、重叠返工和验收。失联、查询锁冲突、启动超时或归属不明时读 [连接与恢复](references/setup.md)，不按进程名清理或重启整个 WorkBuddy。

## 4. 验收与返工

仅 needs_review 且有真实报告、原生停止证据时验收。核对 taskId、attemptId、sessionId、runtimeSource=desktop_queue、remoteStopped；end_turn、队列取消或结果文件本身都不证明原生停止。Codex 不代领、代写或代交 WorkBuddy 成功报告。

检查本次实际增量与相关边界，区分源码检查、Mock、本地浏览器样本和真实环境。基线检查不替代改动后验证；核对命令退出码、证据与当前源码。修改后重跑受影响检查，可信且对应当前修改的验证无需整套重跑。网关能检查所引用记录的状态和哈希，验证覆盖是否足够、功能是否正确仍由 Codex 判断。

通过后 accept_task 记录实际 evidence/artifactPaths。需要修正且确认原生停止后，沿原任务 continue_task，保留会话与失败历史；默认首次加两轮返工，不换键绕过限制。超时的认证迟到报告可供审查，任务仍是 blocked，不能直接验收。

最终报告真实交付状态、成果入口、实际验证及影响使用的遗留问题。评估效率时记录监督调用、回报字节数、耗时和人工干预；没有对照实测，不宣称节省 token 或时间。
