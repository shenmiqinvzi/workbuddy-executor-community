# 53 项场景索引（本轮口径）

原矩阵见 `docs/delivery/FINAL_REVIEW_INDEX.md` §2（V01–V15、C01–C18、F01–F20）。本文件只记录**本轮**对每一项做了什么、最高取得哪一档、还差什么。

等级口径：`source` 代码与合成测试 / `machine` 本机命令输出 / `window` 真实窗口 / `live` 真实执行器与模型 / `installed` 真实安装 / `CI` / `release`。

**总读法**：53 项里本轮**没有任何一项**改判为整项通过。下表「本轮变化」写的是新增的源码与合成证据，不是验收通过。

## V01–V15

| 项 | 场景 | 本轮变化 | 等级 | 遗留 |
| --- | --- | --- | --- | --- |
| V01 | 正常修复与必需测试 | I 线补 `local_check_finished` 真实生产，检查状态→outcome 映射进账本 | source | 需真实派工一单走完 |
| V02 | 原生输入等待，详情可用/未知 | A01 就绪诊断把「原生在线」与「不可判定」分开 | source | 真实等待态未见 |
| V03 | 报告先到、原生仍忙 | B 线让「报告先到仍忙」成独立状态 | source | 真实窗口 |
| V04 | 已取消/停止不明/忙碌会话 | 原裁决保持，未重开 | source | 真实异常卡不补做 |
| V05 | 截止后恢复与迟到报告 | A03 保留期限与终态语义 | source | 真实迟到报告 |
| V06 | 同键重试/双进程 | 原幂等实现不动；B 线定型「拒绝 vs 不确定派工」 | source | 真实双进程 |
| V07 | 文件越界与旧修改 | 原保护规则不动（F-CONTRACT-1 保持 A） | source | 双端实机 |
| V08 | 检查后源码改变 | `EVIDENCE_STALE`/`STALE_ATTEMPT` 语义保留 | source | 真实 stale 触发 |
| V09 | 内容正确、形式不同 | 语义审查与 `checker_error` 分离保留 | source | 真实审查 |
| V10 | 三轮耗尽/模型缺失 | 不换模型约束保留 | source | 真实三轮 |
| V11 | 刷新、掉线、旧 revision | B03 面板恢复体验 + A01 诊断分层 | source | 真实浏览器 |
| V12 | 缺值/重复事件/人工请求 | I 线调用事件去重键写进契约（`review-call:*`、`tool-call:*`） | source | 真实事件流 |
| V13 | Windows 安装与版本切换 | A04 有界安装 + 隔离根 drill/upgrade-drill 全 exit 0 | machine | 真实安装当前候选 |
| V14 | Windows 路径/进程/服务差异 | A05 把 WMI 与 EPERM 偶发改成有界失败（失败不返回空表） | machine | 真实服务模式 |
| V15 | 第二台 Windows 实机 | 未做 | — | 需第二台机器（外部条件 A8） |

## C01–C18

| 项 | 场景 | 本轮变化 | 等级 | 遗留 |
| --- | --- | --- | --- | --- |
| C01 | direct/用户指定/自动模式 | D 线六层边界 + 只读 probe 接进 MCP 组合根 | source | 真实 arming |
| C02 | 方案预览/确认/并发消费 | I 线把重复回答映射 `INPUT_ALREADY_ANSWERED`；消费语义不变 | source | 真实确认窗口 |
| C03 | DSH 无会话/多会话/错目录 | A01 输出 `selection` 三态与候选，不选最新会话 | machine | 真实 DSH 会话 |
| C04 | 选择 DSH 模型与推理档 | 目录新鲜度统一 | source | 真实请求层证据 |
| C05 | 付费/费用未知/绑定漂移 | 缺报价不编造（`costText` 无值即无值） | source | 真实报价 |
| C06 | DSH 正常交付与返工 | 原 DSH 适配保留 | source | 真实派工 |
| C07 | 跨执行器双进程/容量 1 | 容量约束不变 | source | 真实双进程 |
| C08 | 账号池与 Key 路由 | C 线固定来源能力声明 | source | 真实网关账号池 |
| C09 | 估算/耗尽/未知 | `null` 不写 0 的字节与额度语义 | source | 真实额度 |
| C10 | 额度源失联/超时 | 陈旧标注与不回放旧结论（就绪路由同样） | source | 真实失联 |
| C11 | 刷新资源/后台采集/探测 | D 线正式只读 probe（`probeKind:"read_only_local"`） | source | 真实探测授权 |
| C12 | 多客户端并发与计量 | 归因账本覆盖率分子分母；DSH 派工确认接受后写请求观测（金额恒 `unavailable`） | source | 真实请求标识 |
| C13 | 硬费用限制 | `hardCap` 恒 unsupported，不冒充 | source | 需可控制来源 |
| C14 | 方案审计/政策撤回/模板 | B 线模板实例化 + I 线接线（时限只取存储政策） | source | 真实窗口 |
| C15 | 额度连接/面板/导出边界 | 导出真实 bytes 与 digest | source | 真实面板 |
| C16 | schema 与历史升级 | 配额文档升 `quota-2` 且兼容 `quota-1`（旧文档不伪造逐来源读数），契约见 `docs/RESOURCE_DOCUMENT_CONTRACT.md` | source | 真实旧库升级样本 |
| C17 | 换执行器意图与旧验收 | 首期拒绝语义不变 | source | — |
| C18 | 宿主兼容/统计/发布 | 统计页显示覆盖与未知 | source | 真实派工样本 |

## F01–F20

| 项 | 本轮变化 | 等级 | 遗留 |
| --- | --- | --- | --- |
| F01 冷启动 | 降级启动真实可跑（`workbench-entry` 不退出，health/readiness 200，tasks 503） | machine | 关闭真实服务后的冷启动仍需窗口 |
| F02 演示入口 | 未动 | source | 截图标注 |
| F03 真实面板 10 态 | B 线状态机补「报告先到仍忙」 | source | 真实面板 |
| F04 报告→等待→待审分层 | B03 指出阻断验收的证据 | source | 真实分层 |
| F05 分模式网络记录 | I 线只读路由无写入 | source | 分模式抓包 |
| F06 实窗渲染 | 未做 | — | 桌面壳 WebView 失败 |
| F07 文案呈现 | A02 超时文案不含 cancel/stop | source | 实窗 |
| F08 刷新/掉线恢复 | 未动 | source | 真实掉线 |
| F09 任务 A/B 乱序 | 未动 | source | 真实乱序 |
| F10 固定时钟实窗 | 未动 | source | 实窗 |
| F11 界面零与 null 区分 | 未动 | source | 界面复核 |
| F12 运行期双页合并 | 未动 | source | 双页 |
| F13 全界面降级 | 降级横幅只在 health/readiness 提供数据 | machine | 页面渲染 |
| F14 真实 DOM 夹具 | B 线五尺寸探针 `{"ok":true,"sizes":5,"failures":[]}` | source + synthetic | 真实 DOM |
| F15 最终包脱敏 | 打包守卫拦私有路径（本轮又命中一次并修正） | machine | 截图脱敏 |
| F16 界面分区展示 | 未动 | source | 实窗 |
| F17 四尺寸 + 等待审查页 | B 线 1440×900/1280×720/768×1024/390×844 探针通过 | source + synthetic | **无窗口** |
| F18 键盘主路径/200% | 未实测 | — | **无窗口** |
| F19 最终 SHA 的构建与包 | 最终候选 final5：744 受管文件 / 2,483,527 B / ZIP SHA-256 `da0f35d1…250eb426`、manifest `8150249b…`，`verify-release` 744/744 hashesMatch，安装前置自检 `ok:true`（totalBytes 8,125,788）；同 tree 重打包字节一致；隔离根 drill/upgrade/rollback/version-check 全 exit 0 | machine | 发行（未安装、未推送） |
| F20 交接材料 | 本文件 + `TOTAL_RECEIPT.md` + `RESUME.md` | source | 范围与许可 |
