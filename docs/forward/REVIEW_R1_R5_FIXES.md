# REVIEW.md 五项返修记录（R1–R5）

审查对象：`d866a09`。本文件按审查报告的关闭条件逐项记录改动、验证与残余。

## R1（P1）共享 DSH 路径绕过 CommandSpec 准入

**问题**：`workbuddy-executor/vnext-2` 合同带 `execution.executorId=dsh` 时，`TaskApplicationService.send` 路由到 `DshTaskCoordinator.send()`，而通用合同校验只检查 `definition` 是字符串，自由文本来到了 prompt 与模型选择之后。

**修法**：把命令检查的结构化准入做成共享函数，让两条派工路径用同一份规则。

- `gateway/src/command-spec.ts`
  - `admitCommandSpecs(definitions, { workspaceRoot, field, positions })` 新增 `positions`，允许调用方给出与真实数组下标一致的位置串。
  - 新增 `ContractCommandCheck { readonly kind: unknown; readonly definition: unknown }` 与 `admitContractCommandChecks(checks, workspaceRoot)`：只校验 `kind === "command"` 的项，位置串按**真实 `requiredChecks` 下标**生成（语义检查也占位），因此报错能指到 `contract.requiredChecks[1].cwd`。
- `gateway/src/dsh-coordinator.ts`：`sendAdmitted` 在 `collaboration.prepare(...)` 之后、`workspaceProtection.create(...)` 之前调用 `admitContractCommandChecks(contract.requiredChecks, admission.workspace.realPath)`，失败即 `fail(code, commandSpecAdmissionMessage(...))`。`prepare` 只读，所以位置仍早于 scope baseline、模型准备、prompt 与任务持久化。
- `gateway/src/coordinator.ts`：合同路径改用同一函数（`admitContractChecks`），WorkBuddy 与 DSH 不再各有一套。

**验证**：`gateway/test/dsh-adapter.test.ts` 新增三例，全部经 `TaskApplicationService.send` 进入（即审查的复现入口）：

| 用例 | 断言 |
| --- | --- |
| 自由文本检查 | `COMMAND_SPEC_REQUIRED`；`{prompts:0, selections:0}`；`store.get("dsh-prose") === undefined`；`workspace_scope_baselines` / `task_attempts` / `task_contracts` 计数均为 0 |
| 越界 `cwd`（语义项在前） | 消息含 `contract.requiredChecks[1].cwd` |
| 合法 CommandSpec | 仍 `created:true`，`{prompts:1, selections:1}`，`acceptanceCommands` 长度 1 |

台账证据：`outputs/codex-executor-plan-review-20261111/r1-dsh-adapter.log`（40 例通过）。`tsc --noEmit` exit 0。

## R2（P1）只读 readiness 通过子进程建库并迁移

**问题**：`probeToolStdio()` 启动完整 `dist/server.js`，`new TaskStore(config.dbFile)` 在 `callTool` 之前就建库/迁移；`WORKBUDDY_READINESS_PROBE=1` 没有只读分支。桌面 host 的 GET readiness 已接这个探针，所以一次只读诊断会写盘。

**修法**：把「应答健康」和「拥有任务库」拆开。

- 新增 `gateway/src/health-report.ts`：`healthReport({ config, client, sessionId })`，把 `server.ts` 的 health 主体搬出，并返回 `observer`（`pid`/`startedAt`/`codeHash`/`packageVersion`/`dataRoot`/`dbFile`）——身份是**应答进程**的，不是父进程猜的。
- 新增 `gateway/src/health-entry.ts`：只注册 `workbuddy_health` 一个工具的只读 MCP 入口，不 import `TaskStore`、不 import coordinator，启动不建库、不迁移、不回收 worker。
- `gateway/src/server.ts`：health 工具改调 `healthReport(...)`，删掉搬走后不再使用的 import。
- `gateway/src/readiness-probes.ts`：`probeToolStdio` 改为启动 `dist/health-entry.js`，解析 `observer` 得到 `identity`；`createReadinessProbes` 增加 `identity()` 与并发合并（页面轮询只拉起一次子进程）。
- `gateway/src/readiness.ts`：tool 层要求 `dist/server.js` 与 `dist/health-entry.js` 同时存在；子进程 `dataRoot` 与 observer 不一致时判 `blocked` + `missing:["tool_probe_data_root"]`。

**验证**：`gateway/test/readiness-readonly.test.ts`（7/7）覆盖：空目录真实 probe 后不出现 `tasks.sqlite`；非 SQLite 文件字节不变；两次 probe 各自 dataRoot/pid；`probeEnvironment` 七个键精确；异库 identity → blocked；并发只起一次子进程；CLI 组合根 `scripts/readiness.mjs --json` 在空目录不建库且 `toolResponsive` ready。

审查方的复现脚本 `readiness-write.mjs` 现在输出 `{"beforeDatabaseExists":false,"afterDatabaseExists":false,"files":[]}`。

## R3（P2）readiness 子进程丢调用方配置

**问题**：生产构造点都没传 `env`，`getDefaultEnvironment()` 不含 `WORKBUDDY_*`，子进程退回 `.env`/默认配置，可能检查另一个实例。

**修法**：`probeEnvironment({ config, env })` —— 以 `getDefaultEnvironment()` 打底，按 `config` 显式写 `WORKBUDDY_BACKEND` / `DB_FILE` / `RUNS_DIR` / `SERVICE_CONFIG` / `CONFIG_DIR` / `GATEWAY_URL` / `CLI_ELECTRON`，再设 `WORKBUDDY_READINESS_PROBE=1`；**`config` 最后写入**，即调用方选定的实例压过 shell 变量。三处生产构造点（`scripts/readiness.mjs`、`src/workbench-entry.ts`、`scripts/workbench-desktop-host.mjs`）都改为传 `config`。

**验证**：`outputs/codex-executor-plan-review-20261111/r3-probe-binding.mjs` 用带 `.env` 与回显 env 的 `dist/health-entry.js` 夹具跑三种场景——`selected`、`conflicted`（shell 与 `.env` 都写另一实例）都仍报 `dataRoot E:\selected-instance`；`unbound`（不传 config）报 `ENV_MISSING`，证明没有隐式继承。

## R4（P2）verify-pairing 只比交集

**问题**：桌面 ZIP 漏网关必需文件、或包无 manifest，`verify-pairing` 仍 `ok=true`、exit 0（零交集时 `shared.count=0`、`manifestAgreement.compared=0`）。

**修法**：`gateway/scripts/verify-pairing.mjs` 重写：

- `REQUIRED_SHARED`：11 项必须同时在两包里（`package.json`、`dist/server.js`、`dist/health-entry.js`、`dist/readiness.js`、`dist/readiness-probes.js`、`scripts/{readiness,init-state,verify-pairing,check-acceptance-matrix,sync-skill}.mjs`、`skills/workbuddy-executor/SKILL.md`）。
- 单边文件必须命中例外：`ALLOWED_DESKTOP_ONLY`（`desktop/app/*`、`PREVIEW-START-HERE.md`）、`ALLOWED_GATEWAY_ONLY`（空）。空集也不再通过。
- `verifyManifest(archive)`：manifest 必须存在；路径必须安全（拒绝空段、反斜杠、绝对路径、`.`/`..`、重复）；每条要与 ZIP 实际 bytes + sha256 一致；ZIP 里每个条目都要在 manifest 里。
- `versionCore()`：`0.7.1` 与 `0.7.1-t7d-desktop-preview` 视为同版本，`0.7.2` 不算。
- 返回值新增 `required` 与 `problems`，`ok` 只由 `problems.length === 0` 决定。

**验证**：`gateway/test/release-pairing.test.ts` 14/14，含审查要求的五类负例（删桌面 `dist/server.js`、删 manifest、改 manifest、零交集、版本不匹配）与 sidecar、重复路径、非法路径。

真实产物复核：`outputs/codex-executor-plan-review-20261111/r4-pairing-wb40.json` 对 `release-wb40` 双包给出 `ok:false`、`problems:["dist/health-entry.js is missing from both archives"]` —— 新规则生效，且 wb40 早于 health-entry 必然缺该项，下次打包会带上。

## R5（P2）安装包 acceptance:check 不能独立运行

**问题**：`check-acceptance-matrix.mjs` 假设自己在 `<repo>/gateway/scripts`，向上两级找仓库根；包里结构是 `<install>/scripts`，且打包不带 `docs/ACCEPTANCE.md` 等输入 → `ENOENT`。

**修法**（选审查的第一条路：让包内真的能跑）：

- `gateway/scripts/check-acceptance-matrix.mjs`：新增 `MATRIX_INPUTS` 与 `locateInputs(scriptFile)`，候选是「检出布局的上一级」与「安装根本身」，只有四份输入齐备才接受；缺输入时逐条打印 `- missing input: <abs>` 与 `input(s) are not in this tree` 并 exit 1，不再抛裸 `ENOENT`。
- `gateway/scripts/package.mjs`：新增 `MIRRORED_DOCS`（`docs/ACCEPTANCE.md`、`docs/FRONTEND_TASK_PANEL_DESIGN.md`、`docs/forward/ACCEPTANCE_MATRIX.md`、`docs/forward/SCENARIO_INDEX.md`）与 `collectMirroredDocs(sourceDir)`；`createPackage` 在采集网关文件之后从 `path.join(sourceDir, "..", relative)` 读入同一 stage 与 manifest。缺文件时明确报 `Missing mirrored document …`，不静默漏包。

**验证**：`gateway/test/acceptance-matrix.test.ts` 9/9 —— 新增「安装布局能找到输入并通过」「没有输入的安装副本逐条点名缺件」「发布镜像了 4 份输入且缺失时报错」。

**待补的最后一段**：从真实 ZIP 解包后运行 `node scripts/check-acceptance-matrix.mjs`（下一步的 release 复核会带上）。

## 与审查 §3.2 的台账整改

- 标签不再是唯一口径：`任务台账.json` 每张卡新增 `dimensions`（`implementation` / `automated` / `window` / `live` / `installed` / `external`），并填 `delivery_commit` 与 `delivery_commits`。
- `blocked_external` 逐张写明缺的那一件东西（`dimensions.external`），不再用一个宽标签概括。
- `WB43_TOTAL_ACCEPTANCE.md` 的六处不一致已改：`done` 计数（3 张）、502/429 归因（早前派工）与 010 的真实卡点（`turn_end`）、升级/回退已完成、push 已完成、`blocked_external` 定义收紧、`delivery_commit` 补齐。
