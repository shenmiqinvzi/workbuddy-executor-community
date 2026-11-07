# RESUME：断线续跑状态

> **本轮（forward 20261107）状态入口已前移**：`docs/forward/README.md` 与
> `docs/forward/I_CHECKPOINT_2.md` 是本轮的唯一现状入口；证据根在
> `E:\javaproject\outputs\forward-delivery-20261107\`（含 `RESUME.md`）。
> 本文件往下是 2026-11-06 收口轮的历史记录，其中的树路径与 HEAD 不再代表当前开发树
> （本轮开发树为 `E:\javaproject\workbuddy-forward-20261107\I-integration`，分支
> `integration/forward-delivery`，起点 `134cdc7febbf858e89fb1010cf6b9d72da5edbe7`）。

更新时间：2026-11-06（收口轮）

## 1. 树与分支

| 用途 | 路径 | 分支 | 基线 HEAD |
| --- | --- | --- | --- |
| 唯一开发树（本轮所有改动） | `E:\javaproject\workbuddy-finish\R-review-fixes` | `fix/delivery-review-r1-r4` | `8a614c9ee7dc76c4cec22727f884cf6a0e658792` |
| 正式集成源（只读核对，不改） | `E:\javaproject\workbuddy-resource-integration` | `integration/resource-center` | `6c9787a8a5b7a3832ffdb32365c8564b26829b15` |
| 八条开发线历史树 | `E:\javaproject\workbuddy-finish\L01-project` … `L08-acceptance` | 各线分支 | 见 `gates/G0–G3.json` |
| 交付物外部目录 | `E:\javaproject\outputs\finish-integration-20261105` | — | 日志/证据/回执，不入 Git |

原集成树 README.md/ROADMAP.md 有既存未提交改动（README sha `540b4bbf…`、ROADMAP sha `912d4184…`），本轮未触碰。

## 2. 本轮已完成

| 项 | 状态 | 证据 |
| --- | --- | --- |
| C4-1：journal 读异常不得证明「未派工」 | 代码 + 回归（7 种注入 + ENOENT 对照） | `logs/c41*.log`、`probe-after-c41.mjs` |
| 同类读取失败审查 | `run-journal.ts`/`run-worker.ts` 的 `process.kill` 仅 ESRCH 判死 | `logs/full-test*.log` |
| R3：CLI 组合根接共享派工 | 代码 + 正向/围栏测试 | `test/automation-cli-dispatch.test.ts` |
| R2：自由文本脱敏边界 | title/correction 也脱敏；同字段重复只报一次 | `test/delivery-export.test.ts`（20 例） |
| F-CONTRACT-1 | 行为说明 + 兼容影响 + 需用户决定项 | `docs/delivery/F_CONTRACT_1.md` |
| C4-2：索引顶部口径 | 见 `docs/delivery/FINAL_REVIEW_INDEX.md` 顶部 | 本文件同批提交 |

## 3. 正在跑/待跑

- 完整后端套件已在冻结树上跑完：1300 tests / 1287 pass / 1 fail（command-cleanup 高负载时序，单跑 4/4）/ 12 skipped，日志 `outputs\finish-integration-20261105\closeout\logs\full-test-freeze.log`。
- workbench（`npm run test:workbench`）、桌面策略（`npm run desktop:test`）、C# 构建（`npm run desktop:test（C# 策略测试；需要时再 dotnet build desktop\WorkBuddy.Workbench.csproj -c Release）`）。
- 打包与解包探针：`node scripts/package.mjs` → 解包 → `verify-release.mjs` + `candidate-installation.mjs` + 缺陷探针。

## 4. 原任务身份（不可覆盖）

- RC2 真实派工留下的 `blocked` 任务 `rc2-live-20261106`（operation `card-...`/`compat:send:rc2-live-20261106:…`）按 T7D 原样保留，不关闭、不重派、不释放；库副本留在 `outputs\...\G3-fix\live-rc2\evidence\blocked-capacity\`。
- 安装根 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc2` 是上一个候选的实测环境；本轮不热修安装目录，新代码只出新候选。

## 5. 已知失败（不粉饰）

| 失败 | 结论 |
| --- | --- |
| `run-worker.test.ts` detached worker 偶发 `EPERM rename`（高负载） | 单跑稳定通过；根因未定位；不在本轮改动面 |
| `command-cleanup.test.ts` 嵌套 Job 取消偶发计数为 0 | 单跑 4/4 通过；高负载时序 |
| tsx 首次 `os.userInfo` ENOMEM | 沙箱加载器环境失败，非业务断言 |

## 6. 下一步顺序

1. 冻结本轮改动 → 跑最终全量/workbench/desktop/dotnet。
2. 打包新候选（RC5）→ 解包 → verify-release/check/preview/version-check/drill/upgrade-drill/rollback-plan/探针。
3. 更新 `FINAL_REVIEW_INDEX.md` 顶部（当前对象）、`STATUS_INDEX.md`、`PROGRESS.md`、31 任务/53 项增量。
4. 提交 + 外部回执 + `EXTERNAL_DECISIONS.md` 定稿。
5. 真实验收与安装/派工/异机/许可/发行：等用户在 `EXTERNAL_DECISIONS.md` 里逐项选择后再做。

## 启动链路续查（2026-11-06 夜，只读）

- 新增 `docs/delivery/STARTUP_DIAGNOSIS.md`：attempt-06 时间序阶段表（17 ms host_ready → 5.1 s 起 webview，HTTP 200，`ready=false`、`failureCode=null`、stderr 空，持续到 33.2 s）；attempt-07（40 个 `msedgewebview2` 与空 profile）；attempt-08（`%LOCALAPPDATA%` 下 `CreateDirectory` 被拒，而同会话 pwsh/cmd 可写 → 指向执行上下文）。
- 修正四处越界表述：PowerShell 版本、页面渲染、宿主先退出、ASCII 移动即修法。
- 客户端：`exit 0`、无子进程、无端口、`debug.log` 未追加、userData 为空；asar 告警是历史（13:03–18:11）。
- RC6 包字节未变；未安装、未派工、未改政策、未清旧占用。
- 下一步（需授权或人工一次）：普通桌面会话复跑壳一次；再决定 profile 根；客户端只在普通会话双击观测日志。
