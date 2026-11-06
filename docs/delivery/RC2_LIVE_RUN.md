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

### 4.4 没有走完 review/accept（如实记录）

`workbuddy_review_task` 要求 `machineCheckIds`（长度必须为 1），该 id 只能由可信协调器路径（`task-reviews.js` 的 `checks()`）产生；MCP 工具面没有暴露这个入口（`workbuddy_run_review_command` 只产出单条命令证据，不产出批次）。因此本次通过 MCP **无法**生成 `reviewId`，也就无法 `accept_task`。

结论与影响：

- 本单停在 `needs_review`，**不是 accepted**；不得写成「RC2 已验收」。
- 该单继续占着新库的单槽（与 F-CAP-1 同族），我没有再动它。
- 记为 **F-ACC-1**：从 MCP 工具面到不了「程序检查批次 → review → accept」的完整链路；要验收必须走桌面控制通道（客户端 UI 的确认流程）。10 的 review 是由那条路径产生的，不是 MCP。

### 4.5 执行器报告的一处契约歧义

执行器自述：任务正文允许新增 `rc2-check.txt`，但网关附带的 legacy 说明称「本提交未声明结构化范围、只读、不得新建工作区文件」，两者冲突；它按正文与工作区 README 执行。若网关以空 `allowedChanges` 判定，该新增可能被判越界。

记为 **F-CONTRACT-1**（文案/契约不一致，需在下一轮统一：要么自动把目标里的显式文件名折成 `allowedChanges`，要么在提示里不要说「只读」）。

## 5. 结果状态

| 项 | 值 |
|---|---|
| RC1 live 证据 | 只属于 RC1（`658a20b1…`） |
| RC2 安装 | 已完成（新根，未影响 RC1） |
| RC2 派工 | 已完成一次，结果为 `needs_review` |
| RC2 accepted | 未达成（见 F-ACC-1） |
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
