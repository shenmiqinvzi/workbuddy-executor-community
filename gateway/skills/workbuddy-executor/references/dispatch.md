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

## 指定 DSH 执行器

Codex 可以把任务摊派给 DeepSeek Harness，但要走三步，缺一步就会被拒。

1. 确认能接：`workbuddy_list_executors` 看到 `dsh.reason = "ready"`，再用 `workbuddy_list_dsh_sessions({"workspace":"项目的绝对路径"})` 拿到 `matched` 的真实 sessionId。`ambiguous` 让用户指定，`no_matching_live_session` 就是该项目现在没有活着的会话，不要自己造一个。
2. 起草 vnext-2 提案并让用户确认模型：`execution` 里 `executorId: "dsh"`、`connectionId` 用 `hosts[].hostId` 的实际值、`providerId`/`modelId`/`reasoningEffort` 必须是该 host 目录里真实存在的组合（`workbuddy_list_executors` 不报费率，费用仍要单独确认）。
3. 由本机操作者授权计划，再派工：把提案写成文件后运行（`scripts/plan.mjs` 随网关发布包提供，路径是网关安装目录下的 `scripts/plan.mjs`；只安装了技能说明的话，用它指向你实际安装的网关目录）

```
node scripts/plan.mjs create --contract @proposal.json --reason "用户在本轮对话里确认的模型与范围"
node scripts/plan.mjs authorize <返回的 planId> <返回的 revision> --source "user-confirmed-in-chat"
```

然后把返回的 `planId` 与 `revision` 填进契约的 `collaboration: {planId, expectedPlanRevision}`，用 `workbuddy_send_task` 提交：`sessionId` 取第 1 步的真实值，`objective` 与契约一致，且不要再传 `model`/`scope`/`constraints`/`acceptanceCommands`/`timeoutSeconds`（DSH 判 TASK_CONFLICT）。计划是修订绑定的：`revision` 变了、提案条款变了或计划过期，都会 PLAN_STALE，重新走第 3 步。

授权不是工具能力。agent 可以起草提案和参数，但不能自己创建或授权计划，也不能用非契约派工绕过去；用户没确认模型时停在准备阶段。计划只授权一次派工，`consumedBy` 记录它绑定的 taskId。

## 推荐与排除原因

“新建任务”里的“评估选择”给出可审计的解释，不调用模型、不准备原生会话、不建 attempt。口径是：只依据这次填的约定、当前目录快照、当前与原任务政策、以及已保存的统计；不为凑推荐去扫项目、不另调计费模型、不编造质量分。

输出（`workbuddy-executor/recommendation-1`）的关键字段：

```json
{
  "schemaVersion":"workbuddy-executor/recommendation-1",
  "explanationVersion":1,
  "readOnly":true,
  "generatedAt":"2026-11-05T12:00:00.000Z",
  "decision":"delegate",
  "mode":"recommend",
  "authorization":{"state":"none","requires":["preview","confirmation"]},
  "attempt":null,
  "nativeAttempt":"none",
  "catalog":{"catalogId":"目录快照ID","observedAt":"...","expiresAt":"...","fresh":true},
  "policy":{"version":"政策版本","requireFree":false,"selectionMode":"user_choice","allowedCount":0,"maxAttempts":3,"maxTimeoutSeconds":1800,"dispatchEnabled":true},
  "decisionReason":{"code":"delegate_ranked_candidates","message":"...","codes":["..."]},
  "userSelection":null,
  "recommended":{"selection":{"executorId":"workbuddy","connectionId":"实际连接","providerId":"实际提供方","modelId":"实际模型","reasoningEffort":null},
    "cost":{"credits":"x0.00","pricingVerified":true,"known":true,"zero":true,"label":"已核实零费率"},
    "resources":{"status":"fresh","routingVerified":false},
    "rank":{"tier":1,"rule":"tier_then_lexicographic"}},
  "candidates":[],"excluded":[],"missing":[],
  "history":{"status":"partial","code":"statistics_partial_coverage","window":{"from":"...","to":null},"sampleSize":12,
    "coverage":{"tasksIncluded":12},"claims":{"savings":null,"superiority":null}},
  "limitations":["recommendation_only","no_model_call","no_attempt_created","routing_unverified"],
  "digest":"...","drift":null
}
```

怎么读：

- `decision=direct` 表示范围与验收都很小（精确文件、少量检查、单轮），建议 Codex 自己改；它不会创建原生轮次，`attempt` 恒为 `null`、`nativeAttempt` 恒为 `none`。这不是拒绝委派：用户指定 WorkBuddy 时照旧委派。
- `decision=delegate` 表示建议交给执行器；`candidates` 的 `rank.tier` 只是分档（1 零费率且资源引用新鲜、2 零费率、3 已观测费率且资源新鲜、4 已观测费率、5 费用未知），同档按执行选择标识排序，**不是质量排名**，也没有 `score` 字段。
- `decision=wait` 表示现在不该派：没有任何候选、用户选择不可用、或费用上限无法保证。`recommended` 为 `null` 时不挑“最便宜”的替代，等用户重新决定。`hard_cost_cap_unsupported` 就是“要一个硬费用上限”这一条：本模块不保证，别把未知价格当成零，也别当成硬限。
- `userSelection` 记录你显式点的模型：命中就是 `available` 且 `user_selection_wins`；缺失或不可用时是 `user_selection_unavailable`，原因写在 `missing`，不静默换模型。
- `excluded` 是逐项排除原因，常见 `policy_blocked`（原 allowlist/精确模型限制）、`policy_requires_free`、`source_not_online`、`source_not_dispatchable`、`dispatch_not_enabled`、`catalog_expired`、`free_only_not_verified`。分类只据结构判断，不把“在线”当“可执行”。
- `resources` 来自 `/workbench/v1/resources/plan-reference`：`status=fresh|stale|unavailable`，`routingVerified` 恒为 `false`。声明的关联不是真实路由；`quotaRemaining=null` 表示未知，不是零或充足。
- `history` 来自 `/workbench/v1/statistics`：`partial` 时照样给样本量与时间窗，并说明覆盖不全；不可用就写不可用，`claims.savings`/`claims.superiority` 恒为 `null`，没有对照实测就不宣称更省或更强。
- `digest` 只由输入与快照内容决定（同一约定、同一快照重算得到同一 digest）。`previous` 参与评估时返回 `drift`：快照、政策、选择或过期状态变化会标 `blockedForDispatch`，此时确认按钮拦下，不按旧解释派工；一致时 `codes` 为空。

采用候选只是把执行来源/模型/档位填回表单，仍要核对约定并在本机确认；推荐本身不授权，也不等于已经派工。宿主未实现该命令时面板隐藏，手工选择流程不受影响。



## 自动政策下的派工

自动政策启用后，派工不是由对话触发，而是由已保存的政策与本机命令决定。以下每一步都在本机 gateway 目录运行，来源参数必须指向真实操作者：

```powershell
node scripts/automation.mjs evaluate --contract tasks/guard.json --policy-id auto-gate --probe probe.json
node scripts/automation.mjs decide --contract tasks/guard.json --policy-id auto-gate --probe probe.json
node scripts/automation.mjs execute <决定编号> --operation-id <UUID> --enable-dispatch
node scripts/automation.mjs decisions --limit 20
node scripts/automation.mjs recover
```

`evaluate` 只读：它把政策、任务约定、当前模型政策与 `--probe` 提供的只读目录/额度快照放在一起解释，输出 `decision=delegate|wait`、`candidates`、`blocks`、`limits`、`cost`、`rounds` 与 `history`，不写决定行。`decide` 记录一条决定（`pending`）并返回它的编号，同一任务重放返回原记录；同一 `taskId` 已被别的决定占用时报 `TASK_CONFLICT`。`execute` 用决定编号在派工前于同一事务里重验政策版本与撤回、到期、范围、历史模型政策、费用与容量，成功才写 `dispatched`。

怎么读：

- `blocks` 非空就是没派工，`blockedCode` 是第一条。`MODEL_POLICY_BLOCKED`（该模型被当前政策挡住）、`QUOTA_UNAVAILABLE`/`QUOTA_EXHAUSTED`（额度未知或已耗尽）、`COST_CONTROL_UNAVAILABLE`（要硬上限但来源不保证）、`EXECUTOR_BUSY`（共享容量被占）、`POLICY_REVOKED`/`POLICY_EXPIRED`/`SCOPE_VIOLATION`（政策不再覆盖这个任务）都不能靠重试变成可派。
- `evaluation.cost.mode` 决定费用语义：`free_only` 只看新鲜的 x0.00 证据；`known_cost` 只认真实可用的硬上限；`unknown_allowed` 允许未知价格，但 `limits` 里会写它不是硬上限，不能据此宣称省钱或封顶。
- `dispatched` 只说明派工意图已提交，不等于执行成功；后续照常监督与独立验收。
- `outcome_unknown` 表示原操作结果不明：只观察原 `operationId`，不新建任务、不换执行器、不按超时释放占用。重启后停在 `executing` 的决定由 `recover` 标成同一状态，也不重派。
- 撤回、到期或修订只影响之后符合条件的任务；已在执行的任务保留原操作与证据。

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

上面的 `model` 只对 WorkBuddy 任务成立。DSH 任务的返工不要带 `model`、`scope`、`constraints` 或 `acceptanceCommands`：模型由原桥接会话与计划决定，改模型等于换执行条件，要重新走授权。DSH 的原生停止证据是 `turn/end` 或 `agent/inbox/spliced` 的 cancelled 事件，不是会话失活或窗口关闭。

返工后重复监督与独立验收；不重发原任务。取消走 cancel_task，并继续确认 remoteStopped。异常处理见 [连接与恢复](setup.md)。
