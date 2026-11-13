# WorkBuddy Executor

让 Codex 与桌面 WorkBuddy 协作完成本地开发任务：Codex 明确范围、监督并独立验收，WorkBuddy 负责适合委派的实现、测试和资料整理。新增目标是本地多 Agent 协作工作台：接入 DeepSeek Harness（DSH）、按任务选择执行模型、在用户政策内自动制定协作方案，并展示 WorkBuddy2API 提供的用量与额度信息。新增目标部分已实现，源码、真实验收与部署进度分别记录。

当前产品目标仅为 Windows。仓库维护者负责路线、集成与发布，欢迎通过 Issue 提供场景、认领具体任务并提交 PR；任务状态与交付在对应 Issue/PR 中跟踪。

项目正在整理开放协作入口；统一开源许可证尚待明确，来源与授权事实见 [授权和许可说明](AUTHORIZATION.md)。本仓库是面向社区的公开版本。

## 当前状态（唯一现状入口）

下面这些文档按日期记录当时的进展；**当前总表只有一处**——[验收矩阵](docs/forward/ACCEPTANCE_MATRIX.md)（53 项，逐项写明判据、可观察子断言、证据维度与下一步）。历史文档保留原文与日期，不再充当当前结论。

| 你需要 | 入口 |
|---|---|
| 53 项验收现状、证据与缺口 | [ACCEPTANCE_MATRIX.md](docs/forward/ACCEPTANCE_MATRIX.md) |
| 本轮交付范围与未覆盖 | [交付报告](docs/forward/DELIVERY_REPORT_20261111.md) |
| 冻结候选与全绿证据 | [WB36 冻结候选](docs/forward/WB36_FREEZE_CANDIDATE.md) |
| 网关 / 桌面 / 技能配对包 | [WB37 配对包](docs/forward/WB37_PAIRED_RELEASE.md) |
| 安装、升级、回退与排障 | [使用与维护手册](docs/forward/WB40_USER_AND_MAINTAINER_MANUAL.md) |
| 本机安装演练与真实窗口证据 | [WB35/WB38](docs/forward/WB35_WB38_INSTALLED_AND_WINDOW.md) |
| 真实原生派工实录（7 次派工 / 失败路径 / 两次 accepted 闭环） | [WB35 live](docs/forward/WB35_LIVE_NATIVE_RUN.md) |
| 自动模式的两层决策 | [ADR-01](docs/forward/ADR-01_AUTOMATION_MODES.md) |
| 资源、用量与统计 | [WB16–WB25](docs/forward/WB16_WB25_RESOURCE_USAGE_STATISTICS.md) |
| 故障与安全边界 | [WB32–WB33](docs/forward/WB32_WB33_FAULT_AND_SECURITY.md) |
| 技能唯一来源与漂移检测 | [WB07](docs/forward/WB07_SKILL_SINGLE_SOURCE.md) |
| 就绪五层与探针来源 | [WB06](docs/forward/WB06_READINESS_FACTS.md) |
| 停止证据与恢复路径 | [WB04](docs/forward/WB04_NATIVE_STOP_OWNERSHIP.md) · [WB09](docs/forward/WB09_RECOVERY_MATRIX.md) |

支持范围：仅 Windows（Node 24+、PowerShell 5.1+；桌面包 `net10.0-windows`，需 .NET 10 Desktop Runtime 与 WebView2 Runtime，未做自包含发布）。以下是**当前**约定，不是待办清单：

- 自动模式只有 `per_task_confirmed` 一层生效；`preauthorized_policy` 仍是提案，启用需用户明确调整规则（见 ADR-01）。
- 费用未知一律保持 `unknown`，不补 0、不把估算当硬上限；每个新任务仍需用户实际选择执行器/来源/模型/档位。
- 停止只认原生停止证据；报告收到、超时、页面空闲都不等于已停止。
- 证据按维度记录，结论只跟随证据：`installed`（多轮安装，以及 drill root 内的升级/回退/卸载演练）、`live`（本轮在 `7d147b2` 构建的 `install-wb41p` 上与真实桌面复核：DSH `fc13b-dsh-calc-001` attempt 1 `accepted`；WorkBuddy `fc13b-wb-calc-003` attempt 1 `needs_review` → 同任务返工 attempt 2 `needs_review` → 独立检查 → `accepted`，两者都有 `task_closed`）、`window`（真实窗口渲染，本机确认窗口完成派工并走到 `accepted`）。`ci` 维度只保留历史记录（`626de4a` 上的 `Forward gate` 与 `Release pairing`），那是当时的 commit，不代表当前工作树；本轮以本机全量 `1618 tests / 1606 pass / 0 fail / 12 skipped` 与 `tsc --noEmit` 代替，不声称 GitHub 流水线已跑。**已知限制**：本 Harness 版本只在打开模型的那个请求发 `request/header`，返工轮没有请求级模型证据，因此 DSH 返工停在不被认证的 `blocked`（不伪造认证）；WorkBuddy 返工正常。`second_machine` 与 `release` 仍缺。验收矩阵按实际维度记 `blocked`/`unknown`/`partial`。
- 配对包未做代码签名，Windows 会提示未签名；签名与第三方声明见 [WB41](docs/forward/WB41_LICENSES_AND_SIGNING.md)。

常见错误与具体操作：

| 现象 | 先做什么 |
|---|---|
| `readiness` 报 `toolResponsive unknown` | 说明观察者没有注入探针（例如从别处读旧摘要）。在 gateway 目录跑 `npm run readiness`，它会拉起短命 MCP 进程真调 `workbuddy_health`。 |
| `candidateDeployed` 报 `another data directory` | 摘要来自另一个数据根，不能证明当前安装；用本安装的配置目录重跑，或删掉那份外来摘要。 |
| `candidateDeployed` 报 `predates dataRoot` | 旧版常驻服务没写绑定字段；重启一次常驻服务即可，不要改摘要文件。 |
| 派工被拒 `COMMAND_SPEC_REQUIRED` | `acceptanceCommands` 元素必须是五键 JSON 文本（executable/args/cwd/timeoutSeconds/inputs），且 `inputs` 非空、`cwd` 在工作区内。 |
| 派工被拒 `ACTION_UNAVAILABLE` | 该状态不允许此操作；错误里已列出当前 `displayState` 与可用操作，按提示先取消或等原生结束。 |
| `ERR_SQLITE_ERROR` 且提示保留任务编号 | 并发写入超出锁等待预算；确认没有第二个进程占用同一数据根，必要时用 `WORKBUDDY_SQLITE_BUSY_TIMEOUT_MS` 放宽（默认 15000）。 |

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
| T7A 真实只读工作台 | [运行与接口说明](docs/T7A_READONLY_WORKBENCH.md) · [设计约定](DESIGN.md) |
| T7B 桌面任务准备与手动派工 | [流程与部署边界](docs/T7B_DESKTOP_DISPATCH.md) |

本分支新增 T7A 真实只读工作台。在 gateway 目录构建后执行 `npm run workbench`，浏览器打开 `http://127.0.0.1:18493/workbench/`；任务、报告、停止、审查与事件来自同源只读接口。演示模式需主动选择并明确标记，连接失败不自动替换真实记录。该面板不派工、取消、返工、验收或批准原生权限，不会自动升级已安装服务。

T7B 在独立桌面外壳中增加任务约定、明确模型选择、原生确认与唯一派工回执。普通浏览器继续只读；派工默认关闭，需核验现代网关部署后显式启用。源码与合成实窗验证不代表个人安装已升级，也不替代真实模型补验。

本分支已完成 T1/T2：统一只读任务查询、本地 HTTP、持久事件与 revision；阶段响应为 `workbuddy-executor/stage-2`，完整 vNext 契约仍待实现。接口详情及未知字段见[阶段说明](docs/WORKBENCH_STAGE_HTTP.md)。HTTP 没有派工、取消或验收写入口；export/workspaces 仍为 501。MCP 现有执行与同步入口保持兼容，纯查询不触发派工或同步。

T4A 持久准入/共享容量与 T4B 原操作恢复/人工关闭已随前序依赖合入主干，见[集成交付记录](docs/T4_COMPLETION_2026-10-27.md)。WorkBuddy 原队列恢复和 DSH 正常交付已有本机真实验收，积分链路有真实只读证据。[T5 文件保护](docs/T5_WORKSPACE_PROTECTION.md)及[T6 独立审查](docs/T6_INDEPENDENT_REVIEW.md)均已交付源码和两端本机关键真实补验；T6 的不可变 review、独立检查及最终接受已随 [PR #17](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/17)合入主干，见[交付记录](docs/T6_COMPLETION_2026-10-29.md)和[脱敏补验摘要](docs/T6_LIVE_ACCEPTANCE_2026-10-28.md)。完整 token 统计、T7 交互和正式发布部署仍待独立交付。源码合并不自动部署，历史样本不替代当前提交验证。前端与异机分别由 Issue #6/#3 跟踪，当前证据见[开发进度](docs/PROGRESS.md)。

## 验证与已知限制

主要验证环境为 Windows，本仓库尚未完成第二台机器的完整恢复安装验证。上游 README 的其他平台或接入路线不等于本分支已支持。旧 MCP 连接可能仍加载旧程序，更新源码后需按部署步骤核对运行哈希。

现有程序约束不构成操作系统文件系统沙箱；范围检查和验证引用都有覆盖边界。原生权限在 WorkBuddy 内处理，正式取消不能作为暂停后继续。

[2026-10-18 对照报告](benchmarks/2026-10-18-luna-workbuddy/REPORT.zh-CN.md)包含六组固定任务：Luna 直接执行最终通过 6/6，监督 WorkBuddy 通过 4/6，取消与超时各一项。样本小，部分计时缺失，token 和完整监督费用未测，不支持总体效率或成本节省结论。历史评测保留原结果，新改进另做对照。

本次社区发布使用经过隐私审查的文件快照建立新的提交历史，未导入内部开发历史。历史验证中的提交/标签标识仅供来源追溯，不保证这些引用存在于本仓库；详见 [发布边界](PUBLICATION.md)。

## 来源与参与

网关基于 [dudu555-djiao/codex-workbuddy-gateway](https://github.com/dudu555-djiao/codex-workbuddy-gateway) 维护；维护者已与上游原作者沟通取得授权。详细来源、私下授权记录的公开边界及当前许可状态见 [AUTHORIZATION.md](AUTHORIZATION.md)。上游署名与现有第三方声明保留。

反馈和提交方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。请勿提交凭据、私密聊天、真实会话数据库、业务日志或个人开发安排。

DSH 受控适配源码与 Windows 桥接的边界、启用和验证见 [T3b 说明](docs/T3B_DSH_ADAPTER.md)；真实模型执行与安装部署须单独验收。

Windows 独立桌面工作台已提供源码与预览包构建入口：`npm run desktop:build` / `npm run desktop`，运行要求及技能自动打开方式见 [桌面工作台说明](gateway/docs/WORKBENCH.md)。正常用户目录中的预览安装已通过原生窗口、同窗口任务定位与关闭清理检查；异机安装仍待验证。
