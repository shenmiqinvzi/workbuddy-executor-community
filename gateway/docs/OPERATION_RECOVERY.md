# 原操作恢复

这是本地人工恢复入口。它不会重发 prompt、切换模型或创建替代会话。先检查原 operationId，保留原 taskId/attemptId 和失败历史。

```powershell
node dist/recovery-cli.js show <原operationId>
node dist/recovery-cli.js observe <原operationId>
node dist/recovery-cli.js reconcile <原operationId> --operation-id <本次稳定恢复ID> --reason "核对原回执的实际依据"
node dist/recovery-cli.js close <原operationId> --operation-id <另一个稳定恢复ID> --reason "人工关闭的实际依据"
```

Windows 也可使用 `bin\workbuddy-recovery.cmd`，参数相同。命令读取本安装的 `.env`，使用原 TaskStore 和 runsDir；不要复制数据库到另一个网关重派。示例中的占位符需替换为实际标识，不是可直接批准的操作。

`show` 只读已有事实。`observe` 显式收集原来源已存在的报告与停止事件，会保存观察结果；不准备模型、派工、唤醒或发出取消。没有原 DSH 连接时明确失败，不改走 WorkBuddy。

`reconcile` 只能用完整原队列请求/回执或原 DSH 请求层证据解除操作阻塞，工作流仍占容量。`close` 需要匹配身份的停止证据；无 attempt 的新准备只有在持久阶段明确证明准备未开始，或准备已完整返回且派工从未进入时，才可关闭。关闭写 cancelled 和单独审计，交付不被接受，也不虚构停止证明。

改变状态前，控制台展示原绑定、依据、原因和影响，要求键入 `动作 原operationId 本次恢复ID`。没有确认、仅回复 yes、管道输入或 `--approved` 都不能批准新动作。确认后版本/证据若已变化，原请求被拒绝，重新查看再决定。相同恢复 ID 可读取原决定；同 ID 改目标、动作或原因会冲突。

原生停止不明、缺失/篡改/半写回执、历史准备缺少阶段证明时，保持原占用并排查原会话；idle、TTL、客户端 stopped/approved 和空文件不是安全依据。不能删除 SQLite 行、换键、换模型或换会话绕过。

MCP 提供 `workbuddy_get_operation_recovery`（只读）和 `workbuddy_observe_operation_recovery`（显式观察），二者均接收原 `operationId`；人工授权与关闭仅由本地控制台或可信应用完成。HTTP 仍保持只读。源码中的可信应用授权方法不是供浏览器传入 approved 标志的接口。

恢复决定包含原操作、task/attempt、证据种类和摘要、原因、人工确认与决定时间、恢复 operationId。原意图和未知结果保留；已处置的不确定原操作返回 OPERATION_RESOLVED 及 recoveryOperationId，不能把它当作重新发送的许可。T4A 已保存的原成功结果仍按原约定重放。

本能力的自动验证使用隔离原生替身。部署、真实模型与真实原生恢复需要另行验收；cancel/respond/reconcile_report/accept 的完整新版操作契约、文件保护、独立 reviewId 和 Web 写操作不由本阶段扩大。
