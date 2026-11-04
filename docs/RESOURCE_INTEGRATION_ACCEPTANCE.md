# 资源中心隔离集成验收

日期：2026-11-04。范围：D3 并行准备和隔离源码集成，不是完整 D3、D0/D1 验收、生产部署或发布。

## 版本与修改

集成目录 `E:\javaproject\workbuddy-resource-integration`，分支 `integration/resource-center`，共同基线 `5f8620e`。cherry-pick 对照：后端 `cdf4f25` → `e3e506e`、`d9ce88e` → `51159c1`；前端 `4d51174` → `043c0dd`；`668c24d`（提交正文含 `resource-review-fixes`）→ `0217f8f`。集成代码提交 `3d1bcb6`（官方资源与包）及 `e5fe890`、`3e27197`（跨端测试）。后续清单及记录提交以本分支 Git 日志为准。没有合并到主分支、推送或安装到运行环境。

官方静态映射将四个资源文件逐项列入精确白名单，发布收集将其列为必需文件；保留 CSP、Host/Origin、只读方法限制。`app.mjs` 相对导入及 `index.html` 样式引用均与实际 HTTP 路径一致。快照清单通过项目脚本按 Git 跟踪文件生成，不包含构建产物或私有数据。

两处评审问题：修复版本分别保存尝试时间与各分区成功时间；离页取消请求、使旧票据失效并在返回时重读。真实视图模块的最小 DOM 行为回归覆盖首次失败、单侧及双侧失败、保留成功时间、恢复、离页、返回、切源和迟到响应；不将此证据当作真实浏览器或 WebView2 结果。

## 最终版本自动验证

均在隔离目录，退出码 0，除特别注明：

- `npm run build`、`npm run typecheck:task-view`：TypeScript 构建及适用类型检查通过。
- `npm run test:workbench`：100/100，包括 DSH 修复版 9 条资源视图行为回归。
- `node --import ./test/support/typescript-loader.mjs --test --test-concurrency=1 test/quota-observation.test.ts test/credit-balance.test.ts test/quota-entry.test.ts test/workbench-http.test.ts test/workbench-assets.test.ts test/package.test.ts`：64/64。覆盖正式 HTTP 的四资源 200、MIME、CSP、Host/Origin、POST、未知路径、引用关系；每个资源单独缺失导致发布收集失败；以及资源采集、持久缓存、正式 HTTP 与前端真实读取器的合成跨端检查。跨端检查覆盖未配置、配置未采集、null/零、token/积分、partial、单侧与双侧存储故障、恢复和任务查询；采集器回归覆盖失联、超时、来源时间缺失/倒退/陈旧、配置轮换、乱序、重启、失败保留及 GET 不采集。页面故障保留和切源由上述视图桩回归覆盖，非浏览器端到端故障注入。
- `node scripts/generate-snapshot-manifest.mjs` 和 `node verify-snapshot.mjs`：315 个受跟踪文件，哈希和完整性检查通过；沿用已有 capturedAt，并非伪造新采集时间。
- `npm run package -- <隔离 final-release 目录>`：真实打包成功；解压后 `node scripts/verify-release.mjs` 校验 551 文件哈希，四文件实际存在。包 `evidence/final-release/codex-workbuddy-gateway-v0.7.1.zip` 的 SHA-256 为 `70c942827f1f2fb60617fdf5b14ac17aea18d66225762fb024f84093fd6d01bc`；这是本地验收包，不是发布或部署。
- `git diff --check`：退出码 0。
- `npm run desktop:build`：退出码 0，NuGet 漏洞数据服务不可访问产生 NU1900 警告；不是运行验收。`npm run desktop:test` 退出码 -1073741502，无测试通过证据。

## 浏览器、WebView2 与证据限制

官方网关 HTTP 及跨端接口已按上面自动测试；没有完成桌面宽度、720px、420px 的真实浏览器页面、键盘焦点、嵌入面板及交互验收。隔离 Chrome 调试连接未在预期时间完成，尝试已终止，未生成本轮官方链路截图。`evidence/browser-check.mjs` 是此次合成测试准备脚本，不是通过记录。

隔离 WebView2 壳构建成功，以专用 profile、数据库和运行路径尝试启动及状态查询，但状态查询未完成，关闭了本次进程；不能证明四个模块在壳内加载、导航和刷新。未改系统安全策略或生产实例。前端原提交的 `docs/assets/t7d-resources-*.png` 是前端阶段的合成样本截图，不是本次最终版本官方网关或 WebView2 验收证据，也不代表真实账户余额。

## 剩余项与进度含义

- D3-01：两端合成结构连通；当前版本真实来源授权与只读连接未核验，真实 token 链路和积分缓存联调仍待验。
- D3-02：Key 到模型、区域、执行器和任务的可信路由未核验，保留 `routing_unverified`；共享池不证明任务可用。
- D3-03：资源页及本分支源码、包集成已实现并通过上述自动测试；任务方案关联未完成。此条目的"浏览器和 WebView2 交互验收未完成"已由本文末「桌面只读修复与新候选验收」更新：在修复后的新包上浏览器 128/128、WebView2 71/71 通过。
- D3-04：缓存故障及任务查询的合成回归通过；运行中任务监督和停止的端到端故障隔离尚未验证，来源覆盖完整性也无法从现有 quota schema 证明。
- D0/D1 未自动完成，未使用模型请求或真实来源，未处理旧 P0-1 容量。实际部署、主分支合并、发布均未发生。
- 下一步：把 `c5cf788` 合入本集成分支并重建统一候选，两边在同一 SHA-256 上重跑；再按授权条件处理真实来源和路由证据，并保留 D0/D1 门槛。

## 2026-11-04 桌面实窗补充

冻结候选源码 `5104af6`，包 SHA-256 `70c942827f1f2fb60617fdf5b14ac17aea18d66225762fb024f84093fd6d01bc`。桌面策略测试在独立解包目录实际运行 70/70 通过；WebView2 独立窗口已实际打开，四个静态资源加载成功，任务/资源/嵌入面板切换及演示模式得到部分观察。但发现桌面只读存储没有 quota 与 credit 查询，两个资源接口对合成有效快照均返回 503；桌面验收未通过。成功、恢复与离页竞态等实窗场景受阻，浏览器报告尚未到位，双方版本一致性待核对。独立记录：`E:\javaproject\outputs\resource-desktop-acceptance-20261104\DESKTOP_ACCEPTANCE.md`。未改候选源码或生产环境，修复后须重新构建并与浏览器验收对齐新包。

## 2026-11-04 桌面只读修复与新候选验收

上一节的 503 现象仍是对旧包 `70c94282…` 的有效记录。本轮在独立 worktree `E:\javaproject\workbuddy-desktop-resource-fix`（分支 `fix/desktop-readonly-resources`，基线 `0bb9ffe`）修复并重打包，修复提交 `c5cf788`。

根因：桌面 `openWorkbenchReadStore()` 的只读 facade 只代理任务查询，缺 `quotas`、`creditBalances`、`operations`，共享服务调用即抛错，被资源路由统一转成 503。修复把 `readQuotaResources(db, options)`、`readCreditBalances(db, connectionId)`、`readCapacityOccupant(db)` 抽成纯函数供网关与桌面共用，缺表抛 `resource_storage_missing:<table>`（不谎报空集合或空闲容量），facade 不构造任何 store，因此开窗不建表、不生成盐、不登记连接、不写容量行。三条路径与 `quota-1`、`credit-balance-1`、`capacity-1` schema 未改。

新候选包：`codex-workbuddy-gateway-v0.7.1.zip`，552 文件，SHA-256 `60b79f56f738c995cbda9117a009fa1b2aa3697efe672a69d68b1b95782358ce`；`verify-release.mjs` 校验 552 文件哈希一致，退出码 0。与旧包相比只多一个文件（新增回归 `test/desktop-readonly-resources.test.ts`）；版本号相同，必须按 SHA-256 区分。旧包与旧解压目录未被覆盖。

自动验证（均退出码 0）：`npm run build`；`desktop-readonly-resources` 回归 13/13（修复前 stash 该改动为 2 通过 / 11 失败，证明回归确实依赖修复）；`npm run test:workbench` 100/100；隔离 env 下 `npm test` 910 tests / 898 pass / 0 fail / 12 skipped；`npm run desktop:test` 70/70；`git diff --check`。

同一个包上的交互验收：浏览器（官方 `WorkbenchHttpServer` + 精确白名单 + 真实存储 + 隔离合成行）128 项全通过，退出码 0，覆盖 1440×1000、720×1000、420×900 与 200% 模拟缩放；WebView2 实窗 71 项全通过，退出码 0，覆盖真实读取、单侧/双侧失败与恢复、成功时间不被失败请求覆盖、离页取消、返回重读、真实↔演示切换、嵌入面板、键盘、窄窗口、容量 `occupied:null`、关闭后 host 停止与重开后仍为真实读取。两份报告的 `source.commit` 均为 `c5cf788`、`package.sha256` 均为 `60b79f56…`，可证明是同一个包。

本轮未做：真实上游来源与真实账号、可信路由、任务方案关联、D3-04 停机隔离、D0/D1 与正式发行；200% 缩放是 CDP 模拟而非系统 DPI。细节与复现命令见 `docs/RESOURCE_DESKTOP_READONLY_FIX.md`，证据在 `E:\javaproject\outputs\resource-desktop-fix-20261104`。未推送、未合入本集成分支、未部署。
