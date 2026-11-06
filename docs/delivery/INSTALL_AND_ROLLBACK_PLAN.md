# 安装与回退方案（RC6，只读准备）

目标：在你确认之前，把所有会改动磁盘的动作写清楚、给出可回退路径和验收命令。**本文不执行安装。**

## 1. 现在机器上有什么

| 位置 | 说明 | 关键指纹 |
| --- | --- | --- |
| `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1` | RC1 真实安装（含真实派工证据的那一套） | installedAt `2026-11-06T03:18:09.022Z`；snippetHash `abdcfc7a…785276`；dist 232 文件 / 1,871,096 B / sha256 `9f71b07a…c59dc4`；`.env` 六个键，`WORKBUDDY_DSH_ENABLED=1` |
| `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc2` | RC2 真实安装（最后一次真实安装） | installedAt `2026-11-06T08:23:09.782Z`；snippetHash `3657dcac…22e0f5`；dist 232 文件 / 1,871,598 B / sha256 `c8ff7add…9facde`；`WORKBUDDY_DSH_ENABLED=0` |
| `C:\Users\LENOVO\.codex\skills\workbuddy-executor` | 技能安装位（六文件） | `SKILL.md 5a485af7…`、`agents/openai.yaml 7e651486…`、`references/setup.md 3e0707d6…`、`execution.md e03936f0…`、`dispatch.md 5f0c13ac…`、`agent-hub.md 6f00bad7…` |
| `C:\Users\LENOVO\.codex\skill-backups\workbuddy-executor-I5FgPH` | RC1 安装时自动备份的旧技能目录 | 保留，不要删 |
| `C:\Users\LENOVO\.codex\config.toml` | 当前聊天 MCP 的注册与 env | 7451 B，本轮未被任何命令写入 |

RC6 候选（`codex-workbuddy-gateway-v0.7.1.zip`，696 文件 / `c9f724d4…`）**不是**可直接运行的安装：它不含 `node_modules`，也不含桌面运行时。所以「装 RC6」= 解包 + 装生产依赖 + `setup install/upgrade --apply`。

## 2. 装到哪里（三个候选，互斥）

| 方案 | 安装根 | 影响 | 代价 |
| --- | --- | --- | --- |
| A（推荐） | 新建 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc6` | 不动 RC1/RC2 与它们的库、状态、常驻服务；RC6 是独立安装 | 多一份约 8 MB 代码 + 94 个依赖包 |
| B | 覆盖 `gateway-v0.7.1-rc2`（就地升级） | 会替换 RC2 的 `dist`、`.env`、清单；RC2 库仍在但代码变了 | 需要先备份；RC2 的既有证据与「当时那套代码」的对应关系会变 |
| C | 覆盖 `gateway-v0.7.1-rc1` | 同上，但 RC1 是唯一有真实派工证据的安装 | 最不建议：会动到证据基线 |

`setup` 的行为边界（源码事实，`gateway/src/setup.ts`）：

- 只写安装根下的 `.env`、`data/deployment-installation.json`、`data/workbuddy-mcp.toml`，以及替换 `skills\workbuddy-executor`（旧目录先备份到 `~\.codex\skill-backups`）。
- **不写** `~\.codex\config.toml`；`mcpConfigModified` 恒为 false，只提示你手动合并。
- 已有安装且内容有变化时必须走 `upgrade --apply`，不会静默覆盖。

## 3. 安装步骤（方案 A，需你授权后执行）

```powershell
# 0) 前置：解包到全新目录（zip 自带顶层目录）
Expand-Archive -Path gateway\outputs\release\codex-workbuddy-gateway-v0.7.1.zip -DestinationPath E:\javaproject\workbuddy-install\gateway-v0.7.1-rc6
cd E:\javaproject\workbuddy-install\gateway-v0.7.1-rc6\codex-workbuddy-gateway-v0.7.1
cmd /c "npm ci --omit=dev --ignore-scripts"     # 94 个包；npm 不是 exe，必须走 cmd

# 1) 只读预检
node scripts\candidate-installation.mjs check   --package <zip> --expect-sha256 c9f724d4…
node scripts\candidate-installation.mjs preview --package <zip> --install-root <新根> --codex-home C:\Users\LENOVO\.codex

# 2) 演练（不碰真实 Codex 目录）
node scripts\candidate-installation.mjs drill         --package <zip> --drill-root <空目录> --apply
node scripts\candidate-installation.mjs upgrade-drill --package <zip> --drill-root <空目录> --apply

# 3) 真装（把 plan 落盘）
node scripts\setup.mjs install --apply --workbuddy-app "F:\新建文件夹 (2)\WorkBuddy\WorkBuddyAI.exe" --workbuddy-config "C:\Users\LENOVO\.workbuddy-ai"
```

安装后要手动补的一步：`.env` 里的 `WORKBUDDY_DSH_ENABLED`。RC6 的默认是 `1`（两端都可派），若这一轮只想走桌面队列，改成 `0`。

## 4. 装完必须核对的六项

1. `data\deployment-installation.json` 的 `installedAt`、`snippetHash`、六文件哈希与本包一致。
2. `data\workbuddy-mcp.toml` 指向新安装根的 `dist\server.js`；`~\.codex\config.toml` 未被改动（对比 mtime 与大小）。
3. `node dist\workbench-entry.js` 能起，`GET /workbench/v1/health` 200 且 `packageVersion 0.7.1`。
4. `node scripts\recovery-cli.mjs show <旧 operationId>` 在新根上仍可读旧库（只读，不关闭、不重派）。
5. 技能六文件哈希与包一致；旧目录备份存在。
6. 旧安装根的 `dist` 哈希未变（证明是新增而不是覆盖）。

## 5. 回退

演练已证明可回退（`rollback-plan`、`upgrade-drill` 的 17 步中 `rollback_applies`/`skill_restored_to_previous` 均通过）。RC6→RC5 的回退计划实测 `safeToApply:true`（`replace 62 / create 0 / remove 113 / keep 519 / blocked 0`）。

```powershell
node scripts\candidate-installation.mjs rollback-plan --package <RC6 zip> --to <上一版 zip> --install-root <安装根> --codex-home C:\Users\LENOVO\.codex
# 复核报告后，按报告里的 replace/remove/keep 清单执行
```

回退边界：

- 回退只还原代码、`.env`、清单与技能目录；**不回滚数据库**。RC6 装上去之后新写的任务不会因为回退消失，也不会变得可读——回退后仍用 RC6 的代码读它会出现 schema 或语义不匹配。
- 因此回退前必须记录：库文件大小与 sha256、在跑任务为空、容量占用是谁。
- 旧未知任务（RC1 库里的 `d1-workbuddy-2cc8e262-…`）在任何回退路径里都保持原身份，不被 close、不被重派。

## 6. 本方案明确不做的事

- 不删 RC1/RC2 的任何目录或备份。
- 不动 `~\.codex\config.toml` 的 MCP 注册（要换注册是另一个动作，见 `USER_CHOICES.md` D3）。
- 不停两个常驻服务（PID 21160 / 6092），它们与本次安装根无关，除非你选择改政策或换注册。
- 不在安装目录里热改代码：任何源码改动都要出新候选，再按上面流程装。
