# WB43 · 成品总验收（本轮交付档案）

本文件是这一轮的**总账**：哪些卡做完了、证据在哪、哪些没做完以及为什么。它不新增结论，只把分散在 [验收矩阵](ACCEPTANCE_MATRIX.md) 与各任务文档里的状态汇总成一张可核对的表。

## 1. 口径

- `done_source`：源码、测试、文档齐备，证据是**本机 source 维度**（测试日志、校验报告）。不等于实机验收。
- `done`：`done_source` 之外还有原生/窗口/安装层证据（本轮 3 张：WB01 矩阵机器校验、WB03 派前拒绝、WB05 监督器）。
- `blocked_external`：**每一张都写明缺的那一件具体东西**（见第 4 节与 `任务台账.json` 的 `dimensions.external`），不是「代码没写」的同义词。台账同时按五维记录每张卡：`implementation` / `automated` / `window` / `live` / `installed` + `external`，所以标签数不等于完成率。
- 证据维度：`source` / `synthetic` / `window` / `live` / `installed` / `ci` / `second_machine` / `release`。本轮产出 `source`（含合成夹具）与 `installed`（隔离安装演练），`window` 与 `live` 取得部分证据（真实窗口与分阶段文案、真实派工与写盘产物；面板未渲染），`live` 的验收闭环已跑通（`live-accept-014`/`015` 两条 `accepted`），`ci` 取得 Release pairing 的绿色回执。
- 交付提交：`41e9595`（技能/门禁/就绪/发布主线）→ `4aa0b23`（包里补维护脚本并让安装副本自检）→ `d866a09`（记录首轮远端 CI）。三笔均已推 `origin/feat/executor-plan-20261111`；台账 `delivery_commit` 指向最近一笔。

## 2. 44 张卡的状态

| 组 | 任务 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| 基线与契约 | WB00 / WB01 / WB02 | done_source / **done** / done_source | `baseline.json`；53 项矩阵 + `acceptance:check`；ADR-01 + `automation-modes.test.ts` 4/4 |
| P0 缺陷 | WB03 / WB04 / WB05 | **done** / done_source / **done** | CommandSpec 派前拒绝；四类归属样本；三阶段监督器 + DLL 缓存 |
| 就绪与技能 | WB06 / WB07 | done_source / done_source | 五层 + `observer` + 活体探针；`sync-skill` 漂移检测 |
| 桌面主路径 | WB08 / WB10 / WB11 / WB12 / WB13 / WB14 | blocked_external / done_source / done_source / done_source / done_source / blocked_external | 选择页 12/12、模式一致性 3/3、plan 一次消费、六条拒绝文案 |
| 资源与用量 | WB16–WB25 | WB17/18/21/22/23/24/25 done_source；WB16/19/20 blocked_external | `wb16-wb23.log` 152/152、`wb25-wb31.log` 92/92 |
| 自动模式 | WB26–WB29 | WB27/28 done_source；WB26/29 blocked_external | `wb27-wb28.log` 69/69、`automation-view` 15/15 |
| 通知与导出 | WB30 / WB31 | done_source | `wb25-wb31.log` 92/92 |
| 跨能力异常与安全 | WB32 / WB33 | done_source | 145/145、63/63 |
| 矩阵与实机 | WB34 / WB35 | blocked_external / blocked_external（live 端闭环已跑通） | 矩阵 53/53 有行有据；WB35 已取到真实窗口、分阶段失败、7 次真实派工与三类失败路径，并跑通两次完整 accept 闭环（`live-accept-014`/`015` → `accepted`，见 [WB35_LIVE](WB35_LIVE_NATIVE_RUN.md) §3.6）；仍缺真实 DSH 端闭环、面板渲染、`turn_end` |
| 冻结与配对 | WB36 / WB37 | done_source | `suite-npx-tsx.log` 1590/1578/0/12（串行）；`wb41c-pairing.json` ok、799 共用、`wb41c-candidate-check.json` `problems:[]` |
| 安装与第二台机 | WB38 / WB39 | done_source / blocked_external | 隔离根完成解包/依赖/建库/doctor/部署检查/技能落位，并做完整**升级与回退演练**（升到 wb40 后 `skill:check` exit 0、回退后 doctor exit 0，见 [WB37](WB37_PAIRED_RELEASE.md) §4）；改写运行安装与第二台 Windows 仍缺 |
| 文档与许可 | WB40 / WB41 | done_source / blocked_external | README 唯一入口 + 手册；依赖披露完成，许可证与签名属权利人 |
| CI 与发行 | WB42 / WB43 | blocked_external | workflow 就绪、本地复演完成；远端回执与发行授权缺 |

## 2.5 本轮补的三件事（提交之后）

提交 `41e9595` 之后又做了三项，均已并入上面的状态与数字：

1. **发布包自检缺口**：wb37c 时代的包里没有 `scripts/sync-skill.mjs`、`scripts/verify-pairing.mjs`、`scripts/check-acceptance-matrix.mjs`，但 `package.json` 的 `skill:check` / `release:pairing` / `acceptance:check` 都指向它们 —— 装好的包跑不了自己文档里的自检。修法：三个脚本进 `scripts/package.mjs` 允许清单；`sync-skill.mjs` 在没有仓库根时以 bundled 副本为参照（`sourceMode:"bundled"`），并加一条用例锁住。release-wb40 起可用。
2. **升级/回退演练**：隔离根真实替换（备份 → 解包 wb40 → bootstrap/doctor/skill:check → 删除并还原备份 → doctor 复验），升级与回退都可逆，回退回到旧包的确切状态（含它的自检缺口）。
3. **live 派工新证据**：`live-accept-010` 走通「派工 → 原生认领 → 真实回合 → 写盘 `RESULT.md=TOTAL=11` → 报告到达」，但原生最后一条工具调用没有终态 `tool_call_update`，产品判 `stop_unconfirmed` → `blocked`，单槽被占用、再派工 `CAPACITY_OCCUPIED`。这是 FIX02 的残留形态，按停止围栏**拒绝放行是对的**；放宽规则会推翻 WB04 四类样本判据，已回退该尝试。桥接缺口仍是原生 `turn_end` 事件。
4. **live 验收闭环终于跑通**（同一轮后续）：`live-accept-012` 的 131ms `OUTCOME_UNKNOWN` 真因是陈旧 `persistent-service.json` 指向旧数据目录；修成 `BRIDGE_DATABASE_MISMATCH` + `error.detail` 后，`live-accept-014`/`015` 两条任务各跑完 `check_task → run_review_command(exitCode 0) → check_task(passed) → record_inspection → review_task → accept_task`，均 `accepted`，产物 `TOTAL=7`/`TOTAL=19` 为真写盘、`execution.state=stopped`。

## 3. 本轮数字

| 项 | 值 |
| --- | --- |
| 后端套件 | **1590 tests / 1578 pass / 0 fail / 12 skip**（串行，CI 同款 `npx tsx` 命令，1435s，`suite-npx-tsx.log`；`node --import tsx` 口径 1470.8s，`suite-ci-serial.log`） |
| 工作台前端 | 169 / 169 |
| 桌面策略 | 133 pass / 0 fail / 1 skip |
| 验收矩阵 | 53 项齐全，`npm run acceptance:check` 通过 |
| 配对包 | 网关 2676495 B `a7aaf4f8…`；桌面 3105024 B `c39a4426…`；共用 **799** 文件逐字节相同、`problems:[]`、网关独有 0（`release-wb41c`） |
| 快照清单 | 468 文件，`verify-snapshot.mjs` `hashesMatch:true` |
| 改动规模 | 82 条路径（含 22 份 `docs/forward` 文档与 15 个新增源/测试文件） |
| 安装包自检 | 解包 → `bootstrap --apply` → `node scripts/check-acceptance-matrix.mjs` 在**安装树内** exit 0；`readiness --json` 前后 `tasks.sqlite` 均不存在 |

## 4. 明确没做的部分

1. **实窗面板**（WB35/WB34/WB14 的 window 层）：窗口能启动并给出分阶段文案，但本机会话拿不到 WebView2 控制器（`controller` 阶段固定 `COMException`，runtime 已装 157.0.4341.42），面板未渲染。
2. **`turn_end` 桥接**（WB35 的 live 层剩余部分）：`live-accept-010` 那次的原生最后一条工具调用没有终态 `tool_call_update`（应用库 `sessions.status=terminated`，`stillBusy:["unfinishedTools"]`）→ 产品判 `stop_unconfirmed` → `blocked`，这是**对的**。其余两条任务（`live-accept-014`/`015`）原生正常收敛到 `stopReason:"end_turn"` 并跑完 accept 闭环，说明闭环本身不再缺代码，缺的是异常收敛路径的原生事件。
3. **真实 DSH 端闭环**（WB35 的另一半）：本机 dsh 适配器 `adapter_disabled`，没有可用的 DSH 主机连接。
4. **改写运行安装**（WB08/WB38 剩余部分）：隔离根已跑通解包 → 依赖 → 建库 → doctor → 部署检查 → 技能落位，并完成**升级与回退演练**；没做的是把运行安装 `gateway-v0.7.1-final2` 的常驻服务切到候选。
5. **自动模式第二层**（WB26/WB29）：ADR-01 已写清边界，启用需用户明确给出逐任务规则（范围、窗口、预算、期限）。
6. **远端 CI 全绿**（WB42）：`b8d0c09` 起 `Release pairing` 已 12/12 步全绿（`43029275765`），`Forward gate` 的零作业失败已修（job 级 `env` 用了 `${{ runner.temp }}`），`e0b2a1a` 仍卡在第 10 步「Backend suite, serial」，但同一条串行命令在本机两口径全绿（1590/1578/0），已把失败行改成 `::error::` 注解，下一次运行直接给出测试名。`898ecba` 是当前候选提交。
7. **许可证选择与代码签名**（WB41）：权利人与证书都不在本机。
8. **第二台物理 Windows**（WB39）。
9. **真实资源来源联调**（WB16/WB19/WB20）：需要用户可访问的只读来源与上游金额/额度回报。

## 5. 下一步的最小动作

| 想让哪项从 blocked 变成有证据 | 需要什么 |
| --- | --- |
| WB34/WB35（window） | 一台能创建 WebView2 控制器的会话（本机 `controller` 阶段固定 `COMException`），并留窗口截图 |
| WB35（live 异常收敛） | 原生在回合结束时补发终态 `tool_call_update`，或按 [WB04](WB04_NATIVE_STOP_OWNERSHIP.md) 的 `turn_end` 事件契约提供 `wakeId`+`requestId`+`seq`；正常收敛路径的 accept 闭环已由 `live-accept-014`/`015` 证明 |
| WB38（剩余） | 明确是否允许把运行安装 `gateway-v0.7.1-final2` 的常驻服务切到候选（隔离根的升级/回退已演练） |
| WB39 | 第二台 Windows + 可用执行器账号 |
| WB42 | 拿到 GitHub API 配额（或装 `gh` 并登录）后读 `check-runs` 日志，定位两个 run 的零作业失败 |
| WB41 | 权利人选定许可证；准备签名证书 |
