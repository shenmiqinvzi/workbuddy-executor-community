# L05 集成请求：推荐解释的接线点

本线（L05）新增 `gateway/src/recommendation.ts`（纯函数评估器）、`gateway/test/recommendation.test.ts`、`gateway/workbench/test/recommendation-view.test.mjs`，并改动本线拥有的两个视图文件 `gateway/workbench/dispatch.mjs`、`gateway/workbench/dispatch.css`（推荐面板、候选回填、确认前漂移门）。根技能六文件与其发布副本已同步。

需要集成人接线的是**桌面动作 `recommend`**：网页只能通过私有父/子通道请求它，因此必须同时改 `scripts/workbench-desktop-commands.mjs`（动作分派）与 `desktop/DesktopControlPolicy.cs`（动作白名单），否则视图会一直走“宿主不支持 → 面板隐藏”的降级路径。这两处属共享入口，本线**未在本树修改**；下面的 patch 可直接采纳。

不需要新接线：评估器不新增 HTTP 路由（视图复用既有 `/workbench/v1/statistics` 与 `/workbench/v1/resources/plan-reference`），不改 `workbench-assets.ts`、`workbench-http.ts`、`workbench-entry.ts`、DB schema、包白名单里的视图文件清单；`dispatch.mjs`/`dispatch.css` 本就在 `scripts/package.mjs:15` 的 `WORKBENCH_FILES` 里。

---

## 1. `gateway/scripts/workbench-desktop-commands.mjs`：分派 `recommend`

**原因**：现在任何未知动作都落到末尾 `throw Error('Unsupported desktop command.')`，页面据此隐藏面板。动作必须和 `catalog` 一样读同一份能力快照，才能保证解释里的 `catalogId`/`expiresAt` 与页面刚看到的目录一致（漂移比较才有意义）。

**patch**（两处，共 6 行）：

```js
// 顶部，第 1 行 import 之后
import {recommendTask} from '../dist/recommendation.js';

// 在 `if (method === 'catalog') ...` 这一行之后插入
if (method === 'recommend') {
    if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) throw Error('Object parameters are required.');
    // 时钟显式传入：评估器自身不读时钟，同一输入与同一快照得到同一 digest。
    return recommendTask(parameters, session.catalog(), Date.now());
}
```

`session.catalog()` 是 `DesktopDispatchSession` 的既有方法（最多缓存 4 份、`expiresAt = now + 300_000`），不会准备模型、不创建会话、不派工；`recommendTask` 只读它给的 `models/sources/policy/dispatchEnabled/errors` 与本请求里的 `intent/constraints/statistics/resources/previous`。

**验证**（本树已可跑的等价路径）：`gateway/test/recommendation.test.ts` 18 个用例直接调用同一函数；接线后用 `node gateway/scripts/workbench-desktop-host.mjs` 起宿主，页面点“评估选择”应出现解释面板而不是隐藏。

## 2. `gateway/desktop/DesktopControlPolicy.cs`：放开并界定 `recommend`

**原因**：`Decode` 的动作白名单（第 24 行）不含 `recommend`，网页请求会在到达子进程前被拒（`Unsupported desktop action.`）。请求体已受 `MaximumBodyBytes = 65536` 限制，这里只需要把形状界定到评估器接受的键。

**patch**（两处）：

```csharp
// 第 24 行的白名单字符串末尾加一个动作
if (action is not ("catalog" or "preview" or "dispatch" or "status" or "observe" or "choose_workspace" or "latest" or "control_preview" or "control" or "control_status" or "control_list" or "control_observe" or "control_requirements" or "recovery_show" or "attention_verify" or "declare_native_stop" or "recommend")) throw new ArgumentException("Unsupported desktop action.");

// 第 27 行（零参数动作检查）之后插入
if (action == "recommend")
{
    if (parameters.EnumerateObject().Any(p => p.Name is not ("intent" or "constraints" or "statistics" or "resources" or "previous")))
        throw new ArgumentException("Unexpected recommendation parameters.");
    if (parameters.TryGetProperty("intent", out var intent) && intent.ValueKind != JsonValueKind.Object)
        throw new ArgumentException("A recommendation intent object is required.");
    if (parameters.TryGetProperty("resources", out var resources) && resources.ValueKind != JsonValueKind.Array)
        throw new ArgumentException("Resource references must be an array.");
    if (parameters.TryGetProperty("previous", out var previous) && previous.ValueKind != JsonValueKind.Object)
        throw new ArgumentException("A previous explanation object is required.");
}
```

不在 C# 里复制字段级校验：`intent`/`constraints` 的键、长度与取值由 `recommendTask` 的严格白名单判定（未知键 → `INVALID_REQUEST`），重复实现只会产生两套口径。C# 只保证“形状与体积可控”。

**验证**（建议随接线提交的 PolicyTests 用例）：

```csharp
// Decode 接受 recommend 的四个可选段，拒绝多余键与错误类型
var ok = DesktopControlPolicy.Decode("{\"action\":\"recommend\",\"parameters\":{\"intent\":{\"objective\":\"x\"}}}");
Assert.Equal("recommend", ok.Action);
Assert.Throws<ArgumentException>(() => DesktopControlPolicy.Decode("{\"action\":\"recommend\",\"parameters\":{\"score\":1}}"));
Assert.Throws<ArgumentException>(() => DesktopControlPolicy.Decode("{\"action\":\"recommend\",\"parameters\":{\"resources\":{}}}"));
```

## 3. 参数与返回契约

请求（页面 → 宿主）：

| 键 | 类型 | 说明 |
|---|---|---|
| `intent` | object | `title`(≤200)、`objective`(≤8000)、`allowedChanges`/`permittedMetadata`/`checks`(≤200 项×400 字符)、`maxAttempts`(1–100)、`timeoutSeconds`(1–86400)、`sessionId`(≤200) |
| `constraints` | object? | `selection`（用户显式选择，五项执行标识）、`freeOnly`(bool)、`hardCostCap`({credits≤40}) |
| `statistics` | object? | `/workbench/v1/statistics` 的响应，按 `schemaVersion` 校验后只读 `window/coverage` |
| `resources` | array? | 若干份 `plan-resource-reference-1` 文档；只采纳 `execution` 与某候选完全相等的那份 |
| `previous` | object? | `{digest, catalogId, policyVersion, selection}`，用于漂移比较 |

返回：`workbuddy-executor/recommendation-1`（见 `docs/delivery/L05_RULES.md` 的示例）。错误一律以 `{code, message}` 形式抛出：`INVALID_REQUEST`（键/类型/长度不合法）、`CATALOG_UNREADABLE`（目录不可读）。语义上恒有 `readOnly:true`、`authorization.state:"none"`、`attempt:null`、`routingVerified:false`，且不产生任何模型调用或数据库写入。

上限：候选 20、排除 40、缺失 12，单条文本 400 字符；因此响应远小于 `installDesktopCommands` 的 1 MB 回包上限。若把每个候选都取资源引用再回传，建议像视图默认那样只取前 5 个（每份文档 < 64 KB 请求体预算）。

## 4. 可选：`scripts/package.mjs` 的必需文件清单

`dist/recommendation.js` 会随 `dist/**/*.js` 规则被打包，故不是阻塞项。若希望打包缺文件时在验证期就失败，可在第 33 行的 desktop 组后追加：

```js
REQUIRED_FILES.push(...["recommendation"].flatMap(name => [`src/${name}.ts`, `dist/${name}.js`, `dist/${name}.d.ts`]));
```

## 5. 状态

- 本线已应用：评估器、单元测试、视图面板、确认前漂移门、视图测试、技能六文件同步、`docs/delivery/L05_RULES.md`。
- 待集成人接线：第 1、2 节（阻塞“产品可达”）；第 4 节可选。
- 未做且不属于本线：真实模型确认与实际派工（归 10）、把解释写进总进度或其他线的视图。
- 预存问题（非本线引入、未修改）：`scripts/workbench-desktop-host.mjs:38` 有一行注释在基线里已是乱码（`寰呭鐞嗘牳瀵硅蛋...`），只影响可读性；本线未触碰该文件。
