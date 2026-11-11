# WB09 恢复路径收口：组合回归与对照表

WB09 不新造机制，它要求把已修好的几条恢复路径**一起**跑一遍，确认它们互不拆台：同一副作用最多一次、已停止且关闭的任务释放容量、未知任务保留、list 的 reconciled 只列真实状态变化、brief 不丢结果。

## 1. 恢复路径对照表

| 路径 | 触发 | 准入条件（缺一不可） | 副作用 | 谁证明 | 失败时 |
| --- | --- | --- | --- | --- | --- |
| D-3 账本推进 | 读 list / sync 时发现 queued 而原生已停 | 任务/尝试/会话/工作区身份全等 + 持久停止证据（`nativeStoppedAt` 与来源） | 尝试状态推进为已停止，reconciled 列出该行 | `ledger-advance-and-reclaim.test.ts` F-LEDGER-2/3 | 不推进，读取本身不失败 |
| D-4 stale workerKey 回收 | 准备阶段发现创建中的旧保留 | 保留已过期 + 原生注册表可读且确实未注册 | 原子回收保留，释放同一 workerKey 的映射 | `workspace-worker-reclaim.test.ts` F-WORKER-1/2 | 原保留继续阻塞，绝不新建会话 |
| 准备后未派工关闭 | 原调用挂起、准备完成但未派工 | 准备字段完整 + 无派工证据 + 精确 stop 身份 | 关闭任务、记事件、释放容量 | `t4b-operation-recovery.test.ts` R06/R07/R08/R09 | 保持打开 |
| 不确定尝试的关闭 | 报告存在但停止未证 | 原始 stop 身份（不接受报告自述/超时/唤醒） | 关闭或保持，写审计 | `t4b-operation-recovery.test.ts` R04/R05/R15/R16 | 保持 blocked |
| 取消后同轮次收敛 | cancel 已确认 | task_closed 与容量关闭同轮次证据 | 释放槽位 | `closeout-defects.test.ts`、`finish-acceptance-admission-anomalies.test.ts` | 槽位继续占用 |
| 双进程争用 | 两个真实进程同时恢复 | 不可变恢复决定 + 授权 token 精确绑定 | 只有一个生效 | `t4b-operation-recovery.test.ts` R12（4434ms 实测） | 冲突方报错，不回滚他人结果 |
| 审计失败回滚 | 关闭过程中审计写失败 | 事务性回滚 | 任务、事件、授权使用、容量释放全部回滚 | `t4b-operation-recovery.test.ts` R10 | 保持原状 |

## 2. 本轮组合回归结果

```text
node --import tsx --test test/ledger-advance-integration.test.ts test/ledger-advance-and-reclaim.test.ts \
  test/workspace-worker-reclaim.test.ts test/closeout-defects.test.ts test/t4b-operation-recovery.test.ts
→ tests 47 / pass 47 / fail 0 / skipped 0 / 13.9s
```

覆盖点（逐条对应卡片步骤）：

1. **D-3 只在身份匹配且停止已证时推进**：`F-LEDGER-2 an unconfirmed stop is never advanced`、`the identity gate is consulted before any advance`、`a journal that belongs to another task never proves this task stopped`、`F-LEDGER-3 a run request bound to another session is not stop proof`。
2. **扫描有界、坏记录不拖挂列表**：`the advance honours its time budget`、`a failing advance never fails the read`、`an unreadable run request is not stop proof`。
3. **D-4 stale workerKey 原子回收**：`a stale creating reservation is reclaimed, not re-blocked`、`two writers racing on one stale key produce exactly one new reservation`、`an unreadable native registry never creates a second native session`、`a corrupted native registry is treated as unverifiable, not absent`、`a stale reservation the native app did register is reused, never duplicated`。
4. **取消后 task_closed 与容量关闭同轮次**：`closeout-defects.test.ts` 与 `finish-acceptance-admission-anomalies.test.ts`。准入组另跑一轮：`node --import tsx --test test/t3-admission.test.ts test/t4a-operation-admission.test.ts test/finish-acceptance-admission-anomalies.test.ts` → tests 53 / pass 53 / fail 0 / 98.3s，日志 `E:\javaproject\outputs\executor-plan-20261111\wb09-admission.log`。
5. **rejected / outcome_unknown / stop_unconfirmed 的差异与原操作恢复**：R02/R03/R04/R05/R11/R14/R15/R16/R17 各自断言一种「不能恢复」的形状，`R18` 断言 MCP 入口只提供恢复读取与显式观测、不提供人类决策工具。

## 3. 与 WB03/WB04/WB05/WB06 的交叉点

- **WB03**：恢复路径上的「继续」也要过 CommandSpec 预检，非法追加检查在 `continue` 阶段被拒，`command-spec.test.ts` 断言 store 里 attempt 仍为 1（没有产生新尝试）。
- **WB04**：D-3 的停止证据来自原生观察，`nativeHealth.diagnostics` 让「为什么还没停」可读；归属不明的 pending 不会被当成停止。
- **WB05**：Job supervisor 三阶段预算让「命令执行没起来」与「命令超时」分开报，恢复判断不再把 125 当成统一原因。
- **WB06**：就绪报告带 `observer` 与 `dataRoot`，安装/进程不对时不会给出 ready，也就不会让人在错误的进程上做恢复。

## 4. 未覆盖

- 服务停后用**有证据的** MCP 列表恢复：需要真实常驻服务与真实任务库（WB35），本工作树只跑替身。
- 双进程争用已用两个真实进程覆盖（R12），但仍是本地 SQLite 场景，不是跨机。
