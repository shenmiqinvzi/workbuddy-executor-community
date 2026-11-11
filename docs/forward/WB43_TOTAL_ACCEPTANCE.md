# WB43 · 成品总验收（本轮交付档案）

本文件是这一轮的**总账**：哪些卡做完了、证据在哪、哪些没做完以及为什么。它不新增结论，只把分散在 [验收矩阵](ACCEPTANCE_MATRIX.md) 与各任务文档里的状态汇总成一张可核对的表。

## 1. 口径

- `done_source`：源码、测试、文档齐备，证据是**本机 source 维度**（测试日志、校验报告）。不等于实机验收。
- `done`：`done_source` 之外还有原生/窗口/安装层证据。（本轮没有新增 `done`。）
- `blocked_external`：缺的是外部条件（真实模型派工、安装目标、第二台机、CI 回执、发行授权），**不是代码没写**。
- 证据维度：`source` / `synthetic` / `window` / `live` / `installed` / `ci` / `second_machine` / `release`。本轮产出 `source`（含合成夹具）与 `installed`（隔离安装演练），`window` 与 `live` 取得部分证据（真实窗口与分阶段文案、7 次真实派工与失败路径；面板未渲染、accept 闭环未走到）。

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
| 矩阵与实机 | WB34 / WB35 | blocked_external / blocked_external（live 部分已取） | 矩阵 53/53 有行有据；WB35 已取到真实窗口、分阶段失败、7 次真实派工与三类失败路径（见 [WB35_LIVE](WB35_LIVE_NATIVE_RUN.md)），面板渲染与完整 accept 闭环仍缺 |
| 冻结与配对 | WB36 / WB37 | done_source | `suite-wb38.log` 1563/1551/0/12；`wb38-pairing.json` ok、782 共用 |
| 安装与第二台机 | WB38 / WB39 | blocked_external | 本机隔离根已完成解包/依赖/建库/doctor/部署检查/技能落位（installed 证据）；升级回退与切换运行安装、第二台 Windows 仍缺 |
| 文档与许可 | WB40 / WB41 | done_source / blocked_external | README 唯一入口 + 手册；依赖披露完成，许可证与签名属权利人 |
| CI 与发行 | WB42 / WB43 | blocked_external | workflow 就绪、本地复演完成；远端回执与发行授权缺 |

## 3. 本轮数字

| 项 | 值 |
| --- | --- |
| 后端套件 | 1563 tests / 1551 pass / **0 fail** / 12 skip（`suite-wb38.log`，408.7s） |
| 工作台前端 | 169 / 169 |
| 桌面策略 | 133 pass / 0 fail / 1 skip |
| 验收矩阵 | 53 项齐全，`npm run acceptance:check` 通过 |
| 配对包 | 网关 2604199 B `f160410a…`；桌面 3031998 B `a9fd2342…`；共用 782 文件逐字节相同（`release-wb38`） |
| 快照清单 | 464 文件，`verify-snapshot.mjs` exit 0 |
| 改动规模 | 77 条路径（含 21 份 `docs/forward` 文档与 12 个新增源/测试文件） |

## 4. 明确没做的部分

1. **实窗面板与完整 live 闭环**（WB35/WB39/WB14/WB34 的 window/live 层）：窗口已能启动并给出分阶段文案，但本机会话拿不到 WebView2 控制器，面板未渲染；真实派工已跑 7 次（模型 `glm-5.3-flash` 由用户选定），拿到真实产物、scope 拦截、单槽容量、取消与 429/502/无报告三条失败路径，但**没有一次走到 `accept_task`**——卡在本机系统代理 `127.0.0.1:7890` 的 502 与 provider 429；放宽网络后即可复跑。
2. **安装后切换运行**（WB08/WB38）：隔离根已跑通解包 → 依赖 → 建库 → doctor → 部署检查 → 技能落位；缺的是升级/回退/卸载演练与改写运行安装 `gateway-v0.7.1-final2` 的切换授权。
3. **自动模式第二层**（WB26/WB29）：ADR-01 已写清边界，启用需用户明确调整逐任务规则。
4. **远端 CI 回执**（WB42）：需 push 与一次成功运行。
5. **许可证选择与代码签名**（WB41）：权利人与证书都不在本机。
6. **真实资源来源联调**（WB16/WB19/WB20）：需要用户可访问的只读来源。

## 5. 下一步的最小动作

| 想让哪项从 blocked 变成有证据 | 需要什么 |
| --- | --- |
| WB34/WB35 | 一台能创建 WebView2 控制器的会话（本机 `controller` 阶段固定 `COMException`）+ 一次完整主路径（选择 → 预览 → 派工 → 停止 → 返工 → 审查 → 验收）并留窗口截图与原生事件 |
| WB38 | 明确是否允许改写运行安装 `gateway-v0.7.1-final2` 并切换常驻服务（技能与隔离根已就绪） |
| WB39 | 第二台 Windows + 可用执行器账号 |
| WB42 | 推送分支并触发 `forward-gate` / `release-pairing` |
| WB41 | 权利人选定许可证；准备签名证书 |
