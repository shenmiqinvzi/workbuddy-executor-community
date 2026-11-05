# L04 安装、升级回退与发行准备验收记录

本文件记录 L04 线在 G0 基线上的实际执行结果。所有数字来自本机实际命令，未执行的一律写「未执行」并给出缺失条件。真实生产安装、真实升级切换、物理第二台机器与外部许可决定均不在本线授权内，见第 7 节。

## 1 范围与任务

- 任务：D7-01（安装、升级、回退、卸载与依赖诊断）、D7-03（第三方依赖与许可整理、最终用户安装说明），并完成 D1-01 的可回退候选包准备。
- 本线拥有：`installation-readiness` / `deployment-safety` 之外的安装与发行专属代码（新增 `installation-dependencies`、`installation-rollback`）、桌面依赖诊断、`scripts/candidate-installation.mjs` 的命令扩展、Windows 安装/恢复/部署验收/用户验收文档、本线新增测试。
- 不做：不重做 A 线已交付的 `check` / `preview` / `drill` 语义；不接管 `scripts/package.mjs` 的白名单与快照（本线未改动该文件，也未新增需入包的脚本名）；不改根 `README.md`、`ROADMAP.md` 的任何在途内容；不改 `docs/PROGRESS.md` 与 `docs/delivery/STATUS_INDEX.md` 的 gate 状态（由集成人在 G1 更新）。

## 2 基线与提交

| 项 | 值 |
| --- | --- |
| 工作树 | `E:\javaproject\workbuddy-finish\L04-installation` |
| 分支 | `feat/finish-l04-installation` |
| 基线提交（开工核对） | `1f60374a889ae5acb442affff7a59f3e045a1277` |
| 基线 tree | `a45970de95336ed79d99b835fc582d467d9e2e7d` |
| 本线提交 | 见 `E:\javaproject\outputs\finish-l04-20261105\HANDOFF.json` 的 `commits`（本文件随该提交归档，故不自引用 SHA；提交信息见同目录 `evidence\commit-message.txt`） |
| 开工时 `git status --porcelain` | 空 |

## 3 变更文件

新增：

- `gateway/src/installation-dependencies.ts`：只读依赖缺口诊断。逐项给出 `node_version`、`platform`、`architecture`、`gateway_build`、`production_dependencies`、`desktop_shell`、`dotnet_desktop_runtime`、`webview2_runtime`、`workbuddy_application`、`workbuddy_data`、`code_signing` 的 `ok`/`missing`/`mismatch`/`not_applicable`，并给出 `gaps`、`blocksInstall`、`unknown` 与 `networkProbes=0`。.NET 与 WebView2 探测可注入（测试与离线环境不触网）。
- `gateway/src/installation-rollback.ts`：只读回退差异计划。按文件字节识别已安装版本（`exact`/`differing`/`missing`），从目标发行包的 `src/task-store.ts` 抽取它认识的表与列（含 `ALTER TABLE` 迁移列），只读观察现有任务库，给出 `compatible`/`incompatible`/`unknown`/`not_applicable` 判断与恢复路线，输出 `replace`/`create`/`remove`/`keep`/`blocked` 计划、运行目标、配置影响、步骤与失败补救。任何写动作都由 `rollbackOperations()` 单独返回，计划本身不写盘。
- `gateway/test/installation-dependencies.test.ts`（4 项）、`gateway/test/installation-rollback.test.ts`（10 项）。

修改：

- `gateway/scripts/candidate-installation.mjs`：在保留 `check`/`preview`/`drill` 语义的前提下新增 `upgrade-drill`、`dependencies`、`version-check`、`rollback-plan` 四个命令；缺 `dist` 时统一 exit 2 并提示 `npm run build`；drill 段异常收敛为结构化 JSON 失败输出（不再打印堆栈）。
- `gateway/docs/INSTALL_WINDOWS.md`：新增「2.2 依赖自检与版本核对」；第 5 节补 `upgrade-drill`、`rollback-plan`、`version-check` 与备份要求。
- `gateway/RESTORE.md`：新增「版本回退与任务库结构」。
- `gateway/docs/DEPLOYMENT_ACCEPTANCE.md`：新增「异机可审查部署步骤模板」（部署步骤、版本核对、备份与回退、异机依赖检查清单）。
- `gateway/docs/USER_ACCEPTANCE.md`：追加「v0.7.1 发行准备」章节（产物种类、用户安装说明、已知限制、第三方依赖与许可声明）。
- `docs/delivery/L04_ACCEPTANCE.md`：本文件。

未改动但需说明：`gateway/scripts/package.mjs` 白名单未改，新模块位于 `gateway/src/*.ts`，按现有 `src` 规则自动入包；新增测试位于 `gateway/test/`，按设计不入包。

## 4 验证命令与结果

环境：Windows x64、Node 24.19.0、npm 11.17.0、.NET SDK 10.0.12、WebView2 Runtime 156.0.4314.58。运行前清除继承的 `WORKBUDDY_*`，自建 `WORKBUDDY_CLI_ELECTRON`、`WORKBUDDY_CONFIG_DIR`（含 `sessions` 表的合成原生库）、`TEMP`/`TMP`，并设 `NO_PROXY=127.0.0.1,localhost`。

| 检查 | 命令 | 退出码 | 计数 | 日志 |
| --- | --- | --- | --- | --- |
| 构建 | `npm run build` | 0 | — | `evidence\logs\build.log` |
| 候选安装专项 | `npx tsx --test test/candidate-installation.test.ts` | 0 | 11/11 | `evidence\logs\special-candidate-installation.log` |
| 依赖诊断专项 | `npx tsx --test test/installation-dependencies.test.ts` | 0 | 4/4 | `evidence\logs\special-installation-dependencies.log` |
| 回退计划专项 | `npx tsx --test test/installation-rollback.test.ts` | 0 | 10/10 | `evidence\logs\special-installation-rollback.log` |
| 全量 | `npm test` | 0 | 1062 项 / 1049 通过 / 0 失败 / 13 跳过，371.4 秒 | `evidence\logs\npm-test.log` |
| 打包 | `node scripts/package.mjs` | 0 | 591 文件 | `evidence\logs\package.log` |

打包产物（`gateway/outputs/release/`，仅本机工作树，未发布）：

- `codex-workbuddy-gateway-v0.7.1.zip`：591 文件，SHA-256 `1d037b5aa9429ac55c6e03a9c8c3b1d674be0b31fd093da210d59823f3101f8c`
- `workbuddy-executor-v0.7.1.zip`：6 文件，SHA-256 `2e5dcba6493f2efb64949a00c8571a1df51366ec012083eddb7b573fafebb4a6`
- `deepseek-executor-v0.7.1.zip`：2 文件，SHA-256 `22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13`

### 4.1 从打包解包后的工具执行（必做项）

解包目录：`E:\javaproject\outputs\finish-l04-20261105\evidence\unpacked\codex-workbuddy-gateway-v0.7.1`；先在其内 `npm ci --omit=dev`（exit 0，added 94 packages）。下表全部从该解包目录执行：

| 命令 | 退出码 | 实际结果 |
| --- | --- | --- |
| `check --package <zip> --expect-sha256 <sha>` | 0 | 591 文件，declared 与实测摘要一致 |
| `version-check --package <zip> --install-root .` | 0 | `matches=true`，1 个完整匹配的已安装版本 |
| `dependencies --install-root . --workbuddy-app <exe> --workbuddy-config <dir>` | 0 | `blocksInstall=false`；`desktop_shell`、`code_signing` 为 `not_applicable`，其余 ok |
| `preview --install-root <空目录>` | 1（预期） | `safeToApply=false`，`runtime_dependencies`、`desktop_application` 未满足 |
| `preview --install-root .`（工具根） | 1（预期） | `unchanged=591`、`unmanaged=2`，仅 `desktop_application` 未满足：纯网关包不含 `desktop/app` 桌面壳 |
| `drill --drill-root <自建> --apply` | 0 | 4 步通过，5 项断言为 true，6 个负向用例全部按预期拒绝 |
| `upgrade-drill --drill-root <自建> --apply` | 0 | 17 步、17 项检查全部为 true；回退计划 `replace=2`、`remove=1`、`keep=589`、`blocked=0` |
| `drill --drill-root <不存在路径>` | 1 | 输出结构化 JSON 失败，不含堆栈 |
| `rollback-plan --package <新> --to <旧> --task-db <合成库>` | 1（预期） | `safeToApply=false`，`schema.assessment.decision=incompatible`，缺失列逐条列出，文件计划仍完整输出 |

`upgrade-drill` 覆盖的路径（合成夹具，非真实切换）：干净安装 → 重复安装 `unchanged` → 直接 `install` 被要求改用 `upgrade` → `upgrade --apply` → 新文件与 `dist` 哈希校验 → 本地改动被拒 → 只读回退计划 → 按计划替换/删除 → `setup upgrade` 对齐 → 回退字节与文件删除校验 → 卸载后 `.env` 与任务历史保留、技能删除。负向用例：缺 `dist`、已注册常驻服务、未结束任务、停止证据不可确认、截断归档、摘要不符。

`rollback-plan` 的合成夹具位于 `evidence\rollback-fixture\`：从升级演练产出的新/旧两个合成发行版解包，并写入一个刻意缺少新列的任务库。它证明了几件事：判断来自目标发行包自己的 `src/task-store.ts`；不足结构会阻断；计划本身不写盘；把 `--task-db` 指向 WorkBuddy 原生库（只有 `sessions` 表）会得到 `unknown` 并提示「不像网关任务库」，而不是误判为 `incompatible`。

## 5 依赖缺口与许可台账

### 5.1 候选网关包 ≠ 完整可运行桌面安装

网关 ZIP 只包含源码、构建产物、文档与安装工具，**不含** `node_modules`、Node 运行时、.NET 桌面运行时、WebView2 运行时与 `desktop/app` 桌面壳。因此：

- 目标机需要 Node ≥ 22.13 与生产依赖（`npm ci --omit=dev`，本机 94 个包）；
- 需要 .NET Desktop Runtime 10 与 WebView2 Runtime（本机 10.0.12 / 156.0.4314.58）；
- 需要已安装的 WorkBuddy 客户端与可读的原生数据目录（`sessions` 表可读）；
- 缺任一项时 `preview` 会给出 `safeToApply=false` 与具体 `requirements`，`dependencies` 会给出逐项 `missing`/`mismatch` 与补救建议；
- 离线环境不发起网络探测（`networkProbes=0`），.NET/WebView2 探测可注入，缺失时按 `gaps` 处理而不是猜测。

未签名的事实如实记录：产物没有代码签名；安装说明不把关闭系统保护、放宽准入或批量结束进程列为前提。

### 5.2 第三方依赖与许可

从 `gateway/package-lock.json` 取非 dev 依赖并读取各自 `package.json` 的 `license` 字段（脚本输出在 `evidence\licenses\production-licenses.json`）：

| 许可 | 数量 |
| --- | --- |
| MIT | 84 |
| ISC | 7 |
| BSD-3-Clause | 2 |
| BSD-2-Clause | 1 |

合计 94 个生产依赖。桌面壳仅引用 `Microsoft.Web.WebView2` 1.0.4314.35（包内附 `WEBVIEW2-LICENSE.txt`），.NET 10 按其自身许可分发。

许可结论：**本线只整理与建议，项目许可由权利人决定**。工作树根与 `gateway` 根都没有 `LICENSE`/`COPYING`，本线未添加任何许可文件；发布前需权利人对项目整体许可与第三方声明位置作出决定。

## 6 给 10 与 11 的接口

- 给 10（真实验收）：`gateway/docs/DEPLOYMENT_ACCEPTANCE.md` 的「异机可审查部署步骤模板」四节——部署步骤命令模板、版本核对（`version-check` + `runtime-version`）、备份与回退（备份命令 + `rollback-plan` + 不替换文件的条件）、异机依赖检查清单。10 拿到的是可审查模板与只读工具，不是已执行的实机结论。
- 给 11（最终复核与交付）：`gateway/docs/USER_ACCEPTANCE.md` 的「v0.7.1 发行准备」——产物种类（网关 ZIP、技能 ZIP、Harness 技能 ZIP、桌面壳、源码树）、用户安装说明摘要、已知限制、第三方依赖与许可声明。

## 7 局限与未完成项

- 真实生产安装、真实升级与回退切换：未执行（不在本线授权内，归 10）。
- 物理第二台机器、跨机依赖实测：未执行（归 10）。
- 项目许可决定、对外发布与签名：未执行（归 11 与权利人）。
- 桌面壳的构建与运行：本线未构建 `desktop:build`，也未运行 C# 策略检查与正式壳合成冒烟——本线未改动 C# 或宿主代码，桌面壳的构建与验收状态以既有文档为准。
- `preview --install-root .` 在纯网关包上的 exit 1 是设计结果（缺 `desktop/app`），不是缺陷；完整桌面分发包的组包仍待发行决定。
- 所有演练都在 `E:\javaproject\outputs\finish-l04-20261105\evidence` 下的自建隔离目录与合成状态中进行，**不含任何真实生产切换**；未按进程名批量结束任何进程。

## 8 失败历史（保留以便复核）

1. 负向夹具在建库前未创建 `data` 目录，SQLite 报 `unable to open database file`（errcode 14）——已改为先建目录再建库。
2. 升级演练用一段占位文本覆盖技能文件，导致后续「本地改动」判定命中自己制造的内容——已改为写回目标发行包中的原始字节。
3. 负向夹具未预置 `workbuddy.db`，先被 `Select a compatible WorkBuddy data directory` 拦住，掩盖了要验证的拒绝原因——已改为夹具建库后重跑。
4. `docs/USER_ACCEPTANCE.md` 追加章节时，`---` 分隔符匹配到了 v0.6.0 与 v0.7.0 之间，新章节被插到文件中间并拼坏了 v0.7.0 标题——已按「最后一条 `---` 之前」把章节移回文件末尾，并把整文件统一为 CRLF（与 HEAD 一致）。
5. `scripts/candidate-installation.mjs` 被 PowerShell 写回时变成 CRLF，触发 `test/launcher.test.ts:25` 的换行断言——已用 `[IO.File]::WriteAllText` + 无 BOM UTF-8 归一为 LF。
6. 在 `.mjs` 中误写 TypeScript 断言 `(error as Error)`，运行时语法错误——已改为纯 JS 表达式。
7. 从目标发行包源码抽取列名时，真实 schema 的嵌套括号把闭括号带进了列名（出现 `messages.message_id)`），使若干判断把正常列当成缺失——已在列名解析处剥离尾部括号，并新增用仓库真实 `src/task-store.ts` 生成的回归用例（10/10 通过）。
8. 全量 `npm test` 在后台作业中被中断一次（返回 -1，日志截断在 T6 用例中段），已保留为 `evidence\logs\npm-test-interrupted.log`；随后前台重跑得 1062 项 / 1049 通过 / 0 失败。

## 9 运行与部署状态

| 项 | 状态 |
| --- | --- |
| 源码完成 | 是（本线范围内） |
| 合成验证 | 是（隔离目录 + 合成状态，含从解包产物执行 check/preview/drill/upgrade-drill） |
| 真实窗口/真实模型 | 未执行 |
| 物理异机 | 未执行 |
| 已合入 | 否（未 push、未合 main、未合入他人分支） |
| 已部署 | 否 |
| 已发布 | 否 |

`implemented=true`、`syntheticVerified=true`，其余 live/deployed/releaseReady 在 `HANDOFF.json` 中如实为 `false`。
