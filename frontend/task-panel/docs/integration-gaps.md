# 与真实接口的联调缺口

本文件记录：本期 mock 用了哪些"目标契约里还没有"的字段，以及后续接真实接口时必须补齐的能力。
结论先行：**本期不是联调，也没有读取任何真实接口。**

## 1. 目标 TaskView 已定义、当前实现入口可能拿不到的字段

| 字段 | 目标契约 | 现状 |
|---|---|---|
| `revision` | 持久、不可猜测，随事实变化 | stage-2 已有；基础 `statusView` 没有 |
| `checks[]` | 含 `actor / inputHashes / checkerVersion` | 基础 `statusView` 没有；本期 mock 按契约构造 |
| `changes[]` | 含 `category`（交付物 / 元数据 / 未授权） | 尚未实现范围检查（T5） |
| `artifacts[]` | 含 `bytes / sha256`，未知为 null | 尚未实现 |
| `metrics` | 含 `usage` 与 `limitations` | 尚未实现（T7 计量） |
| `timing.lastObservedAt` | 最后观测时间，不等于刷新时间 | stage-2 有保存时间；语义需核对 |

## 2. 本期用"补充 mock"临时代替的字段

以下字段不在目标 TaskView 里，本期放在 `MockPresentationSupplement`（`src/presentation/supplement.ts`），文件头标注"非正式 wire 字段"：

- `objective`：任务目标正文
- `progressSummary`：最近进展
- `reportSummary`：报告正文
- `allowedChangePaths`：允许修改范围
- `changesStatus` / `artifactsStatus`：变更 / 产物是否已观测

> 后续要显示这些内容，必须先做契约变更（单独的 PR），**不能**为了填满页面向 TaskView 加字段，再要求后端照着实现。

## 3. 接真实接口前必须补齐的能力

1. **分页与错误语义**：列表游标、`EVIDENCE_STALE`、逐项读取失败、`unavailable` 降级；不能按完整 TaskView 硬解码 stage-2 响应。
2. **允许动作**：`allowedActions` 目前只展示；写操作需要服务端重新核验与 `expectedRevision`。
3. **会话导航**：`capabilities.nativeSessionNavigation` 验证为 true 之前，不生成 deep link。
4. **模型与额度**：见下节。
5. **刷新频率**：浏览器只读本地快照，不能每 2 秒调用模型或原生桌面接口。

## 4. 模型与额度（后续独立交付）

- 目标 TaskView 没有模型字段；模型绑定来自 vnext-2 草案（T3a）。
- 本期页面不展示模型，也不做选择器。
- 2026-10-26 核对：main 已合并 PR #10–#17（T1–T6），`AGENTS.md` 与契约 §8 已明确新默认政策 `selectionMode=user_choice, requireFree=false, allowed=[]`：
  - 新任务**不预选模型**，先展示来源 / 精确模型 / 推理档位与已知费用，再由用户选择并确认；
  - 付费或费用未知模型可以选，但必须明示费用与局限，不得包装成免费或硬上限；
  - 主动免费限定、白名单与历史任务原政策继续生效；活动任务内执行器与模型固定；
  - 模型证据分级为 declared / selected / request_observed / unavailable，缺证据时阻塞而不是补值。
- 早期 10-25 设计稿（PR #11 版本）写的是"保留已批准免费模型"，已被合并后的 #13 取代。后续模型页按 **main 现行规则**实现，不要照旧稿写默认值。
- 额度单位区分 token / 积分 / 货币；未知保持 null，不与任务成本相加。

## 5. 接入时的风险清单

- 真实接口可能返回 `unknown` 与矛盾证据：保持现有降级文案，不要"修好"数据。
- 事件分页要按 `eventId` 游标，不要按时间戳猜。
- 真实 `lastObservedAt` 可能比刷新时间旧：两个字段分开显示，本期已经这样实现。
- 停止证据缺失时 `remoteStopped=false`：不要渲染成"仍在运行"。
- 真实报告可能有 HTML：继续纯文本渲染。
