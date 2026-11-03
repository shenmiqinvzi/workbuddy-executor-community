# 第六轮真实验证记录（隔离副本 run6）

- 日期：2026-11-02
- 副本：`<workroot>\workbuddy-t7d-p02-20261102`（分支 `feat/t7d-p02-uncertainty`）
- 源仓库：`<workroot>\workbuddy-t7d-desktop-controls-20261031`（HEAD `34fcb1b`，8 条未提交，本轮零改动）
- 账本：`<workroot>\_wb-p05-state\run6\workbuddy.db`
- 证据包：`<workroot>\_wb-p05-state\run6\evidence-run6.json`

## 1. 目的与边界

**目的**：验证 D-4 修复（受管执行器的停止证据链）在真实派工里确实可用，并顺带把八步证据采齐。

**边界**：

- 这是隔离副本里的真实验证，不是产品内 t6 审查。`task_reviews` 没有记录，`tasks.reviewed_at` 仍为 null。
- 第 8 步的审查由另一个模型只读完成，属于外部审查，不能替代产品内不可变 `reviewId` 的验收记录。
- 不涉及原任务 `desktop-send-b58168ae-b46f-4116-b84c-d398f95f84f9` 的取证结论（该结论见 P0-1 裁决）。
- 不做崩溃实验，不验证双进程恢复。

## 2. 结论

- **八步证据齐备**：1–7 每一条都有原始文件逐字段支撑，第 8 步由独立审查补上；证据包 `recorded=20`、`missing=[]`。
- **D-4 首次拿到真实执行证据**：模型主动用有界执行器跑了 `Get-Content hello.txt`，记录为 `exitCode=0`、`cleanupConfirmed=true`、`processStarted=true`、`ownership=windows_job_object`、`reason=exit`、`durationMs=2668`，stdout 为 `hello`。
- **本轮没有触发截止改写**：停止在 `11:03:14.418Z` 确认，早于 `deadline=11:11:32.927Z`，任务停在 `needs_review`，没有出现 run5 那种被写成 `blocked` 的情况。
- **仍不可主张的**：完整验收通过、全工作区零越界、额度可用或已扣费、死亡恢复有效（详见 §6）。

## 3. 现场

| 项目 | 值 |
| --- | --- |
| 任务 | `desktop-27a64eb2-da2c-4422-afd8-f041b956ed7c` |
| 尝试 | `run-bd8e5e66-dff7-4b5a-a336-738c542c8bd3` |
| 会话 | `47b36111-7419-494a-a40b-ee3b0f2d2ceb` |
| 工作区 | `<workroot>\_wb-p05-scratch\run-06` |
| 模型 | `deepseek-v4.1-flash-sg`（观察费率 x0.03） |
| 从记录到停止 | 113918 ms（约 1 分 54 秒） |
| 账本状态 | `needs_review`，`blocking_reason=null` |

## 4. 八步证据

| 步骤 | 结论 | 依据 |
| --- | --- | --- |
| 1 请求已记录 | 成立 | `tasks.created_at=2026-11-02T11:01:20.500Z`；`task_operations[kind=plan_create].state=succeeded`，创建时间在 `body_json.result.createdAt` |
| 2 容量已预留 | 成立 | `workflow_capacity` 恰一行：`slot=1`、`executor=workbuddy`、`task_id`/`operation_id` 与本任务一致 |
| 3 原生会话已创建 | 成立 | `tasks.session_id`、`send.body_json.preparationSessionId`、`wake.json.sessionId` 三者一致；`wake.state=submitted`；`plan_authorize=succeeded` |
| 4 桌面已登记 | 成立 | `claim.json.claimedAt=2026-11-02T11:01:43.827Z`，`desktopPid=26012`；`events.jsonl` 第 2 条同名事件 |
| 5 已进入派工 | 成立 | `send` 与 `queue` 均 `succeeded`，`dispatchEnteredAt` 分别为 `11:01:32.940Z`、`11:01:32.958Z` |
| 6 已收到报告 | 成立 | `worker-result.json.status=completed`，`text` 424 字，`validationRecords` 1 条；系统状态为 `needs_review`（执行者状态不等于系统状态） |
| 7 原生停止已确认 | 成立 | `state.json.nativeStoppedAt=2026-11-02T11:03:14.418Z`，`nativeStopSource=native_idle`，`stopReason=end_turn`；`tasks.run_evidence_digest.stopped=true` |
| 8 独立审查 | 成立（外部） | `review-verdict-run6.md`，sha256 `c660f85b4065c57e…`，7309 字节；属另一模型只读审查，非产品内 t6 |

## 5. D-4 修复的实测确认

run5 的症状是 `validationRecords` 为空——不是模型偷懒，而是本机 `CurrentUser=RemoteSigned` 把网关自己的 `bounded-job.ps1` 挡在启动之前，supervisor 从未运行，于是「停止证据」永远拿不到，任务过截止后被改写成 `blocked`。

本轮两处修复在真实派工中的表现：

1. **执行策略**：调用自家脚本的子进程加 `-ExecutionPolicy Bypass`（只作用于该子进程，不改系统策略）。
2. **启动标记**：只有真的创建过进程才写 `.started.json`；没标记即「没有进程要清理」，不再卡住停止确认。

命令记录 `commands\5ad0f883-8e0f-43c3-8324-eae148643ca7.json`：

| 字段 | 值 |
| --- | --- |
| 命令 | `powershell -NoProfile -NonInteractive -Command "Get-Content hello.txt"` |
| exitCode / reason | `0` / `exit` |
| cleanupConfirmed | `true` |
| processStarted | `true` |
| ownership | `windows_job_object` |
| pid / durationMs | `32200` / `2668` |
| inputs before / after | 同为 `5891b5b5…f6be03`（一致） |
| stdout | `hello` |
| startedMarker | `…​.started.json`，内容为 `{"pid":32200}` |

产物 `hello.txt`：6 字节、内容 `hello\n`、sha256 `5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03`。

模型回报文本中的自述（exitCode、cleanupConfirmed、ownership、耗时、前后哈希一致）与文件记录逐项吻合，没有出现「报成功但记录为空」的情况。

## 6. 独立审查（外部）

- 命令：`codex exec --sandbox read-only --skip-git-repo-check -C <workroot>\_wb-p05-state -o review-verdict-run6.md`
- 任务单：`<workroot>\_wb-p05-state\reviewer-brief-run6.md`
- 结论文件：`<workroot>\_wb-p05-state\review-verdict-run6.md`

**审查确认的四项判定**

1. 面板 `allowedActions` 恒为空属 stage-2 设计（`task-view-stage.ts:161`），不是控制通道全线失效。
2. `resources/quotas`、`resources/capacity` 返回 503 `RESOURCE_STORE_UNAVAILABLE` 是正确失败语义（`workbench-http.ts:338`、`:355`），未知额度不会写成免费。
3. 「派工表缺租约/心跳、死亡后永久 dispatching」作为整体已不成立：表里有 owner/claim/heartbeat 字段，runtime 每 15 秒刷新心跳；但读侧结算只派生 `abandoned/stuck`、不改原始行，死亡后原始 `state` 仍可能停在 `dispatching`，本轮没有死亡案例可验证。
4. 「已收报告、未确认停止、过截止改 blocked」的代码机制仍在（`desktop-queue.ts:679`、`:695`），但需要检查路径被调用；run6 未触发。

**审查指出并已修正的证据表述**

| 项 | 修正前 | 修正后 |
| --- | --- | --- |
| `steps.1.plan.at` | `null`（读了不存在的 `agreement.capturedAt`） | `body_json.result.createdAt` |
| `steps.4.claim` | `runId/workerPid`（字段本就不存在） | `desktopPid/sessionId` 与原始键名 |
| `quotaStore` | `readable: true`（只查表名） | `provesAvailability: false` 并注明只证明表存在 |
| 面板样例 | 只有探测脚本 | 落盘 `panel-run6.json`（7 个端点的真实响应，含两个 503） |

**不可主张清单（原文保留）**

- 不能主张完整验收通过：`tasks.state=needs_review`、`reviewed_at=null`。
- 不能主张全工作区与 Git 未越界：命令记录的 `inputs/before/after` 仅覆盖 `hello.txt`。
- 不能主张额度可用、免费或实际费用已核实：`x0.03` 是报价，不是扣费记录。
- 不能主张进程死亡恢复已实测：派工行是 `submitted`，没有崩溃实验。（**2026-11-02 晚补做，见 §6.5 与 §6.6**：租约层与真实派工各杀过一次，结论见下。）
- 不能主张面板与资源接口已复核：本轮补了样例，但只是单次快照。

## 6.5 崩溃实验与读取接线（同日补做）

审查指出「没有死亡案例」，于是补做了租约层的崩溃实验，并顺带发现一个真缺陷。

**缺陷：恢复证据看不到派工日志。** 派工日志是独立 SQLite（`dispatch/<hash>/requests.sqlite`），而读取层却在任务库里找 `desktop_dispatch_requests` 表。实测：

| 身份 | 修复前 | 修复后 |
| --- | --- | --- |
| `desktop-send-eb3b7456-…` | `dispatch: null`（明明有行） | `state=submitted`、`settlement=lease_unavailable`、`settlementReason=not_pending` |

修法：`openWorkbenchReadStore(file, { dispatchFile })` 以只读连接打开日志文件，仅在任务库没有该表时回退查询；宿主 `workbench-desktop-host.mjs` 传入 `desktopJournal(config).file`。读取全程不写日志文件，派生值只在内存里。

**崩溃实验：主人进程被 SIGKILL。**

- 方法：子进程 `claim` 租约并每 4 秒心跳，父进程发 SIGKILL，然后用真实读取层查证据。
- 结果：磁盘上行仍是 `dispatching`（没有改写成终态）；派生为 `abandoned` / `owner_exited` / `ownerAlive=false`；读取前后行内容 `deepEqual` 一致；`workflow_capacity` 行未变（容量没被释放）。
- 附加用例：活着的 pid + 过期心跳（>180s）→ `stuck`/`heartbeat_expired`；待处理但无租约 → `lease_unavailable`/`no_lease_record`；不给日志 → `unknown_identity`。
- 测试：`gateway/workbench/test/dispatch-crash.test.mjs` 4 例全过；workbench 套件 41/41。
- 证据：`<workroot>\_wb-p05-state\run6\evidence-crash.json`。

**这一条仍不成立**：没有在真实派工中杀掉持有租约的进程。租约层是真实进程被真实杀死，生产行只做了字段核对（`owner_pid`、`claimed_at`、`heartbeat_at`），不是崩溃实测。

## 6.6 真实派工中途杀进程（run7）

租约层实验之后补做了一次真的：用生产宿主（`scripts/workbench-desktop-host.mjs`）提交真实派工，等它拿到租约后直接 `taskkill /F`。

| 项 | 值 |
| --- | --- |
| 任务 / 操作 / 请求 | `desktop-a9a8719f-…` / `desktop-send-8c3290dd-…` / `6ee0e139-…` |
| 模型与费率 | `deepseek-v4.1-flash-sg`，观察费率 x0.03（定价已核验） |
| 时间线 | commit `11:34:06.779Z` → claim `11:34:07.265Z`（owner_pid **17204**）→ 杀于 `11:34:15Z` |
| 死亡位置 | `preparationEnteredAt 11:34:14.780Z`、`dispatchEnteredAt null`：死在准备阶段，**原生尚未开始** |

杀掉之后，同一份证据里同时出现了两句话：

- 派工日志：`state=dispatching`、`owner_pid=17204`、`heartbeat_at=11:34:07.265Z`，**行内容一字未改**；
- 派生：`settlement=abandoned`、`owner_exited`、`ownerAlive=false`、`heartbeatAgeMs≈10.4s`；
- 任务仍是 `queued`，容量仍被这条操作占着（`capacityHoldsOperation=true`）；
- **但结论写的是「原操作仍在进行，等待回执」（`active`）**。

这就是这次真实验的真正收获：`conclusion` 只看 `task_operations.state=effect_started`，完全没看派工租约。同一屏里「主人已死」和「仍在进行」并存，用户会照着后者继续等。

**已修**：`workbench-read-store.mjs` 里 `conclusion` 在回落到 `active` 之前先看派工结算——`abandoned` / `stuck` 一律输出 `outcome_unsettled`（效果不可排除）。补两条回归用例：「死掉的租约主人绝不被说成 active」「活着的租约仍算 active」；workbench 套件 43/43。

**这一条要说清楚**：模型这次没有真的启动，所以没有产生副作用；这次验证的正是「系统自己也分不清有没有副作用」——这正是必须保留原请求与容量的理由。

## 6.7 真实死亡实验：杀进程到底有没有用（2026-11-02 晚）

上一节死在准备阶段。为了回答「已经产生副作用之后死掉会怎样」，又做了三次独立实验：模型 `deepseek-v4.1-flash-sg`（观察费率 `x0.03`），每次都是全新账本与空工作区，派工进入原生之后，用 `taskkill /F` 杀掉租约主人（宿主 node 进程）。

| 账本 | 杀掉时刻 | 杀掉之后副作用 | 账本 `tasks.state` | 运行目录 `state.json` | 容量 |
|---|---|---|---|---|---|
| run8 | `11:41:55.165Z` | `hello.txt` 于 `11:42:19.265Z` 出现（**+24s**） | `queued` | `needs_review`，原生停止 `11:42:53.821Z` | 仍占 |
| run9 | `11:46:07.321Z` | `hello.txt` 于 `11:47:01.521Z` 出现（**+54s**） | `queued` | 杀掉时 `working`；随后自行完成：报告认证 `11:48:23.355Z`、原生停止 `11:48:30.138Z` | 仍占 |
| run10 | `11:51:28.126Z` | 杀掉时文件已存在（模型约 90 秒写完） | `queued` | `needs_review`，原生停止 `11:52:30.575Z` | 仍占 |

**三条结论，都按原文记：**

1. **杀宿主 ≠ 停止工作**。宿主派生的队列 worker 与原生会话继续跑完，三次都拿到了完整报告与原生停止证据。派工行在提交后就 `settled`（`state=submitted`、`lease_unavailable / not_pending`），所以三次都**没有**触发 `outcome_unknown`——长时间工作根本不在派工阶段。
2. **副作用确实发生在“死亡”之后**：run8 差 24 秒、run9 差 54 秒，文件是真的写出来了。
3. **账本不会自己追平**：`tasks.state` 停在 `queued`；打开只读面板得到的不是“排队中”，而是 400 `EVIDENCE_STALE`（`Run evidence differs from the persisted revision; synchronise explicitly and retry`）。面板不肯复述假状态，这是诚实的；但它也没有同步入口，用户只能看到“过期”，容量继续被占着。

**没做到的一段**：想制造「报告已到、原生停止未确认」的窗口，但报告落盘与停止确认在同一个 worker 里连续完成，两次杀进程都没能截断。这一条仍按未覆盖计。

**方法论教训**：`owner_pid` 是宿主，不是执行者；真正的执行链是「宿主 → 队列 worker → 原生会话」。要证明“死亡会中断工作”，得杀对进程，而不是杀看起来持锁的那个。

## 6.8 停止窗口：报告已到、原生停止未确认（2026-11-02 深夜）

上一节缺的正是这个窗口。做法：盯住运行目录的 `worker-result.json`，一落地就杀进程——先只杀了宿主（run11），没截断；改成把该网关下所有 `node.exe`（两个 `service-cli.js run` 加宿主）一起杀（run12），才把窗口留住。

| 账本 | 报告落地 | 杀的时刻 | 杀掉之后 | 原生停止 |
|---|---|---|---|---|
| run11 | `12:06:36.119Z` | `12:06:38.184Z`（只找到宿主） | 15 秒后自行走到 `needs_review`，`nativeStoppedAt=12:06:51.974Z` | 有（窗口被补上） |
| run12 | `12:09:39.882Z` | `12:09:47.149Z`（`service-cli.js run` ×2 + 宿主，共 3 个进程） | `12:09:49.478Z` 状态变成 `needs_review` 且带 `reportDigest`，但 `nativeStoppedAt` **始终为 `null`** | **没有** |

run12 就是那个窗口：**报告在、停止没证实、状态已推进到待复核**。

同步账本之后读面板（只读宿主，`200`）：

```text
businessState  needs_review
displayState   waiting_stop
remoteStopped  false
blocker        null
allowedActions []
timing.nativeStoppedAt           null
presentation.report.authentication authenticated
```

**结论：判定是对的，出路是空的。**

- 对的地方：面板没有冒充“已停止”，`displayState` 直接写着 `waiting_stop`，`remoteStopped=false`；报告的“已认证”只说明报告本身完整，不代表原生停下来了。
- 缺的地方：`blocker` 是 `null`——页面会显示“等待原生停止”，却没有任何一句话说明**为什么**停不下来、**该去哪儿**确认；`allowedActions` 是 `[]`，一个可点的动作都没有；执行容量继续被这条任务占着（`workflow_capacity` 仍有 1 行）。

**方法教训**：一开始按 `desktop-worker-cli.js` 找目标，两次都找到 0 个——真正的执行链是「宿主 + 两个 `service-cli.js run` 进程」，`desktop-worker-cli` 只在收尾那一瞬间存在。

## 6.9 收口演练：核对 → 确认 → 释放（2026-11-02）

有了 §6.8 的窗口，还要回答“然后呢”。演练在**账本副本**上做（`drills/run6-drill`、`drills/run12-drill`），原始账本只读。

| 账本 | 可用动作 | 打错确认串 | 正确确认 | 任务状态 | 容量槽 | 数据库字节 |
|---|---|---|---|---|---|---|
| run6（报告 + 停止都有） | `["close"]`，`proof.close=native_stopped` | `AUTHORIZATION_REQUIRED`，哈希不变 | 成功 | `needs_review` → **`cancelled`** | 1 → **0** | 变化（成功写入） |
| run12（报告有、停止无） | `[]`，`proof.close=null` | 未到提问就被拒 | `RECOVERY_UNPROVEN` | 仍 `needs_review` | 仍 1 | **不变** |

三点值得记下来：

1. **确认串是真闸门**：打错一个字，命令在提问之后立刻失败，数据库哈希一模一样；没有任何“差不多就行”。
2. **关闭 ≠ 验收**：成功的 `close` 把任务写成 `cancelled`，容量释放，交付**没有被接受**。这正是它该有的含义。
3. **没有停止证据时，连收口都不允许**：`reconcile` 与 `close` 都返回 `RECOVERY_UNPROVEN`，容量继续被占。R10 的“永久占位”不是遗漏，是设计：系统宁可占着，也不在无证据时释放。

收口之后回到面板：`businessState=cancelled`、`displayState=cancelled`、`remoteStopped=true`，待处理卡**自动消失**（`attentionReason` 返回 `null`）。

**由此暴露的真缺口**：目前没有任何“人工核对后补写停止证据”的入口。原生自己没写，就永远补不上；人工看过的结论进不了证据链。这条已作为 R11 记入验证计划。

## 6.10 第二轮独立审查与修复（2026-11-02 21:00）

审查者：本机 Codex CLI（`codex-cli 0.166.0-alpha.5.1`，模型 `gpt-6.1-sol`，`--sandbox read-only`），只读，消耗 36,150 tokens，产出 `REVIEW_VERDICT.md`。

**判决：修完再合并。** P0 0 条，P1 2 条，P2 3 条；边界核查结论是「未见只读存储写入、未新增 HTTP 写端点、派生函数未改状态未释放容量」。

| # | 审查发现 | 处理 |
|---|---|---|
| P1-1 | `dispatch-settlement.ts:56` 存活只看 PID，未用 `owner_started_at`；PID 被复用且心跳未超期时仍返回 `live` | **不当作缺陷，补说明**：心跳过期即 `stuck`（已有实测用例）；PID 被复用后新进程不会替我们写心跳，所以「复用 + 心跳新鲜」在本系统的写入者身上不成立。Node 无法跨进程核对启动时间，`owner_started_at` 只作记录不作判定输入 |
| P1-2 | `workbench-read-store.mjs:130` 非终态操作在租约缺失、记录解析失败或完整性不一致时仍返回 `active` | **已改**：新增 `evidenceMissing = integrity !== 'verified'` 与 `dispatchUnrecorded = state === 'effect_started' && !dispatch`，两者都归 `outcome_unsettled`；合成账本实测 `effect_started` + 无派工记录 → `outcome_unsettled` |
| P2-1 | `attention.mjs:36` 标题说停止证据不完整，下一步却说“停止已确认” | **已改**：新增 `review_pending_unstopped`（“先核对停止，再谈独立审查”），配新用例 |
| P2-2 | `attention.mjs:100` 确认串提交前 `trim()`，首尾空白仍能通过 | **已改**：比较与提交都用原始输入，不做修剪 |
| P2-3 | `DesktopControlPolicy.cs:64` `statement` 只查长度，允许控制字符 | **已改**：拒绝控制字符（保留 `\n`、`\t`），新增两条 C# 用例（拒绝 `\u0007`、接受两行） |

**审查之外，自查出一个更该记的问题**：交付时清单是 555 条，而本批新增的 9 个文件**不在清单里**。原因是生成器只扫 git 索引，那 9 个文件当时还没进索引；`git apply` 后它们会变成已跟踪文件，清单却永远缺它们。重打后为 **564** 条。

> 教训：`verify-snapshot` 的 555/555 只证明“清单里列的都一致”，不证明“该列的都在清单里”。完整性是另一件事，得单独核。

复审后的数字：`npm run build` exit 0；`npm run test:workbench` **55/55**；`npm run desktop:test` **52 passed / 0 failed**；`verify-snapshot` **564 文件哈希一致**。

仍未复跑：全量 `npm test`（上一轮 852 条里 839 通过、7 条与本批无关的红）。

## 6.11 全量测试对照：这批改动到底动了什么（2026-11-02 21:40）

之前所有测试数字都是「挑着跑」的。这一轮把 `npm test` 在**两个工作区**各跑一遍：干净克隆（`34fcb1b`，无补丁）与本副本（打了本批全部改动）。同一台机器、同一 Node、同一套环境变量。

| 工作区 | 条数 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|
| 基线（34fcb1b，干净克隆） | 810 | 787 | **17** | 6 |
| 本批（34fcb1b + 全部改动） | 856 | 843 | **7** | 6 |

**基线那 17 条红里，有 10 条被这批改动修好了**：

| 基线红 | 为什么基线会红 | 本批为什么能过 |
|---|---|---|
| bounded 执行器 5 条（参数保真、取消文件、正常退出清理、嵌套 Job 取消、`intentional hang`） | 本机 PowerShell `CurrentUser=RemoteSigned`，`powershell -File bounded-job.ps1` 直接被策略挡，监督进程根本没起 | `-ExecutionPolicy Bypass` 只对该子进程生效（§5） |
| T6 独立审查 4 条 + desktop review 1 条 | 审查步骤本身要跑受管命令，命令起不来 → 检查器拿不到证据 | 同上 |

**剩下 7 条，两边一模一样，没有一条是本批新增**：

- 5 条 Unix socket / registry（`authenticated Unix socket RPC…`、`registry selection…`、`socket timeout…`、`stale registry from a dead pid…`、`MCP health…`）——Windows 上 Unix 域套接字这套场景跑不通，报 `listen EACCES …\host.sock`；
- 1 条 `all Node launchers load the shipped example config…`——启动器是无扩展名脚本，Windows 上 `spawn` 不会按 PATHEXT 解析，报 `ENOENT`；
- 1 条 `intentional hang and its detached child end within bound…`——全量并发下超时（7 秒级等待被抢光）。单独跑该文件三次都是 6/6，说明是负载抖动，不是逻辑错。

**过程里也踩了一个自己挖的坑**：第一次全量忘了设 `WORKBUDDY_CLI_ELECTRON` / `WORKBUDDY_CONFIG_DIR`，168 条因为 `loadConfig` 抛「Multiple WorkBuddy installations」全红。那次运行作废重跑，没有混进上面的数字——但它说明「全量红了一片」不一定是代码坏了，先看错误文案是不是同一条环境报错。

对照数据落盘在 `_wb-p05-state/run9/fulltest-comparison.json`（交付包内为 `evidence/fulltest-comparison.json`）。

## 6.12 R1：跑到一半被杀，系统会不会撒谎（2026-11-02 22:00–22:20）

问题只有一个：**工作做到一半、进程被杀掉之后，账本和界面会不会说「完成了」。**

三次真实派工，每次都是同一套流程（预检 → 原生建会话 → 桌面登记 → 派工 → 有界命令 → 报告 → 停止确认），差别只在杀谁、什么时候杀。

| 实验 | 杀什么、什么时刻 | 之后发生了什么 | 账本最后怎么说 |
|---|---|---|---|
| run13 | 只杀宿主（pid 35908），13:58:50，`hello.txt` 已写出、两条命令都已跑完 | worker（`desktop-worker-cli` pid 31484）活着，把两条命令跑完；22:00:36 才被补杀 | 报告 14:00:58.404Z 通过认证，原生停止 14:02:29.537Z，`needs_review` |
| run14 | 只杀宿主，14:05:32，`Start-Sleep 120` 正在跑（该命令边界 60s） | 超时自己收尾：`exitCode=124`、`reason=timeout`、`cleanupConfirmed=true`，记录已写；14:06:18 补杀 worker | 报告 14:07:15.252Z 认证，停止 14:07:39.343Z，`needs_review` |
| run15 | 宿主 33240 与两个 worker，14:11:40 / 14:11:45，第二次调用刚开始（14:11:36.826）、第三次还没发起 | 工作没停：14:14:17 又起了一次（`d8919f29`），30s 边界到点 `124`/清理确认；14:15:54 写回 `worker-result.json`，14:16:04 报告通过认证 | run `needs_review`；**任务仍是 `queued`**（没人做显式同步） |

**四条结论。**

1. **三次都没有出现「没做却说完成」。** run15 的报告是模型自己跑完写的（本地命令、哈希一致、附了未完成记录的说明）；run13/run14 的报告分别出现在被杀之后 68 秒和 103 秒，都有 `reportAuthentication` 记录。没有一条是「被杀的进程替自己补的」。
2. **账本比进程慢，但不比证据快。** 任务状态一直停在 `queued`，直到有人显式同步；同步之前面板返回 `400 EVIDENCE_STALE`，并明写 `This query performed no write.`。
3. **半截命令记录这次真的出现了。** `e677880b`（起于 14:11:36.826、边界 30s）在杀掉宿主与 worker 之后停在 `state: "running"`，`supervisorPid: 36084` 已消失，没有 `endedAt`、没有 `exitCode`。把它喂给停止围栏 `ownedCommandStopReason()`，返回 **`no_end_evidence`**——系统没有把「没写完」当成「已清理」，收口会被挡住。这是 D-4 那条缝第一次在真实数据上被踩到。
4. **杀宿主不等于停机，而且「我以为杀干净了」也不等于干净。** run15 里我杀掉宿主与两个 worker 之后，`state.json` 的心跳仍在前进——不是因为有人在硬撑门面，而是因为真的还有进程把工作推到结束。心跳在前进不能当成「有人在管」，但反过来，我说「杀完了」也不能当成「已经没人了」。

**顺带否掉了一个自己的怀疑**：`cleanupConfirmed: true` 写进记录时，子进程是否还活着？用 `runBounded` 直接跑 `Start-Sleep 30`、边界 5s，记录落地后每 250ms 探一次 pid——探针在那一刻就是 `ESRCH`（0ms）。早先那次「确认之后进程还在」的观测，是把「超时窗口内仍在运行」看成了「清完之后仍在运行」。这条不再列为疑似缺陷。

**这一轮没做到的事**：没有观测到「被杀之后有人在后台替它补一个 `cleanupConfirmed: true`」——希望是因为不存在，而不是因为没撞上。记录落盘在交付包 `evidence/kill-mid-work-attempts.json`。

## 7. 未完成项

1. **产品内 t6 审查**：需要控制通道（`task_reviews`），stage-2 面板只读，必须走桌面壳同源私有命令 + 原生确认。
2. **崩溃现场**：准备阶段（§6.5、§6.6）、副作用之后（§6.12 run13/run14）、命令执行中（§6.12 run15，`e677880b` 停在 `running`）都已有真实样本；仍缺「被杀之后记录被谁补完」的反面证据。
3. **第二台物理机**：Issue #3 仍未做。
4. **额度**：503 只说明不可读，何时能读到真实余额仍未确定。

## 8. 复现步骤

```text
1. 全新账本：WORKBUDDY_DB_FILE=<state>\run6\workbuddy.db，WORKBUDDY_RUNS_DIR=<state>\run6\runs
2. 归档 gateway\data\persistent-service*.json 与 service-logs（否则 workerRegistration 拒绝启动）
3. WorkBuddy 用 --remote-debugging-port=18491 启动（open-debug-18491.cmd，CRLF 批处理）
4. 壳：WorkBuddy.Workbench.exe --gateway-dir <gateway> --node F:\node.exe --database ... --runs-dir ...
   env: DESKTOP_DISPATCH_ENABLED=1、PINNED_MODEL=deepseek-v4.1-flash-sg、WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
5. node prefill.mjs <workspace> <title> deepseek → 人工在原生窗口确认
6. node poll-run6.mjs 观察 claim → worker-result → needs_review
7. node sync-run6.mjs 把证据绑回账本（tasks.state → needs_review）
8. node evidence-run6.mjs → run6\evidence-run6.json；node finalize-run6.mjs 回填第 8 步
```
