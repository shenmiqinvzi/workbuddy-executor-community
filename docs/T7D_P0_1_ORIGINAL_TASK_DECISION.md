# T7D P0-1 原任务裁决记录（2026-11-01 真实补验）

- 状态：**已按“证据充分、仍不确定”收口**（用户 2026-11-02 明确选择该方案）
- 适用对象：2026-11-01 真实模型补验产生的 `outcome_unknown` 操作
- 本记录裁决的是“如何处理这条旧操作”，**不是**验收结论，**不是**重派授权，也**不改变** T7D 的交付门槛

## 1. 决定

1. 认定原任务的副作用**不可排除**，按“证据已充分、结论仍不确定”收口。
2. 执行容量**继续由原任务保留**，不释放。
3. 原任务**不关闭、不重派、不换身份、不换库、不删除或改写记录**。
4. 本次收口**不改变** T7D 验收条件；后续真实补验另走 P0-5 并单独授权。

## 2. 原任务身份（只读记录，逐字保留）

| 项 | 值 |
|---|---|
| 原操作 | `desktop-send-b58168ae-b46f-4116-b84c-d398f95f84f9` |
| 原状态 | `outcome_unknown` |
| 容量占用者 | `desktop-e083a31e-beba-46d1-82a3-e05d20933f6f` |
| 原预留会话 | `33216aa9-04b0-4bb7-bdd3-750f5bcfb069` |
| 执行轮次（attempt） | 无记录 |
| 进入准备 | 有（`preparationEnteredAt` 已写） |
| 准备完成回执 | 无记录 |
| 进入派工 | 无记录 |
| 恢复审计 | 无 |

来源：`docs/T7D_PREPARATION_RECOVERY_EVIDENCE.md` 第 21 行（2026-11-01 只读检查）。

## 3. 判断依据

### 3.1 已存证据：足以认定“不能排除副作用”

- 该操作已进入准备阶段，但既无“准备完成”回执，也无“派工进入”记录——准备与派工之间的窗口没有闭合证据。
- 设计边界（同文件第 7、9、13、15 行）明确：原生调用的异常或超时**并不证明请求未到达**；进程中断可能发生在发送、创建与写回之间；worker 的 uncertain、历史缺失会话、空闲、文件不变与时间流逝均**不能**证明没有迟到副作用；原生库只存会话记录，缺失行不能推断请求已终结。
- 既有诊断显示 Sidecar 启动超时后**迟到**——即“超时”在本环境已被实际观察为会迟到，不能当作未发生的证据。

### 3.2 本机现场：无法进一步取证（2026-11-02 12:58 复核）

- 默认任务库 `<repo>\gateway\data\platform\workbuddy.db`：源仓库与隔离副本**均不存在**。
- `%LOCALAPPDATA%\WorkBuddyWorkbench`：不存在。
- `AGENT_HUB_STATE_DIR`、`WORKBUDDY_DESKTOP_STATE_DIR`、`WORKBUDDY_DB_FILE`：均为空。
- 本机唯一活跃库 `C:\Users\<user>\.workbuddy-ai\workbuddy.db`（233472 字节，2026-11-02 12:58:03 仍在写，含 `-wal`/`-shm`）是 **WorkBuddy 客户端库**：12 张表（`sessions`、`session_usage`、`automations`、`workspaces`、`workspace_trust_decisions`、`buddy_snapshots` 等），**没有** `task_operations`，也**没有** `desktop_dispatch_requests`。
- 结论：产生该操作的那份网关任务库不在本机现行布局里。`gateway\bin\workbuddy-recovery.cmd` 的 `show`/`observe` 当前**没有库可读**，进一步取证缺少对象。

### 3.3 推论

“取不到证”不等于“没有副作用”。按项目规则（证据不足时继续阻塞、人工判断不能替代证据），结论只能停在**不可排除**。

## 4. 不变项（后续任何轮次都适用）

- 不释放 `workflow_capacity` 中该任务占用的唯一槽位（`slot=1`）。
- 不改 `task_operations` 中该操作的 `state`；不补写 `preparationCompletedAt` / `dispatchEnteredAt`。
- 不删除、不重建、不迁移任务库；不换库或换身份重派。
- 不把该操作改写成 `rejected` / `succeeded` 之类的“干净结局”。
- 不以新任务的报告、停止或验收冒充该任务的结论。

## 5. 现在允许的动作（只读）

在**确实拥有该任务库**的机器上：

```powershell
gateway\bin\workbuddy-recovery.cmd show   desktop-send-b58168ae-b46f-4116-b84c-d398f95f84f9
gateway\bin\workbuddy-recovery.cmd observe desktop-send-b58168ae-b46f-4116-b84c-d398f95f84f9
```

- 两者都只读；`reconcile` / `close` 需要交互式逐字确认，**本记录不授权**。
- 桌面壳内的等价只读入口是 `recovery_show`（T7D P0-2 的 D2 交付），只显示已存事实，不产生动作。

## 6. 什么情况会改判（复核条件）

出现下列任一，且来源可核验，才重新裁决；否则保持本记录：

1. 找到 2026-11-01 那次补验所用的网关任务库（含 `task_operations` 与 `desktop_dispatch_requests`），并能只读复核该 `operationId`；
2. 该库出现与该 `operationId` 匹配的派工回执、attempt 记录或恢复审计；
3. 出现可信原生端的创建请求终态（见设计文档第 11–17 行的未来协议），能证明“明确未创建”或“已创建且相关副作用已终结”；
4. 用户显式改变验收条件（须单独记录，不能由本文件推断）。

## 7. 本记录不主张什么

- 不主张原任务“没有产生副作用”。
- 不主张原任务已完成、已停止或已验收。
- 不主张该 `operationId` 现在可以关闭（`close` 是独立人工决定，需匹配证据）。
- 不主张该容量可以复用给新任务。

## 8. 与其它文档的关系

- 设计边界与未来协议：[T7D_PREPARATION_RECOVERY_EVIDENCE.md](T7D_PREPARATION_RECOVERY_EVIDENCE.md)
- P0 计划与验收：[T7D_DEVELOPMENT_PLAN.md](T7D_DEVELOPMENT_PLAN.md)（P0-1、P0-2、P0-5）
- 不确定状态围栏实现与证据：[T7D_P0_2_UNCERTAINTY_FENCE.md](T7D_P0_2_UNCERTAINTY_FENCE.md)
- 现状陈述：[PROGRESS.md](PROGRESS.md)、[ROADMAP.md](../ROADMAP.md)

## 9. 变更历史

- **2026-11-01**：只读检查，记录原操作 `outcome_unknown`、无 attempt、无准备完成与派工记录、容量仍占用（来源：恢复证据文档第 21 行）。
- **2026-11-02 12:58**：本机复核——默认任务库在两个仓库布局下均不存在，唯一活跃库为客户端库且无 `task_operations`。
- **2026-11-02**：用户选择“按证据充分收口”，本记录成文；未执行任何写入、关闭、重派或容量变更。
