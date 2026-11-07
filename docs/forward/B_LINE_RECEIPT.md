# B 线回执 · 产品主流程与工作台（forward-delivery-20261107）

- 工作树：`E:\javaproject\workbuddy-forward-20261107\B-product`
- 分支：`feat/forward-product-workflow`
- 起点：`134cdc7febbf858e89fb1010cf6b9d72da5edbe7`
- 本轮 HEAD：`4e22c2e`（累计 8 个提交，`git diff --stat 134cdc7..HEAD` = 22 文件 / +1414 / -40）
- 未合 main、未推远端、未连接真实 18491/Host、未做真实派工与真实模型调用。
- 证据目录：`E:\javaproject\outputs\forward-delivery-20261107\B\evidence\`（原始命令输出 + 5 尺寸页面截图）

**证据层级图例**：`source` = 源码与单元/集成测试（隔离夹具）；`synthetic` = 合成目录、合成 catalog、假 `enqueue`/假 fetch；`window` = 真实页面在 headless Chromium 中以 5 个视口渲染测量（不是桌面壳窗口）；`machine` = 本机真实宿主/Host；`CI` = 持续集成。本轮只有 `source`、`synthetic`、`window` 三层，**没有 `machine` 层**。

## 1. 提交清单

| # | SHA | 标题 | 主要文件 | 行数 |
|---|-----|------|----------|------|
| 1 | `e26fe7a` | feat(desktop-dispatch): separate definite preparation refusals from uncertain dispatches | `gateway/src/desktop-dispatch.ts`、`gateway/test/desktop-dispatch.test.ts` | +67 / -8 |
| 2 | `4e63b7a` | feat(workbench): name the three ways a confirmation can end | `gateway/workbench/dispatch.mjs`、`workbench/test/confirm-failure.test.mjs` | +84 / -5 |
| 3 | `bd6f3c1` | feat(workbench): name the evidence that blocks acceptance | `workbench/attention.mjs`、`controls.mjs`、`model.mjs`、`test/task-panel-recovery.test.mjs` | +149 / -6 |
| 4 | `19ef402` | feat(workbench): show what a recommendation cannot promise | `workbench/dispatch.mjs`、`test/recommendation-view.test.mjs` | +52 / 0 |
| 5 | `2cdb97b` | feat(template,notify): clamp template deadlines to the server policy and record why a delivery failed | `src/project-template.ts`、`src/notification-center.ts`、`test/project-template.test.ts`、`test/notification-persistent.test.ts` | +297 / -8 |
| 6 | `da5c43d` | fix(export): count the whole event stream and prove the saved bytes match the preview | `src/delivery-export.ts`、`test/delivery-export-e2e.test.ts` | +232 / -3 |
| 7 | `58813cc` | feat(desktop-dispatch): warn when the objective implies writes the scope does not grant | `src/desktop-dispatch.ts`、`workbench/dispatch.mjs`、两侧测试 | +88 / -4 |
| 8 | `4e22c2e` | test(workbench): measure the real pages at five widths and fix the targets they exposed | `workbench/controls.css`、`dispatch.css`、`controls.mjs`、`test/page-layout-probe.mjs`、`test/support/page-harness/*`、`test/controls-render.test.mjs` | +445 / -6 |

改动的可自主维护面：`desktop-dispatch.ts`、`project-template.ts`、`notification-center.ts`、`delivery-export.ts`、`workbench/dispatch.mjs`、`attention.mjs`、`controls.mjs`、`model.mjs`、`dispatch.css`、`controls.css` 与对应测试。**未触碰** §文件归属里 I 独占的 `task-store.ts`、`task-application-service.ts`、`server.ts`、`workbench-entry.ts`、`workbench-http.ts`、`workbench/app.mjs`、`workbench/index.html`、`package*.json`、公共 schema/迁移、`SKILL.md`、C# 命令路由。

## 2. B01 手动协作完整主路径

**缺口（接手前）**：确认派工失败时只有一句 `error.message`，三种结局（本机取消 / 派工前确定拒绝 / 结果不明）共用同一块 UI；「结果不明」还会退化成“再点一次确认”，而 `commit` 的 `commits` 缓存又会把拒绝当成成功回执留下；正文要求改文件而范围为空时，预览页完全沉默，用户只能到执行阶段撞 `SCOPE_PATH_UNAUTHORIZED`。

**实现**

1. `desktop-dispatch.ts`：把 `commitOnce` 拆成 `preflight()`（DISPATCH_NOT_ENABLED / MODEL_UNVERIFIED / QUOTE_CHANGED / WORKSPACE_CONFLICT / 会话核验 / DRAFT_EXPIRED）+ 派工。preflight 失败时记录 `failures`（`{taskId,operationId,code,message,at}`）、释放 `consumedPlans` 占位、清 `commits` 缓存，使**同一 taskId/operationId 可以「修好后重新核对」而不是换身份重来**；`receipt()` 优先返回真实回执，其次 `outcome_unknown`（仍在处理中），最后返回 `failed` + `retryable:true`；`latest()` 同序。
2. `dispatch.mjs`：新增 `isDefiniteRefusal(code)` 与 `confirmFailure(error, identity)`，把结局分成三支——`CONFIRMATION_CANCELLED`（未派工，方案继续可用）、definite 拒绝（未派工，保留身份，提示「不会自动换模型、换档位或重试」）、其余（`outcome_unknown` 回执，「不要重复派工」）。`failed && retryable` 的回执页新增「回到约定核对」。
3. `desktop-dispatch.ts` + `dispatch.mjs`（`58813cc`）：`DesktopDraft.warnings` + `scopeWarnings(objective, allowedChanges)`：范围为空且有写意图 → `scope_not_declared`；正文里出现未被范围覆盖的路径 → `scope_path_not_covered`（最多 6 条）。预览页在「确认前核对」上方显示「正文与允许范围不一致」，并写明**提示不扩大范围、正文路径不构成写权限**。`warnings` 参与 digest，改写正文会让旧摘要失效。

**忙 / 多会话 / 错目录 / 模型失效 / 权限等待 / 费用未知**（页面既有提示，本轮未改语义，已复验）：来源非 `online` 时按 `stateReason` 列在 `#catalog-notices`；会话重复或非 `idle` 时该选项禁用并单独标注「身份不唯一 / 未连接 / 忙碌 / 状态未知」；会话目录与项目不一致时提示「目录不同」并在预览时核验；模型被策略阻断时 `blockedReason` 直接作为预览阻断原因；`waiting_input` 由任务面板单列（B03）；费用未知恒显示「费用未知，可能计费」，零费率必须 `pricingVerified` 才写「已核实零费率」。

**复验（实际计数）**

```
cd gateway; npx tsx --test test/desktop-dispatch.test.ts     # 12 tests / 12 pass / 0 fail
cd gateway; npm run test:workbench                            # 156 tests / 156 pass / 0 fail
```

新增/扩写的用例：`a preparation refusal is definite: it keeps the identity, releases the plan and names what must change`、`one agreement is confirmed once, and a refusal keeps the exact identity`（扩展）、`a scope warning is shown on the terms it belongs to and never blocks the review`、`confirm-failure.test.mjs`（5 条：取消 / 8 种 definite 码 / 已消费 / 不可读交接 / 裸网络错误不算 definite）。

**真实走通的环节（隔离样本，`synthetic`）**：选项目（真实临时目录 + 真实 `device:inode`）→ 选来源/精确模型/推理档 → 费用（未知与 `pricingVerified` 两种）→ 目标 + 结构化范围 + 检查项 → `preview` 生成草稿（含 `warnings`）→ 改字段 → `preview` 以 `draftId/digest` 修订到 revision+1（taskId/operationId 不变、expiresAt 不延长、旧摘要进 superseded）→ 条款变化（quote/policy/过期）后确认被 definite 拒绝且身份保留 → 修好后确认成功并落 `enqueue` 一次 → 重复确认返回同一 promise → 并发确认只派工一次。
**没有走通（需 `machine` 层）**：真实桌面确认窗口、真实共享原生派工、真实原生停止、真实独立审查与验收、真实模型调用。这些不在源码层可证，留给 L01/L07 实机验收。

## 3. B02 方案 / 推荐 / 用户覆盖

**缺口**：`recommendation.ts` 语义已完整（`direct|delegate|wait`、`excluded`、`missing` 分 `blocks|limits`、用户指定执行器优先、`attempt:null`），但页面把「剩余额度 / 余额 / 新鲜度」直接打印成数字，缺数据时看起来像有数据，且「硬性花费上限」被当成支持的能力。

**实现**（`19ef402`）：`dispatch.mjs` 新增 `costText()` 与 `resourceDetail()`：额度/余额为空写「剩余额度未知」「余额未知」，新鲜度映射为「新鲜/已过期/不可用/新鲜度未知」，`limitations` 只取前 2 条；候选行追加「费用未知，可能计费 · 剩余额度未知」这类技术行。新增 `#recommendation-authority`（「建议不授予派工权：仍需预览与本机确认；记录的执行轮次：无，原生派工：未发生。」）、`#recommendation-direct`、`#recommendation-cost-cap`（`hardCostCap.status==='unsupported'` 时显示「不支持硬性花费上限」）。

**复验**：`npm run test:workbench` 中 `recommendation-view.test.mjs` 8 条全 pass，其中 2 条为本轮新增：缺失资源事实显示为未知 + 硬上限披露为不支持；direct 决策文案 + 「记录的执行轮次：无」+ 断言**不产生 `dispatch` / `preview` 调用**。preview 修改/过期/撤回/重复消费/并发确认由 `desktop-dispatch.test.ts` 覆盖（见 B01 计数）；推荐引擎本身（direct/delegate/wait 理由、排除项、用户覆盖优先、不授予执行权）由 `npx tsx --test test/recommendation.test.ts` 复验 → **18 tests / 18 pass / 0 fail**（该文件本轮未改动，只做回归确认）。

## 4. B03 任务面板与恢复体验

**缺口**：① 执行报告先到、原生停止未确认时，面板标签仍是「执行中」，读起来像还在跑，而验收/返工入口其实已关闭；② 待审查卡片只说「审查未完成」，不说**卡在哪个事实**（没有审查 / 审查基于旧版本 / 没有检查项 / 检查项由执行器自报 / 有未通过项）；③ 非法时间戳会把原始字符串直接打到页面上。

**实现**（`bd6f3c1`）

- `model.mjs stateInfo()`：`queued|running|waiting_input` 且已记录报告 → 标签改为「报告已到，仍在排队」/「报告已到，尚未确认停止」，并追加「报告已记录，但原生停止未确认，验收与返工入口保持关闭。」（`key`/`tone` 不变，`filterRecords` 分组不受影响）。
- `attention.mjs`：新增 `timeOrMissing()`（缺失→「无」，可解析→`formatTime`，不可解析→「无法识别（前 40 字）」）与 `reviewBlocking(view, review)` 五分支文案；`needs_review` 的 why 改用 `reviewBlocking`，`code` 仍为 `review_pending`；`run_orphaned` 的 `ownerPid`/心跳、`waiting_stop` 的 `nativeStoppedAt` 全部走 `timeOrMissing`。
- `controls.mjs`：新增 `reviewBlockText()` 供不可用原因复用，`code` 仍是 `review_incomplete`（**既有 code 顺序不变**，`controls.test.mjs` 的序列断言不受影响）。
- `4e22c2e`：`loadReceipts()` 兜底 `Array.isArray(list)?list:[]`——`control_list` 返回 `null` 时不再 `receipts.some` 抛 `Cannot read properties of null`（该异常是 390×844 实测截图里真实抓到的）。

**状态覆盖**：排队 / 工作中 / 等待输入 / 取消请求 / 等待停止 / 待审查 / 审查失败 / 结果不明 / 已接受，均对应既有十态枚举与 `attentionReason` 判定顺序；报告认证**只**读 `record.presentation.report.authentication`（`attack`：`view.authentication` 不被读取，已有用例守）。

**复验**

```
cd gateway; npm run test:workbench
# 156 tests / 156 pass / 0 fail
# 其中本轮新增 task-panel-recovery.test.mjs 6 条、controls-render.test.mjs 3 条
```

刷新/掉线/乱序/切任务/旧事件去重/非法时间/缺字段/未知枚举：掉线与乱序由 `dispatch-diagnostics.test.mjs`、`recovery.test.mjs`、`dispatch-crash.test.mjs` 覆盖；未知枚举 `settling_v2` → `unknown_state` 由本轮新增用例覆盖。

## 5. B04 模板 / 通知 / 导出

| 缺口 | 实现 | 复验 |
|------|------|------|
| 模板把 `timeoutSeconds` 只夹到合同上限（86400），忽略服务端政策上限，且 `budget` 不记录夹取原因 → 模板静默放大预算 | `project-template.ts` 增 `policyMaxTimeoutSeconds`（只来自服务端，绝不来自客户端草稿），`budget.timeout` 记录 `{requested,policy,applied,clamped}`，并写 note「…秒时限，当前策略上限…秒，已按策略取…秒」；授权/身份语义不动（`authorization` 恒 `null`、`requires:['plan_create','user_confirmation']`、`FORBIDDEN_DRAFT_KEYS` 与 `findCarriedIdentity` 探针保留） | `npx tsx --test test/project-template.test.ts` → 11/11 pass（新增 1 条） |
| 通知投递失败后只剩「稍后重试」，没有原因、没有次数、重启即失忆 | `notification-center.ts` 账本增 `failures`，`poll()` 返回 `deliveryFailures` 与 `failures[]`，`pending()` 带 `lastFailure`；成功投递与「通知已关闭」都清该条；prune 删 24h 外的失败 | `npx tsx --test test/notification-center.test.ts` 8/8；`test/notification-persistent.test.ts` 5/5（真 `TaskStore` + 真 `appendTaskEvent`：二次 poll 为 0、重开不补发、失败原因重开后仍在、关闭重开不补发、poll 不改任务行 state/revision/updatedAt） |
| 导出把 `listTaskEvents({limit:1}).nextEventId` 当事件总数（恒为 1）；断言层只校验 digest，没校验落盘字节 | `delivery-export.ts` 改为按 `afterEventId` 游标分页累加（20 页 × 500 条，超限标 `eventsTruncated` 并给出限制文案） | `npx tsx --test test/delivery-export.test.ts` 18/18；`test/delivery-export-e2e.test.ts` 4/4（真库 + 真产品命令：落盘字节数 == 返回 bytes == 预览 bytes；`sha256(JSON.stringify({...document, exportedAt:''}))` == 预览 digest == 保存 digest；顶层键全在白名单；`redactions.count` == 脱敏字段数 == `preview.redactionCount` 且原始字节不含秘密；同名保护只多一个文件；改动后旧 digest → `export_stale` 且不落盘；`invalid_directory` / `task_not_found` / `INVALID_REQUEST`） |

## 6. B05 页面可独立推进部分

**做法**：不新增依赖（`gateway/package.json` 由 I 独占），用 Node 24 自带 `WebSocket` 直接讲 CDP，驱动本机 Playwright 缓存里的 `chrome-headless-shell`。新增 `workbench/test/page-layout-probe.mjs`（**不是** `*.test.mjs`，不进 `npm run test:workbench`，浏览器缺失时显式失败而不是假通过）与 `workbench/test/support/page-harness/`（真 `dispatch.mjs` / `attention.mjs` / `controls.mjs` + 真 CSS + 桩 `fetch`，目录用 `C:/synthetic/a-very-long-project-directory-name-for-layout/project`）。

**测量项**：横向溢出（`body *` 的 `rect.right > innerWidth+1 || rect.left < -1`）、`scrollWidth`、可聚焦控件的无障碍名（aria-label → aria-labelledby → `label[for]` → 包裹 label → placeholder → 文本）、`aria-describedby` 是否指向存在的 id、`[role=status]`/`[aria-live]` 计数、档位 `aria-current`、<12px 字号、<24px 命中区、Tab 焦点序（10 次 `Input.dispatchKeyEvent`）、焦点环样式，并逐阶段截图。

**实测结果**（`window` 层，headless 视口，非桌面壳窗口）：

```
node workbench/test/page-layout-probe.mjs --out <evidence>/pages
{"ok":true,"sizes":5,"failures":[]}
```

| 视口 | 横向溢出 | 可聚焦控件（填写/核对/回执） | 键盘 Tab 序 | 读屏标签 | 结论 |
|------|----------|------------------------------|-------------|----------|------|
| 1440×900 | 0（`scrollWidth == width`） | 15 / 5 / 5 | 已做，焦点环 `solid 2px` | 已做，无未命名控件、无悬空 `aria-describedby` | 通过 |
| 1280×720 | 0 | 15 / 5 / 5 | 已做（同上） | 已做（同上） | 通过 |
| 768×1024 | 0 | 15 / 5 / 5 | 已做（同上） | 已做（同上） | 通过 |
| 390×844 | 0 | 15 / 5 / 5 | 已做（同上） | 已做（同上） | 通过 |
| 320×844 | 0 | 15 / 5 / 5 | 已做（同上） | 已做（同上） | 通过 |

**探针实测出的真实缺陷（已修）**：`dispatch.css` 的 `.dispatch-advanced summary`（20px 命中区，加 `padding:4px 0`）、`.plan-resource-limits summary`（20px，加 `padding:3px 0`）、`controls.css` 的 `.attention-declare summary`（20px，加 `padding:3px 0`）。

**明确未做**：正式桌面壳窗口内的渲染与真实点击（无 `machine` 层证据，标「正式窗口未验」）；读屏软件（NVDA/讲述人）实际朗读；`productivity.mjs` 导出面板与 `resources`/`statistics` 页面未纳入探针（前者属跨页交互需 I 协调，后两者归 C）；移动端触屏手势。DOM 断言不作为人工实测的替代。

## 7. 失败与教训（保留，不删）

1. 用 PowerShell `Set-Content -Raw` 回写 `workbench/*.mjs` 会把中文 UTF-8 写坏（`SyntaxError: Invalid or unexpected token`，页面出现 `�`）。改这些文件必须用 `edit` 工具；损坏后 `git checkout -- <file>` 重做。
2. `dispatch.mjs` 里嵌套三元构造 DOM 时括号极易失衡，曾多写 `]:[]` 导致 5 个测试文件整体失败；每次改完必须 `node --check workbench/dispatch.mjs`。
3. `npm run test:workbench` 依赖 `dist/`（`read-store`/`declaration`/`dispatch-channel`/`dispatch-crash`/`recovery` 等用例 `import ../dist/*.js`），需先 `npx tsc -p tsconfig.json`。
4. `notification-persistent.test.ts`：`createOrGet` 复用同一 `attemptId` 会报 `Attempt identity belongs to another task`（`saveAttempt` 唯一约束），多任务必须各用唯一 attemptId。
5. `delivery-export-e2e.test.ts`：`statistics.coverage` 用非白名单键会触发构建器自检 `export_not_whitelisted`。
6. 探针退出时 `fs.rmSync(profile)` 会因浏览器未退出而 `EPERM`，必须先等 `exit` 或 5s 兜底，并加重试。
7. mini-dom 没有 `isConnected`，`renderDesktopControls` 的 `loadReceipts` 会因「未挂载」提前返回；渲染类用例需在测试里补 `isConnected` 查询。

## 8. 本轮未验证（交给 I / 实机线）

- 真实桌面壳窗口、真实本机确认窗口、真实原生停止、真实独立审查与验收、真实模型调用与计费。
- `instantiateTemplate` 的 `policyMaxTimeoutSeconds` 目前**没有调用方**（HTTP/桌面宿主侧才调用），需 I 接线，见 `INTEGRATION_REQUEST_B.md` 第 1 条。
- `notification` 的 `deliveryFailures`/`failures` 尚未透出到 `/workbench/v1` 与桌面宿主响应，见第 4 条。
- 1301 条全量回归由 I 负责，本轮只跑 B 线专项。
