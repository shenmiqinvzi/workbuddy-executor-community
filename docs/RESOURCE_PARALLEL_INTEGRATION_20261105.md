# A/B 独立验收与本地集成（2026-11-05）

后续更新：本文记录的 `bd4cdf8` 候选全量失败已由 [DSH 注册发现一致性修复](DSH_REGISTRY_DISCOVERY_FIX.md) 关闭；新候选正式全量 1013 项 / 1000 pass / 0 fail / 13 skipped。下文原始失败与包哈希保留，不能改挂为新版本的运行结果。

范围：A 的关联歧义/积分区域修复，B 的资源故障隔离测试，以及 C 的交付准备首版。集成人未追加 A/B 之外的运行代码修复；生产安装、配置、账号、任务库与原 P0-1 的裁决未动。

## 纳入版本与归属

| 线 | 提交与范围 | 本次验收 |
|---|---|---|
| A / DSH | 集成分支已有 `eab7937`；与 DSH 工作树 `995d4ef` 文件树相同 | 关联原测试 16 + 冲突 19 + loader 6，独立运行 41/41；歧义不取任一来源、cn/intl 积分不混用 |
| B / Codex | `3ad105f`、`9b79ba1`、`c10b896`、`f17c417`；仅新增测试与独立验收文档 | 独立运行 3/3；真实 TaskStore/service/HTTP，WorkBuddy 假原生队列与 DSH 假传输；没有真实模型调用 |
| 本地合并 | `0c58f40`，将 `feat/resource-fault-isolation` 合入 `integration/resource-center` | 无文件冲突；B 没有改 A 的模块，没有修改生产代码 |
| C / 集成人 | [交付准备首版](D0_D1_DELIVERY_READINESS.md) | 技能版本核对、MCP 运行指纹、安装差异、53 项矩阵及 D1 前置条件；D0/D1 没有全部完成 |

已查看 A 的 WebView2 歧义与积分区域不符截图：未任意显示候选读数、正确 token 保留，原确认入口仍可见。A 的浏览器 27/27、WebView2 20/20 是其候选包证据；本轮没有冒充重新执行整套界面验收。

## 统一检查

证据目录：`outputs/resource-parallel-integration-20261105/`。正式构建与测试使用隔离的假可执行文件/配置目录，不连接生产执行器。

| 检查 | 实际结果 |
|---|---|
| `npm run build` | exit 0，`build.log` |
| `npm run typecheck:task-view` | exit 0，`typecheck.log` |
| A 专项 | 41/41，仓库 TypeScript loader 入口 |
| B 专项 | 3/3，仓库 TypeScript loader 入口 |
| `node --test workbench/test/*.test.mjs` | 100/100，exit 0，`workbench.log` |
| 快照生成/验证 | 327 文件，hashesMatch=true，manifestCompleteness=checked；只新增 B 测试项，保留历史 provenance |
| 受限上下文 `npm test` | exit 1；tsx 在 uv_os_get_passwd / ENOMEM 阶段退出，未进入用例，`full-suite.log` |
| 受限上下文 loader 全量 | exit 1；1000 项 / 984 通过 / 3 失败 / 1 取消 / 12 跳过，`full-suite-loader.log` |
| 定向诊断 | 工作区自有 TEMP、concurrency=1，13 项 / 10 通过 / 2 失败 / 1 跳过；DSH 传输和 detached worker 通过，CIM 权限拒绝和 tsx 子进程 MCP 连接关闭仍失败，`targeted-followup.log`；不与上次合并成全绿 |
| 正常上下文正式 `npm test` | exit 1；1000 项 / 986 通过 / 1 失败 / 0 取消 / 13 跳过，330.9 秒，`full-suite-normal.log`。额外跳过是当前卷不提供 Windows 短文件名；不能把跳过数差异当通过 |

受限 loader 全量的失败分别是 command-cleanup 的 CIM 查询、deepseek-server 的 MCP 子进程连接、run-worker 的 TEMP 文件 rename EPERM；dsh-transport 为 60 秒测试取消。定向复验确认其中两项仍失败，不以“未改这些文件”作为无关证明。没有为测试调整产品语义、删除断言或降低全量并发。

正常上下文下前三类均通过，剩余 `test/dsh-transport.test.ts:9`：`DeepSeekClient.rpc()` 先由 `resolveHostId()` 枚举一次，再由 `hosts().find(...)!` 枚举一次，第二次没有对应宿主时访问 `host.socketPath` 抛裸 `TypeError`。通过一个只在第一次返回合成宿主、第二次返回空数组的客户端夹具稳定复现，未发网络请求，见 `dsh-registry-race.json`。这证明缺少对枚举结果变化的处理；本轮全量中第二次宿主被过滤的具体原因仍待定位，不能直接归为机器负载或 A/B 无关。

下一修复应限定为 DSH 注册发现的一致性/错误处理及 Windows 私有路径检查失败的可诊断性：保留 ACL、安全连接与身份约束，不重试 prompt、不静默换 host，不将尚未发送和可能已发送混淆。本轮没有现场修改该模块后用单文件通过替代全量。**A/B 专项验收通过，集成候选全量未通过；正式交付门槛仍未满足。**

## 候选包

- 路径：`outputs/resource-parallel-integration-20261105/package/codex-workbuddy-gateway-v0.7.1.zip`。
- SHA-256：`001b242ea6b6de230bb0a9d3d2095561ff14592cfc9dcbaf0f4db74fd03c3480`。
- 569 个业务文件，逐文件与本地集成树比较无差异；解包后官方 `verify-release.mjs` 返回 verifiedFiles=569、hashesMatch=true。
- 相对 A 候选 `81357907…`，仅新增 `test/resource-fault-isolation.test.ts`，无修改/删除条目；运行文件完全一致。因此可以沿用 A 对应包的界面证据，不宣称新包做了新一轮实窗验证。
- 旧包未覆盖；新包是本地验收候选，不是已发布版本。文件一致不豁免测试或真实验收门槛。

## 后续边界

A 两项缺陷和 B 合成故障隔离专项通过。B 的真实来源/执行器交叉，以及未覆盖组合见 [B 记录](RESOURCE_FAULT_ISOLATION_ACCEPTANCE.md)。D3-01 真实账号池、D3-02 实际任务路由、D0/D1 及 D7 交付门槛仍保留。

安装核对发现：当前技能 6 文件一致，但现有网关安装缺资源新模块、attention.mjs 与候选不同，不能把源码修复当成已部署。当前 MCP 原生连接 offline。下一步应先完成 D0 差异表和可回退候选安装准备，再按实际选择/授权安排 D1；不继续重复已经完成的资源页面开发。

本轮仅本地集成。未推送、未合 main、未部署、未发布。README.md 与 ROADMAP.md 的既有修改保留且不纳入本轮提交。
