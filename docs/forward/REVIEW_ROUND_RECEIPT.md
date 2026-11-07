# 复核轮回执（R1–R4 修复，2026-11-07）

本文件回应 `E:\javaproject\outputs\codex-forward-review-20261107\REVIEW.md`。复核对象是上一轮的集成 HEAD；本轮回执只讲四件事：修复提交、复现前后、快照完整性、新候选。

- 集成树：`E:\javaproject\workbuddy-forward-20261107\I-integration`
- 复核对象：HEAD `b2bbfde9925be22b3046d842c2212d55941dba23`，tree `aa8ec80fadce2e872e40a5c629a03b9b87e93c83`（业务冻结点 `1143d65`）
- 修复分支：`fix/forward-review-r1-r4`（从 `b2bbfde` 拉出）
- 证据根：`E:\javaproject\outputs\forward-delivery-20261107\I\`

## 1. 修复提交

| 提交 | 内容 |
|---|---|
| `39c3d72` | `fix(runtime): read the model catalog without launching or reconfiguring the native client` — R1 |
| `7ec1486` | `fix(automation): keep a rate apart from a balance and resolve the saved effort by identity` — R2 + R3 |
| `8f3e84f` | `chore(snapshot): regenerate the source snapshot so the new gate can run` — R4 |

## 2. 复现前后

### R1（未武装评估不得启动/重启/配置原生客户端）

- **修前路径**：`gateway/src/automation-cli.ts:167` 与 `gateway/src/server.ts:41` 都用 `desktopModelCatalog(config, process.env)`；其 WorkBuddy 读取经 `gateway/src/workspace-manager.ts:83` 的 `listModels` 构造 `autoLaunch=true` 的 `NativeDesktopRpcTrigger`。端口未就绪时 `native-desktop-trigger.ts:453` 的分支会退出已有客户端再重启，普通 `connect()` 还会写 renderer bridge。
- **修后路径**：新增 `gateway/src/read-only-catalog.ts`，两个入口改用 `readOnlyCatalogReaders()`；其 WorkBuddy 读取是 `NativeDesktopRpcTrigger(target, port, false).diagnoseReadOnly()`——第三个参数 `false` 就是「不启动、不重启、不注入」。
- **单测证据**（`gateway/test/read-only-catalog.test.ts`，5/5）：用可记录的 `NativeDesktopProcessControl` 替身驱动**真实 trigger**，断言 `launched` 为空、命令里没有 `taskkill`；端口在监听时也只做读取；`bridgeReady:false` 时报「unavailable」且 `close()` 一定被调用；最后一个用例断言两个入口源码用的是 `readOnlyCatalogReaders()` 且不再出现 `desktopModelCatalog(config, process.env)`。
- **本机真实探针**（`I\r1-readonly-probe.log`）：本机确实有 6 个 WorkBuddy 进程在跑，`readOnlyWorkbuddyCatalog` 在 218 ms 内返回 `{"observed":false,"error":"Native desktop is offline"}`，前后进程数量与 PID 集合完全一致（`same_pids=True`）。⇒ 现在这条路不会为了读目录而关掉正在跑的客户端。
- **未取得**：真实 CDP 桥可用的样例（需要 WorkBuddy 真的开放端口），因此「读到模型列表」这一侧只有替身证据。

### R2（known_cost 不能把倍率、跨连接估算或错单位当余额）

- **修前**：`automation.ts:1498` 只凭 `modelId` 取 token 池；`1210` 的 `known_cost` 接受任何非 `unavailable` 的估算或费率；`1224` 单位不符只追加 `limits`。复核给出的两组输入都得到 `decision:"delegate"`、`blocks:[]`。
- **修后**：probe 行把「费率」和「余额」拆成两个字段（`rate{}` / `balance{kind,unit,remaining,routing,source}`）；`known_cost` 需要 fresh、单位与政策一致、`routing==="verified"` 且只有一个来源，缺任一条都进 `blocks`（`QUOTA_UNAVAILABLE` / `COST_CONTROL_UNAVAILABLE` + `cost_unit_mismatch` / `cost_routing_unverified` / `cost_source_ambiguous`），单位不一致时不做 ceiling 比较。`unknown_allowed` 行为不变；`free_only` 仍要求 fresh 且 `x0.00` 证明。
- **用例证据**（`gateway/test/automation-selection-gate.test.ts`，6/6）：①只有 `x0.11` 倍率、`remaining:null` → `wait` + `QUOTA_UNAVAILABLE`/`cost`；②跨连接同名模型 1000 tokens 估算 + 本地 10 credit 门槛 → `wait`，blocks 同时含 `cost.routing` 与 `cost.unit`，且没有发生 1000 与 10 的比较；③同一个已验证 per-model 余额 → `delegate` 且 `remaining 5000`；④同一模型两个已验证余额 → `cost_source_ambiguous`。既有的 `automation-probe.test.ts` 那条池态用例按新契约改写为「可达报告、不可支撑 known_cost」（`wait` + `COST_CONTROL_UNAVAILABLE`/`cost.routing`，`cost.remaining` 仍报 1000）。
- **已知边界（如实写）**：候选对象里的 `cost.unit` 取自目录行的单位；当余额本身是 `unavailable` 时它回落到政策单位。该字段只用于展示，任何比较都要求 `unitMatches`（余额单位 === 政策单位），所以这只影响「不可用时显示哪个单位」，不影响决策。

### R3（保存的推理档不能靠目录顺序碰运气）

- **修前**：`automation.ts:1188` 先按模型取第一条观测再检查推理档；默认 probe 每档一行，`low` 排在前面时已保存的 `high` 政策会错返 `MODEL_UNVERIFIED`。
- **修后**：先按执行器/连接/provider/model 归组，`modelRow` 用 `identityRows.find(row => row.reasoningEfforts.includes(policy.executor.reasoningEffort))`，匹配失败时消息写出源实际报告过的档位（`reported: low, high` 或 `none`）。
- **用例证据**：同一政策的两种目录顺序（`low,high` 与 `high,low`）都 `delegate` 且 `candidates[0].execution.reasoningEffort === "high"`；缺失档位时报出来的档位清单正确且不被替换。

### R4（新 CI 的第一项必须能过）

- **复现**：在干净树上跑 `node verify-snapshot.mjs` → `Error: Snapshot mismatch: desktop/Program.cs`，exit 1（与复核一致）。
- **修后**：`node scripts/generate-snapshot-manifest.mjs` 从 `git ls-files` 重生成清单，`node verify-snapshot.mjs` → `{"snapshotFilesVerified":436,"hashesMatch":true,"manifestCompleteness":"checked"}`，exit 0。完整性从「逐条比哈希」升级为「与 Git 跟踪集互相比对」：清单少列或列了未跟踪文件都会报错；`dist/` 若被跟踪也直接报错。

## 3. 快照完整性

| 项目 | 数值 |
|---|---|
| 清单条目 | 436 |
| 哈希比对 | `hashesMatch: true` |
| 完整性判定 | `manifestCompleteness: "checked"`（与 `git ls-files gateway` 集合一致，排除 `SNAPSHOT_MANIFEST.json`/`RUNTIME_BASELINE.json`） |
| 抓取时间 | 沿用 `2026-10-23T00:39:39.586Z`（重生成保持幂等，不重写上游来源声明） |
| 复现命令 | `cd gateway; node verify-snapshot.mjs` |

## 4. 门禁（本轮真实输出）

| 门 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 类型检查（服务端） | `npx tsc --noEmit -p tsconfig.json` | exit 0 | — |
| 类型检查（TaskView） | `npx tsc --noEmit -p tsconfig.task-view.json` | exit 0 | — |
| 构建 | `npm run build` | exit 0 | `I\build-r4.log` |
| 后端串行全量 | `npx tsx --test --test-concurrency=1 test/**/*.test.ts`（`WORKBUDDY_CONFIG_DIR` 固定） | **1455 tests / 1443 pass / 0 fail / 12 skipped**，exit 0，1,320,256 ms | `I\full-suite-r4.log` |
| 工作台 | `npm run test:workbench` | 165 tests / 165 pass / 0 fail | `I\workbench-r4.log` |
| 冒烟 | `node scripts/workbench-smoke.mjs` | `{"smoke":"passed","steps":25}` | `I\workbench-smoke-r4.log` |
| 桌面策略 | `npm run desktop:test` | `{"passed":122,"failed":0}`，exit 0 | `I\desktop-test-r4.log` |
| 候选自检 | `node scripts/verify-release.mjs`（解开 final6） | `{"version":"0.7.1","verifiedFiles":750,"hashesMatch":true}` | `I\candidate-final6-verify.txt` |
| 候选安装前置 | `candidate-installation.mjs check --expect-sha256 3d533c36…` | `ok:true`、`files:750`、`totalBytes:8163268`、`problems:[]` | `I\candidate-final6-check.json` |
| 隔离安装演练 | `drill --apply` / `upgrade-drill --apply` / `rollback-plan` / `version-check` | 四条全 exit 0；`version-check` `matched 750 / missing [] / exact true / matches true` | `I\candidate-final6-{drill,upgrade,rollback,version}.log` |
| 候选复算（文档提交后的 HEAD） | `npm run build` → `node scripts/package.mjs I\repro-r4` | 重打包摘要 `3d533c36…`，与 final6 一致（`match=True`） | `I\repro-r4.log` |

两条与本机环境有关的说明（不改结论）：

1. **没有跑 `npm ci`**：本机五个工作树的 `gateway/node_modules` 是指向起点树的目录联接，`npm ci` 会把联接替换成真实目录并重下依赖。CI 首跑时会真正执行这一步。
2. **`dist` 与 `src` 的时间戳**：`scripts/package.mjs:125` 断言 `dist` 比 `src` 新；我在复核过程中 `git checkout` 回退过一个装饰性改动，导致 `src` 的 mtime 变新而打包被拒（`Error: dist is older than src`）。重跑 `npm run build` 后照常打包，且摘要与 final6 完全相同——说明被拒的是时间戳，不是内容。

### 测试日志分档（上一轮遗留要求）

| 档 | 内容 | 可引用的结论 |
|---|---|---|
| A. 干净基线 | 冻结 HEAD `1143d65` 的串行全量：1444 tests / 1432 pass / 0 fail / 12 skipped，完整日志 `I\full-suite-head2.log` | 可引用「0 fail」 |
| B. 一次真实回归（已修） | 我加账本时 `TaskStore` 构造即建 `usage_records` 表，破坏 `statistics.test.ts:304`「从未记录 → `present:false`」；改懒建后 `statistics + dsh-adapter + usage-attribution` 68/68 | 只讲「曾经引入、已修、复跑通过」 |
| C. 两个并发偶发（未定位） | `desktop-queue.test.ts:141` listener 可见性、`desktop-dispatch-e2e.test.ts:73` `ERR_SQLITE_ERROR`；两者都是并发加载下的时序/竞争，单跑分别 24/24、1/1 通过，轮转出现 | **只能**说「高并发下有偶发、单跑通过、未定位」，不得用那一轮的汇总数声称全绿 |
| D. 本轮 R4 后 | 见 §4 串行行 | 修复后的最新一档 |

## 5. 新候选（本机生成，非发行）

| 字段 | 值 |
|---|---|
| 目录 | `E:\javaproject\outputs\forward-delivery-20261107\I\candidate-final6` |
| 包 | `codex-workbuddy-gateway-v0.7.1.zip` |
| 字节 | 2,496,411 |
| 受管文件 | 750（解压后 750，含 `src/read-only-catalog.ts`、两个新测试文件） |
| ZIP SHA-256 | `3d533c36fb7b67c2071f9a4a35aab5f8c9b21967b0b5676d274df83170d9cb3e` |
| manifest | 121,199 B / SHA-256 `ca5407eda257240790e962a96dfdc9f5da6df16196fedb2ae8938d79be3207e8` |
| 解压校验 | `{"version":"0.7.1","verifiedFiles":750,"hashesMatch":true}` |
| 安装前置 | `ok:true / files 750 / totalBytes 8,163,268 / problems []` |
| 桌面成品 | `workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip` 752 文件 / 2,903,333 B / SHA-256 `cb3effed00af5e259fca41593a490df2ea2f63ea72fef1c5f8c49e560912c216`（本轮未重建，桌面 C# 无改动） |
| 相对 final5 | `745 → 750` 文件；增量＝R1 新增源文件与两个测试文件 |

## 6. 交接材料修正

| 项 | 修正 |
|---|---|
| A2 安装条件 | 改为指向 final6 的真实字节与摘要；命令改为真实存在的那一套：解压 → `node scripts/bootstrap.mjs --install-root <新根> --apply` → `npm run doctor` → `candidate-installation.mjs version-check`。**上一轮写的 `candidate-installation.mjs install` 子命令不存在**（该脚本只有 `check/preview/drill/upgrade-drill/dependencies/version-check/rollback-plan`），已删掉。回退＝保留旧根不动 + `rollback-plan` 只出计划。 |
| A3 MCP/服务切换 | 拆成两件事分别取证：磁盘上的安装版本（`readiness`/`version-check` 的 codeHash 与包摘要）与聊天进程实际加载的版本（重启宿主后的 `workbuddy_get_runtime` 指纹）。两者不等即说明聊天里跑的不是新包，不得合并成一条结论。 |
| A7 arming | 明确 arming 只是**执行开关**；每个真实任务仍要按 AGENTS.md 逐任务确认执行器/来源/精确模型/推理档/已知费用，arming 不是一次总授权。 |
| A10 / F-CONTRACT-1 | 选中 A（写权限只来自结构化 scope）**足以**继续用结构化范围样本推进，因此从「M1 必答条件」降为非阻塞项；不再列为 M1 的前置。 |
| 提交数 | 复核 HEAD `b2bbfde` 处 `git rev-list --count 134cdc7..HEAD` = **72**（上一轮写 71，少计了回执提交）；本轮修复在 72 之上另计（见 §7）。 |
| 测试日志 | 按 §4 的 A/B/C/D 四档分开引用，禁止用并发轮的汇总数声称全绿。 |

## 7. 提交与文件

- 修复分支 `fix/forward-review-r1-r4` 上的提交：见 §1 三枚 + 本文件所在提交。
- 本轮新增/修改文件：`gateway/src/read-only-catalog.ts`、`gateway/src/desktop-dispatch-runtime.ts`、`gateway/src/automation-cli.ts`、`gateway/src/server.ts`、`gateway/src/automation.ts`、`gateway/test/read-only-catalog.test.ts`、`gateway/test/automation-selection-gate.test.ts`、`gateway/test/automation-probe.test.ts`、`gateway/SNAPSHOT_MANIFEST.json`、本回执与 `EXTERNAL_CONDITIONS.md`。

## 8. 仍然未满足（与上一轮一致，未因本轮修复而改变）

1. 真实派工、真实窗口、真实安装到常驻根、真实自动 arming、异机、CI 远端执行、许可与发行：全部仍需要 A 组条件。
2. 两处并发偶发仍未定位（能给出推断与单跑通过，不能给出根因）。
3. 真实 CDP 桥可用时的目录读取只有替身证据。
