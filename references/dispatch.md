# 正常派工示例

首次编写派工约定或不确定工具参数时读取。以下为说明性示例，不代表已派工或已验证；项目路径、任务编号、返回的会话及证据必须替换为真实值。模型政策见 [连接与恢复](setup.md#本机部署与模型政策)。

## 约定

目标：修复提交按钮在请求未结束时可重复提交的问题；失败后允许重试。
范围：提交逻辑及相关测试，WorkBuddy 自行定位入口。
边界：保留已有改动，不调整接口契约；遇到改变功能含义的歧义报告 blocked。
验收：连续点击只产生一次请求；成功后正常展示结果；失败后可再次提交。
验证：最小有效检查，标明源码检查、Mock、本地浏览器或真实环境；记录命令、退出码和证据。
期限：本轮1800秒，以工具返回的绝对期限为准。

## 新任务

1. `workbuddy_list_models({"detail":"full"})`：检查精确 ID `deepseek-v4.1-flash` 和 `credits: x0.00`。缺少任一证据就停止，不能只看名称或 isFree。
2. `workbuddy_ensure_workspace`：

```json
{"workspace":"E:/example/project","workerKey":"submit-guard-001","model":"deepseek-v4.1-flash","detail":"brief"}
```

3. 取真实返回的 workspace/sessionId，调用 `workbuddy_send_task`。下例的 sessionId 只是说明变量，不能原样执行：

```json
{
  "taskId":"submit-guard-001",
  "workspace":"E:/example/project",
  "sessionId":"ensure_workspace 返回的真实 sessionId",
  "model":"deepseek-v4.1-flash",
  "objective":"修复提交按钮的重复提交问题：请求期间连续点击只发一次请求，成功正常展示，失败后允许重试。自行定位提交逻辑并完成相关验证。",
  "constraints":["只修改提交逻辑与相关测试","保留用户已有改动，不调整接口契约","改变功能含义的歧义以 blocked 回报"],
  "acceptanceCommands":["验证请求期间连续点击只产生一次请求","验证成功结果展示及失败后可重试","报告实际检查类型、命令、退出码、证据和遗留问题"],
  "timeoutSeconds":1800,
  "detail":"brief"
}
```

constraints 和 acceptanceCommands 会进入任务说明；后者不会由网关自动执行。给 worker 的常规修错、回报及停止约定见 [执行规范](execution.md)。

## 等待与验收

用 `workbuddy_wait({"taskId":"submit-guard-001","timeoutSeconds":50,"detail":"brief"})` 监督；有新进展时会提前返回。断线后恢复同一 taskId，不重做 ensure_workspace 或 send_task；需要完整报告时 get_task 使用 detail=full。

仅在 needs_review、身份与来源匹配、execution.remoteStopped=true 后检查实际 diff 和相关验证。核对本次改动、验证覆盖及当前源码，不能将此示例中的预期当作证据。检查通过才调用 `workbuddy_accept_task`：

```json
{
  "taskId":"submit-guard-001",
  "note":"实际检查后的验收结论",
  "evidence":["填入实际检查、命令结果或被检查源码与预期的对应关系"],
  "artifactPaths":[],
  "detail":"brief"
}
```

只有真实检查过的成果文件才加入 artifactPaths，路径必须为绝对路径。

需要返工时先确认原生停止，再调用 `workbuddy_continue_task`：

```json
{"taskId":"submit-guard-001","feedback":"填入实际发现的问题及改好标准","model":"deepseek-v4.1-flash","detail":"brief"}
```

返工后重复监督与独立验收；不重发原任务。取消走 cancel_task，并继续确认 remoteStopped。异常处理见 [连接与恢复](setup.md)。
