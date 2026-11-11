# WB04 原生停止归属：事件能力、过滤实现与最小桥接契约

本文件回答一个问题：**旧轮次残留的 pending 工具调用，凭什么判定它已经结束；判不了的时候又凭什么继续阻塞。**

## 1. 原生事件能力（实测可得，脱敏）

| 来源 | 字段 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| `daemon:getActiveSessions` | `sessionId`/`id`、`cwd` | 该会话此刻是否被 daemon 认为是活跃会话 | 当前轮次是否还有工具在跑 |
| `session:get` | `cwd`、`status`、`isProcessing`、`stopRequested`、`lastBackendActivityAt` | 会话整体状态与最近活动时间 | 单次工具调用是否终结 |
| `session:get` → `eventHistory[].update` | `sessionUpdate ∈ {tool_call, tool_call_update}`、`toolCallId`、`status`、`_meta` | 每个工具调用最后一次已知状态 | 没有 `_meta` 时，无法区分「同一调用的迟到参数」与「新的调用」 |
| `_meta` | `codebuddy.ai/messageRequestId`、`codebuddy.ai/requestId`、`codebuddy.ai/toolName`、`codebuddy.ai/conversationRequestId`、`codebuddy.ai/modelRequestId`、`codebuddy.ai/toolArgumentsComplete`、`codebuddy.ai{mode:"history",offset}` | 归属：这条 pending 属于哪次 wake、哪个工具、哪个请求 | 归属之外的「这一轮有没有真的结束」 |
| `teamRuntime` | `hasActiveMembers`、`teamActive`、`teamTrulyIdle` | 是否还有子代理/团队成员在工作 | 单个工具调用的终态 |
| 后台任务标志 | `hasRunningBackgroundTasks`、`hasActiveChildAgents` | 是否还有跨轮次的后台后代 | 它们属于哪一次 wake |
| wake 标记 | 用户消息事件（`session:event:<sid>` 的 `user_message_chunk` 等）产生的 wake id | 本次派工是否被原生接受 | 会话是否空闲 |

结论：**只有「同一 invocation 的终态结果」这一种证据能关闭一条 pending**。会话 `status` 是终态、`hasActiveToolCalls=false`、一段时间没有活动、面板显示停，都不是停止证据。

## 2. 过滤实现（`gateway/src/native-desktop-trigger.ts` 的 `inspect`）

1. 按 `eventHistory` 顺序重建 `toolCallId → {status, meta}`。
2. 当事件是 `tool_call` + `status=pending` + `_meta["codebuddy.ai/toolArgumentsComplete"]===true`，且此前同一 `toolCallId` 已是 `completed|failed|cancelled`，且**归属完全一致**时，丢弃这条迟到重放。
3. 归属一致的判据（缺一不可）：
   - `codebuddy.ai/messageRequestId` 相同且非空；**或**两边都没有该键、都是 `codebuddy.ai.mode==="history"` 且 `offset` 为数字、`codebuddy.ai/requestId` 相同（持久化历史不带 wake 元数据的情形）；
   - `codebuddy.ai/toolName`、`codebuddy.ai/conversationRequestId`、`codebuddy.ai/modelRequestId` 全部相同。
4. 其余 pending 一律保留，`unfinishedTools` 置真。
5. `busyFlags` 十个信号任一为真即 `busy`，并在 `diagnostics` 里列 `stillBusy`、`pendingToolCalls`（≤10）、`observedAt`、`requiredUpstreamEvidence`。
6. 只有 `stillBusy` 为空且 `session.status ∈ {completed, failed, cancelled, idle, stopped, pending, terminated}` 才返回 `idle`。

`diagnostics` 经 `run-journal` 落进 `execution.nativeHealth`（`desktop-queue.ts` 15s 去重写入，`coordinator.ts` 读出），所以卡住的运维者能看到是哪个 flag 卡住，而不是只看到「一直忙」。

## 3. 四类样本（表驱动测试）

`gateway/test/native-desktop-trigger.test.ts` 的 `the four ownership samples close only work a terminal result binds`：

| 样本 | 事件/标志 | 期望 | 断言 |
| --- | --- | --- | --- |
| 旧轮次 pending 重放 | 同 invocation 的 `failed` 终态 + 迟到 `pending`（`toolArgumentsComplete:true`） | `idle` | 不误判忙、不发新请求 |
| 当前 pending | 无终态的 `pending` | `busy` | `stillBusy` 含 `unfinishedTools`，`pendingToolCalls` 列出它 |
| 跨轮后台后代 | `hasRunningBackgroundTasks`、`hasActiveChildAgents` | `busy` | 命名 `hasRunningBackgroundTasks` |
| 同会话用户新工作 | 用户新 wake 的 `in_progress` + `isProcessing` | `busy` | 命名 `isProcessing`；三类忙态都拒绝 `wakeIdle` |

负数样本（乱序/重放/归属不明）在 `late argument filtering requires exact invocation identity and keeps real activity busy` 与 `persisted argument replay requires history markers and matching request identity`：分别篡改 `messageRequestId`、`requestId`、`mode`、`offset`、`toolName`、`conversationRequestId`、`modelRequestId` 的任一项，都必须回到 `busy`。

停止安全约束的既有回归：`t7d-native-stop-declaration.test.ts`（4 例，声明不能替代证据、弱证据保留）、`native-turn-failure.test.ts`（3 例，失败只归因到精确 wake）、`native-failure-diagnostic.test.ts`（3 例，429 不编造重试时间）、`native-health-diagnostics.test.ts`（F-DIAG-1，诊断进入执行视图）。本轮没有删除或降低其中任何一条，也没有引入超时忽略 pending 的路径。

## 4. 最小桥接改造契约（上游待办，缺陷仍然阻塞）

现协议能提供归属（wake/request 身份）与单次调用的终态，但**不能**给出「这一轮整体已结束」的独立信号。若上游要一次性解决残留 pending，最小改动是增加一个可归属的 turn 终态事件：

```jsonc
// session:event:<sessionId> 上新增（名称可议，语义固定）
{
  "sessionId": "<sid>",
  "update": {
    "sessionUpdate": "turn_end",            // 新类型
    "turnId": "<原生 turn 身份>",
    "wakeId": "<本次派工的 wake id>",        // 与 user_message_chunk 产生的 wake 对应
    "messageRequestId": "<同 tool_call 的 codebuddy.ai/messageRequestId>",
    "status": "completed" | "failed" | "cancelled",
    "seq": 12345,                            // 单调递增，供乱序判定
    "at": "2026-11-11T00:00:00.000Z"
  }
}
```

验收条件：`turn_end` 的 `wakeId`+`messageRequestId` 与残留 pending 的 `_meta` 一致且 `seq` 晚于该 pending 时，才允许把它并入该 turn 的终态；没有该事件时行为保持现状（busy）。在拿到该事件之前，本任务的真实验收保持 `blocked_external`，**不启用**任何超时忽略或人工放行开关。

## 5. 证据与未覆盖

- 源码：`native-desktop-trigger.ts`（过滤与诊断）、`run-journal.ts`（`nativeHealth.diagnostics`）、`desktop-queue.ts`（15s 去重写入）、`coordinator.ts`（读取透出）。
- 测试：`node --import tsx --test test/native-desktop-trigger.test.ts` → 44 例、38 通过、6 跳过（macOS 生命周期夹具在 win32 跳过），0 失败。
- 未覆盖：真实会话自然结束后核对 `nativeStoppedAt` 与 `nativeStopSource` 需要一台能跑真实 WorkBuddy 会话的机器（WB35/WB39），本次只有替身与固定样本。
