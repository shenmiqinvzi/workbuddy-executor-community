# 集成检查点 2 — 四线合入、接线与候选包

时间：2026-11-07。树：`E:\javaproject\workbuddy-forward-20261107\I-integration`，分支 `integration/forward-delivery`。

## 1. 合入顺序与结果

| 步骤 | 来源 | 结果 |
| --- | --- | --- |
| 1 | A-runtime（7 提交，`11d96a5`…`3a33d0a`） | `15467b9` 无冲突 |
| 2 | B-product（9 提交，HEAD `bd9d632`） | `b6f3f61` 无冲突 |
| 3 | C-data（前 4 提交） | 无冲突；`e49c5ea` 待合 |
| 4 | D-automation（8 提交，`a162469`） | 无冲突 |

合并后 I 侧自有提交 9 个（`caa7a5fa`、`15e23ae`、`387a6f6`、`b56f91b`、`02e7de8`、`6774476`、`804ce30`、`1e0597c` 及后续文档提交）。

## 2. 门禁（真实数字，均在本树实跑）

- `npx tsc --noEmit -p tsconfig.json`：干净。
- `npm run build`：成功。
- `npm run desktop:test`：`{"passed":122,"failed":0}`（基线 92，A02 新增 30）。
- `npm run test:workbench`：B 合入后 **163 tests / 163 pass / 0 fail**（基线 139）。
- 专项：`test/readiness.test.ts` 27/27、`test/workbench-readiness-route.test.ts` 5/5、`test/config-ambiguity.test.ts` 4/4、`test/check-call-events.test.ts` 5/5、`test/desktop-command-template.test.ts` 5/5、`test/desktop-dispatch.test.ts test/project-template.test.ts test/delivery-export.test.ts test/notification-center.test.ts` 50/50、`test/productivity-service.test.ts` 5/5、`test/productivity-http.test.ts` 5/5。
- 全量（固定 `WORKBUDDY_CONFIG_DIR=C:\Users\LENOVO\.workbuddy-ai`）：见 `I\full-suite-cp2.log` 与总回执；本轮全部记录保留，不重跑掩盖。

## 3. 合入时发现的真问题

1. **配额文档契约漂移**（C）：`src/quota-observation.ts:5` 仍 `quota-1`，但 `observations` 已加 `readings[]`；消费端 `workbench/resources-model.mjs` 封闭校验 → `UNKNOWN_SCHEMA`。失败用例 `test/desktop-readonly-resources.test.ts` → `resource frontend reads real cached backend documents and isolates store failures`。已要求 C 升 `quota-2` 并兼容 `quota-1`，本轮按「未修复即如实记录」处理。
2. **`recordHarnessToolCalls` 无调用者**（C）：只在 `statistics-harness-calls.ts` 与测试内出现，`src` 内 0 调用。`tool_call_finished` 的真实生产仍未接线；已要求接在 `src/dsh-coordinator.ts` 的 `sync()` 末端。
3. **打包守卫命中私有路径**（C 的测试）：`test/statistics-call-events.test.ts:78` 的 `C:\Users\alice\…` 被 `scripts/package.mjs` 的 `assertSafeContent` 拒绝。I 侧改为 `C:\Users\example\…`（守卫白名单内），并已通知 C。
4. **导出计数夹具过期**（B 的测试）：`delivery-export` 现在统计「实际读取的事件条数」，`test/productivity-service.test.ts` 的 `exportStore` 只给游标 `nextEventId:3` 却期待 `counts.events===3`。已把夹具改成三条真实事件（断言不变，语义更严）。

## 4. I 侧接线（详见 `I_INTEGRATION_NOTES.md`）

- `src/server.ts`：只读 probe 注入（IR-D1）+ 重复回答映射 `INPUT_ALREADY_ANSWERED`（IR-A6）。
- `scripts/workbench-desktop-commands.mjs`：`productivity_template_instantiate`，时限只取存储政策（IR-B1）。
- `src/productivity-service.ts`：通知快照 `deliveryFailures` / `failures[]`（IR-B4）。
- `package.json`：`readiness` / `bootstrap` / `probe:pages` 三个别名（IR-A2、IR-B5）。
- `scripts/package.mjs`：`readiness.mjs`、`bootstrap.mjs` 及其 `dist` 进入候选包（IR-A3）。

## 5. 候选包（中间产物，非最终发行）

- 命令：`npm run build` → `node scripts/package.mjs outputs/candidate-cp2`。
- 主包：`outputs/candidate-cp2/codex-workbuddy-gateway-v0.7.1.zip`
  - 文件数 **734**（RC6 为 696；新增来自 A/B/C/D 源码与测试、I 侧新测试与文档）
  - 字节 **2,459,060**
  - SHA-256 `61dc04566bf5afe024620fda52786985688278ece07c93e04067db2ece4a8017`
  - manifest `codex-workbuddy-gateway-v0.7.1.manifest.json` 118,591 B，SHA-256 `96d9cc3dc2ae04d530b42f6bb905f385d5a873e097444421b8b15f5123d75a8f`
- 解压根 `node scripts/verify-release.mjs` → `{"version":"0.7.1","verifiedFiles":734,"hashesMatch":true}`。
- `node scripts/candidate-installation.mjs check --package … --expect-sha256 …` → `"ok": true`、`"problems": []`、`totalBytes 8,052,346`。

边界：这是**本机生成的候选包自检**，不是安装、不是异机运行、不是发行。

## 6. 仍未验证（不得读成通过）

- 桌面壳真实窗口（WebView 初始化仍失败）、五尺寸在真实窗口的复核、读屏朗读。
- 真实执行器派工（`live` 一档仍是 RC1/RC2 旧记录）。
- 安装到本机/异机（只做了候选包结构自检与隔离安装根自举）。
- 自动模式 arming、`hardCap`。
- CI、许可、发行。
