# 集成运行手册（I 线）

目标：把 A/B/C/D 四条线合成一个**可复核的候选**，并把每一步的真实输出留成证据。不是发行流程。

## 0. 前置

```powershell
$I='E:\javaproject\workbuddy-forward-20261107\I-integration'
$E='E:\javaproject\outputs\forward-delivery-20261107'
cd $I; git status --porcelain   # 必须为空，否则先落盘
cd "$I\gateway"; npx tsc --noEmit -p tsconfig.json
```

依赖：四棵树 `gateway/node_modules` 均为指向起点树的目录联接；`gateway/dist` 可重建。

## 1. 合并顺序与理由

| 顺序 | 线 | 理由 |
|---|---|---|
| 1 | `feat/forward-runtime-readiness` (A) | 就绪诊断/桌面阶段/安装是其他线观测面的基础；改动含桌面 C# 与 `scripts/package.mjs` 白名单 |
| 2 | `feat/forward-product-workflow` (B) | 产品主流程读 A 的就绪与状态字段 |
| 3 | `feat/forward-observability` (C) | 统计/归因消费 A+B 产生的事件与视图 |
| 4 | `feat/forward-automation-readiness` (D) | 自动政策消费 C 的归因与 A 的就绪判定 |

每步：

```powershell
cd $I
git merge --no-ff <branch> -m "merge <line> into forward integration"
git status --porcelain
```

## 2. 冲突与归属裁决

1. 共享文件被我改过而行也改过 → 以**双线意图都保留**为目标手写合并；无法两者并存时按"共享文件由 I 独占"取 I 版本，并把行的语义在 `INTEGRATION_LOG.md` 里记为待办或已实现。
2. 冻结接口（`task-metrics.ts` 分组/字节、`INTERFACE_CONTRACT.md` 既有字段）不得因合并被改写。
3. 任何为通过而放宽验收门槛的改动（`not_applicable` 算通过、`unknown` 折算 passed、跳过 `verifyHashes`）一律拒绝并记录。
4. 行内新增测试与夹具保留原样；因合并失效的测试必须改到真正通过，不许 skip。

## 3. 每个检查点的验证门

```powershell
cd "$I\gateway"
npm run build
npx tsc --noEmit -p tsconfig.json
npm run typecheck:task-view
npx tsx --test test/**/*.test.ts      # 全量后端
npm run test:workbench                 # 139+ 项
npm run desktop:test                   # PolicyTests
```

记录：`tests / pass / fail / skipped` 四个数字 + 失败项名称与原因。**保留失败**，不为进度重跑掩盖。

检查点 1（A+B）与检查点 2（C+D）各记录一份，比较失败集合是否只减不增。

## 4. 候选生成

```powershell
cd "$I\gateway"
npm run package                        # 产出 zip + sha256 + manifest
node scripts/verify-release.mjs <zip>  # hashesMatch
node scripts/candidate-installation.mjs  # 隔离安装根演练
npm run doctor
```

记录：ZIP 路径/字节数/受管文件数/ZIP SHA-256/manifest SHA-256；安装根路径；`doctor` 的 `codeHash`。

**不做**：在起点安装根 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc2` 上热修；不推送；不合 main。

## 5. 收尾

1. `ACCEPTANCE_53_FORWARD.md`：53 项逐项挂本轮证据与等级，未测的写未测及原因。
2. `TASK_LEDGER_31_FORWARD.md`：31 任务逐项四列（已有基础 / 本轮剩余 / 本轮实际 / 等级）。
3. `FORWARD_RECEIPT.md`：按计划包 `10` 的字段。
4. 证据根 `RESUME.md` 回填，`EXTERNAL_CONDITIONS.md` 复核是否仍准确。

## 6. 反例（本轮明确禁止）

- 把 `synthetic` 结果写成"真实可用"。
- 用"文档已更新"代替代码缺口。
- 为凑绿把失败的测试改成 skip 或放宽断言。
- 在未获授权时派真实模型任务、装候选、改 MCP 服务、推送。
