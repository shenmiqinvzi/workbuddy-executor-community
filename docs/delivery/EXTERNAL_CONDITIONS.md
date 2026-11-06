# 外部条件清单（真实验收 10 线）

本文件回答一件事：**这一轮真实验收里，哪些事不是代码问题，而是必须由用户在本机、用真实资源、当面决定才能推进的外部条件。**

- 生成时间：2026-11-06（Asia/Shanghai）
- 工作树：`E:\javaproject\workbuddy-finish\F10-live`
- 分支 / HEAD：`docs/live-acceptance` / `91af89ee9d5a3358f65a6e0e7699c9100f91d732`
- 只读采集的原始证据（不入包、不进仓库）：`E:\javaproject\outputs\finish-live-20261106\`

每一项按四件事写：**实际缺什么 → 用户最小动作 → 对应产物/范围 → 可继续的独立工作**。

## 本轮结论（2026-11-06 更新）

| 条目 | 当前状态 |
|---|---|
| E01 安装 | **已解决**：RC 已装到 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1`，`doctor` 的 `codeHash` = `ac2a673f…`（= RC 清单） |
| E02 技能 | **已解决**：`CODEX_HOME` 六文件已与 RC 逐字一致，旧版备份 `workbuddy-executor-I5FgPH`；`deepseek-executor` 两文件已装 |
| E03 工具 | **已解决**：走包内 `scripts/workbuddy-call.mjs`（自起 server），本轮全程用它，未改 `config.toml` |
| E04 DSH | **已解决**：`WORKBUDDY_DSH_ENABLED=1`，DSH 技能已装，真实派工 1 单已被接受 |
| E05 容量 | **已解决（自建库）**：本轮用新库 `workbuddy-install\gateway-v0.7.1-rc1\data\tasks.sqlite`，派工前 `workflow_capacity` 0 行；T7B 与 P0-1 未动 |
| E06 政策 | **不适用本轮**：新库不继承 T7B 的 allowlist+requireFree，取默认 `user_choice`/`requireFree:false` |
| E07 选择 | **已解决**：DSH（dsh / wb-proxy / deepseek-v4.1-flash / high / credits x0.00 观测）+ WorkBuddy（workbuddy / workbuddy-native / deepseek-v4.1-flash-sg / null / credits x0.11 相对倍率），两单均已授权并接受 |
| E08 桌面壳 | 未变（0 进程、无窗口证据） |
| E09 异常卡 | **部分解决**：R7 / R4 / R8 / R6 / R3 五张已真实跑完（第 6 节有事件链）；R1/R2/R5/R9/R10 五张未做，理由见总结第 6.6 节 |
| E10 异机 | 未变（无第二台机器） |
| E11 许可/签名 | 未变（未决） |
| E12–E15 | 未变 |
| **E16（新增）** | **已解决本轮**：你在自己的 PowerShell 里带 `WORKBUDDY_REMOTE_DEBUGGING_PORT=18491` 启动后，18491 LISTENING、目录 23 条可读、WorkBuddy 1 单真实通过；该依赖仍长期存在（每次读目录/派工都要带该变量或保持已 attach 的实例）。已提供 `E:\javaproject\workbuddy-install\start-workbuddy-debug.ps1` 把这一步固定下来 |
| **E17（新增）** | **已决定 2026-11-06：本轮不合并**。片段留在 `<root>\data\workbuddy-mcp.toml`，合并预览留在 `evidence\codex-config-preview\`；`C:\Users\LENOVO\.codex\config.toml` **始终未被写入**（仍 7,449 字节、0 处 `workbuddy_rc`） |
| **E18（新增）** | **已决定 2026-11-06：保留**。第一单派工后网关自登记了常驻服务（`data\persistent-service.json` + `PID 11672`），把任务库钉在安装根上；换库会被 `dist\workspace-manager.js:25-28` 拒绝。留=只能用一个库，撤=`service-cli uninstall`（原生自动唤醒也一并消失） |
| **E19（新增）** | **已决定 2026-11-06：按 T7D 口径保留原样**（只读复核确认 `available: []`，`close`/`reconcile` 会抛 `RECOVERY_UNPROVEN`）。缺陷本身：R6 的外来会话被拒时抛无 code 的普通 `Error`，任务落 `blocked`、操作 `outcome_unknown`、容量被占、阻塞原因无因由（`dist\workspace-workers.js:97` + `failureCause()` 只认规范 code）。处置：保留，或用 `recovery-console.js close … --reason` 记一条人工声明 |

---

## E01 候选包从未落盘安装；三台"0.7.1"安装的代码互不相同 —— **本轮已解决**

**实际缺什么**
磁盘上没有一个安装位等于本轮 RC 的代码。用 `gateway/src/runtime-version.ts:1-11` 的算法（对 `dist/**/*.js` 按路径排序后聚合 sha256）逐位重算，`packageVersion` 全是 `0.7.1`，`codeHash` 却各不相同：

| 安装位 | 版本 | dist js | codeHash |
|---|---|---|---|
| T7B-preview（服务在跑，当前聊天 MCP 指向它） | 0.7.1 | 93 | `8427e9e1a4999a4301eb4d109e35ba383d20856eba69b286ba422a50b6e3d58c` |
| `workbuddy-executor-community` | 0.7.1 | 55 | `d5529e49afe3c6b8b7930374ba538fcf7a61896b1cf758ac548d26125c62d833` |
| `workbuddy-integrated-validation-20261019` | 0.7.1 | 49 | `8110503b3ad6134ea8f44540d5c7ba8fb121488497ee61ed9e82bdaa1391a0c6` |
| `F:\WorkBuddy\codex-workbuddy-gateway` | **0.7.0** | 44 | `a365d16723bdf840028364df3c1b4c11471dc74dd12874ecd1abbaeed5025118` |
| RC 解包候选（未安装） | 0.7.1 | 116 | `ac2a673f187546dc9d00c7a20a56ad6fad86adf54a2b0e90d22d1fbcd681e326` |

→ 以"都是 0.7.1"推断同代码不成立。T7B 运行中的 `persistent-service-status.json` 自报 `codeHash 8427e9e1…`，与其磁盘 dist 一致，可确认它是 T7B 那套旧代码，不是 RC。

**用户最小动作**
在 `F:\` 或其他空目录解包 `codex-workbuddy-gateway-v0.7.1.zip`（sha256 `658a20b196051fa25be1c669bb9b5c5574216cd30a6b223bd07efe2e90ba11b8`），`npm ci --omit=dev`，然后运行 `candidate-installation.mjs preview` 看差异清单，最后显式说"同意安装到 `<install-root>`" 或 "先用现有安装继续"。不需要动现有安装位。

**对应产物/范围**
`gateway/docs/INSTALL_WINDOWS.md`；RC 包内 `scripts/candidate-installation.mjs`（preview/drill/upgrade-drill/rollback-plan 全部只读）；安装动作范围仅：解包目录、`gateway/.env`（仅当不存在时创建）、`gateway/skills/**`、`gateway/data/workbuddy-mcp.toml`、`gateway/data/deployment-installation.json`。

**可继续的独立工作**
包完整性、清单、drill 已在 G3 全绿；不安装也能做：证据索引、第二机器依赖清单、异常卡脚本预演（合成库）。

**→ 本轮结果（2026-11-06）**：已按你的决定装到 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1`（新目录、不动 T7B），`verify-release` 694/694、`doctor` 报 `codeHash ac2a673f…`。安装根已含 4098 文件 / 21MB。本机现在有两套 0.7.1 代码：T7B 的 `8427e9e1…` 与 RC 的 `ac2a673f…`，互不影响。

---

## E02 已安装技能与 RC 技能不一致（4/6 文件不同），DSH 技能根本没装

**实际缺什么**
`C:\Users\LENOVO\.codex\skills\workbuddy-executor`（mtime 2026-11-04T16:06:15）与 RC 包 `skills/workbuddy-executor` 逐文件比对：

| 文件 | 已安装 | RC | 结论 |
|---|---|---|---|
| `SKILL.md` | 10108B `8D902679…` | 13978B `5A485AF7…` | 不同 |
| `references/dispatch.md` | 8486B `3311F075…` | 15301B `5F0C13AC…` | 不同 |
| `references/execution.md` | 6920B `7EF40B60…` | 8100B `E03936F0…` | 不同 |
| `references/setup.md` | 8282B `879DC5EC…` | 10784B `3E0707D6…` | 不同 |
| `agents/openai.yaml` | 476B `7E651486…` | 476B `7E651486…` | 相同 |
| `references/agent-hub.md` | 346B `6F00BAD7…` | 346B `6F00BAD7…` | 相同 |

T7B 安装目录下 `gateway/skills/workbuddy-executor` 是**第三套**（`SKILL.md` 7197B `108BA73B…`）。`deepseek-executor` 技能在 `CODEX_HOME` 下不存在，只在 T7B 安装目录留了旧副本（`SKILL.md` 4429B `42FA5925…`）。仓库根六文件与 RC 发布副本 6/6 一致（这条成立），但**磁盘安装位不是**。

**用户最小动作**
二选一：① 让安装流程把六个文件（含 `deepseek-executor` 两个文件）覆盖到 `CODEX_HOME`，并在 Codex 侧重载技能；② 明确"本轮以已安装技能版本为准"，则在验收记录里把技能一致性标为"安装位旧版本，未验证"。

**对应产物/范围**
`gateway/skills/**`、`codex-workbuddy-gateway-v0.7.1.zip` 内同名目录、`workbuddy-executor-v0.7.1.zip`（`e61be9ba…`）、`deepseek-executor-v0.7.1.zip`（`22909e1b…`）。只影响技能文本与派工口径，不影响网关二进制。

**可继续的独立工作**
技能一致性矩阵、派工话术预演、DSH 端契约草稿（已生成 `contracts/dsh.json`）都不依赖安装动作。

**→ 本轮结果**：已按你的决定更新 `CODEX_HOME` 技能。`skills\workbuddy-executor` 六文件现与 RC 清单逐字一致，旧版备份在 `C:\Users\LENOVO\.codex\skill-backups\workbuddy-executor-I5FgPH`；`skills\deepseek-executor` 两文件（`SKILL.md 42fa5925…`、`references/setup.md e6176215…`）已装。

---

## E03 当前聊天没有可用的 WorkBuddy MCP 工具

**实际缺什么**
MCP 注册在 `C:\Users\LENOVO\.codex\config.toml`（7449B，2026-11-06 09:39:45）：`[mcp_servers.workbuddy]` → `F:/node.exe` + `…WorkBuddyWorkbenchT7BPreview-20261031\…\gateway\dist\server.js`，env 指向 `E:/javaproject/outputs/t7b-live-acceptance-20261031/state/*`。但进程表里**没有 `dist/server.js` 进程**（只有 4 个 `service-cli.js` 常驻服务），且本会话工具集里没有任何 `workbuddy_*` 工具。也就是说：注册存在、进程未起、本会话不可调用。另一条 `[mcp_servers.workbuddy_community]` 的 `WORKBUDDY_CLI_ELECTRON` 指向 `F:/WorkBuddy/WorkBuddyAI/WorkBuddyAI.exe`，与现存客户端 `F:/新建文件夹 (2)/WorkBuddy/WorkBuddyAI.exe` 不同，是陈旧路径。

**用户最小动作**
若要真派工：在一个**能加载 MCP 的客户端会话**里启动 workbuddy 服务（Codex 侧重开会话/启用该 server），或直接用包内 `scripts/workbuddy-call.mjs` 在命令行发起（该脚本会自己起 server）。然后确认工具列表里出现 workbuddy 的 task 类工具。

**对应产物/范围**
`gateway/config.toml` 片段、`scripts/workbuddy-call.mjs`、`gateway/data/persistent-service.json`（不要误改）。不改 DB、不触碰 T7C 占用任务。

**可继续的独立工作**
合同草稿、CommandSpec、异常卡脚本、停止证据口径核对都已在本地准备完毕，等工具可用即可执行。

**→ 本轮结果**：没有改 `config.toml`，改用包内 `scripts/workbuddy-call.mjs`（它自己起 server）驱动 MCP，本轮全部派工/复核/接受都走这条路径，退出即收。

---

## E04 DSH 一侧未启用（`DSH_ENABLED=0`，从未真实派工）

**实际缺什么**
- 注册 env：`WORKBUDDY_DSH_ENABLED="0"`。
- 任务库 `dsh_attempt_bindings` 表 **0 行**，`native_stop_declarations` 0 行 → 历史上没有一次真实 DSH 派工。
- `deepseek-executor` 技能未安装到 `CODEX_HOME`（见 E02）。
- 没有观测到 DSH 宿主会话与网关的连接记录。

**用户最小动作**
决定是否本轮启用 DSH：① 允许把 `DSH_ENABLED` 改为 `1`（属配置变更，需要你点头）；② 确认 DSH 宿主的可执行路径与可连会话；③ 决定 DSH 任务用的模型与推理档（见 E07）。

**对应产物/范围**
网关 env 白名单键、`gateway/skills/deepseek-executor`、`docs/D1_LIVE_ACCEPTANCE_PLAN.md` §5 的 DSH 停止证据口径。**不涉及** WorkBuddy 客户端登录。

**可继续的独立工作**
DSH 端样本 `dsh/src/paid-summary.mjs` 与契约草稿已备好（`contracts/dsh.json`，`execution=null`），启用后即可补全。

**→ 本轮结果（已真实派工并通过）**：`.env` 追加 `WORKBUDDY_DSH_ENABLED=1`；新建会话 `session-d3d2d0c7-1563-4c00-9db2-166a1de9606f`；契约 `d1-dsh-5f82573e-…`（`dsh / wb-proxy / deepseek-v4.1-flash / high`）；`send_task` → attempt `run-4fc382d9-…` → 原生 `turn/end`（`requestId===attemptId`）→ 独立命令 7/7 通过 → `review-684133fe-…` → `state=accepted`。`dsh_attempt_bindings` 不再是 0 行。

---

## E05 共享容量 slot=1 已被占用；原 P0-1 的原库在本机不存在

**实际缺什么**
T7B live 库 `E:\javaproject\outputs\t7b-live-acceptance-20261031\state\tasks.sqlite`（237,568B，25 表）里 `workflow_capacity` 有 1 行：
`slot=1, task_id=t7c-mcp-live-range-20261031-01, executor=workbuddy, operation_id=t7c-mcp-live-range-20261031-01:send`。
该任务 state=`accepted`、attempt=1、session `96e79de1-…`，2026-10-31T06:48:25Z 起一直未释放。按代码语义（`gateway/src/operation-admission.ts:57` 先查 `sqlite_schema`，缺表抛 `resource_storage_missing:workflow_capacity`），**表缺失 = 不可读而非空闲**；其余三个库根本没有这张表。

原 P0-1（`desktop-send-b58168ae-…`，`outcome_unknown`，占用者 `desktop-e083a31e-…`）所在的网关任务库**本机不存在**（默认 `<repo>\gateway\data\platform\workbuddy.db` 两种布局都没有；`%LOCALAPPDATA%\WorkBuddyWorkbench` 不存在；`.workbuddy-ai\workbuddy.db` 是客户端库，无 `task_operations`）。因此它的容量占用在本机**不可观察**，只按 `docs/T7D_P0_1_ORIGINAL_TASK_DECISION.md` 的裁决保持"不关闭、不重派、不释放"。

**用户最小动作**
真派工前必须给出选择：① 换一个**未被占用**的库/实例（本条线自建新 DB，按代码语义它的 `workflow_capacity` 为空即视为空闲）；② 明确授权释放 T7C 那条占用（与 P0-1 无关，但需要书面决定）；③ 暂不派工，只完成准备。

**对应产物/范围**
`docs/T7D_P0_1_ORIGINAL_TASK_DECISION.md`、`docs/delivery/STATUS_INDEX.md:222`、T7B `state\tasks.sqlite`（只读副本：`outputs\finish-live-20261106\db-copies\T7B-live-state.sqlite`）。

**可继续的独立工作**
容量与占用的只读复核已完成，可随时重跑 `scripts/read-capacity.mjs`。

**→ 本轮结果（选了①自建新库）**：本轮全部派工在 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1\data\tasks.sqlite`，派工前 25 表、`workflow_capacity` 0 行、tasks 0。T7B 的 `t7c-mcp-live-range-20261031-01` 与原 P0-1 **都没有动**。DSH 那单接受后该行仍存在但 `task_closed` 已写入；WorkBuddy 一单认领时 `dist/operation-admission.js:177-194` 检测到 DSH 占用者 `isClosed()` → 删行并写入 WorkBuddy 任务。现在该行为 WorkBuddy 任务（同样 `closedEventPresent:true`）。全程只有一个未关闭工作流，未出现任何绕过容量的动作。

---

## E06 已安装政策比提案更严：只允许 `workbuddy` / `deepseek-v4.1-flash`，且要求免费

**实际缺什么**
T7B 库 `collaboration_policy` 实际存储：
`{"maxAttempts":3,"maxTimeoutSeconds":86400,"requireFree":true,"allowed":[{"executorId":"workbuddy","connectionId":"local-workbuddy","providerId":"workbuddy-native","modelId":"deepseek-v4.1-flash","reasoningEffort":null}],"version":"policy-4zf1EnD-F3K4-rg70_7szRLJ"}`，digest `6bb30e31…2f4e`。
- `requireFree=true` → 只有 `credits` 匹配 `/^x0(?:\.0+)?(?: credits)?$/i` 的报价才放行（`gateway/src/collaboration.ts:76`）。
- `selectionMode` **未落库**，代码按 `selectionMode ?? "allowlist"` 处理，allowed 仅 1 项 → 等效 allowlist。
- 已记录两次 attempt admission 的模型观察均为 `credits:"x0.00"`、`level:"selected"`。
→ 任何"换模型""用付费模型""用 DSH"都将被这条政策拒绝。

**用户最小动作**
若要用别的执行器/模型：显式授权修改政策（新版本、新 digest），并逐任务确认（见 E07）。若不改，则本轮只能在这一个 allowlist 条目内派工。

**对应产物/范围**
`gateway/src/collaboration.ts:59-66`（默认政策）、`:76`（免费判定）、`gateway/src/automation.ts:501-502`（`maxTimeoutSeconds 1..86400`、`maxAttempts 1..100`）。政策记录在任务库 `collaboration_policy`。

**可继续的独立工作**
政策差异分析已完成；不必改政策也能完成全部文档与合成预演。

**→ 本轮结果**：新库 `collaboration_policy` 0 行，首次使用落到代码默认 `{maxAttempts:3, maxTimeoutSeconds:86400, requireFree:false, selectionMode:"user_choice", allowed:[]}`（`gateway/src/collaboration.ts:59-66`）。所以本轮 DSH 选择通过 `enforceModelPolicy`，未被 T7B 那条 allowlist 拦；T7B 政策本身一个字没改。

---

## E07 每个任务的"执行器—来源—模型—推理档—费用"选择尚未取得

**实际缺什么**
`workbuddy-finish/F10-live/AGENTS.md` 与任务书都要求：每个协作任务在准备/派工前展示可选项与已知报价，取得用户对该任务的实际选择；未知价格必须如实披露，不得当成免费或额度上限。目前：
- WorkBuddy 样本（`src/clamp.mjs`）：执行器 `workbuddy`、连接 `local-workbuddy`、提供方 `workbuddy-native`、模型 `deepseek-v4.1-flash`、推理档 `null`、`credits x0.00`——**这是历史政策记录，不是本轮用户选择**。
- DSH 样本：执行器、来源、模型、推理档全部为空（`contracts/dsh.json` 的 `execution=null`）。
- 无 `quota_connections`、无 `credit_balance_connections` → 没有真实余额/额度连接，实际费用只能靠用户当场看到的价格，不能由余额差推算。

**用户最小动作**
对两个样本各给一次明确选择（可复用同一模型但必须逐条确认）：执行器、来源/连接、精确模型 id、推理档、以及"接受未知报价 / 接受 x0.00 免费 / 改选别的"。

**对应产物/范围**
`contracts/workbuddy.json`、`contracts/dsh.json`（当前 `authorized:false`）；`task_admissions` / `task_attempt_admissions` 记录。

**可继续的独立工作**
两个契约草稿已带完整 `requiredChecks`（含 CommandSpec JSON，executable `F:\node.exe`），只差 `execution` 与 `collaboration` 两段填入。

**→ 本轮结果**：**两单都已完成选择并落地**。DSH：`dsh` / `dsh-53ae185d3f716fee84db` / `wb-proxy` / `deepseek-v4.1-flash` / `high`，计划 `plan-fKA3XfFJIXdllaD0yku0cznc` revision `M1b-zcg_0ElwOuhr1idFF6Xo`，`authorizationSource "user-confirmed 2026-11-06 m00477 dsh dispatch"`，观测 `credits x0.00` 仅作报价记录。WorkBuddy：读真实目录后由你在 23 条里选定 `deepseek-v4.1-flash-sg`（`credits x0.11`，相对倍率非金额）、推理档 `null`（目录不提供 `reasoningEfforts`），计划 `plan-WdMpn6FZddWoqmlRFP1NbXIo` revision `nVjdIUE16zNRS16XITmlskUW`，`authorizationSource "user-confirmed 2026-11-06 workbuddy dispatch (model deepseek-v4.1-flash-sg)"`。两单均已被接受（`review-684133fe-…`、`review-a7598513-…`）。仍无余额/额度连接，任何"实际花了多少钱"都不能由余额差推算。

---

## E08 桌面壳只是文件存在，没有运行过

**实际缺什么**
`…T7BPreview-20261031\…\gateway\desktop\app\WorkBuddy.Workbench.exe`（163,840B，2026-11-04 10:12）存在，但**当前 0 个 Workbench 进程**；RC 包本身不含桌面程序（`preview` 的 `desktop_application` 始终 unmet 属预期）。因此 L05 面板、L06 模板/通知、L07 自动政策页、L08 任务面板的**真实窗口行为**（含四个尺寸、200% 缩放、读屏）一条都没有运行证据。

**用户最小动作**
若要看窗口：本机启动桌面壳（需要 .NET Desktop Runtime 10——实测 10.0.12 已在位；WebView2 156.0.4314.58 已在位），并同意我用截图/录屏记录四个尺寸与缩放。

**对应产物/范围**
`docs/delivery/L05_ACCEPTANCE.md`、`L06_ACCEPTANCE.md`、`L07_ACCEPTANCE.md`、`L08_ACCEPTANCE.md` 第 8 节；桌面壳合成冒烟在 G3 已 92/92 通过。

**可继续的独立工作**
以只读 HTTP 快照替代窗口证据（可做），但结论必须标注"非窗口证据"。

---

## E09 十张真实异常操作卡需要人工在场与中断授权

**实际缺什么**
`docs/delivery/L08_ACCEPTANCE.md` 第 8 节 R1–R10（准备不确定、投递不确定、报告先到原生忙、领取后取消、到期迟到、错会话归属、错执行器同键、预算耗尽、旧 attempt 审核、资源故障期间停止）每一张都要求：新受控任务、新原生会话、用户当场选模确认价格、人工在场、期限 10–15 分钟/1 轮。其中 R10 需要临时改权限、R5 需要临时改期限——都属于必须你点头的动作。停止口径统一为 `hasNativeStopEvidence(snapshot) === true`；`end_turn`、结果文件、取消请求**都不算**停止证明。

**用户最小动作**
逐卡给"执行/跳过"，并指定在场的操作窗口（例如某天某个时段）。R5、R10 需额外单独授权改动。

**对应产物/范围**
`docs/delivery/L08_ACCEPTANCE.md` §8；证据落 `outputs\finish-live-20261106\` 对应子目录。

**可继续的独立工作**
十卡的触发条件、观测点、判定脚本已在文档中固定；合成库上的预演可先做。

**→ 本轮结果（2026-11-06）**
按你的批准跑了五张，全部在真实网关上、用真实原生会话完成：

| 卡 | 结果 |
|---|---|
| R7 错执行器同键 | `OPERATION_CONFLICT`（"The original operation selected a different executor."），无第二次派发，tasks/attempts/send 均未增 |
| R4 领取后取消 | 认领后 14 ms 取消 → 网关自行观测原生空闲 → `native_stop_confirmed` → `task_closed`；工作区未被改动 |
| R8 预算耗尽 | `maxAttempts=1` 下返工被拒（"Task attempt limit reached…"），随后按原预算走完复核并被接受 |

另外记录一条操作顺序坑：**取消之后要再触发一次同步（`get_task`/`wait`）才会落 `task_closed`**，否则容量会一直挂着、下一次派工报 `CAPACITY_OCCUPIED`（R4 第一次尝试就是这样发现的）。
R1/R2/R5/R9/R10 五张仍未做；其中 R2 会再造一个 `outcome_unknown`，按 T7D 口径不能关闭，建议保持不做的状态（R6 已跑，并转为 E19）。证据：`outputs\finish-live-20261106\evidence\cards\`。

---

## E10 没有第二台 Windows 物理机（D7-02）

**实际缺什么**
`docs/D0_D1_DELIVERY_READINESS.md` 的 D7-02 要求第二台物理 Windows：全新 clone、不复制 `.env`/DB/会话/登录，跑 normal/rework/cancel/reconnect/upgrade-uninstall 五个场景。当前只有这一台机器；用 VM 或 CI 冒充会破坏"异机"含义。

**用户最小动作**
提供第二台机器（或明确"本轮不做异机"，则在交付里保持 D7-02 = 待外部条件）。

**对应产物/范围**
`gateway/docs/DEPLOYMENT_ACCEPTANCE.md`、`scripts/deployment-check.mjs --machine-label second-machine`（只读，exit 0 ≠ 验收完成）。

**可继续的独立工作**
依赖清单（Node ≥22.13.0、94 个生产依赖、桌面壳、.NET 10、WebView2、代码签名如实未签名）与迁移脚本已备好。

---

## E11 没有项目许可证文件；包未签名

**实际缺什么**
仓库根与 `gateway/` 均无 `LICENSE`/`COPYING`；生产依赖 94 个（MIT 84 / ISC 7 / BSD-3 2 / BSD-2 1）已有清单，但"项目自身用什么许可"是权利人的决定，不能由本线代填。发布包未做代码签名，SmartScreen 会告警。

**用户最小动作**
由权利人给出许可证选择（或明确"暂不发布"），并决定是否做签名。

**对应产物/范围**
`docs/delivery/L04_ACCEPTANCE.md`、`outputs\finish-l04-20261105\evidence\licenses\production-licenses.json`。

**可继续的独立工作**
第三方许可清单已完成，随时可并入交付材料。

---

## E12 `run-worker` detached EPERM 根因未定位

**实际缺什么**
G3 记录：`run-worker` detached 模式出现过一次 EPERM，本地未复现，根因未定位。这是一条**未解释的历史异常**，不能标"已修复"。

**用户最小动作**
若要在交付里给结论：允许在**非共享**的合成库上重跑该路径（可重复多次）以判定是本机沙箱限制还是产品缺陷。

**对应产物/范围**
`gateway/test/run-worker.test.ts`；G3 回执原文。

**可继续的独立工作**
可在隔离目录反复重跑（不影响共享库），结论写"未复现/未定位"。

---

## E13 O1/O3/O4/O6 是产品缺陷，改代码必须另立 RC

**实际缺什么**
- O1：缺模型时合同路径先报 `PLAN_STALE`，legacy 路径才报 `MODEL_SELECTION_REQUIRED`。
- O3：`formatTime(0)` 显示"未提供"。
- O4：`runs/` 目录含非 `run-*` 条目，不能按目录数推断派发次数。
- O6：`git ls-files` 固定 5s 超时，高负载下抛 `Error: spawnSync git ETIMEDOUT`（`gateway/src/workspace-protection.ts`），错误码不稳定。

**用户最小动作**
决定"本轮只记录不修"还是"另开一条源码修正线、重跑检查、另立 RC"。改 `gateway/src/**` 会作废当前 RC 冻结身份。

**对应产物/范围**
`docs/delivery/STATUS_INDEX.md`、`docs/delivery/L08_ACCEPTANCE.md` §4。

**可继续的独立工作**
缺陷复现脚本与观测记录（不改源码）。

---

## E14 真实费用/额度无法归因

**实际缺什么**
`quota_connections` 0 行、`credit_balance_connections` 0 行，只有 `quota_metadata.scope_salt`。没有真实余额/额度连接，就不能用"余额差"反推费用，也不该把 `x0.00` 说成"免费额度上限"。

**用户最小动作**
若要真实费用证据：在原生客户端里授权一次额度/余额读取（或当场记录报价截图），否则交付里保持"费用未知，仅记录报价"。

**对应产物/范围**
`docs/T3C_CREDIT_BALANCE.md`、`docs/T3C_QUOTA_OBSERVATION.md`。

**可继续的独立工作**
报价记录模板已就绪。

---

## E15 登录与账号/Key 只能你本人在原生入口完成

**实际缺什么**
本线未读取任何账号、Key、`accounts/` 或真实 `.env` 全文；所有政策信息都用"源文件稳定读取 + 自有临时副本"取得，副本已删（`outputs\finish-live-20261106\env-copies\` 为空）。WorkBuddy 客户端登录态、DSH 宿主凭据都需要在本机原生 UI 里配置。

**用户最小动作**
在 `F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe`（或你指定的安装）原生界面里自行登录；凭据不要发到聊天里。

**对应产物/范围**
无（不产生本线产物）。

**可继续的独立工作**
所有不需要登录的检查已全部完成。

---

## E16 WorkBuddy 客户端必须由你带调试端口启动（本会话拉不起 GUI 进程）

**实际缺什么**
网关读模型目录（`workbuddy_list_models`）的前提是：客户端以 `WORKBUDDY_REMOTE_DEBUGGING_PORT=<cdpPort>`（默认 **18491**，`dist/workspace-manager.js:50,110`）启动，网关再 attach 到该端口。`dist/native-desktop-trigger.js:446-460` 会尝试自己 `spawn(exe, [], {detached:true, env:{WORKBUDDY_REMOTE_DEBUGGING_PORT}})` 并等 60×250ms（15s）让 `ownerIsNative()` 为真，否则返回 `Native WorkBuddy local RPC port did not become available`。

实测两件事：
1. 你手动启动的实例不带该变量 → 18491/18493 都不监听（`WorkBuddyAI.exe` 7 个进程照样在跑）。
2. **本会话所在上下文无法拉起任何 GUI 进程**：`Start-Process notepad.exe` 3 秒后进程已不存在；用 `WORKBUDDY_REMOTE_DEBUGGING_PORT=18491` 启动 `WorkBuddyAI.exe`，45 秒内进程数始终 0、18491 无监听。所以"让网关自己拉起客户端"这条路在我这边走不通，不是产品缺陷。

**用户最小动作**（一条命令，复制整行到你自己的 PowerShell）
```powershell
$env:WORKBUDDY_REMOTE_DEBUGGING_PORT='18491'; & 'F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe'
```
窗口打开、登录态沿用现有即可。之后我就能 attach 到 18491 读真实模型目录、列可选执行器/来源/模型/推理档与已知报价，再由你逐任务选定。

**对应产物/范围**
`dist/native-desktop-trigger.js`、`dist/workspace-manager.js`、`<root>\.env`（`WORKBUDDY_CLI_ELECTRON`）；`contracts/workbuddy.json`（仍 `execution:null`/`authorized:false`）。不改 DB、不动 T7B。

**可继续的独立工作**
WorkBuddy 契约草稿、CommandSpec、复核/接受链路已与 DSH 那单一同验证过（命令、核对、复核、接受四个闸门都能跑通），只差执行器侧的真实会话与模型目录。

**→ 本轮结果**：**已解决**。你在自己的 PowerShell 里用上面那条命令启动后，`127.0.0.1:18491` 变为 LISTENING（owner PID 4312 = `F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe`），`workbuddy_list_models` 成功返回 23 条模型，运行时代码摘要 `ac2a673f…` 与本机 RC 逐字相同；随后 WorkBuddy 一单完成领取、报告、原生 idle、独立复核与接受。**这条依赖仍然存在**：以后每次要读目录或派工，客户端都得带该变量启动（或在已 attach 的情况下保持运行）。

**已固化成脚本**：`E:\javaproject\workbuddy-install\start-workbuddy-debug.ps1`。它先检查 18491 是否已在监听、再检查是否有不带该变量的实例在跑（有就提示你先完全退出，因为单实例锁会让第二次启动无效），然后只在**当前进程**设 `WORKBUDDY_REMOTE_DEBUGGING_PORT` 并启动客户端，最多等 60 秒确认端口打开。不写系统环境变量、不写注册表、不装服务、不改计划任务。

---

## E17 新安装的 MCP 片段是否合并进 Codex 配置（**已决定：本轮不合并**）

**实际缺什么**
新安装只把 MCP 片段写进 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1\data\workbuddy-mcp.toml`，**从不写** `C:\Users\LENOVO\.codex\config.toml`（`dist/setup.js` 的设计如此：只生成片段，合并由人完成）。所以当前聊天若想直接用到新安装的 `workbuddy_*` 工具，需要一次配置变更。

**已决定（2026-11-06 15:33，你的回复"那就**不合并**吧"）：本轮不合并**
- 三条理由：① 主库被 R6 的 locked 任务占着，合并进来的工具只能读、send_task 必撞 CAPACITY_OCCUPIED，容易让人误判"随时能派工"；② config.toml 是所有 Codex 会话共用的入口，多一个与 T7B 的 workbuddy 名字近似的条目会增加启动噪音与辨认成本；③ 本轮全部真实派工都走 scripts\workbuddy-call.mjs（自起 server + 显式环境隔离），已证明可靠，合并没有新增能力。
- 保留"随时可切"：需要时把 evidence\codex-config-preview\proposed-block.toml 追加到 config.toml 末尾 → 重启 Codex → workbuddy_list_models 只读验证一次即可。
- 改口条件：主库重新可派工（或换到干净安装根），且你打算长期用这个 RC 安装干活。

**对应产物/范围**
预览在 `outputs\finish-live-20261106\evidence\codex-config-preview\`：
- `proposed-block.toml`：要追加的整段，服务器名是 **`workbuddy_rc`**（不是覆盖现有的 `workbuddy`）；
- `merge-preview.md`：现有 4 个 MCP 条目（`cua_repl`、`node_repl`、`workbuddy`、`workbuddy_community`）**一个都不改**，只在文件末尾追加；
- 块里不含任何账号、token、Key 或 `.env` 值，只有路径与非机密 `WORKBUDDY_*` 设定。

**可继续的独立工作**
不合并也能继续：本轮所有真实派工都是通过包内 `scripts/workbuddy-call.mjs`（自起 server、显式环境隔离）完成的，不依赖 Codex 配置。合并只是让"当前聊天直接可用"。`config.toml` 现在**没有被写过**：仍是 7,449 字节、0 处 `workbuddy_rc`。

---

## E18 第一单派工后网关自登记了常驻服务，它把任务库钉死（**已决定：保留**）

**实际缺什么**
不是缺配置，而是多了一样东西：第一单 WorkBuddy 派工（`2026-11-06T06:12:55Z`）之后，网关自己写了 `<root>\data\persistent-service.json`（678B，`dbFile=<root>\data\tasks.sqlite`、`cdpPort 18491`、4 个 worker）并拉起 `PID 11672`（`dist\service-cli.js run --config …`）。此后**任何 `WORKBUDDY_DB_FILE` 覆盖都会被拒绝**：`dist\workspace-manager.js:25-28` 抛 `The persistent service uses another task database; fix the bridge configuration before connecting projects`。R3 的前两次尝试就是撞在这条约束上（换库被拒 → `blocked`）。

**已决定（2026-11-06 15:30，你的原话"就按你的建议来"）：保留**
- 保留的理由：① 它提供原生自动唤醒，本轮全部真实派工的现场形态就包含它；② 撤掉并不能解开主库上的 R6 占用，只会让安装形态与已产出证据不一致；③ 换库的摩擦已经有确定解法——只要同时把 WORKBUDDY_SERVICE_CONFIG 指到不存在的路径（R3d 已实测可行）。
- 因此**没有执行** service-cli uninstall。若以后要在这个根上做"干净的多库实验"，再单独决定撤除，并重新跑一次安装/派工复验。

**对应产物/范围**
本安装根内 `data\persistent-service.json`、`data\persistent-service-status.json`、`data\service-logs\`、`PID 11672`。T7B 与另外三个既有常驻服务（8848/30964/11220/8912）**没有被碰**。

**可继续的独立工作**
不撤也能继续：本轮所有后续工作都是"主库直接用 + 隔离库同时覆盖 `WORKBUDDY_DB_FILE` 与 `WORKBUDDY_SERVICE_CONFIG`"两招之一，已验证可用。

---

## E19 R6 跑出的真实缺陷：外来会话被拒时无错误码，留下一个占容量的 `blocked` 任务（**已决定：保留原样**）

**实际缺什么**
本来只想验证"错会话归属会被干净拒绝"，实测拒绝路径不是干净拒绝：`dist\workspace-workers.js:97` 抛的是普通 `Error("This native session is already registered for another workspace")`，**没有 code**；`dist\coordinator.js` 的 `failureCause()` 只认 `AdmissionError.code` 或形如 `^[A-Z][A-Z0-9_]{2,40}$` 的码，于是：
- 任务落 `blocked`（`attempt_id:null`、`blocking_reason` 只剩通用文案"Contract preparation failed…"）；
- 操作 `card-r6-foreign-session-1793948211334` 落 `outcome_unknown`；
- `workflow_capacity` 被这个 blocked 任务占住，主库从此不能再派工；
- `get_operation_recovery` 的 `available` 为空（既没有 reconcile 也没有 close 证据）。

**已决定（2026-11-06 15:30）：按 T7D 口径原样保留**
- 只读复核（dist\recovery-cli.js show 与 observe，两次 exit 0）：vailable: []、proof: {reconcile: null, close: null}、history: []、declaration: null、ttemptId: null、preparation.dispatchEnteredAt: null。
- 因此**（b）那条人工声明路径现在根本走不通**：ecovery-console 在 !view.available.includes(action) 时直接抛 RECOVERY_UNPROVEN（"The stored original evidence does not prove this action is safe."），连确认输入都到不了。
- 结论：保留这个 locked 任务与它的 outcome_unknown，主库 workflow_capacity 继续被它占着；**没有改库、没有写声明、没有重派、没有换身份**。复核输出存 evidence\cards\r6\recovery-console-show.json。

**对应产物/范围**
仅 `<root>\data\tasks.sqlite` 里这一条任务与一条操作；证据在 `outputs\finish-live-20261106\evidence\cards\r6\recovery-view.json`。没有改库、没有改状态机、没有重派、没有换身份。

**可继续的独立工作**
R6 之外的结论不受影响（DSH、WorkBuddy、R7、R4、R8、R3 都不依赖它）。后续要跑 R5/R9 之类的卡时，用隔离库（同时覆盖 `WORKBUDDY_DB_FILE` 与 `WORKBUDDY_SERVICE_CONFIG`）即可绕开这个被占的主库。

---

## 汇总：本轮真正卡住的只剩两件事（都需要你亲自决定）

1. **第二台机器与许可证/签名**（E10/E11）——决定"异机"与"许可"两类状态能不能从"待外部条件"变成"已验证"。异常卡 E09 已从"全未做"变为"跑了 5 张、剩 5 张可选"。
2. **是否把新装的 MCP 片段合并进 `C:\Users\LENOVO\.codex\config.toml`**（E17）——预览已生成，配置本身未动；合并会让当前聊天直接指向新安装。
3. **R6 留下的 `blocked` 任务怎么处置**（E19）——保留（主库继续被占）或走恢复控制台记一条人工声明；两条都需要你明确选。
4. **网关自登记的常驻服务留不留**（E18）——留则任务库被钉死，撤则原生自动唤醒消失。
5. **以后要不要继续做新的逐任务派工**（换模型、换推理档、跑剩下的 R1/R2/R5/R9/R10）——每单都需要你在派发前确认模型与费用口径，并且客户端要带调试端口启动（E16，已给 `start-workbuddy-debug.ps1`）。

已解决：E01 安装、E02 技能、E03 工具（走 `workbuddy-call.mjs`）、E04 DSH 启用并真实跑通 1 单、E05 容量（自建新库，不动 T7C 与原 P0-1）、E06 政策（新库用默认值）、E07 两单选择均已取得并授权、E16 客户端带调试端口启动（你已照做，WorkBuddy 1 单真实通过）。
部分解决：E09 异常卡（R7/R4/R8/R6/R3 已跑，其余 5 张可选；其中 R6 转为 E19）。
本轮新增：E18 常驻服务钉库、E19 R6 无错误码缺陷与 blocked 任务。
从属条件（E08 桌面壳、E12 EPERM、E13 产品缺陷、E14 费用归因、E15 登录）不变，都不阻塞本轮已完成的结论。
