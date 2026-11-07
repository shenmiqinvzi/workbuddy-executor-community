# forward 20261107 轮文档索引

本目录是本轮（"接手完整开发"）的**唯一新增文档区**。历史 RC6 记录仍在 `docs/delivery/`，不重写、不改判。

## 计划与本轮的对应

| 计划包文件 | 本轮落在哪 |
|---|---|
| `01_DSH总提示词.md` / `02_总计划…` / `03_共同约定…` | 分线树 A/B/C/D + 集成树 I（见证据根 `RESUME.md`） |
| `04_A运行链路与安装.md` | `A_LINE_RECEIPT.md` |
| `05_B产品主流程与工作台.md` | `B_LINE_RECEIPT.md` |
| `06_C资源与真实计量.md` | `C_LINE_RECEIPT.md` + `CALL_EVENT_CONTRACT.md` |
| `07_D自动政策与恢复.md` | `D_LINE_RECEIPT.md` |
| `08_I集成验收与交付.md` | `INTEGRATION_RUNBOOK.md`、`INTEGRATION_LOG.md`、`ACCEPTANCE_53_FORWARD.md`、`TASK_LEDGER_31_FORWARD.md` |
| `10_验收标准与总回执.md` | `FORWARD_RECEIPT.md`（总回执） |

## 证据等级（每份回执必须自报）

| 等级 | 含义 | 允许的说法 |
|---|---|---|
| `source` | 源码/测试/脚本改动，可静态复核 | "已实现"、"有测试覆盖" |
| `synthetic` | 夹具真跑（真文件/真 SQLite/真有界命令），但执行器适配器是合成的 | "合成通过" |
| `window` | 真实窗口/浏览器/桌面壳观察 | "窗口实测" |
| `live` | 真实模型与真实原生会话派工 | "真实跑过一次" |
| `machine` | 异机/安装根实测 | "安装可用" |
| `CI` | 远端 workflow 实际执行 | "CI 通过" |
| `release` | 正式发行 | 本轮不宣称 |

**禁止**：把 `source` 说成"可用"；把 `synthetic` 说成"真实"；把"能打包"说成"已发行"；把未测的 UI 说成"已适配"。

## 跨线协议

1. 共享文件（`task-store.ts`、`task-application-service.ts`、`server.ts`、`workbench-entry.ts`、`workbench-http.ts`、`workbench/app.mjs`、`workbench/index.html`、`package*.json`、公共 schema、`SKILL.md`、打包白名单）**只有 I 线改**。
2. 需要改共享文件 → 写 `INTEGRATION_REQUEST_<X>.md`，I 线在集成时实现并在 `INTEGRATION_LOG.md` 记一条。
3. 冻结接口：`task-metrics.ts` 的分组/字节语义、`docs/INTERFACE_CONTRACT.md` 的既有字段。扩字段要有契约文件先行。
4. 每线只跑自己的专项测试 + `npx tsc --noEmit -p tsconfig.json`；全量套件由 I 线在检查点跑。
