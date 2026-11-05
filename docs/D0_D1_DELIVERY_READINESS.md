# D0/D1 交付准备与 53 项证据矩阵

核对日期：2026-11-05；C 线，分支 `docs/d0-d1-delivery-readiness`，起点 `882acc8a21dd750c19683efb53951c67bec22309`。本文修订已有矩阵，不重设验收标准。**账目与样本准备完成不等于 D0、D1 或正式交付完成。** 本轮 A/B 新成果未合入此树，最终版本对齐留给集成人。

本轮只读核对既有部署，在 C 自有目录生成代码样本；没有真实模型派工、登录、模型准备、安装切换、政策修改或旧任务收口。执行方案见 [D1 真实验收方案](D1_LIVE_ACCEPTANCE_PLAN.md)。

## 1. 对象、版本与实测结果（D0-01）

本机证据根目录 `E:\javaproject\outputs\delivery-readiness-c-20261105`，下文记为 `<C_EVIDENCE>`。完整输入路径仅留本机 `input-paths.json`，不进 Git/包。采集时 C 树已有本线未提交文件，故 `source.dirty=true`；不是声称采集时为干净发布树。交付提交以 Git 历史及最终回执标识。

| 对象 | 本次实际结果与证据 | 结论和限制 |
|---|---|---|
| 正式集成源码 / C 开发树 | 正式源仍为 `workbuddy-resource-integration` / `integration/resource-center`；C 树基于 `882acc8`。候选清单非 dist 文件在 C 树 285/285 同哈希 | C 是开发工作树；清单不含本轮新增文件，不能称整个 C 树与旧包相同 |
| `882acc8` 候选包 | `outputs/dsh-discovery-fix-20261105/package/codex-workbuddy-gateway-v0.7.1.zip`，SHA-256 `003417bce7b41e4b9bdc3400d3a5d779f80d8dc9fed53437db52f63e964546b8`；解包 570/570 文件匹配旁置 manifest | 包版本 `0.7.1`；直接读字节，没有运行包内程序。不是 A/B/C 最终包 |
| 候选磁盘代码摘要 | 对解包 `dist/**/*.js` 使用 `runtime-version.ts` 相同算法（排序的相对路径+字节），95 个 JS；`491cbd47f01231b2e11328130bd4d33b280e6beda31d8c314f4461228763a370` | 未启动候选服务 |
| 根技能 / 发布副本 / 已安装技能 | 根目录、`gateway/skills/workbuddy-executor/`、已安装技能：SKILL、agents/openai.yaml、4 references 共 6 文件逐一同哈希；见 `baseline.json.skills` | 没有安装技能；技能一致不代表网关同步 |
| MCP 配置目标 | 只抽取 workbuddy 服务的 Node/脚本/cwd、显式 DB/runs/config 路径及非秘密开关；仍指向既有 T7B 预览安装与原现代任务库 | 没有输出配置正文、账号、凭据或命令行；没有改配置/换库 |
| 已安装网关磁盘 | 候选清单 570 项中 487 相同、53 不同、30 缺失、0 不可读；packageVersion 仍 `0.7.1`。93 个 JS 摘要 `8427e9e1a4999a4301eb4d109e35ba383d20856eba69b286ba422a50b6e3d58c` | 明确不同于候选；只比较清单声明文件，未枚举/删除额外安装文件，不可读与不存在分别记录 |
| 当前聊天 MCP 进程 | health 采样 `2026-11-05T08:49:46.346Z`；PID `25864`，启动 `2026-11-05T05:50:58.972Z`；release `portability-20261018.1`，packageVersion `0.7.1`；codeHash 为上行 `8427…58c` | **运行摘要匹配安装磁盘，不匹配候选**；同版本号不代表相同代码。重载后须重新采样 |
| 原生连接 | 同次 health：`online=false`、`ready=false`、`persistentService.installed=false` | MCP 能响应不等于原生会话可执行；没有初始化连接 |
| 独立桌面进程 | `2026-11-05T08:52:20.224Z` 固定名称 `WorkBuddy.Workbench.exe` CIM 查询成功，0 项；见 `desktop-processes.json` | 当时未观察到该名进程；未扫描其他原生宿主，不能推断全机无相关进程；桌面加载摘要仍未验证 |
| 常驻服务 | 安装位置 `data/persistent-service.json` 可读，仅为磁盘注册资料；见 `service-observation.json`。MCP health 报未安装 | 注册与运行分开。未取得服务 PID/启动时间/加载摘要，没有运行 service-cli 或启动服务 |
| 第二台机器 / 当前远端 CI | 本轮未执行/访问 | 未验证；历史 CI 不代替最终候选 CI |

### 1.1 政策与容量：只读事实，不是可派工结论

最终采集器不向源库建立SQLite连接：以只读文件操作连续两遍读取DB/WAL，字节稳定才在显式C自有临时目录创建私有副本，通过 `DatabaseSync(copy,{readOnly:true})` 查询已有政策/容量表后关闭并删除副本。不导入TaskStore，不迁移/修复源库、不提取账号表。副本包含原库/WAL字节，只在本机自有临时目录短暂存在，绝不进Git/包/分享证据；目录不合法、源变化或副本清理失败均不能给可用结论。

合成WAL回归及本机 `source-state-stability.json` 均核对源DB/WAL/SHM不变、临时副本已删除。两遍文件稳定并非与所有写进程共同锁定的原子快照，因此结果仍为 `effectivePolicyVerified=false,sourceSnapshotIsAtomic=false`，不代替派工时事务核验。最初 `baseline.json` 使用源库只读SQLite连接，不能保证SHM读标记零变化；此限制保留，最终方法/政策结果以 `baseline-source-isolated.json` 为准，不倒改原证据。

| 来源与适用版本 | 已核对的非秘密字段 | 含义与缺口 |
|---|---|---|
| 配置所指任务库 `collaboration_policy(id=1)`，摘要校验相符 | version=`policy-4zf1EnD-F3K4-rg70_7szRLJ`；原记录缺 `selectionMode`，按现有解析兼容为 `allowlist`，并保留 `selectionModeStored=false`；`requireFree=true`；`maxAttempts=3`；`maxTimeoutSeconds=86400` | 是已保存全局政策，不是新样本授权；未读取/放宽所有历史任务原约定 |
| 同一政策允许范围 | 仅 `workbuddy / local-workbuddy / workbuddy-native / deepseek-v4.1-flash / reasoningEffort=null` | 所见列表不含 DSH；不能按通用规则绕过部署限制或自动添加 DSH |
| 已安装 `.env` + MCP 显式 env 的白名单投影 | `WORKBUDDY_BACKEND=desktop-queue`；`WORKBUDDY_REQUIRED_FREE_MODEL=deepseek-v4.1-flash`；`WORKBUDDY_DSH_ENABLED=0`；desktop-dispatch 未取得有效字符串值 | 仅磁盘层，未读活进程环境；缺失/空值不当作启用。其他未观测开关保持未知 |
| 同库 `workflow_capacity(slot=1)` | `recorded_occupant`，`closureEvaluated=false` | 有占用记录；没有裁决归属或原生停止，**不是空闲，不可自动清除** |
| 历史任务政策 / 实时实际限制 | 未完整核对；`effectivePolicyVerified=false` | 派工前须满足原约定、当前部署限制、本任务实际选择；现有数据不足以支持 DSH 开工 |

原 P0-1 继续按[原任务裁决](T7D_P0_1_ORIGINAL_TASK_DECISION.md)：副作用不能排除；不关闭、不重派、不换身份/执行器/任务库绕过、不无证据释放容量。另行授权的独立实验须证明不与原请求/会话重叠，也不自动改写原交付判定。

### 1.2 只读采集入口与复核

新增 `gateway/scripts/delivery-baseline.mjs` 只用 Node 内置模块，不调用 loadConfig、TaskStore、安装器、模型或网关初始化。参数都是**显式输入路径**：

```text
node scripts/delivery-baseline.mjs --source-root <SOURCE_ROOT> --candidate-manifest <MANIFEST> --candidate-root <UNPACKED_GATEWAY> --candidate-archive <ZIP> --installed-root <INSTALLED_GATEWAY> --skill-root <INSTALLED_SKILL> --database <CONFIGURED_DB> --policy-scratch-root <EXISTING_OWNED_TEMP_DIRECTORY> --flags-snapshot <FLAGS_JSON> --runtime-snapshot <MCP_HEALTH_JSON> --service-state <SERVICE_REGISTRATION_JSON> --desktop-snapshot <DESKTOP_JSON>
```

脚本只向stdout输出脱敏JSON，调用方保存到自有证据目录；仅政策查询会写入并删除显式scratch下的唯一临时副本，其他对象均只读。scratch必须事先存在、绝对且无链接祖先，缺少则政策返回 `POLICY_SCRATCH_REQUIRED`，不猜临时目录。参数可按需单独提供。退出0仅为采集完成，仍可能含absent/unreadable/not_supplied/invalid/unavailable，**不是允许派工**。未知/重复/不完整参数退出2，不回显值。manifest只允许公开代码路径，拒绝私有状态/越界；不会借其读取.env/数据库。比较范围为声明清单，非全安装目录。

输入快照须有真实来源：runtime 使用真实 MCP health 的 `{collectedAt,runtime,online,ready,persistentService:{installed}}`；flags 为 `{source,fields:{已知非秘密开关}}`；desktop 为 `{queryStatus:'observed'|'unavailable',collectedAt,processes:[...]}`，失败查询不以空数组冒充零进程。常驻服务参数只读磁盘注册。采集器投影/脱敏，但不能证明调用者快照真实，须留来源记录。

本机 `capture-local-inputs.mjs` 留在 `<C_EVIDENCE>`，只读抽取已知配置字段、固定进程元数据，原始命令行不输出。通用仓库脚本不硬编码个人安装路径；`input-paths.json` 不随交付分享。

## 2. 证据索引与判定（D0-02）

类型：**源**=源码/检查目标；**合**=隔离替身/合成；**真**=真实模型/原生观察；**窗**=窗口实测（数据仍可能合成）；**CI**=远端自动检查。各类不能互相替代。矩阵版本列引用下表的确切归属，不将旧实机结果改挂到新候选。

| ID | 版本、类型与证据位置 | 适用范围 |
|---|---|---|
| E0 | C源只读；`<C_EVIDENCE>/baseline-source-isolated.json`、`source-state-stability.json`、`mcp-runtime.json`、`desktop-processes.json`、`service-observation.json`、`deployment-flags.json`；初版baseline.json保留 | §1版本/政策事实；最终源DB/WAL/SHM不变，MCP/桌面快照仍按各自原取样时间，不是模型验收 |
| E1 | `882acc8` 合；[重复枚举修复](DSH_REGISTRY_DISCOVERY_FIX.md) §验证范围；`outputs/dsh-discovery-fix-20261105/full-suite.log` | 当时全量 `1013 / 1000 pass / 0 fail / 13 skip`；不是 C 或最终集成全量，不含独立 workbench 命令 |
| E2 | `eab7937` 资源方案线及后续修复/集成，合+窗；[资源参考](RESOURCE_PLAN_REFERENCE.md) §6；`outputs/resource-review-20261105/reports/browser-fix.json`、`webview/webview-acceptance.json` | 浏览器27、WebView2 20个定向检查；包SHA完整值见原记录，合成额度不当真实资源 |
| E3 | `3ad105f`、`c10b896`，经 `f17c417`/`0c58f40` 集成，合；[故障隔离](RESOURCE_FAULT_ISOLATION_ACCEPTANCE.md) §场景/命令；`outputs/resource-fault-isolation-20261105/cross-tests-final.log` | 双执行器替身+共享服务故障/容量专项，非原生双端实机 |
| E4 | `0e9d96b6e88e0bdfacfd007762c089e6e0f2101c` 真+合；[T6双端](T6_LIVE_ACCEPTANCE_2026-10-28.md) §实际执行/独立验收；[交付及CI](T6_COMPLETION_2026-10-29.md) | WorkBuddy与官方DSH各1代码样本、精确独立命令、reviewId、accepted/closed；隔离候选运行，不是当前安装MCP；代理失败另留 |
| E5 | `1076285` 真+窗；[T7B](T7B_LIVE_ACCEPTANCE_2026-10-31.md) | WorkBuddy手动派工、运行中重开、独立检查/停止/验收；当时包485项 |
| E6 | T7C，T7B合入 `144a520` 的运行代码，真+窗+合；[统一入口](T7C_UNIFIED_ENTRY.md) §本机真实补验/自动验证 | 安装技能+当前聊天MCP的WorkBuddy新代码样本、8项检查、review/accept、重开/历史路由，不是DSH新样本 |
| E7 | `5f8620e` 收尾所记2026-11-04样本，真；[PROGRESS](PROGRESS.md) 搜索 `dsh-live-20261104-01` | 本机应用服务路径，requiredChecks为空，credits:null报价未知；不能代替MCP完整代码验收或实扣 |
| E8 | `34fcb1b`+当时补丁，真+合；[run6/run7](T7D_P0_5_RUN6_VERIFICATION_RECORD.md) §八步、§6.6–6.12 | 历史领取/中断/停止窗口/副本演练；外部审查不等于产品reviewId，旧未知任务不由它改写 |
| E9 | C合/准备；`gateway/test/delivery-baseline.test.ts`、`gateway/test/live-acceptance-fixture.test.ts`；`<C_EVIDENCE>/c-tests-final-release.log`、`prepared-fixtures.json`、`fixture-checks.json` | 最终19项专项；源无写采集、各7项样本检查、参考修复与篡改发现；没有模型执行 |
| S1 | `882acc8` 源+E1套件；`gateway/test/t4a-operation-admission.test.ts`、`t4b-operation-recovery.test.ts`、`capacity-resource.test.ts`、`t7d-native-stop-declaration.test.ts` | 准入/持久操作/容量/停止的检查目标，不声称所有组合实机已测 |
| S2 | `882acc8` 源+E1套件；`gateway/test/workspace-protection.test.ts`、`evidence-consistency.test.ts`、`task-reviews.test.ts`、`task-contract.test.ts` | 范围、证据、不可变审查、契约 |
| S3 | `882acc8` 源+E1套件；`gateway/test/t3-admission.test.ts`、`plan-cli.test.ts`、`dsh-adapter.test.ts`、`dsh-discovery.test.ts`、`mcp-entry.test.ts` | 方案/选择/宿主/入口 |
| S4 | `882acc8` 源+E1套件；`gateway/test/resource-routing.test.ts`、`plan-resource-reference-conflicts.test.ts`、`resource-source-acceptance.test.ts`、`desktop-readonly-resources.test.ts` | 资源关联/白名单/只读；真实路由另待证据 |
| SF | `882acc8` 源，本线未重跑前端专项；`gateway/workbench/test/model.test.mjs`、`read-store.test.mjs`、`recovery.test.mjs`、`attention.test.mjs`、`controls.test.mjs`、`resources-view.test.mjs` | F复验定位；文件存在不代表F全绿 |

状态为“部分证据 / 未完成 / 未验证 / 待范围决定”，本轮没有将整项判为正式通过；子项历史成功仍保留。原标准见 [V/C](ACCEPTANCE.md)、[F](FRONTEND_TASK_PANEL_DESIGN.md) §验收。“受控”指桌面手动候选，“完整”指完整愿景，“原型”指只读mock；发行适用范围待决定。

### V01–V15

| 项 | 适用范围 | 类型/归属版本 | 证据位置 | 状态 | 剩余动作 |
|---|---|---|---|---|---|
| V01 | 受控、完整 | 真T6/T7B/T7C/11月4；合C | E4/E5/E6/E7/E9 | 部分证据 | 当前双端安装技能+MCP代码任务，非空必需检查、review/accept/closed |
| V02 | 受控、完整 | 源/合882；历史真补丁版 | S1/E8/SF | 部分证据 | 已知/未知输入等待实机，不代批不重派不延时 |
| V03 | 受控、完整 | 源/合882；历史真补丁版 | S1/E3/E8§6.8 | 部分证据 | 当前双端报告先到仍忙，accept/rework/new dispatch拒绝 |
| V04 | 受控、完整 | 合0c58f40/882；历史真 | E3/S1/E8 | 部分证据 | 领取后取消/归属冲突，不误停、不释未知容量，原P0-1不动 |
| V05 | 受控、完整 | 源/合882；历史真不完整 | S1/E8/SF | 部分证据 | 截止后重连/迟到报告，原期限/终态、发生/观察时间分别留存 |
| V06 | 受控、完整 | 源/合882 | S1/S3 | 部分证据 | 当前双入口/双进程同键与冲突、结果不明恢复，只观察原操作 |
| V07 | 受控、完整 | 真T6/T7B；源/合882 | E4/E5/S2 | 部分证据 | 双端真实增量/受保护检查/旧改动；隔离越界负例不吞旧改动 |
| V08 | 受控、完整 | 真T6；源/合882 | E4/S2 | 部分证据 | 当前检查后改源码/旧attempt/review拒绝，重新检查留痕 |
| V09 | 受控、完整 | 真T6；源/合882及C | E4/S2/E9 | 部分证据 | 双端按原语义审查；checker_error不归worker内容失败 |
| V10 | 受控、完整 | 源/合882；只读C | S1/S3/E0 | 部分证据 | 缺模型/主动免费/三轮耗尽分别验证；一轮样本不证明三轮上限 |
| V11 | 受控、完整 | 真T7B/T7C；源/合882 | E5/E6/S3/SF | 部分证据 | 当前重开、掉线、旧revision，固定身份无重复派工 |
| V12 | 受控、完整；统计D6 | 源882；合资源候选 | SF/S4/E2/E3 | 部分证据 | 去重、人工episode、返工/恢复复算；缺失计量保持null |
| V13 | 受控/完整发行 | 只读C；源既有文档 | E0/gateway/docs/DEPLOYMENT_ACCEPTANCE.md | 未验证本轮安装 | A准备后获准实装/升级/卸载/回退/运行摘要，保护旧任务 |
| V14 | Windows受控、完整 | 真T6/T7B/T7C；合882 | E4/E5/E6/E1 | 部分证据 | 当前宿主/架构/进程、中文空格路径、返工取消重连及服务失败 |
| V15 | 正式发行 | 本轮无异机；历史CI另列 | E0/E4/gateway/docs/DEPLOYMENT_ACCEPTANCE.md | 未验证 | 第二台物理Windows、操作者事实、独立安装/会话/运行证据 |

### C01–C18

| 项 | 适用范围 | 类型/归属版本 | 证据位置 | 状态 | 剩余动作 |
|---|---|---|---|---|---|
| C01 | 受控手动；完整含推荐/自动 | 源/合882；真T7B | S3/E5 | 未完成整项 | direct/用户覆盖复验，推荐D4/预授权D5，不能借手动改绿 |
| C02 | 受控、完整 | 源/合882；窗资源候选 | S3/E2 | 部分证据 | 当前可信确认/过期/revision/并发消费，预览零模型副作用 |
| C03 | DSH受控、完整 | 源/合882 | S3/E1 | 部分证据 | 真实宿主无/多/错目录会话，精确选择，不猜最新/造替代 |
| C04 | DSH受控、完整 | 真T6及受限11月4样本 | E4/E7/S3 | 部分证据 | 当前目录/准备读回/真实请求模型推理一致，代理只声明可见层 |
| C05 | 受控、完整 | 源/合882；只读C | S3/E0/AGENTS.md | 部分证据 | 新样本实际选择与价格，缺失/漂移拒绝，历史/部署政策不放宽 |
| C06 | DSH受控、完整 | 真T6及受限11月4样本 | E4/E7/S2 | 部分证据 | 当前MCP代码验收、原task/session返工，审查故障不改成功 |
| C07 | 受控、完整 | 源/合882；合故障线 | S1/E3/E0 | 部分证据且有占用门槛 | 原占用/未知先核对；共享容量1，不按TTL/换库绕过 |
| C08 | 资源功能上线 | 源/合882；窗合成 | S4/E2/RESOURCE_SOURCE_ROUTING_ACCEPTANCE.md | 未完成真实路由 | D3真实账号池/Key/区域/共享去重，仍routing_unverified |
| C09 | 资源功能上线 | 合/窗资源候选；源882 | E2/S4 | 部分证据 | 真实快照/面板、单位/估算/时间/耗尽依据，null不补零 |
| C10 | 资源功能上线 | 合0c58f40/882 | E3/S4 | 部分证据：隔离子项通过 | 真实来源/执行器交叉和未测组合，不自动换来源/停任务 |
| C11 | 资源功能上线 | 源/合882 | E3/S4/RESOURCE_SOURCE_ACCEPTANCE_TOOL.md | 部分证据 | 退避/乱序/GET零副作用；主动探测另授权计量，本轮不探测 |
| C12 | 完整统计P1 | 源/合资源候选 | E2/S4 | 未完成 | D6请求归因/覆盖、worker/reviewer/重试去重，余额差不作成本 |
| C13 | 付费/硬限功能上线 | 源/合882；只读C | S3/E0 | 部分证据 | 实际选择及来源硬限能力；无法保证则拒绝该要求，报价不作实扣 |
| C14 | 受控方案；完整含撤回/模板 | 源/合882 | S3/S1 | 未完成整项 | 方案审计复验，D5撤回/D6模板，不复用身份/扩大旧预算 |
| C15 | 资源功能上线/发行 | 源/合882；只读C | S4/E0/E9 | 部分证据 | 当前安装浏览器凭据与全部导出白名单；本线仅证明本工具投影 |
| C16 | 升级/回退 | 源/合882 | S2 | 部分证据 | 获准安装后验证历史兼容/回滚；未知来源/模型不造值 |
| C17 | 受控、完整 | 真T6；源/合882 | E4/S2/S3 | 部分证据 | 当前双端文件保护/旧证据拒绝，不在task内换执行器/模型 |
| C18 | 宿主/停止/版本发布P0；统计P1 | 真T6/T7B/T7C；合882 | E4/E5/E6/E1/E0 | 部分证据 | 当前真实宿主/停止/指纹；D6统计附样本数/区间，检查器错单列 |

### F01–F20

原 F 门槛针对只读mock；受控桌面有授权写操作。应分“原型/真实只读/受控桌面”验收，不能把F05宣布不适用，也不能称整个产品严格只读。本轮未作整项不适用裁决。

| 项 | 适用范围 | 类型/归属版本 | 证据位置 | 状态 | 剩余动作 |
|---|---|---|---|---|---|
| F01 | 原型；真实另测 | 源882 | SF/FRONTEND_TASK_PANEL_DESIGN.md | 待范围决定/未复验 | WorkBuddy/真网关关闭时冷启动mock，不启动真实服务 |
| F02 | 原型/合成展示 | 窗/合资源候选 | E2/E3 | 部分证据 | 当前所有演示入口/截图持续标模拟，真实来源另分类 |
| F03 | 原型10态/受控展示 | 源882 | SF/model.test.mjs | 部分证据 | 原10种displayState全场景，资源关联态不代任务态 |
| F04 | 各展示模式 | 源882；合/真历史 | SF/E3/E4/E8 | 部分证据 | UI报告→等待停止→待审查分层，不凭正文判成功 |
| F05 | 原型/真实只读；受控另验 | 源/合882 | S4/SF/E3 | 待范围决定/部分证据 | 分模式网络记录：无写provider/模型请求，受控写有可信授权 |
| F06 | 原型/受控等待 | 源882 | SF/attention.test.mjs/E8 | 部分证据 | 已知/未知详情实窗，不出现网页代批 |
| F07 | 原型/受控取消期限 | 源882；合故障线 | SF/E3 | 部分证据 | 当前取消/到期/迟到文案，不恢复/延时/假成功 |
| F08 | 真实只读/受控 | 真/窗T7B/T7C；源882 | E5/E6/SF | 部分证据 | 当前刷新/掉线原task/attempt/deadline恢复无重派 |
| F09 | 各展示模式 | 合资源候选；源882 | E2/SF/read-store.test.mjs | 部分证据 | loader之外任务A/B、换场景乱序也需复验 |
| F10 | 各展示模式 | 源882 | SF/model.test.mjs | 未在本轮复验 | 固定时钟/零点/后台/非法时间，读取与事件时间分开 |
| F11 | 各展示模式 | 合/窗资源候选；源882 | E2/S4/SF | 部分证据 | 所有缺值/未观察变更保持未知，真实零与null分开 |
| F12 | 各展示模式 | 源882 | SF/model.test.mjs | 未在本轮复验 | eventId去重、前轮失败保留、发生/观察时间分开 |
| F13 | 各展示模式 | 源882；合故障线 | SF/E3 | 部分证据 | 未知版本/枚举、缺字段/矛盾全界面降级 |
| F14 | 各展示模式 | 源882 | SF/S4 | 未在本轮全面复验 | HTML/脚本/路径文本的DOM/点击夹具，不执行/不打开路径 |
| F15 | 原型/公开材料 | 合资源候选及C | E2/E3/E9 | 部分证据 | 最终包/文档/截图脱敏，机器路径/状态/原始日志不入包 |
| F16 | 各展示模式 | 真T6/T7B；源882 | E4/E5/S2/SF | 部分证据 | 当前双端越界/旧改动/checker_error/unknown展示分开 |
| F17 | 原型/声明支持页面 | 窗资源候选 | E2截图/浏览器报告 | 部分证据 | 定向宽窄屏之外，原四尺寸/任务等待审查页完整复核 |
| F18 | 原型/受控主路径 | 窗资源候选 | E2键盘/实窗报告 | 部分证据 | 全主路径键盘/焦点/200%缩放，定向资源焦点不替代 |
| F19 | 各交付版本 | 合882及C专项 | E1/E9 | 部分证据 | 最终集成构建/类型/前端/全量/包，对应最终SHA，计数不相加 |
| F20 | 各声明发行范围 | 文档882+C | 本文/D1_LIVE_ACCEPTANCE_PLAN.md | 交接材料已补；发行未完成 | 对齐安装说明/范围/未实现项/最终产物，不由本文宣布发行 |

## 3. 范围与交付决定（D0-03）

正式范围未决定，D1未执行，旧P0-1未裁决。下列仅是分期选项，**未选定、未豁免任何门槛**：

| 待决定范围 | 必须先满足 | 保留待办 |
|---|---|---|
| 内部开发预览 | 标模拟/未覆盖，保留原未知/部署政策，无未授权真实动作 | 全部适用正式门槛开放，不称正式交付 |
| 受控手动版分期发行 | 用户确定范围；双端D1、对应V/C/F的P0、安装回退、原T7D判定、最终审查/CI及适用异机条件；未交付入口关闭或明确不可用 | D4/D5/D6相应能力仍待做，C01/C14不因缩小范围整体改绿 |
| 完整愿景发行 | [总规划](FUTURE_DEVELOPMENT_PLAN.md) D0–D7全部适用任务及原发布门槛 | 推荐/自动/真实可信资源/计量/模板/异机/发行尚有工作 |

独立新样本是否满足原T7D补验交付条件须另有用户明确决定，也不会使原未知任务变成已停止/已验收。异机和分支保护不能由C线自行删去。自动测试零失败不等于正式交付。

## 4. C 线验证与集成交接

两个新脚本用内置模块；专项以Node24原生.ts加载，未装依赖/构建dist。最终19/19（含拒绝源回滚journal），见 [D1方案](D1_LIVE_ACCEPTANCE_PLAN.md) §本轮准备实测。首跑子进程上下文问题、后续SHM断言夹具在测量窗口内自行查询的问题及修正分别留档；源库隔离方案已实际复核，不拼接多次结果或抹去失败。

集成人需先审A→B，再对齐新候选/运行证据；包白名单补 `scripts/delivery-baseline.mjs`、`scripts/live-acceptance-fixture.mjs`，统一更新快照（新增两脚本两测试）与最终包。无新依赖、无workbench-assets/tsconfig变化。本线不编辑共享PROGRESS/FUTURE_DEVELOPMENT_PLAN/SNAPSHOT/package白名单，不自行合入集成分支。

## 5. G1 增量登记（集成人，2026-11-05）

本节只追加、不改写上文 53 项矩阵与 C 线原始结论。

- 上面 §4 的交接要求已全部落实：`scripts/delivery-baseline.mjs`、`scripts/live-acceptance-fixture.mjs`（以及 A 的 `scripts/candidate-installation.mjs`、`installation-readiness`）已进包白名单与必需文件清单，`test/package.test.ts` 夹具同步；G1 候选包 634 文件，包内 verify-release 634 项哈希匹配。
- 第一批四线合入后，D0 矩阵里由源码与合成证据推进的条目以 [STATUS_INDEX](delivery/STATUS_INDEX.md) 的「任务分层登记」为准：D3-01/02/03/04、D6-01（仅接口面）、D6-02/05 由合成测试与受控启动冒烟支撑；真实账号池、请求级归因、真实运行中监督、真实安装/升级/回退实跑、D1-02 真实派工仍未执行。
- 本轮不把任何条目改判为「真实可用」或「已交付」：`routingVerified` 在生产候选冒烟中仍为 `false`，`actualTaskCredits` 仍为 `null`，空库统计 `tasksRead` 如实为 0。
