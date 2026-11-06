# 双执行器真实样本与验收约定（RC6）

**先纠正一处错**：上一版把 `execution: null` / `collaboration: null` 解释成「单执行器、无协作」，这是错的。它们是 `live-acceptance-fixture` 生成器**未授权草稿**的占位状态；`null` 字段过不了正式校验，不能拿去派工。

## 1. 草稿与正式约定是两份东西

| | 草稿（现在有的） | 正式约定（派工前才能生成） |
| --- | --- | --- |
| 位置 | `fixtures\live-acceptance-KcShpd\contracts\{workbuddy,dsh}.json` | 另存为新文件，例如 `contracts\workbuddy.formal.json` |
| `authorized` | `false` | 由你的实际选择决定 |
| `execution` | `null` | 精确 `{executor, connection, provider, model, reasoningEffort}`，来源必须是本轮真实可读的目录 |
| `collaboration` | `null` | 带 `planId` 与 `expectedPlanRevision`，且这两个值只能来自可信入口（`createCollaborationPlan` 等），不能手填 |
| 用途 | 历史参考、候选提案 | 只能这一份能提交 |

规则：

1. **保留草稿与基线**：`baseline.json` 的 `baselineSha256 = 316fb243…` 与九个条目的哈希不动，草稿原样保留，作为「派工前长什么样」的证据。
2. **正式约定另复制**：复制草稿 → 填 `execution` → 走可信入口拿到 `planId`/`expectedPlanRevision` → 写进 `collaboration`。
3. **提交前用现行校验**：`validateSupportedTaskContract`（`gateway/src/task-contract.ts`）必须通过；`null` 的 `execution`/`collaboration` **不得通过**。校验失败就停在原地，不许改成 legacy 路径、不许删检查、不许为了过校验去缩 `scope`。
4. 用户确认按原计划执行：展示执行器、来源、精确模型、推理档、范围与费用（含未知披露），取得确认后才派。

## 2. 两端样本

| 项 | WorkBuddy | DSH |
| --- | --- | --- |
| 工作区 | `...\fixtures\live-acceptance-KcShpd\workbuddy` | `...\fixtures\live-acceptance-KcShpd\dsh` |
| 缺陷文件 | `src/clamp.mjs`（上下界夹取写反） | `src/paid-summary.mjs`（把 pending 计入已支付） |
| 允许改动 | 仅该源文件 | 仅该源文件 |
| 验收命令 | `F:\node.exe --test --test-reporter=tap checks/acceptance.test.mjs`（cwd 上述工作区，30s） | 同左，cwd 为 `dsh` |
| 修复前 | 必失败（越界返回上界） | 必失败（pending 被计入） |

`requiredChecks[].definition` 是**精确 JSON 字符串**（CommandSpec），不是散文。三项目前齐备：`independent-command`（命令）+ `behavior`（语义）+ `protected-checks`（检查文件未改）。

## 3. 真正的验收顺序（上一版漏了两步）

worker 自己跑测试只是**自报**，不能当验收。完整链路必须是：

1. worker 执行并自报结果 → 只算线索。
2. **服务端执行命令**：`run_review_command` 按原 JSON CommandSpec 在服务端跑一遍，拿到真实 TAP 输出与退出码。
3. **服务端程序批次**：`check_task` 生成当前程序检查批次，得到 `machineCheckIds`（一次一个批次）。
4. **独立语义审查**：`behavior` / `protected-checks` 由服务端语义检查判定，不采信 worker 自述。
5. **不可变 reviewId**：`review_task` 用上面的 `machineCheckIds` + 原始语义要求生成 `reviewId`。
6. **最新 revision 下 accept**：在最新 `revision` 上 `accept_task`，随后 `task_closed` 落盘、容量行消失。

`record_inspection` 只是「独立复算记录」，**不能替代**第 2–5 步的服务端命令与完整程序批次。上一版把 inspection 写成验收节点，属于口径错误，已在此更正。

## 4. 判定标准

1. `queued` → 原生领取事件 → 系统生成 `attemptId` 并回读。
2. 派工后 `artifacts` 含修复文件；`baseline.json` 里 `mutable:false` 的条目哈希逐条不变。
3. 服务端 `run_review_command` 的真实退出码 0，TAP 全绿；原始输出入证据。
4. `reviewId` 不可变，`accept` 发生在最新 revision。
5. 收尾：`task_closed` 存在、`workflow_capacity` 该行消失、`state=accepted`、`run_evidence_digest.stopped=true`。
6. 保留失败样本：修复前先跑一次，把红色输出存档，证明检查真的会红。

## 5. 顺序与前置

- 两端**严格串行**（共享容量 1）。
- 前置：RC6 安装（未授权）、执行器/模型/推理/费用（待选）、空闲原生会话（WorkBuddy 客户端当前起不来，见 `UI_AND_SECOND_MACHINE_PLAN.md`）、技能与 MCP 核验（技能六文件已与包内逐字节相同，见 `USER_CHOICES.md`）。
- 库内容量空闲 ≠ 原生不重叠：详见 `CAPACITY_AND_IDENTITY.md` §2。
