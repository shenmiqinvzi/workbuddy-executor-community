# workbuddy_get_task_projection

只读查询工具。把已存储的旧记录投影为 TaskView 事实，并返回推导出的显示状态与缺口清单。
**不是**完整 vNext TaskView，也不是实时状态。

## 调用

```
workbuddy_get_task_projection({ taskId: string })
```

仅接收 `taskId`。没有 `detail` 开关：投影始终整体返回，避免展示层过滤把它丢掉。
运行目录由服务自身的 runs 目录 + 已确认的 `attemptId` 决定，调用方不能提供路径。

## 返回结构

成功：

```jsonc
{
  "ok": true,
  "readOnly": true,
  "snapshotOnly": true,
  "task": { "taskId": "...", "attemptId": "run-...", "attempt": 1, "state": "cancelled" },
  "projection": {
    "facts": { /* TaskDisplayFacts */ },
    "displayState": "cancelled",
    "actionFacts": null,
    "allowedActions": ["export"],
    "gaps": [{ "code": "...", "field": "...", "reason": "..." }]
  },
  "runtime": { "packageVersion": "...", "release": "...", "codeHash": "..." }
}
```

`projection` 是适配器的完整结果，`gaps` 原样保留。不补造 `revision`、`reviewId`、
约定版本或源码摘要；`actionFacts` 本轮恒为 `null`，`allowedActions` 恒为 `["export"]`。

失败：

```jsonc
{ "ok": false, "readOnly": true, "snapshotOnly": true,
  "code": "...", "taskId": "...", "attemptId": "run-...|null",
  "field": "state.json", "message": "..." }
```

| code | 含义 |
|---|---|
| `task_not_found` | 存储中没有该 taskId |
| `invalid_attempt_id` | `task.attemptId` 存在但不符合 `RunJournal` 接受的 `^run-[a-f0-9-]{36}$`，或解析后不在 runs 目录内；**不读任何文件**，也不当作"没有当前 attempt" |
| `store_unavailable` | `store.get` / `store.listAttempts` / 末次 `store.get` 抛错；不伪装成 `task_not_found`，错误信息不含数据库内容或本机路径 |
| `read_conflict` | 读取期间当前 attempt 变化（或任务消失），拒绝拼接两轮记录 |
| `state_corrupt` / `cancel_corrupt` | 文件存在但不是 JSON 对象，或**字段类型不符**（见下） |
| `state_unreadable` / `cancel_unreadable` | 非 ENOENT 的读取失败（权限、路径类型等） |

**只有 ENOENT 表示"文件不存在"**，此时不算失败：`state.json` 缺失 → 快照缺失
（`snapshot_missing` 缺口）；`cancel.json` 缺失 → 无取消记录。其他读取失败一律作为结构化
失败返回，不会伪装成"没有数据"。

### 路径构造前校验

`attemptId` 必须同时满足两点才用于构造路径：

1. 匹配 `RunJournal` 的 `^run-[a-f0-9-]{36}$`；
2. `path.resolve(runsDir, attemptId)` 仍位于 `path.resolve(runsDir)` 之内。

`../outside`、`..\outside`、`C:\Windows\...` 等输入直接返回 `invalid_attempt_id`，不读文件。

### 字段运行时校验

`JSON.parse` 之后按字段类型校验，而不是只做类型断言。校验范围是**适配与停止判定实际读取的字段**：
`taskId`、`attemptId`（必填字符串）、`driver`/`sessionId`/`runtimeSource`/`nativeStoppedAt`/
`nativeStopSource`/`stopReason`/`text`/`reportDigest`（可选字符串）、`nativeFailure.observedAt`、
`nativeStopCheck.since|checkedAt|observations`、`stopControl.*`，以及 `cancel.json` 的
`requestedAt`/`reason`。

- 类型不符 → `state_corrupt` / `cancel_corrupt`，`field` 形如 `state.json.nativeStoppedAt`。
- 这防止 `Date.parse` 把数字（如 `0`）隐式转成字符串并**伪造停止证明**。
- **可选字段缺失仍然合法**：旧停止证据可以没有准确时间，不强制补时间。
- 本模块不读取的附加字段不校验、不拒绝。

## 读取来源

| 数据 | 来源 | 说明 |
|---|---|---|
| 任务 | `TaskStore.get(taskId)` | 服务已持有的实例，查询不新建 store |
| 当前轮次 | `TaskStore.listAttempts(taskId)` 中 `attemptId === task.attemptId` 的行 | 只用 `task.attemptId` 选择，不提升历史行 |
| 运行快照 | `<runsDir>/<attemptId>/state.json` | `runsDir` 来自服务配置；路径前先校验 attemptId |
| 取消记录 | `<runsDir>/<attemptId>/cancel.json` | 同上 |

不调用 `coordinator.sync`、`executionStatus`、`checkWorker`、`observeNative` 或任何可能同步、
迁移、派工、写入的入口；不创建目录；不采集实时状态，不传 `liveObservation`。
`store.get` / `store.listAttempts` 的异常在此处被捕获并转为 `store_unavailable`，
不会穿透业务入口。

## 限制

- **非原子读取**：两个文件依次读取，之后重新核对当前 attempt。若已变化则返回 `read_conflict`；
  未变化也不构成强一致保证，只是"同一轮次内读到的两个文件"。
- **不是完整 TaskView**：缺 `revision`、`reviewId`、约定版本、源码摘要与结构化必需检查，
  这些在 `gaps` 中逐项列出。
- **报告认证未知**：有报告只记为 `unknown`，因此 `needs_review` 本轮不可达。
- **无实时状态**：未提供实时观测，`queued`/`running`/`waiting_input` 不会被断言为可信。
- **写操作不开放**：只建议 `export`。

字段级来源与成立条件见 [TASK_VIEW_FACT_MAPPING.md](TASK_VIEW_FACT_MAPPING.md)。
