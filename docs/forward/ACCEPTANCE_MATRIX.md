# 53 项统一验收矩阵（原语义，逐项可观察）

本文件是**验收口径的唯一矩阵**。编号、场景名、判据一律取自原设计：

- V、C 组：`docs/ACCEPTANCE.md` 的两张表（原样引用「场景」与「必须观察到的结果」两列）。
- F 组：`docs/FRONTEND_TASK_PANEL_DESIGN.md` §13 验收清单（原样引用「场景」与判据列）。

历史 `docs/forward/SCENARIO_INDEX.md` 里被改写的名字（例如把 F06 写成「实窗渲染」、把 F14 写成「真实 DOM」）**不是规格**，本矩阵按原文恢复：F06 是「原生等待」，F14 是「内容安全」。结构一致性由 `gateway/scripts/check-acceptance-matrix.mjs` 机器校验（`npm run acceptance:check`），不靠人眼。

## 0. 读法与枚举

| 概念 | 取值 | 含义 |
| --- | --- | --- |
| 证据维度 | `source` / `synthetic` / `window` / `live` / `installed` / `ci` / `second_machine` / `release` | 分别记录，不互相顶替。F 原型的模拟数据是其合法证据；V/C 要求真实原生的条件不能由模拟代替。 |
| 适用模式 | `prototype` / `read-only` / `manual` / `recommend` / `automatic` | 同一项在不同模式下的判据可能不同；`automatic` 只在有效预授权存在时成立。 |
| 本轮结果 | `passed` / `failed` / `unknown` / `blocked` / `not_run` | `unknown`＝有观察但不足以证明；`blocked`＝缺外部条件；`not_run`＝本轮没做。**没有任何一项因为「源码改了」而变成 `passed`。** |
| N/A | 需要具体需求依据 | 不允许用「环境没有」代替；本矩阵本轮没有任何 N/A。 |

**证据失效规则**

1. 换候选后，`source`/`synthetic` 证据按受影响文件重验；受影响范围 = 本次 diff 触及的 `gateway/src/**`、`gateway/scripts/**`、`gateway/skills/**`、前端资源。
2. `window`/`live`/`installed`/`second_machine` 证据与**具体候选哈希**绑定；候选一变即失效，必须重取，不能挂到新构建上。
3. `ci` 证据只证明该次提交的自动检查，不证明实机；`release` 证据只证明包字节与清单一致，不证明运行。
4. 证据文件缺失或无法解析时，该项自动降为 `unknown`。
5. 旧结论只能作为历史记录引用，不能覆盖新观察；出现冲突时以新观察为准并在「下一任务」列登记补验。

## 1. V01–V15

| 编号 | 场景（原文） | 判据（原文） | 可观察子断言 | 模式 | 原任务 | 本轮结果 | 证据 | 下一任务 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V01 | 正常修复和必需测试 | 身份、范围正确，停止确认，独立验收后才 accepted | ①身份/范围字段在派工时冻结；②停止证据来自原生而非报告；③accept 前必须有不含结论字段的检查项 | manual, automatic | D1-02 | unknown | `gateway/test/task-reviews.test.ts`、`t7d-native-stop-declaration.test.ts`（source） | WB35 真实派工闭环 |
| V02 | 原生输入等待，详情可用/未知 | 准确显示处理位置或未知；不代批、不重派，期限不延长 | ①已知输入显示位置；②未知显示未知而非猜测；③等待期间 deadline 不变且无重派 | manual | D1-03 | unknown | `gateway/test/native-desktop-trigger.test.ts`（source） | WB35 真实等待态 |
| V03 | 报告先到、原生仍忙 | 等待停止，accept/rework/new dispatch 均被程序拒绝 | ①报告到但 busy 时三种动作全拒；②`STOP_UNCONFIRMED` 可见；③终态后才可审查 | manual | D1-04 | unknown | `gateway/test/t3-admission.test.ts`（source） | WB35 真实窗口 |
| V04 | 已取消、停止不明或忙碌会话 | 不恢复已取消任务，不误停其他会话，不释放不确定容量 | ①取消后不复活；②他会话工作不被误停；③未知占用不释放 | manual | D1-03 | unknown | `gateway/test/native-desktop-trigger.test.ts`、`workspace-worker-reclaim.test.ts`（source） | WB35 真实误停反例 |
| V05 | 截止后恢复连接及迟到报告 | 原期限和终态保留，迟到报告不可验收，发生与观察时间分开 | ①过期 attempt 拒绝验收；②期限未被延长；③`occurredAt` 与 `observedAt` 分列 | manual | D1-04 | unknown | `gateway/test/task-views.test.ts` 等（source） | WB32 时间语义复核 |
| V06 | 同键重试、不同约定及双进程请求 | 原生只派一次，冲突可解释，结果不明不换键重派 | ①同键只派一次；②冲突返回可解释错误码；③结果不明不换键 | manual | D1-04 | unknown | `gateway/test/t3-admission.test.ts`、`t4a-operation-admission.test.ts`（source） | WB09 组合回归已完成 |
| V07 | 文件越界、额外 metadata、用户旧修改 | 本程序处理的越界操作被拒绝，已观测的原生越界交付不能验收；覆盖范围明确，不吞掉旧改动 | ①越界写路径被拒；②dirty/staged 不被吞；③原生越界交付标记不可验收 | manual | D1-04 | unknown | `gateway/test/workspace-protection.test.ts`（source） | WB10 项目选择与范围 |
| V08 | 检查后源码改变或旧轮次验收 | EVIDENCE_STALE/STALE_ATTEMPT，没有虚假通过 | ①检查后改文件触发 `EVIDENCE_STALE`；②旧 attempt 触发 `STALE_ATTEMPT`；③不出现虚假通过 | manual, automatic | D1-04 | unknown | `gateway/test/evidence-consistency.test.ts`（source） | WB13 详情/返工/审查 |
| V09 | 内容正确、表现形式不同 | 按原约定进行语义审查；checker_error 不归 worker 内容失败 | ①同义不同格式按约定审查；②`checker_error` 单列；③不计 worker 返工 | manual | D1-04 | unknown | `gateway/test/task-reviews.test.ts`（source） | WB21 统计分层 |
| V10 | 三轮耗尽、模型缺失或违反主动免费限定 | 无第四次派发、无擅自换模型、无 UI 绕过路径；费用未知不等于模型身份未知 | ①第三轮后不再派发；②缺模型拒绝而非换模型；③UI 无绕过入口 | manual, recommend, automatic | D2-04 | unknown | `gateway/test/t3-admission.test.ts`（source） | WB22/WB27 推荐与政策 |
| V11 | 浏览器刷新、掉线和旧 revision | 恢复原任务，不重复动作，前后端一致 | ①刷新后同 taskId/attemptId；②旧 revision 动作被拒；③面板 allowedActions 与服务端一致 | manual | D1-03 | unknown | `gateway/test/desktop-control-runtime.test.ts`（source） | WB13/WB34 面板复原 |
| V12 | 数值缺失、重复事件、人工请求/回复 | null 保留，事件不重复计数，人工 episode 和返工/恢复可复算 | ①缺值保持 null；②同 eventId 不重复计数；③从原账复算人工 episode | manual, automatic | D6-01 | unknown | `gateway/test/usage-ledger.test.ts` 等（source） | WB20/WB21 计量 |
| V13 | Windows 安装、构建及版本切换 | 按 Windows 文档验收；新运行哈希可核对，旧任务不被重放；配置/历史保留，卸载可恢复原技能 | ①安装后 codeHash 可核对；②旧任务不重放；③卸载恢复原技能 | manual | D7-01 | blocked | `docs/delivery/INSTALL_AND_ROLLBACK_PLAN.md`（plan） | WB38 安装/升级/回退 |
| V14 | Windows 路径、进程与服务差异 | 记录系统/架构及 WorkBuddy 版本；中文/空格目录、进程归属、真实领取、停止、返工、取消和重连均有证据；服务失败不绕过共用约束 | ①中文/空格路径可用；②Job 后代不逃逸；③服务断连不绕过容量 | manual | D7-01 | unknown | `gateway/test/bounded-command.test.ts`、`command-cleanup.test.ts`（source） | WB39 第二台机 |
| V15 | 第二台 Windows 实机复现与证据分类 | 本机隔离、CI、真实桌面与第二台物理机器分别报告；同一人操作两台机器须如实标记，不冒充独立操作者复现 | ①四类证据分列（隔离/CI/真实桌面/第二台机）；②操作者身份如实标记；③CI 不冒充异机 | manual | D7-02 | blocked | — | WB39 需第二台物理机 |

## 2. C01–C18

| 编号 | 场景（原文） | 判据（原文） | 可观察子断言 | 模式 | 原任务 | 本轮结果 | 证据 | 下一任务 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C01 | direct、用户指定及自动模式 | 小改可直接处理；用户覆盖优先；direct 不创建虚假原生轮次；automatic 只用有效预授权 | ①direct 不产生原生轮次；②用户选择覆盖推荐；③未获预授权时 automatic 拒绝 | manual, recommend, automatic | D5-03 | unknown | `gateway/test/automation*.test.ts`（source） | WB02 ADR-01 决议落地 |
| C02 | 方案预览、确认与并发消费 | 预览不调用模型、不切会话；未回复不启动；旧 revision/过期拒绝；同方案不同 taskId 不重复派工 | ①预览零模型请求；②未确认不派工；③过期/旧 revision 拒绝；④同方案二次消费拒绝 | manual | D2-03 | unknown | `gateway/test/plan-cli.test.ts` 等（source） | WB11 预览一次消费 |
| C03 | DSH 无会话、多会话和错目录 | 返回精确候选/原因；不选最新会话、不自动造替代会话；已有任务只观察原绑定 | ①零会话返回原因；②多会话给候选不猜；③错目录拒绝；④已有任务不改绑定 | manual | D2-01 | unknown | `gateway/test/dsh-discovery.test.ts`（source） | WB10 真实 DSH 会话 |
| C04 | 用户选择 DSH 模型与推理档位 | 目录、准备读回、真实请求层证据一致；不把 Codex Reviewer 配置当 worker 模型；代理证据层级明确 | ①目录与读回一致；②请求层证据单独登记；③Reviewer 配置不被冒用 | manual | D2-02 | unknown | `gateway/test/dsh-adapter.test.ts`（source） | WB15/WB18 真实请求证据 |
| C05 | 用户选择、付费/费用未知、模型缺失或绑定漂移 | 无默认固定/免费模型；用户了解费用后明确选择并确认，未回复不派工；主动免费限定和旧政策仍生效；拒绝静默回退，停止未证实保留占用 | ①无预选模型；②未知费用知情确认；③未确认不派工；④旧免费政策不被放宽 | manual, recommend | D2-02, D4-03 | unknown | `gateway/test/model-policy*.test.ts`（source） | WB10/WB22 选模与报价 |
| C06 | DSH 正常交付、返工与独立验收 | 原 task/session 及真实 DSH 来源可核对；报告、停止、插件审查、最终 accept 分开；自动审查故障不改写为成功 | ①来源可核对；②四层证据分开；③审查故障不改写通过 | manual | D2-02 | unknown | `gateway/test/dsh-adapter.test.ts`（source） | WB15 产品链路 |
| C07 | 跨执行器双进程、投递或模型准备结果不明 | 共同遵守容量 1；意图/回执重启保留；旧任务未知不新派、不按 TTL 释放、不切换执行器绕过 | ①容量 1 串行；②重启后意图仍在；③未知不释放不绕过 | manual | D5-02 | unknown | `gateway/test/capacity-resource.test.ts`（source） | WB09/WB27 |
| C08 | 网关账号池、Key 路由与共享额度 | 仅核验路由后称任务可用；未核验标网关汇总；同池去重，不称 DSH 独占 | ①未核验标 `routing_unverified`；②同池去重；③不宣称独占 | manual, read-only | D3-01, D3-02 | unknown | `gateway/test/resource-routing.test.ts`（source） | WB16–WB19 资源契约 |
| C09 | 估算、上游报告、耗尽与未知 | 来源/单位/方法可见；null 不等于 0；有触顶证据才称 exhausted；token/积分/货币不相加 | ①单位与来源可见；②null 不写 0；③无触顶证据不称 exhausted；④异单位不相加 | read-only | D3-03 | unknown | `gateway/test/resource-source-acceptance.test.ts`（source） | WB17/WB19 |
| C10 | 额度源失联、超时和过期响应 | 缓存标 stale；旧响应不覆盖新快照；任务查询/停止独立可用；不自动换来源或停止任务 | ①失联标 stale；②旧响应不回写；③任务查询/停止不受影响；④不自动换源 | read-only | D3-04 | unknown | `gateway/test/resource-routing.test.ts`（source） | WB19 资源故障隔离 |
| C11 | 刷新资源、后台采集与主动探测 | GET 零任务写入、零模型请求；后台采集有退避；主动探测需独立授权和计量，外部归档写入如实声明 | ①GET 零副作用；②退避有上界；③探测需授权与计量 | read-only | D3-04 | unknown | `gateway/test/desktop-readonly-resources.test.ts`（source） | WB19 |
| C12 | 多客户端并发消耗与任务计量 | 无请求关联时任务消耗 null；不能用余额差；重试、worker、审查各自去重，coverage 不完整如实标明 | ①无关联即 null；②余额差不作成本；③去重分层；④coverage 如实 | read-only, manual | D6-01 | unknown | `gateway/test/usage-ledger.test.ts`（source） | WB20 计量与归因 |
| C13 | 付费授权与硬费用限制 | 要求硬上限而来源无法控制时拒绝；估算不足不冒充硬限制；免费标签不代表全过程零成本 | ①`hardCap` 恒 unsupported；②估算不当硬限；③免费标签不等于零成本 | manual | D3-03, D4-02 | unknown | `gateway/test/credit-balance.test.ts`（source） | WB22 推荐与费用 |
| C14 | 方案审计、政策撤回与项目模板 | 原方案版本和用户覆盖保留；派工重新核验政策；模板不复用身份/旧证据、不增加旧预算、不授权部署 | ①方案版本留痕；②派工重核政策；③模板不带身份与旧预算 | manual, recommend, automatic | D4-01, D5-01, D6-03 | unknown | `gateway/test/automation-policy*.test.ts`（source） | WB25/WB26 模板与政策 |
| C15 | 额度连接、面板和导出边界 | 浏览器不持有网关管理密钥；固定登记连接；拒绝任意 URL 代理；日志/事件/导出无凭据与原始账号 | ①浏览器无管理密钥；②连接固定登记；③拒绝任意 URL；④导出脱敏 | read-only | D3-03, D6-04 | unknown | `gateway/test/resource-source-acceptance.test.ts`（source） | WB31 导出 |
| C16 | schema 与历史数据升级 | vnext-1 摘要/幂等不变；旧解析器拒绝新版；迁移回滚有证据；旧未知来源/实际模型不造值 | ①v1 摘要不变；②旧解析器拒 v2；③迁移可回滚；④不造值 | manual | D7-01 | unknown | `gateway/test/task-contract.test.ts`（source） | WB32/WB38 |
| C17 | 切换执行器意图、范围与旧验收 | 首期拒绝 task 内换执行器/模型；旧源码/旧轮次证据不可验收；用户改动保护规则两执行器一致 | ①task 内换执行器被拒；②旧证据不可验收；③两执行器保护规则一致 | manual | D5-02 | unknown | `gateway/test/coordinator.test.ts`（source） | WB32 跨能力异常 |
| C18 | 宿主兼容、质量统计与真实发布 | 记录实际 DSH/代理/运行版本；真实派工/停止有证据；成功率附样本数/时间范围，检查器错误单列，不宣称未测节省 | ①版本组合留痕；②成功率带样本数与区间；③检查器错误单列 | manual | D6-05 | unknown | `gateway/test/usage-statistics*.test.ts`（source） | WB43 总验收 |

## 3. F01–F20

| 编号 | 场景（原文） | 判据（原文） | 可观察子断言 | 模式 | 原任务 | 本轮结果 | 证据 | 下一任务 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F01 | 环境独立 | WorkBuddy关闭、真实网关未启动时仍能启动mock原型。 | ①无 WorkBuddy 可启动；②无真实网关可启动；③不隐式起服务 | prototype | D7-01 | unknown | `gateway/workbench/test/*.test.mjs`（synthetic） | WB08 桌面首次启动 |
| F02 | 明确模拟 | 页面各场景与截图持续显示模拟标记。 | ①每场景有模拟标记；②截图同样带标记 | prototype | D7-03 | not_run | — | WB34 面板复核 |
| F03 | 状态覆盖 | 10种displayState全部可选择、文案不混淆。 | ①10 态都可选；②文案区分明确 | prototype | D1-01 | unknown | `gateway/workbench/test/model.test.mjs`（synthetic） | WB13 面板 10 态 |
| F04 | 报告不等于完成 | M02先显示报告与等待停止，后显示待验收。 | ①报告到不显示完成；②等待停止独立可见；③待验收在终态后 | prototype, manual | D1-01 | unknown | `gateway/workbench/test/attention.test.mjs`（synthetic） | WB13 |
| F05 | 严格只读 | 数据提供器无写方法，网络检查无真实网关/模型/写操作请求。 | ①提供器无写方法；②无模型请求；③无真实网关写 | read-only | D1-01 | unknown | `gateway/test/workbench-http.test.ts`（source） | WB19/WB28 |
| F06 | 原生等待 | 已知/未知详情分别展示，不出现网页代批。 | ①已知详情展示位置；②未知展示未知；③无网页代批入口 | manual | D1-01 | unknown | `gateway/test/desktop-control.test.ts`（source） | WB13 真实等待态 |
| F07 | 取消与到期 | 不出现恢复已取消任务、延长期限或迟到报告成功的误导。 | ①取消后无恢复入口；②不延长；③迟到报告不显成功 | manual | D1-01 | unknown | `gateway/test/desktop-control-runtime.test.ts`（source） | WB13 |
| F08 | 原身份恢复 | 刷新/断线恢复仍展示原taskId、attemptId、deadline。 | ①三个身份字段一致；②断线重连不换身份 | manual | D1-03 | unknown | `gateway/test/task-view*.test.ts`（source） | WB13/WB35 |
| F09 | 旧响应丢弃 | 延迟任务A响应不得覆盖已选择的任务B；换场景同样成立。 | ①A 的迟到响应被丢弃；②换场景同样丢弃 | prototype | D1-03 | unknown | `gateway/workbench/test/read-store.test.mjs`（synthetic） | WB34 |
| F10 | 时间正确 | 固定时钟、零点、后台恢复、非法时间可复现；前端不改业务状态。 | ①固定时钟可复现；②非法时间降级；③前端不改状态 | prototype | D6-02 | unknown | `gateway/workbench/test/model.test.mjs`（synthetic） | WB21/WB34 |
| F11 | 未知值保留 | null不显示成0；未观测变更不显示“零改动”。 | ①null 不显示 0；②未观测不显示零改动 | prototype | D6-01 | unknown | `gateway/workbench/test/model.test.mjs`（synthetic） | WB17/WB34 |
| F12 | 事件与历史 | 同eventId不重复；前轮失败保留，发生/观测时间可区分。 | ①同 eventId 去重；②前轮失败保留；③两时间可分 | prototype | D6-01 | unknown | `gateway/workbench/test/model.test.mjs`（synthetic） | WB21/WB34 |
| F13 | 数据矛盾降级 | 未知枚举/版本、缺字段、证据矛盾有核查提示，不崩溃。 | ①未知枚举不崩；②缺字段提示；③矛盾提示 | prototype, manual | D0-02 | unknown | `gateway/test/readiness.test.ts`（source） | WB06 已完成接线，WB34 复核 |
| F14 | 内容安全 | HTML/脚本字符串只作为文字，无脚本执行、命令或本机路径打开。 | ①HTML/脚本按文字渲染；②不执行脚本；③不打开本机路径 | prototype, manual | D0-02 | unknown | `gateway/test/task-view-projection.test.ts`（source） | WB33 隐私与注入 |
| F15 | 内容范围 | 合成数据无真实账号、会话、私有路径、业务日志。 | ①无真实账号；②无私有路径；③无业务日志 | prototype | D7-05 | unknown | `gateway/scripts/package*`（source） | WB31 导出脱敏 |
| F16 | 文件/检查语义 | 越界、旧改动冲突、检查器错误、未知结果不合并成通过。 | ①越界单列；②旧改动冲突单列；③checker_error 单列 | prototype, manual | D0-02 | unknown | `gateway/test/task-reviews.test.ts`（source） | WB13/WB33 |
| F17 | 响应式 | 指定四个尺寸可阅读操作，页面无整体横向溢出。 | ①四尺寸可操作；②无整体横向溢出 | prototype | D1-01 | unknown | `gateway/workbench` 探针（synthetic） | WB14 可访问性 |
| F18 | 键盘与缩放 | 主要路径可用键盘完成，焦点可见，200%缩放可用。 | ①主路径键盘可达；②焦点可见；③200% 不破版 | prototype, manual | D1-01 | not_run | — | WB14 可访问性 |
| F19 | 构建与必要测试 | build/test退出0，记录实际命令与结果。 | ①build 退 0；②test 退 0；③命令与结果留档 | manual | D0-01, D7-04 | passed | `E:\javaproject\outputs\executor-plan-20261111\suite-baseline2.log`（source：1513/1501/0） | WB36/WB42 冻结候选与 CI |
| F20 | 交接清楚 | README、场景索引、联调缺口和未实现项齐全。 | ①README 有入口；②索引不缺项；③未实现项明示 | manual | D0-03 | unknown | 本文件、`docs/forward/WB0*_*.md` | WB40/WB43 文档与总验收 |

## 4. 原 31 项任务映射

每一项都必须至少被一个场景覆盖；覆盖它的场景即它的验收路径。

| 原任务 | 覆盖场景 | 对应本轮任务卡 |
| --- | --- | --- |
| D0-01 | F19 | WB00、WB36 |
| D0-02 | F13、F14、F16 | WB01 |
| D0-03 | F20 | WB01、WB40 |
| D1-01 | F03、F04、F05、F06、F07、F17、F18 | WB13、WB14 |
| D1-02 | V01 | WB03、WB13 |
| D1-03 | V02、V04、V11、F08、F09 | WB04、WB13 |
| D1-04 | V03、V05、V06、V07、V08、V09 | WB09、WB13 |
| D2-01 | C03 | WB10 |
| D2-02 | C04、C05、C06 | WB10、WB12、WB15 |
| D2-03 | C02 | WB11 |
| D2-04 | V10、C01 | WB12、WB27 |
| D3-01 | C08 | WB16 |
| D3-02 | C08 | WB17 |
| D3-03 | C09、C13、C15 | WB17、WB19 |
| D3-04 | C10、C11 | WB19、WB28 |
| D4-01 | C14 | WB22、WB23 |
| D4-02 | C13 | WB24 |
| D4-03 | C05 | WB23、WB24 |
| D5-01 | C14 | WB26 |
| D5-02 | C07、C17 | WB27 |
| D5-03 | C01 | WB02、WB29 |
| D6-01 | V12、C12、F11、F12 | WB20、WB34 |
| D6-02 | F10 | WB21 |
| D6-03 | C14 | WB25 |
| D6-04 | C15 | WB30、WB31 |
| D6-05 | C18 | WB21、WB43 |
| D7-01 | V13、V14、F01 | WB08、WB37、WB38 |
| D7-02 | V15 | WB39 |
| D7-03 | F02、F20 | WB40 |
| D7-04 | F19 | WB36、WB42 |
| D7-05 | F15 | WB37、WB41 |

## 5. 证据索引（本轮新增，按维度）

| 维度 | 文件 | 绑定 | 说明 |
| --- | --- | --- | --- |
| source | `E:\javaproject\outputs\executor-plan-20261111\suite-baseline2.log` | 工作树 `feat/executor-plan-20261111` @ 0919201 + WB05 修复 | 1513 tests / 1501 pass / 0 fail / 12 skip |
| source | `E:\javaproject\outputs\executor-plan-20261111\suite-wb03b.log` | 同上 + WB03 | 1520 / 1504 / 4 fail（三处已定位修复，见 WB00 记录） |
| source | `E:\javaproject\outputs\executor-plan-20261111\wb06-readiness-cli.json` | `scripts/readiness.mjs --json` | 五层就绪实测（toolResponsive ready，nativeOnline blocked） |
| source | `E:\javaproject\outputs\executor-plan-20261111\wb07-skill-drift.json` | `scripts/sync-skill.mjs --check --json` | bundled 同步、codex/dsh 漂移 |
| source | `E:\javaproject\outputs\executor-plan-20261111\wb09-admission.log` | 准入组合回归 | 53 tests / 53 pass |
| source | `gateway/test/automation-modes.test.ts`（4/4，5.4s） | ADR-01 两层决策 | 现役模式 `per_task_confirmed`；`src/**` 零处 `preauthorized_policy`；enabled≠armed |
| source | `E:\javaproject\outputs\executor-plan-20261111\suite-wb13.log` | 工作树 `feat/executor-plan-20261111` @ 0919201 + WB03/05/06/07/13 | 1552 tests / 1540 pass / 0 fail / 12 skip |
| source | `E:\javaproject\outputs\executor-plan-20261111\workbench-suite.log` | `node --test workbench/test/*.test.mjs` | 165 tests / 165 pass / 0 fail |
| source | `E:\javaproject\outputs\executor-plan-20261111\suite-freeze2.log` | 工作树 + WB10/12/16–33 全部改动 + `sqlite-busy` | 1557 tests / 1545 pass / 0 fail / 12 skip（冻结候选前一版证据） |
| source | `E:\javaproject\outputs\executor-plan-20261111\suite-wb38.log` | 同上 + 安装演练中的技能派生源修复 | **1563 tests / 1551 pass / 0 fail / 12 skip**（当前候选的全绿证据） |
| source | `E:\javaproject\outputs\executor-plan-20261111\wb36-workbench.log` | `node --test workbench/test/*.test.mjs` | 169 tests / 169 pass |
| source | `E:\javaproject\outputs\executor-plan-20261111\wb36-desktop.log` | `dotnet run --project desktop/test/PolicyTests.csproj -c Release` | 133 pass / 0 fail / 1 skip（symlink 权限） |
| source | `E:\javaproject\outputs\executor-plan-20261111\suite-freeze.log` | 同上，修复前 | 1555 / 1542 / 1 fail（`desktop-dispatch-e2e` 锁等待），保留作失败历史 |
| source | `gateway/test/sqlite-busy.test.ts` + `gateway/src/sqlite-busy.ts` | 锁等待预算可配置 | 2/2 通过；默认 15000，超时仍抛真实错误 |
| source | `gateway/test/release-pairing.test.ts` + `gateway/scripts/verify-pairing.mjs` | 配对校验器 | 5/5 通过 |
| source | `E:\javaproject\outputs\executor-plan-20261111\wb38-pairing.json` | release-wb38 两个 ZIP | `ok:true`、shared 782、mismatched 0、清单分歧 0 |
| source | `E:\javaproject\outputs\executor-plan-20261111\wb38-candidate-check.json` | 网关 ZIP | `ok:true`、782 files、`problems:[]` |
| source | `gateway/scripts/check-acceptance-matrix.mjs`（`npm run acceptance:check`） | 本文件自身 | `53 scenarios, 31 original tasks mapped` |
| installed | `E:\javaproject\outputs\executor-plan-20261111\wb38-doctor3.log`、`wb38-deployment-check.log`、`wb38-readiness.json`、`wb38-skill-check2.json` | release-wb37c 解包安装根 `gateway-v0.7.1-plan20261111` | 依赖安装 exit 0、`localSetupReady:true`、部署检查 exit 0、`toolResponsive ready`、技能三处同步 `inSync true`；详见 [WB35_WB38](WB35_WB38_INSTALLED_AND_WINDOW.md) |
| window（部分） | `E:\javaproject\outputs\executor-plan-20261111\wb35-desktop-printwindow.png`、`wb35-window-firstrun.png`、`wb35-window-render.png`、`wb35-status8.log` | 桌面壳 `desktop/app/WorkBuddy.Workbench.exe` + 安装根 | 真实窗口 853x573、标题 `WorkBuddy · 任务工作台`、分阶段真实文案；`controller` 阶段 `COMException` 未通过 → **面板渲染不计通过** |
| live（部分） | `E:\javaproject\outputs\executor-plan-20261111\live-send.log`、`live-runcheck.log`、`live-check2.log`、`live-cancel*.log`、`live-w*.log` | 真实 WorkBuddy 桌面端 + 已安装根，模型 `glm-5.3-flash`（用户选定，x0.08，金额 unknown） | 7 次真实派工、6 个任务：真实产出 `RESULT.md`/`PROOF.txt`；`$scope` 抓出 unauthorized 新增、命令证据只有 `run_review_command` 才成立（模型自述不采信）、`CAPACITY_OCCUPIED` 单槽、`STALE_REVISION`/`Source changed`、429/502/无报告三路径均 `blocked` 且**无自动重发**；**未跑到 `accept_task`**（上游 429 + 系统代理 502）。详见 [WB35_LIVE](WB35_LIVE_NATIVE_RUN.md) |
| second_machine / ci / release | 尚无 | — | 第二台机属 WB39；CI 回执见 [WB42](WB42_CI_READINESS.md)；发行签名属 WB41/WB43 外部项 |
| source | E:\\javaproject\\outputs\\executor-plan-20261111\\wb16-wb23.log | 资源/统计/用量 13 文件 | 152 tests / 152 pass / 0 fail |
| source | E:\\javaproject\\outputs\\executor-plan-20261111\\wb25-wb31.log | 模板/通知/导出 12 文件 | 92 tests / 92 pass / 0 fail |
| source | E:\\javaproject\\outputs\\executor-plan-20261111\\wb27-wb28.log | 自动政策 9 文件 + 视图 15 例 | 69 pass / 0 fail；视图 15/15 |
| source | E:\\javaproject\\outputs\\executor-plan-20261111\\wb32-fault-matrix.log | 故障/恢复/停止 10 文件 | 145 tests / 145 pass / 0 fail |
| source | E:\\javaproject\\outputs\\executor-plan-20261111\\wb33-security.log | 路径/HTTP/资源 5 文件 | 63 tests / 63 pass / 0 fail |
| source | gateway/workbench/test/recommendation-view.test.mjs + gateway/test/executor-modes-consistency.test.ts | WB10/WB12/WB24 | 12/12 与 3/3（本轮新增 4 + 3 例） |
| source | `E:\javaproject\outputs\executor-plan-20261111\wb40-pairing.json`、`wb40-candidate-check.json` | release-wb40 两个 ZIP | `ok:true`、shared 785 全同、mismatched 0、清单互认 785/0 分歧、`problems:[]` |
| installed | `E:\javaproject\outputs\executor-plan-20261111\wb41-pairing.json`、`wb41-candidate-check.json`、`wb41-installed-acceptance.log`、`wb41-installed-readiness.json` | `release-wb41b` 两个 ZIP + 解包后的隔离安装根 |`ok:true`、共用 798 文件全同、必需 11 项齐备、`problems:[]`；安装树内 `check-acceptance-matrix.mjs` exit 0；`readiness.mjs --json` 前后 `tasks.sqlite` 均不存在 |
| source | `gateway/test/skill-sync.test.ts`（新例 `a packaged installation compares installed copies with its bundled skill`） | 包内自检参照 bundled | 9/9 通过；故意改一字节仍报 `SKILL.md` 漂移 |
| installed | `E:\javaproject\outputs\executor-plan-20261111\wb40-installed-skill-check.json`、`wb40-upgrade-tar.log` | 升级到 release-wb40 的隔离根 `gateway-v0.7.1-plan20261111-wb40` | 解包 exit 0、`npm ci` 8393ms、`skill:check` exit 0（`sourceMode:"bundled"`、三副本 inSync）、doctor exit 0 |
| installed | `E:\javaproject\outputs\executor-plan-20261111\wb40-rollback-doctor.log` | 回退到升级前目录 | doctor exit 0；旧包 `skill:check` 复现「脚本不存在」→ 回退回到原样。见 [WB37](WB37_PAIRED_RELEASE.md) §4 |
| live（部分） | `E:\javaproject\outputs\executor-plan-20261111\live-010-state4.log`、`live-health.log`、`native-dump4.json` | 真实 WorkBuddy + `live-config/tasks-2.sqlite` | `live-accept-010`：原生认领 → 真实回合 → 写盘 `RESULT.md=TOTAL=11` → `report_received` → **`stop_unconfirmed`/`blocked`**（`call_f6f3bbab…` 无终态）。派工链路证明，验收闭环仍未达成；单槽被该任务占用。见 [WB35_LIVE](WB35_LIVE_NATIVE_RUN.md) §3.5 |
| source | `gateway/test/dsh-adapter.test.ts`（+3 例）、`outputs/codex-executor-plan-review-20261111/r1-dsh-adapter.log` | R1：共享 DSH 入口的 CommandSpec 准入 | 自由文本/越界 cwd 在 `TaskApplicationService.send` 内被拒（`prompts:0, selections:0`、任务与 baseline 不新增）；合法 CommandSpec 仍派工。40/40 通过 |
| source | `gateway/test/readiness-readonly.test.ts`（7/7）、`outputs/codex-executor-plan-review-20261111/readiness-write.mjs` 复跑 | R2：只读诊断不建库 | 空目录真实 probe 后 `afterDatabaseExists:false`、`files:[]`；非 SQLite 文件字节不变；并发只起一次子进程 |
| source | `gateway/test/readiness-readonly.test.ts` 的 `probeEnvironment` 用例、`outputs/codex-executor-plan-review-20261111/r3-probe-binding.mjs` | R3：探针绑定调用方配置 | `selected`/`conflicted` 都探测被选实例（`dataRoot E:\selected-instance`）；不传 `config` 时 `ENV_MISSING`，无隐式继承 |
| source | `gateway/test/release-pairing.test.ts`（14/14）、`outputs/codex-executor-plan-review-20261111/r4-pairing-wb40.json` | R4：配对不再只比交集 | 缺必需文件/缺 manifest/摘要不符/零交集/版本不匹配全部 `ok:false`；wb40 复跑报 `dist/health-entry.js is missing from both archives` |
| source | `gateway/test/acceptance-matrix.test.ts`（9/9）、`gateway/scripts/package.mjs` 的 `MIRRORED_DOCS` | R5：安装包自带验收输入 | 安装布局能找到 `docs/` 输入并通过；缺输入时逐条点名；发布镜像 4 份输入，缺失即报错 |
| source | `outputs/executor-plan-20261111/suite-r5b.log` | R1–R5 之后的整套回归 | 见 [REVIEW_R1_R5_FIXES](REVIEW_R1_R5_FIXES.md) 与本轮数字 |

## 6. 与 `SCENARIO_INDEX` 的差异（口径恢复）

| 项 | 历史索引写法 | 原设计 | 采用 |
| --- | --- | --- | --- |
| F06 | 「实窗渲染」 | 「原生等待」 | 原设计 |
| F14 | 「真实 DOM 夹具」 | 「内容安全」 | 原设计 |
| 全部 53 项 | 「本轮没有任何一项改判为整项通过」 | 同 | 保留该结论，不因本轮源码改动改判 |
