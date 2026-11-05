# L03 集成请求：统计读取面的接线点

本线（L03）新增 `usage-attribution`、`task-metrics`、`statistics-service`、`statistics-http` 四个模块和 `workbench/statistics.{mjs,css}` 页面文件；`TaskStore`、`TaskApplicationService`、统一 schema 的归属不变，仍由集成人裁决。

**第 1–4 节已在本树应用**（机械注册与只读接线，改动 6 个既有文件、69 行；集成人可原样采纳或按本节 patch 重构）。第 5 节仍是可选项；第 6 节是已用合成数据跑过的契约联调记录。

已在本树验证：`npm run build`（exit 0）、`npx tsx --test test/statistics.test.ts`（31 pass）、`test/statistics-page.test.ts`（3 pass）、全量 `npm test`（1082 tests / 1069 pass / 0 fail / 13 skipped，日志 `outputs/finish-l03-20261105/logs/full-suite-final.log`），以及 `node dist/workbench-entry.js` 的回环冒烟（`outputs/finish-l03-20261105/evidence/smoke.json`）。

---

## 1. `gateway/src/workbench-http.ts`：加两个只读路由（已应用）

**原因**：统计前缀不在分发里，任何 `/workbench/v1/statistics*` 请求都会落到 404；非 GET 请求也需要 405 + `allow` 头，否则会出现“已知路径当未知路径”。

**patch**：

```ts
// 顶部 import（StatisticsSources 是结构类型，定义在 statistics-service）
import { handleStatisticsRequest } from "./statistics-http.js";
import type { StatisticsSources } from "./statistics-service.js";

// 构造参数：现有 interface WorkbenchAdapterOptions（`gateway/src/workbench-http.ts:121`）加一个可选字段
interface WorkbenchAdapterOptions {
  service: TaskApplicationService;
  health: (service: TaskApplicationService) => WorkbenchHealth;
  requestAllowed?: /* 现有 */;
  embed?: EmbedConfig;
  /** 统计读取面；缺省时不注册任何统计路由（旧调用方行为不变）。 */
  statistics?: StatisticsSources;
}

// GET 分发：放在静态资产之后、tasks 路由之前
if (this.options.statistics) {
  const handled = handleStatisticsRequest(this.options.statistics, pathname, url.search);
  if (handled) { this.send(response, handled.status, handled.body); return; }
}

// 非 GET 的已知路径判定（现有 isKnownPath 链）
const isKnownPath = /* ... */
  || pathname === "/workbench/v1/statistics"
  || pathname.startsWith("/workbench/v1/statistics/");
```

`handleStatisticsRequest` 对非统计路径返回 `null`，因此这处调用不会截走别的路由；它对统计路径返回 `{ status, body }`，状态码已按 400/404/503 分好（`statusFor` 用小写码，body 里再大写）。

**验证**：
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:PORT/workbench/v1/statistics` → `200`
- `.../workbench/v1/statistics?limit=500` → `400`，`...?from=2026-11-05` → `400`
- `.../workbench/v1/statistics/tasks/..%2F..%2Fetc%2Fpasswd` → `400`
- `.../workbench/v1/statistics/tasks/unknown` → `404`
- `curl -X POST .../workbench/v1/statistics` → `405`，响应带 `allow: GET, HEAD`

## 2. `gateway/src/workbench-entry.ts`：注入统计来源（已应用）

**原因**：统计端点不做任何 I/O 决策，它拿到的 `StatisticsSources` 才是唯一数据入口；在这里注入可以保证 GET 不触发采集、不写库、不读 run 目录。

**patch**：

```ts
import { statisticsSources } from "./statistics-http.js";
import { attributeTaskUsageFromLedger } from "./usage-attribution.js";

// store 之后
const statistics = statisticsSources(store, (taskId, attemptIds) =>
  // 只读句柄打开同一个数据库文件；表不存在时返回 unavailable，不建表。
  attributeTaskUsageFromLedger({ file: store.file, taskId, attemptIds }));

const server = new WorkbenchHttpServer({ service, statistics, health: () => /* 现有 */ });
```

`statisticsSources(store, usageFor)` 的 `store` 是结构类型（`get/listAttempts/listTaskEvents/getContract/listTasksByCreatedCursor/reviews.list`），`TaskStore` 已满足，不需要为它新增方法或迁移。

**验证**：启动 `node dist/workbench-entry.js`，`GET /workbench/v1/statistics` 的 `coverage.tasksRead` 与库内任务数一致；请求前后 `tasks.sqlite` 的 SHA-256 不变（已实测：`c43ba262…beec` 前后一致，`-wal` 为 0 字节），且日志中不出现任何上游请求。

## 3. `gateway/src/workbench-assets.ts`：两个白名单条目（已应用）

**原因**：资产服务是精确白名单，未列出的 URL 直接 404；新页面文件必须同时登记，否则页面脚本与样式取不到。

**patch**（`assets` 对象内，另需在 `scripts/package.mjs` 的 `WORKBENCH_FILES` 加同两个名字，否则发布包一致性守卫会红）：

```ts
  "/workbench/statistics.mjs": ["statistics.mjs", "text/javascript; charset=utf-8"],
  "/workbench/statistics.css": ["statistics.css", "text/css; charset=utf-8"],
```

**验证**：`curl -sI .../workbench/statistics.mjs` → `200` 且 `content-type: text/javascript; charset=utf-8`；`.../workbench/statistics.mjs.map` → `404`；响应头 `content-security-policy` 与现有页面一致。

## 4. `gateway/workbench/index.html` + `app.mjs`：统计视图入口（已应用）

**原因**：页面模块已导出 `mountStatistics({ root, fetchJson })`，但外壳没有视图、没有导航按钮、也没有挂载点，用户点不到。

**patch（index.html）**：不新增内联脚本；样式表加一行即可（`statistics.mjs` 由 `app.mjs` import，无需 `<script>`）：

```html
<link rel="stylesheet" href="/workbench/statistics.css">
```

**patch（app.mjs）**：

```js
import { mountStatistics } from './statistics.mjs';

let statisticsView = null;
function navStatistics() {
  return h('button', { class: 'nav-button', type: 'button', id: 'nav-statistics', 'data-view': 'statistics',
    onclick: () => setView(state.view === 'statistics' ? 'tasks' : 'statistics') },
    icon('mark'), '统计', h('span', { class: 'nav-hint' }, '只读'));
}

// buildShell()：资源 nav 之后并列放一个 nav
h('div', {}, h('div', { class: 'nav-heading' }, '统计'), h('nav', { class: 'nav' }, navStatistics())),

// sheet 内、resources-root 之后加挂载点
h('div', { class: 'resources-mount', id: 'statistics-root', hidden: true }),

// setView()：把三态视图接进去（现有两态逻辑改成三分支）
function setView(view) {
  const next = view === 'resources' ? 'resources' : view === 'statistics' ? 'statistics' : 'tasks';
  /* …现有 resources 分支保留… */
  const statsHost = $('statistics-root');
  if (statsHost) statsHost.hidden = next !== 'statistics';
  if (next === 'statistics' && !statisticsView && statsHost) {
    statisticsView = mountStatistics({ root: statsHost, fetchJson: statisticsFetch });
  }
  if (next === 'statistics') {
    const title = $('page-title'); if (title) title.textContent = '统计';
    statisticsView?.reload();
  }
}
```

`mountStatistics` 只发 `GET /workbench/v1/statistics` 和 `GET /workbench/v1/statistics/tasks/:id`，不写任何状态；页面文案已声明“未测量不写 0”“空集合不等于零成本”。

**验证**：打开 `http://127.0.0.1:PORT/workbench/`，点“统计”→ 概览出现 `coverage`、逐任务 `attribution`、`usage` 按单位分行；`?limit=500` 的失败态在页面上显示为错误提示而不是空白；浏览器控制台无 CSP 违规、无内联脚本告警。

## 5. `gateway/src/task-application-service.ts`（可选，仅当要把统计暴露成 MCP 工具）

**原因**：HTTP 已经可用；若 MCP 也要读同一条聚合，建议复用同一纯函数而不是第二份实现。

**patch**：

```ts
readTaskStatistics(taskId: string) {
  const sources = statisticsSources(this.coordinator.store, (id, attemptIds) =>
    attributeTaskUsageFromLedger({ file: this.coordinator.store.file, taskId: id, attemptIds }));
  return readTaskStatistics(sources, taskId);
}
```

**验证**：MCP 端 `workbuddy_get_task_statistics` 返回的 `metrics` 与 HTTP 单任务端点逐字段相等（同一 `taskId`、同一时刻）。

---

## 6. 上游请求字段的契约联调（与 02 线）

**现状**：`parseUpstreamUsageEnvelope` 只接受 `workbuddy-upstream-usage-1`，字段闭集见 `gateway/src/usage-attribution.ts` 的 `UpstreamUsageRecord`。02 线的采集产物若字段名不同，需要一层映射，映射本身应由 02 线提供并在联调中固定。

**联调步骤**：

1. 用 02 线的合成请求记录（不接真实上游）生成一份 envelope JSON。
2. `parseUpstreamUsageEnvelope(json)` → 必须 `ok:true`；任一字段缺失/多余都要报出带 `field` 路径的失败。
3. `UsageLedger.record()` 写入同一 `sourceScope` 两次 → 第二次 `duplicate`，且 `observed_at` 保持首次值。
4. `readUsageRecords(file, { taskId })` + `attributeTaskUsageFromLedger(...)` → `attribution` 与 `coverage` 可解释（exact 需要全部测量值、全部 attempt 绑定、重试父记录在场、非共享池）。

**已验证（合成数据，`evidence/contract-envelope.json`）**：

- 3 行 envelope（worker 2048 tokens、worker 重试 512 tokens、reviewer 共享池 unavailable）解析 `ok`，多余字段 `extra` 被拒并报 `field: "extra"`；
- 第 4 次写入是 `duplicate`，因此聚合仍是 3 行、`tokens` 合计 2560（不是 4608）；
- reviewer 行 `scopeKind=gateway_pool` 触发 `shared_pool_scope`，整体级别降为 `connection_only`，`coverage.measuredRecords=2/3`；
- unavailable 行只计 `unavailableRecords=1`，`amount` 不含它，也不会写成 0 成本。

脚本：`outputs/finish-l03-20261105/evidence/contract-envelope.mjs`（对 `gateway/dist` 运行，无网络、无模型请求）。
