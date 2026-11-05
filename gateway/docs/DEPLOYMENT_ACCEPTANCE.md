# 第二台 Windows 实机部署验收

验收目标：在第二台 Windows 物理电脑上，由维护者本人或测试者仅按 [安装说明](INSTALL_WINDOWS.md)从全新 clone 完成安装与真实任务闭环，使用该机器自己的目录、账号和数据。维护者电脑上的多个临时目录、mock、单元测试和发布包解压验证分别记录，不作为第二台物理机器成功。若由维护者本人操作，报告注明同一操作者，只证明跨机器复现。

## 环境与安装

1. 从社区仓库全新 clone，记录提交和 Node/WorkBuddy 版本；不复制维护者 .env、数据库、会话、登录信息或全局配置。
2. 选择不同的安装位置，建议包含空格或中文。按说明执行 plan、install、重复 install、doctor；确认重复安装无额外修改。
3. 审核并合并本机 MCP 片段，连接 workbuddy。每次需要维护者口头补充的步骤都记为文档或程序缺陷，不能省略为“已经装好”。
4. 登录、原生权限和首次连接初始化由本机使用者处理；不降低系统策略、不自动批准权限、不换收费模型。

## 真实行为

在新的专用演练目录，使用 Codex 和已安装技能进行下列任务。真实 UUID、路径、日志和截图留在本机。

| 场景 | 操作 | 必需观察 |
|---|---|---|
| normal | 提交一个范围明确的小型代码修复及测试 | WorkBuddy 实际领取和修改；独立重跑测试、核对范围与停止，再 accept |
| rework | 事先声明两阶段交付：首轮完成第一部分，停止后以同 taskId/sessionId 补完原约定的第二部分 | continue 保留原身份与失败/轮次记录；不是增加新需求，最终独立验收 |
| cancel | 专用目录中提交一个持续等待的无破坏性演练任务，领取后正式 cancel | 不把取消请求当停止，等待原生停止证据；取消后不能继续 |
| reconnect | 在另一个正常任务进行时断开并重新连接 MCP，查询原 taskId | 原身份、轮次和绝对期限保持；只查询和监督，不重复提交 |
| upgrade/uninstall | 演练完成且停止后按文档更新与卸载 | 活动任务会阻止变更；配置/历史保留，原有技能可恢复 |

计划内两阶段演练用于检查 continuation 链路，不能算作真实质量缺陷返工。发现原生输入等待时记录在原生界面的处理情况，不以取消作为暂停。失败保留原结果，不能替换样本或补造 worker 回报。

## 程序生成本地报告

在 gateway 目录执行：

```powershell
node scripts/deployment-check.mjs --machine-label second-machine --output "./data/deployment-check-initial.json"
```

先得到本地环境检查和 pending 的场景。完成演练后，用自己的真实任务 ID 替换占位值并选用新的报告文件名：

```powershell
node scripts/deployment-check.mjs --machine-label second-machine --normal-task "NORMAL_TASK_ID" --rework-task "REWORK_TASK_ID" --cancel-task "CANCEL_TASK_ID" --output "./data/deployment-check-final.json"
```

工具只读本地状态，不派工、不恢复、不取消任务；不输出真实任务 ID、账号、路径、对话或报告正文。它核对已保存的原生停止、任务/轮次/会话身份、认证回报与独立验收记录。保存证据不是刚刚观察的原生状态。reconnect 永远保留 pending，由实机操作者另写事实与结果；工具不能自动证明物理机器身份。

命令退出码 0 表示本地环境检查通过，不表示整份部署验收完成。检查报告中每个场景以及手工 reconnect/升级/卸载记录，才能给出最终结论。

## 异机可审查部署步骤模板

下列步骤供 10 线在第二台物理机上逐条记录。每步写真实命令、退出码、起止时间和产物路径；没有记录的一步视为未执行，不用“应该可以”代替。

### 1. 部署步骤

```powershell
# 1.1 记录基线
git -C <仓库> rev-parse HEAD
node --version; npm --version
# 1.2 核对发布包（只读，先看包再解压）
node scripts/candidate-installation.mjs check --package "<包路径>" --expect-sha256 "<公布 SHA256>" --report "<报告 1>"
# 1.3 依赖缺口（只读，不安装、不联网）
node scripts/candidate-installation.mjs dependencies --install-root "<目标安装目录>" --package "<包路径>" --workbuddy-app "<WorkBuddy 可执行文件>" --workbuddy-config "<数据目录>" --report "<报告 2>"
# 1.4 预览写入面（只读）
node scripts/candidate-installation.mjs preview --package "<包路径>" --install-root "<目标安装目录>" --codex-home "<CODEX_HOME>" --report "<报告 3>"
# 1.5 解压、安装、复查
Expand-Archive "<包路径>" "<解压目录>"
node scripts/setup.mjs plan
node scripts/setup.mjs install --apply
node scripts/doctor.mjs
```

每一步记录：命令原文（占位符已替换成该机真实路径）、退出码、关键输出摘要、是否触碰过真实 WorkBuddy。`preview` 退出码 1 表示有阻塞项，此时不进入安装；`dependencies` 退出码 1 同理。

### 2. 版本核对

```powershell
node scripts/candidate-installation.mjs version-check --package "<包路径>" --install-root "<安装目录>" --report "<报告 4>"
```

`identities[].exact=true` 表示磁盘上的托管文件与该包逐文件一致。若为 `differing`/`missing`，先看差异文件：是本地改动、旧版本残留还是解压不完整，再决定覆盖或回退。比对只覆盖包内文件，不覆盖 `.env`、`data/`、`node_modules/`，也不证明网关进程加载的是新构建；进程侧仍以 health 的 `runtime-version.release` 与 `codeHash` 为准。

### 3. 备份与回退

```powershell
# 3.1 变更前整目录备份（含 .env 与 data，保留时间戳）
Copy-Item "<安装目录>" "<备份目录>\gateway-<时间戳>" -Recurse
# 3.2 只读差异计划：当前版本 → 目标版本
node scripts/candidate-installation.mjs rollback-plan --package "<当前版本包>" --to "<目标版本包>" --install-root "<安装目录>" --codex-home "<CODEX_HOME>" --task-db "<安装目录>\data\workbuddy.db" --report "<报告 5>"
```

回退前必须有停止证据；有活动任务、停止不明或常驻服务时安装与回退都不放行，先按安装说明第5节处理。计划的 `schema.decision` 为 `incompatible`/`unknown` 时不做文件替换，保留现有版本与数据，按 [恢复说明](../RESTORE.md) 走相容路线。回退后重跑 `version-check` 与 `doctor`，并把失败补救记录写进报告。

### 4. 异机依赖检查清单

| 项目 | 期望 | 观测方式 |
|---|---|---|
| Windows 版本与架构 | x64 | `dependencies` 报告 `platform`/`architecture` |
| Node.js | >= 22.13.0 | 报告 `node_version` 的 observed |
| 网关构建 | dist 内四个入口齐全 | 报告 `gateway_build` |
| 生产依赖 | 与 `package-lock.json` 声明版本一致 | 报告 `production_dependencies` |
| 桌面壳（可选） | 需要窗口时 .NET Desktop Runtime 10 + WebView2 Runtime | 报告 `desktop_shell`/`dotnet_desktop_runtime`/`webview2_runtime` |
| WorkBuddy | 已安装并完成一次登录 | 报告 `workbuddy_application`/`workbuddy_data` |
| 代码签名 | 如实记录为未签名 | 报告 `code_signing`；SmartScreen 提示按原样记录，不要求关闭系统保护 |

缺失项不要用“装个依赖再试”含糊记录：写明缺什么、谁安装、装完重跑哪条命令、报告的 observed 变成什么。

## 提交反馈

用匿名机器标签（如 win-02）记录实际操作系统、应用版本、提交、操作者类型、各步骤结果及卡点。模板字段不能用“预计通过”替代实测。公开前检查报告、截图和 Git 元数据；完整原始材料留在私有位置，报告中手写补充也须去除账号和真实业务信息。

当前状态：程序和流程已提供，第二台物理机器真实结果尚未取得。只有拿到异机部署证据并修复阻塞后，才将跨机器支持写成已验证。
