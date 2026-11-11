# WB07 技能单一来源、生成与安装漂移检测

## 1. 唯一源与生成物

| 角色 | 路径 | 谁写 |
| --- | --- | --- |
| 唯一源（人工编辑） | 仓库根 `SKILL.md`、`agents/openai.yaml`、`references/{setup,execution,dispatch,agent-hub}.md` | 人 |
| 网关副本（生成） | `gateway/skills/workbuddy-executor/` 同名六文件 | `node gateway/scripts/sync-skill.mjs --write` |
| 发布 ZIP（生成） | `gateway/scripts/package.mjs` 打 `workbuddy-executor-v<version>.zip` | 打包脚本，源为上面的网关副本 |
| 安装位（需授权） | `<CODEX_HOME>/skills/workbuddy-executor`（及 `deepseek-executor`） | `install-skill.mjs` / `install-deepseek-skill.mjs`，先备份再原子替换 |

`sync-skill.mjs --write` 只改网关副本，逐文件比较 sha256，只重写内容不同的文件（实测本次只写了 `SKILL.md`、`references/dispatch.md` 两个）。它从不写安装位：安装涉及用户机器上的既有文件与备份，必须走安装脚本。

## 2. 自动核对

```text
npm run skill:check          # = node scripts/sync-skill.mjs --check
npm run skill:check -- --json
npm run skill:sync           # = node scripts/sync-skill.mjs --write
```

`--check` 输出四个位置的状态与逐文件漂移，任一处不一致即 exit 1，并直接给出修复命令与备份路径：

```text
source  <repo>
bundled in sync <repo>/gateway/skills/workbuddy-executor
codex   DRIFT   C:\Users\<user>\.codex\skills\workbuddy-executor  (SKILL.md, references/setup.md, references/dispatch.md)
dsh     DRIFT   C:\Users\<user>\.codex\skills\deepseek-executor   (SKILL.md, references/setup.md)
fix     codex: node gateway/scripts/install-skill.mjs
fix     dsh:   node gateway/scripts/install-deepseek-skill.mjs
```

`gateway/test/skill-sync.test.ts` 覆盖：同源即 in sync、改一个字节即 drift、缺文件报 missing、更新计划包含生成器与安装脚本及 `skill-backups/` 备份路径、生成器只重写有差异的文件、仓库自身 `--check` 报 bundled in sync。

## 3. 本机实测漂移（只读观察，2026-11-11）

证据：`outputs/executor-plan-20261111/wb07-skill-drift.json`（`--check --json` 原始输出）。

- `bundled`：与根六文件一致（本轮已用生成器重建）。
- `codex` 安装位：`SKILL.md`、`references/setup.md`、`references/dispatch.md` 与源不一致——正是 FIX05 描述的安装漂移，含本轮 CommandSpec 新语义未进入安装位。
- `dsh` 安装位（`deepseek-executor`）：`SKILL.md`、`references/setup.md` 与源不一致。

本工作树没有写这两个安装位：改动安装位属于已授权安装流程（WB38/WB35），本会话只做源码级核对与报告。

## 4. 更新与回退

1. 改根六文件 → `npm run skill:check` 看 bundled 漂移 → `npm run skill:sync`。
2. 打包：`node scripts/package.mjs`（ZIP 里的技能即刚生成的副本，哈希见包内 `SNAPSHOT_MANIFEST.json`）。
3. 安装（需授权）：`node scripts/install-skill.mjs`。脚本会先把旧目录整体移到 `<CODEX_HOME>/skill-backups/workbuddy-executor-<随机>`，再 `rename` 暂存目录就位；失败时把备份移回原位并报错。相同内容时输出 `unchanged:true` 且不碰安装位。
4. 回退：把备份目录移回 `<CODEX_HOME>/skills/workbuddy-executor`（脚本输出的 `backup` 字段就是它），再 `npm run skill:check` 确认回到旧哈希。

## 5. 技能内容修订（本轮）

- 示例不再绑定 `F:/node.exe`，改为 `<node>` 占位符 + 「用 `node -p process.execPath` 替换」；`<工作区绝对路径>` 同理。留占位符发出去会被 parser 判 `COMMAND_SPEC_PATH`/`COMMAND_SPEC_REQUIRED`，不会执行。
- 明确只读形态：示例命令只读一个结果文件、不写盘、不联网；要跑测试/生成产物时写盘限定在工作区内，并把读取的文件全部列进 `inputs`。
- 补「命令执行 → 检查批次 → inspection → review → accept」的 revision 变化表（`references/dispatch.md`）：定检查项改 revision，跑命令/记检查/出审查都不改，`accept_task` 只认当前 revision/attempt 的 reviewId；revision 或 attempt 一变，旧 review 与命令记录即失效。
- 示例经 parser 实测：`gateway/test/skill-sync.test.ts` 从 SKILL.md 与 dispatch.md（含网关副本）抽出 JSON 示例，断言「未替换占位符必被拒」「替换后必通过」。

## 6. 未覆盖

- 真正把新技能写进 Codex/DSH 安装位需要用户在真机上授权执行安装脚本；本文件只给差异与回退办法。
- 安装后的「读取的技能与包相同」需要在安装机运行 `sync-skill.mjs --check` 复核（预期 `codex ... in sync`），属 WB38 的安装验收记录。
