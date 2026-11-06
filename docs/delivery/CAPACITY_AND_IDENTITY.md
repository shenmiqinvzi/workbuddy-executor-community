# 容量、占用与身份（RC6，只读核对）

一句话：**这台机器上有三套库、三个占用，只有一套真正被卡死；谁都不能自动清。**

## 1. 三套库的现状

| 库 | 大小 | 任务 | 容量行 | 是否可自动释放 |
| --- | --- | --- | --- | --- |
| RC1 `gateway-v0.7.1-rc1\data\tasks.sqlite` | 933,888 B / 25 表 | 6 条（2 accepted、2 cancelled、1 accepted、1 blocked） | 指向 `d1-workbuddy-2cc8e262-54f5-43a0-8511-b3febf0d4101`，operation `card-r6-foreign-session-1793948211334` | **不能**。该任务是 `blocked` 且 `attempt_id=null`、没有 `task_closed`、`run_evidence_digest.stopped=null`，`isClosed()` 永远为假 |
| RC2 `gateway-v0.7.1-rc2\data\tasks.sqlite` | 258,048 B | 1 条 `rc2-live-20261106b`，`needs_review`，attempt `run-de1afbd3-571a-4533-885e-3819146f0882` | 指向它 | **不能**。`stopped=true` 但没有 `task_closed`，`isClosed()` 为假 |
| 当前聊天 MCP `outputs\t7b-live-acceptance-20261031\state\tasks.sqlite` | 237,568 B | 2 条，均 `accepted`，均有 `task_closed` 且 `stopped=true` | 指向已关闭任务 | **会自然清掉**：下一次 `claim()` 发现前一个占用者已关闭就删行。也就是说聊天 MCP 侧并不是被卡死的那一个 |

结论：被卡死的是 **RC1 的 R6 任务**与 **RC2 的 needs_review 任务**。它们分别属于两套独立安装与两个独立库，互不影响；RC6 是新安装，默认会带自己的空库，因此**不存在「RC6 装上去就能解开 R6」这回事**。

## 2. 为什么不能「顺手清掉」

- 清容量等于对原任务下结论。R6 是「外来会话被拒」后的 `blocked`，原生侧是否真的没有残留我们**没有证据**；RC2 的是「已停在窗口、等待 review」，它连 review 都还没做完。
- `recovery-cli show` 对这两条的 `available` 都是空，`proof.reconcile`/`close` 都是 null。这表示「当前没有可核对的原生证据」，**不表示**「可以安全关闭」。
- 一旦关闭，`task_closed` 会被写死，之后任何「那台机器上到底跑没跑过」的追问都无法再回答。

## 3. 可以做的不重叠方案（选一个）

| 方案 | 做法 | 结果 | 需要谁 |
| --- | --- | --- | --- |
| N1（推荐） | RC6 装到新根 + 新库，本轮真实派工全在 RC6 上跑；RC1/RC2 原样保留 | 能拿到 RC6 的真实证据；R6 与 RC2 的占用继续挂着，报告里如实标「未解除」 | 你授权安装与派工即可 |
| N2 | 先只读核对 R6 的原始请求、会话、事件，找出「原生侧到底做过什么」的正面证据 | 若有证据，按既有恢复流程补证后再决定；若没有，回到 N1 并标注 | 你确认可以读取该任务详情 |
| N3 | 对 RC2 的 needs_review 任务补完 review 后关闭 | 释放 RC2 的槽；但会改变 RC2 这套安装的结论（从「未 accepted」变成「已处理」） | 你要单独同意，因为这是对历史任务下结论 |

明确不做：换库、换身份、用第二台机来「绕开」原占用；把「新库没有占用」写成「原占用已解除」。

## 4. 身份与选择规则（每条真实任务都要满足）

- **执行器**：`workbuddy`（桌面原生）或 `dsh`（Harness），一条任务只属于一个执行器；同一个 `operationId` 不能换执行器重发（会 `OPERATION_CONFLICT`）。
- **来源**：`runtimeSource` 如实写，不得把网关本地观察写成原生确认；三档「已声明 / 已观测 / 已核验」不混用。
- **模型**：必须精确到 modelId 与推理档位；本轮 WorkBuddy 侧的实际可选目录**当前查不到**（客户端起不来，见 `UI_AND_SECOND_MACHINE_PLAN.md` §3），只能引用 RC1 时代的 23 条快照并标注「非本轮实测」。
- **费用**：WorkBuddy 的 `credits` 是相对倍率（如 `x0.11`），不是金额；DSH 侧 `x0.00` 是观测值，不等于免费承诺。两项都必须原样写进任务确认。
- **会话**：一条任务绑定一个已存在的原生会话与一个工作目录；跨目录会话直接在准入被拒（`WORKSPACE_CONFLICT`）。
- **范围**：写权限只来自结构化 `scope.allowedChanges`；正文里写「请新建文件」不构成授权（见 `F_CONTRACT_1.md` 方案 A）。

## 5. 复核命令（只读）

```powershell
# 三套库的容量行与任务状态（只读副本，不动原件）
node E:\javaproject\outputs\rc6-live-readiness-20261106\read-capacity.mjs
```

该脚本把三个库连同 `-wal`/`-shm` 复制到临时目录再查，输出 `capacity-detail.md`。原件从未以写方式打开。
