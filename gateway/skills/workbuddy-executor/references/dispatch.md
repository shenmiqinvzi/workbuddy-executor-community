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

1. `workbuddy_list_models({"detail":"full"})`：展示实际可用模型、精确 ID 与已知费率，让用户选择本次模型。费用未知明确说明，用户了解后仍可确认；只有主动设置免费限定时才要求精确零费率。以下 `用户选定的精确模型ID` 均为占位符，须替换为实际选择，不能原样执行。
2. 已选择并确认后，向 `workbuddy_send_task` 提交实际文件 scope；先定位需改文件，不能让自然语言约束代替机器范围。原生会话准备在持久容量及文件基线准入后进行。有真实既有 sessionId 时可显式传入，不能编造。

```json
{
  "operationId":"submit-guard-001-send",
  "expectedRevision":null,
  "expectedAttemptId":null,
  "taskId":"submit-guard-001",
  "sessionId":"实际已核验的会话ID",
  "objective":"修复提交按钮的重复提交问题；失败后允许重试。",
  "contract":{
    "schemaVersion":"workbuddy-executor/vnext-1",
    "taskId":"submit-guard-001",
    "workspaceId":"实际已注册的工作区ID",
    "title":"提交防重复",
    "objective":"修复提交按钮的重复提交问题；失败后允许重试。",
    "model":"用户选定的精确模型ID",
    "scope":{"allowedChanges":["src/submit.ts","test/submit.test.ts"],"permittedMetadata":[]},
    "requiredChecks":[
      {"id":"dedup","kind":"semantic","definition":"请求未结束时连续点击仅发一次请求"},
      {"id":"success-retry","kind":"semantic","definition":"成功正常展示，失败后允许再次提交"}
    ],
    "timeoutSeconds":1800,
    "maxAttempts":3
  },
  "detail":"brief"
}
```

本例使用结构化原约定，以便 T6 的语义检查能对应派工前的检查项。workspaceId 必须由已有可信 SDK 初始化的工作区登记取得，不能编造；MCP 当前不开放工作区登记或计划授权写入口。没有登记时先通过受控 SDK 准备原约定。vnext-2 还须沿用实际授权的协作方案。示例没有命令检查要求，不代表可省略项目所需测试；需要程序命令检查时，应在原 requiredChecks 中声明实际命令及输入，精确 JSON CommandSpec 的格式见 [T6](https://github.com/shenmiqinvzi/workbuddy-executor-community/blob/main/docs/T6_INDEPENDENT_REVIEW.md)。

路径、范围与检查定义必须替换为实际约定；只支持精确文件或 directory/**。非契约 send 的 scope 仍受支持，但 acceptanceCommands 属于命令要求，不能用自然语言的“测试通过”替代可匹配的机器记录。原有用户修改即便落在范围内也不能覆盖。给 worker 的回报及停止约定见[执行规范](execution.md)。

## 等待与验收

用 `workbuddy_wait({"taskId":"submit-guard-001","timeoutSeconds":50,"detail":"brief"})` 监督；有新进展时会提前返回。断线后恢复同一 taskId，不重做 ensure_workspace 或 send_task；需要完整报告时 get_task 使用 detail=full。

仅在 needs_review、认证报告及原生停止均明确后核对实际 diff。以下每一步使用独立稳定 operationId、相同当前 attempt 和最新 revision（示例为占位符）：

1. `workbuddy_check_task({taskId,operationId,expectedRevision,expectedAttemptId})`：实际执行程序核验，返回 machineCheckIds 与新 revision。
2. 独立读取实际文件、必要时运行原约定检查。`workbuddy_record_inspection({...版本参数,note,files:["实际绝对路径"]})` 保存明确人工检查记录与文件哈希，取得 evidenceId；它不把 worker 自报转换为独立判断。
3. `workbuddy_review_task` 提交原 semantic 项；各项带 checkId、status、note、evidenceRefs:[evidenceId]，另带 machineCheckIds 和整体 note。取得不可变 reviewId 与落库后 revision。必需项缺失、failed/unknown/checker_error/not_applicable 均不能验收。
4. `workbuddy_accept_task` 使用以下实际返回值：

```json
{
  "operationId":"submit-guard-001-accept-1",
  "expectedRevision":"review_task 返回的实际 revision",
  "expectedAttemptId":"当前实际 attemptId",
  "taskId":"submit-guard-001",
  "reviewId":"review_task 返回的实际 reviewId"
}
```

`workbuddy_get_reviews` 只读持久记录。更正通过新 review 的 supersedesReviewId 保留旧结果；不能人工豁免程序事实。审查后发生源码/证据/轮次变动，旧 review 拒绝最终验收。旧 note/evidence/artifactPaths 参数不再提供最终成功通道。

需要返工时先确认原生停止，再调用 `workbuddy_continue_task`：

```json
{"operationId":"submit-guard-001-rework-1","expectedRevision":"当前任务返回的实际 revision","expectedAttemptId":"当前实际 attemptId","taskId":"submit-guard-001","feedback":"填入实际发现的问题及改好标准","model":"用户选定的精确模型ID","detail":"brief"}
```

OUTCOME_UNKNOWN 保留原操作与名额，调用 `workbuddy_get_operation` 查询原 operationId，不自动重发。示例中的版本占位符必须替换为任务实际值。

返工后重复监督与独立验收；不重发原任务。取消走 cancel_task，并继续确认 remoteStopped。异常处理见 [连接与恢复](setup.md)。
