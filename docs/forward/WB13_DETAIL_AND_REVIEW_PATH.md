# WB13 任务详情、返工取消与独立审查主路径

本轮范围：核对既有主路径、把"拒绝要给下一步"这条完成标准落到代码与测试里、写出可核对的对照表。方案与审查的状态机沿用 HEAD 0919201，本轮唯一的行为改动是 `assertCurrent` 的拒绝文案（见 §4）。

## 1. 详情首屏：先给阻塞，再给动作

`TaskApplicationService.statusView()` 产出的 `TaskStatusView`（`gateway/src/task-application-service.ts:20-40`）就是详情页的数据源，字段足够回答"卡在哪、该去哪处理"：

| 字段 | 回答的问题 |
| --- | --- |
| `businessState` | 库里记的业务状态（`queued/working/needs_review/...`） |
| `displayState` | 页面该显示的状态，是推导值，不直接等于业务状态 |
| `remoteStopped` | 原生侧是否**已确认**停止（不是超时推断） |
| `allowedActions` | 现在真正可点的按钮 |
| `lastObservedAt` | 上次观察时间，用来判断"这屏是不是旧的" |
| `expectedRevision` / `expectedAttemptId` | 这一屏绑定的 revision 与 attempt，操作要带上它们 |
| `reviewOperation` | 独立审查/验收要用的 operationId 与期望 revision |

`displayState` 的推导顺序（`:487-497`）把"结束"与"验收"分开了：

```
accepted                            → accepted
终态                                → cancelled / failed / waiting_stop
execution = waiting_input           → waiting_input
已有审查记录                        → 已停止? needs_review : waiting_stop
cancel 已请求 / stop_unconfirmed    → waiting_stop
业务已停但执行器仍在 queued/working → unknown（不猜）
session 离线或未知                  → unknown
queued / working                    → queued / running
```

关键点：**执行器结束只走到 `waiting_stop` 或 `needs_review`，永远不会自己变成 `accepted`**（`accepted` 只在 `task.state === "accepted"` 时出现）。

## 2. 按钮由 allowedActions 驱动

`allowedActions` 的生成条件（`:499-507`）：

| 动作 | 条件 |
| --- | --- |
| `cancel` | 未停止、未请求取消、`displayState ∈ {queued, running, waiting_input}` |
| `rework` | 工作区基线存在、已停止、有 session、`attempt < attemptLimit`、且已有审查或检查未通过 |
| `accept` | 工作区基线存在、检查项 `passed`、已停止、已有审查、有 session、有仓库绑定 |
| `review` | 桌面侧在 `needs_review` + `remoteStopped` + 有报告 + 基线存在时补上（`desktop-control-runtime.ts:53-54`） |

因此"取消 / 观察恢复 / 返工 / 检查 / 接受"是五个独立入口，没有一个入口能替另一个做决定；页面没有权限自己判断能不能点。

## 3. 独立审查：先跑命令，再取 revision，最后出不可变 review

顺序是强制的（`SKILL.md` / `references/dispatch.md` 的 revision 单向表，本轮 WB07 补写）：

```
1. 独立命令跑完（run_review_command / check_task），拿到真实退出码与输出
2. 重新读详情，取当前 revision / attemptId（读完之前的判断作废）
3. 创建程序批次（inspectionFiles）与语义检查结论（semanticChecks）
4. review_task 生成不可变 reviewId（绑定 revision + attempt + 检查项集合）
5. accept_task 只认当前 reviewId；reviewId 变了就是 REVIEW_REQUIRED
```

约束（`desktop-control.ts:53-58`、`test/desktop-control.test.ts`）：

- `review` 必须提交**全部**原始语义检查项，缺一项或多一项都 `INVALID_REQUEST`；结论只能是 `passed/failed`，编造值被拒。
- 有语义检查却没有实际查看文件（`inspectionFiles` 为空）也拒——"没看代码就下结论"不算审查。
- 审查过程中原验收要求变化 → `CONTRACT_INTEGRITY`，旧预览作废。

## 4. 拒绝必须给下一步（本轮改动）

`assertCurrent` 的六条拒绝现在都带可执行下一步，而不是只说"不允许"：

| 码 | 现在的文案要点 |
| --- | --- |
| `STALE_ATTEMPT` | 任务已进入其他轮次 → 刷新详情页，新操作要基于当前 attempt 重新发起 |
| `STALE_REVISION` | 状态已变化 → 刷新后重新核对，不要沿用旧页面上的按钮结果 |
| `ACTION_UNAVAILABLE` | 带上本机观察到的 `displayState` 与**实际可用操作**列表 |
| `STOP_UNCONFIRMED` | 先取消或等原生侧结束，拿到停止证据后再返工/审查/验收；**不会因超时放行** |
| `BUDGET_EXCEEDED` | 去详情确认当前模型与剩余轮次，或改走新的派工而不是在本轮返工 |
| `REVIEW_REQUIRED` | 打开最新一份独立审查，确认 reviewId 后再验收 |

证明：`gateway/test/action-refusals.test.ts`（3 例，本轮新增）+ `gateway/test/desktop-control.test.ts`（3 例）。

```
node --import tsx --test test/action-refusals.test.ts test/desktop-control.test.ts
→ tests 6 / pass 6 / fail 0 / 1322ms
```

## 5. 三段凭证与"未知就给原生定位"

- **报告**：`needs_review` 的前提是任务报告已回；详情页展示报告正文与它的 revision。
- **停止**：`remoteStopped` 只由原生事件推出（WB04 的归属过滤），`waiting_stop` 表示"业务上停了、原生还没确认"。
- **独立验收**：`reviewOperation` 给出 operationId 与期望 revision，用来查这一次审查/验收到底发生了什么。
- 输入未知（`displayState === "unknown"`）时页面只给原生定位入口与查询提示，不提供网页代批，也不猜"大概在跑"。

## 6. 完成标准对照

| 完成标准 | 证明 |
| --- | --- |
| 过期页面不能执行新动作 | `STALE_REVISION` / `STALE_ATTEMPT`（`desktop-control.test.ts`「refuses stale attempts…」+ `action-refusals.test.ts`） |
| 无停止不能返工/accept | `STOP_UNCONFIRMED`（同上两处）；`allowedActions` 本身也不含这两个按钮 |
| 执行器结束只到待审 | `displayState` 推导：`needs_review` / `waiting_stop`，`accepted` 仅由业务状态给出 |
| 审查后文件变化阻止接受 | `accept` 要求"当前 reviewId + 检查 passed + 基线存在"，任一变化即 `REVIEW_REQUIRED` / 按钮消失 |
| 操作拒绝给具体下一步 | §4 六条文案 + 3 个断言测试 |

## 7. 未覆盖

- 真实桌面的按钮点击、截图与录像：属 WB35（需真实桌面进程与冻结候选）；本轮只给源码级证据。
- 原生侧"执行器已结束但事件还没到"的时序：依赖 WB04 的最小桥接契约（`turn_end`），当前 `blocked_external`。
