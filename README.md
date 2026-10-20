# WorkBuddy Executor

让 Codex 与桌面 WorkBuddy 协作完成本地开发任务：Codex 明确范围、监督并独立验收，WorkBuddy 负责适合委派的实现、测试和资料整理。

当前产品目标仅为 Windows。仓库维护者负责路线、集成与发布，欢迎通过 Issue 提供场景、认领具体任务并提交 PR；任务状态与交付在对应 Issue/PR 中跟踪。

项目正在整理开放协作入口；统一开源许可证尚待明确，来源与授权事实见 [授权和许可说明](AUTHORIZATION.md)。本仓库是面向社区的公开版本。

## 当前能力

- 通过 Windows desktop-queue 连接 WorkBuddy，提供技能、网关源码和验证记录。
- 以稳定任务身份派工、监督、同任务返工及独立验收；相同初始请求复用，冲突请求拒绝。
- 在启用免费模型政策时核验精确模型与零费率，不静默切换付费模型。
- 观察原生停止证据、限制执行期限和返工轮次；报告收到不等于已停止或已验收。
- 对引用的验证记录、报告身份和当前源码进行复核；覆盖边界见 [保障清单](gateway/docs/workbuddy-executor-audit.md)。

范围明确、低风险的小改默认直接处理；需要持续定位、实现和验证的任务再委派。用户明确要求委派时按指定方式执行。

## 开始使用与开发

使用技能从 [SKILL.md](SKILL.md) 开始；完整正常流程见 [派工示例](references/dispatch.md)，部署和故障恢复见 [连接说明](references/setup.md)。示例中的本机路径须按实际安装调整。

新部署者从 [Windows 安装指南](gateway/docs/INSTALL_WINDOWS.md) 开始，使用配置探测、只读诊断和可重复安装流程。跨机器结果另按 [第二台 Windows 实机验收](gateway/docs/DEPLOYMENT_ACCEPTANCE.md)记录。参与开发请先读 [贡献指南](CONTRIBUTING.md)，历史快照恢复见 [gateway/RESTORE.md](gateway/RESTORE.md)。实际配置、登录和运行数据由使用者在本机维护。

| 内容 | 入口 |
|---|---|
| 使用需求、灵感和故障反馈 | [创建 Issue](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/new/choose) |
| 阶段目标与可参与方向 | [公开路线图](ROADMAP.md) |
| 已完成、待交付与下一步 | [开发进度](docs/PROGRESS.md) |
| 待实现的架构与约束 | [总体设计](docs/DEVELOPMENT_DESIGN.md) |
| 服务、状态及指标约定 | [接口契约](docs/INTERFACE_CONTRACT.md) |
| 版本行为验收标准 | [验收场景](docs/ACCEPTANCE.md) |
| 已有修复与验证历史 | [更新记录](CHANGELOG.md) |
| 前端只读模拟原型 | [设计任务书](docs/FRONTEND_TASK_PANEL_DESIGN.md) · [Issue #6](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/6) |

共享任务服务的基础兼容层已接入 MCP，提供保守的任务状态和允许操作视图，并保留原生错误、报告恢复与停止核验规则。整合分支已完成独立部署和本机真实验证：正常小代码任务验收通过，MCP重连、正式取消均有实际证据；历史pending误判修复后，原超时演练第3轮已验收，前两轮失败保留。详见[修复部署记录](gateway/docs/native-history-deployment-verification.json)。完整 vNext 契约、本地 HTTP/面板和自动指标仍待实现，开发分支尚未合并main。

下一优先项是统一任务视图与本地只读接口；前端只读模拟原型已通过 Issue #6 发布并指派，尚未记录实现PR或验收。当前阶段与待办统一见[开发进度](docs/PROGRESS.md)。

## 验证与已知限制

主要验证环境为 Windows，本仓库尚未完成第二台机器的完整恢复安装验证。上游 README 的其他平台或接入路线不等于本分支已支持。旧 MCP 连接可能仍加载旧程序，更新源码后需按部署步骤核对运行哈希。

现有程序约束不构成操作系统文件系统沙箱；范围检查和验证引用都有覆盖边界。原生权限在 WorkBuddy 内处理，正式取消不能作为暂停后继续。

[2026-10-18 对照报告](benchmarks/2026-10-18-luna-workbuddy/REPORT.zh-CN.md)包含六组固定任务：Luna 直接执行最终通过 6/6，监督 WorkBuddy 通过 4/6，取消与超时各一项。样本小，部分计时缺失，token 和完整监督费用未测，不支持总体效率或成本节省结论。历史评测保留原结果，新改进另做对照。

本次社区发布使用经过隐私审查的文件快照建立新的提交历史，未导入内部开发历史。历史验证中的提交/标签标识仅供来源追溯，不保证这些引用存在于本仓库；详见 [发布边界](PUBLICATION.md)。

## 来源与参与

网关基于 [dudu555-djiao/codex-workbuddy-gateway](https://github.com/dudu555-djiao/codex-workbuddy-gateway) 维护；维护者已与上游原作者沟通取得授权。详细来源、私下授权记录的公开边界及当前许可状态见 [AUTHORIZATION.md](AUTHORIZATION.md)。上游署名与现有第三方声明保留。

反馈和提交方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。请勿提交凭据、私密聊天、真实会话数据库、业务日志或个人开发安排。
