# 检查点 1 — A 线合入与只读诊断出口

本文件只记录**已经跑过并留存输出**的事实。没有跑过的，写"未跑"，不写推测。所有命令都在集成树
`E:\javaproject\workbuddy-forward-20261107\I-integration` 的 `gateway` 目录下执行。

## 1. 合入内容

| 项 | 值 |
| --- | --- |
| 合并提交 | `b56f91b merge: A-runtime readiness and desktop startup stages (checkpoint 1)` |
| 来源分支 | `feat/forward-runtime-readiness`（HEAD `0f0a263`） |
| 合入文件 | `gateway/desktop/Program.cs`、`gateway/desktop/StartupProgress.cs`、`gateway/desktop/test/Program.cs`、`gateway/desktop/test/PolicyTests.csproj`、`gateway/src/readiness.ts`、`gateway/scripts/readiness.mjs`、`gateway/test/readiness.test.ts`、`gateway/scripts/package.mjs`（+1/-1 白名单）、`gateway/test/package.test.ts`（+1/-1 计数） |
| 冲突 | 无 |
| 共享文件越界 | 仅 `package.mjs` / `package.test.ts` 各 1 行白名单增补（`StartupProgress.cs`），已核对语义并在本检查点接受 |

## 2. 本检查点新增的接线（I 线）

`02e7de8 feat(workbench): serve the five-layer readiness diagnosis over read-only HTTP`

- `gateway/src/workbench-http.ts`：新增 `readiness?: { observe: () => Promise<unknown> }` 适配器选项；新增只读路由 `GET /workbench/v1/readiness`；把它加进"已知只读路径"集合，因此 `POST` 得到 405 而不是 404；拒绝任何查询参数（400 `INVALID_READINESS_QUERY`）；观测抛错时返回 503 `READINESS_UNAVAILABLE`，**不回放上一次结论**。
- `gateway/src/workbench-entry.ts`：`readiness: { observe: () => observeReadiness({ config }) }`。每次 GET 重新观测；不准备模型、不开会话、不写配置文件。
- A01 的 `observeReadiness` 对无法解析的配置返回 `selection.state="ambiguous"` 并列出候选路径；HTTP 侧只透传，不修补。

## 3. 验证（本轮真实输出）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `npx tsc --noEmit -p tsconfig.json` | 干净（无输出） |
| 就绪诊断 | `npx tsx --test test/readiness.test.ts` | 27 tests / 27 pass / 0 fail（3107ms） |
| 就绪路由 | `npx tsx --test test/workbench-readiness-route.test.ts` | 4 tests / 4 pass / 0 fail（1783ms） |
| 配置歧义 | `npx tsx --test test/config-ambiguity.test.ts` | 4 tests / 4 pass / 0 fail（384ms） |
| 调用事实 | `npx tsx --test test/check-call-events.test.ts` | 5 tests / 5 pass / 0 fail |

固定环境说明：以上与全量套件都要求 `$env:WORKBUDDY_CONFIG_DIR='C:\Users\LENOVO\.workbuddy-ai'`；不固定时本机会因两套布局并存而拒绝启动（见 `ENV_FINDINGS.md` E1）。任何"N pass / 0 fail"的记录都必须同时写明这一点。

## 4. 候选流水线在集成树的试跑（中间产物，不是最终候选）

顺序：`npm run build` → `npm run package` → 解压 → `node scripts/verify-release.mjs` → `node scripts/candidate-installation.mjs check`。

| 项 | 值 |
| --- | --- |
| 归档 | `gateway/outputs/release/codex-workbuddy-gateway-v0.7.1.zip` |
| 字节 | 2,266,059 |
| 受管文件 | 698 |
| ZIP SHA-256 | `1209086ae8e6fb40fc3f83d70cacc450a6bb604d60dcad3b781aa601f2d4a13f` |
| 包内解压总字节 | 7,378,696 |
| `verify-release` | `{"version":"0.7.1","verifiedFiles":698,"hashesMatch":true}` |
| `candidate-installation check` | `"ok": true`，`"problems": []` |

**这不是候选交付物**：它只含 I 线两个提交与 A 线两个提交，B/C/D 尚未合入。最终候选在四点全部合入、全量套件重跑后再生成一次，并重新记录上表。

两个前置教训（已写进 `INTEGRATION_RUNBOOK.md`）：

1. `npm run package` 会先检查 `dist` 是否比 `src` 新，未 `npm run build` 时直接失败（`scripts/package.mjs:125`）。顺序必须是 build → package。
2. 打包会检查"私有机器路径"（`scripts/package.mjs:185` `assertSafeContent`）。我最初的测试夹具写了 `C:\Users\x\`，被打包拦下。规则只接受 `example` / `YOUR_NAME` / `Public` / `<...>` 这类占位名，已改为 `C:\Users\example\`。这条守卫是有效的，不改它。

## 5. 本检查点仍未满足的（不许写进"已完成"）

- **启动阶段的可诊断性只到管道层**：`scripts/readiness.mjs` 与 HTTP 路由都能报出 `startup.outcome/awaitingStage/awaitingMs`，但桌面壳本身卡在 WebView 初始化时，宿主进程之外的失败点仍无观测（A02 只覆盖到 `navigation` 阶段）。真实窗口是否 ready 未在本轮验证。
- **配置无法解析时进程仍会退出**：`workbench-entry.ts` 顶层 `loadConfig()` 抛错即退出，因此"配置歧义"时没有 HTTP 表面可以承载诊断（CLI 可以）。这是下一步要接的（需要一个不依赖 `TaskApplicationService` 的降级表面），本轮未做。
- **B/C/D 未合入**，因此 53 项场景与 31 项任务台账在本检查点不更新。
