# B 线集成请求（交 I）

范围：只列 **B 线无法自行完成、必须落在 I 独占文件**（`workbench-http.ts`、`workbench-entry.ts`、`workbench/app.mjs`、`workbench/index.html`、`gateway/package*.json`、`server.ts`、公共 schema/迁移）上的改动。每条给：字段 / 触发位置 / 失败语义 / 最小验证。B 线已侧全部落地并有专项测试，I 侧接线不需要改 B 的语义。

约定：所有字段都只描述**已记录的事实**；不得由页面推断，不得因缺失而填默认值或质量分。

---

## 1. `instantiateTemplate` 的政策时限需要调用方传入（P0，否则 B04 的夹取不生效）

- **字段**：`TemplateInstantiationOptions.policyMaxTimeoutSeconds?: number`（`gateway/src/project-template.ts`，已存在）。
- **触发位置**：任何 `instantiateTemplate(template, options)` 的调用点，当前源码内 **0 个调用方**（预期在 `workbench-http.ts` 的模板/生产力命令入口，或桌面宿主的生产力命令分发处）。
- **写法**：取当前协作政策的 `maxTimeoutSeconds`（与 `desktopModelCatalog` 读到的是同一行 `collaboration_policy`），原样传入；**不得**取自请求体、草稿、模板自身。
- **缺失语义**：不传时行为等于「只按合同上限 86400 夹取」（即当前行为），不会报错——所以**必须显式接线**，否则模板仍可静默放大预算。
- **迁移影响**：无。纯新增可选参数，`budget.timeout` 只是多记录几个字段。
- **最小验证**：
  ```
  cd gateway; npx tsx --test test/project-template.test.ts
  # 需 11/11 pass，其中 "template: the deadline preset is clamped to the server policy, not only to the contract limit"
  ```
  接线后请在 HTTP 层加一条端到端断言：政策 `maxTimeoutSeconds=300`、模板预设 900 → 返回 draft 的 `timeoutSeconds===300` 且 `budget.timeout.clamped===true`。

## 2. `draft.warnings` 与 `receipt.retryable` 需要透出到响应与 schema（P0，否则 B01 的预览提示在正式窗口里看不到）

- **字段 1**：`DesktopDraft.warnings: Array<{code:'scope_not_declared'|'scope_path_not_covered', message:string}>`（`preview`/`revise` 返回值，已参与 digest）。
- **字段 2**：`DesktopReceipt.retryable?: boolean`（`failed` 且属于派工前确定拒绝时为 `true`）。
- **触发位置**：
  - `workbench-http.ts` 的 `desktop/preview`、`desktop/status` 响应体：原样透传，**不要**过滤未知 `code`（页面按 `message` 渲染，`code` 仅作 `data-*`/日志）。
  - 公共 schema（若 desktop draft/receipt 有 JSON schema 或类型声明）：把两个字段加为可选，`warnings` 默认 `[]`。
- **失败语义**：字段缺失时页面不渲染提示区块、不显示「回到约定核对」——即**静默降级**，不报错。这是可接受的兜底，但会让用户重新回到「撞 `SCOPE_PATH_UNAUTHORIZED`」的旧体验，因此请务必接通。
- **迁移影响**：无（新增可选字段，`warnings` 已经在 B 侧所有夹具里出现，历史草稿为 `[]`）。
- **最小验证**：
  ```
  cd gateway; npx tsx --test test/desktop-dispatch.test.ts   # 12/12
  cd gateway; npm run test:workbench                          # 156/156
  ```
  HTTP 层加一条：objective 写「修改 docs/README.md」、`scope.allowedChanges=[]` → `preview` 响应含 2 条 warnings（`scope_not_declared` + `scope_path_not_covered`）。

## 3. `renderControlUnavailable()` 可能返回 `null`，挂载处必须判空（P1，用户可见的脏字）

- **字段/契约**：`renderControlUnavailable(record, options)` 在「没有任何不可用原因」时返回 `null`（不是空 section）。
- **触发位置**：`workbench/app.mjs`（以及 `controls.mjs` 的调用方）所有 `slot.append(renderControlUnavailable(...))`。
- **失败语义**：直接 `append(null)` 会在页面上打出字面文本 `null`（390×844 截图实测到过），不抛错、不写日志——属于最难发现的一类缺陷。
- **迁移影响**：无。
- **最小验证**：
  ```
  cd gateway; node --test workbench/test/controls-render.test.mjs   # 3/3
  ```
  断言：`renderControlUnavailable(已停止且审查通过) === null`；`null` 时不追加节点。

## 4. 通知投递失败需要在 HTTP / 桌面宿主可查（P1，B04「可查原因」的最后一公里）

- **字段**：`NotificationPollResult.deliveryFailures: number` 与 `failures: Array<{episodeKey, taskId, reason, message, attempts}>`；单条 `PendingNotification.lastFailure?: {message, at, attempts}`（均在 `notification-center.ts`，已落地）。
- **触发位置**：`workbench-http.ts` 中调用 `notifications.poll()` 的地方（通知轮询端点 / 桌面宿主 IPC）。原样透传；如果响应是包了一层 `{ok,value}`，请把两个字段放进 `value`。
- **失败语义**：不透传时页面只能显示「稍后重试」，用户无法区分「通知服务不可达」与「降级被节流」。丢字段不报错。
- **迁移影响**：无（账本新增 `failures` 段，旧账本缺该段按空处理，已做宽松解析）。
- **最小验证**：
  ```
  cd gateway; npx tsx --test test/notification-persistent.test.ts   # 5/5
  cd gateway; npx tsx --test test/notification-center.test.ts        # 8/8
  ```
  HTTP 层加一条：让 `deliver` 抛 `Error('relay refused')` → 轮询响应 `deliveryFailures===1` 且 `failures[0].message==='relay refused'`；重开进程后再轮询仍能看到该原因。

## 5. 页面探针需要一个登记的入口（P2，否则只能手动跑）

- **请求**：在 `gateway/package.json` 增加 `"probe:pages": "node workbench/test/page-layout-probe.mjs"`（脚本本体已在 B 侧，非 `*.test.mjs`，不会进 `npm run test:workbench`）。
- **触发位置**：`scripts` 段；CI/验收脚本可按需调用。
- **失败语义**：探针在找不到浏览器时**显式失败**（`exit 1` + `browser-not-found`），不产生假通过；可用环境变量 `WORKBUDDY_PAGE_PROBE_BROWSER` 指定可执行文件路径。
- **迁移影响**：无（仅新增脚本；不新增依赖，用的是 Node 24 内置 `WebSocket` + 本机 Playwright 缓存）。
- **最小验证**：`cd gateway; npm run probe:pages` → 退出码 0，输出 `{"ok":true,"sizes":5,"failures":[]}`。

## 6. 任务面板标签变化需要 app.mjs 不要二次加工（P2，只需知情）

- **事实**：`workbench/model.mjs` 的 `stateInfo()` 现在会在「报告已到但原生停止未确认」时改写 `label` 与 `description`（`key`/`tone` 不变），例如 `running` → 「报告已到，尚未确认停止」。
- **请求**：`app.mjs` 若对 `stateInfo(...).label` 做映射或拼接，请直接使用返回值，不要按 `key` 重新生成文案，否则会出现「执行中 · 报告已到，尚未确认停止」这类自相矛盾的组合。
- **失败语义**：不做改动也不会崩，只是文案重复。
- **最小验证**：`cd gateway; npm run test:workbench`（`model.test.mjs` + `task-panel-recovery.test.mjs` 覆盖）。

---

## 不建议由 I 改动的事项（B 侧已自行完成，避免重复劳动）

- `workbench/dispatch.mjs`、`attention.mjs`、`controls.mjs`、`model.mjs`、`dispatch.css`、`controls.css`：B 线独占，已改。
- `desktop-dispatch.ts`、`project-template.ts`、`notification-center.ts`、`delivery-export.ts`：B 线独占，已改。
- `index.html` 无需新增 stylesheet：页面所需的样式都在 `dispatch.css` / `controls.css`（已被现有文档引用）。

## 与 F-CONTRACT-1 的关系

本轮 **没有** 改动 F-CONTRACT-1 的任何语义：写权限仍只来自调用方声明的结构化 `scope.allowedChanges`；新增的 `warnings` 只做**提示**，不授予权限、不放宽 `workspace-protection` 判定、不改变 `SCOPE_PATH_UNAUTHORIZED` 的触发条件。B（准入阶段拒绝无范围写任务，错误码建议 `SCOPE_NOT_DECLARED`）与 C（从正文推导写权限）仍需用户一次决定，本轮不实现。
