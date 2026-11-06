# 双执行器真实样本与验收约定（RC6）

两条样本都来自 `live-acceptance-fixture` 生成器，故意带有真实缺陷：**修复前必失败，修复后必通过**。因此它们既能证明「派工链路通」，也能证明「验收不是走过场」。

夹具根：`E:\javaproject\outputs\rc6-live-readiness-20261106\fixtures\live-acceptance-KcShpd`
基线摘要：`baselineSha256 = 316fb2431b6424d1e677326e411ac8823fb5447451a0d8cb849eb47d9aadb0a7`
`authorized:false`、`dispatchPrepared:false` —— 只准备，不授权。

## 1. WorkBuddy 侧样本

| 项 | 值 |
| --- | --- |
| 工作区 | `...\fixtures\live-acceptance-KcShpd\workbuddy` |
| 缺陷文件 | `src/clamp.mjs`（`clamp` 的上下界夹取写反，任何越界值都返回上界） |
| 验收命令 | `F:\node.exe --test --test-reporter=tap checks/acceptance.test.mjs`（cwd = 上面的工作区，timeout 30s） |
| 输入 | `src/clamp.mjs`、`checks/acceptance.test.mjs` |
| 允许改动 | `src/clamp.mjs`（仅此一个文件） |
| 失败表现（修复前） | `低于区间返回下端点` 期望 0 得 10；`负数和小数` 期望 -1.25 得 -1 |

契约草案已生成：`contracts\workbuddy.json`，其中 `requiredChecks` 三项目前齐备：

```json
{"id":"independent-command","kind":"command",
 "definition":"{\"executable\":\"F:\\\\node.exe\",\"args\":[\"--test\",\"--test-reporter=tap\",\"checks/acceptance.test.mjs\"],\"cwd\":\"...\\\\workbuddy\",\"timeoutSeconds\":30,\"inputs\":[\"src/clamp.mjs\",\"checks/acceptance.test.mjs\"]}"}
```

`definition` 必须是这个**精确 JSON 字符串**（CommandSpec），不是散文字符串——这是 L08 之后契约的要求。

## 2. DSH 侧样本

| 项 | 值 |
| --- | --- |
| 工作区 | `...\fixtures\live-acceptance-KcShpd\dsh` |
| 缺陷文件 | `src/paid-summary.mjs`（把 `pending` 也计入已支付） |
| 验收命令 | `F:\node.exe --test --test-reporter=tap checks/acceptance.test.mjs`（cwd = `...\dsh`，timeout 30s） |
| 允许改动 | `src/paid-summary.mjs` |
| 失败表现（修复前） | `pending 不计入` 期望 1 得 2；`混合状态` 金额多算 |

契约草案：`contracts\dsh.json`，结构同上，`cwd` 指向 `dsh` 目录。

## 3. 每条任务要带的字段（两端一致）

- `schemaVersion: "workbuddy-executor/vnext-2"`
- `taskId` / `workspaceId`：用草案里已生成的值，不要重置成新值（重置会破坏夹具身份）
- `title` / `objective`：草案里的中文（夹具文件是 UTF-8；控制台若显示乱码是 PowerShell 编码问题，不影响内容）
- `execution` / `collaboration`：本轮为 `null`（单执行器、无协作）
- `timeoutSeconds: 600`、`maxAttempts: 1`（待你确认的默认值）
- `scope.allowedChanges`：只有那一个源文件
- `requiredChecks`：`independent-command`（精确 CommandSpec）+ `behavior`（语义）+ `protected-checks`（检查文件未被改）
- `operationId`：一次派工一个，落在草案的 `proposedOperationId` 上；重试要复用同一个，换键会被判 `OPERATION_CONFLICT`

## 4. 判定标准（不符合就不算通过）

1. 任务先进入 `queued`，再出现原生领取事件；`attemptId` 由系统生成并回读得到。
2. 派工后 `get_task` 的 `artifacts` 含两端各自的修复文件；`src` 之外的检查文件哈希未变（用 `baseline.json` 的 `mutable:false` 条目逐条比对）。
3. 验收命令在原生侧真实执行，退出码 0，TAP 全绿；证据里保存原始 TAP 输出，不写「看起来通过」。
4. `record_inspection` 记录独立复算结果；`review` 通过后才 `accept`。
5. 全链结束后：`task_closed` 存在、`workflow_capacity` 该行消失、任务 `state=accepted`、`run_evidence_digest.stopped=true`。
6. 失败样本要留证：故意先不修，跑一次，把失败输出存下来，证明「这条检查真的会红」。

## 5. 顺序与容量

- 两端**严格串行**：WorkBuddy 一条走完（含 review/accept/关闭）再做 DSH。共享容量只有 1，并行会互相顶掉。
- 每条任务开工前核对：`workflow_capacity` 为空，或占用的正是本轮要跑的那条。
- RC6 用新库时，容量天然为空；RC1/RC2 的占用仍然挂着（见 `CAPACITY_AND_IDENTITY.md`），不影响 RC6，但也**不能**写成「已解除」。

## 6. 前置依赖（缺一项就不能开工）

| 依赖 | 当前状态 |
| --- | --- |
| RC6 安装 | 未安装（`USER_CHOICES.md` D1） |
| 执行器与模型的实际选择 | WorkBuddy 侧目录查不到（客户端起不来）；DSH 侧需你指定模型与推理档位 |
| 费用确认 | WorkBuddy `credits` 为倍率、DSH 为观测值，均需你原样确认 |
| 空闲原生会话 | WorkBuddy 会话需客户端可用；DSH 会话需 Harness 侧在线 |
| 技能与 MCP 核验 | 安装后按 `INSTALL_AND_ROLLBACK_PLAN.md` 第 4 节六项核对 |
