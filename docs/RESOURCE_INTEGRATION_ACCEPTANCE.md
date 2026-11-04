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
- D3-03：资源页及本分支源码、包集成已实现并通过上述自动测试；任务方案关联、真实浏览器和 WebView2 交互验收未完成。
- D3-04：缓存故障及任务查询的合成回归通过；运行中任务监督和停止的端到端故障隔离尚未验证，来源覆盖完整性也无法从现有 quota schema 证明。
- D0/D1 未自动完成，未使用模型请求或真实来源，未处理旧 P0-1 容量。实际部署、主分支合并、发布均未发生。
- 下一步：在能运行浏览器和 WebView2 的隔离环境，对本集成版本完成三种宽度、键盘、导航、刷新/故障恢复与桌面壳资源加载验收；再按授权条件处理真实来源和路由证据，并保留 D0/D1 门槛。
