# A 线回执（forward-delivery-20261107）

工作树：`E:\javaproject\workbuddy-forward-20261107\A-runtime`
分支：`feat/forward-runtime-readiness`，起点 `134cdc7febbf858e89fb1010cf6b9d72da5edbe7`
证据目录：`E:\javaproject\outputs\forward-delivery-20261107\A\`

本线只改了归属内的文件：`gateway/src/*`（coordinator 之外的运行链路/安装/诊断）、`gateway/desktop/*`、`gateway/scripts/*` 及对应测试。
`task-store.ts`、`task-application-service.ts`、`server.ts`、`workbench-*`、`app.mjs`、`index.html`、`package*.json`、公共 schema/迁移、`SKILL.md` 一行未改；需要 I 接线的部分见 `INTEGRATION_REQUEST_A.md`。

## 1. 提交清单

| # | commit | 标题 | 文件 | 行数 |
|---|---|---|---|---|
| 1 | `11d96a5` | A02: split desktop startup into bounded stages and stop reporting a hang as a cancellation | `gateway/desktop/Program.cs`、`gateway/desktop/StartupProgress.cs`(新)、`gateway/desktop/test/PolicyTests.csproj`、`gateway/desktop/test/Program.cs`、`gateway/scripts/package.mjs`、`gateway/test/package.test.ts` | +459 / -36 |
| 2 | `0f0a263` | A01: report five readiness layers separately, with install selection as its own state | `gateway/src/readiness.ts`(新 512)、`gateway/scripts/readiness.mjs`(新 36)、`gateway/test/readiness.test.ts`(新 331) | +879 / -0 |
| 3 | `c1b9f8d` | A03: name an unreadable journal and consume a single input answer exactly once | `gateway/src/run-journal.ts`、`gateway/src/run-worker.ts`、`gateway/test/run-journal.test.ts`、`gateway/test/run-worker.test.ts` | +112 / -27 |
| 4 | `161097e` | A04: turn the lockfile install into planned, bounded steps with a named failure | `gateway/src/installation-bootstrap.ts`(新 154)、`gateway/scripts/bootstrap.mjs`(新 51)、`gateway/test/installation-bootstrap.test.ts`(新 92) | +297 / -0 |
| 5 | `27f92fd` | A04: let the first run install from the lockfile before the planner exists | `gateway/scripts/bootstrap.mjs` | +51 / -6 |
| 6 | `ecedc5c` | A05: bound the two load-only failures instead of letting them read as absent | `gateway/src/native-process.ts`、`gateway/src/run-journal.ts`、`gateway/test/native-process.test.ts`、`gateway/test/run-journal.test.ts` | +133 / -13 |

共 6 个代码提交，触及 17 个文件（其中 7 个新增：`StartupProgress.cs`、`readiness.ts`、`readiness.mjs`、`readiness.test.ts`、`installation-bootstrap.ts`、`bootstrap.mjs`、`installation-bootstrap.test.ts`），合计 +1931 / -82 行；另有本文件与 `INTEGRATION_REQUEST_A.md` 的文档提交（分支上 A 线最后一个提交，`git log -1 -- docs/forward` 可查）。

## 2. A01 运行身份与就绪分层诊断

**原缺口**：`doctor --live` 只回答「工具能不能响应/模型政策」，`deployment` 只回答「候选包能不能装」。五件事（工具可响应 / 原生在线 / 项目会话可接单 / 候选已部署 / 桌面页已就绪）没有一处同时分开；`packageVersion=0.7.1` 被当作「是不是同一个东西」的证据；缺运行摘要时没有明确语义。I 线实测的 E1（本机两个 WorkBuddy 数据目录 → `loadConfig()` 直接抛错）在旧诊断里表现为整条命令失败，看不出「歧义」本身是一个状态。

**实现**（`gateway/src/readiness.ts`，`node scripts/readiness.mjs`）：
- `READINESS_SCHEMA = "workbuddy-readiness/v1"`，`observeReadiness()` 输出 `{schema, readOnly:true, observedAt, selection, layers[5], nextAction, notes}`；每层 `{layer, question, state, observedAt, facts, missing[], reason?}`，`state ∈ ready|unverified|blocked|absent|unknown`。
- 层内事实只放「从这台机器上读到的东西」：`buildPresent`、`runtimeSummary`（来自 `data/persistent-service-status.json` 心跳，`pid` 必须正整数、`codeHash` 必须 64 位 hex，否则 `found:false`）、`runtimeHeartbeat`、`applicationPresent`、`configSchemaCompatible`、`capacity`（`workflow_capacity` 单行）、`sessionCount`（自带只读 SQL，区分「0 个」与「读不到」）、`registration`（registered/absent/unreadable）、`page`、`startup.outcome/startupStage/failureCode`。
- 缺运行摘要 → `unknown` + `missing:["runtime_summary"]`，**不回落磁盘 `package.json` 版本**；候选层只有在「运行摘要里的 codeHash」和「安装目录 `dist` 的 codeHash」都拿到时才敢比，否则 `unknown`。磁盘 `packageVersion` 只作为展示字段，注释里写明它永不替代运行事实。
- 配置歧义是**独立状态** `selection.state = resolved|ambiguous|missing`，列出 `config.candidates` / `executable.candidates`，`nextAction.layer = "selection"` 优先于任何一层；`suggested` 只打印 `$env:WORKBUDDY_CONFIG_DIR = "…"` 这类建议命令，**不写任何配置文件、不建库**。
- 只读性：全部读路径（`DatabaseSync({readOnly:true})`、`readFileSync`、命名管道快照），不准备模型、不启动服务、不改会话；`scripts/readiness.mjs` 里 `loadConfig()` 的错误被捕获成 `configError` 事实，而不是让进程崩掉。
- 桌面页就绪：自建命名管道客户端 `observeDesktopWindow()`（`\\.\pipe\WorkBuddy.Workbench.<instanceKey>`，请求 `{taskId:null,status:true}`），要求 `ready === true` 且 page 匹配 `^http://127\.0\.0\.1:\d{1,5}/workbench/?`；壳没有 `startup` 子对象时 `blocked` + `missing:["startup_diagnostics"]`，理由是「这份壳无法区分环境创建和控制器创建」，需要重装新壳。
- 唯一「下一动作」：`pickNextAction()` 只给一条，文案里带具体开关（`WORKBUDDY_DESKTOP_DISPATCH_ENABLED=1`）或「先按原身份核对停止证据、不换库不换身份」。

**复验**：
```
cd gateway; $env:WORKBUDDY_CONFIG_DIR='C:\Users\LENOVO\.workbuddy-ai'
npx tsx --test test/readiness.test.ts     → tests 27 / pass 27 / fail 0
node scripts/readiness.mjs                → 五层 + Next action(selection) + 建议命令，退出码 1（未全 ready）
```
本机实跑（dev 根，未改任何配置，证据 `readiness-dev-root.txt` / `.json`）：
`backend: unresolved | config: ambiguous [%USERPROFILE%\.workbuddy-ai, %USERPROFILE%\.workbuddy] | executable: missing`
→ `unknown / absent / unknown / unknown / unknown`，`Next action (selection)`。

**判定**：E1 四条要求全部落地（歧义独立状态并列出候选、下游层不回落磁盘版本、CLI 同打 backend/config.source/candidates/executable.source 且不写配置、测试前先固定 `WORKBUDDY_CONFIG_DIR`）。缺口关闭（源码 + 合成层）；窗口/实机层未验证（本机没有可用桌面会话）。

## 3. A02 桌面壳启动阶段

**原缺口**：`startupStage` 只有 `runtime → host → host_ready → webview → navigate`，`profile 创建`、`WebView environment 创建`、`controller 创建` 三步合成在 `webview` 一个名字里；`CoreWebView2Environment.CreateAsync` / `EnsureCoreWebView2Async` 不返回时快照只有 `startupStage=webview`、`failureCode=null`，看不出卡在哪一步、等了多久、有没有界；等待被取消时只能靠 `OperationCanceledException` 反映，而「界到期」和「步骤自取消」共用同一个异常类型 —— 一旦写进 `failureCode` 就是把超时伪装成「已取消/已停止」。

**实现**（`gateway/desktop/StartupProgress.cs` 新增 277 行 + `Program.cs` 改造）：
- 阶段拆开：`runtime → host → host_ready → profile → webview_environment → controller → navigate → ready`（旧前缀保留，历史证据仍可读）。每步记录 `elapsedMs`（进入时刻）与 `boundMs`（预算），`profile` 是同步调用，预算写 0 并在文档里写清「同步、无界」。
- 四种终止语义分开：`timeout:<stage>`（预算到期）、`interrupted:<stage>`（步骤自己取消，窗口没关）、`closed`（操作者关窗，无 `failureCode`）、`failed:<异常类型>`。预算到期靠 `task.WaitAsync(budget)` 抛 `TimeoutException`，**不用 `CancelAfter` 造取消**，所以「我们自己的界」不会伪装成取消。
- 挂在运行时的自解释快照：`startup = {outcome, startupStage, stageElapsedMs, awaitingStage, awaitingMs, awaitingBoundedMs, transitions[], failureCode, failureStage, failureDetail}`；`outcome` 里 timeout / interrupted / closed 三态互不混用，`failureCode` 里不出现 cancel/stop 字样。
- 宿主归属：`OwnedHost<T>`（`Interlocked.Exchange`）保证「上一轮的 `Exited` 处理器 / 迟到的重试」只能处理本窗口拥有的宿主，重试连点由 `progress.TryBegin()` 挡住，不会起第二个宿主、第二个 WebView。
- `WebView2RuntimeNotFoundException` 现在也写 `failureCode`（原来是 UI 变红但快照里 `failureCode=null`）。

**复验**：
```
cd gateway\desktop\test; dotnet run --project PolicyTests.csproj -v q --nologo
  → {"passed":122,"failed":0}     （原 92，新增 30 条：阶段顺序/耗时、timeout 不等于 cancel/stop、
                                   挂住的阶段停在原地、等待与预算同时可读、宿主只归最新一轮、关窗无 failureCode）
cd gateway; npx tsx --test test/package.test.ts → 13 / 13
```
**未覆盖**：**窗口实测未做**。本机没有普通桌面会话条件（既有证据只到「宿主存活 + HTTP 200 + `startupStage=webview` 未 ready」），阶段转移与清理全部由可注入的假时钟 + 替身宿主覆盖。真实 `CreateAsync`/`EnsureCoreWebView2Async` 在本机的行为、以及 `timeout:webview_environment` 是否真的会在 30s 触发，仍需一次普通桌面会话复跑。

## 4. A03 核心生命周期保真

**原缺口**：逐条核对六项后，只有两块是真实空白（其余四项既有修复必须原样保留）：

| 项 | 结论 |
|---|---|
| 领取后取消 | 已有：`requestCancellation` 写 `cancel.json`，`report()` 在 `cancellationRequested()` 时置 `cancelled` 且 `nativeStoppedAt` 留空 —— 不冒充停止。保留。 |
| 报告先到仍忙 | 已有：`observeNative` 的 idle 分支先看 `reportDigest` / 终态 `stopReason`，只补停止证据、不改写已认证报告。保留。 |
| 连接丢失 | 已有：`mutateClaim` 校验 `leaseHash`/`desktopPid`/`sessionId` 三项，不符即拒。保留。 |
| 迟到报告 | 已有：只有「已领取 + 未认证 + cancel.reason=deadline」才写 `late-report.json`；未领取的超时不可能有 claim，`mutateClaim` 先拒，不存在信息丢失路径。保留。 |
| **同键/冲突键** | **空白**：`respond()` 撞 EEXIST 时把裸 `EEXIST` 文本抛给上层，旧测试甚至把 `/EEXIST/` 当契约；worker 侧同一 `method:id` 复现时旧答案会被自动套用 —— 等于没有人工点击的 `allow_once`。 |
| **journal/PID 读失败** | **空白**：`state.json` 解析失败抛裸 `SyntaxError`（没有 attempt 上下文），且 `DurableRuns.messages` 跟着抛，整个列表不可用；「读不到」与「不存在」在调用侧无法区分。 |

**实现**（`c1b9f8d`）：
- `run-journal.ts` 新增 `UnreadableJournalError`：`snapshot()` / `request()` 只在 ENOENT 当「不存在」，其它一律包成带 `attemptId`/`file`/`cause` 的错误，消息里写明「unreadable is not absent，nothing was resent/re-claimed/closed」。
- `DurableRuns.messages` 只为该错误降级成一条 `source:"unreadable-journal"` + `status:"blocked"` + `blockedReason:"journal_unreadable"` 的记录，让状态可见；其它错误（含 "not found; refusing"）照旧外抛。
- `respond()` 把 EEXIST 翻成「这个 input 请求已经答过，第一次的答案被保留、没有被覆盖」。
- `run-worker.ts` 读到答案后先删 `input-<key>.json` 再解释：一个答案只消费一次，同一请求 id 复现必须重新等人工决定。

**复验**：
```
cd gateway; $env:WORKBUDDY_CONFIG_DIR='C:\Users\LENOVO\.workbuddy-ai'
npx tsx --test test/run-journal.test.ts test/run-worker.test.ts → tests 14 / pass 14 / fail 0
npx tsx --test test/desktop-queue.test.ts                       → tests 24 / pass 24 / fail 0
npx tsc --noEmit -p tsconfig.json                               → exit 0
```
新增用例：`a damaged journal is reported as unreadable, never read as absent`（含「文件字节未变、没建 cancel.json」）、`a repeated input request is never satisfied by an earlier answer`。
**没有做的事**：没有把任何 `catch` 改成 `false`；`alive()` 非 ESRCH 仍算存活、`EPERM` 仍不等于进程消失、未知仍继续占用共享容量、工作树有结果仍不等于成功。

## 5. A04 可复现安装与桌面成品

**原缺口**：`npm ci` 在整个仓库里只出现在提示文案（`installation-dependencies.ts` 的 remediation、`installation-readiness.ts:317` 的 `runtime_dependencies`），没有任何**可执行**步骤按 lockfile 装依赖再构建；所以「文档里的安装路径能真的执行」无法被验证，桌面成品也只有打包器产出的 `desktop/app` 约定，没有一个从空目录走到 `.exe` 的实测。

**实现**：
- `gateway/src/installation-bootstrap.ts`：`planInstallationBootstrap()` 先给 blockers（`install_root`/`node_version`≤`supportedNode`/`package_json`/`package_lock`/`build_script`）和 steps（`npm_ci`：`dist` 存在时 `ci --omit=dev`，否则全量 `ci`；`npm_build`：`run build --if-present`），`runInstallationBootstrap()` 逐条执行、记录 `exitCode/durationMs/output`，失败即停后续标 `skipped`，成功后再跑一次 `diagnoseInstallationDependencies()` 并把 `gaps` 合进 `next`。Windows 上 `.cmd` 必须经 `ComSpec /d /s /c`，否则 `npm.cmd` 直接被 spawn 会 3ms「成功」而 `exitCode` 未知 —— 这是实测踩到的坑。
- `gateway/scripts/bootstrap.mjs`：`--install-root`(必需)/`--apply`/`--npm`/`--timeout-ms`/`--json`/`--report`；`dist` 还不存在的**首跑**走脚本内联路径（先校验 package.json + package-lock.json，再真跑 `npm ci` + `npm run build`），之后交给 planner。
- 依赖检查沿用并复用了既有 11 行探针（`node_version`/`platform`/`architecture`/`gateway_build`/`production_dependencies`/`desktop_shell`/`dotnet_desktop_runtime`/`webview2_runtime`/`workbuddy_application`/`workbuddy_data`/`code_signing`，`networkProbes: 0`）。

**隔离安装根实测**（源 = `git archive HEAD`，635 文件，**无 dist、无 node_modules**；全部在 `A\drill\install-root` 下，未碰真实安装根）：

| 场景 | 命令 | 结果 |
|---|---|---|
| 新装（首跑自举） | `bootstrap.mjs --install-root . --apply --timeout-ms 900000` | `npm ci` ok 6736ms → `npm run build` ok 6190ms → planner `ci --omit=dev` ok 6308ms，exit 0（`bootstrap-selfhost.json`） |
| 重复安装 | 同上（dist 已存在） | `ci` ok 6120ms + `build` ok 6934ms，exit 0；再跑一次只 `ci --omit=dev` 5908ms，exit 0（`bootstrap-reinstall.json`） |
| 桌面成品 | `dotnet build desktop\WorkBuddy.Workbench.csproj -c Release` | exit 0、0 警告、产物 `desktop\bin\Release\net10.0-windows\WorkBuddy.Workbench.exe` 存在（`desktop-build.log`） |
| 候选包体检 | `candidate-installation.mjs check`（只读候选 zip，sha256 `c9f724d4…338ff`） | `ok:true`、696 文件、`problems:[]`、version 0.7.1 |
| 新装演练 | `drill --drill-root A\drill\first-install --apply` | exit 0；steps `plan/install/install_repeat/uninstall` 全 ok；6 项 negatives 全 ok（含 `truncated_archive`、`digest_mismatch_reported`、`registered_service_blocks_install`、`unclosed_task_blocks_install`、`unconfirmed_stop_blocks_install`） |
| 旧库升级 | `upgrade-drill --apply` | exit 0；17 步全 ok，含 `install_on_installed_root_is_refused`、`gateway_file_is_newer_bytes`、`local_skill_change_is_refused`、`rollback_applies`、`skill_restored_to_previous`、`env_preserved_after_uninstall`、`history_preserved_after_uninstall` |

**更高 schema 拒绝**：既有 `candidate-installation` 与 `deployment-safety` 的拒绝路径在本轮演练里被 negatives 覆盖（digest 不符、截断档、活动任务、未证实停止、已注册服务）；本轮**没有**新增 schema 迁移，因此「更高 schema 拒绝时不先建表、不写元数据」仍由既有 `assertTaskRecordsStopped()` + `readServiceRegistration()` 的 version 校验保证，本线未改其逻辑 —— 属于「已存在且未回归」而非本轮新证据。
**备份与卸载保留用户数据**：`upgrade-drill` 的 `rollback_applies` / `rolled_back_gateway_bytes` / `env_preserved_after_uninstall` / `history_preserved_after_uninstall` / `skill_removed_after_uninstall` 这 5 步 exit 0 即是该结论的合成层证据。

**复验**：
```
cd gateway
npx tsx --test test/installation-bootstrap.test.ts → tests 7 / pass 7 / fail 0
npx tsx --test test/candidate-installation.test.ts test/installation-dependencies.test.ts test/installation-rollback.test.ts test/installation-bootstrap.test.ts
  → tests 32 / pass 32 / fail 0
npx tsc --noEmit -p tsconfig.json → exit 0
```
**未覆盖**：真实安装根（`%LOCALAPPDATA%`/正式安装目录）未安装、未升级，也没跑过真实服务的注册/卸载；所有「安装」结论都是隔离根 + 演练目录层级。

## 6. A05 旧任务分层说明 + 两个偶发

### 6.1 两个偶发：定向诊断与修复

**偶发一：`command-cleanup` 计数（I 的 E2，WMI `HRESULT 0x80004005`）**
- 现象：`test/command-cleanup.test.ts` 的 nested Job 用例在 4 路并发子代理下失败，`reconcileOwnedCommands` 抛 WMI 错误，导致同一目录「有时 recovered 1、有时 0」。
- 定位：`gateway/src/native-process.ts:21 windowsProcessTable` 单次 `execFileSync(powershell Get-CimInstance)`，WMI 在 contention 下返回 0x80004005，异常被裸抛；`command-cleanup.ts:9` 的默认 `inspect` 正是它。
- 修复（`ecedc5c`）：`windowsProcessTable(run,{attempts=3,backoffMs=200})` 有界重试吸收瞬态；仍失败则抛 `ProcessTableUnavailableError`，消息写明「nothing was assumed about any process」——**绝不返回空表**（空表会被读成「没有任何进程」，那才是假绿）。
- 复验：单跑 3 次 → 每次都 `tests 4 / pass 4 / fail 0`；4 路并发（`Start-Job` × 4）→ 4 份日志全部 `tests 4 / pass 4 / fail 0`，日志中不再出现 `0x80004005`（`cleanup-contention-1..4.log`）。
- 判定：**根因已定位并修复**（瞬态 WMI 被有限次重试吸收；持久失败现在有名字、不会被误读成「没有进程」）。剩余不确定性：真实 4 子代理极端负载下是否会连续 3 次都失败，未做压测。

**偶发二：`run-worker` detached EPERM rename**
- 现象：高负载时 worker 侧写 `state.json` 偶发 EPERM（Windows 上目标被读者/杀毒/索引占用），表现为 worker 收尾失败而不是结果丢失。
- 定位：`gateway/src/run-journal.ts` 的 `writePrivateJson` 直接 `fs.renameSync(temp, file)`，EPERM/EBUSY 一律裸抛。
- 修复（`ecedc5c`）：新增 `publishFileSync(temp, file, {rename?, attempts=6, backoffMs=20})`，只对 `EPERM`/`EACCES`/`EBUSY` 重试，其它错误一次即抛；末次失败删掉临时文件并抛「destination stayed busy (CODE) after N attempts，旧内容完好」，`writePrivateJson` 改用它。
- 复验：`test/run-journal.test.ts` 新增三条（占用 3 次后成功 → 内容为新值；一直忙 → 旧内容保留 + 临时文件被删 + 报错点明 EBUSY；别的错误不重试且只试 1 次），与既有用例合计 `tests 21 / pass 21 / fail 0`（含 `native-process` 2 条重试用例）。
- 判定：**根因已定位并按 Windows 语义修复**；真实高负载下的重现概率未测（本机没有可稳定复现的杀毒/读者争用条件）。

### 6.2 旧任务分层说明（只读核对，给 I）

数据来源：`classify-old-tasks.mjs`（`DatabaseSync({readOnly:true})`，未写库、未关任务、未重派）+ `data/runs/*/state.json`。证据：`old-task-classification.json`。

三库都有 `task_closures` 表但**没有行**——关闭证据以 `task_events.type='task_closed'` 表达，不能只看 `tasks.state`。

**A. 已关闭，可自然清理（有 `task_closed` + attempt 原生停止证据）**

| 库 | task | state | attempt | 停止证据 |
|---|---|---|---|---|
| `workbuddy-install\gateway-v0.7.1-rc1\data\tasks.sqlite` | `d1-dsh-5f82573e-b87a-4ff1-acd9-ec8d541243f5` | accepted | `run-4fc382d9…` | `nativeStoppedAt 2026-11-06T05:37:16.483Z` / `dsh_terminal_event` |
| 同上 | `d1-workbuddy-2fec4908-eb45-45eb-8852-8e8411b0cacf` | accepted | `run-bc7288ad…` | `06:14:07.761Z` / `native_idle` |
| 同上 | `d1-workbuddy-3f05ab79-28de-4b1d-9c75-4f7692d04ad3` | cancelled | `run-2a6c487c…` | `06:28:11.235Z` / `native_idle`（另有 `cancel_requested`） |
| 同上 | `d1-workbuddy-90e3d881-dfbb-4873-8a07-771ff2033490` | cancelled | `run-eec70101…` | `06:31:11.782Z` / `native_idle`（无 report_json，取消路径） |
| 同上 | `d1-workbuddy-096d49a6-1b20-4e8e-a7c5-b9beadf74aac` | accepted | `run-ccba521a…` | `06:34:09.443Z` / `native_idle` |
| `outputs\t7b-live-acceptance-20261031\state\tasks.sqlite` | `desktop-1661b0ae-3206-4904-a434-21de5e1855d3` | accepted | `run-d039ae42…` | `2026-10-31T04:35:13.478Z` / `native_idle` |
| 同上 | `t7c-mcp-live-range-20261031-01` | accepted | `run-d38c49a8…` | `06:44:59.440Z` / `native_idle`（同时是该库 `workflow_capacity` 的占用者，已闭合 → `claim()` 自清） |

**B. `needs_review` 且有停止证据（要用户裁决，不能自动关）**

| 库 | task | attempt | 证据 |
|---|---|---|---|
| `workbuddy-install\gateway-v0.7.1-rc2\data\tasks.sqlite` | `rc2-live-20261106b` | `run-de1afbd3-571a-4533-885e-3819146f0882` | `nativeStoppedAt 2026-11-06T08:28:13.793Z` / `native_idle`，`report_received`+`result` 都在，`report_json` 存在，**无 `task_closed`**；它占用该库 slot 1 |

**C. 仍未知（不关闭、不重派、不释放）**

| 库 | task | 事实 |
|---|---|---|
| `workbuddy-install\gateway-v0.7.1-rc1\data\tasks.sqlite` | `d1-workbuddy-2cc8e262-54f5-43a0-8511-b3febf0d4101` | `state=blocked`、`attempt_id=null`；事件只有 `task_received` + `task_state_changed`，**没有** `attempt_queued`/`native_claimed`/`native_stop_confirmed`；`blocking_reason="Contract preparation failed; inspect the original task before any recovery."`；它是该库 `workflow_capacity` 的占用者（`operation_id=card-r6-foreign-session-1793948211334`） |

对 C 的说明：它从未被派发，所以不存在可取得的原生停止证据，也无法证明「已停止」；释放这个 slot 会改变共享容量的语义，必须由用户明确决定，本线只提供事实。三库中都没有 `state.json` 读取失败（`readError` 全为 null），因此这三层分类不依赖任何「读不到」的推断。

## 7. 未覆盖项与原因

1. **窗口实测未做**（A02）：本机无可用的普通桌面会话，`CreateAsync`/`EnsureCoreWebView2Async` 的真实行为、`timeout:webview_environment` 是否真会触发、导航成功后的 `ready=true` 全属未验证；A02 的结论只到「阶段/预算/终止语义在源码与替身上成立」。
2. **实机安装未做**（A04）：只在隔离根与演练目录里跑过；真实 `%LOCALAPPDATA%` 安装、真实服务注册/卸载、跨版本升级未执行。
3. **UI 四尺寸/200%/读屏**：依赖 `ready=true`，仍未开始。
4. **两个偶发的极负载重现**：修复按 Windows 语义与瞬态重试完成，但没有稳定的高负载复现环境，因此「重现概率降为 0」未证明，只证明「单跑 3/3、4 路并发 4/4 不再出现」。
5. **`native-desktop-trigger.ts:314` 的 `catch { table = [] }`**：核对后保留 —— 它后面有 `executablePathOf(pid)` 的 `Get-Process` 回退，缺行不等于「别人的端口」，不是假绿。
6. **`desktop-dispatch-e2e` 的 SQLite 并发竞争**（I 的 E4）：属于共享测试夹具的并发问题，未在本线修（不在归属内），单独跑 1/1 pass。

## 8. 用户必须做的最小动作

1. 在 PowerShell 里固定一次安装选择，之后所有命令都在同一选择下跑：
   `$env:WORKBUDDY_CONFIG_DIR='C:\Users\LENOVO\.workbuddy-ai'`（本机实测可用的那个），需要时再设 `$env:WORKBUDDY_CLI_ELECTRON='<WorkBuddyAI.exe 绝对路径>'`。诊断本身不会写任何配置文件。
2. 跑一次 `node gateway\scripts\readiness.mjs`，把输出里的 `Next action` 当作唯一入口：它现在会指向 `selection`（因为本机有两个数据目录）。
3. 要验证 A02 的窗口层结论，必须在**普通桌面会话**（不是本沙箱令牌）里启动一次壳，并在挂住时读快照：`startup.awaitingStage` / `awaitingMs` / `awaitingBoundedMs` 会直接指出卡在 `webview_environment` 还是 `controller`。
4. 对 6.2 的 B 类（`rc2-live-20261106b`）与 C 类（`d1-workbuddy-2cc8e262…`）做人为裁决：B 可以 `needs_review` 收尾，C 需要先确认它到底有没有在原生侧跑过，再决定是否释放 slot。两者都不要用「换库/换身份」绕过。
