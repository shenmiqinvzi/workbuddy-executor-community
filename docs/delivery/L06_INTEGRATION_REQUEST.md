# L06 集成请求：模板、通知与导出预览的接线点

本线（L06）新增六个源码模块 `gateway/src/{project-template,notification-center,delivery-export,productivity-service,productivity-runtime,desktop-productivity}.ts`、两个页面文件 `gateway/workbench/productivity.{mjs,css}`、一个桌面侧文件 `gateway/desktop/DesktopProductivityConfirmation.cs` 与七组测试。`TaskStore`、`TaskApplicationService`、统一 schema、任务库表结构的归属不变，本线没有改它们，也没有新增表或迁移。

**第 1–6 节已在本树应用**（改动 9 个既有文件，均为机械注册与只读接线；集成人可原样采纳或按本节 patch 重构）。第 7 节是**尚未交付**的 07 对齐契约，本线只留了保存与拒绝两侧的边界，没有政策引擎，因此不能宣称自动政策模板可用。第 8 节是可复验命令。

已在本树验证（日志与计数见 `outputs/finish-l06-20261105/HANDOFF.json`）：`npm run build`（exit 0）、`npm run typecheck:task-view`（exit 0）、七个 L06 测试文件 54 pass / 0 fail、`workbench-http`+`workbench-assets` 共享入口 16 pass、`npm run test:workbench` 117 pass、`npm run desktop:test` 87 pass、回环只读冒烟（模板/通知/导出预览三组状态码，库文件 SHA-256 前后一致）。

---

## 1. `gateway/src/workbench-http.ts`：加三条只读路由（已应用）

**原因**：`/workbench/v1/templates*`、`/workbench/v1/notifications`、`/workbench/v1/export-preview/*` 不在分发里会落到 404；非 GET 也需要 405 + `allow` 头。这个适配器没有请求体解析，因此写操作**不能**做成 POST 路由——模板保存、通知开关、导出写盘都走第 5 节的桌面命令。

**patch**：

```ts
// 顶部 import
import { handleProductivityRequest } from "./productivity-service.js";
import type { ProductivitySources } from "./productivity-service.js";

// WorkbenchAdapterOptions 末尾加一个可选字段
/**
 * Read-only productivity surface: saved template catalog/detail, the
 * notification snapshot and the delivery-export preview. Absent means the
 * routes do not exist; their write counterparts are desktop commands only.
 */
productivity?: ProductivitySources;

// 非 GET 的已知路径判定链
|| pathname === "/workbench/v1/templates"
|| pathname.startsWith("/workbench/v1/templates/")
|| pathname === "/workbench/v1/notifications"
|| pathname.startsWith("/workbench/v1/export-preview/")

// GET 分发，放在 statistics 之后、panel/tasks 之前
if (this.options.productivity) {
  const productivity = handleProductivityRequest(this.options.productivity, pathname, url.search);
  if (productivity) { this.send(response, productivity.status, productivity.body); return; }
}
```

`handleProductivityRequest` 对其它路径返回 `null`，不会截走已有路由；状态码映射：400 给 `invalid_*` / `invalid_query`，404 给 `template_not_found` / `task_not_found`，409 给 `export_too_large` / `export_not_whitelisted`。错误体与现有适配器同形（`{error:{code,message,retryable:false,…},view:null}`，码为大写）。

**验证**：

```text
GET  /workbench/v1/templates                       -> 200，activation.supported=false
GET  /workbench/v1/templates/tmpl-00000000         -> 404，TEMPLATE_NOT_FOUND
GET  /workbench/v1/templates/..%2F..%2Fetc         -> 400，INVALID_TEMPLATE_ID
GET  /workbench/v1/templates?includeArchived=yes   -> 400，INVALID_QUERY
GET  /workbench/v1/notifications                   -> 200，两次请求体相同（不消耗 episode）
GET  /workbench/v1/export-preview/task-smoke-1     -> 200，digest 64 hex，不含 objective 正文
POST 上述三条路由                                   -> 405，响应带 allow: GET, HEAD
不传 productivity 选项                              -> 404（旧调用方行为不变）
```

## 2. `gateway/src/workbench-assets.ts` + `gateway/scripts/package.mjs`（已应用）

**原因**：资产服务是精确白名单，未登记的 URL 直接 404；发布包一致性守卫会比对 `WORKBENCH_FILES`，只改一处会红。

**patch**：

```ts
// workbench-assets.ts 的 assets 对象
"/workbench/productivity.mjs": ["productivity.mjs", "text/javascript; charset=utf-8"],
"/workbench/productivity.css": ["productivity.css", "text/css; charset=utf-8"],

// scripts/package.mjs 的 WORKBENCH_FILES 数组追加
"productivity.mjs", "productivity.css",
```

**验证**：`curl -sI .../workbench/productivity.mjs` → 200 且 `content-type: text/javascript; charset=utf-8`；`.css` 同理；CSP 与其它页面一致（`default-src 'none'; script-src 'self'; …; frame-ancestors 'none'; form-action 'none'`）；`npm run test:workbench` 的资产用例通过（此前缺 package.mjs 条目会报 `does not ship workbench/productivity.css`）。

## 3. `gateway/workbench/index.html` + `app.mjs`：模板与交付视图（已应用）

**原因**：页面模块已导出 `mountProductivity({ root, fetchJson })`，但外壳没有导航、没有挂载点、也没有视图分支，用户点不到。

**patch（index.html）**：只加样式表（脚本由 `app.mjs` import，不加内联脚本）：

```html
<link rel="stylesheet" href="/workbench/productivity.css">
```

**patch（app.mjs）**，共 4 处，均为并列新增，不动 resources/statistics 分支：

```js
import { mountProductivity } from './productivity.mjs';

let productivityView = null;
function navProductivity() {
  return h('button', { class: 'nav-button', type: 'button', id: 'nav-productivity', 'data-view': 'productivity',
    onclick: () => setView(state.view === 'productivity' ? 'tasks' : 'productivity') },
    icon('mark'), '模板与交付', h('span', { class: 'nav-hint' }, '只读预览'));
}

// buildShell()：统计 nav 之后并列一组，主区 statistics-root 之后加挂载点
h('div', {}, h('div', { class: 'nav-heading' }, '模板与交付'), h('nav', { class: 'nav' }, navProductivity())),
h('div', { class: 'resources-mount', id: 'productivity-root', hidden: true }),

// setView()：归一化加一支；hidden 切换加一支；末尾 else-if 分支
const next = view === 'resources' ? 'resources' : view === 'statistics' ? 'statistics'
  : view === 'productivity' ? 'productivity' : 'tasks';
const productivityHost = $('productivity-root');
if (productivityHost) productivityHost.hidden = next !== 'productivity';
else if (next === 'productivity') {
  /* 关派工面板、resourcesView?.setVisible(false)、懒 mountProductivity({root, fetchJson: statisticsFetch})、
     改 intro 文案与 #page-title，productivityView?.reload() */
}
```

页面模块自身只发 GET、只写 `textContent`（测试里有静态断言），`reload()` 由外壳在切回该视图时调用。

**验证**：浏览器打开 `/workbench/`，侧栏出现「模板与交付」，点击后三块（项目模板 / 桌面通知 / 脱敏导出）都渲染为可读列表；`Escape`/再次点击回到任务列表；键盘 Tab 能到「显示已归档」「版本历史」「预览」；断网或 4xx 时显示错误态而不是空白。

## 4. `gateway/src/workbench-entry.ts`：注入只读来源（已应用）

**原因**：端点本身不做 I/O 决策，拿到的 `ProductivitySources` 才是唯一入口；在这个只读入口注入可以保证 GET 不投递通知、不写模板、不碰任务库。

**patch**：

```ts
import { exportStatisticsFrom, openProductivityRuntime } from "./productivity-runtime.js";

const productivity = openProductivityRuntime({
  configDir: config.workbuddyConfigDir,
  store,
  statistics: exportStatisticsFrom(statistics),
});

const server = new WorkbenchHttpServer({ service, statistics, productivity: productivity.sources, health: /* 现有 */ });
```

模板与通知账本落在 `config.workbuddyConfigDir`（`project-templates.json`、`notification-config.json`、`notification-ledger.json`），不落任务库；该入口不传 `deliver`，所以即便有人轮询也不会弹通知。

**验证**：启动 `node dist/workbench-entry.js`，`GET /workbench/v1/notifications` 的 `config` 与磁盘文件一致；请求前后 `tasks.sqlite` 的 SHA-256 不变、`-wal` 0 字节；配置目录只多出上述三个 JSON，且均为 0600。

## 5. `gateway/scripts/workbench-desktop-commands.mjs` + `workbench-desktop-host.mjs`：桌面命令与通知轮询（已应用）

**原因**：模板保存、归档、通知配置、导出写盘都需要一个“父进程已确认”的通道；HTTP 适配器按设计没有写入口，桌面命令通道是现成的结构化入口（严格字段校验、单行 ≤70000 字节、错误走 `AdmissionError`）。

**patch（commands.mjs）**：给两个函数末尾各加一个可选参数，并在最终 `throw` 之前插入分派：

```js
export function desktopCommandHandler(session, controls = null, recovery = null, attention = null,
                                      declarations = null, productivity = null) { /* … */ }
export function installDesktopCommands(session, input = process.stdin, output = process.stdout, controls = null,
                                      recovery = null, attention = null, declarations = null, productivity = null) { /* … */ }

if (productivity) {
  const outcome = await productivity.run(method, parameters);
  if (outcome.handled) {
    if (outcome.failure) throw Object.assign(new Error(outcome.failure.message), { name: 'AdmissionError', code: outcome.failure.code });
    return outcome.value;
  }
}
```

**patch（host.mjs）**：

```js
const productivity = openProductivityRuntime({
  configDir: config.workbuddyConfigDir,
  store,
  deliver: notification => process.stdout.write(JSON.stringify({ event: 'desktop_notification', notification }) + '\n'),
  statistics: exportStatisticsFrom(statisticsSources(store)),
});
const server = new WorkbenchHttpServer({ service, health, statistics: statisticsSources(store), productivity: productivity.sources });
const productivityCommands = Object.freeze({ run: (method, parameters) => Promise.resolve(runProductivityCommand(productivity.commands, method, parameters)) });
installDesktopCommands(/* …既有 7 参… */, productivityCommands);
// 通知按 15s 轮询，失败下一拍重试；账本才是投递记录
void pollNotifications();
const notificationTimer = setInterval(() => { void pollNotifications(); }, 15_000);
notificationTimer.unref?.();
// close 里 clearInterval(notificationTimer)
```

首行 ready 帧增加 `productivity: true`。该宿主新增的写路径只有两类：配置目录内的三个 JSON，以及用户在选择框里挑定的导出目录；任务库仍只由 `declare_native_stop` 写入。

**验证**：`node --check scripts/workbench-desktop-host.mjs` exit 0；桌面壳内保存模板后 `project-templates.json` 出现且 `GET /workbench/v1/templates` 计数 +1；关闭通知开关后 `notification-config.json` 记录 `enabled:false`，重启宿主不再弹横幅；模板/导出命令在页面直接 POST 时仍 405。

## 6. 桌面壳：`DesktopControlPolicy.cs`、`Program.cs`、`DesktopProductivityConfirmation.cs`（已应用）

**原因**：`DesktopControlPolicy` 是动作与参数的白名单，新动作不登记就会被 `Decode` 拒绝；`Program.cs` 是唯一能弹原生确认与通知的地方；导出目录必须来自 `FolderBrowserDialog`，不能由页面给字符串。

**patch（DesktopControlPolicy.cs）**：动作白名单追加 8 项，并逐动作校验字段：

```text
productivity_catalog          仅允许布尔 includeArchived
productivity_template_detail  仅允许 templateId（^tmpl-[A-Za-z0-9-]{8,64}$）
productivity_template_save    允许 template(object) + 可选 templateId
productivity_template_archive 仅允许 templateId
productivity_notifications    无参数
productivity_notification_config 仅允许 config(object)
productivity_export_preview   仅允许 taskId
productivity_export_save      允许 taskId + 64 hex digest + 可选 directory
```

新增私有 helper `IsTemplateId`、`IsIdentity`（1..200 字符、无控制字符），注释写明「Identities are matched, never turned into paths」。

**patch（Program.cs）**：

- `HandleDesktopResourceAsync` 增两支：`productivity_export_save` 无 `directory` 时先开 `FolderBrowserDialog{Description="选择导出保存文件夹"}`（取消抛 `CONFIRMATION_CANCELLED`），再 `DesktopProductivityConfirmation.ShowExportSave`，最后 `commands.CallAsync("productivity_export_save", {taskId,digest,directory})`；`productivity_template_save` 先确认再 `commands.CallAsync`。确认互斥沿用 `CONFIRMATION_BUSY`。
- `StartAsync` 起 `ReadHostEventsAsync(ownHost)` 读宿主 stdout，只处理 `event=="desktop_notification"`（行长 0 或 >70000、`JsonException` 一律丢弃）；`ShowNotification` 按 `notificationId` 去重，用 `NotifyIcon.ShowBalloonTip(8000)`，reason 文案「等待你提供信息 / 已停止，等待验收 / 执行失败 / 已超过约定时限」，并注明通知不批准、不重试、不延时、不写任务状态；`FormClosing` 释放托盘图标。
- `DesktopProductivityConfirmation.Show(...)` 无默认 AcceptButton、必须勾选确认框；导出确认显示文件夹、任务编号、预览指纹，并说明只含白名单字段、不写半份文件、不覆盖同名；模板确认显示名称/类型/说明/检查数/范围数/时限/尝试上限，政策建议模板额外注明「只保存建议，不激活」。

**验证**：`npm run desktop:test` → 87 pass / 0 fail（新增 17 条断言）；`dotnet build desktop\WorkBuddy.Workbench.csproj -c Release` 0 warning 0 error；手工路径：点「保存模板」→ 勾选后确认 → 列表出现新版本；取消对话框 → 不落盘、无半份文件；同一通知在同一窗口只弹一次，重开宿主后账本已投递的 episode 不再弹。

## 7. 07 对齐契约（**未交付**，需 07 提供）

本线只能保证“建议被保存、且不会被误当成已生效”，不能保证“政策能运行”。具体边界：

| 项 | 本线行为 | 07 需要提供的 |
| --- | --- | --- |
| 模板类型 | `kind:"policy-suggestion"` 可保存，内含 `policySuggestion{maxAttempts,timeoutSeconds,note}` | 政策求值/激活入口；在此之前 `activation` 恒为 `"unsupported"` |
| 实例化 | 政策模板一律以 `policy_activation_unsupported` 拒绝；`requires:["plan_create","user_confirmation"]` | 若允许实例化，必须同时给出真实授权与预算来源 |
| 预算 | `budget{requested,policy,applied,clamped}`，`applied=min(模板, maxAttempts)`，超限在 `notes` 说明 | 新的预算权威（谁批准、上限从哪来），不得用模板里的数字冒充授权 |
| 选择建议 | `selectionSuggestion{executorId,providerId,modelId,reasoningEffort}` 仅作展示，不预选 | 若要让建议变默选，需模型选择与价格披露流程一并交付 |
| 未知枚举 | 未知 `kind` / `executorId` / check `kind` 返回 `unknown_enum` 且带 `allowed` | 新枚举加入时同步更新 `KINDS`/`EXECUTORS`，不要放宽为“原样接受” |
| 到期/截止 | 通知的 `deadline` 由契约 `timeoutSeconds + createdAt` 派生，锚点 `{kind:'derived',eventId:null,revision}` | 若 07 引入真实截止事件，应改为事件锚点，并保留旧派生锚点的去重键 |

**验证（07 接入后必须重跑）**：政策模板保存后 `GET /workbench/v1/templates` 仍显示 `activation.supported=false`；实例化返回 `policy_activation_unsupported`；把 `activation` 改成任何其它值保存返回 `invalid_value`；旧账本里的 `derived` 锚点在新事件锚点出现后不重复投递。

## 8. 复验命令

```powershell
# 工作树
cd E:\javaproject\workbuddy-finish\L06-productivity\gateway
git rev-parse HEAD

# 构建与类型
npm run build
npm run typecheck:task-view

# L06 专项（7 个文件）
node .\node_modules\tsx\dist\cli.mjs --test test\project-template.test.ts test\notification-center.test.ts test\delivery-export.test.ts test\productivity-service.test.ts test\productivity-page.test.ts test\productivity-http.test.ts test\desktop-productivity.test.ts

# 共享入口与页面
node .\node_modules\tsx\dist\cli.mjs --test test\workbench-http.test.ts test\workbench-assets.test.ts
npm run test:workbench
npm run desktop:test

# 只读冒烟（合成库，端口自定义）
$env:WORKBUDDY_WORKBENCH_PORT = "18532"
node dist\workbench-entry.js
```

集成人若只采纳第 1–4 节而暂不接桌面命令，模板/通知/导出预览会保持只读：页面能看到已存模板与待办，但保存按钮只会在受控桌面壳里出现结果；这属于预期降级，不是坏数据。
