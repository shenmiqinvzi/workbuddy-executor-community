# 公开路线图

修订日期：2026-10-29。方向：Codex 主导的本地开发协作工作台，可靠执行、可验证交付、可解释调度与可复现安装。首期仅面向 Windows、本地单用户；新增多 Agent 能力仍保持一次一个执行任务，不扩大并发。

当前实现和证据以[开发进度](docs/PROGRESS.md)为准。T1/T2、T3 协作基础及 T4A/T4B 已合入主干；WorkBuddy/DSH 的本机关键真实案例与[完成边界](docs/T4_COMPLETION_2026-10-27.md)分别登记。真实 token 统计、完整自动策略和面板仍待交付；文档和源码更新不自动部署或改变已安装技能的模型政策。

## 阶段与门槛

| 阶段 | 目标与主要交付 | 完成依据 |
|---|---|---|
| T1/T2：已完成源码交付 | stage-2 统一只读查询、本地 HTTP、稳定分页、持久事件和 revision | 对应提交的构建、回归、只读冒烟与干净检出验证；完整 vNext 和部署另验 |
| T3a：基础源码已实现 | 真实队列契约准入、工作区绑定、轮次/期限；vnext-2 版本分派、协作方案、免费模型政策 | 见[T3a 实现范围](docs/T3A_DISPATCH_ADMISSION.md)；合成验证与真实桌面证据分别登记，未部署 |
| T3b：适配源码及关键本机案例已交付 | DSH 适配、精确会话发现、执行模型选择/核验与技能协作入口 | [适配边界](docs/T3B_DSH_ADAPTER.md)与[真实补验](docs/T4B_LIVE_ACCEPTANCE_2026-10-27.md)分开；正常交付/停止/独立验收通过，全部真实返工和故障不由单例代替 |
| T3c：基础源码及积分联调已完成 | token 估算 quota-1、积分缓存 credit-balance-1 的后台采集与只读接口 | [积分链路](docs/T3C_CREDIT_BALANCE.md)已有本机真实只读证据；[token 统计](docs/T3C_QUOTA_OBSERVATION.md)、完整路由和前端仍待验收，不冒充 DSH 独占余额 |
| T4A/T4B：源码验收完成并合入主干 | operationId、旧 revision/attempt 拒绝、方案消费、模型准备、持久意图/回执、共享容量与人工恢复/关闭 | [阶段交付记录](docs/T4_COMPLETION_2026-10-27.md)；受控入口共同遵守容量 1，崩溃与结果不明不重派；HTTP 保持只读 |
| T5：源码与本机真实补验完成 | 派工前文件基线、范围增量、原有改动保护 | [实现与验证边界](docs/T5_WORKSPACE_PROTECTION.md)；Windows 路径/链接/重命名专项验证，[两端本机真实补验](docs/T5_LIVE_ACCEPTANCE_2026-10-27.md)已 accepted；仓库集成见[T5 交付记录](docs/T5_COMPLETION_2026-10-28.md)，正式部署另验，不宣称完整 OS 沙箱 |
| T6：源码合并与两端本机关键补验完成 | 独立检查、不可变 reviewId 与最终验收 | [交付记录](docs/T6_COMPLETION_2026-10-29.md)及[真实补验](docs/T6_LIVE_ACCEPTANCE_2026-10-28.md)；两端 accepted/关闭，代理失败与检查器错误保留，正式部署及异机另验 |
| T7 | 手动/推荐/自动模式、真实面板、可复算指标、单任务归因与发布 | 对应约束验收后逐项开放写操作；费用未知如实保留；真实原生与异机记录分开 |

完整依据为[总体设计](docs/DEVELOPMENT_DESIGN.md)、[协作设计](docs/COLLABORATION_DESIGN.md)、[接口](docs/INTERFACE_CONTRACT.md)和[验收](docs/ACCEPTANCE.md)。T3a–T3c 按独立结果逐项集成，内部受控派工验证不等于 HTTP 写入口可以上线；新增写入口须经过关口 B 的停止、费用、预算、排他、范围与验收审查。

## 配套任务与优先级

- P0：执行器/宿主兼容诊断、真实模型与会话绑定、方案授权审计、两执行器防重复、额度故障隔离、凭据边界与历史 schema 兼容。
- P1：完整请求归因后单任务计量、项目级方案模板、人工待处理/通知、脱敏故障导出与带样本量的质量统计；不以余额差估算精确任务成本。
- 后续单列：跨执行器交接、安全并行、独立 worktree 与合并冲突。云端团队、多租户和账号托管不纳入首期。

前端原型继续按[原设计任务书](docs/FRONTEND_TASK_PANEL_DESIGN.md)与[Issue #6](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/6)的只读边界交付；新增协作和额度场景单独分期，不把 mock 完成写成真实联调。

完整第二台 Windows 验收由[Issue #3](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/3)跟踪。安装/重复安装、领取后取消停止、执行中重连、升级卸载和登录自启需对应当前运行版本的真实证据。CI 通过不替代物理机器和原生执行验证。

维护者结合 Issue/PR 决定集成顺序；每阶段保存提交、命令、结果和未覆盖项，不登记个人工时或内部排期。仓库、已安装技能和运行服务分别管理，推送或合并不自动部署。
