# 调用事件生产契约（tool_call_finished / local_check_finished）

本文件冻结 `calls` 指标的**生产端**契约。`MetricSummary.calls` 过去结构恒空，因为没有任何代码观察过一次调用结束；本节规定谁在什么条件下允许写一条调用事实、字段如何取值、如何去重，以及哪些边界上根本没有观察者。

接口本身（字段名、枚举、按 channel/outcome 分组、字节分层不相加）由 [INTERFACE_CONTRACT.md](INTERFACE_CONTRACT.md) §6 与 `gateway/src/task-metrics.ts` 决定；本文件不新增字段，只规定**谁来写**。

## 1. 允许写调用事实的唯一来源

一条调用事实必须由本服务在**自己观察到的时点**写入，禁止从以下来源推导：worker 报告文本、模型自述、模板、UI 断言、日志猜测、按时间估算。

允许的两个入口：

| 事件类型 | 生产位置 | 观察到的真实事实 |
| --- | --- | --- |
| `local_check_finished` | `gateway/src/task-reviews.ts`（`TaskReviews.publishCallFact`） | 本服务实际执行的有界命令，或本服务实际执行的一次检查批 `checks()` 中的单个检查 |
| `tool_call_finished` | 执行器适配层（DSH Harness 事件读取端） | Harness 事件流里真实出现的工具调用与其结束状态 |

## 2. payload 字段

```jsonc
{
  "checkId": "test",            // local_check 必填：原契约检查 id
  "kind": "command",            // local_check：provenance|scope|command|semantic
  "checkStatus": "passed",      // 原始检查状态，保留原文不折算
  "channel": "local_check",     // local_check 固定为该值；tool_call 为 mcp|cli|native
  "outcome": "succeeded",       // succeeded|failed|outcome_unknown，缺省视为 outcome_unknown
  "durationSeconds": 1.234,     // 仅在真实测得时出现；不测则不写，不写 0
  "bytes": { "stdout": 24 }     // 仅包含真实测量到的层：stdout|stderr|combined|wire
}
```

规则：

1. 未测得的字段**不出现**，绝不用 0 或估算值填充；消费者把缺失保持为 null。
2. 字节只能来自真实输出文件（`fs.statSync` 的大小），或线上真实计量；不得由字符数×编码宽度推算后冒充测量。
3. `durationSeconds` 只接受有界执行自带的 `durationMs`；`startedAt/endedAt` 缺失时不写时长。
4. `occurredAt` 为检查/调用实际发生时点，`observedAt` 为写入时点；`observedAt < occurredAt` 视为时钟异常，不修正成假顺序。

## 3. 状态到 outcome 的映射（local_check）

| checkStatus | outcome | 说明 |
| --- | --- | --- |
| `passed` | `succeeded` | 命令退出码 0 且清理确认 |
| `failed` | `failed` | 真实非零退出码 |
| `checker_error` | `outcome_unknown` | 清理未确认、监督器未给出结论等：不知道它做了什么，不等于失败 |
| `unknown` | `outcome_unknown` | 证据不足 |
| `not_applicable` | **不写事件** | 检查没有运行，写一条“成功调用”就是发明事实 |

## 4. 去重键（必须稳定）

| 事实 | `sourceRef` |
| --- | --- |
| 一次真实执行的独立命令 | `review-call:command:<commandRecordId>` |
| 一次检查批中的单个检查 | `review-call:batch:<batchId>:<checkId>` |
| 一次 DSH 工具调用 | `tool-call:<executorId>:<attemptId>:<harnessEventSeq>` |

`task_events` 上已有 `source_ref` 唯一索引，重放同一次操作、重复 `sync`、进程重启后的重读都不得产生第二条事实。

已知语义边界（刻意保留）：同一命令在执行时记一条带字节的事实，之后每次 `checks()` 复核各记一条**不带字节**的事实——复核是一次真实检查，但不产生新输出，所以不得重复累加字节。

## 5. 不可观察的边界（必须如实留空）

| 执行器 | 工具调用能否离散观察 | 处理 |
| --- | --- | --- |
| DSH | 能：Harness 事件流含工具调用与结果（`get_task detail=evidence` 的 bounded tool calls/results 同源） | 由 DSH 适配层产出 `tool_call_finished`，channel 记 `native`（原生 Harness 通道），并保留 `harnessEventSeq` |
| WorkBuddy 原生 | 不能：适配层只看到 `hasActiveToolCalls` 布尔（`native-desktop-trigger.ts`），没有调用身份、参数、结果或独立时间 | **不产出** `tool_call_finished`；`calls` 在该执行器上仅覆盖 `local_check`，并在 limitations 中标注 |

`hasActiveToolCalls=true` 不能折算成一次调用；轮询次数不是调用次数。任何“把 busy 轮询当调用计数”的实现都算伪造。

## 6. 验收

- `gateway/test/check-call-events.test.ts`：执行成功命令写一条带真实 stdout 字节与时长的事实；退出码 7 写 `failed`；两次复核不重复计同一命令；`not_applicable` 不写；消费者 `buildTaskMetricSummary().calls` 非空且字节 > 0。
- 回归：`gateway/test/task-reviews.test.ts` 与 `gateway/test/statistics.test.ts` 全通过（新增事实不得改变既有事件语义与验收门槛）。
- 证据分级：本契约的实现属 `source` + `synthetic`（夹具真跑有界命令）。真实 WorkBuddy/DSH 会话上的 `calls` 数字仍属 `window/live`，只有实际派工后才有。
