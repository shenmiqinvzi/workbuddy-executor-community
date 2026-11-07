# final6 复核轮回执（P1 旧快照费用门槛、两种 ZIP 对齐、A2/A3 操作表）

本文件回应 `E:\javaproject\outputs\codex-forward-final6-review-20261107\REVIEW.md`。起点是 `b41c60357639c6ddb07d30a93669243d480aae81`（tree `679aebab`），分支 `fix/forward-review-r1-r4`。

## 1. P1 · 旧观测快照不再被升级为已验证余额

### 改了什么

`gateway/src/automation.ts` 两处：

1. **回退不再声称路由**（原 `:1229` 起）。旧行没有 `balance` 字段时，仍按 `valueKind` 得到 `kind` 以便显示，但 `routing` 一律为 `"unverified"`、`source` 为 `null`。旧 `valueKind` 从来没说过这个数字属于哪个执行器/连接/模型。
2. **`known_cost` 明确拒绝非 reported 余额**。判据从「`kind === "unavailable"` 才拒」改成「`kind !== "reported"` 即拒」，估算值现在被点名：`this observation is only estimated`（原 `:1255` 起）。

### 复现前后（同一支探针，`--probe FILE` 重放）

复核方给的 `probe.mjs` 原样复制到证据根（`I\p1-probe.mjs`）后跑两遍。它构造的旧快照正是 final5 会写出的形状：`credits:"x0.11"`、`remaining:1000`、`unit:"tokens"`、`valueKind:"reported"`，没有 `rate`、没有 `balance`，政策是 `known_cost` + 10 tokens ceiling。

| | 修前（`I\p1-before.log`） | 修后（`I\p1-after.log`） |
|---|---|---|
| `decision` | `delegate` | **`wait`** |
| `blocks` | `[]` | `COST_CONTROL_UNAVAILABLE` / `cost.routing` |
| `limits` | — | `cost_routing_unverified` |
| `cost.remaining` | 1000 | 1000（仍然显示） |
| `cost.evidence` | `reported` | `reported`（仍然显示） |

同一支探针里复核确认过的另外三组没有回退：`unarmedEvaluate.launchAttempts` 仍为 `[]`（R1）；`knownCostWithRateButNoBalance` 与 `knownCostWithUnrelatedTokenPool` 都是 `wait`（R2）；`dshHighWithLowFirst` 是 `delegate`（R3）。

### 回归用例（`gateway/test/automation-selection-gate.test.ts`）

- `P1 a snapshot saved before balances carried routing stays readable but cannot satisfy known_cost`：旧形状行 → `wait` + `cost.routing`，`cost.remaining` 仍是 1000、`cost.evidence` 仍是 `reported`，且**没有**发生 ceiling 比较。
- `P1 known_cost refuses an estimate explicitly instead of only excluding unavailable`：`kind:"estimated"` + `routing:"verified"` → `wait`，消息含 `only estimated`，`cost.evidence` 保持 `estimated`。
- 正向与旧行为都保留：已验证 per-model 余额 → `delegate`；两个 verified 余额 → `cost_source_ambiguous`；`free_only`/`unknown_allowed` 行为未变。

### 拒绝的决定无法进入共享 send（`gateway/test/automation-cli-dispatch.test.ts`）

新增 `P1 a recorded snapshot without routing evidence cannot reach the shared dispatcher`：用真实 CLI 组合根 `decide`（`--probe` 指向旧快照文件）→ `decision.status === "blocked"`、`evaluation.decision === "wait"`、blocks 含 `cost.routing`；随后 `enable`，再 `execute --enable-dispatch` → `ok:false`、`code:"COST_CONTROL_UNAVAILABLE"`，且 `client.sent.length === 0`（一次也没到 transport）。

### 一处夹具修正（必须说明）

`gateway/test/support/automation-fixture.ts` 的默认模型行只写 `valueKind`/`remaining`，不写 `rate`/`balance`——那是旧探针的形状。P1 的判据一落地，`automation-policy.test.ts` 里「源可承受到硬上限才放行」的用例就从 `delegate` 变成 `wait`。修法不是放宽产品规则，而是让夹具说当前探针实际说的话：新增 `withCostEvidence()`，在未显式给 `rate`/`balance` 时补上 `reported` + `routing:"verified"` 的显式证据；想造旧快照的用例自己省略这两个字段（P1 的两条新用例正是这么做）。

## 2. 两种 ZIP 的网关字节对齐

旧桌面包是 R1–R4 修复之前的构建，与 final6 差 18 项、缺 6 项。本轮用**候选的网关字节 + 已核对的 C# 成品**重打桌面包：

| 项 | 值 |
|---|---|
| 网关候选 | `I\candidate-final8\codex-workbuddy-gateway-v0.7.1.zip` |
| 桌面包 | `I\candidate-final8-desktop\workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip` |
| 逐项比较（桌面包 `gateway/` 子树 vs 候选） | 候选 751 项（750 受管 + `RELEASE_MANIFEST.json`）、桌面包 `gateway/` 758 项；**相同 750、不同 0、缺 0** |
| 差异只有两类 | ①候选根的 `RELEASE_MANIFEST.json` 在桌面包里位于归档根（不在 `gateway/` 下）；②桌面包多 8 个 `desktop/app/*` C# 与 WebView2 产物 |
| C# 成品复用 | `desktop/app/WorkBuddy.Workbench.exe` 新旧桌面包 SHA-256 同为 `22d328a15d1fdbd7dbb3bf6077d801f4e2a48c94c624b9c202f1429a1d8830e4`，163,840 B；本轮没重建 C#，直接复用 |
| 确定性 | 同树重打两次桌面 zip 得到同一摘要 `a2e7f2ee…` |
| 旧包归属 | 旧桌面包 `cb3effed…` 保留在原处（`gateway\outputs\desktop-release\`），按「final6 之前的桌面成品」记录，不再作为本轮候选的一部分 |

## 3. A2 / A3 操作表修正（每条都在本机核对过）

| 项 | 复核意见 | 实际核对结果 |
|---|---|---|
| `bootstrap --apply` 的依赖步骤 | 应为带 `dist` 的发布包执行 `npm ci --omit=dev` | 属实：`gateway/src/installation-bootstrap.ts:110` 在 `buildPresent` 时用 `["ci","--omit=dev"]`；无 `dist` 时才 `npm ci` + `npm run build`，且这是 `scripts/bootstrap.mjs` 的首次运行分支 |
| 网关首次配置 | 由 `scripts/setup.mjs plan` / `install --apply` 完成，并要同一实际 WorkBuddy 路径、配置目录、隔离 `--codex-home` | 属实。本机实跑 `plan`（只读）：`{"ok":true,"action":"plan","changed":false,"mcpConfigModified":false,"taskSent":false}`，`envWillBeCreated:true`，提示去审 `data/workbuddy-mcp.toml` 后自行加入 Codex。**注意**：`setup.mjs` **没有** `--root` 参数（实跑报 `Unknown option '--root'`），必须在目标网关根内运行；`src/installation-bootstrap.ts` 原来那句 `setup.mjs plan --root <install-root>` 是错的提示，已改成实际可用的命令行 |
| `version-check` 的 `--package` | 省略时 exit 1，给了 final 包时隔离根 exit 0 | 属实：省略 → exit 1、`{"ok":false,"error":"--package is required."}`；带 final8 → exit 0、`matched 750 / missing [] / exact true / matches true` |
| `rollback-plan` 的参数 | 同样需要 `--package`，外加 `--to`、目标安装根与 codex-home | 属实：`rollback-plan --package <当前ZIP> --to <旧ZIP> --install-root <drill>\installation --codex-home <drill>\codex-home` → exit 0、`ok:true`、`problems:[]` |
| A3 指纹来源 | 从 `workbuddy_health` 的 `runtime.codeHash` 取；没有 `workbuddy_get_runtime` | 属实：`server.ts` 注册的工具里有 `workbuddy_health`，没有 `workbuddy_get_runtime`；`guard()` 给每个工具结果附加 `runtime:runtimeVersion`（含 `packageVersion`/`release`/`codeHash`）。操作表已按此改写，并要求磁盘安装版本与聊天加载版本分开取证 |
| 样本与确认表口径 | 按实际候选、具体新根、真实可选模型、用户逐任务选择填写；安装/聊天切换/模型调用分别取证；共享容量与原生不重叠分别取证 | 已写成 `EXTERNAL_CONDITIONS.md` 的 §E 表：候选绑定 `final8` 的 ZIP SHA 与 manifest SHA，安装根写绝对路径，桌面成品写 `a2e7f2ee…`，模型 id 必须现场从 `workbuddy_list_models` 抄，五个选择字段缺一不发车 |

## 4. 门禁（本轮真实输出）

| 门 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 类型检查 | `npx tsc --noEmit -p tsconfig.json` | exit 0 | — |
| 构建 | `npm run build` | exit 0 | `I\build-final8.log` |
| 受影响专项（8 个文件） | `npx tsx --test test/installation-bootstrap.test.ts test/automation-{policy,probe,cli-dispatch,http,selection-gate,dispatch}.test.ts test/read-only-catalog.test.ts` | **70 tests / 70 pass / 0 fail** | `I\targeted-final8.log` |
| 源快照 | `node scripts/generate-snapshot-manifest.mjs` → `node verify-snapshot.mjs` | `{"snapshotFilesVerified":436,"hashesMatch":true,"manifestCompleteness":"checked"}` | `I\snapshot-regen-final8.log` |
| 候选解压校验 | `node scripts/verify-release.mjs` | `{"version":"0.7.1","verifiedFiles":750,"hashesMatch":true}` | `I\candidate-final8-verify.txt` |
| 候选安装前置 | `candidate-installation.mjs check --package … --expect-sha256 8ca1e719…` | `ok:true / files 750 / totalBytes 8,170,501 / problems []` | `I\candidate-final8-check.json` |
| 隔离安装演练 | `drill --apply` / `upgrade-drill --apply` / `version-check` / `rollback-plan` | 四条全 exit 0；`version-check` `matched 750 / exact true / matches true` | `I\candidate-final8-{drill,upgrade,version,rollback}.log` |
| 桌面成品 | `node scripts/package-desktop.mjs I\candidate-final8-desktop` | 758 文件 / 2,919,650 B / `a2e7f2ee…`（重打同摘要） | `I\desktop-package-final8.log` |

后端串行全量（1455/1443/0/12）属于上一轮同一业务冻结点，本轮只改 `automation.ts` 的费用判据、测试与一处提示文案，按复核要求跑受影响专项；全量留给下一轮统一重跑，不在这里冒充新一轮数字。

## 5. 新候选

| 字段 | 值 |
|---|---|
| 目录 | `E:\javaproject\outputs\forward-delivery-20261107\I\candidate-final8` |
| 网关包 | `codex-workbuddy-gateway-v0.7.1.zip`，2,497,869 B，750 受管文件 |
| ZIP SHA-256 | `8ca1e7198d7bdd14c9bb2f92622e3f0250c587d19e7da8af64a500fe91ae9848` |
| manifest | 121,200 B / SHA-256 `9817c92fc0f76ece005c4643c5ca2a137c0e374f11090fb77ff511a2f61417cc` |
| 桌面包 | `workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip`，758 文件，2,919,650 B，SHA-256 `a2e7f2ee47119374937a5226371b537be7b2749ca11289c3c9581c22772a0ecf` |
| 桌面网关字节 | 与候选逐项相同 750/750，不同 0、缺 0 |

## 6. 仍未满足（不变）

真实派工、真实窗口、装到常驻根、自动 arming、异机、CI 远端、许可与发行 —— 仍全部需要 `EXTERNAL_CONDITIONS.md` 的 A 组条件；本轮把「装到常驻根」的命令链、参数与前置校验逐条核对到可执行状态，但没有执行安装。
