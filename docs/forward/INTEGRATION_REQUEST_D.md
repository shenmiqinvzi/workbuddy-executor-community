# D 线集成请求（I 侧接线）

本轮 D 线把自动政策的**观测组合根、六层边界、只读读面**做实，并在**自己拥有的组合根**（`scripts/automation.mjs` /
`src/automation-cli.ts`）上完成了「真实只读 probe → 政策评估 → 持久决定 → 原 operation → 共享 guarded send」的整链验证。
下面是把同一套东西接到**正式组合根**（`server.ts` / workbench 进程 / 统一迁移）所需的全部改动。均为 I 独占文件，本线未改。

约定：失败语义统一为「观测不到就阻塞或降级，绝不当免费、绝不静默换源或换模型、绝不把旧快照当实时」。

---

## IR-D1（最高优先）把真实只读 probe 接进工作台进程的 `AutomationService`

**现状**：`src/workbench-http.ts` 通过 `options.automation?: AutomationService` 读取投影；该实例目前由 I 侧构造，
没有传 `probe`，因此 `snapshot().probeKind === "none"`，任何真实政策在工作台只能看到「未记录观测」。
D 线已提供工厂 `createReadOnlyProbe`（`src/automation.ts` 导出，`kind:"read_only_local"`）。

**改动点**：构造该实例处（`src/server.ts`，或其调用 `new AutomationService(...)` 的位置）改为：

```ts
import { AutomationService, createReadOnlyProbe } from "./automation.js";
import { desktopModelCatalog } from "./desktop-dispatch-runtime.js";

const automation = new AutomationService(store, {
  probe: createReadOnlyProbe({
    db: store.database,                       // TaskStore 的 public getter（task-store.ts:172）
    env: process.env,
    catalog: () => desktopModelCatalog(config, process.env),
  }),
  probeKind: "read_only_local",
  armed: false,                               // 工作台进程不派工；派工只在 CLI
  // send 故意不接：没有 send 时 execute 会以 AUTOMATION_NOT_ARMED 拒绝
});
```

**字段/契约**（都是已存在的类型，无需新增 public schema）：
`AutomationProbeReport { probeVersion, readOnly:true, observedAt, policy, executors, models, sources, coverage, limitations }`，
`coverage = { executors:"observed"|"unavailable", catalog:"observed"|"declared_only"|"missing", costEvidence:"executor_catalog"|"gateway_pool"|"unavailable", tokenEstimates, creditCache, taskAttribution:"unavailable" }`。

**触发位置**：每次 `evaluate`/`decide`/`execute` 都会重新 `runProbe`（`automation.ts:1050`），不做缓存、不复用旧报告。

**失败语义**：

- 目录读面不可用 → `sources[catalog].status = "unavailable"|"unwired"|"missing"`，`assessment` 追加
  `OBSERVATION_UNAVAILABLE`（字段 `probe.catalog`），决定记 `blocked`，**不派工**；
- 资源表缺失/未声明 → `unreadable`/`not_declared`（`readQuotaResources` 抛 `resource_storage_missing` 时由 probe 捕获成状态，不外抛）；
- 不得在此路径上做任何写（probe 全程只读：不 `poll`、不 `publish`、不 `beginPoll`）。

**最小验证**：`GET /workbench/v1/automation` 返回 `probeKind === "read_only_local"`，且 `layers` 为六层对象；
随后 `npx tsx --test test/automation-http.test.ts`（8 条）仍全绿。若目录不可用，根投影的 `layers.dispatch` 仍是声明值，
但新建决定必须为 `blocked` + `OBSERVATION_UNAVAILABLE`。

---

## IR-D2 workbench 导航与 405 表：暴露只读页 + 新增 operation 子路径

**现状**：`workbench/automation.mjs`、`automation.css` 已在 `WORKBENCH_FILES` 里打包，但 `app.mjs` / `index.html` 没有导航入口；
`WorkbenchHttp.isKnownPath` 需要知道所有 automation 路径，否则写动词会得到 404 而不是 405。
本轮 `automationPaths()` 新增了一条：`/workbench/v1/automation/decisions/:decisionId/operation`。

**改动点**：

1. `gateway/workbench/app.mjs`：加一个导航项（例如「自动政策」），挂载 `mountAutomation({ root, fetchJson })`；
   深链沿用 shell 的 `#taskId=<id>`，页面里的「查看原任务」已经用该形式（`taskLink()`）。
2. `gateway/workbench/index.html` + `automation.css`：容器节点与样式（D 线已提供 `.automation-*` 类，未新增样式文件）。
3. `gateway/src/workbench-http.ts`：`isKnownPath` 从 `automationPaths()`（`src/automation-http.ts`）取全部路径，
   包含 `""`、`/policies`、`/policies/:policyId`、`/decisions`、`/decisions/:decisionId`、
   `/decisions/:decisionId/operation`、`/audit`；非 GET/HEAD → 405 + `Allow: GET, HEAD`。

**失败语义**：未配置 `options.automation` 时整个前缀 404（已有行为，测试 `without the option the automation routes do not exist` 覆盖）；
配置后写动词一律 405，绝不转发到任何服务方法。

**最小验证**：`npx tsx --test test/automation-http.test.ts`（8 条，含「every automation route refuses a write with 405, not 404」与 operation 读面）；
`node --test workbench/test/automation-view.test.mjs`（15 条）。

---

## IR-D3 共享 schema/迁移归属：四张 `automation_*` 表

**现状**：`ensureAutomationSchema(db)` 自建 `automation_meta` / `automation_policies` / `automation_decisions` / `automation_audit`，
`AUTOMATION_SCHEMA_VERSION = 1`，遇到更高版本抛 `AUTOMATION_SCHEMA_UNSUPPORTED`（HTTP 503）。L07 里这条归属仍待裁定。

**请求**：由 I 决定是（a）把四张表纳入统一迁移，`ensureAutomationSchema` 变成幂等校验，还是（b）保留模块自建但在统一迁移里声明版本。
两种都可，但**必须**明确：升级路径（`schema_version` 递增时不静默改表）、回滚语义、以及旧库补表的幂等性
（现有测试 `an old database gains empty automation tables and never an implicit authorization`、`ensureAutomationSchema is idempotent on the same connection` 已锁定行为）。

**失败语义**：库版本高于本构建 → 503 `AUTOMATION_SCHEMA_UNSUPPORTED`，不得降级猜测；缺表 → 自建，但**不得**顺带产生任何授权（`enabled` 默认 0）。

**最小验证**：`npx tsx --test test/automation-policy.test.ts`（22 条，含上述两条）。

---

## IR-D4 目录读面的宿主依赖与降级

**现状**：`desktopModelCatalog(config, env)`（B 线）需要 WorkBuddy/DSH 宿主在线；离线时返回 `diagnostics` 而非异常。
D 线的 probe 把它当唯一执行器/模型来源。

**请求**：在 I 的组合根里确认 `config` 与 `env` 是「当前安装的真实配置」，不要注入测试替身；宿主离线时保持
`catalog:"unavailable"` + 阻塞，不要回退到「用保存的政策当观测」（旧兜底已删除，`runProbe` 无 probe 时返回空观测）。

**最小验证**：断开宿主后 `decide` 应为 `blocked`/`OBSERVATION_UNAVAILABLE`；接回后同一政策可 `delegate`（价格已核验时）。

---

## IR-D5 逐任务确认提示（不改行为，只补可见性）

**现状**：`layers.taskSelection.mode = "per_task_confirmed"` 是**声明**，不是观测。当前 `AGENTS.md` 要求每个新的真实协作任务
由用户当次确认执行器/来源/精确模型/推理档/费用。

**请求**：工作台在自动政策页顶部保留这句话（D 线文案已写：「自动政策只收窄派工范围……也不替代 AGENTS.md 的逐任务选择确认」），
并且**不要**因为存在政策就跳过模型选择 UI。政策不替未来未知任务选模型。

**最小验证**：页面文本断言（`workbench/test/automation-view.test.mjs` 已含只读断言与六层断言），加上人工确认模型选择步骤仍在。

---

## 汇总：接线后即可成立的结论

- 工作台能看到真实的观测时间、来源状态、覆盖范围与「为什么不派」；
- 观测不可用时决定自动阻塞，不会把未声明当免费，也不会换源/换模型；
- 派工仍然只有 CLI 一条写入口，页面/HTTP/MCP 保持只读；
- 预算、撤回、恢复在重启后仍成立（本轮已在真实 CLI 组合根上验证，见 `D_LINE_RECEIPT.md` §5）。
