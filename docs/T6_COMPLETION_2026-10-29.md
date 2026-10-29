# T6 交付记录（2026-10-29）

T6 已完成共用独立检查、不可变 reviewId、证据绑定的最终验收、仓库集成及两端本机关键真实补验。实现通过 [PR #17](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/17)合入主干；本记录补齐随后取得的真实补验证据，源码交付、CI、真实补验与正式部署分别登记。

## 提交和 CI

| 项目 | 归属 |
|---|---|
| T5 起始 main | d058234332d411a244f03a5566990316cafaac5c |
| T6 最终 PR head | 36984753f99d6e04759c85ece82cff4d7528a2a0 |
| T6 实际 main 合并提交 | 0e9d96b6e88e0bdfacfd007762c089e6e0f2101c |
| 合并文件树 | 629bfd29708238e431e6265d6a293ffa58ac5461 |
| 运行代码摘要 | 1aec15871cc64127cd970ee14bfc8819962818732b312098b4f7b17e5d4ffd5b |

最终 PR head 的 [CI 40650368034](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/runs/40650368034)与实际 main 的 [CI 40651746599](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/runs/40651746599)分别成功，各 732 项：725 通过、7 条件跳过、0 失败。构建、类型检查、已提交编译产物一致性、446 文件快照、6 份技能副本及 25 步编译入口冒烟均通过。PR CI 与 main CI 不互相代替，计数不相加。

独立干净检出未构建、没有 .env 或开发依赖，复用与同一 lockfile 对应的已验证生产依赖，快照和编译入口冒烟通过；没有冒称重新安装依赖。较早候选及本机执行组中的失败保留：brief schema 问题修正后定向回归通过，Windows Job 的本机区域信任阻塞单列。最终 CI 结果不抹去这些原始失败。

## 实现与真实补验

WorkBuddy desktop-queue 与 DSH 使用同一审查存储和最终验收关口，服务端产生检查身份、不可变 review 和持久操作回执。worker 自报不能冒充独立检查，后端命令须匹配原精确 CommandSpec；必需项缺失、失败、unknown、checker_error 或 not_applicable 均不能接受。更正留痕，审查区分 basisRevision/committedRevision，最终 accept 重核真实来源、报告认证、停止、原约定和当前文件/证据，并一致提交 accepted、task_closed 和操作回执。细节见[T6 实现边界](T6_INDEPENDENT_REVIEW.md)。

10月28日，新的 WorkBuddy 与 DSH 官方来源小样本均在上述 main 的字节相同隔离运行副本上完成真实执行、后端独立命令、不可变审查、最终接受和关闭。各一轮，期限不变，原有文件与 Git 暂存状态保持；重开数据库后验收记录与重放结果一致。原代理 DSH 的 11128 渠道失败、环境预检失败及验收脚本更正分别留档，详见[脱敏补验摘要](T6_LIVE_ACCEPTANCE_2026-10-28.md)。这些是新 T6 样本，没有将 T5 历史任务重新标记或补造 review。

本次文档收尾只同步经过核对的脱敏结论，不改变运行代码。后续文档 head 和合并后的 CI 以对应 PR/Actions SHA 核对，不把上述实现 CI 冒称文档提交的新 CI，也不冒称每个文档提交再次派工模型。

## 完成边界与后续

交付覆盖约定源码、自动验证、主干集成与本机关键补验。库存排除项、外部 shell 可见性及数据库外部文件竞态限制仍在，不宣称 OS 沙箱。原生停止覆盖原请求；全部真实故障、第二台 Windows、正式安装包和部署升级仍待独立验证。

HTTP 仍为 stage-2 只读；受控 SDK/MCP 已实现的 T6 入口不等于完整 vNext HTTP 写 API。T7 的真实面板、手动/推荐/自动模式、可解释调度、单任务计量和发布验证尚未交付，见[开发进度](PROGRESS.md)。本次没有修改已安装网关、技能、应用插件、全局 MCP、profile、凭据或安全策略。原始任务库、会话和工具日志留在仓库之外。
