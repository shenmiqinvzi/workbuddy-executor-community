# WB32 / WB33 异常矩阵与安全边界验收（源码级）

日期：2026-11-11。工作树 `E:/javaproject/workbuddy-forward-20261107/R-executor-plan-20261111`。

范围声明：本文件只记录**替身与夹具**证据。真实 SQLite 多进程、真实原生会话、真实安装后的窗口与网络捕获不在本轮，逐项在「未覆盖」中单列，不被替身结果覆盖。

## 运行证据

```
node --import tsx --test <10 个故障/恢复/停止文件>   tests 145 / pass 145 / fail 0 / 67597ms
node --import tsx --test <5 个路径/HTTP/资源文件>    tests  63 / pass  63 / fail 0 / 19205ms
```
日志：`E:\javaproject\outputs\executor-plan-20261111\wb32-fault-matrix.log`、`wb33-security.log`。

## WB32 异常矩阵

| 场景 | 不变量 | 证据 |
| --- | --- | --- |
| V02 原生输入等待，详情可用/未知 | 显示处理位置或未知，不代批、不重派、不延长期限 | `native-desktop-trigger.test.ts`（busy 命名信号 + 四类归属样本）、`native-health-diagnostics.test.ts` |
| V03 报告先到、原生仍忙 | 等待停止；accept/rework/新派工被程序拒绝 | `t7d-native-stop-declaration.test.ts`「a declaration is refused when the run already proves the stop, is still active, or the statement is too thin」、`finish-acceptance-review-layers.test.ts` |
| V04 已取消、停止不明或忙碌会话 | 不恢复已取消任务、不误停其他会话、不释放不确定容量 | `native-turn-failure.test.ts`、`t7d-native-stop-declaration.test.ts`、`capacity-resource.test.ts` |
| V05 截止后恢复与迟到报告 | 原期限与终态保留，迟到报告不可验收，发生与观察时间分开 | `finish-acceptance-admission-anomalies.test.ts`、`t4b-operation-recovery.test.ts` |
| V06 同键重试、不同约定、双进程 | 原生只派一次；冲突可解释；结果不明不换键重派 | `t3-admission.test.ts`、`t4a-operation-admission.test.ts`（`TASK_CONFLICT`）、`automation-dispatch.test.ts`「two processes racing one decision produce a single dispatch」 |
| V07 越界、额外 metadata、用户旧修改 | 越界操作被拒；已观测的原生越界交付不可验收；不吞旧改动 | `workspace-protection.test.ts`、`finish-acceptance-resource-independence.test.ts` |
| V08 检查后源码改变或旧轮次验收 | `EVIDENCE_STALE`/`STALE_ATTEMPT`，无虚假通过 | `evidence-consistency.test.ts`、`report-authentication.test.ts`、`workspace-protection.test.ts` |
| V09 内容正确、形式不同 | 按语义审查；`checker_error` 不归 worker 内容失败 | `finish-acceptance-review-layers.test.ts`、`statistics.test.ts` |
| V10 三轮耗尽、模型缺失、违规免费限定 | 无第四次派发、无擅自换模型、无 UI 绕过；费用未知 ≠ 模型身份未知 | `recommendation.test.ts`（`an unavailable user choice waits…`）、`task-contract` 的 `effectiveMaxAttempts`、`automation-policy.test.ts` |
| C07 跨执行器双进程与结果不明 | 容量 1；意图/回执重启保留；旧任务未知不新派、不按 TTL 释放、不换执行器绕过 | `capacity-resource.test.ts`、`preparation-protocol.test.ts`、`closeout-defects.test.ts`、`persistent-service.test.ts` |
| C16 schema 与历史升级 | `vnext-1` 摘要/幂等不变；旧解析器拒绝新版；迁移回滚有证据；不造值 | `task-contract` 版本分派 + `persistent-service.test.ts`、`backend-integration.test.ts` |
| C17 切换执行器意图/范围/旧验收 | 首期拒绝 task 内换执行器/模型；旧证据不可验收；保护规则两执行器一致 | `t3-admission.test.ts`、`t4a-operation-admission.test.ts`、`workspace-protection.test.ts` |

准备前/副作用后回执前崩溃：`preparation-protocol.test.ts` 覆盖原生边界前后的中断（准备失败不派工、派工后崩溃转原 operation 观察）。

## WB33 路径、隐私与内容安全

| 类别 | 事实 | 证据 |
| --- | --- | --- |
| Windows 路径形态 | 中文、空格、大小写、短名（8.3）、UNC、绝对路径、`..`、junction 与 symlink 都按**真实文件**归一并比对 | `workspace-protection.test.ts`（含「T5 Windows short-name workspace inputs expand to the same real file」） |
| 越界拒绝 | 范围外写入、额外 metadata、删除/重命名都在准入与验收两层被拒 | `workspace-protection.test.ts`、`finish-acceptance-resource-independence.test.ts` |
| 用户既有改动 | dirty/staged/untracked 与最小 metadata 被保留；git 读取超时不再误报（预算 30s，可 `WORKBUDDY_GIT_READ_TIMEOUT_MS` 覆盖） | 同上（本轮 WB05/WB06 修复） |
| HTTP 表面 | 仅回环、校验 Host/Origin/授权；GET 无副作用；固定来源连接 | `workbench-http.test.ts`、`productivity-http.test.ts`、`resource-trust-http.test.ts`、`automation-http.test.ts`（写路由一律 405） |
| 资源隐私 | 凭据以变量名引用；快照拒绝凭据形状键/值；页面只拿脱敏快照 | `resource-snapshot-store.test.ts`、`desktop-readonly-resources.test.ts` |
| 注入呈现 | HTML/脚本/命令/path 字符串在报告、错误、资源与导出中只作文字呈现 | `workbench/test/*`（mini-DOM 文本断言）、`delivery-export.test.ts`（Unicode/URL/JWT/PEM/嵌套秘密） |
| 不宣称 OS 沙箱 | 保护是“本程序作用域 + 观测到的原生交付”两段式，不冒充文件系统隔离 | `workspace-protection.ts` 头注释与 `docs/forward/WB09_RECOVERY_MATRIX.md` |

## 未覆盖（外部条件）

- 真实 SQLite 多进程争用与真实进程崩溃注入（本轮只有替身与临时库）。
- 真实原生会话的“报告先到、仍忙”“迟到报告”“停止不明”。
- 实际安装后的窗口网络捕获与 DOM 内容安全实测（归 WB35）。
- 截图/日志/发行包的秘密扫描属 WB33 第 5 步的产物侧检查，需在 WB37 打包后执行，本轮未做。
