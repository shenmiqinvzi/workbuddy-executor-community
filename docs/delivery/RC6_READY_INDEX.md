# RC6 真实验收入口（只读准备，2026-11-06）

本文件是真实验收这一轮的入口：先读它，再按需打开下面七份准备文档。它不改变任何既有结论，也不把「已准备」写成「已验收」。

## 1. 基线与对象

| 项 | 值 |
| --- | --- |
| 仓库 / 工作树 | `E:\javaproject\workbuddy-finish\R-review-fixes` |
| 分支 | `fix/delivery-review-r1-r4` |
| 业务基线 | `8afd839b770fc2e57910fc8882cc3fb6bd08f7c4`（tree `f667a8186edc16ddc146fb5e65e54c7fd1b517d9`） |
| 本轮文档增量 | 见外部回执 `outputs\finish-integration-20261105\closeout\RC6_LIVE_READY_RECEIPT.md`（提交哈希写在那里，避免自引用） |
| 候选 | RC6，`gateway\outputs\release\codex-workbuddy-gateway-v0.7.1.zip` |
| 包 SHA-256 | `c9f724d4888da5ed2566b464c4b85745693d7dd3b600fed1f622b8f3a10338ff`（696 个受管文件 / 2,257,997 B） |
| manifest SHA-256 | `49a0656c26d54ff65b470d14a75f629481b19f4e869df370c2e205c79b84f5f4`（112,259 B） |
| 解包目录 | `E:\javaproject\outputs\finish-integration-20261105\closeout\candidate-rc6\codex-workbuddy-gateway-v0.7.1` |
| 源码验证 | 1301 tests / 1289 pass / 0 fail / 12 skipped（`closeout\logs\full-test-rc6b.log`）；专项、workbench 139/139、desktop 92/92 |
| 真实环境状态 | **RC6 未安装、未派工、未推送、未发布**；最后一次真实安装是 RC2，最后一次真实派工是 RC2 的 `rc2-live-20261106b`（未 accepted） |

## 2. 只读复验（不改任何产物）

```powershell
cd E:\javaproject\workbuddy-finish\R-review-fixes
git rev-parse HEAD                  # 应为本轮文档增量提交（基线 8afd839… 的后续）
git status --porcelain              # 应为 0 行
Get-FileHash gateway\outputs\release\codex-workbuddy-gateway-v0.7.1.zip -Algorithm SHA256
Get-FileHash gateway\outputs\release\codex-workbuddy-gateway-v0.7.1.manifest.json -Algorithm SHA256
cd E:\javaproject\workbuddy-finish\R-review-fixes\gateway; npx tsc --noEmit -p tsconfig.json
cd E:\javaproject\outputs\finish-integration-20261105\closeout\candidate-rc6\codex-workbuddy-gateway-v0.7.1
node scripts\verify-release.mjs     # 预期 {"verifiedFiles":696,"hashesMatch":true}
```

预期值：zip `c9f724d4…`、manifest `49a0656c…`、`hashesMatch:true`。上面五条都不会重写 `gateway/dist` 或 `outputs/release`。

> 纠偏（2026-11-06）：上一版这里写的是 `cd ..\outputs\...`，从 `gateway` 往上只会到 `R-review-fixes\outputs`，该目录不存在。所有涉及 external outputs 的路径一律写绝对路径，不要用相对跳转。

## 3. 重建（会覆盖 dist 与发布目录，属于新对象）

**注意**：RC6 冻结后不要再重建同一路径的包并把结论挂回 RC6。若确需重建，先把旧产物移走，重建结果是新候选，必须重跑解包自检与探针。

```powershell
cd E:\javaproject\workbuddy-finish\R-review-fixes\gateway
npm run build
npm run typecheck:task-view
# 先把 outputs\release 下旧产物移出，否则打包器拒绝覆盖
node scripts\package.mjs
node scripts\generate-snapshot-manifest.mjs
node scripts\verify-snapshot.mjs
```

`package.mjs` 现在带构建新鲜度守卫：`src` 里最新的 `.ts` 比 `dist` 最旧的 `.js|.d.ts` 新超过 2 秒会直接拒绝打包（`dist is older than src; run npm run build before packaging.`）。

## 4. 本轮准备文档

| 文档 | 回答什么 |
| --- | --- |
| `INSTALL_AND_ROLLBACK_PLAN.md` | 装到哪、装了什么、怎么退、退到哪里、装完怎么验 |
| `CAPACITY_AND_IDENTITY.md` | 三个库各自的容量占用、为什么不能自动清、身份与不重叠规则 |
| `LIVE_TASK_PROPOSALS.md` | 两台执行器各一条真实样本的完整契约、验收命令与判定标准 |
| `USER_CHOICES.md` | 需要你拍板的事项，一张表，逐项标「不选会怎样」 |
| `UI_AND_SECOND_MACHINE_PLAN.md` | 正式桌面壳的实测结果、窗口证据怎么补、第二台机怎么做 |
| `EXTERNAL_DECISIONS.md` | 既有七项外部决策（D1–D7），本轮未改口径 |
| `F_CONTRACT_1.md` | 未声明写范围时为何只读，以及 B/C 两个需要你选的方案 |

## 5. 边界（本轮同样适用）

- 不推送、不合 main、不发布、不部署；不登录真实账号；不真实派工（除非你在 `USER_CHOICES.md` 上逐项选定并授权）。
- 不修改生产政策、不释放旧未知占用、不换库、不换身份、不用第二台机绕开原占用。
- 不重开八条功能线，不覆盖 RC6 事实。
