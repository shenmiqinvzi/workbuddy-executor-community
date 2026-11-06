# L06 验收记录：版本化项目模板、桌面通知与脱敏导出

- 线：L06（项目模板 / 通知 / 脱敏导出），任务 D6-03（模板部分）、D6-04（通知与导出）
- 工作树：`E:\javaproject\workbuddy-finish\L06-productivity`
- 分支：`feat/finish-l06-productivity`
- 日期：2026-11-06

## 1. 范围

本线交付三块能力，全部落在本工作树内，未改任务库表结构、未改 `TaskStore` / `TaskApplicationService`、未改 `gateway/workbench/dispatch.mjs` 与技能文件。

**做**：

1. 版本化项目模板：`gateway/src/project-template.ts`（保存项目预设、检查定义、可选选择建议；同 id 保存生成新版本，最多 20 版；归档；坏数据可解释）。
2. 实例化：产生新 `taskId`/`draftId`，`authorization:null`，`requires:["plan_create","user_confirmation"]`；不复制 attempt/operation/plan/review 身份与旧证据；预算取 `min(模板, 策略)` 并把截断写进 `notes`；政策建议模板一律拒绝实例化（`policy_activation_unsupported`）。
3. 桌面通知：`gateway/src/notification-center.ts`（可配置开关与原因、按真实事件 id / episode 去重、每原因节流、关闭只停投递并推进水位、重开不补发、失败不吞 episode）。
4. 脱敏导出：`gateway/src/delivery-export.ts`（显式字段白名单、嵌套秘密脱敏、路径校验、4 MiB 上限、同名不覆盖、预览 digest 与保存一致）。
5. 只读读取面：`gateway/src/productivity-service.ts`（模板目录/详情、通知快照、导出预览）；页面 `gateway/workbench/productivity.{mjs,css}`；桌面命令 `gateway/src/desktop-productivity.ts` + `gateway/desktop/DesktopProductivityConfirmation.cs`；宿主接线 `gateway/src/productivity-runtime.ts`。
6. 测试七组、C# 策略断言十七组、只读回环冒烟。

**不做（明确边界）**：

- 不做政策引擎：`kind:"policy-suggestion"` 只保存建议，`activation` 固定 `"unsupported"`，07 未交付前不宣称自动政策模板可用。
- 不新增 HTTP 写入口：适配器仍无请求体解析；模板保存、通知开关、导出写盘只在受控桌面壳的命令通道里发生。
- 不写任务库：通知与模板的状态文件在 `WORKBUDDY_CONFIG_DIR`，导出写到用户在原生选择框里挑定的目录。
- 不安装、不发布、不部署、不 push、不合 main。
- 不跑全量测试套件（按 COMMON.md 只跑受影响专项）。

## 2. 基线与提交

| 项 | 值 |
| --- | --- |
| 基线提交 | `af9bab6f095c19b1ff98b12450e493544a75138d` |
| 基线 tree | `d919434fe8d84a6e5a7ff242b8fdafcb0f2f0abd` |
| 实现提交 | `ac606e0392160bd1e9c5d5c45ca30c091106209e`（27 files, +4195 / −13） |
| 文档提交 | 本文件所在提交（SHA 见 `outputs/finish-l06-20261105/HANDOFF.json` 的 `commits` 末项） |
| 分支 | `feat/finish-l06-productivity` |
| 工作树 | `E:\javaproject\workbuddy-finish\L06-productivity` |

开工前核对：`git rev-parse HEAD` 与基线一致、`git rev-parse 'HEAD^{tree}'` 与基线 tree 一致、`git status --porcelain` 0 行。提交后 `git status --porcelain` 0 行；未 push、未合 main、未发布、未部署。

依赖：工作树原本没有 `node_modules`，`npm run build` 报 `'tsc' is not recognized`；按本树 lockfile 执行 `npm ci --no-audit --no-fund`（100 packages，exit 0），未改任何版本号。

## 3. 变更文件

**新增（源码）**

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `gateway/src/project-template.ts` | 644 | schema 校验、legacy 升级、实例化、版本化存储 |
| `gateway/src/notification-center.ts` | 532 | 配置、账本、去重、节流、轮询 |
| `gateway/src/delivery-export.ts` | 356 | 白名单文档、脱敏、目标解析、写盘 |
| `gateway/src/productivity-service.ts` | 285 | 三条只读路由与错误映射 |
| `gateway/src/productivity-runtime.ts` | 79 | 配置目录内的运行期组装 |
| `gateway/src/desktop-productivity.ts` | 168 | 桌面命令分派与字段校验 |
| `gateway/workbench/productivity.mjs` | 260 | 独立视图（只 GET、只 textContent） |
| `gateway/workbench/productivity.css` | 25 | 视图样式 |
| `gateway/desktop/DesktopProductivityConfirmation.cs` | 78 | 原生确认对话框（模板/导出） |

**新增（测试）**

| 文件 | 行数 | 用例数 |
| --- | --- | --- |
| `gateway/test/project-template.test.ts` | 319 | 10 |
| `gateway/test/notification-center.test.ts` | 254 | 8 |
| `gateway/test/delivery-export.test.ts` | 301 | 13 |
| `gateway/test/productivity-service.test.ts` | 207 | 5 |
| `gateway/test/productivity-page.test.ts` | 95 | 6 |
| `gateway/test/productivity-http.test.ts` | 133 | 5 |
| `gateway/test/desktop-productivity.test.ts` | 192 | 7 |

**修改（机械接线，均已在 `docs/delivery/L06_INTEGRATION_REQUEST.md` 逐处说明）**

`gateway/src/workbench-http.ts`（+18：import、可选 `productivity` 选项、405 已知路径、GET 分支）、`gateway/src/workbench-assets.ts`（+2：两个白名单条目）、`gateway/src/workbench-entry.ts`（+10：只读来源注入）、`gateway/workbench/app.mjs`（+36/−2：import、`navProductivity`、`setView` 一支、挂载点）、`gateway/workbench/index.html`（+1：样式表）、`gateway/scripts/package.mjs`（+1/−1：发布包清单）、`gateway/scripts/workbench-desktop-commands.mjs`（+16/−2：第 8 参与分派）、`gateway/scripts/workbench-desktop-host.mjs`（+43/−7：运行期组装、通知轮询、ready 帧）、`gateway/desktop/DesktopControlPolicy.cs`（+43/−1：8 个动作与参数校验）、`gateway/desktop/Program.cs`（+92/−6：通知读取/托盘、导出与模板确认）、`gateway/desktop/test/Program.cs`（+17：策略断言）。

关键契约位置：

- 模板 schema：`PROJECT_TEMPLATE_SCHEMA = "workbuddy-executor/project-template-2"`，见 `gateway/src/project-template.ts:39`；legacy 为 `gateway/src/project-template.ts:41`。
- 导出白名单：`EXPORT_KEY_WHITELIST`，见 `gateway/src/delivery-export.ts:48`。
- 导出文档 schema：`workbuddy-executor/delivery-export-1`。
- 通知 schema：`workbuddy-executor/notification-1`；原因枚举 `input_requested|needs_review|failed|deadline`。
- 只读读取面 schema：`workbuddy-executor/productivity-1`。

## 4. 验证

所有命令在 `E:\javaproject\workbuddy-finish\L06-productivity\gateway` 下执行；测试前清理继承的 `WORKBUDDY_*` 与 `NODE_TEST_CONTEXT`，自建 `WORKBUDDY_CLI_ELECTRON` / `WORKBUDDY_CONFIG_DIR` / DB / runs，回环流量 `NO_PROXY=127.0.0.1,localhost`。

| # | 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- | --- |
| 1 | `npm ci --no-audit --no-fund` | 0 | 100 packages（esbuild postinstall 未批准，tsx 仍可用） | — |
| 2 | `npm run build` | 0 | `tsc -p tsconfig.json` | `evidence/build.log` |
| 3 | `npm run typecheck:task-view` | 0 | `tsc -p tsconfig.task-view.json` | `evidence/typecheck-task-view.log` |
| 4 | `tsx --test` × 7 个 L06 文件 | 0 | tests 54 / pass 54 / fail 0 | `evidence/ts-l06-tests.log` |
| 5 | `tsx --test test\workbench-http.test.ts test\workbench-assets.test.ts` | 0 | tests 16 / pass 16 | `evidence/ts-shared-entry.log` |
| 6 | `npm run test:workbench` | 0 | tests 117 / pass 117 | `evidence/workbench-pages.log` |
| 7 | `npm run desktop:test` | 0 | `{"passed":87,"failed":0}` | `evidence/desktop-policy.log` |
| 8 | `dotnet build desktop\WorkBuddy.Workbench.csproj -c Release` | 0 | 0 warning / 0 error | `evidence/desktop-build.log` |
| 9 | `node --check scripts\workbench-desktop-host.mjs` | 0 | 语法通过 | — |
| 10 | Node 驱动探针启动 `scripts\workbench-desktop-host.mjs`（合成库） | 0 | ready 帧含 `productivity:true`；四条只读路由 200；POST 405；`stdin.end()` 后正常退出 | `evidence\desktop-host\host-probe.log` |

日志与冒烟记录位于 `E:\javaproject\outputs\finish-l06-20261105\evidence\`。

### 4.1 用例覆盖

**模板**（10）：保存 preset 且 `activation="unsupported"`；`activation:"enabled"` → `invalid_value`；未知 `kind` → `unknown_enum` 且带 `allowed`；`policy-suggestion` 缺建议 → 字段错误；路径穿越 → `project.scope*`；检查定义里写结论字段 → `check_conclusion_not_allowed`；非法 check kind → 复用契约校验的 `invalid_value`；两次实例化 `taskId`/`draftId` 不同且 `authorization=null`、`requires=[plan_create,user_confirmation]`、无携带身份；`policyMaxAttempts=1` 时 `applied=1` 且 `notes` 说明截断；政策模板实例化 → `policy_activation_unsupported`；归档后 → `template_archived`；空标题/控制字符 → `invalid_value`；同 id 保存 → version 2；版本上限 20；归档默认隐藏；legacy v1 升级（丢 `workspacePath`、裸模型名不转 `selectionSuggestion`、原文件不改写）；坏文件给出说明且仍可保存；`unsupported_schema_version`。

**通知**（8）：重复事件只投一次、重开不补发；同原因两个 episode 节流后可投；重复与乱序事件不重复；关闭后不投递但水位前进；presenter 抛错后下一拍重试；`deadline` 由契约派生且标题不用 objective 正文；配置拒绝未知字段/未知原因/越界间隔且拒绝后原配置不变；坏账本丢弃非法 deferred 并给出说明。

**导出**（13）：白名单字段与三条固定 limitation；objective 正文、模型名、messageId 不出现；嵌套 secret 脱敏并报字段名；HTML 标题保持字面值、文档无 html 字段；事件读取失败记 limitation 且 events=0；契约 `integrity_failure` 只标注不复述；statistics 覆盖复制、claims 全 null；审查 50 份上限与 note 截断；`invalid_task_id` / `task_not_found`；200 字节上限拒绝且目录为空；`..` / 文件 / 相对路径拒绝；同名两次保存得 `-1` 后缀；`export_stale` 取消且不落盘。

**只读服务 / 页面 / 路由 / 桌面命令**（5 + 6 + 5 + 7）：catalog 只读且 `activation.supported=false`；详情取版本与未知 id；快照不消耗 episode；预览 digest 64 hex、`target=user_chosen_directory`；路由参数错误码为大写且与适配器同形；页面纯函数（字节格式、原因标签、模板行、导出摘要、限制行）与“无 innerHTML”静态断言；HTTP 200/404/400/405/`allow` 头、无 productivity 选项时 404；桌面命令 `handled:false`、保存/升版、未知字段、非法 id、归档、通知配置、导出 digest 校验、未知动作。

### 4.2 回环冒烟（合成库）

见 `evidence\smoke\smoke.md`：合成库 SHA-256 `ae100e400b8fd844668c8636d36bf5bea49c6a5fb4e97350d16d65a01d005411`；`WORKBUDDY_WORKBENCH_PORT=18532 node dist\workbench-entry.js`：

```text
GET  /workbench/v1/templates                 200  count=0, activation.supported=false
GET  /workbench/v1/notifications             200  config + pending
GET  /workbench/v1/export-preview/task-smoke-1  200  digest 64 hex，响应体无 objective 正文
GET  /workbench/v1/templates?includeArchived=yes  400  INVALID_QUERY
GET  /workbench/v1/export-preview/..%2Fetc        400  INVALID_TASK_ID
POST /workbench/v1/templates                      405  allow: GET, HEAD
```

停机后库 SHA-256 不变、`-wal` 0 字节；配置目录只新增模板/通知/账本三个 JSON（0600）。

### 4.3 受控桌面壳的组装探针

`scripts\workbench-desktop-host.mjs` 用同一合成库启动（保持 stdin 打开），首行 ready 帧为：

```text
{"event":"desktop_host_ready","port":57645,"readOnly":true,"desktopCommands":true,"productivity":true}
```

随后 `GET /workbench/v1/templates`、`/notifications`、`/health`、`/export-preview/task-smoke-1` 均 200 且 `cache-control: no-store`；`POST /templates` 405（`allow: GET, HEAD`）；`?includeArchived=yes` 400 `INVALID_QUERY`。`stdin.end()` 后宿主自行关闭并 exit 0；库 SHA-256 不变，配置目录只多出空账本 `notification-ledger.json`（131 字节）。日志：`evidence\desktop-host\host-probe.log`。

这一步只验证组装与只读面，不代替真人点击：托盘横幅、原生确认框与键盘路径仍需在装有 WebView2 的桌面会话里走一遍（见第 6 节局限）。

## 5. 失败历史

1. `npm run build` 首次失败：`'tsc' is not recognized` —— 工作树无 `node_modules`，按 lockfile `npm ci` 后通过，未改版本。
2. `product-template` 首版把契约的 `task_mismatch` / `objective_mismatch` 直接透出 —— 模板不是任务，改为映射为 `invalid_value`；标题/目标为空时改为显式报字段错误。
3. `productivity-service` 的 `errorBody` 大小写与适配器不一致 —— 统一大写（`INVALID_QUERY` 等），HTTP 测试据此断言。
4. `delivery-export` 的 `redactSecrets` 结果只用于白名单检查、文档仍展开未脱敏对象 —— 改为最终文档取脱敏副本，测试加“嵌套 secret 不出现”。
5. `EXPORT_KEY_WHITELIST` 漏 `attemptId`，生成期自检直接拒绝 —— 补入白名单；同时把内联 `token=abc123` 纳入秘密值正则。
6. 导出 digest 把 `exportedAt` 算进去，预览后的保存几乎必然 `export_stale` —— digest 改为对 `exportedAt: ""` 的内容计算，保存与预览共用同一算法。
7. 通知 `scan()` 用 watermark 过滤旧事件，导致被节流或 presenter 失败的 episode 无法重建（2 个用例挂） —— 账本 `deferred` 保存完整候选与 `readyAt`，`candidatesFor` 合并扫描与 deferred；`scan()` 不再写水位，只由 `poll()` 提交。
8. 测试用 `Get-Content -Raw` + `Set-Content` 做替换时，后续相对路径读取返回 `$null`，把 `gateway/test/delivery-export.test.ts` 写成 0 字节 —— 整份重写；此后 .NET 文件 API 一律用绝对路径。
9. `admin` 误把合法 `minIntervalMs:1` 当作越界 —— 改为非整数/负数/超上限三例。
10. `test/workbench-assets.test.ts` 报 `scripts/package.mjs does not ship workbench/productivity.css` —— 在 `WORKBENCH_FILES` 补两个文件。
11. C# `catch (ObjectDisposedException)` 排在 `InvalidOperationException` 之后触发 CS0160 —— 调换顺序。
12. `probe-*.mts` 里 `../src/...` 相对 import 失败（tsx 以文件位置解析）—— 改为 `./src/...`，诊断脚本用完即删。

## 6. 局限

- 政策模板只能保存、不能激活；07 交付前页面显示“政策建议（未启用）”，实例化返回 `policy_activation_unsupported`。这是本线的真实边界，不是待修 bug。
- 通知只在受控桌面壳里显示（托盘气球）；浏览器页面只显示待办快照，不弹系统通知。
- 桌面壳内对“同一窗口内重复横幅”只按 `notificationId` 做进程内去重；权威去重在账本里。窗口重启后账本不回放已投递 episode。
- 导出不导出原生日志、DB、聊天正文、账号与凭据；也不提供“导出全部任务”，一次一个任务。上限 4 MiB，超出拒绝而不是截断。
- 导出 digest 标识内容而非预览时刻；若两次预览之间任务补了新事件，保存会以 `export_stale` 拒绝并要求重新预览。
- 未做真实安装包、未在真实通知宿主（Windows 通知中心策略受限的机器）与真实生产库上验收；`WORKBUDDY_CONFIG_DIR` 权限只保证创建时 0600，不保证目录本身的 ACL。
- 托盘横幅、原生确认框、导出目录选择与键盘操作没有自动化 UI 驱动，只有宿主组装探针（4.3）与 C# 策略断言；真人点击路径未记录截图。
- 未跑全量 `npm test`；结论只覆盖第 4 节列出的专项与共享入口。

## 7. 运行与部署状态

- 可在本工作树运行：`npm run build` 后 `node dist/workbench-entry.js`（只读页面）与 `npm run desktop`（受控桌面壳，需 WebView2）。
- 通知轮询在桌面宿主内每 15 秒一次；网页入口不轮询、不投递。
- 未安装为系统服务、未生成安装包、未部署到任何主机、未发布；未 push、未合 main。
- 真实通知宿主、真实导出目标目录、生产安装均不在本线授权范围内。

## 8. 交接产物

- 集成请求：`docs/delivery/L06_INTEGRATION_REQUEST.md`（第 1–6 节已应用，第 7 节为 07 对齐契约）。
- 验收：本文件。
- 证据：`E:\javaproject\outputs\finish-l06-20261105\evidence\`（build / typecheck / 三组测试日志 / C# 策略 / 桌面构建 / 冒烟）。
- 交接清单：`E:\javaproject\outputs\finish-l06-20261105\HANDOFF.json`。
