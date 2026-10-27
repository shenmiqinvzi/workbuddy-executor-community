# WorkBuddy Executor

让 Codex 与桌面 WorkBuddy 协作完成本地开发任务：Codex 明确范围、监督并独立验收，WorkBuddy 负责适合委派的实现、测试和资料整理。新增目标是本地多 Agent 协作工作台：接入 DeepSeek Harness（DSH）、按任务选择执行模型、在用户政策内自动制定协作方案，并展示 WorkBuddy2API 提供的用量与额度信息。新增目标部分已实现，源码、真实验收与部署进度分别记录。

当前产品目标仅为 Windows。仓库维护者负责路线、集成与发布，欢迎通过 Issue 提供场景、认领具体任务并提交 PR；任务状态与交付在对应 Issue/PR 中跟踪。

项目正在整理开放协作入口；统一开源许可证尚待明确，来源与授权事实见 [授权和许可说明](AUTHORIZATION.md)。本仓库是面向社区的公开版本。

## 当前能力

- 通过 Windows desktop-queue 连接 WorkBuddy，提供技能、网关源码和验证记录。
- 以稳定任务身份派工、监督、同任务返工及独立验收；相同初始请求复用，冲突请求拒绝。
- 新任务先展示可用模型与已知费用，由用户选择并确认；无固定模型或默认免费要求。可主动设置免费限定，旧任务限制保留，不擅自切换模型。完整面板选择器仍待 T7。
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
| DSH、模型选择、自动协作与额度 | [协作设计](docs/COLLABORATION_DESIGN.md) |
| 服务、状态及指标约定 | [接口契约](docs/INTERFACE_CONTRACT.md) |
| 版本行为验收标准 | [验收场景](docs/ACCEPTANCE.md) |
| 已有修复与验证历史 | [更新记录](CHANGELOG.md) |
| 前端只读模拟原型 | [设计任务书](docs/FRONTEND_TASK_PANEL_DESIGN.md) · [Issue #6](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/6) |

本分支已完成 T1/T2：统一只读任务查询、本地 HTTP、持久事件与 revision；阶段响应为 `workbuddy-executor/stage-2`，完整 vNext 契约仍待实现。接口详情及未知字段见[阶段说明](docs/WORKBENCH_STAGE_HTTP.md)。HTTP 没有派工、取消或验收写入口；export/workspaces 仍为 501。MCP 现有执行与同步入口保持兼容，纯查询不触发派工或同步。

T4A 持久准入/共享容量与 T4B 原操作恢复/人工关闭已随前序依赖合入主干，见[集成交付记录](docs/T4_COMPLETION_2026-10-27.md)。WorkBuddy 原队列恢复和 DSH 正常交付已有本机真实验收，积分链路有真实只读证据。[T5 文件保护](docs/T5_WORKSPACE_PROTECTION.md)源码已实现，新增基线、原有改动保护与共用验收核对，真实补验尚未完成；完整 token 统计、T6 review 和 T7 交互仍待独立交付。源码合并不自动部署，历史样本不替代当前提交验证。前端与异机分别由 Issue #6/#3 跟踪，当前证据见[开发进度](docs/PROGRESS.md)。

## 验证与已知限制

主要验证环境为 Windows，本仓库尚未完成第二台机器的完整恢复安装验证。上游 README 的其他平台或接入路线不等于本分支已支持。旧 MCP 连接可能仍加载旧程序，更新源码后需按部署步骤核对运行哈希。

现有程序约束不构成操作系统文件系统沙箱；范围检查和验证引用都有覆盖边界。原生权限在 WorkBuddy 内处理，正式取消不能作为暂停后继续。

[2026-10-18 对照报告](benchmarks/2026-10-18-luna-workbuddy/REPORT.zh-CN.md)包含六组固定任务：Luna 直接执行最终通过 6/6，监督 WorkBuddy 通过 4/6，取消与超时各一项。样本小，部分计时缺失，token 和完整监督费用未测，不支持总体效率或成本节省结论。历史评测保留原结果，新改进另做对照。

本次社区发布使用经过隐私审查的文件快照建立新的提交历史，未导入内部开发历史。历史验证中的提交/标签标识仅供来源追溯，不保证这些引用存在于本仓库；详见 [发布边界](PUBLICATION.md)。

## 来源与参与

网关基于 [dudu555-djiao/codex-workbuddy-gateway](https://github.com/dudu555-djiao/codex-workbuddy-gateway) 维护；维护者已与上游原作者沟通取得授权。详细来源、私下授权记录的公开边界及当前许可状态见 [AUTHORIZATION.md](AUTHORIZATION.md)。上游署名与现有第三方声明保留。

反馈和提交方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。请勿提交凭据、私密聊天、真实会话数据库、业务日志或个人开发安排。

DSH 受控适配源码与 Windows 桥接的边界、启用和验证见 [T3b 说明](docs/T3B_DSH_ADAPTER.md)；真实模型执行与安装部署须单独验收。
