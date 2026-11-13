# Windows 社区版安装

目标：使用自己的 WorkBuddy、配置与业务目录完成安装，无需修改源码。当前提供可迁移安装程序；第二台物理机器的真实验收仍待完成，不能把本机隔离测试当作跨机器通过。

## 1. 准备

安装 Git、Node.js >=22.13.0、npm 和 WorkBuddy。先自行打开并登录 WorkBuddy，让应用建立本机数据目录。登录、权限及账号由使用者在原生界面处理。

```powershell
git clone https://github.com/shenmiqinvzi/workbuddy-executor-community.git
cd workbuddy-executor-community/gateway
node verify-snapshot.mjs
npm ci
npm run build
```

快照核验应在修改或重新构建之前执行。Node 和 WorkBuddy 可以安装在不同目录，项目路径允许中文和空格。当前安装向导以 Windows 为支持范围，其他平台沿用上游代码不等于经过本版验证。

桌面工作台窗口是可选的独立外壳，同一份界面也可在浏览器里查看。源码 clone 不含已编译的桌面程序（`desktop/app` 不入库），需要该窗口时额外准备 .NET SDK 10 与 WebView2 Runtime：

```powershell
npm run desktop:build
npm run desktop
```

运行该窗口还要求本机已安装 .NET Desktop Runtime 10。跳过这一步不影响技能与 MCP 派工流程，浏览器界面用 `npm run workbench` 启动后在 `http://127.0.0.1:18493/workbench/` 查看同一份只读记录。构建细节、预览包内容与签名状态见 [桌面工作台说明](WORKBENCH.md)。

如果使用完整发布 ZIP，在解压后的网关目录先运行 `node scripts/verify-release.mjs` 核对发布清单，再运行 `node scripts/bootstrap.mjs --install-root . --apply` 安装生产依赖。源码 clone 使用上述 verify-snapshot/build 流程。单独技能 ZIP 需要配套网关和 MCP 连接。

## 2. 先预览，再安装

```powershell
node scripts/setup.mjs plan
node scripts/setup.mjs install --apply
node scripts/doctor.mjs
```

plan 不写入文件。安装会探测常见位置和正在运行的 WorkBuddy 可执行文件；数据目录只在发现原生 workbuddy.db 时作为候选。有多个候选时要求明确选择。自定义安装路径或进程信息不可读时：

```powershell
node scripts/setup.mjs plan --workbuddy-app "D:/Apps/WorkBuddy/WorkBuddyAI.exe" --workbuddy-config "D:/My WorkBuddy Data"
node scripts/setup.mjs install --apply --workbuddy-app "D:/Apps/WorkBuddy/WorkBuddyAI.exe" --workbuddy-config "D:/My WorkBuddy Data"
```

上述路径是占位示例，替换为自己的实际位置。也可通过 WORKBUDDY_CLI_ELECTRON、WORKBUDDY_CONFIG_DIR 指定。--codex-home 或 CODEX_HOME 可选择独立的技能安装目录。

同一个数据目录里，`data/persistent-service.json` 记录的原生目录必须与进程自身读取的 WORKBUDDY_CONFIG_DIR 一致：准备阶段按注册绑定原生会话，派工阶段读进程配置，两者不同就会出现"准备用 A、派工读 B"。这种情况下返工/派工在创建 attempt 之前就被拒绝，不会留下新的 blocked attempt 或需要恢复操作的 effect_started：

- `BRIDGE_CONFIG_MISMATCH`：注册的原生目录与 WORKBUDDY_CONFIG_DIR 不同，错误里给出两个绝对路径；把 WORKBUDDY_CONFIG_DIR 改成注册里的目录，或为本数据目录重写注册。
- `BRIDGE_SESSION_ABSENT`：该目录的原生历史里没有这个会话；重新打开该会话，或为这个数据目录准备新工作区。
- `BRIDGE_HISTORY_UNREADABLE`：该目录下没有可读的 workbuddy.db（或在运行中无法读取）；修好桌面配置或目录权限后重试同一任务。

修好之后用新的 operationId 重试即可；被拒绝的那次操作不推进 attempt，也不需要按恢复流程关闭。

安装写入本机 .env（仅原来不存在时）、技能文件、data/workbuddy-mcp.toml 和 data/deployment-installation.json。旧技能先备份；同样内容重复安装不改变文件。既有 .env 不覆盖；配置冲突或缺少免费政策时明确报错，由使用者核对修改。整个安装不发送任务、不启动或重启 WorkBuddy、不安装常驻服务，也不改变执行策略。

### 2.1 先核对发布包，再决定是否安装

完整发布 ZIP 可以先用只读工具核对，再决定是否解压到目标目录：

```powershell
node scripts/candidate-installation.mjs check --package "D:/pkg/codex-workbuddy-gateway-v0.7.1.zip" --expect-sha256 "<公布的 SHA256>"
node scripts/candidate-installation.mjs preview --package "D:/pkg/codex-workbuddy-gateway-v0.7.1.zip" --install-root "D:/Apps/workbuddy-gateway" --codex-home "D:/codex-home"
```

`check` 逐条核对包内 `RELEASE_MANIFEST.json` 的记录（路径边界、字节数、哈希），并拒绝清单外的多余文件；`preview` 只比较目标目录，列出将新建、变更、保持不变和被阻挡的文件，以及依赖条件、备份与回退步骤。两者都不写 .env、技能、任务库或安装目录。`preview` 不接受缺失的目标路径：没有显式 `--install-root` 与 `--codex-home` 就报错，不会回落到真实安装目录或用户目录。

若只想在一台机器上完整走一遍安装、重复安装、升级与卸载，而不触碰真实安装：

```powershell
node scripts/candidate-installation.mjs drill --package "D:/pkg/codex-workbuddy-gateway-v0.7.1.zip" --drill-root "D:/drills/candidate-20261105"
```

`drill` 只写入你给出的演练目录（安装目录、假 `CODEX_HOME`、合成桌面配置都建在该目录下），先输出计划；加 `--apply` 才执行 install、重复 install 与 uninstall。这是隔离演练，不是真实安装，也不代表跨机器验收。

### 2.2 依赖自检与版本核对

发布 ZIP 只含网关程序和技能文件，不含 Node.js、.NET Desktop Runtime、WebView2 Runtime，也不含 WorkBuddy 本身。解压后可以先只读确认这台机器是否具备运行条件：

```powershell
node scripts/candidate-installation.mjs dependencies --install-root "D:/Apps/workbuddy-gateway" --package "D:/pkg/codex-workbuddy-gateway-v0.7.1.zip" --workbuddy-app "D:/Apps/WorkBuddy/WorkBuddyAI.exe" --workbuddy-config "D:/My WorkBuddy Data"
```

报告逐项给出 observed 与 expected：Node 版本、Windows 平台、x64 架构、网关构建、生产依赖（按 `package-lock.json` 声明版本比对，比较实际安装的包）、桌面壳、.NET Desktop Runtime、WebView2 Runtime、WorkBuddy 可执行文件与数据目录、代码签名状态。诊断只读，不联网、不安装、不写 .env、不启动 WorkBuddy；存在阻塞项时退出码为 1。它不会替使用者猜测 WorkBuddy 位置：未给出 `--workbuddy-app` / `--workbuddy-config` 时如实报告 missing，而不是把探测到的候选当成已确认。

`--platform` 与 `--arch` 只用于在别的机器上复现同一判断，不会让安装程序放宽接受条件。

已安装目录是否与某个发布包同版本，可用 `version-check` 只读比对（逐文件字节数与哈希）：

```powershell
node scripts/candidate-installation.mjs version-check --package "D:/pkg/codex-workbuddy-gateway-v0.7.1.zip" --install-root "D:/Apps/workbuddy-gateway"
```

`matches=true` 只说明磁盘上的托管文件与该包一致，不代表任务已执行、原生登录就绪或部署验收完成。

### 2.3 初始化全新任务库

若需要在首次派工前打开独立桌面工作台，请先核对宿主提示中的数据库绝对路径。已有任务库应直接使用其原路径。只有确认目标是**有意选择的新库**时，才在同一个网关目录运行：

```powershell
node scripts/init-state.mjs
```

此命令使用与桌面宿主相同的配置。若通过 `WORKBUDDY_DB_FILE` 指定了路径，运行两者时使用同一个值。命令在目标已存在时退出，成功后可重开工作台。建立任务库只表示可保存任务记录。原生连接和派工就绪分别核验。

## 3. 连接 Codex

打开生成的 data/workbuddy-mcp.toml，核对命令和路径。将其中 workbuddy 配置合并进自己的 Codex config.toml；如已有同名项，只替换明确指向这次安装的条目，保留其他设置。安装程序不会替你修改用户配置。

配置格式依据 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)，使用 command、args、cwd 和 env。片段内的绝对路径由实际安装位置生成，不要求 F 盘。配置文件和片段含本机路径，不要提交到仓库。

配置后按客户端的 MCP 管理入口重新连接 workbuddy；已有旧进程不会因文件更新而升级。可以先调用 workbuddy_health 观察网关连接；这不证明原生登录、模型额度或真实执行成功。

## 4. 首次真实连接

先确认没有其他 WorkBuddy 任务运行。首次建立原生连接可能需要正常重启应用。通过 Codex 按技能流程查询可用模型及已知费用，由用户选择并确认，再用 `workbuddy_send_task` 提交专用样本目录、稳定任务身份和选定模型。编辑样本要声明结构化文件范围。模型准备在派工准入后执行。付费和费用未知可在用户了解后选择，只有主动免费限定才要求零费率。升级保留已有显式限制。

```powershell
node scripts/doctor.mjs --live
```

本地诊断只查环境与原生 sessions 表结构；--live 进一步观察已存在的原生桥接和模型目录，不安装桥接、不重配模型、不重启应用。初装时 bridge_missing 是可解释状态，须先完成上述首次连接；不能靠重复运行 doctor 自动修复。login/quota 保持 unknown，诊断通过不等于任务已执行。

原生回合在提交有效完成报告前返回 HTTP 429 时，任务保持 blocked，`execution.nativeRateLimit` 标记限流，并在证据可确定时注明原生消息提交或原生历史阶段。只有错误文本明确提供数字形式的 `Retry-After` 时才记录 `retryAfterSeconds`；未提供时不推算恢复时间。该值是原生响应的等待提示，不保证额度恢复，也不会触发自动重发或付费模型切换。先核对原任务的停止证据和原生界面状态，服务恢复后沿原 taskId/会话继续。

如果已认证、按时提交的完成报告早于原生错误，网关保留 `needs_review`，在 `execution.postReportFailure` 单独记录后到的错误；原生停止与独立验收仍是必要条件。错误早于报告、报告缺失或被改动、取消或超时的任务继续保持 blocked。

原生报错不代表本轮已经结束。新版将相关错误持久保存；即使重连后错误不再出现在原生接口中，也不会仅凭一次空闲判定 `remoteStopped=true`。监督器核对原 task/attempt/session、工作目录和最近唤醒标记，只向这一轮发送一次原生 `session:cancel` 收尾请求，不关闭整个应用。必须收到该请求回执，随后至少两次观察到空闲（间隔至少一秒、后端活动时间未变化），并核对没有未结束工具、团队或已知后台任务，以及本轮命令清理证据，才允许返工或验收。收尾保留已有结果，不自动重发、不将失败改成成功。

请求超时、回执丢失、归属变化或仍有活动时保持 `stop_unconfirmed`，重连不重发取消请求，也不放行下一任务。`execution.stopControl` 和 `execution.nativeStopCheck` 提供请求与连续观察记录；单次空闲恢复和报告恢复工具不能绕过新版失败轮次的停止门槛。旧版本保存的历史停止记录不会被本次源码修改自动重新核验。

部分原生版本会在工具结束后补发参数完整事件：同一工具先出现 `failed` 等终态，随后又出现带 `codebuddy.ai/toolArgumentsComplete=true` 的 `tool_call/pending`。历史解析仅在工具 ID、工具名、会话请求、模型请求及唤醒请求身份全部匹配时保留已有终态；缺少或不同身份、普通待执行事件、后续执行中更新及其他工具仍会阻止停止确认。原生权限、执行中标志、团队和后台任务检查继续生效。

该解析版本使用 `historyRevision=2`。重启后的持久历史可能省略唤醒字段；仅双方都明确标记 `mode=history`、各有数值 offset，且工具 ID、工具名、会话请求、模型请求及非空原生 requestId 全部匹配时，才识别这种参数补全事件。缺少历史标记、单方仍有唤醒字段或请求身份不匹配时继续等待，不推断停止。

旧桥接的在途活动仍被保留并检查，因此旧桥接已因残留历史显示忙时，热加载新文件不会自动解除阻塞；不要修改任务库或强行关闭应用来制造停止证明。修复须另行安排部署与原生界面确认，当前任务及其原报告、超时和取消结果保持原样。

旧版本因后到错误覆盖了报告时，可用 `workbuddy_reconcile_report`，提供原 taskId、当前 attemptId 与核查原因。它核对现有报告摘要、原生最近唤醒身份、当前原生空闲和命令清理证据，仅恢复到待审查，不重发任务、不延长预算、不自动验收；原报告和失败事件都保留。当前聊天仍是旧内存版本时，可通过本机 `scripts/workbuddy-call.mjs` 启动器调用该工具。

当前 MCP 的相关可选返回字段如下；未观察到的证据省略，不推断为成功：

共享服务兼容层在 `get_task`、`wait` 返回 `statusView`，在 `list_tasks` 返回对应的 `statusViews`。每项包含 `taskId`、`attemptId`、`sessionId`、`businessState`、`displayState`、`remoteStopped`、`allowedActions` 与 `lastObservedAt`。它是现有任务的保守投影，尚不是设计中的完整 vNext TaskView；操作执行时仍由 coordinator 重新核验。原生失败后的停止未确认也显示为 `waiting_stop`，不要求先有人工取消请求；不会因此开放返工或验收。报告恢复同样经过共享服务入口。

新版 `workbuddy_list_tasks` 可能将已有停止证据的桌面队列任务补记到任务库。`reconciled` 只列出本次状态已推进的任务。需要只读快照时，请使用 `node scripts/workbuddy-inspect.mjs @任务参数文件.json`。

| 字段 | 含义 |
|---|---|
| `execution.nativeRateLimit` | `kind=rate_limited`、`statusCode=429`、`observedAt`；可附 `phase`（`session:sendMessage` 或 `native_history`）和明确提供的 `retryAfterSeconds` |
| `execution.postReportFailure` | 晚于有效完成报告的 `error`、`observedAt`、原 `reportReceivedAt`，可附 `phase`；保留报告但不跳过停止和验收 |
| `execution.stopControl` | 原有请求状态加 `issuedAt`、`acknowledgedAt` 等时间；仅 `issuedAt` 不证明请求成功或任务停止 |
| `execution.nativeStopCheck` | 失败轮次的连续空闲检查：`since`、`checkedAt`、`observations`，可附后端 `activityAt` |
| `execution.nativeHealth.diagnostics` | 原生观察仍判忙时可记录阻塞信号、未结束工具及所缺证据。观察时间和身份仍须与当前轮次核对，诊断本身不确认停止。 |

`workbuddy_reconcile_report` 输入为 `{taskId, attemptId, reason, detail?}`：`attemptId` 必须是当前 `run-<UUID>`，`reason` 为非空核查说明（最长2000字符），`detail` 为 `brief` 或 `full`。成功只表示已有报告恢复到 `needs_review`，`taskCompleted=false`；仍须核对返回的 `task`、`execution` 和当前成果后另行验收。

本次本机真实样本与回归测试的脱敏边界记录见 [原生停止验证摘要](native-stop-verification.json)。

历史参数事件兼容修复的部署与原任务第3轮真实验收记录见 [本机历史解析修复复验](native-history-deployment-verification.json)；它记录实际运行哈希、预期超时124、清理和停止证据，并保留前两轮失败，不能代替异机验收。

## 5. 升级、回退和卸载

先让所有任务完成验收或明确结束，并取得停止证明。仍有 working、needs_review 或停止不明记录时，安装程序拒绝变更。

若已安装常驻服务，先在原安装目录执行：

```powershell
node dist/service-cli.js uninstall --config "./data/persistent-service.json"
```

该流程先核对任务停止，再核对 Windows 服务 PID 的可执行文件和启动参数；归属不明则拒绝停止。它不停止 WorkBuddy 原生应用，不删除业务文件或任务历史。若使用自定义服务配置，传入对应真实路径。修改源码前退出旧 MCP 连接并备份原目录；保留自己的 .env、data 和旧版本源码/包。

```powershell
npm ci
npm run build
node scripts/setup.mjs upgrade --apply
node scripts/doctor.mjs
```

重新检查生成片段并连接 MCP。升级不会重放任务。

升级前可以先在隔离目录把整条链路走一遍，不触碰真实安装：

```powershell
node scripts/candidate-installation.mjs upgrade-drill --package "D:/pkg/codex-workbuddy-gateway-v0.7.1.zip" --drill-root "D:/drills/upgrade-20261105" --apply
```

`upgrade-drill` 在演练目录里合成上一版与这一版的发行包，依次执行 install → 重复 install（应保持不变）→ 再用 install 覆盖（应被拒绝并提示用 upgrade）→ upgrade --apply → 改动托管文件（应报本地改动并拒绝）→ 还原 → 回退规划与执行 → 卸载，并复验缺构建、常驻服务、活动任务、停止不明、截断包与摘要不符等负向路径。它是合成夹具上的演练，不是真实升级，也不代表跨机器验收。

回退需要明确指出目标版本，先只读生成差异计划：

```powershell
node scripts/candidate-installation.mjs rollback-plan --package "D:/pkg/codex-workbuddy-gateway-v0.7.1.zip" --to "D:/pkg/codex-workbuddy-gateway-v0.6.0.zip" --install-root "D:/Apps/workbuddy-gateway" --codex-home "D:/codex-home" --report "D:/reports/rollback-plan.json"
```

计划列出将被替换、新建、删除、保留与阻挡的文件（含当前和目标哈希）、运行目标（哪些进程需要重启、正在运行的进程不会自动换版本）、配置影响、执行步骤和失败补救顺序。存在本地改动、路径异常或目标包未通过核对时 `safeToApply=false` 且退出码为 1，计划不写盘。

若现有任务库结构比回退目标更新，计划会单独给出 schema 判断（`schema.assessment.decision`）：`compatible` 才可直接回退；`incompatible` 或 `unknown` 时保持原状，先备份整个 data 目录，再按[恢复说明](../RESTORE.md)核对。把 `--task-db` 指向 WorkBuddy 原生库（只有 sessions 表）时同样是 `unknown`，并提示该库不像网关任务库。不要用删除任务库或把旧库覆盖到新库的方式“恢复”，也不声称旧程序能读新结构。

```powershell
node scripts/setup.mjs uninstall
node scripts/setup.mjs uninstall --apply
```

前一条只预览。卸载删除未被本地修改的托管技能和生成片段，恢复首次安装前的技能备份，保留 .env、网关目录、任务数据与版本备份。用户改过的技能或片段会被保留并报错，不直接覆盖。Codex 配置条目需自行核对移除；不能盲目移除指向其他安装的 workbuddy 项。

若进程崩溃留下 data/setup-in-progress.json，先检查本轮结果与备份，确认没有另一个安装进程后再处理该记录。锁不会按时间自行失效，也不能以反复安装覆盖不明结果。

完成安装后按 [独立部署验收](DEPLOYMENT_ACCEPTANCE.md)检查。报告默认保留本机，公开前按贡献指南脱敏。
