# 真实验收总结（10 线）

- 生成时间：2026-11-06（Asia/Shanghai）
- 工作树：`E:\javaproject\workbuddy-finish\F10-live`
- 分支：`docs/live-acceptance`
- 起点 HEAD：`91af89ee9d5a3358f65a6e0e7699c9100f91d732`（G3 归档 / RC 冻结点）
- 起点工作树：`git status --porcelain` 为 0 行（干净）
- 原始证据目录（不入包、不进仓库）：`E:\javaproject\outputs\finish-live-20261106\`
- 安装根（本机，非仓库）：`E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1`

## 结论先说

**RC 已经装到独立目录，两个执行器各跑完一单真实任务并被接受：DSH 与 WorkBuddy 的派发、原生停止、独立复核、接受全部是真事件。**

- 阶段 1（只读就绪检查）：**完成**，见第 3 节。
- 阶段 2（安装）：**完成**——新目录安装、`CODEX_HOME` 技能更新到 RC、`DSH_ENABLED=1`、全新任务库。见第 4 节。
- 阶段 3（双执行器各一个真实任务）：**两个都完成**——DSH 一单见第 5.1 节，WorkBuddy 一单见第 5.2 节。
- 阶段 4（真实异常卡）：**跑了 5 张**——R7 冲突、R4 领取后取消、R8 预算耗尽、R6 错会话归属、R3 报告先到原生未停；其中 R7/R4/R8/R3 按预期通过，**R6 跑出一个真实缺陷并留下一个需要你决定的 `blocked` 任务**（第 6.4 节）；其余 5 张未做（第 6.6 节）。
- 阶段 5（第二台 Windows）：**未执行**（没有机器，按你的选择标待外部条件）。

"真实验收通过"只能说到这个粒度：**DSH 1 个任务、WorkBuddy 1 个任务在同一天、同一台机器、同一个 RC 代码上真实通过，另加 5 张异常卡（全部发生在同一台机器、同一个 RC 上）；异机 0 个。**

两个执行器读取的是同一份 RC 代码摘要 `ac2a673f…`（WorkBuddy 侧由运行中 `runtime.codeHash` 逐字核对，DSH 侧由网关进程给出同一摘要）。

---

## 1. 起点核对（任务书允许继续的条件）

| 项 | 要求 | 实测 | 结论 |
|---|---|---|---|
| 分支 | `docs/live-acceptance` | `docs/live-acceptance` | 通过 |
| HEAD | `91af89ee9d5a3358f65a6e0e7699c9100f91d732` | 同 | 通过 |
| 工作树 | 干净 | `status --porcelain` 0 行 | 通过 |
| HEAD 树对象 | G3 归档树 | `4c61792ac92f7ba0597e378d304e0e8ad952a943`，与 `G3_RECEIPT.md` 逐字一致 | 通过 |

没有 reset、没有 checkout、没有切分支、没有新建替代工作树。

## 2. 本轮实际做了什么

1. 自己重算 RC 三个包的 sha256 与 694 文件清单（没抄 G3 记录），再逐文件比对技能六文件与磁盘安装位。
2. 对五个代码位置分别计算 `runtime-version.ts` 的 `codeHash`，确认"都叫 0.7.1"不等于同一份代码。
3. 只读提取政策与容量事实（源文件稳定读取 + 自有副本，副本用后即删），确认原 P0-1 的归属与停止证据状态。
4. **安装 RC 到 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1`**：`verify-release` → `setup plan` → `setup install --apply` → `doctor`，并更新 `CODEX_HOME` 技能、写入 `WORKBUDDY_DSH_ENABLED=1`。
5. 修复一次安装事故：PowerShell 传中文路径导致 `.env` 里 `WORKBUDDY_CLI_ELECTRON` 落盘为乱码，改用 Node 以 UTF-8 字面量重写并复跑 `install --apply` 修好（以码点复核，`fs.existsSync` 为 true）。
6. 在**全新任务库**（0 行容量占用）上跑通 DSH 一单真实任务：建 DSH 会话 → 契约 → 本地规划缝 `create`/`authorize` → `send_task` → `wait` → 独立跑命令 → `check_task` → `review_task` → `accept_task`。
7. 导出 DSH 任务的证据包（10 个 JSON）到 `outputs\finish-live-20261106\evidence\dsh\`。
8. 等你带调试端口启动客户端后，读真实模型目录（23 条）、把可选模型与 `credits` 倍率列给你选，你选定 `deepseek-v4.1-flash-sg` / 推理档 `null`。
9. 在同一新库上跑通 WorkBuddy 一单真实任务：注册工作区 → 契约 → 规划缝 `create`/`authorize` → `send_task` → 原生领取/报告/原生 idle → 独立命令 → 独立核对 → `check_task` → `review_task` → `accept_task`；导出证据包到 `evidence\workbuddy\`。
10. 按你的批准跑了五张异常操作卡（R7 冲突、R4 领取后取消、R8 预算耗尽、R6 错会话归属、R3 报告先到原生未停），每张用独立副本、独立原生会话，并把事件链与副作用核对写进第 6 节。
11. R6 顺带跑出一个真实缺陷：外来会话被拒时抛的是无 code 的普通 `Error`，任务落 `blocked` 且操作 `outcome_unknown`、占住容量，阻塞原因里没有因由（第 6.4 节）；R3 顺带发现网关自登记的常驻服务会把任务库钉死（第 4 节末尾）。
12. 写了 `E:\javaproject\workbuddy-install\start-workbuddy-debug.ps1`（带调试端口启动客户端），并为 Codex `config.toml` 生成了合并预览（**只生成，未写入**）。
13. 写三份交付文档，并按安装、两个执行器与五张卡的实际结果回填状态、回执与外部条件；原始状态全部留在 `outputs\finish-live-20261106\`。

**没有做**：没有动 T7B 安装与它的库、没有动四个既有常驻服务、没有改 `C:\Users\LENOVO\.codex\config.toml`、没有释放任何既有容量、没有碰原 P0-1、没有第二台机器、没有 push、没有合 main、没有打标签、没有发布、没有部署。

## 3. 阶段 1：只读就绪检查

### 3.1 RC 身份（自算，与 G3 一致）

成品包在 `workbuddy-finish\I-integration\gateway\outputs\release\`（F10-live 树内没有 `gateway/outputs`，被 `gateway/.gitignore:8` 忽略）：

| 产物 | 字节 | sha256 |
|---|---|---|
| `codex-workbuddy-gateway-v0.7.1.zip` | 2,235,102 | `658a20b196051fa25be1c669bb9b5c5574216cd30a6b223bd07efe2e90ba11b8` |
| `workbuddy-executor-v0.7.1.zip` | 27,040 | `e61be9ba03f48e555ed1a8441eb8d56f0013eb818cfdceb610015d26e0839db8` |
| `deepseek-executor-v0.7.1.zip` | 4,249 | `22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13` |

网关包展开 695 条目、全部是文件、根前缀 `codex-workbuddy-gateway-v0.7.1/`；`RELEASE_MANIFEST.json`（111,924B）自描述 694 个文件。逐条复算：**listedFiles=694, verifiedFiles=694, bytes=7,273,213, mismatch=0, missing=0, extra=0**。

### 3.2 技能一致性：仓库内一致，安装位不一致

- 仓库根六文件 vs gateway 发布副本：**6/6 相同**（`SKILL.md` `5a485af7…`、`agent-hub.md` `6f00bad7…`、`dispatch.md` `5f0c13ac…`、`execution.md` `e03936f0…`、`setup.md` `3e0707d6…`、`openai.yaml` `7e651486…`）。
- 安装前磁盘上的 `C:\Users\LENOVO\.codex\skills\workbuddy-executor`（2026-11-04 16:06）与 RC 相比 **4/6 文件不同**；T7B 安装目录里是第三套；`deepseek-executor` 当时没有装进 `CODEX_HOME`。
- 安装后（第 4 节）安装位六文件已与清单逐字一致。

### 3.3 五个代码位置互不相同

| 位置 | 版本 | dist js | dist 全量字节 | codeHash |
|---|---|---|---|---|
| T7B-preview（服务在跑） | 0.7.1 | 93 | 2,200,742 | `8427e9e1a4999a4301eb4d109e35ba383d20856eba69b286ba422a50b6e3d58c` |
| community | 0.7.1 | 55 | 1,171,501 | `d5529e49afe3c6b8b7930374ba538fcf7a61896b1cf758ac548d26125c62d833` |
| integrated-validation | 0.7.1 | 49 | 989,192 | `8110503b3ad6134ea8f44540d5c7ba8fb121488497ee61ed9e82bdaa1391a0c6` |
| `F:\WorkBuddy\codex-workbuddy-gateway` | 0.7.0 | 44 | 859,601 | `a365d16723bdf840028364df3c1b4c11471dc74dd12874ecd1abbaeed5025118` |
| RC（解包候选 / 本轮新装） | 0.7.1 | 116 | 3,106,839 | `ac2a673f187546dc9d00c7a20a56ad6fad86adf54a2b0e90d22d1fbcd681e326` |

新装根的 `doctor.mjs` 自报 `codeHash ac2a673f…`，与 RC 清单一致 → **本轮实际跑的是 RC 代码**；T7B 里跑的仍是 `8427e9e1…` 那套旧代码。

### 3.4 运行现场（安装前）

- 常驻服务 4 个：PID 8848（T7B）、30964（community）、11220（integrated-validation）、8912（F:\WorkBuddy 0.7.0），全部 `dist/service-cli.js run --config …`。
- 桌面壳 `WorkBuddy.Workbench.exe`（163,840B）在 T7B 目录，0 个进程。
- 聊天 MCP 只注册在 `C:\Users\LENOVO\.codex\config.toml`，指向 T7B 的 `dist/server.js`，**注册时没有 server 进程**。
- 两个 home 并存：`~/.workbuddy`（23,448 文件 / 707MB）与 `~/.workbuddy-ai`（55,288 / 2.8GB）。
- 运行时 `F:\node.exe` = v24.19.0（≥22.13.0）；.NET Desktop Runtime 10.0.12、WebView2 156.0.4314.58 在位。

### 3.5 政策精确限制（T7B 库，作为历史事实）

```json
{"maxAttempts":3,"maxTimeoutSeconds":86400,"requireFree":true,
 "allowed":[{"executorId":"workbuddy","connectionId":"local-workbuddy","providerId":"workbuddy-native","modelId":"deepseek-v4.1-flash","reasoningEffort":null}],
 "version":"policy-4zf1EnD-F3K4-rg70_7szRLJ"}
```

`digest` = `6bb30e31ed07428740689bc2d3a62dc79d16c51d26abe070372c2552f2e27f4e`；`selectionMode` 未落库，代码按 `?? "allowlist"` 处理；`requireFree=true` 只放行 `credits` 命中 `/^x0(?:\.0+)?(?: credits)?$/i` 的模型（`gateway/src/collaboration.ts:76`）。**本轮新库不继承这条政策**：新库 `collaboration_policy` 0 行，首次使用取代码默认 `requireFree:false` / `selectionMode:"user_choice"` / `allowed:[]`。

### 3.6 容量与原 P0-1

- T7B 库 `workflow_capacity` 1 行：`slot=1, task_id=t7c-mcp-live-range-20261031-01, executor=workbuddy`，`accepted` 起未释放。**本轮没有动它。**
- 其余三个库没有 `workflow_capacity` 表；按 `gateway/src/operation-admission.ts:57`，缺表抛 `resource_storage_missing:workflow_capacity` → **表缺失是不可读，不是空闲**。
- 原 P0-1：`desktop-send-b58168ae-…` 状态 `outcome_unknown`，占用者 `desktop-e083a31e-…`，原预留会话 `33216aa9-…`；无 attempt、无准备完成回执、无派工进入、无恢复审计；**产生它的网关库在本机不存在**。按 `docs/T7D_P0_1_ORIGINAL_TASK_DECISION.md`：不关闭、不重派、不释放、不换库、不改写记录。本轮没有碰。

## 4. 阶段 2：安装（已执行）

**参数（全部显式给出，避免歧义）**

| 项 | 值 |
|---|---|
| 安装根 | `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1` |
| `--workbuddy-app` | `F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe`（Tencent 5.9.4） |
| `--workbuddy-config` | `C:\Users\LENOVO\.workbuddy-ai`（活跃那套，`workbuddy.db` 245,760B） |
| `--codex-home` | `C:\Users\LENOVO\.codex` |
| 免费模型限定 | **未写**（你要先看清单再选） |

**执行结果**

| 步骤 | 结果 |
|---|---|
| `node scripts/verify-release.mjs` | `{"version":"0.7.1","verifiedFiles":694,"hashesMatch":true}` exit 0 |
| `setup.mjs plan …` | `ok:true, changed:false, envWillBeCreated:true, mcpConfigModified:false, taskSent:false` |
| `setup.mjs install --apply …` | `ok:true, changed:true` |
| `doctor.mjs` | `ok:true, readOnly:true, localSetupReady:true`；`codeHash ac2a673f…`；`freePolicyEnabled:false`；`login: unknown`；`taskSent:false` |

**落盘产物**

| 路径 | 字节 | sha256 |
|---|---|---|
| `<root>\.env` | 335 | `4b41648dc652028e66dacf691fb4774c24ecae9ab43f7787775c3a2e5978ffc1` |
| `<root>\data\workbuddy-mcp.toml` | 465 | `abdcfc7a248163818a5632fa79164f4c65a1ab9a10c951101844d20120985276`（= 清单 `snippetHash`） |
| `<root>\data\deployment-installation.json` | 1,034 | 含 `installedAt 2026-11-06T03:18:09.022Z`、`skillBackup …workbuddy-executor-I5FgPH` |
| `<root>\data\tasks.sqlite` | 249,856（安装时） | `6853032a342a14d5066dc079f50eae743ecd5b26680aa72459b328ec57f23376` |

- `.env` 键：`WORKBUDDY_BACKEND=desktop-queue`、`WORKBUDDY_NODE_BIN`、`WORKBUDDY_CLI_ELECTRON`、`WORKBUDDY_CONFIG_DIR`、`WORKBUDDY_MAX_TASK_ATTEMPTS=3`、`WORKBUDDY_DSH_ENABLED=1`（最后一条为启用 DSH 手动追加；`dist/server.js` 用 `loadDotEnv()` 读同目录 `.env`，显式环境变量优先）。
- 技能：`CODEX_HOME` 下 `workbuddy-executor` 六文件被覆盖为 RC 版本（逐文件 sha256 与清单一致），旧版备份在 `C:\Users\LENOVO\.codex\skill-backups\workbuddy-executor-I5FgPH`；`deepseek-executor` 装到 `C:\Users\LENOVO\.codex\skills\deepseek-executor`（`SKILL.md 42fa5925…`、`references/setup.md e6176215…`）。
- **没有**合并 `data\workbuddy-mcp.toml` 到 `C:\Users\LENOVO\.codex\config.toml`；**没有**重启 WorkBuddy。
- **安装本身没有登记常驻服务**，但第一单 WorkBuddy 派工（06:12:55Z）之后网关自己安装了常驻服务：进程 `PID 11672`（`dist\service-cli.js run --config <root>\data\persistent-service.json`），注册文件 `<root>\data\persistent-service.json`（678B，`dbFile` 指向 `<root>\data\tasks.sqlite`，`cdpPort 18491`，`workers` 4 个），另有 `persistent-service-status.json` 与 `service-logs\`。这条服务把"任务库"钉在这个安装根上：**任何 `WORKBUDDY_DB_FILE` 覆盖都会被 `dist\workspace-manager.js:25-28` 拒绝**（`The persistent service uses another task database; fix the bridge configuration before connecting projects`）。本轮 R3 的三次尝试里有两次就是撞上这条约束（见 6.5）。要撤掉：`node dist\service-cli.js uninstall --config "<root>\data\persistent-service.json"`，我没执行。
- 一次事故与修复：首次通过 PowerShell 传中文路径，`.env` 的 `WORKBUDDY_CLI_ELECTRON` 落盘为乱码；改用 Node 以 UTF-8 字面量重写后复跑 `install --apply`，`envRepaired:true`，并以码点复核 `F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe` 与 `fs.existsSync=true`。

**回退**：删掉 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1` 即可（独立目录、不影响 T7B）；技能回退用 `skill-backups\workbuddy-executor-I5FgPH` 覆盖回去；`.env` 随目录一起消失。`rollback-plan` 对跨基线包判 `incompatible`，不能用它做逐文件回退。

## 5. 阶段 3：真实派工

### 5.1 DSH 执行器：真实跑完并通过（1 单）

**已确认的选择**：执行器 `dsh`、来源 `wb-proxy`、模型 `deepseek-v4.1-flash`、推理档 `high`、费用口径 `credits x0.00`（host 目录观测值，未代表真实计费）。以上由你在 2026-11-06 当场选定。

| 环节 | 结果 |
|---|---|
| DSH 会话 | `session-d3d2d0c7-1563-4c00-9db2-166a1de9606f`，workspace `<sample>\dsh`，`attached:true` |
| 契约 | taskId `d1-dsh-5f82573e-b87a-4ff1-acd9-ec8d541243f5`，`execution{executorId:"dsh",connectionId:"dsh-53ae185d3f716fee84db",providerId:"wb-proxy",modelId:"deepseek-v4.1-flash",reasoningEffort:"high"}`，`timeoutSeconds 600`、`maxAttempts 1`、范围只有 `src/paid-summary.mjs` |
| 规划缝 | `plan-fKA3XfFJIXdllaD0yku0cznc` / revision `M1b-zcg_0ElwOuhr1idFF6Xo`，`authorizedAt 2026-11-06T05:35:52.924Z`，`authorizationSource "user-confirmed 2026-11-06 m00477 dsh dispatch"` |
| 派工 | `workbuddy_send_task` → `ok:true`，attemptId `run-4fc382d9-daa5-46d8-bc9a-e4ff17f8c532` |
| 原生停止 | `nativeStopSource:"dsh_terminal_event"`，`terminal.rawType:"turn/end"`（seq 38），`requestId===attemptId`，`nativeStoppedAt 2026-11-06T05:37:16.483Z` |
| 独立命令 | `independent-command` → `command-1f957dda-7171-4bff-a773-540b1742f829`，`passed`，`exitCode 0`，`cleanupConfirmed:true` |
| 独立核对 | `inspection-a4d41d34-0277-4716-926a-efe09c494854`（三个文件逐一核对） |
| 程序检查 | `machine-7e44ef47-eadf-41cd-813c-6295a32dc8c4` |
| 复核 | `review-684133fe-a47d-46c2-becf-d919c00f18e2`，`committedRevision zWVvf5wQxAoQ9OEtzOuxtQT1`，`agreement 6ad0ebcf…` |
| 接受 | `workbuddy_accept_task` → `state:"accepted"`，revision `DNbnQevDQ_eiY3Fy`，`reviewedAt 2026-11-06T05:55:54.478Z` |

**我自己的独立复核（不看执行器自报）**

- `dsh/src/paid-summary.mjs`：`6b6bb4b9…` → `ae31bca8ba19d7ba1e25339aacb13e4a2e57f41ac593da2047aa4907b77213dd`，是唯一变动文件且为 mutable。
- `dsh/checks/acceptance.test.mjs` 仍 `c6a5043e…`、`dsh/README.md` 仍 `dd47d363…` → 范围外未动。
- 手跑 CommandSpec：`F:\node.exe --test --test-reporter=tap checks/acceptance.test.mjs` → tests 7 / pass 7 / fail 0，exit 0。
- 改动内容：`src/paid-summary.mjs:6` 由 `!== 'refunded'` 改为 `=== 'paid'`，校验与溢出检查保留。

**证据包**：`outputs\finish-live-20261106\evidence\dsh\`（`final-state.json`、`events.json`、`review-records.json`、`admission.json`、`attempt-admissions.json`、`contract.json`、`plans.json`、`capacity.json`、`policy.json`、`baseline-compare.json`）。

**容量语义（实测，不是推断）**：接受后 `workflow_capacity` 仍留着该行，但 `task_closed` 事件已存在；`dist/operation-admission.js:177-194` 的 `claim()` 在下一次认领时会发现占用者 `isClosed()` 并清行 —— 即"同一时刻只允许一个未关闭工作流"，不是永久占用。

### 5.2 WorkBuddy 执行器：真实跑完并通过（1 单）

**先解决的前置**：网关读真实模型目录前，客户端必须以 `WORKBUDDY_REMOTE_DEBUGGING_PORT=<cdpPort>`（默认 **18491**）启动并由网关 attach。你在自己的 PowerShell 里这样启动后，`127.0.0.1:18491` 变为 LISTENING（owner PID 4312 = `F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe`）；`workbuddy_list_models` 返回的运行时代码摘要 `ac2a673f187546dc9d00c7a20a56ad6fad86adf54a2b0e90d22d1fbcd681e326` **与本机安装的 RC 逐字相同**。

**已确认的选择（你当场选定）**：执行器 `workbuddy`、来源 `local-workbuddy` / `workbuddy-native`、模型 `deepseek-v4.1-flash-sg`（目录显示 `credits x0.11`，只是相对倍率，不含金额，也没有余额连接）、推理档 `null`。

| 环节 | 结果 |
|---|---|
| 原生模型目录 | 23 条（`evidence\workbuddy-models.json`，5042B）；**目录只给 `id`/`name`/`credits`，没有 `reasoningEfforts`**，所以 WorkBuddy 单推理档只能 `null` |
| 目录差异 | **`deepseek-v4.1-flash` 已不在今天的目录里，只有 `deepseek-v4.1-flash-sg`** —— 历史 allowlist 里的裸 id 今天会 `MODEL_UNVERIFIED` |
| 契约 | taskId `d1-workbuddy-2fec4908-eb45-45eb-8852-8e8411b0cacf`，`execution{executorId:"workbuddy",connectionId:"local-workbuddy",providerId:"workbuddy-native",modelId:"deepseek-v4.1-flash-sg",reasoningEffort:null}`，`timeoutSeconds 600`、`maxAttempts 1`、范围只有 `src/clamp.mjs` |
| 规划缝 | `plan-WdMpn6FZddWoqmlRFP1NbXIo` / revision `nVjdIUE16zNRS16XITmlskUW`，`termsHash 3503d65e…`，`authorizedAt 2026-11-06T06:09:38.018Z`，`authorizationSource "user-confirmed 2026-11-06 workbuddy dispatch (model deepseek-v4.1-flash-sg)"` |
| 派工 | `workbuddy_send_task` → `ok:true`、`created:true`，attemptId `run-bc7288ad-bedb-4593-852d-551e91e6a1e3`，原生会话 `da998f42-39df-4866-b274-c99a43c50603`，`runtimeSource:"desktop_queue"` |
| 原生领取 | 事件 seq 2：「The verified native WorkBuddy desktop conversation claimed this task.」 |
| 原生报告 | seq 3：改 `src/clamp.mjs:4` 的 `Math.max(lower, Math.max(value, upper))` → `Math.min(upper, Math.max(lower, value))`，自报 7/7 |
| 原生停止 | seq 4 与 `runEvidenceDigest`：`nativeStopSource:"native_idle"`、`stopReason:"end_turn"`、`nativeStoppedAt 2026-11-06T06:14:07.761Z`、`stopped:true`、`stopProofDigest fe44a8cc…` |
| 独立命令 | `independent-command` → `command-147c9d82-1e6f-4b4a-a145-366d94730ef1`，`passed`，`exitCode 0`，`cleanupConfirmed:true` |
| 独立核对 | `inspection-439c2888-261a-485e-aa07-ea33edad852e`（三个文件绝对路径逐一核对） |
| 程序检查 | `machine-5e4f2568-f402-4b37-a662-9588dd3d5822`（`$provenance`、`$scope`、`independent-command` 全 passed） |
| 复核 | `review-a7598513-0642-4caf-bc29-9d66886ee3e9`，`commit revision hgkJZeo6KgaKKRD5M-sVnb3E`，`submissionHash 1c1b759c…` |
| 接受 | `workbuddy_accept_task` → `state:"accepted"`，revision `nViAz0BiNEdMDcsL`，`reviewedAt 2026-11-06T06:15:38.488Z` |

**我自己的独立复核（不看执行器自报）**

- `workbuddy/src/clamp.mjs`：`a865956f…` → `c5533fab8d9a93bae501dcfd14059055c46c963ecacf720c32f76100458ad4b6`（300B），唯一变动且为 mutable。
- `workbuddy/checks/acceptance.test.mjs` 仍 `e46e3a15…`、`workbuddy/README.md` 仍 `b133aa74…` → 范围外未动。
- 手跑 CommandSpec：`F:\node.exe --test --test-reporter=tap checks/acceptance.test.mjs` → tests 7 / pass 7 / fail 0，exit 0。
- 复核记录里 `$provenance` 的 `evidenceRefs` 是 `["authenticated_report","native_stop"]`，`$scope` 引用 `workspace_inventory`，命令项的 `evidenceRefs` 指向 `data\runs\run-bc7288ad…\commands\cdac703f-….json`。

**证据包**：`outputs\finish-live-20261106\evidence\workbuddy\`（10 个 JSON，命名与 DSH 侧一致）。

**两次踩坑（已修正，记录下来）**：① `workbuddy_record_inspection` 的 `files` **必须是绝对路径**，相对路径报 `INVALID_REVIEW: Inspection files must be absolute`；② `workbuddy_check_task` 的机器检查必须先落批，`review_task` 的 `machineCheckIds` 只能引用 `machine-…` 批、语义项只能引用 `inspection-…`，否则 `REVIEW_EVIDENCE_UNKNOWN`（与 DSH 侧同一条规则）。

**容量语义（实测）**：WorkBuddy 派工认领时，`dist/operation-admission.js:177-194` 检测到占用者（DSH 任务）已 `isClosed()`（`stopped`+attemptId 匹配+`task_closed` 事件）→ 删行并写入本任务；当时 `workflow_capacity` 一行是 WorkBuddy 任务，`closedEventPresent:true`。全程**没有任何绕过容量的动作**，始终只有一个未关闭工作流（例外的 R6 见 6.4：那一张把容量留在了 `blocked` 任务上）。

## 6. 阶段 4：真实异常操作卡（跑了 5 张：R7、R4、R8、R6、R3）

`docs/delivery/L08_ACCEPTANCE.md` 第 8 节有十张卡。按你 2026-11-06 的批准（m00987 与 m01254）跑 R7 + R4 + R8 + R6 + R3 五张，其余五张不做，理由见本节末尾。每张卡都是独立任务、独立原生会话、独立工作区副本（`cards\r4`、`cards\r4b`、`cards\r8`），模型一律按你当场选的 `deepseek-v4.1-flash-sg`（目录 credits x0.11，相对倍率不是金额，实际计费仍未知），`reasoningEffort: null`（原生目录不提供推理档），停止口径仍统一按 `hasNativeStopEvidence(snapshot) === true`。

### 6.1 R7：同一 operationId 换执行器重发

| 项 | 实测 |
|---|---|
| 操作 | 复用 WorkBuddy 派工的 operationId `compat:send:d1-workbuddy-2fec4908-…:bcc3da9a…`，配 DSH 契约重发 |
| 结果 | `OPERATION_CONFLICT` — "The original operation selected a different executor." |
| 副作用核对 | `tasks` 仍 2 行、`task_attempts` 仍 2 行、`send` 操作仍 2 条、`workflow_capacity` 未变、runs 目录未新增 |
| 结论 | 冲突在执行器比对阶段就被拦下，没有产生第二次派发，也没有污染原操作的记录 |

证据：`evidence\cards\r7\db-snapshot.json`。

### 6.2 R4：领取后取消

**第一次尝试（记录一条真实现象）**：fixture `cards\r4\live-acceptance-TD6jzc`，任务 `d1-workbuddy-3f05ab79-28de-4b1d-9c75-4f7692d04ad3`。原生侧约 80 秒就跑完，我的轮询间隔 55 秒，取消时任务已是 `needs_review`。

- `cancel` 返回 `cancellationRequested: false`（原生已空闲，不需要再发取消），任务状态直接记 `cancelled`；
- 但这时**没有 `task_closed` 事件**，`workflow_capacity` 仍占着该任务，下一次派工被 `CAPACITY_OCCUPIED` 拒绝；
- 再调一次 `workbuddy_get_task` 触发同步后，才落下 `task_closed`（`actor: gateway`，`closedAs: cancelled`）。

也就是说：**取消之后需要再触发一次同步（`get_task` / `wait`）才会落闭环事件**，否则容量会一直挂着。这是操作顺序问题，不是记录缺失。

**正式卡**：fixture `cards\r4b\live-acceptance-PVGV2a`，任务 `d1-workbuddy-90e3d881-dfbb-4873-8a07-771ff2033490`，计划 `plan-JI2B296_nVSjIz-DAzPS_mQu`。

| 时刻（UTC） | 事件 |
|---|---|
| 06:31:09.696 | `native_claimed`（seq 2，状态转 `working`） |
| 06:31:09.710 | `cancel_requested`（认领后 14 ms，`cancellationRequested: true`） |
| 06:31:11.782 | `native_stop_confirmed`，`nativeStopSource: "native_idle"`、`stopReason: "native_idle_verified"` |
| 06:31:11.809 | `task_closed`（`closedAs: cancelled`） |

- **停止口径**：取消请求本身不是停止证明；这次成立是因为网关在取消后自己观测到原生空闲并落了 `native_stop_confirmed`，两者都在记录里。
- **工作区**：`workbuddy/src/clamp.mjs` 仍是 `A865956F…`（与基线一致），取消发生在模型改文件之前，没有半成品。

证据：`evidence\cards\r4b\r4-timeline.json`。

### 6.3 R8：预算耗尽后返工

fixture `cards\r8\live-acceptance-0Rm4aZ`，任务 `d1-workbuddy-096d49a6-1b20-4e8e-a7c5-b9beadf74aac`，契约 `maxAttempts: 1`，计划 `plan-DC1roNRG6XXJbQD41PrfPwhU`。

1. 唯一一轮跑完 → `needs_review`（06:34:04）。
2. `workbuddy_continue_task` 被拒：**`Task attempt limit reached. Stop retrying and review the failure and existing files before changing the configured budget.`**（普通 `Error`，没有 `code` 字段；状态与 attempt 数都没变）。
3. 随后直接跑复核命令先报 `STOP_UNCONFIRMED`（当时原生停止证据还没折进 digest）；等 `runEvidenceDigest.stopped === true` 后重试成功：
   `independent-command` `command-efdfc39f…`（passed / exit 0）→ `inspection-54c951e3…` → `machine-c4780ae8…` → `review-2c19944f-d161-46d0-a194-bc1a123b7560` → 接受，revision `hb6o85fI5h8u3uyf`，`reviewedAt 06:34:38.573Z`。
4. 工作区：`src/clamp.mjs` `C5533FAB…`（唯一变动），`checks/acceptance.test.mjs` `E46E3A15…`、`README.md` `B133AA74…` 与基线一致。

证据：`evidence\cards\r8\r8-timeline.json`、`r8-close.json`。

### 6.4 R6：错会话归属（跑出了一个真实缺陷，结果需要你决定）

fixture `cards\r6\live-acceptance-JrUp5h`，任务 `d1-workbuddy-2cc8e262-54f5-43a0-8511-b3febf0d4101`，计划 `plan-cNoewrGNjILIaGeMfW9_tycT`（授权 06:56:19Z）。做法是把**属于另一个项目**的原生会话 `da998f42-39df-4866-b274-c99a43c50603`（`b2Cgxq\workbuddy`）连同 R6 的 workspace 一起送上，期望网关干净拒绝。

实际结果不是干净拒绝：

1. 返回 `{ok:false, code:null, error:"Observe the original operation; no automatic retry is allowed."}` —— **没有可判别的错误码**。
2. 任务落到 `blocked`：`attempt_id:null`、`session_id:"da998f42-…"`、`blocking_reason:"Contract preparation failed; inspect the original task before any recovery."`；事件只有 `task_received` 与 `task_state_changed`。
3. 操作 `card-r6-foreign-session-1793948211334` 状态 `outcome_unknown`，`error.code = OPERATION_FAILED`。
4. `workflow_capacity` 被这个 blocked 任务占住。
5. `get_operation_recovery`：`available: []`、`proof:{reconcile:null, close:null}`、`runEvidenceDigest:null`、`preparation.incomplete:true`（`phaseRecorded:true`、`completedAt:null`、`dispatchEnteredAt:null`）、`resolvedBinding.sessionId` 就是那个外来会话。

根因（源码 + `WORKBUDDY_WORKBENCH_DIAGNOSTICS=1` 栈）：`dist\workspace-workers.js:97` 抛 `Error("This native session is already registered for another workspace")` —— **普通 Error，没有 code**；`dist\coordinator.js` 的 `failureCause()` 只认 `AdmissionError.code` 或形如 `^[A-Z][A-Z0-9_]{2,40}$` 的码，于是 `blocking_reason` 把因由丢了。

判定：**安全属性成立**（任务没有被塞进别人的会话执行，工作区没被动过），**可观测性与可恢复性不成立**（无码、无因由、占容量，按 T7D 口径不能关闭也不能重派）。这张卡达到了"发现真实缺陷"的目的，但留下一个需要你决定的 `blocked` 任务。

证据：`evidence\cards\r6\recovery-view.json`（DB 前后快照在 `scripts\card-r6.mjs` 的输出里）。

### 6.5 R3：报告先到、原生还没停（通过）

这张卡要证的是"原生报告已经回来，但原生停止证据还没折进 digest 时，返工与复核必须被拒"。

- 第一次（`cards\r3`，换库）：撞上常驻服务的钉库约束（见 4 节末尾），不是卡的主题。
- 第二次（`cards\r3b\live-acceptance-0n9UNc`，任务 `d1-workbuddy-15a592a3-fbc2-4baa-872e-eacce1f50354`）：真的跑起来了，事件链 `report_received 07:05:29.333` → `native_stop_confirmed 07:05:37.768`，**报告比原生停止早 8.4 秒**；但我在窗口内把 `expectedRevision/expectedAttemptId` 传成 `null`（`continue_task` → `STALE_ATTEMPT`；`run_review_command` 直接被 MCP schema 拒 `-32602 Expected string, received null`），窗口没测成，之后按正规链收口（`review-572c11a3…`，终态 `accepted`）。
- 第三次（`cards\r3d`，任务 `d1-workbuddy-2305dfc8-8855-4d07-9744-7e4ba8332cac`）：`scripts\watch-r3d.mjs` 以 300 ms 轮询抓到窗口 `07:19:39.124`，此刻 `state:"needs_review"`、`runEvidenceDigest.stopped:false`。窗口内：
  - `workbuddy_run_review_command` 被拒 **`STOP_UNCONFIRMED` / `"The original native execution must have explicit stop evidence."`**（这就是本卡要的口径）；
  - `workbuddy_continue_task` 被拒（这张 fixture `maxAttempts:1`，先撞预算而不是停止闸门 —— 与 R8 同一条顺序）。
- 停止证据折入 digest 之后同一条链全部放行：`run_review_command` → `record_inspection` → `check_task`（`machine-9fc2064c…`）→ `review_task`（`review-f91ca58d-3d30-4a75-bbcf-fb37fbdbc9c5`，`committedRevision J52PCH2KmFIvrdg4xLgAo1Mk`）→ `accept` `ok:true`。
- 我的独立复核：`workbuddy/src/clamp.mjs` `C5533FAB8D9A…`（唯一变动）、`checks/acceptance.test.mjs` `E46E3A15…` 未变；手跑 TAP **7/7 pass**。

证据：`evidence\cards\r3\{r3-timeline.json, r3b-close.json, r3c-blocked-first-attempt.json, r3d-close.json}`。

### 6.6 没做的五张及理由

| 卡 | 不做的理由 |
|---|---|
| R1 准备不确定 | 需要人为中断准备阶段，构造真正的"不确定"态 |
| R2 投递不确定 | 会再产生一个 `outcome_unknown`，按 T7D 口径不能关闭也不能重派，等于再造一个永久占用 |
| R5 到期迟到 | 需要让原生侧超过 600 秒期限，只能靠人为拖时间 |
| R9 旧 attempt-review-源码 | 需要伪造历史 attempt 记录，等于改库 |
| R10 资源故障期间停止 | 需要拔网络/杀进程级故障注入，超出本机单机验收范围 |

方案与预期口径仍固定在 `docs/delivery/L08_ACCEPTANCE.md` 第 8 节，历史 T6/T7B/T7C 口径未被覆盖。

## 7. 阶段 5：第二台 Windows（未执行）

没有物理第二台机器 → D7-02 保持"待外部条件"，没有用 VM 或 CI 冒充。异机依赖清单（Node ≥22.13.0、94 生产依赖、桌面壳、.NET 10、WebView2、未签名）固定在 `gateway/docs/DEPLOYMENT_ACCEPTANCE.md`；`deployment-check.mjs` 只读，exit 0 不等于验收完成。

## 8. 七类状态

| 类别 | 状态 | 依据 |
|---|---|---|
| 开发完成 | **是** | 八份 `HANDOFF.json` 均 `implemented=true` |
| 合成验证 | **是** | `syntheticVerified=true` ×8；G3 1281 tests / 1269 pass / 0 fail / 12 skipped exit 0 |
| 真实验收 | **是（同机）**：DSH 1 单 + WorkBuddy 1 单均通过 | 第 5.1、5.2 节真实事件链，两个 reviewId 均已落地 |
| 异机验证 | **否** | 第 7 节 |
| 远端 CI | **否** | 无远端流水线、无 push |
| 许可证 / 签名 | **未决** | 无 `LICENSE`、包未签名，权利人决定 |
| 部署 / 发布 | **否** | 未打标签、未合 main、未发布、未部署 |

## 9. 固定回执

```
分支:        docs/live-acceptance
起点 HEAD:   91af89ee9d5a3358f65a6e0e7699c9100f91d732
起点树:      clean (git status --porcelain = 0 行)
HEAD 树对象: 4c61792ac92f7ba0597e378d304e0e8ad952a943

RC 对象:
  归档提交       91af89ee9d5a3358f65a6e0e7699c9100f91d732
  网关包         658a20b196051fa25be1c669bb9b5c5574216cd30a6b223bd07efe2e90ba11b8
                 694 文件 / 7,273,213 字节 / mismatch 0
  技能包         e61be9ba03f48e555ed1a8441eb8d56f0013eb818cfdceb610015d26e0839db8
  Harness 技能包  22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13

安装（本机）:
  根            E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1
  运行代码摘要   ac2a673f187546dc9d00c7a20a56ad6fad86adf54a2b0e90d22d1fbcd681e326
  安装清单      data\deployment-installation.json（installedAt 2026-11-06T03:18:09.022Z）
  技能备份      C:\Users\LENOVO\.codex\skill-backups\workbuddy-executor-I5FgPH

任务派发记录:
  DSH      taskId d1-dsh-5f82573e-b87a-4ff1-acd9-ec8d541243f5
           执行器 dsh / 来源 wb-proxy / 模型 deepseek-v4.1-flash / 推理 high / 费用 credits x0.00（观测值）
           attemptId run-4fc382d9-daa5-46d8-bc9a-e4ff17f8c532
           reviewId review-684133fe-a47d-46c2-becf-d919c00f18e2
           state accepted（2026-11-06T05:55:54.478Z）
  WorkBuddy taskId d1-workbuddy-2fec4908-eb45-45eb-8852-8e8411b0cacf
           执行器 workbuddy / 来源 local-workbuddy·workbuddy-native / 模型 deepseek-v4.1-flash-sg
           推理 null（目录不提供 reasoningEfforts）/ 费用 credits x0.11（相对倍率，非金额）
           attemptId run-bc7288ad-bedb-4593-852d-551e91e6a1e3
           原生停止 native_idle（end_turn，2026-11-06T06:14:07.761Z）
           reviewId review-a7598513-0642-4caf-bc29-9d66886ee3e9
           state accepted（2026-11-06T06:15:38.488Z）

异常卡记录（均为新任务 + 新原生会话 + 新副本，模型同上，推理档 null）:
  R7   同 operationId 换执行器重发 → OPERATION_CONFLICT（无第二次派发；tasks/attempts/send 均未增）
  R4   任务 d1-workbuddy-90e3d881-dfbb-4873-8a07-771ff2033490 / attempt run-eec70101-3fe0-4ae6-9166-be2de5fac6c1
       认领 06:31:09.696 → 取消请求 06:31:09.710 → 原生空闲确认 06:31:11.782 → task_closed 06:31:11.809
       工作区未变动（clamp.mjs 仍 A865956F…）
  R8   任务 d1-workbuddy-096d49a6-1b20-4e8e-a7c5-b9beadf74aac / attempt run-ccba521a-4c33-4acf-ac78-a2e8bd1b41ba
       maxAttempts=1；返工被拒 "Task attempt limit reached…"；复核 review-2c19944f-d161-46d0-a194-bc1a123b7560
       state accepted（2026-11-06T06:34:38.573Z，revision hb6o85fI5h8u3uyf）
  R6   任务 d1-workbuddy-2cc8e262-54f5-43a0-8511-b3febf0d4101 / 操作 card-r6-foreign-session-1793948211334
       外来会话 da998f42-… 被拒，但抛的是无 code 的普通 Error → blocked、attempt null、操作 outcome_unknown、容量被占
       阻塞原因只剩通用文案（真实原因 "This native session is already registered for another workspace"）
  R3   任务 d1-workbuddy-2305dfc8-8855-4d07-9744-7e4ba8332cac / attempt run-cef955b6-5bd2-406b-8c06-c5517d8da974
       窗口 07:19:39.124（needs_review、digest.stopped=false）→ 复核被拒 STOP_UNCONFIRMED
       停止折入后 command → inspection → machine-9fc2064c… → review-f91ca58d-3d30-4a75-bbcf-fb37fbdbc9c5 → accepted
  未跑  R1/R2/R5/R9/R10（理由见第 6.6 节）

容量:
  主库 workflow_capacity 现被 R6 的 blocked 任务占住（d1-workbuddy-2cc8e262…，已决定按 T7D 口径保留，不释放）
  R3 用的隔离库（cards\r3b\state）容量指向 R3d 任务，已 accepted 且 task_closed，下次认领自动清行
  主库任务：DSH accepted、WorkBuddy accepted、R4a cancelled、R4b cancelled、R8 accepted、R6 blocked
  常驻服务：data\persistent-service.json + PID 11672（已决定保留，未执行 uninstall）
  R6 处置：保留；recovery-cli show/observe 均 available=[]、proof=null（已存档）
  T7B 库 slot=1 仍被 t7c-mcp-live-range-20261031-01 占用，未释放
  原 P0-1 未关闭、未重派、未释放

七类状态: 开发=是 / 合成=是 / 真实=是（DSH+WorkBuddy 各 1 单 + 5 张异常卡，同机）/ 异机=否 / 远端CI=否 / 许可=未决 / 部署=否

未执行: R1/R2/R5/R9/R10 五张卡、异机验收、push、合 main、打标签、发布、部署
```

## 10. 剩余需要你决定/动手的项

1. ~~要不要跑那十张真实异常卡~~ → 已按你的批准跑完 R7/R4/R8/R6/R3（第 6 节）。剩下 R1/R2/R5/R9/R10 五张仍是可选项，其中 R2 会再造一个 `outcome_unknown`，建议不做。
2. ~~R6 留下的 `blocked` 任务怎么处置~~ → **已决定（2026-11-06 15:30）：按 T7D 口径原样保留**。只读复核（`dist\recovery-cli.js show` / `observe`）两次 exit 0，`available: []`、`proof: {reconcile:null, close:null}`、`history: []`、`declaration: null`；因此"用恢复控制台记人工声明"这条路径现在根本走不通（会抛 `RECOVERY_UNPROVEN`，连确认输入都到不了）。主库 `workflow_capacity` 继续被 `d1-workbuddy-2cc8e262…` 占着，没有再派任务。复核输出：`evidence\cards\r6\recovery-console-show.json`。
3. **第二台 Windows**：有机器时按 `DEPLOYMENT_ACCEPTANCE.md` 走（全新 clone、不复制 .env/DB/会话）；没有就维持待外部条件，不拿 VM/CI 冒充。
4. **许可证与代码签名**：由权利人决定（L04 已把 94 个生产依赖的许可归集好，仓库仍无 `LICENSE`，包未签名）。
5. ~~是否把新装的 MCP 片段合并进 `C:\Users\LENOVO\.codex\config.toml`~~ → **已决定（2026-11-06 15:33）：本轮不合并**。理由：主库被 R6 的 blocked 任务占着，合并后工具只能读、`send_task` 必撞 `CAPACITY_OCCUPIED`；`config.toml` 是全局入口，与 T7B 的 `workbuddy` 条目名字近似会增加噪音；本轮派工走 `scripts\workbuddy-call.mjs` 已证明可靠。片段留在 `<root>\data\workbuddy-mcp.toml`，预览留在 `evidence\codex-config-preview\`，需要时追加一次即可；**`config.toml` 始终未被写入**（7,449 字节 / 0 处 `workbuddy_rc`）。
6. ~~网关自登记的常驻服务是否保留~~ → **已决定（2026-11-06 15:30）：保留**。它提供原生自动唤醒，本轮真实派工的现场形态就包含它；撤掉解不开主库上的 R6 占用，只会让安装形态与已产出证据不一致。换库的摩擦有确定解法：同时把 `WORKBUDDY_SERVICE_CONFIG` 指到不存在的路径（R3d 已验证）。**没有执行** `service-cli uninstall`。
7. **启动客户端的固定动作**：`E:\javaproject\workbuddy-install\start-workbuddy-debug.ps1`（先完全退出客户端，再运行；它只在当前进程设 `WORKBUDDY_REMOTE_DEBUGGING_PORT`，不写系统环境变量、不装服务）。不这么做时网关无法自己拉起带调试端口的实例。
8. **是否把这两单之外的执行器组合也跑一遍**（例如 WorkBuddy 换更贵的模型、DSH 换低推理档）：这属于新的逐任务选择，需要你在派发前确认模型与费用口径。

细节与每项的最小动作见 `docs/delivery/EXTERNAL_CONDITIONS.md`；逐样本证据索引见 `docs/delivery/LIVE_ACCEPTANCE_EVIDENCE_INDEX.md`。
