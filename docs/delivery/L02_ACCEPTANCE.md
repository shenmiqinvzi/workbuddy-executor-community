# L02 验收记录：可信资源来源、路由证据与故障隔离

- 线：L02（可信资源来源 / 路由 / 故障隔离），对应 D3-01、D3-02、D3-03、D3-04 与 C08–C11、C15，兼顾 03 请求归因接口（D6-01 的接口面）。
- 工作树：`E:\javaproject\workbuddy-finish\L02-resources`，分支 `feat/finish-l02-resources`。
- 基线提交：`1f60374a889ae5acb442affff7a59f3e045a1277`（`chore: 建立 G0 统一开发基线`），基线 tree `a45970de95336ed79d99b835fc582d467d9e2e7d`。
- 开工核对：`git rev-parse HEAD`、`git rev-parse HEAD^{tree}`、`git rev-parse --abbrev-ref HEAD` 与给定值一致，`git status --porcelain` 为空。
- 本线提交见外部 `HANDOFF.json` 的 `commits` 字段（提交后写入最终 SHA）。本记录只覆盖源码与本地合成验收，未合入集成源、未部署、未发布。

## 1. 范围与边界

本线交付的是**只读资源视图的可核验化**：固定连接登记、三层证据分层、请求归因能力缺口、快照归档，以及证据分区与额度/积分分区之间的故障隔离。

明确不做的事：

- 不代理任意 URL。所有来源读取仍然只经 `LocalStatisticsClient` 的三个固定只读路径（`/usage/remaining`、`/v1/balance-summary`、`/v1/models`），且来源地址强制为回环 HTTP 源。
- 浏览器/桌面壳不持有管理 Key。声明文件里只登记环境变量名与“是否在进程中设置”，页面只显示变量名。
- 不读现有账号配置猜测连接。连接登记只来自显式声明的 `WORKBUDDY_RESOURCE_CONNECTIONS_FILE`；未声明就是 `not_declared`。
- 不把声明升级成路由证据。`layers.configuration`、`layers.executionSelection`、`layers.requestRouting` 三层各自带 `verified:false`，`routingVerified` 恒为 `false`。
- 不改任务状态与来源，不自动停任务，不因资源故障写库。证据与额度读取都是 GET，零模型请求、零任务写入。
- 不伪造请求归因。上游载荷没有请求标识时，`requestAttribution.status` 恒为 `unavailable`，`fields`/`optionalLinks` 全 null，并给出 10 条转 10 真实验收的待办。
- 不探测真实 Key、不跑真实模型、不改生产配置（归 10）。

## 2. 变更文件

新增源码（`gateway/src/`）：

| 文件 | 职责 |
|---|---|
| `resource-connections.ts` | 固定连接声明登记与解释性诊断（`workbuddy-executor/resource-connections-1`） |
| `resource-attribution.ts` | 请求归因能力缺口契约与用量单位守卫（`workbuddy-executor/request-attribution-1`） |
| `resource-snapshot-store.ts` | 证据快照归档、摘要校验、凭据拒存（`workbuddy-executor/resource-snapshot-archive-1`） |

修改源码：

| 文件 | 改动 |
|---|---|
| `gateway/src/local-statistics-client.ts` | 抽出并导出 `loopbackOrigin()`，构造器复用同一判定，行为不变 |
| `gateway/src/resource-routing.ts` | `buildRoutingEvidence()` 增加可选 `context`，追加 `layers`、`connectionRegistry`、`connectionDiagnostics`、`requestAttribution` 四块；既有字段与既有 `limitations` 数组不动 |

新增测试：

| 文件 | 用例数 |
|---|---|
| `gateway/test/resource-connections.test.ts` | 12 |
| `gateway/test/resource-attribution.test.ts` | 7 |
| `gateway/test/resource-snapshot-store.test.ts` | 9 |
| `gateway/test/resource-trust-http.test.ts` | 4 |
| `gateway/workbench/test/resources-trust.test.mjs` | 10 |

前端（资源页第三个分区，属本线文件）：

| 文件 | 改动 |
|---|---|
| `gateway/workbench/resources-model.mjs` | `parseRoutingDocument`、`buildTrustView`、层/状态/冲突/诊断/归因标签表、缺失限制码补全 |
| `gateway/workbench/resources-source.mjs` | `readRouting()`、`demoRouting()`、`DemoResourceSource.readRouting()`、端点表增加 `/routing` |
| `gateway/workbench/resources.mjs` | `trustSection()`、`layerCard()`、`connectionRow()`、`diagnosticRow()`、`knownAtRow()`、`applyRouting()`、`render()` 追加第三分区、数据来源切换时重置证据状态 |
| `gateway/workbench/resources.css` | 证据分区样式与 720 以下单列布局 |
| `gateway/workbench/test/support/mini-fetch.mjs` | 三路由桩（quota / credit / routing），routing 可独立失败 |

未改共享入口：`gateway/src/workbench-http.ts`（HTTP 注册由集成人所有，`/workbench/v1/resources/routing` 已经存在且无参数）、`gateway/src/task-application-service.ts`（薄委托不需要改签名）、`gateway/src/workbench-entry.ts`、全局导航与页面外壳。需要集成人处理的文档面见第 8 节。

## 3. 契约

### 3.1 固定连接登记（`workbuddy-executor/resource-connections-1`）

入口：环境变量 `WORKBUDDY_RESOURCE_CONNECTIONS_FILE` 指向的本机 JSON 文件；只读，不轮询、不探测。

- 文档键：`schemaVersion`、`connections`、`note`。
- 连接键：`connectionId`、`resource`（`quota`/`credit`）、`sourceUrl`、`realm`（`cn`/`intl`/null）、`pools`（`pool-<32 hex>`）、`models`、`shared`、`declaredAt`、`credentialEnv`、`note`。
- `sourceUrl` 必须是显式回环 HTTP 源（`http://127.0.0.1:<port>/` 或 `http://[::1]:<port>/`，无路径、查询、片段、用户信息）；否则 `source_url_invalid`。
- `credentialEnv` 只接受 `{ apiKey?: "ENV_NAME", panelToken?: "ENV_NAME" }`，只输出变量名与 `present` 布尔；内联凭据值或凭据形字段一律拒收（`inline_credential_rejected` / `credential_reference_invalid`），文件里出现密钥即整文件 `invalid_file`。
- 状态：文件级 `not_declared` / `declared` / `invalid_file`；连接级 `declared` / `ambiguous` / `invalid`。
- 冲突：`duplicate_connection`、`duplicate_pool_declaration`、`realm_conflict`、`shared_flag_conflict`；命中冲突的连接降为 `ambiguous`，不择一。
- 固定边界（写在 `restrictions` 里）：`loopbackOriginOnly`、`fixedReadPathsOnly`、`arbitraryUrlProxy:false`、`browserManagerKey:false`、`credentialValuesExposed:false`、`credentialSource:"environment_reference_only"`。
- 诊断对比（`connectionDiagnostics`）：`declared_and_observed`、`declared_not_configured`、`declared_no_snapshot`、`declared_pool_not_observed`、`observed_pool_outside_declaration`、`realm_mismatch`、`declared_model_not_observed`、`credential_absent`、`declaration_invalid`、`declaration_ambiguous`、`observed_source_error:<code>`，外加未声明但已观测的连接（`undeclaredObserved`）。诊断只解释，不重写声明或观测。

### 3.2 三层证据（`buildRoutingEvidence` 追加字段）

```
layers.configuration      code=connection_pool_model        level=gateway_observation_only  verified=false
layers.executionSelection code=execution_selection_declaration level=declaration_only       verified=false
layers.requestRouting     code=actual_request_routing       level=unavailable               verified=false
                          reason=upstream_payload_lacks_request_identity
```

- `executionSelection` 的来源仍是 `WORKBUDDY_RESOURCE_LINKS_FILE`（既有 `plan-resource-reference` 契约），本线没有改写选择流程，也没有新增关联字段。
- 代理背后的真实模型保持未知：`model_scope_unverified`、`modelAggregate` 粒度不变。
- 新增块不改变原有 `mappings[].level`、`connections[]`、`unresolved[]`、`invalidatesOn[]`；旧消费者按原字段读取仍然成立。

### 3.3 请求归因能力缺口（`workbuddy-executor/request-attribution-1`）

- 现状：`/usage/remaining` 与 `/v1/balance-summary` 的载荷只有「账号 × 模型」聚合，没有 task / session / provider / request 标识。
- 所以 `requestAttribution` 的 `fields.*` 与 `optionalLinks.*` 全为 null，`knownAt` 只把 connection / pool / modelAggregate 标为已知。
- `doesNotProve` 与 `integrationTodo`（10 条）随文档一起返回，作为转 10 真实验收的清单，而不是“以后再说”的注释。
- `normalizeAttributionUsage()` 给 03 用：没有单位就不接受数值（`unit_missing`），单位不在 `tokens`/`credit` 表里就 `unit_unsupported`，绝不把两种单位相加。

### 3.4 快照归档（`workbuddy-executor/resource-snapshot-archive-1`）

- `saveResourceSnapshot({directory,kind,document})`：规范 JSON（键排序、无空白）→ SHA-256；文件名 `<kind>-<UTC>-<digest12>.json`；临时文件 0600 + `rename` 原子落盘；单份上限 4 MiB。
- 凭据拒存：键名命中凭据模式（`credentialEnv`/`credentials` 引用子树与 `envVar`/`purpose`/`present` 白名单除外）或值形如 `Bearer …`/`sk-…`/`AKIA…`/`xox…` 时 `status:"refused"`，不写文件。
- `readResourceSnapshot(file)` 校验摘要与 schema：`ok` / `not_found` / `unreadable` / `corrupt` / `digest_mismatch` / `schema_unsupported`，篡改能被发现。
- `listResourceSnapshots(dir)` 按文件名倒序；目录不存在返回空数组，不创建目录。

## 4. 验证命令与结果

全部命令在 `E:\javaproject\workbuddy-finish\L02-resources\gateway` 下执行；日志在 `E:\javaproject\outputs\finish-l02-20261105\logs\`。

| # | 命令 | 退出码 | 结果 | 日志 |
|---|---|---|---|---|
| 1 | `npm ci --no-fund --no-audit` | 0 | 按本树 `package-lock.json`，新增 100 包，未改版本 | 终端（`workbuddy-finish` 树内） |
| 2 | `npm run build`（`tsc -p tsconfig.json`） | 0 | `dist/` 生成 | `final-build.log` |
| 3 | `npx tsx --test test/resource-routing.test.ts test/resource-routing-consistency.test.ts test/resource-fault-isolation.test.ts test/plan-resource-reference.test.ts test/plan-resource-reference-conflicts.test.ts test/plan-reference-loader.test.ts test/resource-source-acceptance.test.ts` | 0 | tests 88 / pass 88 / fail 0（基线） | `baseline-resource-suites.log` |
| 4 | 10 个资源套件（含 quota/credit/desktop-readonly/source-acceptance） | 0 | tests 132 / pass 132 / fail 0 | `resource-suites-after-routing-extension.log` |
| 5 | `npx tsx --test test/resource-connections.test.ts test/resource-attribution.test.ts test/resource-snapshot-store.test.ts test/resource-trust-http.test.ts` | 0 | tests 32 / pass 32 / fail 0 | `new-suites-final.log` |
| 6 | `npx tsx --test test/**/*.test.ts`（全量） | 0 | tests 1081 / pass 1069 / fail 0 / skipped 12 | `final-gateway-suite.log` |
| 7 | `node --test workbench/test/*.test.mjs` | 0 | tests 113 / pass 113 / fail 0 | `final-workbench-suite.log` |
| 8 | `dotnet run --project desktop/test/PolicyTests.csproj --configuration Release` | 0 | `{"passed":70,"failed":0}` | `final-desktop-policy.log` |
| 9 | `node scripts/build-desktop.mjs` | 0 | 桌面壳构建产出 `desktop/app/WorkBuddy.Workbench.exe` | `desktop-build.log` |
| 10 | `node scripts/run-trust.mjs`（真页面 + 真桌面宿主 + 合成 DB/声明，Chrome CDP） | 0 | checks 38 / failed 0 | `final-browser-trust.log`、`browser\reports\browser-trust.json` |
| 11 | `node scripts/run-webview.mjs`（真 WebView2 桌面壳窗口，合成 DB/声明） | 0 | checks 13 / failed 0 | `webview-trust.log`、`browser\reports\webview-trust.json` |

测试环境口径（每次测试前）：清空本线设置的 `WORKBUDDY_*`，只保留 `WORKBUDDY_CLI_ELECTRON=<fixture>\WorkBuddy\WorkBuddy.exe`、`WORKBUDDY_CONFIG_DIR=<fixture>\workbuddy-config`、`NO_PROXY=127.0.0.1,localhost`；DB/runs/状态目录由各夹具自建（`mkdtemp` 或场景目录），只删自己建的目录。

## 5. 合成展示

浏览器（`browser\shots\`）：`S1-declared-observed-1440.png`、`S1-declared-observed-720.png`、`S2-declaration-conflict-1440.png`、`S3-inline-credential-refused-1440.png`、`S4-not-declared-1440.png`、`S4-not-declared-720.png`、`S5-evidence-failure-1440.png`、`S6-demo-mode-1440.png`。

桌面壳（`browser\shots\`）：`W1-desktop-declared-observed.png`、`W2-desktop-720.png`、`W3-desktop-trust-section.png`（滚到证据分区的定格，三层卡片、声明与观测对比、请求归因缺口同时可见）。

场景与结论：

- S1 声明与观测一致：三层齐全且顺序为 configuration / executionSelection / requestRouting，每层带「未核验」，页面不出现「已验证」，`登记 2 条 · 可用 2 条 · 需核对 0 条`，凭据只显示变量名。
- S2 同池多区域冲突：声明冲突被列为冲突且连接为歧义；观测不被声明改写，三层仍在。
- S3 声明内联凭据：声明被判无效，诊断行给出“凭据引用必须写成环境变量名”，页面始终不回显该值，两个读数保留。
- S4 未声明：`尚未声明固定连接`，已观测连接列入未声明列表（只转写连接标识，不出现 `[object Object]`）。
- S5 证据接口 503：只有证据分区失败，额度与积分保留上次成功快照，不出现“两个分区都失败”，也不自动切演示数据。
- S6 演示模式：三层仍在、仍标「未核验」，页面标注演示数据。

网络事实：整个浏览器场景共 19 次 `/workbench/v1/resources/*` GET，全部打向 workbench 本机端口（routing 的一次 503 是脚本故意制造的失败），零上游请求、零模型请求；桌面壳场景同样只访问本机 workbench 端口。

## 6. 失败历史（按发生顺序）

1. **全量测试环境歧义**（`full-suite.log`）：172 个用例失败，报错统一为 `Error: Multiple WorkBuddy installations or data directories found; set WORKBUDDY_CLI_ELECTRON and WORKBUDDY_CONFIG_DIR explicitly.`。本机有多套 WorkBuddy 安装，必须显式给两个路径；建 `fixture\` 后重跑。
2. **夹具变量泄漏**（`full-suite-fixture.log`）：1 个用例失败（`workbench-http.test.ts:474`，`entry subprocess did not answer on port 19627; last: status 400`）。该用例故意不设 `WORKBUDDY_RUNS_DIR` 来验证默认 runs 目录，外层设置泄漏进去。改为全量时不再设置 `WORKBUDDY_DB_FILE` / `WORKBUDDY_RUNS_DIR` 后全绿（`full-suite-fixture2.log`）。
3. **TS2552**：`loopbackOrigin()` 重构后残留 `baseUrl: url.origin`，`npm run build` 报 `src/local-statistics-client.ts(29,59): error TS2552: Cannot find name 'url'`；改为 `baseUrl: origin`。
4. **凭据拒存误判**：`findCredentialLeaks` 把 `credentialEnv.apiKey` 当成凭据键，导致含凭据引用的证据文档无法归档。改为在引用子树内只查值、不查键名，并保留对 `Bearer`/`sk-` 形态值的拦截。
5. **归因文档自伤**：`requestAttribution` 的 `observedPayload.token` / `.credit` 键名命中凭据键模式，路由证据无法存档；键名改为 `tokenFields` / `creditFields`。
6. **可用计数偏乐观**：`connectionDiagnostics.summary.usable` 原只按声明状态统计，缺 Key 仍算可用；改为“声明有效且不是 `credential_absent`”才计入，`flagged` 随之校正。
7. **测试自身口径错误**：合法声明用例漏传凭据环境（导致 `present:false`）；`realm_mismatch` 用例把“声明池未命中”当成区域冲突，改为“命中声明池但观测到不同区域”。
8. **浏览器首跑 6 项失败**（两处真实前端缺陷 + 三处夹具/断言错误）：`已观测到但未声明的连接：[object Object]`（`buildTrustView` 直接透传对象数组，已改为连接标识）；`未识别的诊断码（credential_reference_missing 等）`（标签表缺 11 个实际产出的码，已补齐 21 个）；夹具的 quota 连接漏 `credentialEnv`、credit 连接多声明 `models`；S3 期望文件级 `inline_credential_rejected` 而实际是字段级 `credential_reference_invalid`；S2 断言文案不精确。修复后 38/38。
9. **`models_not_supported` 过宽**：原先只要 credit 连接出现 `models` 就报错，空数组也报。改为只有非空列表才报，并补一条回归用例。
10. **桌面壳自建 exe 无法启动 WebView2**（见第 7 节），改用既有打包壳 + 本树网关完成桌面壳合成展示。

## 7. 局限与外部条件

- **没有真实来源授权**：`WORKBUDDY_QUOTA_*` / `WORKBUDDY_CREDIT_*` 全部用合成值或不设置，D3-01、D3-02 的实机部分是待外部条件项，不是已通过项。
- **没有真实模型请求**：本线不派工、不探测模型，`liveVerified` 为 false。
- **请求归因仍是能力缺口**：上游载荷没有请求标识，这是上游契约限制，不是本线未完成；10 条待办已随响应返回。
- **桌面壳自建 exe 的环境限制**：本机用 `desktop:build` 产出的 `WorkBuddy.Workbench.exe` 启动时，WebView2 用户数据目录创建被拒（`System.UnauthorizedAccessException: Access to the path '…\<InstanceKey>\WebView2' is denied.`），预建目录后改为 `COMException (0x8000FFFF)`；同一台机器上用 2026-11-04 打包壳（同一 WinForms 外壳）指向本树网关则可以正常起 WebView2 并完成 13 项检查。桌面壳源码本身未改，`PolicyTests` 70/70 通过。该限制记入 `externalConditions`，不影响页面与接口证据。
- **`WORKBUDDY_PYTHON`** 是本机既有环境变量（`F:\pythonw.exe`），不属于测试夹具，未清空；测试不依赖它。

## 8. 需要集成人接线的事项（integration-request）

1. `docs/INTERFACE_CONTRACT.md`：补 `/workbench/v1/resources/routing`、`/credit-balances`、`/plan-reference` 三行候选接口说明，并记录本次追加的 `layers` / `connectionRegistry` / `connectionDiagnostics` / `requestAttribution` 四块字段与“三层都 `verified:false`”的约束。文档由集成人所有，本线不改。
2. 配置面：`WORKBUDDY_RESOURCE_CONNECTIONS_FILE` 需要出现在面向操作者的配置说明里（与既有 `WORKBUDDY_RESOURCE_LINKS_FILE` 同段）。本线只读该变量，不写统一配置入口。
3. `docs/STATUS_INDEX.md` 或批次进度：把 L02 的“源码 + 合成 + 窗口”状态与“真实联调待外部条件”分开记录。

HTTP 注册不需要新增：`/workbench/v1/resources/routing` 已由集成人在 `workbench-http.ts` 注册，本线只是让它的响应体多了四块证据字段，既有测试（含桌面一致性）全绿。

## 9. 真实联调准备清单（转 10）

1. 授权窗口内确认本机 hub：`http://127.0.0.1:8788/`，`pythonw.exe wb_proxy.py --port 8788`，只在回环监听。
2. 面板 token：`POST /panel/login` 取 `X-Panel-Token`（TTL 7 天、重启失效）；令牌只放进程环境，不落盘、不进声明文件。
3. 先 dry-run：`node scripts/resource-source-acceptance.mjs --check --source both`，确认参数、回环地址与凭据存在性；再 `--execute`（只读 GET，不触发模型）。
4. 声明文件写两个固定连接（quota / credit），`sourceUrl` 只用 `http://127.0.0.1:8788/`，`credentialEnv` 写变量名；页面应显示“已声明固定连接 + 已观测快照”，三层仍标「未核验」。
5. 反向用例：401/403（`source_unauthorized`）、面板 token 过期、区域错配（`realm_mismatch`）、同池重复声明（`duplicate_pool_declaration`）、上游超时（`source_timeout`）。每一种都要求：任务列表仍 200、任务状态与 attempt 不变、证据分区单独失败。
6. 归因验收：若上游仍无请求标识，`requestAttribution.status` 必须保持 `unavailable`；若上游新增字段，按 `integrationTodo` 逐条落地后再把状态改为可用，并在同一次提交里更新契约。
7. 快照留证：对一次真实 `/resources/routing` 响应做 `saveResourceSnapshot()`，确认 `digest` 与重读一致、文件里不含凭据，再归档到证据目录。
8. 环境：`WORKBUDDY_CLI_ELECTRON`、`WORKBUDDY_CONFIG_DIR` 必填；回环访问加 `NO_PROXY=127.0.0.1,localhost`。

## 10. 运行与部署状态

- 源码：已提交到本线分支（见 `HANDOFF.json`），未合入集成源，未 push。
- 合成验收：通过（本记录第 4、5 节）。
- 真实模型/真实来源：未执行（外部条件）。
- 部署/发布：未部署、未发布；`deployed=false`、`releaseReady=false`。
