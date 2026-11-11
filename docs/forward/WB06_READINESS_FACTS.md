# WB06 五层就绪：统一契约、入口接线与运行事实对照

本文件是 WB06 的交付物之一。它说明「就绪」这件事的证据从哪来：谁观察、观察了什么、数据根是哪一个、什么时候观察的，以及哪些入口只能报 `unknown` 而不是假装 ready。

## 1. 契约

`gateway/src/readiness.ts` 的 `observeReadiness()` 返回 `workbuddy-readiness/v1` 报告，含五层：

| 层 | 问题 | 谁能让它 ready |
| --- | --- | --- |
| `toolResponsive` | 工具本身能否应答 | 只有**当前进程**注入的 tool probe 得到应答 |
| `nativeOnline` | 原生桥是否连上 | 当前进程的 native probe（或 tool probe 回报的 bridge 状态） |
| `projectSessionDispatchable` | 项目会话能否派工 | 选择读回 + 项目会话登记 + 派工开关 |
| `candidateDeployed` | 运行的是不是这份构建 | 运行摘要的 `codeHash` 与 `dataRoot` 同时匹配 |
| `desktopPageReady` | 桌面壳里的页面是否就绪 | 窗口观察到的页面加载结果 |

状态取值：`ready | blocked | unknown | absent | unverified`。`blocked` 表示查到了明确的拒绝原因；`unknown` 表示没观察；`absent` 表示组件不存在；`unverified` 表示有记录但不足以作证。只有 `ready` 算就绪。

报告新增必填字段 `observer`：

```json
{
  "origin": "scripts/readiness.mjs",
  "pid": 38284,
  "platform": "win32",
  "node": "24.19.0",
  "root": "E:\\javaproject\\workbuddy-forward-20261107\\R-executor-plan-20261111\\gateway\\",
  "dataRoot": "E:\\...\\gateway\\data",
  "probes": { "tool": "injected", "native": "injected" }
}
```

没有注入 probe 时 `probes` 为 `not_observed`，并在 `notes` 里明写「tool: <origin> 没有注入 tool probe……不能当作“工具已就绪”」。这样一份从 CLI 里看到的 `unknown` 不会被误读成「工具坏了」，也不会被误读成「工具好了」。

## 2. 运行摘要的绑定与新鲜度

常驻服务心跳（`service-cli.ts` 的 `serviceLoop`）现在写：

```json
{ "pid": 1234, "runtime": { ... }, "dataRoot": "<...\\gateway\\data>", "startedAt": "<ISO>", "updatedAt": "<ISO>" }
```

`candidateDeployed` 层的判定顺序（`readiness.ts`）：

1. 摘要的 `dataRoot` 与本次观察的 `dataRoot` 不同 → `blocked`，理由「the runtime summary belongs to another data directory; it cannot prove this install is running」；
2. 没有摘要 → `unknown`；摘要没有 `codeHash` → `unknown`；
3. 有 `codeHash` 但没有 `dataRoot`（旧版服务写的） → `unverified`，`missing` 含 `runtime_data_root`，理由「the runtime summary predates dataRoot/startedAt binding; restart the service once to write them」；
4. 没有 `dist` → `unknown`；
5. 其余按 `codeHash` 匹配/不匹配给 `ready`/`blocked`。

即：**旧摘要、别的库、旧版服务写的摘要都不能证明这份安装正在运行。**

## 3. 入口 × 探针 × 证据来源

| 入口 | tool probe | native probe | 证据来源 | 数据根 |
| --- | --- | --- | --- | --- |
| `scripts/readiness.mjs` | 注入：短命 MCP 客户端调 `workbuddy_health` | 同一回答里的 `online` | 该 CLI 进程（报告里写 pid） | 解析出的配置 `dirname(dbFile)` |
| `scripts/readiness.mjs --no-probe` | 不注入 | 不注入 | 只有磁盘事实 | 同上，`probes: not_observed` |
| `src/workbench-entry.ts`（full） | 注入（模块级 `createReadinessProbes({ moduleUrl: import.meta.url })`） | 同上 | 入口进程 | 同上 |
| `src/workbench-entry.ts`（degraded） | 不注入（配置解析失败时工具进程也起不来） | 不注入 | 只有错误原因 | `null` |
| `scripts/workbench-desktop-host.mjs` | 注入（`dist/readiness-probes.js`） | 同上 | 桌面宿主进程 | 同上 |
| MCP server（`dist/server.js`） | 它是被观察方 | 用它自己的 bridge 状态回答 | — | — |

`test/desktop-host-wiring.test.ts` 断言桌面宿主确实构造并传入了 `createReadinessProbes`；`gateway/test/readiness-probe-live.test.ts` 用真实进程跑通「probe 到 `dist/server.js` 拿回 `workbuddy_health`」这一跳（构建缺失时跳过，不伪造通过）。

## 4. 本工作树的实测（2026-11-11）

命令与结果（完整 JSON 见 `outputs/executor-plan-20261111/wb06-readiness-cli.json`）：

```text
node scripts/readiness.mjs --json     # exit 1（有层未就绪时非零退出）
toolResponsive            ready     workbuddy_health answered from this process (backend desktop-queue, online false, ready false)
nativeOnline              blocked   bridge online=false as reported by the tool process (pid 38284)
projectSessionDispatchable unknown  dispatching needs a usable desktop app
candidateDeployed         unknown   no runtime summary was ever written
desktopPageReady          absent    no desktop window is running for this install
nextAction: nativeOnline — 打开 WorkBuddy 桌面应用并完成首次连接
```

要点：tool 层 ready 的证据是「本进程真的起了一个 MCP 进程并拿到回答」（`facts.observedByPid=38284`），不是磁盘上有个 `dist`；native 层 blocked 的理由来自同一回答，而不是猜测。

同安装的已部署目录（只读核对，未改动）：`E:\javaproject\workbuddy-install\gateway-v0.7.1-final2\data\` 只有 `tasks.sqlite`，**没有** `persistent-service-status.json`。因此对该安装，`candidateDeployed` 只能是 `unknown`（无摘要），`persistentService.installed=false` 与 FIX03 的描述一致。

## 5. 反例（都在测试里）

- `a runtime summary from another data directory cannot prove this install is running`：异库 `dataRoot` → `blocked`，`missing` 含 `runtime_summary` 之外的 `foreignDataRoot` 语义。
- `a summary written before the binding fields stays readable but cannot be ready`：旧摘要 → `unverified` + `runtime_data_root`。
- `a tool probe from this process is what makes toolResponsive ready`：无 probe 时 `missing` 含 `tool_probe`，状态不是 ready。
- `the report names the process that observed it and which probes ran`：`observer` 四要素 + 两条 not_observed note。
- `a probe that fails blocks the layer with its reason instead of reporting unknown`：probe 抛错 → `blocked` + `the tool probe failed`。

## 6. 未覆盖与外部条件

- 真实安装上的「常驻服务已装（`persistent-service.installed=true`）」与「MCP 与同安装桌面交叉核对」需要安装/切换运行，属实机验收（WB35），本工作树只提供源码级事实与只读对照，不宣称已就绪。
- 桌面页面层需要真实窗口，`observeDesktopWindow` 的实窗观察属 WB35/WB39。
