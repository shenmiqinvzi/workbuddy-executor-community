# 资源页前端交付记录（D3-03 并行准备）

- 日期：2026-11-04
- 工作目录：`E:\javaproject\workbuddy-parallel-resource-frontend`（独立 worktree）
- 分支：`feat/resource-center-frontend`，基线 `5f8620e`
- 本轮范围：工作台原生「资源」页前端主体。后端真实来源、任务方案关联、D3 整体阶段验收不在本轮结论内。

## 1. 页面实现

工作台左侧新增独立分组「资源」，按钮 `#nav-resources`（带「只读」小字提示）。点击后整个 `main.sheet` 进入资源视图：

- 保留现有任务、待处理、验收记录与嵌入面板的全部行为；资源视图只切换显示层，不改任何任务数据流。
- 进入资源视图时，若派工面板 `#task-compose` 处于展开态，会先点它的返回按钮恢复，避免两个页面的工具栏互相遮挡。
- 资源视图下隐藏任务页的指标卡、工具栏、任务列表/详情、页脚、来源提示、演示开关、嵌入面板、派工面板，以及 `#refresh`、`#source-badge`、`#new-task`；不会新增任何探测、刷新上游、改账号或改模型的按钮，唯一的写操作是「重新读取缓存」，它只重复调用两个 GET 接口。
- 首次进入才发起读取，之后不再自动轮询；离开页面会中止在途请求并停止更新视图。

页面结构（自上而下）：

1. 标题行：「只读资源视图」+ 模式徽标（「真实读取」/「演示数据」）+「重新读取缓存」+ 上次读取时间。
2. 一行说明：手动刷新只重新读取网关缓存，不探测上游额度。
3. 概览四格：数据来源、连接（已观测 / 已配置）、token 记录数（含截断标记）、积分池数（含部分覆盖标记）。
4. 「Token 额度」分区：每行一张卡片，展示模型、来源连接与区域、单位 `token`、值类型（估算值）、可用性（未观测到耗尽证据 / 可用性未知 / 已证实耗尽（存在触顶证据））、新鲜度、剩余/预算/已用、重置时间、来源时间、采集时间、共享范围、覆盖率（接口未提供时写「接口未提供覆盖率」）、推算方法、作用域、路由验证状态、限制与说明（可折叠）。
5. 「积分」分区：每段一张卡片，展示区域池、覆盖完整/部分/不可用、余额（`积分`，不是货币符号）、账号数据、成员最新观测、采集时间、缓存过期、缓存新鲜度、余额新鲜度、共享范围、作用域、路由验证、限制与说明。
6. 页脚列出两个只读接口路径与逐连接状态。

关键约束的落地方式：

- **null 不补零**：模型层把 `null` 留在视图字段里，页面渲染成「未提供」；`0` 与 `null` 在文案、`aria` 与统计里都分开。
- **token 与积分不合并**：没有总余额、没有换算、没有加总；积分卡片明确写「积分不是货币，也不与 token 相加」。
- **不称独占额度**：每条 token 行与积分行都带「路由验证：未核验」+「网关汇总，尚未验证为本任务可用」，页头再重复一次「不是本任务独占额度」。
- **真实失败不替换演示**：失败只显示失败卡并保留该分区上一次成功快照，标注「未用演示数据替代」；演示数据只有在左侧数据来源手动切到 `demo` 时出现，并整页显示「演示数据」横幅。

## 2. 截图

已提交（`docs/assets/`）：

- `docs/assets/t7d-resources-overview.png`：1440×980 真实读取模式，两分区正常。
- `docs/assets/t7d-resources-partial-failure.png`：积分接口 503，token 分区保留、积分分区报错。
- `docs/assets/t7d-resources-narrow-720.png`：720px 宽，导航收成抽屉、概览两列、卡片单列。
- `docs/assets/t7d-resources-demo.png`：手动切换演示数据后的横幅与标记。

完整 14 张（未提交，位于工作区外临时目录 `E:\javaproject\.dsh-resource-preview\shots\`）：含陈旧、未知 schema、空数据、双接口失败、加载中、超时、竞态、420px 窄屏、键盘进入、返回任务页。

## 3. 文件改动

新增（`gateway/workbench/`）：

| 文件 | 行数 | 作用 |
| --- | --- | --- |
| `resources-model.mjs` | 599 | 严格 schema 解析、视图投影、格式化、标签文案、读取票据（竞态保护）、采集时间漂移比较 |
| `resources-source.mjs` | 314 | 两个只读接口的读取器（超时、错误码映射、单侧失败隔离）、演示来源 |
| `resources.mjs` | 401 | 资源视图 DOM、状态机、首次加载/刷新/模式切换/销毁 |
| `resources.css` | 515 | 资源视图样式与 1100/760/480 断点，全部使用现有 `:root` token |
| `test/resources-model.test.mjs` | 203 | 13 个用例：解析、null、耗尽、未知 schema、未知限制码、覆盖率自洽、积分非货币、时间戳、竞态票据 |
| `test/resources-source.test.mjs` | 161 | 9 个用例：成功、单侧失败、未知 schema、非 JSON、断网、超时、外部取消、演示来源、错误对象 |

修改：

- `gateway/workbench/app.mjs`（+69/−9）：引入 `mountResources`；`state.view`；`navResources()`；`setView()`；侧栏「资源」分组；`#resources-root` 容器；`render()` 里的标题与 aria-current 分支；`switchSource()` 同步资源视图模式；`/` 快捷键只在任务视图生效。
- `gateway/workbench/index.html`（+1）：在 `controls.css` 之后加载 `resources.css`。

未改动：`gateway/src/`、后端测试、桌面 C#、安装脚本、快照清单、打包脚本。

## 4. 接口依赖

只使用两个既有只读接口，路径与 schema 本轮冻结：

- `GET /workbench/v1/resources/quotas` → `workbuddy-executor/quota-1`
- `GET /workbench/v1/resources/credit-balances` → `workbuddy-executor/credit-balance-1`

客户端行为：

- `GET`、`credentials: 'same-origin'`、`cache: 'no-store'`、单次 8 秒超时；两侧并行读取，任一侧失败只影响该分区。
- 错误码直接沿用网关：`INVALID_RESOURCE_QUERY`、`RESOURCE_STORE_UNAVAILABLE`、`UNKNOWN_SCHEMA`（本地判定）、`INVALID_RESPONSE`、`NETWORK_ERROR`、`RESOURCE_TIMEOUT`。
- 浏览器不能区分「未配置」与「配置了但从未采集」以外的情况；这两种由接口自身的 `status` 与空数组推断，页面文案分别为「尚未配置资源采集」与「连接已配置，但还没有观测到快照」。

## 5. 演示方式

左侧「数据来源」选择演示数据后，`switchSource('demo')` 会把资源视图切到 `DemoResourceSource`：

- 返回两份与真实 schema 同构的文档，且先经过同一套严格解析，schema 不合规会直接报错而不是渲染。
- 页面顶部固定显示「演示数据」横幅，模式徽标变「演示数据」。
- 演示数据永远只在手动选择时出现；真实接口失败时不会自动切换。

## 6. 状态覆盖

| 状态 | 触发方式 | 页面表现 |
| --- | --- | --- |
| 首次加载 | 进入资源视图 | 骨架屏 + 「正在读取网关缓存」 |
| 未配置 | 两接口都返回空 `connections` | 「尚未配置资源采集」空状态，不新建连接 |
| 已配置未采集 | 连接存在但无快照 | 「连接已配置，但还没有观测到快照」 |
| 部分失败 | 一侧 503 / 超时 / 未知结构 | 失败卡（含错误码、HTTP 状态、原因）+ 另一侧正常 + 失败侧保留上次快照 |
| 空数据 | 连接存在、观测为空 | 分区空状态 |
| 失联后旧快照 | 连接快照过期或采集报错 | 卡片标「陈旧：超出有效期或最近一次采集报错」并保留数值 |
| 未知 schema | `schemaVersion` 不符或多/少字段 | 「资源接口结构未受支持」，不渲染任何未知字段 |
| 已证实耗尽 | `availability: 'exhausted'` | 「已证实耗尽（存在触顶证据）」 |
| 演示 | 手动切来源 | 横幅 + 徽标 + 与真实结构同构的样本 |
| 乱序 | 连续两次读取 | 旧票据立即失效并中止旧请求，只有最后一次写入界面 |

## 7. 测试与验证

单元/模块测试（`cd gateway && npm run test:workbench`）：

- 全量 **91 个用例全部通过**，其中本轮新增 22 个（模型 13 + 来源 9）；其余为既有用例，未因资源页改动而调整预期。
- 构建前置：worktree 内以 junction 复用源目录 `gateway/node_modules`，再 `npm run build`（`tsc`）。`node_modules/`、`dist/` 均被 `gateway/.gitignore` 忽略，未进入提交。

浏览器验证（Chrome headless + CDP，隔离样本网关）：

- 样本网关：本地 Node HTTP，静态文件取自本 worktree 的 `gateway/workbench/`，两个资源接口返回与真实 schema 同构的样本，支持 `ok / partial / stale / unknown / empty / error / slow / race` 场景切换。
- 14 个场景断言全部通过：首次加载、部分失败、陈旧、未知 schema、空数据、双接口失败、加载中、超时、竞态（两次读取到达网关、最终只显示新值 222）、720/420 窄屏无横向溢出、键盘 Enter 进入资源视图、Tab 焦点移动、演示模式、返回任务页恢复指标与列表。
- 脚本与全量截图在工作区外：`E:\javaproject\.dsh-resource-preview\server.mjs`、`drive.mjs`、`shots\`，未纳入提交。

## 8. 未完成项与契约问题

未完成（本轮不做，留给后续阶段）：

- 任务方案关联：两个接口只有池级 `scopeId` / `modelId`，没有任务或方案维度，页面因此不展示「本任务额度」。
- 后端真实来源核对：本轮样本按现有 TypeScript 响应构造，未连真实采集器。
- 桌面壳验收：WebView2 内未验收，截图与断言只代表 Chromium 浏览器。
- 自动刷新与上游探测：按任务要求不做。

接口契约问题（记录，不自改后端）：

1. `quota-1` 没有覆盖率、账号计数与 `cacheFreshness` 字段，token 分区的覆盖率只能写「接口未提供覆盖率」；同一页两个分区的"覆盖率"含义不对等。
2. `quota-1` 的 `connections[]` 有 `collectedAt`，`credit-balance-1` 的 `connections[]` 也有 `collectedAt`，但两边 `snapshotId` 由不同采集器生成，编号天然不同。因此**不能用快照编号判断采集轮次**，本页改为比较同一连接的 `collectedAt` 差值，超过 5 分钟才提示「分区数据可能来自不同轮次」。
3. `balanceFreshness` 取值只有 `stale` / `unavailable`，没有 `fresh`；页面文案必须写成「余额新鲜度不可用：只能确认缓存时间」，不能声称整池新鲜。
4. `coverage: 'partial'` 时余额只是已知账号之和，页面已标注，但接口没有给出"缺了哪些账号"，排障信息不足。
5. `quota-1` 顶层 `truncated` 只表示本次返回被截断，不含总量，概览只能写「已截断」。
6. 两个接口都没有"是否已配置"的显式字段，空 `connections` 与"已配置但采集失败"只能靠 `status` + 数组长度推断。

## 9. 交给 Codex 的集成清单

本 worktree 分支 `feat/resource-center-frontend`，提交见文末。需要 Codex 在最终集成时补齐：

1. **静态资源白名单**：`gateway/src/workbench-assets.ts` 需要新增四条映射（本轮按约束未改）：
   - `/workbench/resources.mjs` → `resources.mjs`，`text/javascript; charset=utf-8`
   - `/workbench/resources-source.mjs` → `resources-source.mjs`，`text/javascript; charset=utf-8`
   - `/workbench/resources-model.mjs` → `resources-model.mjs`，`text/javascript; charset=utf-8`
   - `/workbench/resources.css` → `resources.css`，`text/css; charset=utf-8`
2. **快照清单**：`gateway/SNAPSHOT_MANIFEST.json` 需要登记新增的两个测试文件（`workbench/test/resources-model.test.mjs`、`workbench/test/resources-source.test.mjs`），重跑 `gateway/scripts/generate-snapshot-manifest.mjs` 生成。
3. **安装包/打包清单**：新增的四个前端文件必须进入打包产物清单，否则安装后的桌面壳加载 `resources.css` 与三个模块会 404。本轮只验证了开发目录下的静态加载，安装包可用性未验证。
4. **接口层**：本轮不需要后端改动；若后续要展示任务方案关联，需要新增接口字段，不在本轮范围。

## 10. 复现步骤

```powershell
# 单元测试
cd E:\javaproject\workbuddy-parallel-resource-frontend\gateway
npm run build
npm run test:workbench

# 浏览器验证（样本网关于工作区外）
cd E:\javaproject\.dsh-resource-preview
node server.mjs                     # 另一个终端，监听 127.0.0.1:8123
node drive.mjs                      # Chrome headless + CDP，输出 14 张截图与 report.json
```
