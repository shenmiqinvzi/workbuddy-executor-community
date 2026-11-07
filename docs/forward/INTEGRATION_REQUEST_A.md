# A 线集成请求（forward-delivery-20261107）

本文件只列**需要 I 接线或需要 I 决定共享文件**的项。A 线自己的代码已经提交在 `feat/forward-runtime-readiness`（见 `A_LINE_RECEIPT.md` 第 1 节），下面每项都写：接口/字段/版本、触发位置、失败与缺失语义、最小验证。

归属约束：`gateway/package.json`、`gateway/test/package.test.ts`、`gateway/scripts/package.mjs` 的**后续**改动都经这份文件提，A 线不再直接改。

---

## IR-A1（需 I 确认接受）：`11d96a5` 里 2 行打包白名单

- **内容**：`gateway/scripts/package.mjs` 的 `DESKTOP_FILES` 加 `"StartupProgress.cs"`；`gateway/test/package.test.ts:100` 的同一份文件列表加同名项。这正是 A02 新增 `gateway/desktop/StartupProgress.cs` 的必要同步，否则打包白名单与夹具会漂移。
- **触发位置**：`node scripts/package.mjs` 与 `npx tsx --test test/package.test.ts`。
- **失败与缺失语义**：漏加 → 打包产物缺文件、`package.test.ts` 断言文件清单时失败；已加 → 两侧一致。
- **最小验证**：`cd gateway; npx tsx --test test/package.test.ts` → 13/13 pass（已由 A 线跑过）。

## IR-A2（需 I 改 `gateway/package.json`）：两个脚本别名

`gateway/package.json` 属 I 独占，A 线没有加 `scripts` 条目。请在 `scripts` 里补：

```json
"readiness": "node scripts/readiness.mjs",
"bootstrap": "node scripts/bootstrap.mjs"
```

- **接口**：`npm run readiness [-- --json]`；`npm run bootstrap -- --install-root <dir> [--apply] [--timeout-ms N] [--report <file>]`。
- **触发位置**：用户文档里的「先诊断、再安装」两条命令。
- **失败与缺失语义**：`readiness` 退出码 = 五层全 `ready` ? 0 : 1（未全 ready 是**正常结论**，不是崩溃）；`bootstrap` 未给 `--install-root` 时以 usage 错误退出，给 `--apply` 才会写文件。没有别名时用户只能记住 `node scripts/*.mjs`，文档里的 `npm run` 路径就是空的。
- **最小验证**：`cd gateway; npm run readiness -- --json | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))"`（能解析即脚本可用）；`npm run bootstrap -- --help`。

## IR-A3（需 I 决定是否加进包）：`scripts/bootstrap.mjs`、`scripts/readiness.mjs` 的入包

- **现状**：`scripts/package.mjs` 的受管文件清单决定候选包里有什么；两个新脚本目前**不在**包里。候选包体检口径是 696 文件，加脚本会改变 `SNAPSHOT_MANIFEST.json` 与文件数，属 I 的发布口径。
- **接口**：脚本本身只依赖 `dist/`（`readiness.mjs` → `dist/readiness.js`，`bootstrap.mjs` → `dist/installation-bootstrap.js`，两者都不存在时 `bootstrap.mjs` 有内联首跑路径）。
- **失败与缺失语义**：脚本入包但 `dist` 缺对应模块 → `readiness.mjs` 抛模块缺失（明确）；若只入 `bootstrap.mjs` 而缺 planner，则退化为内联 `npm ci` + `npm run build`，报告只有 step 级信息、没有 `diagnosis.gaps` 合并。
- **最小验证**：把两脚本加进清单后 `node scripts/package.mjs` → 解包目录里存在 `scripts/readiness.mjs`、`scripts/bootstrap.mjs`，且 `node scripts/verify-release.mjs` 的 `hashesMatch: true`。A 线未改发布口径，等你决定。

## IR-A4（需 I 接线）：把五层就绪报告挂到服务端只读入口

- **API**（`gateway/src/readiness.ts`，`READINESS_SCHEMA = "workbuddy-readiness/v1"`）：

  ```ts
  observeReadiness(options: ReadinessOptions): Promise<ReadinessReport>
  describeReadiness(report): string[]          // 一行一层，给人读
  ```
  `ReadinessReport = { schema, readOnly: true, observedAt, selection, layers[5], nextAction, notes }`；
  每层 `{ layer: "toolResponsive"|"nativeOnline"|"projectSessionDispatchable"|"candidateDeployed"|"desktopPageReady", question, state: "ready"|"unverified"|"blocked"|"absent"|"unknown", observedAt, facts, missing[], reason? }`；
  `selection = { state: "resolved"|"ambiguous"|"missing", backend, config:{state,candidates[]}, executable:{state,candidates[]}, suggested[] }`；
  `nextAction = { layer, action } | null`（唯一一条）。
- **触发位置**（建议）：`gateway/src/server.ts` 或 `workbench-http.ts` 的只读 GET（例如 `/workbench/readiness`）以及现有 `doctor` 的人类可读输出；不要放进会写库的路径。
- **只读契约（必须保持）**：不准备模型、不启动/重启服务、不改会话、不写配置文件、不建库；库一律 `DatabaseSync({readOnly:true})`；桌面快照只读命名管道 `WorkBuddy.Workbench.<instanceKey>`（请求 `{taskId:null,status:true}`）。
- **失败与缺失语义**：
  - 缺运行摘要（`data/persistent-service-status.json` 缺失 / `pid` 非正整数 / `codeHash` 非 64 hex）→ 该层 `unknown` + `missing:["runtime_summary"]`；**不得**回退成磁盘 `package.json` 的 `packageVersion`（磁盘版本只作为展示字段）。
  - 配置无法解析（E1 歧义、`executable` 缺失）→ `selection.state !== "resolved"`，`nextAction.layer = "selection"`，下游层 `unknown` 且 `missing` 指出缺哪一层；HTTP 层应返回 200 + 报告，不要把 `loadConfig()` 的异常变成 500。
  - `workflow_capacity` 表缺失 → 该层 `blocked`（不是 `free`）；有占用 → `blocked`，reason 里带「never treated as free」。
  - `sessions` 读不到 → `unknown`（不是「0 个会话」）。
  - 桌面壳没有 `startup` 子对象 → `blocked` + `missing:["startup_diagnostics"]`（提示需要新版壳）。
- **最小验证**：`npx tsx --test test/readiness.test.ts`（27 项覆盖上述每个语义）；接好端点后 `curl http://127.0.0.1:<port>/workbench/readiness` 返回 `schema` 与五个 `layer`，并确认调用前后 `data/` 目录文件列表不变。

## IR-A5（需 I 接线）：`needs_review`/`blocked` 之外的新增降级消息

- **API**（`gateway/src/run-journal.ts`）：
  ```ts
  class UnreadableJournalError extends Error { attemptId: string; file: string; cause: unknown }
  // DurableRuns.messages() 捕获它，返回单条记录：
  // message_id: `${attemptId}:unreadable`
  // metadata: { source: "unreadable-journal", type: "result", status: "blocked",
  //             blockedReason: "journal_unreadable", attemptId, file }
  ```
- **触发位置**：`server.ts` / `workbench-entry.ts` 里把 `messages()` 结果映射成 UI 记录的层（`app.mjs` 的渲染）。
- **失败与缺失语义**：这条记录表示「journal 存在但读不动」，**不是**「任务不存在」，也**不是**可重试失败：UI 不要提供「重发/重试/关闭」按钮，只显示原因与文件路径；服务端不得因为这条记录去 `cancel()`/`close()`/重新 `claim()`（这些调用本身会抛 `UnreadableJournalError`）。`messages()` 对「attempt 不存在」仍抛 `not found; refusing`，两者不要合并。
- **最小验证**：`npx tsx --test test/run-journal.test.ts` → 含 `a damaged journal is reported as unreadable, never read as absent`（断言消息文本、`source`、`status`、文件字节未变、没建 `cancel.json`）；接线后把某 attempt 的 `state.json` 手动写坏，页面应显示一条 blocked 记录而不是整页报错。

## IR-A6（需 I 接线）：`respond()` 的重复回答错误文案

- **接口**：`RunJournal.respond()` 在目标 `input-<key>.json` 已存在时抛
  `This WorkBuddy input request (<key 前 8 位>) was already answered; the first answer is kept and was not overwritten`。
- **触发位置**：MCP/HTTP 层把回答转发给 `respond()` 的位置。
- **失败与缺失语义**：这是**幂等拒绝**，不是内部错误：映射成 409 + 该文案，保持第一次答案；不要重试、不要覆盖、不要把用户第二次点击当成第一次的替代。
- **最小验证**：`npx tsx --test test/run-journal.test.ts` 中 `only answers the currently pending WorkBuddy permission request once` 与新增的「已答过」断言。

## IR-A7（仅告知，无需接线）：`publishFileSync`

- `gateway/src/run-journal.ts` 新增 `publishFileSync(temp, file, {rename?, attempts=6, backoffMs=20})`，`writePrivateJson` 已改用它。只有 `EPERM`/`EACCES`/`EBUSY` 重试，末次失败删临时文件并抛「destination stayed busy (CODE) after N attempts，旧内容完好」。
- 影响面：所有写 `state.json`/`worker-result.json` 的调用方（含 worker、service、desktop-queue）在 Windows 争用下不再裸 EPERM；错误文案会出现在日志里，不需要 UI 特判。
- 最小验证：`npx tsx --test test/run-journal.test.ts`（三条新用例）。

## IR-A8（无需改动，仅确认口径）：A03 没有改状态机与 schema

- 没有新增表、没有迁移、没有改 `TERMINAL` 集合、没有改 `hasNativeStopEvidence()` 的判据；`cancellationRequested ≠ 停止`、`认证报告 ≠ 停止`、`工作树有结果 ≠ 成功`、`读不到 ≠ 不存在`、`EPERM ≠ 进程消失`、`未知继续占用共享容量` 全部原样保留。
- 如果你在集成时看到 `messages()` 多了一条 blocked 记录（IR-A5），那是**新增的可见性**，不是状态迁移。
