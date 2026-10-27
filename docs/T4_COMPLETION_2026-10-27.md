# T4 集成交付记录（2026-10-27）

T4A 持久准入与共享容量、T4B 原操作恢复与人工关闭已完成源码阶段验收，并按依赖顺序合入 main。阶段范围分别见 [T4A](T4A_OPERATION_ADMISSION.md) 和 [T4B](T4B_OPERATION_RECOVERY.md)；真实桌面证据边界见 [脱敏验收摘要](T4B_LIVE_ACCEPTANCE_2026-10-27.md)。T5–T7 仍按独立阶段交付。

## 合并记录

| PR | 内容 | main 合并提交 |
|---|---|---|
| [#10](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/10) | T1/T2 只读查询、事件与版本 | 99a3152 |
| [#11](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/11) | 协作设计 | 88bf8b2 |
| [#12](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/12) | 额度缓存及所含 T3a 前序提交 | 315bf5a |
| [#13](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/13) | DSH 适配与用户实际选模 | c77e39f |
| [#14](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/14) | T4A 准入与共享容量 | a2f0ff2 |
| [#15](https://github.com/shenmiqinvzi/workbuddy-executor-community/pull/15) | T4B 恢复、关闭围栏与回报模板修复 | b37e972 |

各 PR 使用已验证的原 head，通过 merge 保留原提交历史；未 squash、重写历史或强推。T4B 完成合并时，main 的 Git 文件树为 `12176a310c843e76d01609c9351ecd68cb1cdd5f`，与已验收候选源码 `0bce733` 完全一致，未引入合并冲突或额外业务变更。本记录及入口文档为随后的纯文档同步，不改变网关源码或产物。

## 验证依据

- T4A 原 head `dc20ab9` 的 [Windows CI](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/runs/40293896501) 成功；T4B `0bce733` 的 [Windows CI](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/runs/40440278476) 同提交第二轮成功：671 项中 664 通过、7 跳过、0 失败。首轮两项 Windows 时序超时保留，未改断言、期限或策略。
- 构建、类型、已提交编译产物一致性、433 文件官方快照、6 份技能副本和 25 步 MCP/HTTP 冒烟已有对应提交证据；独立生产依赖干净检出不 build 直接运行入口通过。
- WorkBuddy 原队列恢复后真实交付、DSH 按时真实交付均记录 accepted；共享容量拒绝、实际确认关闭、失败历史保持及重放围栏有本机证据。
- 合并后的实际 main 提交必须另核对 [Windows gateway 的 main 运行](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/workflows/windows-gateway.yml?query=branch%3Amain)，不把 PR head 的成功冒充合并后 CI。该检查的最终结论以对应 SHA 的运行记录为准。

事务竞争、故障注入、准备阶段关闭、旧 token/attempt 与在途调用围栏的完整矩阵主要是隔离验证，不冒称每项都已真实桌面注入。本机未签名 helper 策略阻碍和 CI 首轮时序超时均保留，不降低系统策略或隐藏失败。

## 完成边界

本次完成的是 T4 的约定源码、验收和仓库集成。恢复后的模型、身份、预算和原期限保持，停止不明或历史缺证仍保守保留占用，这是已交付的拒绝规则。HTTP 保持只读，cancel/respond/reconcile_report/accept 的完整新版操作契约、T5 文件保护、T6 不可变 reviewId、T7 面板与自动策略未借本次合并扩展。

合并不自动发布版本、替换已安装网关或技能，也不新派真实模型请求。第二台 Windows、全部真实 DSH 返工/恢复故障、新监督工具真实到期取消、最终费用与代理物理模型不由本次覆盖。原始私有任务库、会话、凭据和授权聊天均留在仓库外，旧失败不改判。
