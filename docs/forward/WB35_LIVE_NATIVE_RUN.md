# WB35 live 原生派工实录（2026-11-11）

本页记录用**真实 WorkBuddy 桌面端**跑通与跑不通的部分。所有结论只依据本页列出的日志文件与产物，不做推断。

## 1. 打通前置（四步，缺一不可）

| 步骤 | 事实 | 证据 |
| --- | --- | --- |
| 应用路径 | 默认发现指向 `C:\Users\LENOVO\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe`（不存在）。真实安装为 `F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe`，需 `WORKBUDDY_CLI_ELECTRON` 覆盖 | `live-models.log` 首轮 `ENOENT` |
| 原生库 | 端口启用前读 `<workbuddyConfigDir>\workbuddy.db` 的 `sessions`，要求全部终态（见 `src/native-desktop-trigger.ts:410`）。`WORKBUDDY_CONFIG_DIR` 会覆盖该路径，所以把真实库 `C:\Users\LENOVO\.workbuddy-ai\workbuddy.db`（140 条 session 全 completed）复制到 `outputs\executor-plan-20261111\live-config\` | `live-health3.log` |
| 调试端口 | 触发层用 `desktopLaunchEnv()` 设 `WORKBUDDY_REMOTE_DEBUGGING_PORT` 并重启应用；首次重启会被 120s 客户端超时截断，需要更大预算重试 | `live-models.log`（2715ms 成功）、`scripts/live-call.local.mjs`（默认 600s） |
| 模型目录 | `workbuddy_list_models` 返回 23 个模型 + credits 倍率；金额上游不回传，一律 unknown | `live-models.log` |

## 2. 派工实录（7 次真实派工）

| 任务 | 模型 | 结果 | 关键事实 |
| --- | --- | --- | --- |
| `live-wb35-001` 第 1 轮 | glm-5.3-flash (x0.08) | `needs_review` | 真实产出 `RESULT.md=SUM=7`；`nativeStopSource=native_idle`、`stopReason=end_turn` |
| 同上 返工第 2 轮 | glm-5.3-flash | `needs_review` | 增加了 `PROOF.txt`（超出原 scope）→ `$scope` 判 `failed`：`Unauthorized workspace changes: added PROOF.txt` |
| 同上 返工第 3 轮 | glm-5.3-flash | `blocked` | 原生 429：`nativeRateLimit {kind:rate_limited,statusCode:429,phase:native_history}`，未自动重发 |
| `live-wb35-002` | glm-5.3-flash | `blocked` | 同一 429 路径 |
| `live-wb35-003` | hy3 (x0.00) | `blocked` | 「turn ended without a verified worker report」，文件保留、未自动重发 |
| `live-wb35-004` | minimax-m3.1-flash (x0.08) | `blocked` | 502（系统代理 127.0.0.1:7890，socket hang up）；`RESULT.md=SUM=11` 已写出 |
| `live-wb35-005/006` | minimax / glm | `blocked` | 同一 502 代理路径 |
| `live-wb35-007` | deepseek-v4.1-flash-sg (x0.11) | `blocked` | 无认证报告；但 `RESULT.md` 已变为 `SUM=11` + `CHECKED=yes`（工作完成、报告握手失败） |

合计 7 次派工、6 个任务、1 次同任务返工链（3 轮）；**没有一次被自动重发**。

## 3. 已证明的护栏（每条都有真实调用）

1. **不信任模型自述**：模型在 `report.rawText` 里写「已运行验收命令，退出码 0」，但 `workbuddy_check_task` 对 `legacy-command-1` 判 `unknown`（`No verified command record matches`）。只有我显式调用 `workbuddy_run_review_command` 后才有 `exitCode:0, cleanupConfirmed:true` 的真实记录（`live-runcheck.log`）。
2. **scope 是准入时绑定的**：返工追加 `PROOF.txt` 被 `$scope` 抓出 unauthorized；`continue_task` 附带的 `acceptanceCommands` 不能扩大原 scope。
3. **单槽容量**：前一个任务未关闭时 `send_task` 直接 `CAPACITY_OCCUPIED`（`live-send2.log`）。
4. **CAS/新鲜度**：`check_task` 用旧 revision 报 `STALE_REVISION`；工作区在观测后被改动报 `Source changed during or after cited validation`（`live-check2/3/4.log`）。
5. **取消语义**：`cancel_task` 写入 cancellation 记录并在同一 task/attempt/session 内发原生取消（系统消息 `Native cancellation issued for this task/attempt/session only.`）；没有把「已请求取消」当成「已停止」——`stopped` 仍由原生空闲证明。
6. **失败即停**：429/502/无报告三种失败都收敛为 `blocked` + `No automatic resend`，产物保留不删。
7. **会话复用**：返工落在同一 `sessionId`；任务被取消后再派工会换新会话（`7143d993…` → `0fa6a0a6…`），不会把取消过的会话当可复用目标。

## 3.5 第 8 次（`live-accept-010`）：派工链路全通，停止证据缺失

这一轮换到全新库（`live-config/tasks-2.sqlite` + `runs-2`）后，派工链路第一次完整走通到「原生真的干活并写出产物」：

| 阶段 | 结果 |
| --- | --- |
| `send_task` | `created:true`，`state:queued`，revision `KcV8F2mraOVWgTWj` |
| 原生认领 | 系统消息「The verified native WorkBuddy desktop conversation claimed this task.」 |
| 模型回合 | 助手消息说明「读取 NUMBERS.txt（5 和 6），求和 11，将 RESULT.md 覆写为单行 TOTAL=11」 |
| 产物 | `live-workspace2\RESULT.md` = `TOTAL=11`（真写盘，非自述） |
| 报告 | `execution.state=report_received`、`reportDigestPresent:true` |
| 停止 | **`stop_unconfirmed` → `blocked`**，`displayState=waiting_stop`、`allowedActions:[]` |

原因是原生侧那次回合的最后一个工具调用（`call_f6f3bbab7d6c4d748338bdb6`）一直停在 `in_progress`，没有拿到终态 `tool_call_update`；会话本身已 `terminated`（应用库 `sessions.status=terminated`），但渲染层历史里这条记录不会自己收敛。`workbuddy_health` 的 `nativeHealth.diagnostics` 如实点名：

```json
{"state":"busy","diagnostics":{"stillBusy":["unfinishedTools"],
 "pendingToolCalls":[{"toolCallId":"call_f6f3bbab7d6c4d748338bdb6","status":"in_progress"}],
 "requiredUpstreamEvidence":[
  "a native event that binds each unfinished tool call to a finished turn (attempt or wake identity, or a terminal tool_call_update)",
  "or a daemon signal that the current turn ended for this session"]}}
```

**处置决定（重要）**：我曾试过把规则放宽成「会话状态终态 + 不在 daemon 活跃表 ⇒ 把未收敛的工具记录当历史」。这会直接推翻 WB04 已固化的判据（`test/native-desktop-trigger.test.ts` 的四类样本里，「当前回合的 pending 调用 stays busy」正是其中一条），等于用「状态看起来结束了」替代「原生给出停止证据」。按停止围栏不做这个放宽 —— 改动已回退，四类样本 38 通过 / 6 跳过 / 0 失败。

因此本任务的正确结局就是 **blocked（stop_unconfirmed）**，而且它占着单槽容量：再派工一律 `CAPACITY_OCCUPIED`（`An original workflow remains open or uncertain (task live-accept-010)`）。释放路径只有两条，都不许自动化：①原生补发那条终态事件；②操作员在有 TTY 的恢复控制台里用 `bin\workbuddy-recovery.cmd` 查看证据后人工确认（`recovery-cli.ts` 要求 `process.stdin.isTTY && process.stdout.isTTY` 才接受确认命令）。

这正是 WB04 文档里写的桥接缺口：需要原生新增 `turn_end` 事件（`turnId/wakeId/messageRequestId/status/seq`），让「回合结束」有可绑定到 attempt 的终态证据，而不是靠一个不会收敛的工具记录。

## 4. 没证明的部分（如实记）

- **完整验收闭环没有跑完**：没有一次拿到「认证报告 + 命令证据 + 独立审查 + accept」齐全的 `accepted` 任务。卡点不在源码，而在本机网络：系统代理 127.0.0.1:7890 在上游模型流上间歇 502（`socket hang up`），以及 provider 侧 429。7 次里 0 次走到 `accept_task`。
- `<sub>未观测</sub>`：真实窗口内的任务面板渲染（WebView2 controller 在本机不可用，见 `WB35_WB38_INSTALLED_AND_WINDOW.md`）、第二台物理机、远端 CI、签名发行。

## 5. 复跑方法

```bash
# 客户端必须放在 gateway 目录内才能解析 @modelcontextprotocol/sdk
cp E:/javaproject/outputs/executor-plan-20261111/live-call.mjs gateway/scripts/live-call.local.mjs
cd gateway
export WORKBUDDY_CONFIG_DIR=<含 workbuddy.db 的隔离目录>
export WORKBUDDY_CLI_ELECTRON='<WorkBuddyAI.exe 绝对路径>'
node scripts/live-call.local.mjs workbuddy_list_models '{}'
node scripts/live-call.local.mjs workbuddy_send_task @args.json
node scripts/live-call.local.mjs workbuddy_wait '{"taskId":"...","timeoutMs":45000}'
```

`live-call.mjs`（本机验证用客户端，超时由 `LIVE_CALL_TIMEOUT_MS` 控制，默认 600s）只放在 outputs 证据目录，不进仓库、不属于发布产物。
