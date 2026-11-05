# 后端开发进度

更新日期：2026-11-04。本页区分源码能力、自动验证和运行部署。

**后续开发任务已建立**：从 `5f8620e` 基线按[开发规划 D0–D7](FUTURE_DEVELOPMENT_PLAN.md)逐项推进。任务总表维护状态，本页按同一编号追加实际提交、验证、部署情况和剩余动作；规划不代表功能已经交付。下一轮从 D0-01 版本核对、D0-02 验收矩阵、D0-03 交付范围与补验判定开始。

**当前状态（2026-11-04 收尾）**：源码与发布副本一致，技能说明已按程序口径改写（原生停止证据不再拿 `end_turn` 与队列取消充当证明），待处理卡片的报告认证改读真实结构 `presentation.report.authentication`；本机已有一个真实 DSH 派工样本走完“派工—认证报告—原生停止—不可变 reviewId 验收”，但该样本 `requiredChecks=[]`、走本机应用服务路径、单机隔离，因此**不等于** MCP 端到端、复杂功能、扣费或异机验收已验证。历史各段的结论按当时证据保留，后续进展写在对应日期里并标注替换关系。


## D3 资源中心隔离集成（2026-11-04）

源码实现并入独立 `integration/resource-center` 分支：资源页、后端故障隔离、官方资源白名单和本地发布包；修复失败时间误标及离页未取消请求。最终版本工作台 100/100、后端及官方 HTTP/发布相关 64/64，构建和类型检查通过；本地验收包通过 551 文件哈希核验。仅合入该隔离分支，未合入主分支、未部署、未发布。

D3-01 真实来源未验；D3-02 Key 路由未核验；D3-03 任务方案关联及真实浏览器/WebView2 交互未完成；D3-04 运行中监督与停止故障隔离未完成。D0/D1 门槛不变。完整版本、命令、证据和限制见 [资源集成验收记录](RESOURCE_INTEGRATION_ACCEPTANCE.md)。
## 本分支 T7D（开发与补验中）

PR #22 为草稿；2026-11-02 核对 head `34fcb1b` 的 Windows CI 成功，尚无提交的 PR 审查。桌面停止、返工、独立审查与验收已有源码及隔离验证，真实独立窗口样本覆盖审查、验收、停止和重开；返工目前是模拟执行器证据。原真实模型补验在原生准备阶段结果不明，无记录 attempt 或完整准备回执，不能据此推断无副作用，也没有真实报告、原生停止及最终验收。只读准备阶段诊断已接入；原任务及容量继续保留。2026-11-02 已按“证据充分、仍不确定”收口（副作用不可排除、容量不释放、不关闭不重派），见[T7D P0-1 原任务裁决记录](T7D_P0_1_ORIGINAL_TASK_DECISION.md)。P0-3 源码层已交付：原生准备协议事实写成常量、失败路径追加只读探针、查不到不当作未创建，见[T7D P0-3 原生准备协议](T7D_P0_3_NATIVE_PREPARATION_PROTOCOL.md)。P0-5 方案与只读预检已就位（单机隔离账本，容量被占即停），见[T7D P0-5 独立真实验证方案](T7D_P0_5_INDEPENDENT_VERIFICATION_PLAN.md)。

2026-11-03 平台边界与全量口径：P0-2→P0-5 已在本机落地为一次提交（分支 `feat/t7d-p05-uncertainty-fence`，提交 `b010855`，139 files +5531/−339；该分支随后做过一次历史重写，把作者机器路径从提交内容中移除，行数按重写后的提交重新统计），未推送、未合并、未安装。本机 `npm test` 由 856 条 / 844 通过 / 6 失败 / 6 跳过（基线 `34fcb1b` 为 810/787/17/6）变为 **856 / 844 / 0 失败 / 12 跳过，退出码 0**。原 6 条失败是平台差而非缺陷：其中 5 条把宿主注册表写成 `*.sock` 并用 mode/uid 判私有（`deepseek-client.test.ts` 四处、`deepseek-server.test.ts` 一处），而 Windows 的宿主是命名管道、私有性由 ACL 检查（`dsh-transport.test.ts` 覆盖该分支），`net` 也无法在 Windows 监听套接字路径；另 1 条驱动 `bin/workbuddy-*` 的 `#!/bin/sh` 启动器（`launcher.test.ts`），Windows 没有无扩展名文件的 shebang 解释器和执行位。这 6 条已按仓内既有的 macOS 跳过约定改成显式平台跳过并写明原因；此前 `windows-gateway.yml` 只跑显式文件清单，这三份文件不在任何 job 里，等于本机之外从未被执行。新增 `.github/workflows/posix-bridge.yml` 在 ubuntu 上运行这三个文件，否则“跳过”就是把断言删掉。该 job 随后在 PR #23 上首次运行即失败，暴露出真实缺陷，见下一段；跳过不等于已通过，这三份用例在 Windows 上本次未被实际执行。顺带修掉一个更要紧的空洞：`verify-snapshot.mjs` 只校验清单里列出的条目，不校验跟踪文件是否都在清单里，所以落地那次报 564 / true 时其实有 3 个 `dist/native-stop-declaration.*` 未入清单。清单已重新生成为 567 条，校验器增加与 `git ls-files` 的集合比对并输出 `manifestCompleteness: checked`；漏记和多记两种情形都实测能报出文件名，非 git 检出时返回 `unavailable`，不假装通过。
2026-11-03 POSIX bridge 首次远端运行与换行修复：`POSIX bridge` 在 PR #23 上首次运行就失败在测试步骤，原因是真实缺陷而不是断言写错。`gateway/.gitattributes` 用 `* -text` 保留快照原始字节，于是 8 个 `bin/workbuddy-*` 的 `#!/bin/sh` 启动器与 `.env.example` 都以 CRLF 入库；在 Linux 上首行变成 `#!/bin/sh\r`，exec 直接报 `spawn ... ENOENT`，而 `.env` 被 source 之后每个值尾部带 CR，`WORKBUDDY_OAUTH_SCOPES` 这类含空格的引号值随之错位。也就是说这些启动器在 POSIX 上从未真正执行过，问题一直被"Windows 跳过"掩盖。修法：`bin/*`、`scripts/*.mjs`（全部是 `#!/usr/bin/env node`）和 `.env.example` 改为 `text eol=lf`，`bin/*.cmd` 保持 `-text eol=crlf`；7 个 `scripts/*.mjs` 只有换行变化（`git diff --ignore-cr-at-eol` 无内容差异）；清单按新字节重新生成仍是 567 条，`capturedAt` 与上游 provenance 保持不变。新增守卫用例直接读字节，出现任何 CR 即失败，因此在 Windows 检出上同样会报警，不依赖"能在哪个平台执行启动器"。验证：Linux 容器（`node:24-bookworm`，`npm ci` + `npm run build`）跑这三份文件 8/8 通过；本机全量 `npm test` 857 条 / 845 通过 / 0 失败 / 12 跳过，退出码 0；`verify-snapshot` 567 / hashesMatch true。未做 macOS 运行，也未在 POSIX 主机上验证已安装包。

2026-11-03 Windows 打包失败与机器路径清理：`Windows gateway` 在 PR #23 上测试全部通过，失败在最后的 `Package desktop workbench`。`scripts/package.mjs` 的 `assertSafeContent` 拒绝发布包含私有机器路径的文件，这次拒得对：P0 批次在本机取证时把作者本人的 Windows 账户目录（形如 `C:\Users\<user>\.workbuddy-ai`）、一个只有本机才存在的状态目录（形如 `<workroot>\_wb-p05-state\...`）和另一个盘符上的客户端路径写进了 `gateway/test/desktop-worker-env.test.ts`，`gateway/src/coordinator.ts` 的诊断分支也把日志写死在同一棵树的固定路径下，于是发布物既含作者账户名，也含读者机器上不存在的盘符。诊断日志改为 `os.tmpdir()`；夹具换成 `D:\state\...` 与 `C:\Program Files\工作区\...`，空格、撇号与非 ASCII 的引号覆盖保持不变；四份 P0 验证记录里的人名与盘符同样中性化。构建产物与快照清单同步更新（仍 567 条）。发布包已能在本机生成（`workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip`，536 files，1,927,997 字节），全量 `npm test` 857 / 845 / 0 / 12，退出码 0；随后该提交在 PR #23 上 `Windows gateway` 与 `POSIX bridge` 均通过。未在已安装的 POSIX 包上运行，异机验收仍未做。

2026-11-03 编译产物出库：`gateway/.gitignore` 早就写着 `dist/`，但索引里仍强制跟踪着 270 个编译产物——每次改源码都要重提交一批可再生成的文件，而“提交的 dist 与源码一致”只能靠维护者的纪律维持。现在改为：`dist/` 不入库，由 `npm run build` 从 `src/` 与 `package-lock.json` 生成；快照清单按跟踪文件重新生成为 **297 条**（原 567 条里有 270 个是 `dist`），`capturedAt` 与上游 provenance 不变，`exclusions`/`notes` 里写明编译产物不再入库及其来源。`verify-snapshot.mjs` 增加硬约束：索引里只要出现 `dist/` 下的文件就报 `Build output is tracked again: ...`（实测 `git add -f` 一个 `dist` 文件即红，撤回即绿）。CI 里原来的 `git diff --exit-code -- dist` 换成 `node scripts/package.mjs <tmp>`：从干净构建出发打一次发布包，`package.mjs` 的必需文件清单会拒绝缺任何一个 `dist` 条目的包，比“比较已提交的字节”更贴近要防的事。验证：`verify-snapshot` 297 / true / checked；`package.test.ts`、`deployment.test.ts`、`mcp-entry.test.ts` 24/24；本机 `node scripts/package.mjs` 产出 release 与两个技能包。仍未做：干净克隆上走一遍 clone → `npm ci` → `build` → `test` 的完整路径（CI 覆盖，本机不重复）。

2026-11-03 独立复审四项修复：用同模型（`gpt-6.1-sol`、只读）对本分支做了一次独立审查，除已修的 `attention.mjs` 缺失外，另指出四处“文档说得比代码更硬”的地方，均已改掉。其一，桥接层的零费率规则可以被降级：`configurePolicy` 只拦“把已有模型限制改空”，同一模型再传 `false` 就能把 x0 关掉；现在已开启就必须保持开启，且 `nativeModelPolicy()` 在旧的 `WORKBUDDY_REQUIRED_FREE_MODEL` 存在时，`WORKBUDDY_PINNED_MODEL` 只决定用哪个模型、不再顺手取消零费率要求。其二，预检在“库在但没有 `workflow_capacity` 表”时把 `occupant` 留空并照样给出 `ready:true`，错库或旧库因此是绿灯；现在表缺失直接进 blockers（`capacity_table_missing`），容量观测值报 `unknown`，不再等于 `free`。其三，验证声明只看证据值非空：`identity_mismatch`、`reviewer=executor`、`error` 这类值会被说成“身份一致”“存在非执行者审查”；现在失败值不算证据、`reserved_session` 必须是 UUID、给不出执行者身份时只能说“记录到一份审查结论”，身份一致性只在两份证据指向同一 UUID 时才敢声明。其四，发布面隐私检查只认 `/Users/` 且密钥检查只对 `.env.example` 生效：现在 `C:\Users\<acct>`、`/home/<acct>` 一并拒绝（`example`、`Public`、`<user>` 等占位名仍放行），所有 `.env*` 与 `*.example` 模板都检查非空密钥——`WINDOWS_ENV.example` 属于此列。文档口径同时校正：`b010855` 按重写后的提交记为 139 files +5531/−339，`dist/` 出库后也不再声称“干净检出可直接运行已提交入口”。验证：本机全量 `npm test` **870 / 858 通过 / 0 失败 / 12 跳过，退出码 0**（新增 7 条用例覆盖上述四处），`verify-snapshot` 298 / hashesMatch true，构建退出码 0。

2026-11-04 可选的嵌入面板与桌面壳白名单：这个仓库要发给别人用，所以这里只提供机制，不提供任何具体页面的地址。需要看自己本地面板的人设置 `WORKBUDDY_WORKBENCH_EMBED_URL`（可选 `WORKBUDDY_WORKBENCH_EMBED_TITLE` 改侧栏与标题、`WORKBUDDY_WORKBENCH_EMBED_ORIGINS` 追加额外来源），不设置就完全没有这一栏、也不内嵌任何页面，与之前行为一致。挡路的是两条既有设计：桌面壳 `Program.cs` 的 `FrameNavigationStarting` 取消**所有**子框架导航，`WebResourceRequested` 对 `/workbench/` 之外的请求一律回 403，于是 iframe 在 WebView2 里必然空白——此前用无头 Edge 打开同一页面却能正常渲染，那条"已验证"结论就是这样被推翻的，教训是壳内行为只能在壳里验。改法是把放行做成显式白名单而不是删掉防护：`DesktopOptions` 增加 `EmbedOrigins`，来源只有两个——`WORKBUDDY_WORKBENCH_EMBED_ORIGINS` 的逐条解析，以及面板 URL 自身的 origin；两者都只接受 http + 回环主机（`127.0.0.1`/`localhost`）、且 origin 条目不得带路径、查询、片段或用户信息，去重后只留 authority；`AllowsEmbed(target, method)` 要求 method ∈ GET/HEAD/POST、scheme 为 http、authority 与白名单逐字相等。默认列表为空即维持"全部取消 + 403"。同样的来源集合也决定 CSP：`workbench-assets.ts` 的 `frame-src` 在无配置时是 `'none'`，有配置时逐个列出，避免出现"桌面壳放行、页面 CSP 却拦住"的两套口径。前端不再硬编码地址：启动时 GET `/workbench/v1/embed`，由网关回答有没有面板、叫什么、什么 origin，没有就隐藏侧栏入口；iframe 首次切到该视图才设置 `src`，8 秒仍未加载则显示"请确认 <origin> 上的服务正在运行"；嵌入视图下 `.sheet` 转为纵向 flex，面板铺满标题区与页脚之间。另加仅用于取证的 `WORKBUDDY_WORKBENCH_DEBUG_PORT`（1..65535，默认不设）给 WebView2 传 `--remote-debugging-port`。按 CONTRIBUTING 对执行约束改动的自审：不触碰任务状态机、不写库、不放宽 `AllowedRequest` 既有的 `/workbench/` 前缀与同端口约束，只在一个维度上新增默认关闭的口子——"子框架 + 跨源"；iframe 内容是另一台本机服务自渲染的页面，工作台不读它的 cookie、也不向其注入脚本。验证：`dotnet run --project desktop/test/PolicyTests.csproj -c Release` 70/70（原 52 + 白名单 12 + 面板 URL 派生 6）；新增 `test/embed-panel.test.ts` 9/9（未配置不内嵌、URL 自带 origin、标题回退与截断、非 http/非回环/带凭据/带查询一律拒绝、`localhost` 可用、额外来源严格解析去重、HTTP 端点与 CSP 两套口径、POST 405）；`node --test workbench/test/*.test.mjs` 63/63；`tsc -p tsconfig.json` 退出码 0；本机全量 `npm test` 881 / 868 通过 / 1 失败 / 12 跳过，唯一失败是 `bounded-command.test.ts` 在整轮高负载下等不到子进程 pid 文件（单文件复跑 6/6 通过），属于既有的时序敏感用例而非本轮改动；`node verify-snapshot.mjs` 在重生成清单后 298 / hashesMatch true / manifestCompleteness checked。真实窗口取证用 CDP 在 WebView2 内切到该视图再截图，面板完整渲染并随窗口伸缩；同一条路径在改动前是空白。环境注意：本机同时存在两个 WorkBuddy 数据目录（`.workbuddy` 与 `.workbuddy-ai`），未显式指定 `WORKBUDDY_CONFIG_DIR` 时 `loadConfig` 会按"多份安装/数据目录"直接抛错，上面的全量数字是在 shell 里显式设置 `WORKBUDDY_CLI_ELECTRON` 与 `WORKBUDDY_CONFIG_DIR` 后取得的（生产 `.env` 一直显式指定）。仍未做：异机与签名发行未验证；嵌入页面自身的登录态由该页面自己管理，强制结束窗口会丢它的 cookie。

2026-11-04 执行器选择与面板展示：目标是把"这次派给谁"变成可确认、可核对的事实，而不是从任务名或会话猜。三处缺口分别补上。其一，面板此前只把 `binding.runtimeSource` 映射成一句 `desktop_queue→WorkBuddy / dsh→DSH` 的文字，`desktop_interactive` 落不到任何执行器，`filters.executor` 是个没有控件的死字段；现在 `model.mjs` 用 `executorKey()` 统一判身份（`dsh`、`desktop_queue`/`desktop_interactive`、其余归 `unknown` 并显示"来源未提供"），筛选、行内徽章、详情与"本轮记录"里的执行器/原生会话共用同一判定，`executorBreakdown()` 给出按当前搜索与状态过滤后的计数，选中项即使计数为 0 也保留 chip，避免筛空后无法切回。其二，技能此前没有任何发现入口：`dsh-inspect.ts` 只是 CLI，Codex 拿不到 hostId 与 sessionId，也就无法真的把任务交给 Harness。新增 `src/dsh-discovery.ts` 把发现做成只读事实——`summarizeDshHosts()` 丢掉 `socketPath` 与 token 只留 hostId/profile/version，`dshExecutorSummary()` 区分 `adapter_disabled`（网关没开）、`native_bridge_not_registered`（开了但没有活着的桥）与 `ready`，`defaultHostId` 只在显式指定且该桥活着、或唯一 host 时才给，绝不回退到别的桥；`dsh-inspect.ts` 改为复用同一实现，两处口径不会再漂。MCP 面新增两个只读工具：`workbuddy_list_executors`（WorkBuddy 后端 + DSH 适配器状态，描述写明"可用不等于报价、不等于已派工"）与 `workbuddy_list_dsh_sessions`（按项目绝对路径列实时会话，返回 `matched`/`ambiguous`/`no_matching_live_session`/`registry_missing`）。其三，DSH 派工卡在授权而不是传输：`DshTaskCoordinator` 只接受带 `execution` 的 vnext-2 契约，而 `CollaborationRegistry.prepare` 在 `selectionMode=user_choice` 下要求计划已授权，创建/授权计划是 `TaskApplicationService` 上的本地信任接缝，从不在 HTTP 或 MCP 暴露。因此新增 `src/plan.ts` + `scripts/plan.mjs`（`register` / `create` / `authorize` / `show`）：agent 可以起草提案，但授权必须由本机操作者执行并给出 source，`revision` 变了、条款变了或过期都是 PLAN_STALE。这条接缝刻意不加进工具面——让 agent 能自己授权等于把"用户确认"这一环删掉。文档同步：`SKILL.md` 新增「执行器选择」小节（含 DSH 不许带 `model`/`scope`/`constraints`/`acceptanceCommands`/`timeoutSeconds` 与 `sessionMode=new`，否则 TASK_CONFLICT），`references/dispatch.md` 新增「指定 DSH 执行器」三步流程，`references/setup.md` 那句"本技能当前工具仍为 desktop-queue，不能假称已具备 DSH MCP 派工"按代码现状改写，`.env.example` 补上 `WORKBUDDY_DSH_*` 四个变量与授权说明。验证：`tsc -p tsconfig.json` 退出码 0；新增 `test/dsh-discovery.test.ts` 5/5（去重、丢死桥、不泄露 token 与管道名、三态、defaultHostId 四态、session 发现含过期租约）、`test/plan-cli.test.ts` 4/4（相对路径拒绝、同 id 换目录拒绝、未授权计划 authorizedAt 为空、错误 revision 与空 source 各自失败、vnext-1 提案被拒）；`node --test workbench/test/*.test.mjs` 64/64（新增执行器身份与筛选一条）。未做：真实 DSH 派工未执行——本机桥已注册并能列到 40 个模型（含 `wb-proxy/*`），但生产 `.env` 仍是 `WORKBUDDY_DSH_ENABLED=0`，打开开关与真实派工属于另行授权的一次执行，不在本轮源码改动内；面板未用真实 DSH 任务的截图取证，展示逻辑只用合成记录覆盖。（本段这句“真实 DSH 派工未执行”与“面板未用真实 DSH 任务截图取证”已被同日的隔离样本与真实窗口取证替换，见下文「真实 DSH 派工的隔离样本」；本段保留当时的结论与授权边界。）

2026-11-04 桌面不确定状态的真实窗口回归与三个面板缺陷：R12（`run_orphaned`）与 R2（`waiting_stop` 的人工确认入口）此前只有单元测试和读侧派生，缺一次真实窗口里的取证。为不碰正在用的生产库，这次用隔离夹具：借生产 `dist` 的 `task-store`／`coordinator.runEvidenceDigestOf`／`report-authentication.reportDigest`／`desktop-dispatch-runtime.desktopJournal` 造三条任务和一条派工租约（`p06-waiting-stop`：`needs_review` + 认证报告 + `nativeStoppedAt` 为空；`p06-orphaned`：`working` + 无报告 + `owner_pid=999999`；`p06-accepted` 作对照），再用 `WORKBUDDY_DB_FILE`／`WORKBUDDY_RUNS_DIR`／`WORKBUDDY_DESKTOP_STATE_DIR` 起第二个桌面实例。桌面壳的 `InstanceKey` 由网关目录、数据库、运行目录三者哈希得出，换库即换实例，因此隔离窗口与生产窗口的单实例锁互不干扰，生产库一个字节没动。真实窗口里逐行点开两张卡片读到：`p06-orphaned` 的 `data-reason="run_orphaned"`、标题「运行已无人管理（派工进程已退出）」、why 里带 `owner_pid 999999`；`p06-waiting-stop` 的 `data-reason="stop_unconfirmed"`、标题「报告已到，原生停止未确认」、why 里写明停止记录时间为空，并带人工声明入口。回归顺带暴露三个真实缺陷，都是单元测试看不见的那类。其一，`attention.mjs` 的 `factRows()` 里读 `record.view?.dispatchLease`，而 `record` 在那个函数作用域里根本不存在，于是「核对当前证据」在任何卡片上都会抛 `record is not defined`——按钮看得见、点了没用。其二，`renderAttention()` 判断是否显示声明入口时写的是 `view.remoteStopped === false`，`view` 同样不存在；`stop_unconfirmed` 因为有 `||` 短路才没炸，任何"报告到了、停止证据不全"的 `review_pending` 卡都会直接抛错。其三，核对成功后立刻 `refresh(record.taskId)` 重渲染，把刚展开的证据表整份抹掉，等于修好前两个错之后仍然看不到任何事实。改法：`factRows(value, record)` 显式传参；把判断与事实组装提成两个可测的纯函数 `offersDeclaration(reason, record)` 与 `evidenceFacts(value, record)`，`renderAttention` 只负责渲染；核对成功后不再重渲染（记录没变，重渲染只会丢证据），声明入口成功后仍然刷新。验证：`node --test workbench/test/*.test.mjs` **66/66**（新增 2 条覆盖两个纯函数的无参/无 view/四种 reason 组合）；修后在真实窗口复验，两张卡片的事实表分别 11 行与 10 行，orphaned 那张含「派工租约 dispatching · abandoned/owner_exited · owner_pid 999999 · 心跳 2026-11-04T07:18:43.277Z」，控制台无异常，截图留在取证目录（不在仓库内）。修复同步到了生产安装目录的 `workbench/attention.mjs`（与开发仓哈希一致）。仍未做：额度扣费实测（`x0.08` 只是报价）、真实 DSH 派工，两者都要另行授权。

2026-11-04 停止证据与报告认证的口径修正：技能说明第 4 节原写“WorkBuddy 认 end_turn 与队列取消”，与程序不符。按 `gateway/src/run-journal.ts` 的 `hasNativeStopEvidence()`，WorkBuddy 的停止证据只有两种落法：`nativeStoppedAt` 带 `nativeStopSource=native_idle`（原生会话经检查确认空闲后才写入），或 `nativeStopSource=not_dispatched`（从未被原生领取，含领取前取消）；历史记录另有 `stopReason ∈ {native_idle_verified, native_failure_verified, native_idle_without_report}` 三个等价标记。源码注释写明 worker 的 `end_turn`/`blocked`/`failed`/`cancelled` 报告不是这种证明；原生失败路径还要求 `nativeFailure → stopControl` 的完整时间链与至少两次空闲观察。DSH 侧按 `dsh-coordinator.ts` 与同一函数：`dsh.requestId` 必须等于本轮 `attemptId`、`dsh.sessionId` 等于快照 `sessionId`、`hostId` 非空，terminal 事件带 `seq` 与可解析时间，`rawType` 为 `turn/end`（completed/failed/cancelled）或 `type=cancelled` 且 `rawType=agent/inbox/spliced`，且 `nativeStoppedAt` 与事件时间逐字相等、`nativeStopSource=dsh_terminal_event`。SKILL.md 已按这套事实重写，只改文档，没动程序里的停止、身份、验收或容量约束；发布副本 `gateway/skills/workbuddy-executor/SKILL.md` 同步为同一字节。另一处：待处理卡片的 `attentionReason()` 读 `view.presentation?.report?.authentication` 与 `view.reportAuthentication`，而面板记录的是 `presentation.report.authentication`（`model.mjs` 的 `proofs()` 也这么读），于是已认证的报告在 `waiting_stop` 卡上显示“认证：未提供”。改为导出的纯函数 `reportAuthentication(record)`，只认 `authenticated`/`unauthenticated`，缺失或结构不对一律“未提供”，不按正文存在推断；测试夹具同时从 `view.reportAuthentication` 移到真实位置，避免“测试通过、界面照错”。验证：`node --test workbench/test/*.test.mjs` 69/69（新增 3 条：`waiting_stop` 读真实结构、缺失与 `unauthenticated` 不冒充通过、纯函数只认记录结构）；证据展开、人工声明入口、核对后证据不消失这三条既有行为由原有用例继续覆盖。

2026-11-04 真实 DSH 派工的隔离样本：上一段写的“真实 DSH 派工未执行”现在有一个真实样本，事实与边界一起记。样本走的是已安装网关的本地应用服务路径：用桥的 `create` 在专用工作目录自建 Harness 会话，本机操作者授权计划（`scripts/plan.mjs` 的 create/authorize 同一接缝），再投递 vnext-2 契约（`execution.executorId="dsh"`、`providerId`/`modelId` 明确、`scope` 只给一个文件）。15 秒内走完 `queued → working → needs_review`。只读复核结果：账本里 `runtimeSource=dsh`；报告 `state=authenticated`（`reportDigest` 与运行证据正文一致）；`stop.proven=true`、`dsh.requestId` 等于本轮 `attemptId`、`nativeStopSource=dsh_terminal_event`、`executionStatus.remoteStopped=true`；交付文件由被派的 Harness 会话自己写出（三行，回读校验）。随后走 T6 全链：`reviewChecks` 的 `$provenance`、`$scope` 独立通过 → 不可变 `reviewId` → `acceptReview`，任务终态 `accepted`、`task_closed`。四点边界必须一起读：①原约定 `requiredChecks=[]`，没有命令或语义必需检查，这份样本只证明“派工—报告—原生停止—独立验收”这条链路成立，不证明复杂功能；②走的是本机应用服务（`TaskApplicationService`）路径，不等于当前聊天 MCP 的端到端派工已验证；③单机隔离样本（独立账本、独立运行目录、独立桌面实例）不等于异机验收，第二台物理机仍未做；④模型目录 40 项全部 `credits:null`、`pricingVerified:false`，报价不等于实际扣费或免费证明。顺带记录一条运行约束：`workspace-protection` 的清单在目录条目超过 4 万或耗时超过 15 秒时报 `SCOPE_SCAN_LIMIT`，因此体积很大的仓库根目录不能直接当工作区，派工前要先选一个小目录或新开会话。取证用隔离账本启动的第二个桌面实例（`InstanceKey` 由网关目录、数据库、运行目录派生，换库即换实例），生产窗口与生产库未动；窗口里该任务显示 DSH 徽章、执行报告来源认证通过、原生停止已确认、独立验收已通过。路径按脱敏写法：账本 `<STATE_DIR>/tasks.sqlite`、运行证据 `<STATE_DIR>/runs/<ATTEMPT_ID>/state.json`、交付文件 `<WORKSPACE_DIR>/report.md`、截图留在取证目录不入库。仍未做：真实 MCP 端到端派工、扣费实测、异机验收。

后续按照 [T7D 开发与验收计划](T7D_DEVELOPMENT_PLAN.md) 分开处理原任务取证、桌面不确定状态、安全可靠性、本机审查命令和另行授权的独立真实验证。预览、完整验收、合并、安装与正式发布分别判定；是否改变原补验交付条件须用户在证据明确后决定。已有预览包未自动更新日常安装。

## 本分支 T7C

T7B 已由 PR #20 合入 main `144a520`。本机技能、主 MCP 与独立桌面入口已统一到已验证安装和同一现代任务库；两个历史库按真实编号只读定位，原模型限制与绝对证据路径保持不变。当前聊天 MCP 重加载后的代码哈希、原历史及真实补验身份均已核对。新的 WorkBuddy 单轮 range 样本 accepted、closed、原生停止确认，八项独立检查通过；关闭并重开工作台仍定位原任务，没有重派。详见 [T7C 统一入口与验证归属](T7C_UNIFIED_ENTRY.md)。源码、远端 CI 和合并分别记录，本机部署不自动代表正式发行。

新增真实 stdio 双进程冷启动回归，覆盖原任务身份、模型选择准入及不可变 review 参数；本机构建和现有路由回归通过。没有改变 UI、执行协议、历史任务状态或免费政策；异机、签名发行、自动调度与计量另验。

## 已完成 T7B

T7A 已由 PR #19 合入 main `4037112`。T7B 增加独立桌面任务准备、明确来源/模型/推理选择、未知费率披露、原生确认和持久唯一回执。执行仍通过原有准入、共享容量和范围保护，公共 HTTP 不开放写入口，详见 [T7B 流程与边界](T7B_DESKTOP_DISPATCH.md)。

本轮使用标记的隔离项目、任务库和假执行器完成真实 WinForms/WebView2 窗口流程：取消不调用，明确确认后立即关窗，独立后台完成一次合成派工；重开丢弃浏览器存储后仍恢复原任务/操作，显式观察不重复准备或投递。实窗发现并修复中文 stdio 编码与 DPI 下确认按钮裁切。合成原生确认不代表真实模型验收；未升级原桥接、技能或既有政策，派工默认关闭，真实部署和补验另行确认。

10月31日后续：经本轮模型/范围明确授权，在独立现代库完成 WorkBuddy 单次真实补验，任务 accepted、closed、原生停止确认，五项独立检查通过。关窗重开保持原身份，没有重复派工，见[脱敏补验记录](T7B_LIVE_ACCEPTANCE_2026-10-31.md)。检查器路径错误保留并修正；受理回执提示已改为不随最终验收状态失真的说明。旧库和独立库的技能查看定位采用显式只读路由，原模型政策保持不变；源码合并和本机入口切换分别核验。

T4A/T4B 及前序依赖已通过 PR #10–#15 按序合入 main，最终 T4 合并提交为 `b37e972`，文件树与已验收的 `0bce733` 完全一致。真实领取提示的 validationRecords 修复、WorkBuddy 原队列恢复后交付、DSH 按时交付和共享容量/关闭证据均保留，详见 [集成交付记录](T4_COMPLETION_2026-10-27.md)及[脱敏验收摘要](T4B_LIVE_ACCEPTANCE_2026-10-27.md)。源码阶段、仓库合并、正式发布和安装部署分别登记。

T5 工作区文件保护源码及 WorkBuddy/DSH 本机真实补验已完成，两端均 accepted 并关闭，详见 [实现边界](T5_WORKSPACE_PROTECTION.md)和[脱敏验收摘要](T5_LIVE_ACCEPTANCE_2026-10-27.md)。两端真实样本分别绑定各自候选，政策路由修复的最终回归、远端 CI 与主干合并独立登记。仓库集成与验证归属见[T5 交付记录](T5_COMPLETION_2026-10-28.md)及 PR #16。T6 后端审查与最终验收已随 PR #17 合入 main `0e9d96b`；WorkBuddy 与 DSH 官方来源在该运行代码上完成新的本机补验，均 accepted 并关闭，见[T6 交付记录](T6_COMPLETION_2026-10-29.md)和[脱敏补验摘要](T6_LIVE_ACCEPTANCE_2026-10-28.md)。原代理失败及检查器错误保留；源码、自动验证、仓库集成和真实补验分别登记。正式发布部署及异机另验，T7 尚未交付。

## 本分支 T7A

真实只读工作台已实现：同源静态界面、独立版本 panel-1 视图、任务列表/详情、已存报告与不可变审查、文件范围和跨轮次事件。默认读取网关保存的事实，明确区分收到报告、原生停止和最终验收；演示数据需主动切换。桌面主从视图、窄屏分区、搜索/筛选/游标加载及旧快照保留已接入，见[运行与接口说明](T7A_READONLY_WORKBENCH.md)。stage-2 的未知字段保持原语义，GET 不触发同步、检查、模型或数据库写入。

本机浏览器读取的是 T6 历史库的独立备份，原库只读，未重新派工模型。合成截图、临时 SQLite/HTTP 测试和真实历史读取分别记录，不称为新的原生执行验收。仓库 CI、合并和正式部署独立核验；T7 的用户模式、自动调度、计量与发布验证仍未交付。

## 已合并基础

main 已在原 `7c9bece`（PR #9）基础上整合 T1/T2、T3 的协作基础及 T4A/T4B。原有 Windows 路径、启动、共享任务、只读投影、报告认证和初始 TaskContract 保留；契约准入、持久操作、共享容量和人工恢复已接入受控执行链。T5 增加文件保护，T6 增加共用独立检查、不可变审查与最终验收；完整面板和自动策略属于 T7，不代表完整 vNext 已交付。

## 本分支 T1 / T2

| 阶段 | 实现 | 边界 |
|---|---|---|
| T1 统一只读查询与 HTTP | 稳定 createdAt/taskId 游标列表、详情、health；loopback 绑定、Host/Origin 校验、失败保留 | 不包装 MCP get_task 的同步入口，不启动原生执行 |
| T2 持久事件 | SQLite 跨轮次 eventId、原生日志去重、逐条消息内容与语义事件；终态后持久推进原生消费游标 | 来源依赖受控同步，不是原生推送；缺少真实来源的事件不伪造 |
| T2 revision | 创建即保存随机 token；任务、验收条件及运行证据变化更新版本；无变化同步稳定 | GET 零写入，证据领先返回 EVIDENCE_STALE，同轮次并发更新返回 READ_CONFLICT |
| 关闭一致性 | 验收状态、review 事实及 task_closed 同事务提交；重复终态同步共享去重键 | 取消请求不等于原生停止，须有停止证明后关闭 |

HTTP schema 为 `workbuddy-executor/stage-2`，不是完整 `workbuddy-executor/vnext-1`。接口、游标、错误和未知字段见[阶段说明](WORKBENCH_STAGE_HTTP.md)，完整目标见[接口契约](INTERFACE_CONTRACT.md)。export/workspaces 仍为 501，HTTP 没有派工、返工、取消、审查或验收写入口。

## 验证与构建

`gateway/test/evidence-consistency.test.ts` 将独立验收标准纳入仓库：真实 HTTP 的证据领先拒绝、首次同步前执行完成、第二 SQLite 连接并发写入、同步后版本前移和稳定性、取消记录版本绑定、已绑定文件缺失、身份变更。它与事件、游标、原子回滚、报告认证回归一起进入 Windows CI。

标准检查：

```powershell
cd gateway
npm run build
npm run typecheck:task-view
node --import ./test/support/typescript-loader.mjs --test test/evidence-consistency.test.ts test/task-store.test.ts test/coordinator.test.ts test/task-application-service.test.ts test/workbench-http.test.ts
node scripts/workbench-smoke.mjs
node verify-snapshot.mjs
```

本次集成实际重新构建 dist、生成清单并核对重复构建，支持干净检出执行 `npm run build` 后再运行入口（编译产物自 `997b992` 起不再入库，索引里出现 `dist/` 会被 `verify-snapshot.mjs` 直接拒绝）。清单保留上游 provenance，不把本次提交冒充上游版本。检查结果属于具体提交，远端 CI 是否通过以对应运行记录为准。Windows Job/进程清理等环境敏感测试的历史失败不删除，未运行项目不计为通过。

## 后续顺序

2026-10-25 源码阶段记录：T3a 契约准入与 T3c 只读资源基础已实现，详见[T3a 边界](T3A_DISPATCH_ADMISSION.md)、[token 观测](T3C_QUOTA_OBSERVATION.md)和[积分缓存](T3C_CREDIT_BALANCE.md)。积分链路当时已完成本机真实只读联调，token 管理统计尚未验证。T3b 共享任务适配与 Windows 桥接源码已实现，见[T3b 说明](T3B_DSH_ADAPTER.md)；随后另行获批安装与真实会话执行的结果见上方 10月27日更新。T4A 持久操作与共享容量见[T4A 边界](T4A_OPERATION_ADMISSION.md)；T4B 原操作恢复见 [T4B 边界](T4B_OPERATION_RECOVERY.md)；T5–T7 仍待独立交付。总体目标见[协作设计](COLLABORATION_DESIGN.md)、[接口扩展](INTERFACE_CONTRACT.md#8-多-agent-扩展草案vnext-2待实现)与[验收场景](ACCEPTANCE.md)。

1. T3a：初始契约接入真实派工，绑定 workspaceId、有效轮次预算、固定期限；新增协作方案和版本化模型政策。旧 vnext-1 摘要保留，vnext-2 由显式版本分派解析。
2. T3b：共享 TaskStore 的 DSH 适配、精确会话发现、Windows named pipe、模型读回/请求层证据和取消/返工/独立验收的受控 SDK 已实现；宿主隔离加载与合成执行不替代真实模型验收。新增 HTTP 写入口、完整恢复和前端未交付；插件自动审查故障保留。
3. T3c：token 估算 quota-1 与独立的 credit-balance-1 缓存汇总接口已实现；[积分链路](T3C_CREDIT_BALANCE.md)已用本机 DSH 四个既有来源完成真实只读联调，去重为两个区域池。真实 token 统计、完整 Key 路由、前端及单任务费用仍未验收；不把共享缓存称为独占/实时余额。
4. T4A：SQLite 操作准入、显式 send/rework 预期版本、元数据方案操作、模型准备前共同占用、跨连接/进程竞争与保守崩溃状态已实现。cancel/respond/reconcile_report/accept 尚未具备完整新版操作契约；原生回执和人工恢复由 T4B 补充。HTTP 继续只读；本机共享容量结果见本次真实验收摘要。
5. T4B：原队列/DSH 回执恢复、人工授权审计、原子关闭/释放、永久关闭围栏及本地交互控制台已接入；历史缺证和停止不明仍保留占用。MCP 仅查询/显式观察，HTTP 无新写入口。本机原队列恢复续跑、人工关闭及幂等已有真实证据；不等于每个真实 DSH 恢复故障均已触发。
6. T5：文件范围清单、越界变更检查与用户原有改动保护源码已实现，两执行器采用相同准入与验收规则；真实补验、部署另记，不宣称 OS 沙箱。
7. T6：共用持久不可变 reviewId、独立程序/人工检查、当前约定/attempt/执行来源/文件证据绑定与最终 accept 已实现并合入主干；受控 SDK/MCP 可用，HTTP 继续只读。新的 WorkBuddy 与 DSH 官方来源本机小样本均 accepted 并关闭；原代理失败及检查器错误单列，正式部署和异机未执行，见[T6 阶段说明](T6_INDEPENDENT_REVIEW.md)、[交付记录](T6_COMPLETION_2026-10-29.md)和[补验摘要](T6_LIVE_ACCEPTANCE_2026-10-28.md)。
8. T7：面板真实读取、手动/推荐/自动三种模式、可解释调度、完整请求归因后单任务计量、发布版本核验与真实桌面/异机验证。

任何 HTTP 写入口及停止、费用、预算、排他、范围规则变更，须在对应约束具备后单独验收。源码提交不自动升级已安装技能或运行网关。

模型选择采用用户优先：先展示实际可用模型及已知费用，再由用户选择、确认后派工；不默认固定模型，不强制免费。付费或费用未知均须用户了解后确认；历史任务和已有部署主动设置的免费限制不自动取消。后端默认政策与仓库技能同步落实此规则，完整面板选择器仍属 T7。额度来自目标 DSH → WorkBuddy2API → 上游账号池链路，不把网关总量视作 DSH 独占余额。自动模式不授权提交、推送、部署或原生权限批准；这些仍按用户实际授权执行。

## 外部验证

[前端 Issue #6](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/6)和[异机验收 Issue #3](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/3)独立跟踪。已有历史正常任务/同任务返工反馈不能替代当前版本完整安装、取消后停止、执行中重连、升级卸载和登录自启的证据。

会话导航可见性、旧离线诊断及真实环境验证仍需按实际样本核对。本分支的合成 native actor、SQLite 和 HTTP 测试不代表真实桌面或异机验收。

## T7A 桌面外壳补充

已实现 Windows x64 独立窗口、技能启动入口、单实例任务定位及桌面专用 SQLite 只读服务。源码构建和基础测试通过；正常用户目录中的预览安装已通过真实 WebView2 渲染、同窗口定位、导航和写请求限制、窗口关闭及自有查看服务退出检查。本机技能已接入独立查看入口，保留原有执行与模型规则，原执行网关未升级。异机安装仍待验证。见 [桌面运行与边界](../gateway/docs/WORKBENCH.md)。

## T7D 第一梯队（2026-11-03）

P0-2 与 P0-4 已按 [P0-5 独立验证计划](T7D_P0_5_INDEPENDENT_VERIFICATION_PLAN.md) §11 风险表落地，全部为读侧/前端改动，无新 HTTP 写入口：

- R12 运行孤儿证据：`leaseByTask` 按 taskId 读派工租约，`settleDispatch` 判定后把 `dispatchLease`/`runOrphaned` 附加进 stage 视图，面板对 `abandoned`（主人进程退出且无回执）显示"运行已无人管理"卡片；`stuck`（心跳过期）与探测失败不定罪。
- R2 停止出口：`waiting_stop` 卡片补阻塞原因与核对/人工声明入口；`review_pending` 且停止证据不完整的变体同挂声明入口；修正报告认证字段的读取路径。
- P0-4 桌面体验：任务列表 ↑/↓/Home/End 键盘导航与移动详情 Escape 返回；≤760 断点 metrics 两列、证明单列，≤480 断点事实表/检查/文件行单列化；实时源读失败后按 2s→30s 退避自动重试（至多 5 次），`online` 事件立即重读，错误横幅显示重试进度。

验证：gateway 后端 872 tests / 860 pass / 0 fail / 12 skipped（`WORKBUDDY_BACKEND=cli`），workbench 前端 63 tests / 63 pass，`npm run build` 与 `typecheck:task-view` 通过。改动未提交、未安装；真实窗口回归属 P0-6。

## P0-6 完整真实验证 run（2026-11-03）

run16（独立账本 `<STATE_DIR>\run16`）：glm-5.3-flash（x0.08，模型读回+费率披露后用户选定）真实派工 → 71 秒完成 → **完整验收链首次全通**：程序检查（$provenance/$scope passed）→ 独立检查（artifact 哈希入账）→ 不可变 reviewId（check-1 semantic passed）→ `workbuddy_accept_task` → **state=accepted**。artifact 逐字节核验（26 字节，hexdump 一致）。详见 [P0-5 独立验证计划 §10.6](T7D_P0_5_INDEPENDENT_VERIFICATION_PLAN.md)。派工确认走内容指纹（digest 含随机 UUID 每次必变，内容一致作为授权锚）；原生客户端自动确认协作计划。剩余不可主张：额度扣费（报价而已）、异机验证（Issue #3）。

## 发布（2026-11-03）

- CI：0282c72 补交 SNAPSHOT_MANIFEST.json（R12 改了 7 个源文件，清单未再生成导致 "Verify source snapshot" 红）；重跑后 posix/gateway 双 job 绿。
- 合并：PR #23（base 为 stage-2 分支 feat/t7d-desktop-controls，merge cf0bb9d）→ PR #24 把该分支合入 main（merge 47f9886）。main 现含 T7D 全部改动；本地 feat/t7d-p05 分支已 fast-forward 对齐 47f9886。
- 升级安装（T7B 预览网关 `<GATEWAY_DIR>`，手工部署快照、非 setup.mjs 安装，故走构建物同步而非 upgrade --apply）：
  1. 备份至 `<BACKUP_DIR>`（排除 node_modules）。
  2. 依赖不变（package.json/package-lock 逐字节一致），node_modules 未动。
  3. robocopy /MIR 同步 dist/src/workbench/scripts/skills/bin/desktop/deepseek-plugin/docs/test 十目录 + 根 package.json 等 8 文件；`.env` 与 `data/`（persistent-service.json 等）保留未触碰。
  4. doctor ok=true、buildPresent、desktopRoute，codeHash 9bb1582b。
  5. 技能升级：install-skill.mjs 6 文件全部 DIFF→已安装，旧版备份 `<SKILL_BACKUP_DIR>`。
  6. 常驻服务 service-c（service-cli.js run，1.5s 轮询 pumpWorkspaceWorkers，Windows 无自动拉起）已 kill+detached 重拉：新 pid 17404，status=no_task，codeHash=9bb1582b——已跑新代码。
  7. MCP server（codex.exe 子进程）不动，Codex Desktop 重连/新会话自动加载新 dist/server.js。
- 验证：WorkBuddy 客户端 7 进程健康、CDP 18491 可达；`.env`/`data/` 时间戳未变（10-31）。run_orphaned/waiting_stop 真实窗口回归仍属 P0-6 后续。

### D3 桌面验收补充（2026-11-04）

`5104af6` 候选的隔离 WebView2 窗口实际打开，桌面策略测试 70/70；发现桌面只读存储未接入 quota/credit，两个资源 API 对有效合成快照返回 503，桌面验收未通过。浏览器报告尚待核对。修复、共同新包及后续实窗回归待完成；未部署、未合主分支、未发布。详见 [集成验收记录](RESOURCE_INTEGRATION_ACCEPTANCE.md) 的桌面补充；真实来源、可信路由、任务方案关联及 D0/D1 仍待完成。

### D3 资源中心本地集成收尾（2026-11-04）

上段的 503 已在 `c5cf788` 修复，并被 fast-forward 纳入 `integration/resource-center`（连同文档提交 `a8ce8f0`）。`SNAPSHOT_MANIFEST.json` 已用仓库脚本重新生成（316 文件，`capturedAt` 与上游 provenance 保持原值），`verify-snapshot.mjs` 通过。当前集成分支的发布文件集合与已验收包 `60b79f56…`（552 文件）逐文件比对：运行文件全等，仅新增的容量损坏态回归测试使测试文件有 1 处差异，故未重建候选包，浏览器 128/128 与 WebView2 71/71 的证据仍归属该包。容量只读验证补到空闲 / 占用 / 缺表 / 表结构损坏四态；WebView2 与浏览器均为隔离合成数据，未接真实账号，未部署、未合 main、未发布。基线见 [RESOURCE_CENTER_BASELINE.md](RESOURCE_CENTER_BASELINE.md)。

### D3-01/D3-02 真实来源与路由证据（2026-11-04）

在独立分支 `feat/resource-source-routing`（基线 `98a39f2`）完成两件事：一是按真实 `wb_proxy.py` 核对 token `/usage/remaining`（面板路由，需 `POST /panel/login` 换的会话令牌，面板口令不能当令牌；会话纯内存、hub 重启即失效、有效会话还能绕过 API 密钥）与积分 `/v1/balance-summary`（只需 API 密钥）的载荷与网关采集器契约，字段与整数口径逐项吻合；二是新增只读资源 `GET /workbench/v1/resources/routing`（`routing-evidence-1`），把「连接→池→模型」可核验的部分按 `observed/expired/unavailable/unobserved` 分级列出，并把「任务→模型、会话→provider、Key 范围、独占预留」四条结构性未知写成 `unresolved`，`routingVerified` 恒为 false，连接指纹变化、快照过期、采集报错与存储损坏都会降级或失败关闭，不复用旧映射。

验证：真实 hub 代码 + 隔离实例 + 空账号池上 35 项检查全过（工作树构建与包内构建各一轮，GET 期间上游请求日志零增长）；新增 10 项路由证据测试，路由+资源批次 56/56、工作台 100/100、HTTP 与打包批次 34/34、桌面策略 70/70，`npm run build` 与 `typecheck:task-view` 通过，快照 318 文件一致。运行文件已变化，候选包重建为 `532f2b86…`（557 文件，包内 `verify-release` 通过），旧包 `60b79f56…` 的浏览器/实窗结论不迁移。

未完成：本机正式部署没有注入统计连接（缺 `WORKBUDDY_QUOTA_SOURCE_URL`/`API_KEY`/`PANEL_TOKEN` 与积分对应三项），真实账号池的 rows 与余额仍未在正式链路上出现；任务级路由仍不可证，`routing_unverified` 保留。D3-01/D3-02 均不标整体完成。详见 [RESOURCE_SOURCE_ROUTING_ACCEPTANCE.md](RESOURCE_SOURCE_ROUTING_ACCEPTANCE.md)。

### D3-02 路由证据一致性修复（2026-11-04 第二轮）

修掉两处已复现的错标。其一是多连接合并：聚合视图选中连接 B 的数据、`connectionIds` 里还带着更早但新鲜的连接 A，原实现在 `connectionIds` 上取最强等级，于是"数据来自失败连接 B、等级却借用 A 的 observed"；现改为等级只由 `primaryConnectionId` 那条证据决定，其他来源只进 `sources[]` 与 `connectionIds`，不参与提升。其二是来源时间缺失：有快照但 `sourceObservedAt` 为空时原实现判 `expired`，现区分成 `unavailable` + `source_time_unknown`，过期只留给"确实超过有效期"；quota 映射的有效期只在主证据快照与连接快照一致时引用，否则保持 `null`，`generatedAt` 不延长任何快照有效期。

回归：新增 14 项一致性测试（真实 `TaskStore` + 真实 service），修复前 4 pass / 10 fail，修复后 14/14；路由+资源批次 76/76、工作台 100/100、HTTP 与打包批次 61/61、桌面策略 70/70、`build` 与 `typecheck:task-view` 通过、快照 319 文件一致。新候选包 `da637ece…`（558 文件，包内 `verify-release` 通过，与上一包 `532f2b86…` 的文件级差异为 4 改 1 增）。新接口在包内构建上由 `verify-package-routing.mjs` 验 34 项（含成功 / 时间未知 / 过期 / 失败 / 多连接冲突 / HTTP 参数与方法 / 容量路径 / 数据库不变），正式 desktop host 由 `desktop-routing-host-check.mjs` 验 16 项（routing 200、primary=B、level=unavailable、五个前端资源 200、数据库 sha256 前后一致、host 退出 0）。全量 `npm test` 为 935/922 pass/1 fail，唯一失败是并行负载下的挂起类计时用例，单文件复跑 6/6 通过并另做基线对照，未把全量写成通过。

真实来源条件本轮重新核对：本机 hub 在跑（`127.0.0.1:8788`，realm `cn`，8 个账号），但仍无 `WORKBUDDY_*` 注入；`/usage/remaining` 必须面板会话令牌，而本机面板口令为默认值、本轮禁止自行登录，故 token 侧保持阻塞；积分侧技术上可用已有 API Key，但使用授权无法从文件确认，本轮未使用其值。真实账号池联调仍需用户在本机注入令牌/密钥后重跑。D3-01 不标完成；D3-02 只多了"证据一致性已修并可回溯"，任务级路由仍保留 `routing_unverified`。

### D3 测试稳定性与真实来源验收工具（2026-11-04 第三轮）

独立分支 `fix/resource-acceptance-readiness`（基线 `e39a4d4`）。本轮只做两件事，不重做已通过的能力。

**测试稳定性。** 上一轮全量两次失败都指向 `bounded-command` 的"挂起命令 + 脱离后代的超时清理"用例，报错是读 `child.pid` 时 `ENOENT`。定位结论是夹具预算假设错误，不是产品缺陷：`bounded-job.ps1` 用 `Add-Type` 编译监督器并挂起目标进程，`Stopwatch` 在 `ResumeThread` 之后才起算——也就是说 1 秒预算全部落在目标自己的启动上，而生成该 pid 的 Node 目标在整机并行下启动开销会超过 1 秒。实测 spawn→pid 文件出现的中位耗时：单进程 367ms，8 并发 519ms，24 并发 1351ms，48 并发 2753ms（最大 5317ms）。因此把该用例预算改成 10 秒（约两倍最坏值）并补 `elapsed >= 9000` 断言，逼它证明"守住 deadline 而不是提前放弃"；另加一个用 `ping.exe`（几十毫秒即可运行）作真挂起目标的 1 秒 deadline 用例，保留对短期限与清理的直接验证。没有删断言、没有在目标被杀后补等 pid、没有关并发。

`run-worker` 的 detached 用例另有一处独立竞态：worker 先写 `state.json` 的终态、再追加对应的 `result` 事件，测试原来"等状态后直接读最后一条消息"，会偶尔读到还没被覆盖的 `turn_end`（`status: completed`）。本轮把等待条件改成等**证据本身**（最后一条消息的 `status` 为 `needs_review`，10 秒上限），断言内容不变；产品写入顺序作为已知的瞬时窗口记录在案，本轮不改监督器行为。夹具的 `timeoutSeconds` 试过的 5→60 与轮询 5s→30s 已还原，因为放预算既不解这个竞态、又拖长全量。

整机并行还暴露了第三处时间假设：`credit-balance.test.ts` 的「unsupported and unauthorized endpoints…」用共享夹具的 `intervalMs: 1000` 连打两次 `collect()`，再断言"第二次被采集窗口挡住、上游只收到 1 次"。全量里这条一直跑到 3.4 秒时失败（`2 !== 1`），单独跑 5 次、4 路并发 24 轮都不复现——原因是第一次失败请求本身就可能超过 1 秒，第二个 `collect()` 于是**合法地**落在新窗口里。修法是只把这条用例的窗口放宽到 60 秒（`connection(url,{intervalMs:60000})`），断言仍是"上游只被请求一次"，改的是"紧邻"这个词是否成立的前提，不是结论。

**真实来源验收工具。** 新增 `gateway/scripts/resource-source-acceptance.mjs`，把上一轮散在 `outputs/` 里的临时思路变成仓库内可维护的两段式工具：`--check` 只做离线条件核对（回环 origin、凭据字段是否存在、构建是否存在），绝不报通过；`--execute` 在条件具备时用**正式** `TaskStore` + `TaskApplicationService` + `WorkbenchHttpServer` + 正式采集器完成一次有界的只读验收，隔离临时库与端口，token 与积分可分别执行、分别记录，缺条件的一侧写进 `notExecuted` 而不是算通过。检查项覆盖采集结果、快照落库、官方 HTTP 与库一致、routing 证据归属、时间与单位、null 与零与部分覆盖的区分、GET 不触发上游、GET 不改库、无模型请求、以及自建服务已关闭；报告只保留布尔、状态码、schema、coverage、时间与计数，凭据与余额数值不进输出。退出码 0 / 1 / 2 分别是全过 / 有失败 / 缺条件或部分未执行。数据类检查要求样本非空，空上游不会被 `every()` 判成通过。

验证：`test/resource-source-acceptance.test.ts` 11 项（缺条件、单侧执行、双源全通、脱敏、401、超时、坏载荷、空上游不冒充通过、服务与状态目录清理、命令行退出码）通过；`bounded-command` 7/7；`run-worker` 顺序复跑 8 次与 4 路并发各 5/5；`credit-balance` 修复后 6 波 × 4 路并发 24 次全过；资源与 HTTP 批次 81/81；工作台 100/100；`typecheck:task-view` 通过。全量 `npm test`（隔离 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`）：**947 条 / 935 通过 / 0 失败 / 12 跳过，退出码 0**（`logs/full-suite-final5.log`，286s）。此前四次全量各出现过一次机器负载型失败（`spawnSync git ETIMEDOUT`、detached launcher 未启动、`bounded-command` 读 pid 时 `ENOENT`、`credit-balance` 的 `2 !== 1`），本轮已按上面三段分别定位并修复前两类夹具假设，第四类改为放宽采集窗口。

候选包：`outputs/resource-acceptance-readiness-20261104/package-v6/codex-workbuddy-gateway-v0.7.1.zip`，560 文件，SHA-256 `5580742bddf2e492adc8d700e935fee85261818db08b3c0e83327b728e1a023d`；包内 `verify-release.mjs` → 560 文件 `hashesMatch: true`；用包内 `dist/` 与包内脚本对回环 fixture 跑 `--execute --source both` → 35/35、退出码 0，`--check` 退出码 0。旧包 `84cc070a…`、`da637ece…`、`532f2b86…` 均保留未覆盖。

真实账号池仍未验证——本机没有把统计连接注入部署，token 侧还缺面板会话令牌，积分侧的既有 Key 使用授权未经确认，工具与操作步骤只到"可审查、可重复运行"这一步。D3-01/D3-02 状态不变，任务级路由仍 `routing_unverified`。详见 [RESOURCE_SOURCE_ACCEPTANCE_TOOL.md](RESOURCE_SOURCE_ACCEPTANCE_TOOL.md)。

本地集成：`git merge --ff-only fix/resource-acceptance-readiness`，`e39a4d4 → 6b169d3`（11 文件、+760/−21），`README.md`、`ROADMAP.md` 的既有未提交修改原样保留。集成后复核：`npm run build` 0、`typecheck:task-view` 0、资源与容量批次 91/91、HTTP/打包批次 63/63、`npm run test:workbench` 100/100、`desktop:test` 70/70、`verify-snapshot.mjs` 321 文件 `hashesMatch:true`、`git diff --check` 0；用 `collectReleaseFiles()` 逐文件比对 `package-v6` 侧车清单 → **560/560 全等**，即该包就是集成分支的构建结果。未推送、未合 main、未部署。未限定条件时 `--check` 输出 `accepted:false`、退出码 2，两条来源分别列出缺失字段。

### D3 验收工具完整性修复（2026-11-05 第四轮）

独立审查用隔离夹具复现了三处「工具说通过、其实没验证」的缺陷（`outputs/resource-review-20261105/acceptance-boundaries-GxhjWv/review-result.json`），本轮只修这三处，不扩功能。

**状态目录归属。** `--state-dir` 原本被当成本轮根目录，`finally` 里直接 `rm -rf`，调用者目录里的 sentinel 与同名 `resources.sqlite` 一起消失，仍报 `accepted: true`。现在 `--state-dir` 只是**父目录**，工具用 `mkdtemp` 在里面建 `resource-source-acceptance-*` 自有子目录，数据库与 runs 只落在这个子目录，清理也只针对它；`realpath` 校验父子关系与 basename 前缀，`lstat` 拒绝符号链接/junction，判断不了就报 `state_root_not_owned`/`state_root_outside_parent` 并停止删除，而不是扩大范围。

**WAL 提交检测。** `database_unchanged_by_reads` 原本只比较 `resources.sqlite` 主文件 SHA-256，而 `TaskStore` 跑在 WAL 模式：GET 期间提交的写入留在 `-wal` 里，主文件哈希不变，检查照样通过。现在改为在读取窗口两端采样 `PRAGMA data_version` 加全表内容摘要（基线放在采集完成之后、GET 之前），`data_version` 对另一连接的提交敏感，摘要兜住同页更新；不用 checkpoint、不重开数据库、不清 WAL。

**关闭失败不再报成功。** 原实现忽略 `server.close()`/`store.close()` 的异常，再读封装类根本不存在的 `listening` 属性，于是注入关闭异常后端口仍在 200、`services_closed` 仍 true。现在逐项记录 collector / server / store 的实际关闭结果（5 秒有界），并用 `net.connect` 探端口；关闭失败保留状态目录（`stateRetention: "kept_after_close_failure"`），继续关闭其余资源，整体不通过。

回归：`test/resource-source-acceptance.test.ts` 从 11 项扩到 **20 项**（调用者目录与既有库不受损、`--keep` 只留自有子目录、失败运行同样不损坏、WAL-only 写入与 store 同连接写入都被检出、`server.close` 抛错、`store.close` 抛错、collector 抛错仍继续关闭其余、部分初始化只清理已创建部分）。旧实现上先跑出 **10 pass / 10 fail**（`outputs/resource-acceptance-boundaries-20261105/pre-fix-tests.log`），改后 20/20；资源与路由批次 96/96；正式全量（隔离 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`）**956 条 / 944 通过 / 0 失败 / 12 跳过，退出码 0**（309s）。

候选包：`outputs/resource-acceptance-boundaries-20261105/package/codex-workbuddy-gateway-v0.7.1.zip`，560 文件，SHA-256 `d3a3c6212d224eb485bd92e873ce2130bd2f2311b17e9ae63d0588bacb9c7cbd`；解包后 `verify-release.mjs` → 560 文件 `hashesMatch: true`；包内依赖安装 94 包。包级验证 `scripts/verify-package-acceptance.mjs` **16/16**：成功路径 35 项全过、调用者目录与外来数据库不变、自有目录被清理、报告无凭据；WAL 写入使 `database_unchanged_by_reads` 失败（`contentStable:false`）；用包装内同一文件的注入缝验证 `server.close` 抛错 → `services_closed` 失败、端口仍开、目录保留，读取窗口内写入 → 检查失败。旧包 `5580742b…` 等全部保留未覆盖。

对历史结论的影响：上一轮记的「35 项全过、accepted: true」只在「工具自有临时目录、上游正常、服务正常关闭」前提下成立，不能证明调用者目录安全、读取窗口内无写入、关闭失败会被发现；新证据替代这三项。真实账号池仍未验证，D3-01/D3-02 不标完成。

## D3-03 核对步骤的资源参考（2026-11-05 第五轮）

核对并确认步骤里新增了"资源参考"区域。它先把关联规则写清楚：执行选择（`workbuddy/local-workbuddy/workbuddy-native` 或 DSH 的 host 身份）与统计连接（`WORKBUDDY_QUOTA_SOURCE_ID` 等）不在同一命名空间，仓库里没有既有映射，因此只承认 `WORKBUDDY_RESOURCE_LINKS_FILE` 指向的**只读声明** `execution-links-1`：同时匹配执行器、执行连接、提供方、**精确模型 ID**（可选 realm）才建立关联，其余一律"未建立关联"。

新增 `gateway/src/plan-resource-reference.ts`（只读声明解析、七种关联状态、主证据取值）、`GET /workbench/v1/resources/plan-reference`（400/405/503 边界）、`workbench/plan-reference.mjs`（loader + 视图，绑定执行选择与草稿 `draftId:digest`）；`dispatch.mjs` 在 review 列插入 `#plan-resource-slot`，返回修改与关闭面板都会 `reset()`；`app.mjs` 传 `onResources`，页面可跳网关资源汇总；`workbench-assets.ts` 与 `package.mjs` 已登记新资源文件。

关键约束：读数只取 `observation.connectionId === link.quotaConnectionId` 的主证据，`connectionIds` 里的其他来源不参与数值、时间、有效期，也不提升等级；`sourceObservedAt` 为空是 `source_time_unknown`（`unavailable`），不是 `expired`；null 保持 null，积分不标货币、不与 token 相加；所有分支 `routingVerified:false`。页面只读快照，不触发上游采集、登录或模型请求，失败时保留上一份成功快照并提示。

回归：`test/plan-resource-reference.test.ts` 16/16、`test/plan-reference-loader.test.ts` 6/6、受影响 13 个测试文件 140/140、workbench 100/100、desktop 70/70、typecheck 0；正式全量（隔离 `WORKBUDDY_CLI_ELECTRON`/`WORKBUDDY_CONFIG_DIR`）**978 条 / 966 通过 / 0 失败 / 12 跳过，退出码 0**（358s）。

界面验收：浏览器 19/19（关联读数、核对步骤仍可确认、720/420 无溢出、503 注入保留旧快照、返回重开后重读、键盘焦点与回车、未关联无数字、跳转资源页）；WebView2 实窗 19/19（同一组场景，另加清空声明立即转为未关联、恢复声明回到已关联）。截图见 `outputs/resource-plan-reference-20261105/shots/` 与 `outputs/resource-plan-reference-20261105/webview/shots/`，均标"隔离合成数据"。

候选包：`outputs/resource-plan-reference-20261105/package-v2/codex-workbuddy-gateway-v0.7.1.zip`，567 文件，SHA-256 `c0349d799048385d3ee44db8a848f8a0904def5209a090e568bf98494dacd5a0`；解包后 `verify-release.mjs` → 567 文件 `hashesMatch: true`；包内含 `workbench/plan-reference.mjs` 与 `src/plan-resource-reference.ts`。旧包全部保留未覆盖。首版 `package`（`74bf2fea…`）的 `dist/plan-resource-reference.js` 是打包前未重建的旧产物，缺 `linked_rows_elsewhere` 分支，与集成树不一致；重建 dist 后重打包，并用 `scripts/compare-runtime.mjs` 对 `package-v2` 逐文件比对 → **567/567 全等**，浏览器 19/19 与 WebView2 19/19 均已在 `package-v2` 上重跑。

仍未完成：真实来源没有声明关联（本机未注入统计连接），真实窗口只能显示"未建立关联"；任务→模型的实际路由仍不可证，`routing_unverified` 保留，D3-02 不因本轮改状态；D3-01 真实账号池与 D3-04 监督隔离维持原状态。
