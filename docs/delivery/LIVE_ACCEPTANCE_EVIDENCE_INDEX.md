# 真实验收证据索引与脱敏摘要（10 线）

- 生成时间：2026-11-06（Asia/Shanghai）
- 原始状态目录：`E:\javaproject\outputs\finish-live-20261106\`（**不入包、不进仓库、不推送**）
- 安装根（本机）：`E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1`
- 全量清单：`E:\javaproject\outputs\finish-live-20261106\evidence-manifest.json`（每个文件的 sha256 + 字节数）
- 口径：本文件只做索引和脱敏摘要；任何"通过/失败"结论都必须能回到下面列出的具体文件。

## 0. 脱敏声明

- 全程没有读取、没有导出、没有在聊天里出现：账号、API Key、`accounts/` 目录、真实 `.env` 全文、客户端登录态、Cookie、token。
- 政策类字段（backend、db 路径、model id、超时、轮次）用"源文件稳定读取 + 自有临时副本"方式提取，副本目录 `env-copies\` 用完即清空（现为空目录，已核对）。
- 任务库副本只含任务/政策/容量/评审记录，不含凭据；`quota_connections`、`credit_balance_connections` 本来就是 0 行。
- 样本里没有真实用户数据（`live-acceptance-fixture.mjs` 生成的合成工程，只有 `clamp.mjs` / `paid-summary.mjs` 与各自的 `acceptance.test.mjs`）。
- 新装 `.env` 只记录键名与哈希，不复制值到文档。

## 1. RC 身份与实际安装（只读 + 本轮安装）

| 证据 | 位置 | 摘要 |
|---|---|---|
| 网关包哈希 + 694 文件逐条复算 | 见 `LIVE_ACCEPTANCE_SUMMARY.md` §3.1；复算脚本 `scripts\code-hash.mjs`（`80d1cce9cc9e70bd…`, 1535B） | listed 694 / verified 694 / 7,273,213B / mismatch 0 / missing 0 / extra 0 |
| 五个代码位置的 codeHash | `scripts\code-hash.mjs` 对各位置 `dist` 复算 | T7B `8427e9e1…`、community `d5529e49…`、integrated `8110503b…`、F 0.7.0 `a365d167…`、RC `ac2a673f…` |
| T7B 运行中服务自报 | `…T7BPreview-20261031\…\gateway\data\persistent-service-status.json`（849B，只读） | `codeHash 8427e9e1…` 与磁盘一致；`status:"no_task"`；`updatedAt 2026-11-06T02:35:49Z` |
| **本轮安装记录** | `outputs\finish-live-20261106\evidence\INSTALL_RECORD.md` | 安装根、参数、`verify-release` 694/694、`setup plan/install` 结果、产物哈希、技能备份、回退办法 |
| **新装 doctor** | `outputs\finish-live-20261106\evidence\doctor-new-install.json` | `ok:true, readOnly:true, localSetupReady:true`；`codeHash ac2a673f…`；`freePolicyEnabled:false`；`login:unknown`；`taskSent:false` |
| 新装 verify-release 日志 | `outputs\finish-live-20261106\evidence\verify-release-new-install.log` | `{"version":"0.7.1","verifiedFiles":694,"hashesMatch":true}` exit 0 |
| 安装产物哈希 | `<root>\.env` 335B `4b41648dc652028e…`；`data\workbuddy-mcp.toml` 465B `abdcfc7a24816381…`（= 清单 `snippetHash`）；`data\deployment-installation.json` 1,034B（`installedAt 2026-11-06T03:18:09.022Z`） | 三者互相印证 |
| 技能位 | `C:\Users\LENOVO\.codex\skills\workbuddy-executor`（6 文件）与 `skills\deepseek-executor`（2 文件） | 现与 RC 逐字一致；旧版备份 `skill-backups\workbuddy-executor-I5FgPH` |

## 2. 政策与容量（只读副本 + 本轮新库）

历史库副本：`outputs\finish-live-20261106\db-copies\`

| 文件 | 字节 | sha256(前16) | 用途 |
|---|---|---|---|
| `T7B-live-state.sqlite` | 237,568 | `DA9A07B0FA1A7018` | `collaboration_policy`、`workflow_capacity`、`task_admissions`、`native_stop_declarations`、`dsh_attempt_bindings` 等 |
| `community-E.sqlite` | 32,768 | `7A4285C18B6A7004` | 无 `workflow_capacity` 表 |
| `integrated-validation.sqlite` | 32,768 | `7A4285C18B6A7004` | 同上（与 community 同哈希） |
| `F-WorkBuddy-0.7.0.sqlite` | 495,616 | `80F614DAB709F3A7` | 同上 |

查询脚本：`scripts\read-capacity.mjs`（`f7d68e532d0a87c3…`）、`scripts\read-p01.mjs`（`8dd1567d2908bde7…`）、`scripts\probe-db.cjs`（本轮用，参数为库路径）。

历史读数（T7B）：

- `workflow_capacity`: `slot=1 / task_id=t7c-mcp-live-range-20261031-01 / executor=workbuddy`（**未动**）
- `collaboration_policy`: `maxAttempts=3 / maxTimeoutSeconds=86400 / requireFree=true / allowed 仅 1 项 / version policy-4zf1EnD-F3K4-rg70_7szRLJ`，`selectionMode` 未落库
- `task_attempt_admissions` 2 行：`credits:"x0.00"`、`level:"selected"`
- `native_stop_declarations` 0 行、`dsh_attempt_bindings` 0 行、`quota_connections` 0、`credit_balance_connections` 0

本轮新库（`workbuddy-install\gateway-v0.7.1-rc1\data\tasks.sqlite`）：

- 派工前：25 表、`workflow_capacity` **0 行**、tasks 0、`collaboration_policy` 0 行 → 首次使用取默认 `requireFree:false` / `selectionMode:"user_choice"` / `allowed:[]`
- 派工后（含五张卡）：tasks 6 = DSH accepted、WorkBuddy accepted、R4a cancelled、R4b cancelled、R8 accepted、**R6 blocked**。
  - DSH 单接受后容量行仍指向 DSH；WorkBuddy 单认领时 `claim()` 检测到 DSH 占用者已 `isClosed()`（`stopped`+attemptId 匹配+`task_closed`）→ 删行写入 WorkBuddy 任务。
  - **当前容量行指向 R6 的 blocked 任务**（`d1-workbuddy-2cc8e262…`、operationId `card-r6-foreign-session-1793948211334`），未释放；详见第 8 节与外部条件 E19。
  - 隔离库 `cards\r3b\state\tasks.sqlite`：2 个任务均 accepted，容量行指向 R3d 任务（已 `task_closed`，下次认领自动清行）。
  - 全程只有一个未关闭工作流，**没有任何绕过容量的操作**。

## 3. 样本 A：WorkBuddy 端（`src/clamp.mjs`）—— 已真实派工并通过

根：`outputs\finish-live-20261106\samples\live-acceptance-b2Cgxq\workbuddy`

| 文件 | 字节 | sha256 | 说明 |
|---|---|---|---|
| `src/clamp.mjs` 基线 | 300 | `a865956f688e0daadce8640bf9bf33e3279462e18d313ffb4b7943f8fcc9c5b0` | 唯一允许修改的文件 |
| `src/clamp.mjs` 终态 | 300 | `c5533fab8d9a93bae501dcfd14059055c46c963ecacf720c32f76100458ad4b6` | 第 4 行 `Math.max(lower, Math.max(value, upper))` → `Math.min(upper, Math.max(lower, value))` |
| `checks/acceptance.test.mjs` | 953 | `e46e3a157d6d11b5048bd70fa5b210b09ad299463d47e7675f687563207b6061` | 未变（范围守住） |
| `README.md` | 293 | `b133aa74f9a2ce5715595f3c6e5b2cfc56621dd1f3a301b1f2c9e33c9b209f6b` | 未变 |

真实模型目录：`outputs\finish-live-20261106\evidence\workbuddy-models.json`（5042B）
- 23 条；字段只有 `id`/`name`/`credits`，**没有 `reasoningEfforts`** → 本单推理档只能 `null`
- 目录里没有裸 `deepseek-v4.1-flash`，只有 `deepseek-v4.1-flash-sg`（`credits x0.11`，相对倍率，非金额）
- 运行时摘要 `ac2a673f187546dc9d00c7a20a56ad6fad86adf54a2b0e90d22d1fbcd681e326`（与本机 RC 一致）

契约（已填、已授权）：`outputs\finish-live-20261106\contracts\workbuddy-filled.json`
- `taskId d1-workbuddy-2fec4908-eb45-45eb-8852-8e8411b0cacf`
- `execution{executorId:"workbuddy", connectionId:"local-workbuddy", providerId:"workbuddy-native", modelId:"deepseek-v4.1-flash-sg", reasoningEffort:null}`
- `collaboration{planId:"plan-WdMpn6FZddWoqmlRFP1NbXIo", expectedPlanRevision:"nVjdIUE16zNRS16XITmlskUW"}`
- `timeoutSeconds 600`、`maxAttempts 1`、范围 `["src/clamp.mjs"]`、3 条 requiredChecks（`independent-command` 为精确 CommandSpec）

派工与终态
- `workbuddy_send_task` → attemptId `run-bc7288ad-bedb-4593-852d-551e91e6a1e3`，原生会话 `da998f42-39df-4866-b274-c99a43c50603`，`runtimeSource:"desktop_queue"`
- 原生停止：`nativeStopSource:"native_idle"`、`stopReason:"end_turn"`、`nativeStoppedAt 2026-11-06T06:14:07.761Z`、`stopped:true`
- 独立命令：`command-147c9d82-1e6f-4b4a-a145-366d94730ef1`（passed / exit 0 / cleanupConfirmed）
- 独立核对：`inspection-439c2888-261a-485e-aa07-ea33edad852e`
- 程序检查：`machine-5e4f2568-f402-4b37-a662-9588dd3d5822`（`$provenance`、`$scope`、`independent-command` 全 passed）
- 复核：`review-a7598513-0642-4caf-bc29-9d66886ee3e9`（`committedRevision hgkJZeo6KgaKKRD5M-sVnb3E`、`submissionHash 1c1b759c…`）
- 接受：`state:"accepted"`、revision `nViAz0BiNEdMDcsL`、`reviewedAt 2026-11-06T06:15:38.488Z`

证据包：`outputs\finish-live-20261106\evidence\workbuddy\`（10 个 JSON，与 DSH 侧同名同结构：`final-state`、`events`、`review-records`、`admission`、`attempt-admissions`、`contract`、`plans`、`capacity`、`policy`、`baseline-compare`）。

## 4. 样本 B：DSH 端（`src/paid-summary.mjs`）—— 已真实派工并通过

根：`outputs\finish-live-20261106\samples\live-acceptance-b2Cgxq\dsh`

| 文件 | 字节 | sha256 | 说明 |
|---|---|---|---|
| `src/paid-summary.mjs` 基线 | 610 | `6b6bb4b997cce6f5acc09fcb4eed63eff816c6eec3b371b3ef33076ac1001276` | 唯一允许修改的文件 |
| `src/paid-summary.mjs` 终态 | 606 | `ae31bca8ba19d7ba1e25339aacb13e4a2e57f41ac593da2047aa4907b77213dd` | 执行器只改了第 6 行：`!== 'refunded'` → `=== 'paid'` |
| `checks/acceptance.test.mjs` | 1500 | `c6a5043e786688dc0c38718b3a7b938d7e7284dccc7ac4aeeb84885c84bcae52` | 未变（范围守住） |
| `README.md` | 312 | `dd47d363c6e2128fa5d9fd11bfc9af295b1babc8fea580c85d10d61cac125fda` | 未变 |

契约（已填、已授权）：`outputs\finish-live-20261106\contracts\dsh-filled.json`
- `taskId d1-dsh-5f82573e-b87a-4ff1-acd9-ec8d541243f5`
- `execution{executorId:"dsh", connectionId:"dsh-53ae185d3f716fee84db", providerId:"wb-proxy", modelId:"deepseek-v4.1-flash", reasoningEffort:"high"}`
- `collaboration{planId:"plan-fKA3XfFJIXdllaD0yku0cznc", expectedPlanRevision:"M1b-zcg_0ElwOuhr1idFF6Xo"}`
- `timeoutSeconds 600`、`maxAttempts 1`、范围 `["src/paid-summary.mjs"]`、3 条 requiredChecks（首条为精确 CommandSpec）

证据包：`outputs\finish-live-20261106\evidence\dsh\`

| 文件 | 内容 |
|---|---|
| `final-state.json` | 任务终态：`state:"accepted"`、`attemptId run-4fc382d9-daa5-46d8-bc9a-e4ff17f8c532`、`revision DNbnQevDQ_eiY3Fy`、`reviewedAt 2026-11-06T05:55:54.478Z`、`evidence ["review-684133fe-…"]` |
| `events.json` | 全部事件（`attempt_queued`、`dsh_started`、`dsh_progress`×29、`dsh_completed`、`native_stop_confirmed`、`report_received`、`program_checks_recorded`、`independent_command_recorded`、`independent_inspection_recorded`、`independent_review_recorded`、`task_closed` 等） |
| `review-records.json` | 机器检查/核对/复核三类记录与 `digest` |
| `admission.json` / `attempt-admissions.json` | 任务准入与 attempt 准入（含 `credits:"x0.00"`、`observedAt`） |
| `contract.json` | 契约与 `contractHash`、`agreementVersion` |
| `plans.json` | 计划 `plan-fKA3XfFJIXdllaD0yku0cznc`、`authorizedAt 2026-11-06T05:35:52.924Z`、`authorizationSource "user-confirmed 2026-11-06 m00477 dsh dispatch"`、`consumedBy` 指向该任务 |
| `capacity.json` | `workflow_capacity` 行 + `closedEventPresent:true`（说明清行条件已具备） |
| `policy.json` | 新库无政策行（`null`）→ 取代码默认 |
| `baseline-compare.json` | 三个文件的基线/终态 sha256 对照（只有 mutable 文件变化） |

关键原生停止证据（来自 `final-state.json` 的 `runEvidenceDigest`）：
`nativeStopSource:"dsh_terminal_event"`、`terminal.rawType:"turn/end"`（seq 38）、`requestId===attemptId`、`nativeStoppedAt 2026-11-06T05:37:16.483Z`、`effectiveModel{providerId:"wb-proxy",modelId:"deepseek-v4.1-flash",reasoningEffort:"high",seq:14}`。

复核 ID：`review-684133fe-a47d-46c2-becf-d919c00f18e2`；`agreement hash 6ad0ebcf…`、`version av1-d1d1f6ad21f7551a8cf44d55c3c89c94`；`committedRevision zWVvf5wQxAoQ9OEtzOuxtQT1`。

## 5. 样本整体与基线

| 文件 | 字节 | sha256 | 说明 |
|---|---|---|---|
| `baseline.json` | 2330 | `51476979c3ba7e2d9dfed377cf2b216d97dfdf22c3502088a68ba06d6fef334a` | 样本基线，`verify` 用它做完整性判定 |
| `owner.json` | 113 | `31ede93f647b899b` | 归属记录（合成） |
| `logs/fixture-create.log` | 1732 | `6e0ce2ac8cf4ae30…` | `create` 输出，exit 0，`preparedOnly:true authorized:false` |
| `logs/fixture-verify.log` | 178 | `8ea9c67183443d24…` | `verify` 输出，`{"ok":true,"preparedOnly":true,"authorized":false,"problems":[]}`，exit 0 |

样本侧结论：**DSH 与 WorkBuddy 两半都已从"准备完成"推进到"真实执行并被接受"**（WorkBuddy 侧需要客户端带调试端口启动，见 E16；这一环境依赖不影响证据本身）。

## 6. 合成验证证据（历史，非本轮产生）

| 线 | HANDOFF | 关键数字 |
|---|---|---|
| L01–L04 | `outputs\finish-l0x-20261105\HANDOFF.json` | base `1f60374a`；commits 1/3/2/1；`liveVerified=false` |
| L05–L06 | 同上 | base `af9bab6f`；commits 2/2；L05 workbench 123、npm test 1163/1151/12 skipped；L06 desktop:test 87、dotnet 0 警告 0 错误 |
| L07 | 同上 | base `000e9da1`；commits 2；npm test 1254/1242/12 skipped；automation smoke 12 命令 / 2 refused / 0 tasksCreated |
| L08 | 同上 | base `000e9da1`；commits 3；gateway 全量 1244/1232/12 skipped exit 0；四个专项 10/10、10/10、8/8、6/6、1/1；workbench 131 |

八条线共同：`implemented=true`、`syntheticVerified=true`、`liveVerified=false`、`deployed=false`、`releaseReady=false`。
G3 汇总：全量 1281 tests / 1269 pass / 0 fail / 0 cancelled / 12 skipped，exit 0；workbench 139/139；desktop:test 92；两线专项 76/76（见 `G3_RECEIPT.md`）。

## 7. 没被任何证据覆盖的（明确缺口）

- ~~WorkBuddy 侧真实派工与真实原生停止~~ → **本轮已覆盖**：`nativeStopSource:"native_idle"`、`review-a7598513-…`、`state:"accepted"`（见第 3 节）。
- 真实模型选择与真实费用金额（两单的 `credits` 都是相对倍率/观测值；无 quota/credit 连接，未产生任何真实计费数字）。
- 真实窗口行为：四尺寸、200% 缩放、读屏、桌面壳截图（0 个 Workbench 进程）。
- 双进程并发同键（V06）只有同进程双连接证据。
- 两个执行器在同一 workspace 上的对照并跑（本轮按容量 1 严格串行：先 DSH 关闭后才认领 WorkBuddy）。
- 第二台物理 Windows 的全新 clone 与五场景。
- 异常卡里没做的五张：R1 准备不确定、R2 投递不确定、R5 到期迟到、R9 旧 attempt-review-源码、R10 资源故障期间停止（已做的 R7/R4/R8/R6/R3 见第 8 节）。
- R6 只覆盖了"外来会话 + 本 workspace"这一种错配形态；同一会话跨两个受控 fork 并发的形态没测。
- 常驻服务钉库后的换库路径只用"同时覆盖 `WORKBUDDY_SERVICE_CONFIG`"绕过，没有走 `service-cli uninstall` 的正规撤除路径。
- `run-worker` detached EPERM 的根因。

## 8. 真实异常卡证据（R7 / R4 / R8 / R6 / R3）

五张卡各用独立样本副本与独立原生会话，模型均为 `deepseek-v4.1-flash-sg`、`reasoningEffort: null`。

| 卡 | 目录 | 关键文件 | 结论 |
|---|---|---|---|
| R7 错执行器同键 | `evidence\cards\r7\` | `db-snapshot.json` | `OPERATION_CONFLICT`（"selected a different executor"）；tasks 2 / attempts 2 / send 2 未变，容量未变，无新 run 目录 |
| R4 领取后取消 | `evidence\cards\r4b\` | `r4-timeline.json` | 认领 06:31:09.696 → 取消 06:31:09.710 → `native_stop_confirmed`（`native_idle`）06:31:11.782 → `task_closed` 06:31:11.809；工作区 `clamp.mjs` 仍为基线 `A865956F…` |
| R8 预算耗尽 | `evidence\cards\r8\` | `r8-timeline.json`、`r8-close.json` | `maxAttempts=1` 返工被拒；等停止证据折入后走完 command/inspection/machine/review 并被接受，revision `hb6o85fI5h8u3uyf` |
| R6 错会话归属 | `evidence\cards\r6\` | `recovery-view.json` | **不是干净拒绝**：外来会话 `da998f42…` 触发无 code 的 `Error`（`workspace-workers.js:97`）→ 任务 `blocked`、`attempt_id:null`、操作 `outcome_unknown`、容量被占、`blocking_reason` 无因由；主库任务 `d1-workbuddy-2cc8e262…` |
| R3 报告先到原生未停 | `evidence\cards\r3\` | `r3-timeline.json`、`r3d-close.json`、`r3b-close.json`、`r3c-blocked-first-attempt.json` | 窗口 07:19:39.124（`needs_review`、`digest.stopped:false`）→ `run_review_command` 被拒 `STOP_UNCONFIRMED`；停止折入后 command → inspection → `machine-9fc2064c…` → `review-f91ca58d…` → accepted；工作区仅 `clamp.mjs C5533FAB…`，测试 7/7 |

补充：
- R4 第一次尝试（`cards\r4\live-acceptance-TD6jzc`）暴露操作顺序问题——取消后不触发同步就不会落 `task_closed`，容量保持占用并让下一次派工报 `CAPACITY_OCCUPIED`（总结第 6.2 节、外部条件 E09）。
- R3 前两次尝试（`cards\r3`、`cards\r3c`）撞上常驻服务钉库与一次同类 preparation 失败，均落 `blocked`；真正的卡在 `cards\r3d` 上取得干净窗口（外部条件 E18）。
- 原始状态留在 `outputs\finish-live-20261106\cards\`（各 fixture 与 state 库），未入包。

另附本轮为"可运维"生成的产物（非验收证据）：
- `E:\javaproject\workbuddy-install\start-workbuddy-debug.ps1`（带调试端口启动客户端）；
- `evidence\codex-config-preview\{proposed-block.toml, merge-preview.md, merge-preview.json}`（Codex 配置合并预览，文件未被修改）。
- `LICENSE` 与代码签名。
