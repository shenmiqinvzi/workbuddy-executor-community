# 总回执 — forward 20261107 轮

> 交给复核方（Codex）的入口文件。字段按计划包 `10_验收标准与总回执.md` 的要求排列。
> 本文件不把「源码完成」「真实可用」「正式发行」混为一谈：下面每一行都标明证据档位。

## 1. 当前入口

| 项 | 值 |
|---|---|
| 集成树 | `E:\javaproject\workbuddy-forward-20261107\I-integration` |
| 分支 | `integration/forward-delivery` |
| 起点 | `134cdc7febbf858e89fb1010cf6b9d72da5edbe7`（`workbuddy-finish\R-review-fixes`，分支 `fix/delivery-review-r1-r4`） |
| 本轮最新提交 | 见 §3 表末行 |
| 证据根 | `E:\javaproject\outputs\forward-delivery-20261107\`（`A/ B/ C/ D/ I/ shared/`） |
| 续接入口 | `docs/forward/I_CHECKPOINT_2.md`、证据根 `RESUME.md` |
| 计划包 | `E:\javaproject\workbuddy-development-plan-20261107\`（10 个 md） |

## 2. 交付状态（按档位，不合并表述）

| 档位 | 状态 | 说明 |
|---|---|---|
| 源码（source） | 已推进 | 四线全部合入集成树；31 项中 28 项有本轮代码与测试 |
| 合成（synthetic） | 已推进 | 后端全量、工作台、桌面策略三套测试见 §4 |
| 本机（machine） | 局部 | 降级启动真跑、就绪诊断真跑、候选包生成与自检真跑 |
| 窗口（window） | **无** | 桌面壳 WebView 初始化失败，页面渲染/四尺寸/200%/读屏全部未实测 |
| 真实（live） | **无** | 本轮无真实派工、无真实模型调用 |
| 安装（installed） | **无** | 只有隔离安装根自举与候选自检 |
| 发行（release） | **无** | 未推送、未合 main、未加许可宣示 |

结论口径：**M1-D（开发就绪）达成；M1-L（实际可用）未达成；M2-D 部分达成；M2-L 未达成；R 未开始。**

## 3. 合并与提交（集成树）

| 来源 | 提交 | 内容 |
|---|---|---|
| A-runtime | `11d96a5` `0f0a263` `c1b9f8d` `161097e` `27f92fd` `ecedc5c` `3a33d0a` | 启动阶段拆分、五层就绪诊断、两块生命周期空白、有界安装、两个偶发有界化、文档 |
| B-product | 9 提交（`19ef402` `bd6f3c1` `4e63b7a` `e26fe7a` `2cdb97b` `da5c43d` `58813cc` `4e22c2e` `bd9d632`） | 派工三结局、面板恢复、模板期限裁剪、导出比对、五尺寸探针、文档 |
| C-data | 6 提交（`b6edd38` `25787e8` `e49c5ea` `9e00fee` `7af4515` 等） | 来源能力声明、路由歧义、harness 调用事实、统计契约、quota-2 升版与 DSH sync 生产接线 |
| D-automation | 8 提交（`6267e05` `8e35607` `07f7b79` `d50ae78` `70b1803` `ee1cfcc` `a162469` 等） | 六层披露、只读 probe、操作只读路由、幂等派工、socket 修复、文档 |
| I 集成 | `caa7a5fa` `15e23ae` `387a6f6` `02e7de8` `6774476` `804ce30` `1e0597c` `4b04bfa` `65c1d7a` `9898edb` `f47fb4b` + 3 个 merge | local_check 生产端、歧义文案、就绪只读路由、降级启动、产品面接线、打包白名单、MCP 入口隔离、交付入口前移、清理误入日志、四次合并 |

## 4. 验证（真实输出，命令与日志）

| 门 | 命令 | 结果 | 日志 |
|---|---|---|---|
| 全量后端 | `$env:WORKBUDDY_CONFIG_DIR='C:\Users\LENOVO\.workbuddy-ai'; npx tsx --test test/**/*.test.ts` | **1439 tests / 1427 pass / 0 fail / 12 skipped**（exit 0） | `I\full-suite-final.log` |
| 工作台 | `npm run test:workbench` | 164 tests / 164 pass / 0 fail | 终端 |
| 桌面策略 | `npm run desktop:test` | 122 pass / 0 fail | `A\desktop-policy-tests.log` |
| 类型 | `npx tsc --noEmit -p tsconfig.json`、`npm run typecheck:task-view` | 均 exit 0 | 终端 |
| 构建 | `npm run build` | exit 0 | 终端 |

### 4.1 全量后端套件的两个已知非回归噪声

1. **配置目录歧义**：不设 `WORKBUDDY_CONFIG_DIR` 时本机同时存在 `%USERPROFILE%\.workbuddy-ai` 与 `%USERPROFILE%\.workbuddy`，`loadConfig()` 按设计抛错，180 条用例构造即失败（起点树同样失败，已证非本轮回归）。本文件所有全量数字都在固定 `WORKBUDDY_CONFIG_DIR` 下取得。
2. **`dist` 陈旧**：`scripts/workbench-read-store.mjs:7` 从 `../dist/quota-observation.js` 读，源码改了不重建 `dist` 会让桌面只读路径读出版本漂移（本轮确实出现过，`npm run build` 后消失）。因此「改了 `src` 就要 build 再跑该文件」。

## 5. 候选包（本机生成，非发行）

| 项 | 值 |
|---|---|
| 路径 | `I-integration\gateway\outputs\candidate-final\codex-workbuddy-gateway-v0.7.1.zip` |
| 字节 | 2,479,137 |
| 条目数 | 745（`candidate-installation` 计 744 个受管文件，`verify-release` 校验 744） |
| ZIP SHA-256 | `b3a8a86ab8350fec0a3918a6cc5110aecfec0421c4df8bf6874b977775f38e8d` |
| manifest | 120,216 B / SHA-256 `d84b629de0d2238046d2e6e16002880ab5d26ce42abd659f2926e1fe0ebc3688` |
| `verify-release.mjs` | `{"version":"0.7.1","verifiedFiles":744,"hashesMatch":true}` → `I\candidate-final-verify.txt` |
| `candidate-installation.mjs check` | `ok:true`、`problems:[]`、`totalBytes 8110205` → `I\candidate-final-check.json` |
| 桌面成品 | 未生成（`npm run desktop:package` 需要 WebView2 构建产物与本机桌面环境；`desktop:test` 122 pass 只证明策略层） |

> 上一轮中间包 `outputs\candidate-cp2`（734 文件 / `61dc0456…`）只保留作对照，**不是**本轮候选。

## 6. 本轮新增能力（每条都在 §4 有测试）

1. **`local_check_finished` 真实生产**：`TaskReviews.publishCallFact` 在 `checks()`/`runCommand()` 里写真实检查事实，去重键 `review-call:*`，字节取自真实输出文件，未测不写 0。契约 `docs/CALL_EVENT_CONTRACT.md`。
2. **五层就绪诊断 + 就绪只读路由**：`src/readiness.ts`、`scripts/readiness.mjs`、`GET /workbench/v1/readiness`（拒绝查询参数 400、观测失败 503、不回落磁盘版本）。
3. **配置无法解析时降级启动**：`workbench-entry` 分 `serveFull`/`serveDegraded` 两路，进程不退出，`health.ready=false` + `degraded.code=CONFIG_UNRESOLVED`，其余端点 503 `SURFACE_DEGRADED`。
4. **歧义拒绝说人话**：`ambiguityMessage()` 列出候选并点名两个环境变量，声明不代选、不回退。
5. **产品面接线**：模板实例化（时限只取存储政策）、通知失败原因透传、重复回答 `INPUT_ALREADY_ANSWERED`、MCP 进程只读 probe（经 `src/read-only-probe.ts` 门面，自动化模块不进 MCP 入口）。
6. **C 线两项**：quota 文档升 `workbuddy-executor/quota-2` 并兼容 quota-1（旧文档不伪造逐来源读数）；`tool_call_finished` 从真实 DSH `sync()` 事件流生产。

## 7. 未满足项（逐条给阻塞原因）

| # | 项 | 阻塞原因 | 需要的外部条件 |
|---|---|---|---|
| 1 | 真实派工（双执行器、非空检查/审查/接受/关闭） | 每个真实任务需逐任务确认执行器/模型/推理档/费用 | A1/A4/A5 |
| 2 | 桌面窗口实测（渲染、四尺寸、200%、读屏） | 本机 WebView 初始化失败，无普通桌面会话 | A9 + 桌面环境 |
| 3 | 真实安装与升级/卸载 | 候选包自检通过，但安装会改变本机环境 | A2 |
| 4 | 异机复现 | 无第二台 Windows 与独立操作者 | A8 |
| 5 | 自动模式 arming 与 `hardCap` | 自动执行需显式授权；来源不支持硬上限时保持 unsupported | A7 |
| 6 | 许可、CI、发行 | 未获授权 | A9/A10 |
| 7 | 53 项矩阵改判 | 一条都没改判，见 `SCENARIO_INDEX.md` | 1–6 完成后自然推进 |

## 8. 已执行的外部动作

- 建立 5 个工作树与 5 个证据目录（本地文件操作）。
- `gateway/node_modules` 用目录联接指向起点树，避免四次重复安装。
- 生成候选包并解压校验（本地文件操作，未安装）。
- **未** 调用任何真实模型、**未** 派工、**未** 安装、**未** 改 MCP/生产配置、**未** 推送。

## 9. 复核入口

```powershell
cd E:\javaproject\workbuddy-forward-20261107\I-integration
git log --oneline -8
cd gateway
npx tsc --noEmit -p tsconfig.json
$env:WORKBUDDY_CONFIG_DIR='C:\Users\LENOVO\.workbuddy-ai'
npx tsx --test test/check-call-events.test.ts test/config-ambiguity.test.ts test/readiness.test.ts test/workbench-readiness-route.test.ts
npx tsx --test test/desktop-readonly-resources.test.ts test/workbench-http.test.ts
npm run test:workbench
npm run desktop:test
node scripts/readiness.mjs        # 未设 config：exit 1 + 候选清单，不写配置
```

只看结论的读者：先读本文件 §2，再读 `docs/forward/SCENARIO_INDEX.md` 的「总读法」，其余按需展开。
