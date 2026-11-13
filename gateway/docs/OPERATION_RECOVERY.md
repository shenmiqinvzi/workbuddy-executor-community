# 原操作恢复

这是本地人工恢复入口。它不会重发 prompt、切换模型或创建替代会话。先检查原 operationId，保留原 taskId/attemptId 和失败历史。

```powershell
node dist/recovery-cli.js show <原operationId>
node dist/recovery-cli.js observe <原operationId>
node dist/recovery-cli.js reconcile <原operationId> --operation-id <本次稳定恢复ID> --reason "核对原回执的实际依据"
node dist/recovery-cli.js close <原operationId> --operation-id <另一个稳定恢复ID> --reason "人工关闭的实际依据"
```

Windows 也可使用 `bin\workbuddy-recovery.cmd`，参数相同。命令读取本安装的 `.env`，使用原 TaskStore 和 runsDir；不要复制数据库到另一个网关重派。示例中的占位符需替换为实际标识，不是可直接批准的操作。

`show` 只读已有事实。`observe` 显式收集原来源已存在的报告与停止事件，会保存观察结果；不准备模型、派工、唤醒或发出取消。没有原 DSH 连接时明确失败，不改走 WorkBuddy。对一个没有 attempt 的准备中断，`observe` 还会只读核对 `preparation.reservedSessionId` 在 WorkBuddy 原生历史里的状态并写入 `preparation.observation`；这一步同样不创建、不唤醒、不发消息。

`show` 的 `preparation` 展示网关已记录的阶段时间、预留会话和最近一次观察；`incomplete` 表示记录了进入准备但没有完整返回。缺失标记、没有 attempt 或这个诊断字段本身都不能证明原生调用已停止或没有副作用，也不会增加可用恢复动作。历史操作的 `phaseRecorded: false` 表示缺少新阶段格式，不能把空值当作未执行证明。

观察结果只有三种：`registered`（预留会话确实存在，从未向它派发提示词）、`absent`（正是那个预留会话不存在）、`unverifiable`（桌面历史读不到，什么都不能推断）。前两种各支持一种关闭依据：`registered` 用 `not_dispatched`，`absent` 用 `preparation_failed`；`unverifiable` 不提供任何关闭依据，修好桌面目录后用同一 operationId 再观察。

`reconcile` 只能用完整原队列请求/回执或原 DSH 请求层证据解除操作阻塞，工作流仍占容量。`close` 需要匹配身份的停止证据；无 attempt 的新准备只有在持久阶段明确证明准备未开始、准备已完整返回且派工从未进入，或预留会话经观察为 `registered`/`absent` 时，才可关闭。关闭写 cancelled 和单独审计，交付不被接受，也不虚构停止证明。

改变状态前，控制台展示原绑定、依据、原因和影响，要求键入 `动作 原operationId 本次恢复ID`。没有确认、仅回复 yes、管道输入或 `--approved` 都不能批准新动作。确认后版本/证据若已变化，原请求被拒绝，重新查看再决定。相同恢复 ID 可读取原决定；同 ID 改目标、动作或原因会冲突。

原生停止不明、缺失/篡改/半写回执、历史准备缺少阶段证明时，保持原占用并排查原会话；idle、TTL、客户端 stopped/approved 和空文件不是安全依据。不能删除 SQLite 行、换键、换模型或换会话绕过。

客户端等超时不等于操作被取消，也不等于没产生原生效果。`scripts/workbuddy-call.mjs` 的等待由 `WORKBUDDY_MCP_CLIENT_TIMEOUT_MS`（默认 900000 毫秒）决定；`WORKBUDDY_REQUEST_TIMEOUT_MS`（默认 30000）只约束网关自己的下游请求。调大后者不会延长前者。等超时后按上面的 `show` → `observe` → `close` 顺序收尾，不要为拿到"第二个会话"而重派同一 taskId。

配置类拒绝不进入这里：当 `data/persistent-service.json` 的原生目录与进程的 `WORKBUDDY_CONFIG_DIR` 不一致、该目录读不到原生历史、或历史里没有这个会话时，返工/派工在创建 attempt 之前就以 `BRIDGE_CONFIG_MISMATCH`、`BRIDGE_HISTORY_UNREADABLE` 或 `BRIDGE_SESSION_ABSENT` 失败，既不写新的派工边界，也不产生需要这里关闭的操作；按错误里给出的路径改好配置，用新的 operationId 重试同一任务即可（详见 INSTALL_WINDOWS.md 第 2 节）。

MCP 提供 `workbuddy_get_operation_recovery`（只读）和 `workbuddy_observe_operation_recovery`（显式观察），二者均接收原 `operationId`；人工授权与关闭仅由本地控制台或可信应用完成。HTTP 仍保持只读。源码中的可信应用授权方法不是供浏览器传入 approved 标志的接口。

恢复决定包含原操作、task/attempt、证据种类和摘要、原因、人工确认与决定时间、恢复 operationId。原意图和未知结果保留；已处置的不确定原操作返回 OPERATION_RESOLVED 及 recoveryOperationId，不能把它当作重新发送的许可。T4A 已保存的原成功结果仍按原约定重放。

本能力的自动验证使用隔离原生替身。另行获批的本机候选已验证 WorkBuddy 原队列恢复后交付、DSH 正常交付、共享容量拒绝及人工关闭，见[脱敏摘要](../../docs/T4B_LIVE_ACCEPTANCE_2026-10-27.md)；不代表所有真实故障、正式发布或异机验收通过。cancel/respond/reconcile_report/accept 的完整新版操作契约、文件保护、独立 reviewId 和 Web 写操作不由本阶段扩大。
