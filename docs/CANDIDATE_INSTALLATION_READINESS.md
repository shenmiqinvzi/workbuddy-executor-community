# 候选安装准备与隔离演练（A 线）

本记录对应 D1-01「可安装准备」的预览部分和 D7-01「隔离安装演练」，**不包含真实安装、真实升级或生产切换**。文中所有运行都在本轮新建的隔离目录里，使用合成桌面配置、假可执行文件与合成任务库；不修改真实安装目录、真实 `.env`、用户 `config.toml`、任务历史或模型政策。

## 1. 结论

| 项目 | 状态 |
|---|---|
| 候选包只读核对（清单、哈希、路径边界） | 已实现并隔离验证 |
| 安装预览（新建/变更/保留/阻挡、依赖条件、备份与回退） | 已实现并隔离验证 |
| 首次安装、相同内容重复安装、升级、卸载与恢复原技能 | 复用既有 `setup.mjs`，本轮补齐隔离演练与回归 |
| 失败中断与回退 | 复用既有回退逻辑，本轮新增失败回归 |
| 真实安装 / 真实升级 / 生产切换 | **未执行** |
| 跨机器验收 | **未执行** |

本轮没有把隔离演练称为真实安装，也没有把 D1 或 D7 标记为完成。

## 2. 基线与目录

- 工作目录：`E:\javaproject\workbuddy-next-round\A-installation`
- 分支：`feat/candidate-installation-readiness`，起点 `882acc8`
- 候选输入包：`E:\javaproject\outputs\dsh-discovery-fix-20261105\package\codex-workbuddy-gateway-v0.7.1.zip`
- 候选包 SHA-256：`003417bce7b41e4b9bdc3400d3a5d779f80d8dc9fed53437db52f63e964546b8`

该包是**网关候选发布包**，不含可直接运行的桌面完整安装：`desktop/` 只有 C# 源码，没有编译后的 exe；包内也没有 `node_modules`。桌面程序、.NET 10 Desktop Runtime、WebView2 Runtime 与 `npm ci` 依赖需要单独准备，预览会把这四项列为条件而不是假定满足。

## 3. 本轮新增

### 3.1 `gateway/src/installation-readiness.ts`

只读模块，不改动既有安装器：

- `inspectCandidatePackage(file, { expectedSha256? })`：自行解析 ZIP 中央目录与本地头，逐条校验 `RELEASE_MANIFEST.json` 的路径、字节数与 SHA-256，拒绝清单外文件、越界路径、链接与超大归档（归档 256 MiB / 解压 512 MiB / 65535 条目上限）。
- `assertArchivePath(name)`：拒绝绝对路径、盘符、反斜杠、`.`/`..` 段、空段、结尾斜杠、ADS 冒号与控制字符。
- `planCandidateInstallation(input)`：把候选清单与目标目录比对成 `create/update/unchanged/unmanaged/blocked/managedDrift`，并给出 8 项前置条件与备份、回退、下一步文案。它不写任何文件。
- `assertDrillWorkspace({ drillRoot, installRoot, codexHome, env? })`：演练目录必须显式给出、必须存在、不能是盘符根或用户主目录；安装目录与假 `CODEX_HOME` 必须都在演练目录内且互不相同；环境里的 `CODEX_HOME` 越界即拒绝。

### 3.2 `gateway/scripts/candidate-installation.mjs`

| 命令 | 行为 | 是否写盘 |
|---|---|---|
| `check` | 核对候选包清单与哈希，输出版本、文件数与问题列表 | 否 |
| `preview` | 输出安装计划；缺少 `--install-root`/`--codex-home` 直接报错 | 否 |
| `drill` | 在显式演练目录解包并跑 `plan` | 仅演练目录 |
| `drill --apply` | 追加 `install`、重复 `install`、`uninstall` | 仅演练目录 |

`drill` 会在演练目录内自建合成桌面资产（`WorkBuddyAI.exe` 占位文件与含 `sessions` 表的 `workbuddy.db`），并把 `WORKBUDDY_CLI_ELECTRON`、`WORKBUDDY_CONFIG_DIR`、`CODEX_HOME` 全部指向该目录，因此不会读取真实 WorkBuddy 安装或用户配置。

### 3.3 修了一个既有缺口

`gateway/src/deployment-safety.ts` 的 `assertTaskRecordsStopped()` 在任务有 `attempt_id` 但 `runs/<attempt>/state.json` 缺失时，直接把 `ENOENT` 抛给调用方。这既不是「空闲」也不是可解释的拒绝，安装器因此以一个文件系统错误中断。

现在按「状态不明一律拒绝」处理：库打不开 → `Task records are unreadable; installation was left unchanged.`；`state.json` 缺失 → `Native stopping is unconfirmed; installation was left unchanged.`；读取或解析失败 → `Task stop evidence is unreadable; ...`。拒绝发生时安装目录与 `.env` 均未创建。

## 4. 八项要求的落点

| 要求 | 实现 | 隔离验证 | 真实未执行 |
|---|---|---|---|
| 1 预览默认只读 | `planCandidateInstallation` 只读；`check`/`preview` 不写 | `plan` 前后对演练目录做整树哈希，完全一致；`preview` 后目标目录 `0` 文件 | 真实安装目录未预览 |
| 2 不改 .env、config.toml、技能、任务库、profile，不启停进程 | 只读命令不调用 `setup()`；`drill` 用自建 `.env` 与假 `CODEX_HOME` | 演练前后真实用户目录未参与；`drill` 的 `.env`/技能都在演练目录内 | 真实 `.env` 与 Codex 配置未触碰 |
| 3 演练只用自建目录，显式传参，不回落 | `assertDrillWorkspace` 六类拒绝 | 缺 `--drill-root` 报错；越界、同目录、盘符根、主目录、不存在目录均被拒 | 无 |
| 4 首次安装/重复/升级/中断回退/卸载恢复 | 复用 `setup()` 四动作 | 9 项新回归覆盖：首次 `changed=true`、重复 `unchanged=true`、源变化后 `install` 要求 `upgrade`、升级成功、`uninstall` 恢复安装前的个人技能并保留 `.env` 与 `data/` | 真实升级顺序未执行 |
| 5 配置、历史、政策与用户修改保留 | 复用既有 `.env` 保留与本地改动检测 | `.env` 字节不变；`data/private-history.txt` 原样；技能或片段被改后 `managedDrift` 命中且 `safeToApply=false` | 真实任务历史未读取 |
| 6 活动任务/停止未确认/容量未知/库不可读/服务不明必须拒绝 | 复用 `assertInstallationIdle`，本轮补 `state.json` 缺失与库不可读 | working 任务、缺失停止证据、`persistent-service.json` 三种拒绝，且 `.env` 未创建 | 真实任务库未参与 |
| 7 中文与空格路径、链接、zip 路径边界 | 全部 fixture 使用 `演练 root`/`安装 directory`；`target_is_link`；`assertArchivePath` | 路径攻击表 10 条全部拒绝；junction 目标被阻挡；中文空格路径全程通过 | 真实安装路径未演练 |
| 8 部署前清单与可回退证据 | `backups`/`rollback`/`next` 与预览报告的 `blocked`/`managedDrift` | `drill` 报告含每步结果；中断升级回归证明 skill/snippet/env 复原、锁释放 | 真实回退未执行 |

## 5. 命令与结果

隔离环境变量（所有涉及 `loadConfig` 的测试都必须显式给出，否则本机会因多个安装候选报歧义）：

```powershell
$env:WORKBUDDY_CLI_ELECTRON = "<outputs>\env\WorkBuddy.exe"
$env:WORKBUDDY_CONFIG_DIR   = "<outputs>\env\workbuddy-config"
$env:NO_PROXY = "127.0.0.1,localhost"
```

| 命令 | 结果 |
|---|---|
| `npx tsx --test test/candidate-installation.test.ts test/deployment.test.ts` | 23 项全通过（新增 9 + 既有 14），exit 0 |
| 修复前同一命令（旧 `deployment-safety.ts`） | 8 通过 / 1 失败（`ENOENT ... state.json`），exit 1 |
| `npm run build` | exit 0 |
| `npm run typecheck:task-view` | exit 0 |
| `npm test`（隔离环境变量） | 1022 项 / 1010 通过 / 0 失败 / 12 跳过，exit 0 |
| `npx tsx --test test/quota-entry.test.ts` | 6/6 通过，exit 0（用于定位全量首轮的并发失败） |
| `node scripts/candidate-installation.mjs check --package <包> --expect-sha256 003417bc…` | `ok=true`，570 文件，5,430,511 字节，0 问题，exit 0 |
| `… preview --install-root … --codex-home …` | `create=570`，`safeToApply=false`，`runtime_dependencies=false`，`desktop_application=false`，目标目录 0 文件，exit 1（预期：候选包不是完整安装） |
| `… drill --drill-root …` | 解包 570，`plan` 通过，未写安装之外的内容，exit 0 |
| `… drill --drill-root … --apply` | `plan`/`install`/`install_repeat`/`uninstall` 全部 ok；`idempotent=true`、`envPreservedAfterUninstall=true`、`skillRemovedAfterUninstall=true`，exit 0 |

首轮正式全量出现 1 项失败：`test/quota-entry.test.ts` 的 `compiled entry: credit invalid preserves task reads and credential boundaries` 报 `TypeError: Cannot read properties of undefined (reading 'errorCode')`。该文件单独运行 6/6 通过，第二轮全量 1022/1010/0/12 通过；失败与本次改动无关（未触及 quota/credit 读取路径），按并发资源竞争记录，未通过反复重跑掩盖。

证据位置：`E:\javaproject\outputs\candidate-installation-readiness-20261105\`
- `logs\before-fix.log`（修复前 1 项真实失败）
- `logs\after-fix.log`（修复后 23 项）
- `logs\full-suite.log`（第二轮全量，1010 通过）
- `logs\quota-entry-alone.log`（并发失败项单独复跑）
- `logs\check.log`、`reports\check.json`
- `logs\preview.log`、`reports\preview.json`
- `logs\drill.log`、`reports\drill.json`
- `logs\drill-apply.log`、`reports\drill-apply.json`
- `drill\`（演练目录，可整体删除）

## 6. 旧实现已具备、本轮未重写

- `setup.mjs plan|install|upgrade|uninstall --apply`：`.env` 只在不存在时创建；既有 `.env` 永不重写；技能先备份后替换；生成 `data/workbuddy-mcp.toml` 与 `data/deployment-installation.json`；失败时回滚技能、片段与新 `.env`。
- `assertInstallationIdle()`：活动任务、停止证据、常驻服务三类拒绝。
- `discoverDesktopPaths()`：显式传入即用、不探测；缺失或歧义时报错而不是猜。
- `zip.mjs` 与 `verify-release.mjs`：打包与发布清单校验。
- `deployment.test.ts` 既有 14 项回归。

本轮只在 `deployment-safety.ts` 做了一处最小修复（见 3.3），其余安装行为未改动。

## 7. 生产切换的最少条件

1. 候选包经 `check` 核对通过，且 SHA-256 与发布记录一致。
2. 在目标机器上用 `preview` 得到 `safeToApply=true`：`node_modules` 已按 lockfile 安装、桌面程序与 WebView2 就绪、目标目录不是主目录或盘符根、既有 `.env` 的 backend 为 `desktop-queue`。
3. 所有任务已验收或明确结束，停止证据可读且确认；无常驻服务占用。
4. 已自行备份 `.env` 与 `data/`，并记录当前版本号，可回到上一份候选包。
5. 安装后按 `node scripts/doctor.mjs` 复核，MCP 条目由使用者本人合并进 Codex 配置。
6. 真实安装、真实升级与另一台物理机器的验收仍需单独执行并单独记录。

## 8. 仍未完成

- 真实安装、真实升级与回退未执行。
- 跨机器验收未执行。
- 完整桌面安装（exe、.NET、WebView2）不在本包内，其准备步骤只列为条件。
- `SNAPSHOT_MANIFEST.json`、打包脚本与进度文件由集成人统一处理；新增脚本 `scripts/candidate-installation.mjs` 若需进包，需由集成人加入白名单。
