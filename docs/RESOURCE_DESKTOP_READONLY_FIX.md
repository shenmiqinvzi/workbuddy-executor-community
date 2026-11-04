# 桌面只读资源读取修复（D3-03 桌面适配）

- 日期：2026-11-04
- 工作目录：`E:\javaproject\workbuddy-desktop-resource-fix`（独立 worktree）
- 分支：`fix/desktop-readonly-resources`，基线 `0bb9ffe`（集成候选 `integration/resource-center` 的当时 HEAD）
- 修复提交：`c5cf788`「Fix desktop read-only resource facade」
- 证据目录：`E:\javaproject\outputs\resource-desktop-fix-20261104`

范围：只修桌面只读存储对 `quotas` / `creditBalances` / `operations` 的适配缺口，并在同一个新候选包上重跑浏览器与 WebView2 验收。真实上游来源、可信路由、任务方案关联、D0/D1 与正式发行不在本轮结论内。

## 1. 根因

桌面工作台用 `openWorkbenchReadStore()` 打开一个**只读** SQLite facade，再把它当成 `TaskCoordinator` 传给共享的 `TaskApplicationService`。该 facade 只代理了任务类查询（`get`、`listAttempts`、`listTasksByCreatedCursor`、`hasTaskAfterCursor`、`listTaskEvents` 等），没有 `quotas`、`creditBalances`、`operations` 三个成员：

- `TaskApplicationService.readQuotaResources()` → `store.quotas.read(...)`
- `TaskApplicationService.readCreditBalances()` → `store.creditBalances.read(...)`
- `TaskApplicationService.readCapacity()` → `store.operations.occupant()`

三处都在调用时抛 `TypeError`，被 `gateway/src/workbench-http.ts` 的资源路由统一捕获成 **503 `RESOURCE_STORE_UNAVAILABLE`**。所以旧包对有效合成快照也返回 503，容量接口同样不可达——和上一轮桌面验收记录的现象一致。

这不是 HTTP 层的错误，看到 503 说明"存储读不出来"，不能用"返回空数组"或"虚构空闲容量"掩盖，否则会把"读不到"说成"已知为零"。

## 2. 修复

| 文件 | 改动 |
| --- | --- |
| `gateway/src/quota-observation.ts` | 抽出导出纯函数 `readQuotaResources(db, options)`（原 `QuotaStore.read` 的整段实现，`this.db` → 参数 `db`），开头用 `present(db, table)` 检查 `quota_connections` 是否存在，缺表抛 `resource_storage_missing:quota_connections`；`QuotaStore.read()` 改成一行转发 |
| `gateway/src/credit-balance.ts` | 同样抽出 `readCreditBalances(db, connectionId)`，缺表抛 `resource_storage_missing:credit_balance_connections`；`CreditBalanceStore.read()` 一行转发 |
| `gateway/src/operation-admission.ts` | 抽出 `readCapacityOccupant(db)`，缺 `workflow_capacity` 表抛 `resource_storage_missing:workflow_capacity`，空表返回 `null`；`OperationAdmission.occupant()` 一行转发 |
| `gateway/scripts/workbench-read-store.mjs` | facade 补三个冻结成员：`quotas.read`、`creditBalances.read`、`operations.occupant`，直接调上面的纯函数并传入已有的 `db` |

要点：

- **复用而不是另写规则**：桌面读的是网关自己的查询函数，脱敏（`scopeId` 伪装）、去重（`scopeId:modelId`、按 `collectedAt` 取最新）、新鲜度（`fresh`/`stale`/`unavailable`）、`connectionIds` 合并、`limitations`、`coverage` 推导都只有一份实现，不会漂移。
- **严格只读**：facade 不构造 `TaskStore`、`QuotaStore`、`CreditBalanceStore`、`OperationAdmission`，因此开窗不会建表、不会生成元数据盐、不会登记连接、不会写容量行；也不启动采集器、执行器、同步、恢复或派工。
- **缺表 ≠ 空**：旧库缺表时抛明确错误 → HTTP 503，页面显示"资源接口不可用"，而不是"未配置"或"空闲"。
- 三条路径与 schema（`quota-1`、`credit-balance-1`、`capacity-1`）未改。

## 3. 三条链路结果（新包、真实只读 SQLite、合成数据）

`desktop/desktop-host-check.mjs` 起真实 host（`listen(0)` 随机端口 51237）读取合成快照，退出码 0，结果在 `desktop/desktop-host-results.json`：

| 端点 | 状态 | 关键内容 |
| --- | --- | --- |
| `GET /workbench/v1/resources/quotas` | 200 | `workbuddy-executor/quota-1`、`readOnly:true`、1 连接 `observed`/`fresh`、1 观测 `synthetic-model`：`unit:tokens`、`valueKind:estimated`、`availability:available`、`used 20 / budget 100 / remaining 80`、`connectionIds:['synthetic-quota']`、5 条 `limitations`（含 `routing_unverified`） |
| `GET /workbench/v1/resources/credit-balances` | 200 | `workbuddy-executor/credit-balance-1`、1 连接 `cacheFreshness:fresh`、1 余额 `unit:credit`、`balance 12`、`accountsEnabled 2 / accountsWithData 1`、`coverage:partial`、`balanceFreshness:unavailable`（只可能 stale/unavailable）、5 条 `limitations` |
| `GET /workbench/v1/resources/capacity` | 200 | `workbuddy-executor/capacity-1`、`readOnly:true`、`snapshotOnly:true`、`limit:1`、`occupied:null`（明确空闲，不是 503） |
| `GET /workbench/v1/tasks` | 200 | `stage-2`，任务列表正常返回，资源故障不影响任务查询 |
| 四个前端资源 | 200 | `resources.mjs` / `resources-source.mjs` / `resources-model.mjs` 为 `text/javascript; charset=utf-8`，`resources.css` 为 `text/css; charset=utf-8` |

## 4. 只读保证与数据库不变的证据

`gateway/test/desktop-readonly-resources.test.ts` 用真实 `TaskStore` 写库、`close()`，再用真实 `openWorkbenchReadStore()` + 真实 `TaskApplicationService` 读，断言：

- 桌面读到的 `quotas` / `creditBalances` 与写库端 `writer.quotas.read()` / `writer.creditBalances.read()` **深度相等**（同一套语义）。
- 主库文件 `sha256`、`sqlite_schema` 全量、任务 `revision`/`updated_at`、`task_events` 计数在"打开窗口 + 读三条资源 + 关闭"前后**完全一致**。
- 旧库（缺 `quota_connections` / `credit_balance_connections` / `workflow_capacity`）读取后不新增 `quota_metadata`、不新增盐、不新增连接行。
- 空库 → 资源为空集合（`connections:[]`、`observations:[]`），任务查询照常 200。
- 损坏快照 → 抛 `resource_corrupt` / `credit_resource_corrupt`，不混成空集合。
- 缺表 → 三条资源 503 `RESOURCE_STORE_UNAVAILABLE`，而 `/workbench/` 与 `/workbench/v1/tasks` 仍 200。
- `server.close()` + `store.close()` 之后请求失败、读取抛错（服务与连接都真正退出）。

## 5. 自动测试（实际命令与结果）

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `cd gateway; npm run build` | tsc 通过 | 0 |
| `cd gateway; npx tsx --test test/desktop-readonly-resources.test.ts` | 13/13 | 0 |
| 同上，先 `git stash push -- gateway/src gateway/scripts` 再跑 | 2 通过 / 11 失败（修复前预期失败） | 1 |
| 恢复后重跑 | 13/13 | 0 |
| `cd gateway; npm run test:workbench` | 100/100 | 0 |
| `WORKBUDDY_CLI_ELECTRON=<env>\WorkBuddy.exe`、`WORKBUDDY_CONFIG_DIR=<env>\workbuddy-config` 下 `npm test` | 910 tests / 898 pass / 0 fail / 12 skipped（约 328s） | 0 |
| `cd gateway; npm run desktop:test` | 70/70（desktop 策略测试） | 0 |
| `git diff --check` | 无空白问题 | 0 |

`npm test` 首次在未设隔离 env 时失败于 `workspace-workers.test.ts`（`Multiple WorkBuddy installations ...`，`src/config.ts:55`）。这是本机存在多个 WorkBuddy 安装导致的环境歧义，与本轮改动无关；用上面的隔离 env 指向空样本后全绿。桌面策略测试必须在 `gateway/` 目录跑（该 script 定义在 `gateway/package.json`）。

## 6. 新候选包

- 构建与打包：`cd gateway; npm run package -- E:\javaproject\outputs\resource-desktop-fix-20261104\package`，退出码 0。
- 产物：`codex-workbuddy-gateway-v0.7.1.zip`（**552 文件**）、`.manifest.json`、`.zip.sha256`；另有 `workbuddy-executor-v0.7.1.zip`（6 文件）与 `deepseek-executor-v0.7.1.zip`（2 文件）。
- **SHA-256**：`60b79f56f738c995cbda9117a009fa1b2aa3697efe672a69d68b1b95782358ce`
- 解压后 `node scripts/verify-release.mjs` → `{"version":"0.7.1","verifiedFiles":552,"hashesMatch":true}`，退出码 0；`npm ci --omit=dev` 成功（94 packages）。
- 与旧包（`70c942827f1f2fb60617fdf5b14ac17aea18d66225762fb024f84093fd6d01bc`，551 文件）的差异：**只多 1 个文件**，即新增回归 `test/desktop-readonly-resources.test.ts`；其余改动是 4 个源码文件与由此重新生成的 `dist/`。版本号沿用 `0.7.1`，因此必须用 SHA-256 区分，不能凭版本号判断同一个包。
- 旧包与旧解压目录均未覆盖（打包脚本用 `flag:'wx'` 写文件），旧证据保持原样。

## 7. 浏览器验收（与桌面同一个包）

脚本：`outputs/resource-desktop-fix-20261104/browser/scripts/`（自上一轮 `resource-browser-acceptance-20261104/scripts/` 复制后使用，未改候选包源码）。

- 官方链路：`WorkbenchHttpServer` + `serveWorkbenchAsset` 精确白名单；资源响应来自真实 `QuotaStore`/`CreditBalanceStore`，数据为隔离合成行；故障注入只作用于测试适配层与 CDP 层。
- 结果：**128 项检查 / 128 通过 / 0 失败 / 0 场景错误**，退出码 0（约 30 秒）。
- 视口：1440×1000、720×1000、420×900，另加 1440×1000 @200%（CDP 模拟，不是系统 DPI）。
- 报告：`browser/reports/{summary.json, scenarios.json, checks.log, console-network.json}`（已对 `127.0.0.1:<port>`、本地路径、临时库名脱敏），截图 20 张在 `browser/shots/`。
- `summary.json` 现在记录运行时算出的 `package.sha256` 与 `source.commit`：`c5cf788` / `60b79f56…`，与桌面侧一致。

## 8. WebView2 实窗验收（同一个包）

脚本：`desktop/webview-acceptance.mjs`（本轮新写，复用 `browser/scripts/cdp.mjs`）。真实 `WorkBuddy.Workbench.exe`，专用 profile、独立数据库、独立 runs 目录、动态调试端口；故障注入在浏览器层用 CDP `Fetch.fulfillRequest` 返回 503，不改业务判定。

- 结果：**71 项检查 / 71 通过 / 0 失败**，退出码 0；窗口关闭请求后 685ms 内正常退出（`exit.code:0`），无强杀。
- 场景：任务页基线 → 资源页真实读取 → 单侧失败 → 双侧失败 → 恢复 → 陈旧快照 → 离页取消 → 返回重读 → 键盘 → 窄窗口 720/420 → 真实↔演示切换 → 嵌入面板 → 容量 → 控制台卫生 → 关闭后 host 停止 → 重开仍为真实读取。
- 关键证据：
  - 页头「本次读取尝试 20:12」与两分区「上次成功读取」分开显示；单侧失败时失败分区保留旧时间、成功分区时间前进，提示里写清「该分区保留了 … 的成功快照；另一分区已在本次读取中更新（…）。失败分区没有替换成演示数据。」
  - 双侧失败时两个分区的成功时间都不被覆盖，提示「未用演示数据替代」，页面仍为「真实读取」。
  - 读取中离页：两个在途请求都被 abort（计数 2），隐藏页的尝试时间不再变化。
  - 返回：自动重新读取（页头时间前进、不卡 `aria-busy`）。
  - 陈旧快照同时出现「陈旧」「可用性未知」「已证实耗尽」「未提供」四种状态文案，`null` 不显示为 0。
  - 容量：200 + `occupied:null` + `snapshotOnly:true`（明确空闲事实）。
  - 关闭窗口后自有查看服务不再应答（连接被拒），重开后仍是真实读取并读到同一批合成快照。
- 证据：`desktop/webview-acceptance.json`、截图 13 张 `desktop/shots/W01–W13*.png`、`webview-stdout.log` / `webview-stderr.log` / `webview-reopen-stderr.log`。截图均带「隔离合成数据 · 非真实额度」角标。

## 9. 本轮修正的验收脚本问题（不是产品缺陷）

复跑时先有 3 项失败，逐项取证后确认都是脚本自身的断言/时序写错，修改脚本后 71/71：

1. `S03.3`：原断言要求"token 分区时间不变"，但该场景只给积分侧注入失败，token 侧本次读取是**成功**的，时间本来就该前进。改为"失败分区保留、成功分区前进"。
2. `S08.2`：`waitFor(aria-busy !== 'true')` 在返回触发的读取还没把 busy 置 true 时就通过，读到上一轮时间。改为先等页头时间真的变化再等 busy 结束。
3. `S13.3`：容量响应字段是 `occupied`，脚本读的是不存在的 `occupiedByTaskId`。改为读 `occupied`，并补一条"`readOnly`/`snapshotOnly`/`limit` 齐全"的断言（总数因此是 71 而不是 70）。
4. 页头时间只到分钟，原先固定 `+30s` 是否跨过分钟边界不稳定。改为把页面时钟推到「下一分钟 + 5 秒」，只在测试页内生效（`window.Date` 子类），不改产品逻辑。

另外修正 `browser/scripts/run-acceptance.mjs` 的包路径（`../package/` 才是压缩包位置，`./package/` 只有解压目录），并让报告在运行时计算包哈希与源码提交。

## 10. 未覆盖与限制

- 仍未接入真实上游来源与真实账号：所有额度、积分、容量都是隔离合成行；页面显示"网关汇总，尚未验证为本任务可用"，未核验路由（`routing_unverified`）保持原样。
- 任务方案关联（D3-03 的关联部分）、可信路由（D3-02）、真实来源（D3-01）、任务监督停机的端到端隔离（D3-04）、D0/D1 与正式发行均未在本轮验证。
- 200% 缩放是 CDP 模拟；系统实际 DPI 缩放未单独测量。仅一个 Windows 环境、单显示器；暗色主题与高对比模式未覆盖。
- 只验证 Chromium WebView2 与 headless Chrome，未验证其它浏览器。
- 容量只读验证覆盖"空闲/占用/缺表/损坏"四态，未在真实占用的运行中任务上验证（不启动真实派工）。
- 演示模式只能证明页面能标记并展示合成样本，**不等于**桌面真实缓存读取通过；真实缓存读取的证据是第 3、8 节的 200 响应与实窗数据。

## 11. 进程与清理

- 本轮创建的进程都按 PID 记录并在结束时关闭：桌面 host（`desktop-host-check` 的 host 进程）、WebView2 主进程与其子进程、Chromium headless（`browser-probe`）。
- 关闭方式是对自己启动的 PID 发关闭窗口/终止，未按进程名批量结束，也未改系统设置或用户浏览器配置。
- 结束后按命令行过滤复查：`chrome.exe` / `msedge.exe` / `WorkBuddy.Workbench.exe` 中与本轮输出目录匹配的进程数为 0。

## 12. 状态与下一步

- 本轮可标记完成的只有：**D3-03 的桌面只读资源读取缺陷**（quota / credit / capacity 三条链路在实窗可用）以及适用于本包的三宽度浏览器、键盘、窄窗口、失败恢复与竞态实窗子项。
- 仍未完成：真实上游来源、可信路由、任务方案关联、D3-04 的停机隔离、D0/D1 门槛、正式发行与生产部署。
- 下一步：由集成方把 `c5cf788` 合入 `integration/resource-center` 并重建统一候选包，两边在同一 SHA-256 上重跑浏览器与 WebView2；之后按授权条件处理真实来源与路由证据。

## 13. 可集成提交

- `c5cf788` — Fix desktop read-only resource facade（5 文件：4 源码 + 1 新增回归；+482 / −49）
- 本交付记录另起一个提交（文档），未推送、未合并、未部署。

## 14. 复现命令

```powershell
# 源码验证（worktree 内）
cd E:\javaproject\workbuddy-desktop-resource-fix\gateway
npm run build
npx tsx --test test/desktop-readonly-resources.test.ts
npm run test:workbench
npm run desktop:test

# 全量 TS 套件（需要隔离 env，避免本机多安装歧义）
$env:WORKBUDDY_CLI_ELECTRON='E:\javaproject\outputs\resource-desktop-fix-20261104\env\WorkBuddy.exe'
$env:WORKBUDDY_CONFIG_DIR='E:\javaproject\outputs\resource-desktop-fix-20261104\env\workbuddy-config'
npm test

# 打包与校验
npm run package -- E:\javaproject\outputs\resource-desktop-fix-20261104\package
# 解压后：node scripts/verify-release.mjs

# 浏览器与 WebView2 验收
cd E:\javaproject\outputs\resource-desktop-fix-20261104\browser\scripts; node run-acceptance.mjs
cd E:\javaproject\outputs\resource-desktop-fix-20261104\desktop; node webview-acceptance.mjs
```
