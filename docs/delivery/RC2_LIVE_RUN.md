# RC2 真实安装与单次派工（集成人执行，2026-11-06）

用户决定：「1.好，那就真实重装并派一单 2.不补做了 3.按你的建议来，怎么好怎么来」。
对应执行：在 RC2 候选包上新装一个安装根，用 WorkBuddy 桌面通道派一单；五张未做卡（R1/R2/R5/R9/R10）不补；不推送、不合 main、不发布、不部署；`config.toml` 不合；许可位置留权利人。

## 1. 授权边界

| 项 | 状态 |
|---|---|
| 真实安装（新根） | 已授权并执行 |
| 真实派工 | 已授权，执行一次（模型由用户选定，见 §4） |
| 生产政策/生产配置 | 未改 |
| 推送 / 合 main / 发布 / 部署 | 未做 |
| 旧 RC1 安装根 | 未删除、未改写；只读取其 `.env` 与清单作为安装参数来源 |
| Codex 的 MCP 配置 | 未改（`setup` 从不覆盖，只写片段；返回 `mcpConfigModified:false`） |

## 2. 安装

- 候选：`gateway\outputs\release\codex-workbuddy-gateway-v0.7.1.zip`，694 文件 / 2 236 003 字节 / `sha256 9e146b93fe40ff3b7086e4117c89dd0e2b81f81c61a585cfba4b003ef4411eee`（即 RC2）。
- 安装根：`E:\javaproject\workbuddy-install\gateway-v0.7.1-rc2`（新建；压缩包自带顶层同名目录，已上移一层得到 695 个文件）。
- 依赖：`cmd /c "npm ci --omit=dev"` exit 0，`added 94 packages`（`zod` 就位）。
- 预演：`setup("plan")` exit 0 —— `changed:false`、`envWillBeCreated:true`、`mcpConfigModified:false`。
- 应用：`setup("install", {apply:true})` exit 0 —— `changed:true`、`unchanged:false`；写 `.env`、`data/workbuddy-mcp.toml`、`data/deployment-installation.json`；`installedAt 2026-11-06T08:23:09.782Z`；`snippetHash 3657dcac47dac5abcc7d6ef7602bb494b15705acd22dd53d72f0f3dd4f22e0f5`（RC1 为 `abdcfc7a…`，因为根路径不同）。
- 技能位：`C:\Users\LENOVO\.codex\skills\workbuddy-executor` 六文件哈希与清单逐条一致（与 RC1 的六文件相同，故本次未产生新备份，`skillBackup` 为空；RC1 的备份 `workbuddy-executor-I5FgPH` 仍在）。
- `.env` 追加（在我这一侧显式记录）：`WORKBUDDY_DSH_ENABLED=0` —— 本次只走 WorkBuddy 桌面队列，不需要 DSH 桥接宿主。
- 安装参数（从 RC1 `.env` 读出，未手抄）：`WORKBUDDY_CLI_ELECTRON="F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe"`、`WORKBUDDY_CONFIG_DIR="C:/Users/LENOVO/.workbuddy-ai"`、`CODEX_HOME=C:\Users\LENOVO\.codex`。

## 3. 安装实例的零费用复核

用**已安装实例自己的 `dist`** 重放两处拒绝（不是候选包、不是集成树）：

| 场景 | 期望 | 实测 |
|---|---|---|
| R6 原生会话改绑到另一个项目 | `AdmissionError` / `WORKSPACE_CONFLICT` | `name=AdmissionError`、`code=WORKSPACE_CONFLICT`、`failureCause()=WORKSPACE_CONFLICT`、`workersAfter=1`、文案未变 |
| R8 轮数上限耗尽后再次返工 | `AdmissionError` / `ATTEMPT_LIMIT` | `name=AdmissionError`、`code=ATTEMPT_LIMIT`、`failureCause()=ATTEMPT_LIMIT` |

`verdict: both refusals carry stable codes`，exit 0（`outputs\finish-integration-20261105\G3-fix\run\installed-replay.json`）。
即：装上去的字节确实带修复，不只是候选包层面。

## 4. 单次真实派工

- 执行器/来源：`workbuddy` / 本机 WorkBuddy 桌面队列（`desktop-queue`），真实客户端进程在运行。
- 模型：`deepseek-v4.1-flash-sg`（面板 `credits x0.11`，**相对倍率标识，不是金额**；真实扣费以面板为准，我不把它当免费额度或硬上限）。
- 推理档：`null`（该模型目录未提供 `reasoningEfforts`）。
- 模型目录：安装实例 `workbuddy_list_models` 23 条，`deepseek-v4.1-flash-sg` 在列；实例 `codeHash 7c94cb1f4166ee06f2aa598b41856f16078d48e075c4422c6ef5c9f90f176b34`。
- 工作区：`E:\javaproject\outputs\finish-integration-20261105\rc2-live\workspace`（新建，仅 `README.md`）。
- 目标：只新增 `rc2-check.txt`，内容一行 `RC2-LIVE-OK`；附一条验收命令（读取该文件并断言内容）。

### 4.1 第一次尝试被拒（并暴露一个容量缺陷）

`taskId rc2-live-20261106`、`sessionMode:"new"` → 任务 `blocked`：

> `Use workspace or ensure_workspace for native project routing; sessionMode:new is not supported by the queue`

随后立即出现的后果（**这是本轮新发现的缺陷**，RC1 未覆盖）：

1. 一个在准入阶段就被拒、从未发生任何原生派工的任务，仍然占住 `workflow_capacity` 的单槽；
2. 下一次 `send_task` 直接 `{"code":"CAPACITY_OCCUPIED","error":"An original workflow remains open or uncertain."}`；
3. `workbuddy_cancel_task` 返回 `ok:true` 但 `cancellationRequested:false` / `remoteStopped:false` / `executionState:"stop_unconfirmed"`，任务仍是 `blocked`，`cancelNote` 已写入，**槽位不释放**；
4. `recovery-cli show` 显示该操作 `state:"succeeded"`、`available:[]`、`proof.reconcile/close` 均为 `null`、`capacity` 指向该 blocked 任务。

处置（只针对本次测试安装，不是产品修复）：先把 `data\tasks.sqlite`（249 856B）整库复制到 `G3-fix\live-rc2\evidence\blocked-capacity\`，再把库文件移出 `data\`，让实例用新库继续。原始库保留为缺陷证据（`tasks.sqlite.blocked-capacity`）。

记为 **F-CAP-1**：准入拒绝也会占用单槽；取消不释放；恢复面没有可用动作。与 10 的 R4/R6 是同一族（blocked/取消后容量挂着），但触发点更早、代价更低（连原生副作用都没有）。

### 4.2 第二次尝试成功

`taskId rc2-live-20261106b`、`sessionMode:"existing"` + `workspace`：

- `send_task` → `ok:true`、`created:true`、`state:"queued"`、`sessionId 39afd554-3a3e-4472-8bae-e38fb3385332`、`attemptId run-de1afbd3-571a-4533-885e-3819146f0882`、`operationId compat:send:rc2-live-20261106b:9c9f2422…`。
- `wait` 第 1 轮：seq1 排队、seq2「已验证的原生 WorkBuddy 桌面会话领取了该任务」（`working`）。
- `wait` 第 2 轮：seq3 结果 —— 只新增 `rc2-check.txt`，自报「11 字节、无 BOM、无尾随换行」「README.md 未改动」「验收命令 `exitCode=0`、`cleanupConfirmed=true`」。
- `get_task`：`state:"needs_review"`、`attempt:1`、`artifacts` 含该文件、`nativeStoppedAt 2026-11-06T08:28:13.793Z`（原生空闲已验证）、`revision KCL9_pmCfU07YdtN`。

### 4.3 集成人独立核验（不看执行器自述）

| 项 | 实测 |
|---|---|
| 文件 | `rc2-check.txt` 11 字节 |
| sha256 | `cfb99eca7087b9d796bb7bcfc86832215311e6494531db609f67c5d475addd89` |
| 内容 | 恰为 `RC2-LIVE-OK`（无前后空白） |
| 验收命令手工重跑 | exit 0 |
| `README.md` | 124B 未改（mtime 仍 16:24:59，sha256 `6cb9bfcf7b729b55e46c871c90ab0ce5f9802a226f49b223e78f43dcc7d82e66`） |
| 其它文件 | 工作区内无新增/改动 |

`workbuddy_record_inspection` 记录了这次检查：`evidenceId inspection-e468e8ce-c33b-46b0-beaf-3dc0ca0eb058`，`revision H2vSynKHLpZM8_VSwsHiS7LA`。

### 4.4 没有走完 review/accept（结论已在 RC3 轮更正）

`workbuddy_review_task` 要求 `machineCheckIds`（长度必须为 1），本次通过 MCP **没有**生成 `reviewId`，也就没有 `accept_task`。

当时的推断是「MCP 工具面没有 `checks()` 入口」。**这个推断是错的**：RC3 轮流调查确认已安装的 `dist/server.js` 里有 `workbuddy_check_task`（`tasks.reviewChecks` → `store.reviews.checks`）。用已安装 RC2 的 `dist` 对派工后的库副本重放，`checks()` 正常返回批次 `machine-95d5a843-1e46-44c9-8ce5-57346e00aa8c`，三项检查为 `$provenance passed`、**`$scope failed`**、`legacy-command-1 unknown`。

所以真实障碍是：

- 本单在正文里新增了 `rc2-check.txt`，而契约的 `scope.allowedChanges` 只声明了 `src/**`，于是 `$scope` 判失败（与 4.5 的 F-CONTRACT-1 是同一件事的两面）；
- 失败 note 当时只有通用文案「T5 inventory and original user changes」，看不出是哪条路径，掩盖了上面这个原因。

`F-ACC-1` 因此更正为「**诊断不可发现 + 契约与正文不一致**」，而不是「MCP 缺入口」。RC3 已针对这两点做修复（见第 8 节）。

结论与影响：

- 本单停在 `needs_review`，**不是 accepted**；不得写成「RC2 已验收」。
- 该单继续占着新库的单槽（与 F-CAP-1 同族）；RC2 的代码里取消关不掉它，RC3 起可以（见第 8 节）。

### 4.5 执行器报告的一处契约歧义

执行器自述：任务正文允许新增 `rc2-check.txt`，但网关附带的 legacy 说明称「本提交未声明结构化范围、只读、不得新建工作区文件」，两者冲突；它按正文与工作区 README 执行。若网关以空 `allowedChanges` 判定，该新增可能被判越界。

记为 **F-CONTRACT-1**（文案/契约不一致，需在下一轮统一：要么自动把目标里的显式文件名折成 `allowedChanges`，要么在提示里不要说「只读」）。

## 5. 结果状态

| 项 | 值 |
|---|---|
| RC1 live 证据 | 只属于 RC1（`658a20b1…`） |
| RC2 安装 | 已完成（新根，未影响 RC1） |
| RC2 派工 | 已完成一次，结果为 `needs_review` |
| RC2 accepted | 未达成（原因见 4.4 更正后的 F-ACC-1） |
| RC2 其它卡（R1/R2/R5/R9/R10） | 用户决定不补 |
| 推送 / 合 main / 发布 / 部署 | 未做 |

## 6. 复现要点与坑

- 解包 RC2 后包根是 `...\gateway-v0.7.1-rc2\codex-workbuddy-gateway-v0.7.1`，装之前要么上移一层，要么直接把子目录当安装根。
- 解包目录必须先 `npm ci --omit=dev` 才能启动（否则 `Cannot find package 'zod'`）。
- PowerShell `Set-Content -Encoding UTF8` 会写 BOM，`JSON.parse` 直接失败；写 JSON 载荷一律用 `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))`。
- PowerShell 会把原生命令的双引号参数吃掉；CLI 参数一律走 `@file`。
- `$pid` 是只读自动变量，别拿来装进程号；停进程按端口 `Get-NetTCPConnection -LocalPort ... -State Listen` 取 `OwningProcess` 再 `Stop-Process`。
- 候选包解包目录一旦跑过 `npm ci` 就被污染（4099 文件），复现请解到全新空目录（11 的 K7）。

## 7. 证据位置

- 安装与派工原始输出：`outputs\finish-integration-20261105\G3-fix\run\`（`plan-rc2.json`、`install-rc2.json`、`installed-replay.json`、`send-task*.json`、`wait-1/2.json`、`get-task.out.json`、`inspect.out.json`、`cancel-a.out.json`、`models-rc2.json`）。
- 安装根快照副本：`outputs\finish-integration-20261105\G3-fix\live-rc2\`（`.env`、`deployment-installation.json`、`workbuddy-mcp.toml`、派工后库副本、日志合集）。
- 缺陷证据：`live-rc2\evidence\blocked-capacity\`（被阻塞任务占用槽位的整库）。

## 8. RC3 修复与验证（2026-11-06，同一集成人）

### 8.1 F-CAP-1：从未派工的任务取消即关闭并释放单槽

改动（`gateway/src/operation-admission.ts`、`gateway/src/coordinator.ts`）：

- `isClosed()` 增加第三条闭合路径：任务为 `cancelled` 且存在 `task_closed` 事件、`source_ref` 恰为 `never_dispatched:<attemptId>`。
- 新增 `neverDispatched(taskId, attemptId)`：操作不含 `effect_started`/`outcome_unknown`、没有 `effectStartedAt`/`dispatchEnteredAt`、该任务没有任何 `task_closed` 事件。
- 新增 `closeNeverDispatched(...)`：在一个事务里把任务置 `cancelled`、清 `blockingReason`、写 `task_closed`（`closure:"never_dispatched"`）、删 `workflow_capacity`。
- `requestCancellation` 先走该分支；`finishCancellation` 对它返回 `closed:true`、`capacityReleased:true`、`remoteStopped:false`、`executionState:"never_dispatched"`，并明说「这不是原生停止证明」。
- `CAPACITY_OCCUPIED` 文案补上占用任务 id，并指向 continue/cancel。

刻意**没有**做的：把 `blocked` 自动改成 failed/closed。既有测试「a rejected queue dispatch remains inspectable and can be corrected without losing its task」依赖「拒绝后仍可 `continue` 纠正」，自动关闭会破坏它。

### 8.2 F-ACC-1：让失败可发现、让入口可发现

- `task-reviews.ts` 的 `$scope` note：有 `scope.error` 用它；否则列出未授权变更（如 `Unauthorized workspace changes: added rc2-check.txt`，最多 5 条）；都没有时才用原通用文案。
- `review()` 的 `INVALID_REVIEW` 文案追加 `call workbuddy_check_task first to create that batch.`。
- `server.ts` 两个工具描述：`check_task` 明说返回 `workbuddy_review_task` 需要的 `machineCheckIds`；`review_task` 明说批次来自 `workbuddy_check_task`。

未改的：F-CONTRACT-1（正文与 `allowedChanges` 的冲突）本轮不动语义，只在 `$scope` 上把原因说清楚；是否自动把正文显式文件名折成范围，留待下一轮决定。

### 8.3 检查（隔离环境同前，日志 `outputs\finish-integration-20261105\G3-fix2\logs\`）

| 检查 | 结果 |
|---|---|
| `npm run build` | exit 0 |
| 受影响 15 个套件（coordinator/deepseek-coordinator/deepseek-server/desktop-control×3/desktop-queue/finish-acceptance×2/queue-reliability/t3/t4a/t4b/task-application-service/task-reviews） | 218 tests / 217 pass / 0 fail / 1 skipped / exit 0 |
| `npm run test:workbench` | 139/139 exit 0 |
| `npm test`（全量） | 1284 tests / 1272 pass / 0 fail / 12 skipped / exit 0 |
| 新增用例 | 「a cancellation before native dispatch closes the workflow and frees shared capacity」、「T5 machine checks name the unauthorized workspace change instead of a generic scope note」 |

### 8.4 RC3 候选与运行探针

- 包：`gateway\outputs\release\codex-workbuddy-gateway-v0.7.1.zip`，**694 文件 / 2 239 631 字节 / sha256 `4021310ca255497a4bf276f030dc656f24c3e7216ee094220a95766a49562632`**（RC2 为 2 236 003 / `9e146b93…`）。
- 解包 `verify-release` → `{version:"0.7.1", verifiedFiles:694, hashesMatch:true}` exit 0。
- `check --expect-sha256 4021310c…` → `ok:true`、files 694、problems 0、totalBytes 7 292 282。
- `version-check` → `matches:true`、`exact:true`、`matched:694`。
- `drill --apply` → steps 4/4、checks 全 true、negatives true；`upgrade-drill --apply` → steps 17/17、checks 全 true、negatives true。
- 运行探针 `outputs\finish-integration-20261105\G3-fix2\probe\fcap1-rc3.mjs`（对解包包的 `dist` 跑合成库，不碰真实安装）：7 步全 true，`verdict:"F-CAP-1 closure releases capacity on RC3"`，exit 0 —— 依次验证拒绝、blocked、取消后 `closed/capacityReleased/remoteStopped:false/never_dispatched`、任务变 `cancelled`、`workflow_capacity` 归零、`task_closed` 的 `source_ref` 是 `never_dispatched:<attempt>`、随后一单能正常派发。

### 8.5 边界

- RC2 的真实证据只属于 RC2；RC3 目前只有合成检查 + 运行探针，**没有**在 RC3 上重装或派工。
- 上一次真实派工留下的 `needs_review` 任务仍在 RC2 安装根的库里；RC3 的修复可以在同类新库上生效，但要让那条历史任务关闭需要用户授权在真实安装根上操作。
- 未推送、未合 main、未发布、未部署。
