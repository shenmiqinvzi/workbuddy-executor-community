# L08 独立验收报告（finish-acceptance）

- 工作树：`E:\javaproject\workbuddy-finish\L08-acceptance`，分支 `test/finish-l08-acceptance`
- 基线：`000e9da17c43ded7040c9e6822fb48eb51abcedc`（tree `7fc23ee6ea99da2e5b857a8ec4eeb8f66559941a`），父 `4a3c9b46acf968ec668e2abd60bd3c9d7e451e4f`
- 证据根：`E:\javaproject\outputs\finish-l08-20261105\`
- 本线只新增 `finish-acceptance-*` 测试、夹具与本文档；业务源码、07 线测试、共享入口、包白名单、`workbench-assets.ts`、全局导航与技能六文件均未修改（`git status` 只列本线新增文件）。

## 0. 结论摘要

1. **没有发现可复现的产品缺陷。** 五个新测试文件把 12 类异常、审查四层、导出/凭据/模板、任务面板语义与资源故障独立性都压到持久状态、文件与派发次数上，全部通过。发现的都是**行为口径差异**（错误码分层、任务行折叠时机、时间格式化的 0/null 分流），逐条记录在第 4 节，不冒充缺陷、也不代产品改文案。
2. **53 项没有一项可以因为本线而改判「通过」。** 本线新增的证据全部属于「合」（隔离替身/合成数据）；F 的窗/读屏/四尺寸/200% 与全部「真」证据仍然缺失。第 5 节给出逐项可观察子断言与建议状态。
3. **12 类异常中 11 类由合成执行器实测；「真实原生进程故障」不在本线触发范围**（第 8 节把它写成 10 张操作卡交 10 线）。
4. 读屏（屏幕阅读器）、真实浏览器四尺寸与 200% 缩放、真实 WorkBuddy/DSH 宿主派工**均未测**，第 7、9 节明确标注，不写「通过」。

## 1. 方法与证据口径

| 类型 | 含义 | 本线是否新增 |
|---|---|---|
| 源 | 直接检查源码目标（导出面、分支、序列化边界） | 是（源码级断言，非运行证据） |
| 合 | 隔离替身/合成数据：假执行器、临时库、临时 runs、临时工作区 | 是（本线主体） |
| 真 | 真实模型/真实原生观察（WorkBuddy 桌面、DSH 宿主） | 否 |
| 窗 | 真实窗口实测（可用合成数据） | 否（无浏览器会话） |
| CI | 远端自动检查 | 否 |

隔离条件（每个测试文件自建，互不共享）：

- `fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "l08-accept-*")))` 作为根；SQLite 任务库、`runs/`、原生会话库 `workbuddy.db` 全在该根内。
- 场景全部经 `TaskApplicationService`/`TaskCoordinator` 真实代码路径，活动执行器为**假**：`SelectedModelClient` 只写 `model-ready.json`，`DesktopQueue` 用 `{desktopPid: process.pid}`，DSH `DshTransport` 只回放合成事件；不连接真实 WorkBuddy、DSH、模型或网络。
- 运行命令前置：`$env:NO_PROXY="127.0.0.1,localhost"`；`NODE_TEST_CONTEXT` 未继承；不读取用户配置目录。

## 2. 实际执行的命令

| # | 命令 | 退出码 | 计数 | 日志 |
|---|---|---|---|---|
| 1 | `npm ci`（`gateway/`，本树 `package-lock.json`） | 0 | 依赖按锁文件安装；`npx tsx --version` = 4.23.15 | `logs\npm-ci.log` |
| 2 | `npm run build` | 0 | `tsc -p tsconfig.json` | `logs\build.log` |
| 3 | `npm run typecheck:task-view` | 0 | `tsc -p tsconfig.task-view.json` | 终端 |
| 4 | `npx tsx --test test/finish-acceptance-review-layers.test.ts` | 0 | 10 tests / 10 pass / 0 fail（124.5s） | 终端 |
| 5 | `npx tsx --test test/finish-acceptance-admission-anomalies.test.ts` | 0 | 10 tests / 10 pass / 0 fail | 终端 |
| 6 | `node --test workbench/test/finish-acceptance-task-panel.test.mjs` | 0 | 8 tests / 8 pass / 0 fail（163ms） | 终端 |
| 7 | `npx tsx --test test/finish-acceptance-resources-credentials.test.ts` | 0 | 6 tests / 6 pass / 0 fail | 终端 |
| 8 | `npx tsx --test test/finish-acceptance-resource-independence.test.ts` | 0 | 1 test / 1 pass / 0 fail | 终端 |
| 9 | `npm run test:workbench` | 0 | 131 tests / 131 pass / 0 fail | `logs\workbench-test.log` |
| 10 | `npm run desktop:test` | 0 | `{"passed":92,"failed":0}` | `logs\desktop-test.log` |
| 11 | `npx tsx --test "test/**/*.test.ts"`（全量） | 0 | 1244 tests / 1232 pass / 0 fail / 12 skipped（348.9s） | `logs\gateway-full-test.log` |

### 2.1 全量回归

在全部夹具改动定稿后执行一次，命令与计数如下（日志逐字落盘，未做筛选）：

```text
cd gateway
$env:NO_PROXY="127.0.0.1,localhost"
$env:WORKBUDDY_CLI_ELECTRON="E:\javaproject\outputs\finish-l08-20261105\env\electron.exe"
$env:WORKBUDDY_CONFIG_DIR="E:\javaproject\outputs\finish-l08-20261105\env\config"
$env:NODE_TEST_CONTEXT=$null
npx tsx --test "test/**/*.test.ts"
```

结果：`tests 1244 / pass 1232 / fail 0 / skipped 12 / duration_ms 348903`，`EXIT=0`。

**环境条件（必须记录，否则会误判成回归）**：第一次执行时未设置上面两个目录变量，同一命令得到 `tests 1244 / pass 1060 / fail 172`，172 例的错误全部是同一条 `Error: Multiple WorkBuddy installations or data directories found; set WORKBUDDY_CLI_ELECTRON and WORKBUDDY_CONFIG_DIR explicitly.`（`src/config.ts:55`）。原因是本机存在多个 WorkBuddy 安装与数据目录，`discoverDesktopPaths` 判定为 `ambiguous` 并直接拒绝启动；显式指向本线自建的占位可执行文件与空配置目录后，全部 172 例恢复通过。这不是被测代码的回归，也不是本线新增测试引入的失败；但任何在本机复跑全量的人都会撞上它，故写入本文与集成请求。

## 3. 新增测试清单

| 文件 | 用例 | 钉住的事实 |
|---|---|---|
| `gateway/test/support/finish-acceptance-fixture.ts` | — | 验收线自建夹具（不复用 07 的 `review-fixture.ts`，避免交付线 helper 的缺陷自我遮蔽）：临时根、临时库、git 基线、原生会话库、假 WorkBuddy 队列、假 DSH 传输、计划创建→授权→派发→报告→原生停止→审查→接受/返工/取消全套入口；计数 `preparations/inspections/prompts/reports` |
| `gateway/test/finish-acceptance-review-layers.test.ts` | 10 | 命令语义（未知/失败/checker_error）、不可变 reviewId、伪造证据、基线篡改、旧 attempt/review、accept 原子性与幂等、取消、伪造已认证报告 |
| `gateway/test/finish-acceptance-admission-anomalies.test.ts` | 10 | 无模型、准备崩溃、不确定派发、同键重放与冲突、跨任务/跨执行器容量 1、领取后取消、错会话报告、到期迟到报告、重启保身份、预算耗尽 |
| `gateway/workbench/test/finish-acceptance-task-panel.test.mjs` | 8 | 10 态与文案、报告≠完成、时间三态、0 与 null、事件去重/旧响应/键盘路径的源码断言、恶意 HTML 只作文本、导航与重试退避 |
| `gateway/test/finish-acceptance-resources-credentials.test.ts` | 6 | 导出白名单、密钥按 key/value 双路脱敏、导出目标不可逃逸、资源读失败显式降级、legacy 模板不携带身份/授权、归档与政策模板拒绝 |
| `gateway/test/finish-acceptance-resource-independence.test.ts` | 1 | 统计源全坏时任务列表/详情仍可用、用户停止仍生效、故障以 503 有界返回 |

## 4. 独立失败清单与复测结果

本节只记「本线以合成方式观察到、且与文档口径存在差异」的事实。**没有一条被判为产品缺陷**；需要产品改动的部分留在 10 线或集成人决定。

| # | 现象 | 复现（最小） | 影响 | 证据位置 | 建议 |
|---|---|---|---|---|---|
| O1 | 合同路径提交空白模型时，先被单元校验拒绝为 `PLAN_STALE`（"A valid vnext-2 proposal is required"），legacy 路径才是 `MODEL_SELECTION_REQUIRED` | `sendRaw({model:"  "})` vs `coordinator.send({model:"  "})` | 用户看到的错误码取决于入口；两条都能拒绝且零副作用 | `finish-acceptance-admission-anomalies.test.ts` 用例 1；`src/collaboration.ts:130`、`src/coordinator.ts:106` | 若要求「缺模型」只有一个错误码，由负责线在提案校验前分流；本线不改 |
| O2 | 领取（`queue.claim`）之后任务行仍是 `queued`，必须 `service.sync` 才折叠为 `working`/`blocked` | claim → 读 `store.get(taskId).state` | 面板可能短暂显示 queued；不影响锁与容量 | 同一文件用例 6–8；`src/desktop-queue.ts` claim 路径 | 记录为已知折叠时机；若要求 claim 即折叠，由负责线评估 |
| O3 | `model.formatTime(0)` 返回「未提供」：数值 0 被当作缺失时间 | `formatTime(0)` | 与 F11「null 不显示成 0」方向一致，但把 0 归为缺失是格式化层选择 | `finish-acceptance-task-panel.test.mjs` | 保留；若真实来源可能出现 epoch 0，应显式渲染为时间而不是「未提供」 |
| O4 | `runs/` 下除 `run-*` attempt 目录外还有其它条目（同一 attempt 时共 3 项） | `readdirSync(runsDir)` | 只影响断言写法；不代表多派发 | 同一文件用例 10 与 `finish-acceptance-admission-anomalies.test.ts` 用例 10（按 `run-` 前缀过滤） | 文档说明 runs 目录布局；不改成「目录数=派发数」 |
| O5 | 一次 `send` 会调用准备 1 次、模型观察 1 次 | 夹具计数：`preparations=1, inspections=1` | 初版夹具把两者累加，曾得出「准备两次」的错误结论 | `test/support/finish-acceptance-fixture.ts` 计数拆分 | 已修正夹具；保留拆分后的断言作为「一次派发只准备一次」的证据 |

**复测**：以上 5 条在修正断言后全部重跑通过（第 2 节 #4–#8）；没有一条以「改了产品代码」的方式变绿。

## 5. 53 项建议更新稿

口径：**本线只能新增「合」证据**。下表「本轮结果」中的「合成通过」指该子断言在本线隔离夹具中真实执行并通过；「合成部分」指只覆盖了该项的一部分子断言；「未覆盖」指本线没有任何新证据；**没有任何一项因为本线改判整项通过**。原文「适用范围/类型」列保留 D0 口径（`docs/D0_D1_DELIVERY_READINESS.md:79-147`），历史 T6/T7B/T7C 口径不动。

### 5.1 V01–V15

| 项 | 模式/版本（原文） | 本轮新增可观察子断言 | 本轮结果 | 仍未覆盖的真实条件 |
|---|---|---|---|---|
| V01 | 受控、完整；真T6/T7B/T7C/11月4；合C | 必需检查非空才可 review；`$provenance`/`$scope`/required 全 passed 才 accept；`task_closed` 恰 1 条；关闭后 review 被拒 | 合成通过 | 真实双端安装技能 + MCP 代码任务的端到端闭环 |
| V02 | 受控、完整；历史真补丁版 | 无原生停止证据时 `checks()` 抛 `STOP_UNCONFIRMED`；等待输入不进 binding | 合成部分 | 已知/未知输入等待的实机行为；不代批不重派 |
| V03 | 受控、完整；历史真补丁版 | 报告已到但无原生停止 → 审查拒绝；该状态下 accept 抛 `CHECKS_REQUIRED` | 合成部分 | 真实「报告先到、原生仍忙」下 accept/rework/new dispatch 三重拒绝 |
| V04 | 受控、完整；合0c58f40/882 | 领取后取消：journal `cancel.json` 存在、`nativeBoundary` 抛 `CANCELLED_TERMINAL`、容量仍占用、`isClosed=false`；错会话报告被拒且无 `reportAuthentication` | 合成通过 | 真实误停/容量释放在原生进程上的表现 |
| V05 | 受控、完整；历史真不完整 | 到期后报告写 `late-report.json`、snapshot 仍 blocked、无认证；`TASK_STATUS: blocked` | 合成通过 | 截止后重连、发生时间与观察时间分离的实机证据 |
| V06 | 受控、完整 | 同 operationId 重放只执行一次；同键不同参数 `OPERATION_CONFLICT`；换执行器同键 `OPERATION_CONFLICT` | 合成部分 | 双进程并发同键（本线为同进程双连接） |
| V07 | 受控、完整；真T6/T7B | 审查后越界写受保护文件 → accept 拒绝、state 不变；旧改动不被吞 | 合成部分 | 真实双端增量与「隔离越界不吞旧改动」实机复验 |
| V08 | 受控、完整；真T6 | 新 attempt 的 `command` 为 unknown（旧命令记录不冒充）；旧 review accept → `REVIEW_STALE`；`task_review_records` UPDATE/DELETE 抛 `immutable` | 合成通过 | 检查后改真实源码的实机留痕 |
| V09 | 受控、完整；真T6；合882及C | 损坏命令证据 → `checker_error` 且 note 含 "no worker failure was inferred"；accept 仍 `CHECKS_REQUIRED`，attempt/state 不变 | 合成通过 | 双端按原语义审查的实机记录 |
| V10 | 受控、完整；只读C | 空白模型两条入口都拒绝且零副作用；`maxAttempts=1` 时再返工抛 "attempt limit"，不建 attempt、不开 run 目录 | 合成部分 | 真实「缺模型/主动免费/三轮耗尽」分别验证；一轮样本不证明三轮上限 |
| V11 | 受控、完整；真T7B/T7C | 重启（新 store）后 attemptId/revision/占用不变、`request.json` 一致、事件不增、send 操作仍 1 条 | 合成通过 | 真实重开/掉线/旧 revision 的固定身份 |
| V12 | 受控、完整；统计D6 | `amount(null)!=="0"`、`formatCount(null)===null`、导出无统计时 `present:false` 且声明「不把缺失当作零」；事件去重为源码级断言 | 合成部分 | 人工 episode、返工/恢复复算、真实去重的实机证据 |
| V13 | 受控/完整发行；只读C | 无 | 未覆盖 | 获准实装/升级/卸载/回退与运行摘要 |
| V14 | Windows受控、完整；真T6/T7B/T7C | 临时 ASCII 路径下的返工/取消/重开 | 未覆盖（关键条件缺失） | 中文与空格路径、真实宿主/架构/进程、服务失败 |
| V15 | 正式发行 | 无 | 未覆盖 | 第二台物理 Windows 与操作者事实 |

### 5.2 C01–C18

| 项 | 模式/版本 | 本轮新增可观察子断言 | 本轮结果 | 仍未覆盖 |
|---|---|---|---|---|
| C01 | 受控手动；完整含推荐/自动 | 计划创建要求 `mode:"manual"`；模板实例化 `authorization:null`、`requires:["plan_create","user_confirmation"]` | 合成部分 | direct/用户覆盖复验；推荐 D4/预授权 D5 |
| C02 | 受控、完整；窗资源候选 | accept 幂等（同输入 deepEqual）、换 operationId 被拒、旧 reviewId → `REVIEW_STALE` | 合成部分 | 预览零模型副作用、并发消费实机 |
| C03 | DSH受控、完整 | 夹具显式拒绝创建会话（`create` 抛错），不猜最新 | 合成部分（仅拒绝面） | 真实宿主无/多/错目录会话与精确选择 |
| C04 | DSH受控、完整；真T6及受限样本 | 准备返回的 workspace/session 固定；模型观察计数 1 | 合成部分 | 目录/准备读回/真实请求模型推理一致 |
| C05 | 受控、完整；只读C | 空白模型拒绝；`model-ready.json` 只由显式选择产生 | 合成部分 | 新样本实际选择与价格、缺失/漂移拒绝 |
| C06 | DSH受控、完整 | 返工沿用原会话（改会话 → `MODEL_BINDING_CHANGED`） | 合成部分 | MCP 代码验收与真实返工 |
| C07 | 受控、完整；合故障线 | 占用中的第二次派发 `CAPACITY_OCCUPIED`；取消未证明停止仍占位；`isClosed=false` | 合成通过 | 真实占用/未知先核对；不按 TTL 释放 |
| C08 | 资源功能上线 | 无 | 未覆盖 | D3 真实账号池/Key/区域/共享去重 |
| C09 | 资源功能上线 | `formatCount/formatCredits/formatRatio/formatStamp` 的 0 与 null 分流 | 合成部分 | 真实快照、单位/估算/耗尽依据 |
| C10 | 资源功能上线；合0c58f40 | 同任务换执行器 claim → `EXECUTOR_UNAVAILABLE`，且不新增操作 | 合成部分 | 真实来源/执行器交叉与未测组合 |
| C11 | 资源功能上线 | 无（未跑来源） | 未覆盖 | 退避/乱序/GET 零副作用；主动探测另授权 |
| C12 | 完整统计P1 | 无统计源时导出显式降级；统计源全坏时 503 且任务列表/详情仍可用 | 合成部分 | 请求归因/覆盖、去重、余额差不作成本 |
| C13 | 付费/硬限功能上线 | 无 | 未覆盖 | 实际选择与来源硬限能力 |
| C14 | 受控方案；完整含撤回/模板 | 模板不携带 attempt/plan/review/authorization；归档 `template_archived`；`policy-suggestion` → `policy_activation_unsupported` | 合成通过（模板子项） | 方案审计复验、D5 撤回、D6 模板真实实例化 |
| C15 | 资源功能上线/发行 | 导出白名单不含凭据形状键；按 key 与 value 双路脱敏并列出字段路径 | 合成部分 | 安装浏览器凭据边界、全部导出白名单 |
| C16 | 升级/回退 | legacy 模板升级丢弃 workspacePath/model；实例化不造授权、不选模型 | 合成部分 | 获准安装后的历史兼容与回滚 |
| C17 | 受控、完整；真T6 | 越界改动 → accept 拒绝；审查 pending 时换执行器被拒 | 合成通过 | 双端文件保护与旧证据拒绝的实机证据 |
| C18 | 宿主/停止/版本发布P0；统计P1 | 停止与监督在统计源全坏时仍可用（列表/详情/取消） | 合成部分 | 真实宿主/停止/指纹；统计样本数与区间 |

### 5.3 F01–F20

| 项 | 模式（原文） | 本轮新增可观察子断言 | 本轮结果 | 仍未覆盖 |
|---|---|---|---|---|
| F01 | 原型；真实另测 | 无（无浏览器会话） | 未覆盖 | 关闭真实服务后的冷启动 mock |
| F02 | 原型/合成展示 | 无截图；仅确认演示数据不含真实账号/路径 | 未覆盖（视觉） | 所有演示入口与截图持续标注模拟 |
| F03 | 原型10态/受控展示 | `STATES` 恰 10 项且 label 互不相同；未知 displayState 落到 unknown；needs_review 无停止 → inconsistent | 合成通过 | 10 态在真实面板上的完整可见性 |
| F04 | 各展示模式 | `proofs()` 三分：报告 present、原生停止 true、独立验收需 accepted+全 passed+actor≠worker | 合成通过 | 报告→等待停止→待审查的真实视觉分层 |
| F05 | 原型/真实只读；受控另验 | 假执行器全程零网络；源码断言无写 provider | 合成部分 | 分模式网络记录 |
| F06 | 原型/受控等待 | `attentionReason` 码值与「无网页代批」路径为源码级断言 | 合成部分 | 已知/未知详情的实窗渲染 |
| F07 | 原型/受控取消期限 | 取消/到期/迟到在状态层分开（cancelled / blocked / late-report） | 合成部分 | 文案在真实面板上的呈现 |
| F08 | 真实只读/受控 | 重开新 store 后身份与事件不重复 | 合成通过（数据层） | 真实刷新/掉线恢复 |
| F09 | 各展示模式 | 源码断言 `serial !== state.detailSerial` 丢弃旧详情、listSerial 保护列表 | 源级通过 | 任务 A/B 与换场景的真实乱序 |
| F10 | 各展示模式 | 合法午夜时间可渲染；非法时间「未提供」；**数值 0 记为缺失（O3）** | 合成通过（含已知限制） | 固定时钟/后台切换的实窗验证 |
| F11 | 各展示模式 | `amount(null)!=="0"`、`formatCount(null)===null`、`formatRatio(null,0)===null`、`formatStamp(null)==="未提供"` | 合成通过 | 界面层「未知」与真实零的视觉区分 |
| F12 | 各展示模式 | 源码断言 `new Map([...state.events,...page.events].map(e=>[e.eventId,e]))` | 源级通过 | 运行时同 eventId 双页合并 |
| F13 | 各展示模式 | `validateRecord` 拒绝缺字段/非法 schema/非法 remoteStopped；未知枚举降级为 unknown | 合成通过 | 全界面在未知版本/矛盾数据下的降级 |
| F14 | 各展示模式 | 恶意 `<img src=x onerror=...>` 只进 `textContent`；`querySelectorAll("img"/"script")===0` | 合成通过 | 真实 DOM 与点击夹具 |
| F15 | 原型/公开材料 | 导出/模板不含机器路径、账号或旧 workspacePath | 合成部分 | 最终包/文档/截图脱敏 |
| F16 | 各展示模式 | 越界写入、旧 attempt、checker_error 在数据层分开（accept 拒绝理由不同） | 合成部分 | 真实界面的分区展示 |
| F17 | 原型/声明支持页面 | 无 | 未覆盖 | 四个指定尺寸 + 等待审查页完整复核 |
| F18 | 原型/受控主路径 | 源码断言 `/` 聚焦、方向键/Home/End、`row?.focus()` | 源级通过 | 键盘全主路径、焦点可见、200% 缩放实测 |
| F19 | 各交付版本 | 第 2 节全部命令退出码 0 并留日志；空测试不计通过 | 合成通过（本线） | 最终集成 SHA 的构建/类型/前端/全量/包 |
| F20 | 各声明发行范围 | 本文件 + `HANDOFF.json`（未知写 null 加原因） | 合成通过（交接面） | 对齐安装说明/范围/未实现项/最终产物 |

## 6. 12 类异常的覆盖表

| # | 异常 | 触发方式（本线，合成） | 断言到的持久事实 | 结果 | 用例 |
|---|---|---|---|---|---|
| 1 | 准备不确定 | `prepareFails:true`，准备回调抛错 | op=`outcome_unknown`、`attemptId=null`、task=`blocked`、槽位仍占、runs 为空、同键重试抛 `OUTCOME_UNKNOWN`、preparations 仍 1 | 通过 | 准入 2 |
| 2 | 投递不确定 | patch `SelectedModelClient.prototype.sendMessage` 抛错 | 返回 `{code:"OUTCOME_UNKNOWN"}`、op=`outcome_unknown`、attempt 存在、`request.json` 不存在、不自动重试、send 操作仅 1 条 | 通过 | 准入 3 |
| 3 | 双入口同键 | 同 operationId 同参重放 / 同键不同参 | 重放 action 只执行 1 次且返回同 id；不同参 `OPERATION_CONFLICT` 且 action 不变 | 通过 | 准入 4 |
| 4 | 双入口不同约定 | 同 operationId 换 executor | `OPERATION_CONFLICT`（"selected a different executor"）、`prompts=0` | 通过 | 准入 4 |
| 5 | 跨执行器容量 1 | 占用中派第二任务 / 换执行器 claim | `CAPACITY_OCCUPIED` / `EXECUTOR_UNAVAILABLE`；第二任务无任务行；占用不变 | 通过 | 准入 5 |
| 6 | 报告先到原生忙 | 报告已提交但无 `observeNative` | `checks()` 抛 `STOP_UNCONFIRMED`；补原生停止后 `$provenance` 才 passed | 通过 | 审查 10 |
| 7 | 领取后取消 | claim → `service.cancel` | `cancel.json` 存在、`nativeBoundary` 抛 `CANCELLED_TERMINAL`、state=cancelled、无 `reportAuthentication`、`isClosed=false` | 通过 | 准入 6 |
| 8 | 错会话归属 | claim 后换 sessionId 报告 | 抛 `/session|lease|match/i`；journal 仍 working、无认证 | 通过 | 准入 7 |
| 9 | 到期迟到 | 把 deadline 改到过去后报告 | `{ok:true,status:"blocked"}`、`late-report.json` 保留原文、无认证、state=blocked | 通过 | 准入 8 |
| 10 | 原身份恢复/返工 | 关闭 store 后重开；旧 review 返工 | attemptId/revision/占用/`request.json` 不变、事件不增；旧 reviewId → `REVIEW_STALE` | 通过 | 准入 9、审查 4/7 |
| 11 | 旧 attempt/review/源码失效 | attempt 2 复用旧命令记录；审查后越界写 | 新 attempt 的 command=unknown；accept → `CHECKS_REQUIRED`；越界 → accept 拒绝 | 通过 | 审查 3/6/7 |
| 12 | 缺模型 / 预算耗尽 | 空白模型；`maxAttempts=1` 后返工 | 模型门禁零副作用；返工抛 "attempt limit"、不建 attempt、不新开 run 目录 | 通过 | 准入 1/10 |

## 7. 任务面板与桌面壳：合成证据与未覆盖

**已用合成数据验证（数据/格式化/源码层）**

- 10 种 `displayState` 全覆盖且 label 唯一；未知状态降级为 unknown 而不是崩溃。
- 报告 ≠ 完成：`proofs()` 的三条来源分开，worker 自报通过不构成独立验收。
- 时间：合法午夜可渲染、非法串「未提供」、缺失「未提供」；**数值 0 归为缺失**（O3）。
- null 与零分流：`amount`/`formatCount`/`formatCredits`/`formatRatio`/`formatStamp`/`seconds`。
- 恶意 HTML 与脚本只作文本；`querySelectorAll("img"/"script")` 为 0。
- 事件去重、旧响应丢弃、键盘主路径、焦点恢复：源码级断言（`app.mjs:442/448/470/492/536/611-642`、`backToList`）。

**明确未覆盖（必须实窗）**

- F17 四个指定尺寸的实测与整体横向溢出；F18 全主路径键盘、焦点可见、200% 缩放。
- F12 运行时同 eventId 双页合并；F09 任务 A/B 与换场景乱序。
- 读屏（屏幕阅读器）完全未测：本报告不写「可访问性通过」。
- 桌面壳（受控桌面）的截图、DPR 变化、真实滚动条与打印样式均未验证。

## 8. 交 10 线的 10 张真实异常操作卡

通用前置（每张卡都适用，不再重复）：

- 使用**新的**受控任务与**新的**原生会话；不触碰任何历史未知任务、不杀共享原生进程、不重置共享库。
- 模型必须由用户当场选择并确认价格（AGENTS.md 要求），不预选、不默认免费。
- 每张卡记录：`runs/<attemptId>/state.json`、`cancel.json`、`late-report.json`、`claim.json` 快照，原生会话在操作前后的 idle/working 状态截图，面板截图。
- 停止核对口径：`hasNativeStopEvidence(snapshot)===true` 且 `nativeStoppedAt` 与终态事件一致；仅「界面显示已停止」不算。

| # | 卡片 | 原生触发方法 | 范围与风险 | 期限/轮次 | 取消与停止核对 | 需要用户授权与人工条件 |
|---|---|---|---|---|---|---|
| R1 | 准备不确定 | 在 ensure_workspace 创建会话时断开 CDP 端口（不影响其它会话） | 只影响新会话；可能留下一个 uncertain 原生会话，需人工确认后手工清理 | 期限 10 分钟；1 轮 | 记录 `reservations` 与 `workers.state=uncertain`；不得重试同键 | 允许一次真实准备调用；人工在场观察原生窗口 |
| R2 | 投递不确定 | 派发瞬间关闭该会话所在窗口或断开 CDP | 只影响该任务；可能产生一个「已发出但无回执」的原生轮次 | 期限 10 分钟；1 轮 | 无 `request.json`、op=`outcome_unknown`；原生窗口需人工确认确实未执行 | 允许一次真实派发；用户确认不自动重试 |
| R3 | 报告先到原生忙 | 让 worker 先提交报告，保持原生会话 working（不点停止） | 只影响该任务；无需破坏进程 | 期限 15 分钟；1 轮 | `checks()` 应 `STOP_UNCONFIRMED`；原生仍 working 截图 | 允许真实报告；用户确认「不接受」 |
| R4 | 领取后取消 | claim 后在面板点停止 | 只影响该任务 | 期限 10 分钟；1 轮 | `cancel.json` 存在、无 `reportAuthentication`、容量是否保留 | 允许一次停止操作 |
| R5 | 到期迟到 | 用受控配置把该任务 deadline 设为近过去（不改全局 TTL） | 只影响该任务；需保证不误伤其它任务 | 期限 2 分钟；1 轮 | `late-report.json` 存在且 blocked、不可 accept | 允许修改该任务的期限配置；用户确认放弃该结果 |
| R6 | 错会话归属 | 用另一个真实会话的请求对当前 attempt 报告 | 只影响该 attempt；不写入成功 | 期限 10 分钟；1 轮 | 报错含 session/lease；journal 仍 working | 允许两个真实会话（否则跳过该卡） |
| R7 | 错执行器同键 | 用同一 operationId 但 `executorId:"dsh"` 重发 | 只影响该操作；不应产生第二次派发 | 期限 10 分钟；1 轮 | `OPERATION_CONFLICT`；send 操作仍 1 条 | 允许一次被拒绝的调用 |
| R8 | 预算耗尽 | 受控任务 `maxAttempts=1`，跑完一轮再返工 | 只影响该任务；不会自动第四次派发 | 期限 15 分钟；2 轮内 | 返工被拒、attempt 仍 1、无新 run 目录 | 用户确认预算为 1 且不修改 |
| R9 | 旧 attempt/review/源码 | 审查 pending 时改受保护文件，或用旧 reviewId 接受 | 只影响该任务；不改共享源码 | 期限 15 分钟；1 轮 | `REVIEW_STALE`/拒绝接受；旧 review 记录不可变 | 允许一次越界写（在受控工作区） |
| R10 | 资源故障期间停止 | 让统计源不可读（例如断开其数据文件的可读权限），同时取消任务 | 只影响读路径；不改任务库 | 期限 10 分钟；1 轮 | 列表/详情仍 200、统计 503、取消生效 | 允许一次权限变更并立即恢复；用户确认恢复后复核 |

## 9. 覆盖与未覆盖汇总

**本线实际覆盖（合成，可重复执行）**

- 审查四层：命令语义（unknown/failed/checker_error）、不可变 reviewId、accept 前置与原子性、`task_closed` 唯一性；旧 attempt/review 失效；基线篡改与伪造证据拒绝。
- 准入与派发：12 类异常全部至少一条用例；断言落在 SQLite 状态、`runs/` 文件、操作记录条数、准备/观察/提示计数上。
- 导出与凭据：白名单、双路脱敏、目标逃逸、事件流降级、统计缺失不补零。
- 模板：legacy 升级不携带身份/授权、实例化 `authorization:null`、归档与政策模板拒绝。
- 任务面板语义：10 态、报告≠完成、时间与 0/null、恶意 HTML 只作文本、导航与退避（含源码级去重/旧响应/焦点断言）。
- 资源故障独立性：统计源全坏时任务列表/详情/取消仍可用，故障以 503 有界返回。

**本线明确未覆盖**

- 任何「真」证据：真实 WorkBuddy 桌面派工/报告/停止、真实 DSH 宿主与会话、真实模型选择与报价、真实安装/升级/回退。
- 任何「窗」证据：四个指定尺寸、200% 缩放、键盘全主路径实测、读屏、打印/DPR 变化。
- 双进程并发同键（本线为同进程两个 SQLite 连接）；真实截止后重连；中文与空格路径；第二台物理 Windows。
- 生产 MCP 运行摘要、生产协作政策与容量记录的核对（D0 事实按原文引用，未重跑）。

**不得据本报告得出的结论**

- 不得写「53 项通过」「可发布」「已验收」；本线只把「合」证据补齐了一部分，且新增了 O1–O5 五条口径记录。
- 不得把第 7 节的源码级断言当成界面行为通过；也不得把 R1–R10 操作卡当成已执行。

## 10. 交接、集成请求与开放问题

**集成请求（给 G3/集成人）**

| 文件 | 原因 | 合同/补丁 | 复验 |
|---|---|---|---|
| `docs/D0_D1_DELIVERY_READINESS.md`（53 项表） | 本线新增了合成证据与 5 条口径记录，状态列需要按第 5 节更新 | 用 §5.1–5.3 的「本轮新增可观察子断言 / 本轮结果 / 仍未覆盖」替换对应行的「证据位置/状态/剩余动作」，其余列不动 | 更新后重跑第 2 节 #4–#10，确认仍是同一 SHA 的计数 |
| `docs/delivery/STATUS_INDEX.md` | L08 已产出独立验收报告与专项脚本 | 增加一行指向本文件，并注明「仅合成证据，真实/窗口未执行」 | 人工核对链接 |
| 部署/环境说明 | 本机存在多个 WorkBuddy 安装/数据目录，直接 `npm test` 会因发现歧义整体失败（172 例均为同一原因） | 在验收/开发环境说明里要求显式设置 `WORKBUDDY_CLI_ELECTRON` 与 `WORKBUDDY_CONFIG_DIR` | 设置后全量回归应回到 0 fail（见 §2.1） |

**开放问题（交 10 线/产品）**

1. O1 的错误码分层是否要统一为单一「缺模型」码。
2. O3 把数值 0 当缺失时间是否符合预期；若真实来源可能出现 epoch 0，需要显式渲染。
3. F17/F18/读屏没有任何窗口证据，需在真实浏览器里补齐后才能动 F 的状态。
4. `runs/` 目录除 `run-*` 外还有其它条目（O4），若面板或导出按目录数推断派发次数会误判。



