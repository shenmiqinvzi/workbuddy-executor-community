# GPT-6 Luna / WorkBuddy 小样本对照试验

本报告覆盖 2026-10-18 在同一 Windows 环境中完成的六组固定任务，共 12 个条件。每组比较 GPT-6 Luna 直接执行与 GPT-6 Luna 监督一个免费 WorkBuddy 执行。样本只有六个固定 fixture，结果是探索性 pilot，只描述这组任务和当前默认环境，不代表总体性能。

任务文本和输入 fixture 在执行前冻结；共享验收器在 S1 输出已回报后才正式冻结，之后的修订及原因记在 [协议修订记录](ledger/protocol-amendment.md)。最终验收器 SHA-256 为 `5c67459bf3e150f2c7c3b9d11e61bb25eede60356ca01dab13cddd5be67c09b0`。S1 的先行输出保留在样本中，不宣称盲测。

## 结果

| Pair | Direct | WorkBuddy 监督条件 | 严格时间可比 | 观察到的 coordinator 总耗时（Direct / WB） |
|---|---|---|---|---|
| S1 | 通过；旧结果无可靠时钟，首轮未知 | 通过；首次范围失败后清理额外 memory 文件 | 否 | NA / 381.043 秒（恢复运行，包含基础设施恢复和验收器修订） |
| S2 | 通过 | 通过；首次范围失败后清理额外 memory 文件 | 否 | 66 / 410.974 秒（调用端点口径不匹配） |
| F1 | 通过 | 取消；未交付可验收结果，内容/范围为 NA | 否 | 89 / 589 秒（包含 UI 排障、停止核对和被网关拒绝的继续请求） |
| F2 | 通过，4 个 worker 测试另加独立 contract 验证 | 通过；一次范围清理 | 是 | 76 / 457 秒 |
| R1 | 通过；31.854 秒仅为 child-reported start 到父级验收 | 超时/blocked；内容通过但范围失败，额外 memory 文件仍在 | 否 | 31.854 / 6801.249 秒（WB 含超时后的长暂停，不是 active time） |
| R2 | 通过 | 通过；第一次答案已符合原任务，因 checker 格式误拒而发生一次不必要的格式返工 | 是 | 68.643 / 430.4 秒 |

最终有 10/12 个条件通过；六个 Direct 条件全部通过。首轮按原任务语义和范围计，6 个通过、5 个未通过，S1 Direct 缺少历史遥测而为 NA。Direct 的首轮已知样本为 5/5；WorkBuddy 条件首轮为 1/6。F1 WorkBuddy 是取消失败，R1 WorkBuddy 在期限后仍为 blocked，均保留在分母中。

只有 F2 和 R2 的两组时钟都从协调者开始前记录到独立验收端点，足以作严格配对时间比较。它们的 Direct/WB 总耗时分别为 76/457 秒和 68.643/430.4 秒；WB 区间包含各自的一次返工。其余四组不作严格耗时比值，原因分别是旧时钟缺失、调用端点口径差异、取消及用户排障、旧 Direct 子代理自报 start 与 R1 WB 超时暂停。

这里的“严格时间可比”仅表示 F2/R2 两侧端点和计时口径完整一致，不证明纯模型能力的因果差异；尤其 R2 WB 时钟包含一次监督验收误拒后的格式反馈。

## 监督成本与人为参与

可观测的 WorkBuddy 代理指标为 82 次网关 CLI 调用，其中 78 次退出码为 0、4 次为非零或未完整返回（S1 有三次不完整/失败恢复调用，F1 有一次被拒绝的继续请求）。已保存的 CLI 输出文件共 221,520 字节，这是已知捕获量下限；S1 缺失响应的字节不可恢复。F1 的字节来自 PowerShell 合并 stdout/stderr，其余按 stdout 文件长度记录；这些数值不是 MCP wire bytes。Direct 组的工具调用量和返回字节不可观测，均为 NA。token 数、active reasoning 秒数、Codex 活跃监督时间和完整监督成本均未测量，因此本试验不支持“节省监督成本”或 token 的结论。

共记录两次用户介入 episode：F1 原生 UI 排障一次（截图显示 user cancelled，但实际操作者未知）；R1 请求确认单文件删除一次，用户授权时原任务期限已过，因此没有继续或接受该任务。父代理在 F1 对已取消任务尝试继续，网关拒绝；该次错误属于监督恢复失误，不归给 worker，并包含在 F1 的调用、失败和耗时记录中。

外部反馈共 5 轮：4 轮针对额外 memory 文件的范围清理（S1、S2、F2 完成，R1 在期限前未完成），另 1 轮是本试验验收器误拒导致的非必要格式反馈（R2）。这些轮次不应统称为 worker 的内容缺陷。

S1、S2、F2、R1 WorkBuddy workspace 曾出现 `.workbuddy-ai/memory/2026-10-18.md`。可过滤的原生 session 日志证明相关 `Write` tool 指向该路径；触发原因是否来自应用自动记忆行为仍未知。S1/S2/F2 的范围返工只处理各自文件；R1 任务因期限到期保留 scope failure。没有更改 WorkBuddy 设置或全局权限。

R2 初次 WorkBuddy 文档有三个 H2 gap 区块，完全满足冻结任务要求的三项独立、可执行缺口及范围，但冻结 checker 额外要求恰好三个 Markdown list bullets，导致自动检查 false-negative。格式返工提示已发出后才确认这个 checker 缺陷；因此记录一次外部格式返工，但不把 checker 失败算作 worker 的首轮失败。初次 native `Write` payload 和哈希已单独保存；它是工具 payload 哈希，不是当时文件系统字节哈希。Direct 和 WorkBuddy 均依原任务内容手工验收，checker 本身和任务文本未按 R2 输出再修改。

## 复核与限制

逐 run 结果见 `ledger/*.result.json`，机器汇总为 [results.csv](results.csv) 与 [results.json](results.json)。汇总脚本 `node tools/summarize-results.mjs` 会核对 19 个冻结输入哈希、验收器哈希、已记录的调用数、CLI 字节数、start/end 算术及配对严格可比标记。父代理独立复核确认 11 个有计时的条件端点与总时长最大差异 0.001 秒，所有冻结输入哈希匹配；10 个通过的 workspace 文件范围正确。每个 run 的交付件和冻结副本列于 [artifact hash index](ledger/artifact-sha256.json)。

Direct 条件请求 GPT-6 Luna，并继承默认推理配置；每轮实际推理配置未独立暴露或核实。Fixture 构造、协议/验收器修正、父代理独立复核、报告合成的成本不计入 run 时钟；可测的完整额外成本没有保留。原始 CLI stdout/stderr、原生应用日志及本地 memory 证据保留在本机但不进入 Git；Git 中保存每个 run 的可审查任务产物、哈希索引、结构化结果和汇总。没有 push。
