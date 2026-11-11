# 交付报告 · 2026-11-11（本轮收口）

对象：`workbuddy-executor`（技能 + 网关 + 桌面）按 `E:\javaproject\workbuddy-product-plan-20261110` 规划包推进的结果。
工作树：`E:\javaproject\workbuddy-forward-20261107\R-executor-plan-20261111`，分支 `feat/executor-plan-20261111`，基线 `0919201`，**未提交、未推送**。

## 1. 一句话结论

规划包 44 张卡里，**26 张做到源码级完成（done_source）、3 张此前已完成（done）、15 张因缺外部条件挂起（blocked_external）、0 张停留在 planned**；
后端 1563 例 0 失败、工作台 169/169、桌面策略 133 通过；配对包与冻结清单已生成并可逐字节重建；
本机还完成了一次隔离安装演练（installed 证据）与真实窗口启动（window 部分证据，面板未渲染）。
**仍不宣称**：任务面板实窗渲染、真实模型派工与费用、第二台机、CI 回执、发行签名。

## 2. 本轮真正改了什么（按缺陷 → 修复）

| 缺陷 | 修法 | 证据 |
| --- | --- | --- |
| FIX01 裸命令能派出去 | 新增 `src/command-spec.ts`（五键解析 + 位置/原因/示例），在 legacy send、contract check、continue 三条路径**早于原生准备**拒绝；MCP 描述与三份技能文档同步 | `test/command-spec.test.ts` 7/7；`suite-wb38` 全绿 |
| FIX04 Job 两例 125 | `bounded-job.ps1` 加阶段标记 + 按 SHA256 缓存编译产物；`bounded-command.ts` 拆三阶段预算（`failure.phase`） | `test/bounded-command.test.ts` 9/9 |
| FIX06 readiness 缺探针 | `readiness.ts` 加 `observer`（origin/pid/dataRoot/探针是否注入）+ 异库/旧摘要判定；新增 `readiness-probes.ts` 真拉 `dist/server.js` 调 `workbuddy_health` | `readiness.test.ts`+`desktop-host-wiring` 41/41；`readiness-probe-live.test.ts` 2/2 |
| FIX05 技能三份漂移 | `scripts/sync-skill.mjs`（`skill:check`/`skill:sync`）+ 文档去机器绑定路径；安装演练中再修 DSH 派生变体的比对源 | `skill-sync.test.ts` 8/8；`skill-copies.test.ts`；`wb38-skill-check2.json` exit 0 |
| 派工后 30 秒锁超时 | 新增 `sqlite-busy.ts`，四处写入连接统一可配置等待预算（默认 15s） | `sqlite-busy.test.ts` 2/2；`suite-freeze.log` 1 失败 → `suite-freeze2.log` 0 失败 |
| FIX08/09 验收语义漂移 | `ACCEPTANCE_MATRIX.md` 53 项按原文恢复（F06 原生等待、F14 内容安全）+ `check-acceptance-matrix.mjs` 机器校验 | `acceptance:check` 通过；负例 4 个 |
| 详情/拒绝不可操作 | 六条拒绝各带具体下一步（含 `displayState`、可用操作、「不会因超时放行」） | `action-refusals.test.ts` + `desktop-control.test.ts` 6/6 |

## 3. 指标

| 项 | 值 |
| --- | --- |
| 后端套件 | **1563 tests / 1551 pass / 0 fail / 12 skip**（408.7s，`suite-wb38.log`） |
| 工作台前端 | 169 / 169 |
| 桌面策略（dotnet） | 133 pass / 0 fail / 1 skip（symlink 权限） |
| 验收矩阵 | 53 项齐全，31 项原任务全覆盖 |
| 快照清单 | 464 文件，`verify-snapshot.mjs` exit 0 |
| 改动规模 | 77 条路径；新增源/脚本 6 个、新增测试 10 个路径、文档 21 份（另有 1 份第三方清单 JSON） |
| 配对包 | 网关 `f160410a…`（2604199 B）/ 桌面 `a9fd2342…`（3031998 B）/ 共用 782 文件逐字节相同 |

12 条 skip 全部有归类：6 条 POSIX-only（Unix socket、`*.sock` 隐私、`sh` 启动器）、6 条 macOS 生命周期；Windows 侧替代证据为命名管道 ACL 用例与 `.cmd` 启动器用例。

## 4. 本机安装与窗口实测（installed / window 部分）

| 步骤 | 结果 | 证据 |
| --- | --- | --- |
| 解包到隔离根 `gateway-v0.7.1-plan20261111` | exit 0 | — |
| `bootstrap --apply` | `ok npm_ci: npm.cmd ci --omit=dev (4235ms)` | `wb38-*` |
| `init-state` | 建库 249856 B / 25 表 | `wb35-init-state.log` |
| `doctor` / `deployment-check` | 均 exit 0（`localSetupReady:true`、`codeHash 96f8cfe6…`） | `wb38-doctor3.log`、`wb38-deployment-check.log` |
| `readiness --json` | `toolResponsive ready`、`nativeOnline blocked`、其余 unknown/absent | `wb38-readiness.json` |
| 技能落位 + 三处同步 | codex 安装成功（含备份）、dsh unchanged、`inSync true` | `wb38-skill-check2.json` |
| 桌面壳窗口 | 真实窗口 853x573、标题 `WorkBuddy · 任务工作台`、分阶段真实文案；`controller` 阶段 `COMException` | `wb35-status8.log`、`wb35-desktop-printwindow.png` |

结论：安装链路与窗口启动链路的失败都是**可解释的阶段性失败**，不是白屏或静默退出；
但面板本体未渲染（本会话拿不到 WebView2 控制器），因此 window 只记部分证据。
详见 [WB35_WB38_INSTALLED_AND_WINDOW.md](WB35_WB38_INSTALLED_AND_WINDOW.md)。

### 4.1 真实原生派工（live 部分，2026-11-11 下午）

用户选定 `glm-5.3-flash`（x0.08 credits，金额 unknown）后，对真实 WorkBuddy 桌面端跑了 7 次派工（6 个任务、1 条 3 轮返工链）：

| 事实 | 证据 |
| --- | --- |
| 真实产出 `RESULT.md=SUM=7`、`RESULT.md=SUM=11`＋`CHECKED=yes` | `live-workspace*/`、`live-send.log` |
| 模型自述「已跑验收命令 exit 0」不算数，`check_task` 判 `unknown` | `live-check.log` |
| 独立执行 `run_review_command` → `exitCode 0 / cleanupConfirmed true` | `live-runcheck.log` |
| 返工新增 `PROOF.txt` 被 `$scope` 判 unauthorized | `live-check2.log` |
| 单槽：前任务未关时 `CAPACITY_OCCUPIED` | `live-send2.log` |
| 旧 revision → `STALE_REVISION`；观测后改文件 → `Source changed…` | `live-check2/3/4.log` |
| 429 / 代理 502 / 无报告 → 三种都 `blocked` 且 `No automatic resend` | `live-w3-*`、`live-w5-*`、`live-w7-*` |
| 取消写入 cancellation 并只对本 task/attempt/session 发原生取消 | `live-cancel7.log` |

**没有一次走到 `accept_task`**：本机系统代理 `127.0.0.1:7890` 在上游模型流上间歇返回 502（`socket hang up`），provider 侧同时给 429。这是环境条件，不是源码缺陷；网络恢复后按 [WB35_LIVE_NATIVE_RUN.md](WB35_LIVE_NATIVE_RUN.md) 第 5 节可原样复跑。

## 5. 交付物

**源码（gateway）**：`src/command-spec.ts`、`src/readiness-probes.ts`、`src/sqlite-busy.ts`、`scripts/sync-skill.mjs`、`scripts/check-acceptance-matrix.mjs`、`scripts/verify-pairing.mjs`；改 `bounded-command.ts`/`bounded-job.ps1`/`coordinator.ts`/`deepseek-coordinator.ts`/`readiness.ts`/`service-cli.ts`/`desktop-control*.ts`/`task-store.ts`/`workspace-protection.ts`/`workspace-workers.ts` 等；`package.json` 增 `skill:check`/`skill:sync`/`acceptance:check`/`release:pairing`/`release:candidate`。

**测试**：`command-spec`、`acceptance-matrix`、`skill-sync`、`automation-modes`、`action-refusals`、`sqlite-busy`、`release-pairing`、`executor-modes-consistency`、`readiness-probe-live`，以及 `recommendation-view` 新增 4 例、`native-desktop-trigger` 新增四类归属样本。

**文档（docs/forward）**：`ACCEPTANCE_MATRIX.md`、`ADR-01_AUTOMATION_MODES.md`、`SCENARIO_INDEX.md`、`WB04_NATIVE_STOP_OWNERSHIP.md`、`WB06_READINESS_FACTS.md`、`WB07_SKILL_SINGLE_SOURCE.md`、`WB09_RECOVERY_MATRIX.md`、`WB10_WB12_SELECTION_MODES.md`、`WB11_PLAN_ONCE_CONSUMPTION.md`、`WB13_DETAIL_AND_REVIEW_PATH.md`、`WB16_WB25_RESOURCE_USAGE_STATISTICS.md`、`WB26_WB31_AUTOMATION_NOTIFY_EXPORT.md`、`WB32_WB33_FAULT_AND_SECURITY.md`、`WB35_WB38_INSTALLED_AND_WINDOW.md`、`WB36_FREEZE_CANDIDATE.md`、`WB37_PAIRED_RELEASE.md`、`WB40_USER_AND_MAINTAINER_MANUAL.md`、`WB41_LICENSES_AND_SIGNING.md` + `WB41_THIRD_PARTY_INVENTORY.json`、`WB42_CI_READINESS.md`、`WB43_TOTAL_ACCEPTANCE.md`。

**产物**：`outputs\executor-plan-20261111\release-wb38\`（网关/桌面/两个技能包 + 清单 + `.sha256`）、`final-state.json`、`suite-wb38.log` 等 30+ 份证据。

## 6. 未做与原因（不改判）

| 卡 | 缺什么 |
| --- | --- |
| WB08 / WB38 | 升级/回退/卸载演练与切换运行安装 `gateway-v0.7.1-final2` 的写入授权（隔离根演练已完成） |
| WB14 / WB34 / WB35 | 能创建 WebView2 控制器的会话 + 真实派工（模型选择、费用确认、原生会话） |
| WB15 / WB26 / WB29 | DSH 真实链路、自动模式第二层的用户规则调整授权 |
| WB16 / WB19 / WB20 | 用户可访问的真实只读来源与上游用量接口 |
| WB39 | 第二台 Windows 物理机 |
| WB41 | 许可证选择（权利人）+ 代码签名证书 |
| WB42 / WB43 | 远端 CI 回执（需 push + 一次成功运行）、发行授权 |

## 7. 若要继续，最小动作

1. 明确是否允许改写运行安装并切换常驻服务 → WB38 补齐升级/回退/卸载。
2. 换一台能起 WebView2 控制器的会话跑一次主路径（选择→预览→派工→停止→返工→审查→验收）→ 补齐 window/live。
3. 授权 push → 触发 `forward-gate` 与 `release-pairing` → 补 ci 回执。
4. 权利人定许可证 + 证书 → WB41 收口。
