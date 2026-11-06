# 最终交付检查与复核索引

本文件是交付的唯一入口。**顶部是收口轮（2026-11-06）的当前状态**；从「判读约定」开始到 §14 是第 11 线在提交 `06d52b1` / RC2 上的历史记录，保留原文不再更新；读到旧 SHA 与旧结论时以顶部为准。

## 当前状态（收口轮，2026-11-06）

| 项 | 值 |
| --- | --- |
| 源码树 | `E:\javaproject\workbuddy-finish\R-review-fixes` |
| 分支 | `fix/delivery-review-r1-r4` |
| 起点提交 | `8a614c9ee7dc76c4cec22727f884cf6a0e658792`（RC4，Codex 复核对象） |
| 本轮提交 | 见文末「收口轮回执」；提交后由外部回执记录该 SHA，提交前不预设 |
| 候选包 | RC6：`gateway/outputs/release/codex-workbuddy-gateway-v0.7.1.zip` |
| 包 SHA-256 | `c9f724d4888da5ed2566b464c4b85745693d7dd3b600fed1f622b8f3a10338ff`（2,257,997 B，696 个受管文件） |
| manifest SHA-256 | `49a0656c26d54ff65b470d14a75f629481b19f4e869df370c2e205c79b84f5f4`（112,259 B） |
| 技能包 / Harness 包 | `e61be9ba…`（6 文件）/ `22909e1b…`（2 文件），本轮未变 |
| 解包核对位置 | `E:\javaproject\outputs\finish-integration-20261105\closeout\candidate-rc6\codex-workbuddy-gateway-v0.7.1` |
| 安装状态 | 未安装。最后一次真实安装是 RC2（`E:\javaproject\workbuddy-install\gateway-v0.7.1-rc2`），RC3/RC4/RC5/RC6 都没进过真实环境 |
| 真实派工 | RC1 两单真实派工 accepted；RC2 一单落 `needs_review`、另一单被拒后 `blocked` 占着容量（按 T7D 原样保留）。RC3–RC6 无真实派工 |
| 异机 / 远端 CI | 未做 |
| 许可与发行 | 未决（仓库无 LICENSE；发行范围需用户定） |
| 部署 | 未部署、未推送、未合 main |

最小复验（只读，约 15 秒）：

```text
cd E:\javaproject\workbuddy-finish\R-review-fixes\gateway
npm run build && npm run typecheck:task-view && npm run test:workbench
node scripts/package.mjs            # 先拒绝过期 dist，再打包
node <解包根>\scripts\verify-release.mjs
```

## 收口轮做了什么

| 项 | 结论 | 证据 |
| --- | --- | --- |
| C4-1 journal 读异常被当成「未派工」 | 已修：只有 `ENOENT` 视为干净，`EACCES/EPERM/EIO/ENOTDIR/未知` 一律视为未证明；`stat` 与 `readdir` 两阶段都覆盖 | `gateway/src/coordinator.ts` 的 `journalShowsNoDispatch`；7 种注入回归在 `gateway/test/desktop-queue.test.ts` |
| 同类「读失败 = 已停止」 | 已修两处：`process.kill` 只有 `ESRCH` 才算进程消失 | `gateway/src/run-journal.ts`、`gateway/src/run-worker.ts` |
| R3 正向派工证据 | 已补：真实 CLI 组合根 + 记录型客户端，合法 decision 走到 `TaskApplicationService.send`；同 operationId 幂等、换 operationId 冲突、撤回后不派发 | `gateway/test/automation-cli-dispatch.test.ts`（2 例） |
| R2 脱敏边界 | 已补：`task.title` 与 `evidence.reviews[].correction` 也脱敏；同字段重复只报一次 | `gateway/test/delivery-export.test.ts`（20 例） |
| F-CONTRACT-1 | 已给行为说明、兼容影响表与需要用户决定的 B/C 选项；本轮只改提示词措辞，不放宽范围判定 | `docs/delivery/F_CONTRACT_1.md` |
| 打包发布态 | 新增构建新鲜度守卫：`dist` 比 `src` 旧超过 2 秒且文件数达到真实规模时，`node scripts/package.mjs` 直接拒绝 | `gateway/scripts/package.mjs`；回归 `a stale dist is refused before anything is zipped` |
| 打包事故（本轮真实发生） | 第一次 RC5 复用了上一轮的 `dist`，C4-1 修复没进包；解包探针把「源码修了、包没修」当场抓出，重建后才得到 RC5 的 SHA | `outputs\finish-integration-20261105\closeout\c41-rc5.json` 的失败轮与通过轮 |
| 迁移事故（RC6 前） | 旧 `ensureAutomationSchema` 先建四张表再校验版本，遇到更高版本的库会先写入再拒绝；旧库交叉验证发现后改为先校验后建表，并加回归 | `outputs\finish-integration-20261105\closeout\probe\crosscheck.mjs` 与 `rc6-crosscheck.json` |

## 收口轮验证

| 检查 | 结果 |
| --- | --- |
| `npm run build` / `npm run typecheck:task-view` | exit 0 / exit 0 |
| 完整后端套件 `npx tsx --test "test/**/*.test.ts"` | 1301 tests / 1289 pass / 0 fail / 12 skipped。首轮曾红在本轮自写的新鲜度回归（夹具只刷新了部分 dist），修正夹具后全绿；`command-cleanup` 与 `run-worker` 两个高负载偶发本轮未复现，仍按未定位记录 |
| `npm run test:workbench` | 139/139，exit 0 |
| `npm run desktop:test` | `{"passed":92,"failed":0}` |
| 解包 `verify-release.mjs` | 696 文件、`hashesMatch:true` |
| `candidate-installation.mjs check` | `ok:true`、`problems:[]`、`totalBytes 7,355,535`；用错误 SHA 复核会稳定报 `Archive SHA-256 does not match` |
| `preview` | exit 1（预期：纯包无依赖与桌面壳），`safeToApply:false`、`create:696` |
| `version-check` | `matches:true`、`exact:true` |
| `drill --apply` / `upgrade-drill --apply` / `rollback-plan` | 全部 exit 0；回退到上一候选（RC5）的计划 `safeToApply:true` |
| 三个打包缺陷探针 | C4-1 三态（clean 关闭、两种不可读都保留容量）；R1 两道门（9 步）；R2/R3（脱敏保留正文、CLI 报 `dispatcherWired:true`、`armed:false`） |
| 旧库交叉验证 | RC1 时代 25 表库直接服务：按需建 4 张 automation 表、6 任务与 42 操作保留、五条只读路由 200、写入口 405；版本 2 与不可读元数据均 503 `AUTOMATION_SCHEMA_UNSUPPORTED` 且不新增同类表 |

## 仍未满足（不许读成通过）

1. **真实环境只到 RC1/RC2。** RC6 的安装、派工、异机、CI 都是未做状态。
2. **53 项矩阵没有一项因本轮改动改判「整项通过」**；本轮只补证据与缺陷，`docs/D0_D1_DELIVERY_READINESS.md` 第 2 节原文不动。
3. **F-CONTRACT-1 的 B/C 方案需要用户决定**：放行未声明范围的写入、或从正文推导范围，都会改正式语义。
4. **两个高负载偶发**（`command-cleanup` 计数、`run-worker` EPERM）根因未定位。
5. **UI 四尺寸 / 200% 缩放 / 读屏 / 键盘路径** 只有合成断言，没有真实窗口实测。
6. **许可、发行范围、推送与合 main** 等用户在 `docs/delivery/EXTERNAL_DECISIONS.md` 里逐项确认。

---

> 以下为第 11 线历史记录（对象：`06d52b1` + RC2）。其中「最终候选 RC2 从未进过真实环境」等表述描述的是当时对象；当前对象见顶部 RC6。

## 判读约定（先看这一节，否则后面每个状态都会被误读）

1. **任务状态只用五个词**：待开始 / 进行中 / 待验收 / 待外部条件 / 已完成（`docs/parallel/DELIVERY_FINISH_20261105/MASTER_PLAN.md:61-67`）。
2. **交付状态只用七类**：开发完成 / 合成验收 / 真实验收 / 异机验证 / 远端 CI / 许可与签名 / 部署与发行（任务书 `11_FINAL_REVIEW_HANDOFF.md` 固定回执四类中的第三类）。
3. **「已完成」在本索引里只表示「该行要求的动作已经做完并可指认证据」**，不等于「53 项通过」「可以发布」「已由 Codex 验收」。任务书明令：不得替 Codex 签「已由 Codex 验收」。
4. **本索引的三种判定用语**：
   - **成立**：我亲自跑过只读命令或读过文件，结论可由给出的路径/哈希复算。
   - **未核验**：文档里有记载，但本线没有独立复算（多为真实安装根、真实库、真实派工记录、远端状态）。「未核验」不是「不成立」，但也不能当「通过」用。
   - **不成立**：有可指认的反证（见第 10.1 节）。
5. **证据分层**（沿用 `docs/D0_D1_DELIVERY_READINESS.md:55-57`）：源=源码与检查；合=隔离替身/合成；真=真实模型/原生观察；窗=窗口实测；CI=远端自动检查。四层不得互相替代，也不能把旧实机结果改挂到新候选。

---

## 0. 候选与提交标识（本线自算，不复述集成人数字）

### 0.1 提交链（`git log --oneline`，自上而下）

```
06d52b1  docs: replay the RC2 refusals and repair the three unreadable evidence files   ← 现 HEAD
b37be81  fix: give live-acceptance refusals stable admission codes and archive the 10 record
91af89e  Integrate the third batch and freeze the delivery candidate                    ← RC1 冻结点
05fa644  Merge branch 'test/finish-l08-acceptance' into integration/delivery-finish
3008d01  Merge branch 'feat/finish-l07-automation' into integration/delivery-finish
000e9da  Integrate the L05 recommendation and L06 productivity deliveries                ← G2
af9bab6  … （G1）        1f60374  … （G0 公共清单）        b4fae7f  0ba7c30  490f4f1  2819c28 （G0 集成修复与三条 A/B/C 合入）
```

- `b37be81` 只动 `gateway/src/coordinator.ts`(+4/-1)、`gateway/src/workspace-workers.ts`(+6/-1) 与两个测试、八个文档类文件（`git show --stat b37be81`）。
- `06d52b1` 只动三个文件：`docs/delivery/LIVE_EVIDENCE_REPAIR.md`、`docs/delivery/STATUS_INDEX.md`、`gates/G3-fix.json`（`git show --stat 06d52b1`）。**该提交不含任何代码改动。**

### 0.2 三个发布包（我逐个自算 SHA-256 与字节数）

| 产物 | 位置（本机，不入 Git） | 字节 | SHA-256（自算） | 状态 |
|---|---|---|---|---|
| 网关候选 **RC2**（现役最终候选） | `I-integration\gateway\outputs\release\codex-workbuddy-gateway-v0.7.1.zip` | 2 236 003 | `9e146b93fe40ff3b7086e4117c89dd0e2b81f81c61a585cfba4b003ef4411eee` | 只做过源码与合成检查；**未进真实环境** |
| 同包 manifest（旁置） | `…\release\codex-workbuddy-gateway-v0.7.1.manifest.json` | 111 924 | 未单算（包内同名内嵌件逐字比较一致，见 0.3） | 694 文件、`version":"0.7.1"`、`project` 字段 |
| 网关 **RC1**（真实验收用的那个） | `outputs\finish-integration-20261105\G3-fix\release-rc1\codex-workbuddy-gateway-v0.7.1.zip` | 2 235 102 | `658a20b196051fa25be1c669bb9b5c5574216cd30a6b223bd07efe2e90ba11b8` | 已真实安装并做过两单派工；源码已前进，**不再是最终候选** |
| 技能包 | `…\release\workbuddy-executor-v0.7.1.zip` | 27 040 | `e61be9ba03f48e555ed1a8441eb8d56f0013eb818cfdceb610015d26e0839db8` | 两个候选共用同一份 |
| Harness 技能包 | `…\release\deepseek-executor-v0.7.1.zip` | 4 249 | `22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13` | 同上 |

三个 `.sha256` 旁置文件内容与上表逐字一致（`Get-Content … -Raw`）。

### 0.3 我实际跑过的只读命令与结果

| 检查 | 命令/方法 | 结果 |
|---|---|---|
| 压缩包结构 | `System.IO.Compression.ZipFile` 逐条目统计 | 695 条目；`node_modules` 0 条；`/dist/*.js` 116 条；`.env` 0 条（仅 `.env.example` 1 条）；`/data/` 0 条；`/desktop/` 11 条；顶层含 `RESTORE.md`、`RELEASE_MANIFEST.json` |
| 包内 manifest | 流式读取 `RELEASE_MANIFEST.json` | `version=0.7.1`、`files=694`、顶层键 `project,version,videoAcceptance,files` |
| 包自检 | 在 RC2 解包目录执行 `node scripts/verify-release.mjs` | `{"version":"0.7.1","verifiedFiles":694,"hashesMatch":true}`，exit 0 |
| 修复是否进了 RC2 产物 | 在两个包的 `dist` 里检索稳定码字面量 | RC2 `dist/workspace-workers.js` 含 `WORKSPACE_CONFLICT` 1 处、`dist/coordinator.js` 含 `ATTEMPT_LIMIT` 1 处；**RC1 的 `dist/workspace-workers.js` 含 `WORKSPACE_CONFLICT` 0 处、`dist/coordinator.js` 含 `ATTEMPT_LIMIT` 0 处** |
| 文档 blob | `git ls-tree -r HEAD docs/delivery gates docs/D0_D1_DELIVERY_READINESS.md` | 见第 1.1 节表 |
| 远端与标签 | `git remote -v`、`git tag`、`git branch -vv` | 远端 `origin` 指 `github.com/shenmiqinvzi/workbuddy-executor-community.git`；`docs/final-review` 无 upstream；标签 0 个 |
| 链接存在性 | `Test-Path` 逐条 | `gateway/docs/RESTORE.md` **不存在**；`gateway/RESTORE.md` 存在且已被跟踪（见 K1） |

**本线明确没有做的事**：没有运行 `npm test`、没有构建 dist、没有 `npm ci`、没有安装/升级/卸载任何东西、没有打开真实任务库、没有碰真实安装根、没有派工、没有推送。

---

## 1. 提交链、归属文件与接线关闭

### 1.1 交付文档清单（路径 + Git blob SHA + 引入提交）

全部取自 `git ls-tree -r HEAD docs/delivery gates docs/D0_D1_DELIVERY_READINESS.md`，blob SHA 可逐条复算。

| 文件 | blob SHA | 引入提交 | 复核结论 |
|---|---|---|---|
| `docs/delivery/STATUS_INDEX.md` | `f0f0c0142f5aef4eb0bb45e85c76abc25e4bafa3` | `1f60374`（末次更新 `06d52b1`） | 唯一现状来源；但「11 交付检查」一行仍写“未开始”（见 K3） |
| `docs/delivery/LIVE_ACCEPTANCE_SUMMARY.md` | `893001411f107c6e7d4aa7aeb997b0cf6d8be227` | `b37be81` | 10 的主报告；七类状态与固定回执齐全 |
| `docs/delivery/LIVE_ACCEPTANCE_EVIDENCE_INDEX.md` | `4fa490d5bd8f0be3a91b92871599bd17d9e40fae` | `b37be81` | 证据索引；三份坏证据未回链（见 K4） |
| `docs/delivery/EXTERNAL_CONDITIONS.md` | `271e32da78fda0c9f458e09d5bae693527f24f26` | `b37be81` | E01–E19 外部条件台账 |
| `docs/delivery/LIVE_EVIDENCE_REPAIR.md` | `097705b745a3318181ea61e66218bd46e51f1f36` | `06d52b1` | 三份不可解析证据的重采/转码/投影结论 |
| `docs/D0_D1_DELIVERY_READINESS.md` | `b895ec23ed8520e67cf82b3b018dcb6b958274bb` | `bd4cdf8`（末次 `91af89e`） | 53 项矩阵原文（§2）+ G1/G2/G3 三段只增不改的增量（§5/§6/§7） |
| `docs/delivery/L01_ACCEPTANCE.md` … `L08_ACCEPTANCE.md` | `0ebcfdc3…`、`1367303…`、`f1084f5a…`、`f9fcf0a3…`、`1b7565c8…`、`d35d3f0a…`、`cd8d6572…`、`616ab76b…` | 各线分支 + 合入提交 | 八线自述；行号引用见各节 |
| `docs/delivery/L03_INTEGRATION_REQUEST.md` / `L05_…` / `L06_…` / `L05_RULES.md` | `d8afbfb4…` / `a7ff3505…` / `0770dcdb…` / `cf78c269…` | 同上 | 接线请求原件 |
| `gates/G0.json` | `70482c664c2b4e15434f21cd11bd44c4381972c1` | `1f60374` | 见第 1.3 节 |
| `gates/G1.json` | `414dc597a705af3bde08fb24c2ec9ff533902748` | `af9bab6` | 同上 |
| `gates/G2.json` | `0d9da45bf3a44b7cb0fa51680ab309717b91a524` | `000e9da` | 同上 |
| `gates/G3.json` | `4d5e1badf84612fcbf4a566146a4ca5ac4791ebd` | `91af89e` | 同上 |
| `gates/G3-fix.json` | `22199145dfd5d6754d1b6f924a6ac55001d6a0eb` | `b37be81`（末次 `06d52b1`） | 代码基线字段有问题（见 K2） |

### 1.2 八线交付与合入（数字取自 `docs/delivery/STATUS_INDEX.md`，提交号我用 `git cat-file` 逐个确认存在）

| 线 | 交付分支 | 交付 HEAD | 提交/规模 | 合入提交 | 本线复核 |
|---|---|---|---|---|---|
| L01 | `feat/finish-l01-project` | `226af908e5fd262fb16fac97e968206c6ea31c8b` | 1 提交 / 12 文件 1231+/55- | `960ee3a43b6b56879c66c416ac5843eb12ddf2a1` | 提交存在 ✔ |
| L02 | `feat/finish-l02-resources` | `35d7e0e54ac80582fdc0ca196f2c416d9c71b95d` | 3 提交 / 16 文件 2902+/17- | `6e71c930a0d6b9efe460835c2270fcb60090d54c` | 同上 ✔ |
| L03 | `feat/finish-l03-statistics` | `31d60330cca02ca8560c6bd05c33b99025c26005` | 2 提交 / 17 文件 3257+/8- | `b52ce2bc4bf069e29645c62a9b158f09348d939d` | ✔ |
| L04 | `feat/finish-l04-installation` | `5527850b6406046bae1a031d8887728fe4c4d2fa` | 1 提交 / 10 文件 1680+/39- | `0dfe653bcffa62f1e29a93ad24d4b6993ca12989` | ✔ |
| L05 | `feat/finish-l05-recommendation` | `fd56b132a8c2f2ec4c77f12142c74626153a527c` | 2 提交 / 12 文件 1467+/4- | `dbb9b2fa95ddb35c5bf2e43496f9eeee4f6b3b32` | ✔ |
| L06 | `feat/finish-l06-productivity` | `5b31cb3980d943c7f2008345b3c3fbb85749343c` | 2 提交 / 29 文件 4621+/13- | `4a3c9b46acf968ec668e2abd60bd3c9d7e451e4f` | ✔ |
| L07 | `feat/finish-l07-automation` | `de8cf5de7ddab4f59fd056940a2cd8171cb9bba4` | 2 提交 / 30 文件 3149+/13- | `3008d01c2bf4173d4884ae7d972671dabaca498a` | ✔ |
| L08 | `test/finish-l08-acceptance` | `7bbdfb47530ba2111cd7a9b5b996ee20c79b45e9` | 3 提交 / 7 文件 1365+/0- | `05fa644dc1f73d5d0468328f459c097cd41a9d27` | ✔（只加测试与报告，未改业务源码） |

八份 `HANDOFF.json`（`E:\javaproject\outputs\finish-l0{1..8}-20261105\HANDOFF.json`）字段一致：`implemented=true`、`syntheticVerified=true`、`liveVerified=false`、`deployed=false`、`releaseReady=false`；集成请求数 0/3/5/0/2/7/8/4，开放问题数 3/4/5/4/5/7/8/9，外部条件数 3/6/3/3/3/4/4/5。**注意：八份 HANDOFF 的 `liveVerified` 全为 false，而 10 的文档说两单真实派工已通过——两者不矛盾，因为 HANDOFF 是各线自评，10 的真实证据归 10 的报告与 `gates/G3-fix.json`，不改写各线 HANDOFF。**

### 1.3 gate 回执要点（我自己解析 JSON 得到，不是抄 STATUS_INDEX）

| gate | 回执文件 | recordedAt | codeBaseCommit / tree | sourcePassed / liveReady | 关键失败 |
|---|---|---|---|---|---|
| G0 | `gates/G0.json` | 2026-11-05T20:22+08:00 | `1f60374a…` / `a45970de…` | true / — | 全量首轮 `1048/1031/5 fail`（全在 `test/package.test.ts`，Missing release file `scripts/candidate-installation.mjs`），第二轮 `1048/1036/0/12` |
| G1 | `gates/G1.json` | — | `af9bab6f…` / `d919434f…` | true / false | 全量第一轮 `1145/1132/1 fail`：`test/run-worker.test.ts:94`，`EPERM … rename state.json.<pid>.<rand>.tmp -> state.json`；第二轮 0 fail |
| G2 | `gates/G2.json` | — | `af9bab6f…` / `d919434f…` | true / false | 两线专项首轮 exit1（Missing release file `workbench/productivity.mjs`）；EPERM 未复现 |
| G3 | `gates/G3.json` | — | `91af89ee…` / `4c61792a…` | true / false | 全量 `1281/1269/0/12` 一轮即 0 fail |
| G3-fix | `gates/G3-fix.json` | 2026-11-06T16:06+08:00 | `91af89ee…` / `4c61792a…`（**与实际打包树不符，见 K2**） | true / `liveVerifiedForRc1=true`、`rc2LiveVerified=false`、`releaseReady=false` | 全量 `1282/1269/1 fail`：`test/command-cleanup.test.ts:24`（`recovered.length` 期望 1 得 0），单文件复跑两次 4/4 |

### 1.4 原始失败与最终复验日志路径

| 批次 | 原始日志 | 最终复验 | 备注 |
|---|---|---|---|
| G0 | `outputs\finish-integration-20261105\G0\logs\`（全量首轮日志**被第二轮同名覆盖**，gate 自己记了这条） | 同目录第二轮日志，exit 0 | 首轮 5 fail 的失败项已重建为 `scripts/candidate-installation.mjs` 夹具，未留原始文件 |
| G1 | `outputs\finish-integration-20261105\G1\logs\` | 单文件复跑 `npx tsx --test --test-concurrency=1 test/run-worker.test.ts` 5/5，exit 0 | EPERM 根因**未定位** |
| G2 | `outputs\finish-integration-20261105\G2\logs\` | `G2\probe\host-recommend.mjs` exit 0 | — |
| G3 | `outputs\finish-integration-20261105\G3\logs\` | 同上 + 三个探针（desktopRecommend/httpSmoke/automationPanelWithSavedPolicy） | — |
| G3-fix | `outputs\finish-integration-20261105\G3-fix\logs\` | `G3-fix\probe\probe-rc2-replay.mjs` exit 0 | command-cleanup 单文件 4/4 两次；根因**未定位** |
| 10 | `E:\javaproject\outputs\finish-live-20261106\`（284 文件，不入 Git） | 集成人用 `G3-probe\verify-live10.mjs` 对库**副本**只读核验，输出 `live10-verify.json` | 本线**未打开**这些原始证据（见 10.2） |

---

## 2. 任务与矩阵的逐项状态

### 2.1 31 项任务（定义摘自 `docs/parallel/DELIVERY_FINISH_20261105/MASTER_PLAN.md:25-59`）

「源码/合成」「真实」两列分别是该任务在合成证据与真实环境里的**实际到达层**；「状态」是本线的判定，不是各线自评。

| 任务 | 要点 | 源码/合成 | 真实（RC1，同机） | 状态 | 证据锚点 | 剩余动作 |
|---|---|---|---|---|---|---|
| D0-01 | 源码/技能/磁盘/MCP/桌面/服务/政策版本表 | 有表 | 2026-11-06 只读采样（含五个 codeHash） | 已完成 | `LIVE_ACCEPTANCE_SUMMARY.md:76-110`、本文 §3 | 运行现场需在最终候选上重采一次 |
| D0-02 | 53 项逐项类型/版本/证据/缺项 | 有矩阵（95 行） | 未改判任何整项 | 已完成 | `D0_D1_DELIVERY_READINESS.md:79-147`、`L08_ACCEPTANCE.md:90-160` | 真实与窗口证据缺（见 §2.2） |
| D0-03 | 用户实际发行范围 + 原 T7D 补验判定 | 只有分期草案 | 未决定 | 待外部条件 | `D0_D1_DELIVERY_READINESS.md:149-159`、`EXTERNAL_CONDITIONS.md` E11/E19 | 用户书面决定（见 §8） |
| D1-01 | 可回退候选 + 真实安装 + 认证显示实窗 | 安装/升级/卸载/回退工具齐 | 新目录装过一次；`login: unknown` | 待验收 | `LIVE_ACCEPTANCE_SUMMARY.md:112-148`、`INSTALL_WINDOWS.md:139-186` | 认证状态实窗、真实回退 |
| D1-02 | 已装技能+真实 MCP 双端闭环 | — | 两单 accepted（走 `scripts\workbuddy-call.mjs`，非聊天 MCP） | 待验收 | `LIVE_ACCEPTANCE_SUMMARY.md:150-214` | 聊天 MCP 入口闭环（本轮明确未合并片段） |
| D1-03 | 原身份返工/领取后取消/重连/已知未知等待 | 合成通过/部分 | R4 领取后取消通过 | 待验收 | `L08_ACCEPTANCE.md:162-177`、`LIVE_ACCEPTANCE_EVIDENCE_INDEX.md:164-184` | 返工与重连实机 |
| D1-04 | 不确定准备/投递、先报告、迟到、旧证据、跨入口并发 | 12 类异常合成全通过 | R3 报告先到通过；R6 暴露缺陷；R1/R2/R5/R9 未做 | 进行中 | `L08_ACCEPTANCE.md:162-177`、`LIVE_ACCEPTANCE_SUMMARY.md:298-308` | 4 类真实卡（需授权） |
| D2-01 | 项目登记/选择/诊断/精确会话 | 源码+合成 | 未做 | 待验收 | `L01_ACCEPTANCE.md`、`STATUS_INDEX.md`「任务分层登记」 | 真实目录/宿主 |
| D2-02 | 技能/桌面同目录能力，报价与请求观察分层 | 源码+合成 | 未做 | 待验收 | 同上 | 真实报价 |
| D2-03 | 预览/修改/可信确认/持久消费 | 源码+合成 | 未做 | 待验收 | 同上 | 实窗确认 |
| D2-04 | direct 与委派一致，用户指定优先 | 源码+合成（推荐探针） | 两单模型均由用户当场选择 | 待验收 | `gates/G2.json` probe 段 | 覆盖与撤回实机 |
| D3-01 | 采集器/缓存/API 真实来源 | 源码+合成 | 无账号池 | 待外部条件 | `STATUS_INDEX.md`、`EXTERNAL_CONDITIONS.md` E06 | 真实账号/Key |
| D3-02 | Key/区域/模型限制/共享池映射 | 源码+合成 | 无 | 待外部条件 | 同上 | 同上 |
| D3-03 | 资源视图声明来源/单位/覆盖/新鲜度 | 合成（三层 verified:false） | 无 | 待验收 | `STATUS_INDEX.md` | 真实快照 |
| D3-04 | 故障隔离/退避/乱序 | 合成 | 无 | 待验收 | `L02_ACCEPTANCE.md` | 真实交叉 |
| D4-01 | 规则候选/理由/排除 | 合成（`recommendation-1`） | 无 | 待验收 | `gates/G2.json`/`G3.json` probe | 真实宿主面板 |
| D4-02 | 引用资源快照、覆盖后新版本 | 合成 | 无 | 待验收 | `L05_ACCEPTANCE.md` | 同上 |
| D4-03 | 技能/桌面推荐确认闭环，推荐不授权 | 合成 + C# 5 例 | 无 | 待验收 | `gates/G2.json` integrationFixes | 真实桌面通道 |
| D5-01 | 政策可查看/修订/到期/撤回 | CLI 合成（`policy-create` 成功） | 无 | 待验收 | `gates/G3.json` automation CLI 段 | 真实入口 |
| D5-02 | 授权内持久派工/恢复/并发预算 | 合成；`armed:false`、`dispatcherWired:false` | 未启用 | 待验收 | 同上 | 真实启用（需授权） |
| D5-03 | automatic 界面/审计/竞态 | 合成投影 | 无 | 待验收 | `gates/G3.json` probes | 真实长程窗口 |
| D6-01 | 请求归因、覆盖及去重 | **仅接口面** | 无 | 进行中 | `STATUS_INDEX.md`、`D0_...md:114`（C12） | `request-attribution-1` 缺口 |
| D6-02 | 可复算时间/调用/返工/恢复/人工/费用 | 合成；引擎 `calls` 恒空 | 无 | 待验收 | `gates/G1.json` openUnknowns | 真实调用计数 |
| D6-03 | 版本化模板，不复制身份/授权/旧证据 | 合成通过（模板子项） | 无 | 待验收 | `L08_ACCEPTANCE.md:131` | 真实实例化；政策模板仍不可激活 |
| D6-04 | 通知去重与脱敏导出 | 合成 | 无 | 待验收 | `L06_ACCEPTANCE.md` | 真实通知宿主 |
| D6-05 | 样本量/时间窗/检查器错误单列 | 合成 | 无 | 待验收 | `L03_ACCEPTANCE.md` | 真实样本 |
| D7-01 | 干净安装/重复/升级/卸载/回退/后台启动 | 合成演练 4 步/17 步全通过 | **只做了「新目录安装」** | 待验收 | `gates/G3.json` candidateTools、`LIVE_ACCEPTANCE_SUMMARY.md:112-148` | 真实升级/卸载/回退 |
| D7-02 | 第二台物理 Windows | — | 没有机器 | 待外部条件 | `LIVE_ACCEPTANCE_SUMMARY.md:310-312` | 机器与操作者 |
| D7-03 | 许可、第三方声明、最终用户文档 | 台账齐（94 包） | — | 待外部条件 | `L04_ACCEPTANCE.md:80-121`、`USER_ACCEPTANCE.md:60-96` | 权利人定许可文本 |
| D7-04 | 对应最终 HEAD 审查/CI/保护/产物校验 | 本地校验通过 | 无 PR/CI | 待外部条件 | 本文 §7 | 推送与 CI（需授权） |
| D7-05 | 候选档案、标签/签名/发布说明/回退 | 档案与三包校验和齐 | 无标签、无签名 | 进行中 | 本文 §0.2、§4.3 | 标签/签名/发行 |

> 判定口径：**没有任何一项可写「已完成（真实）」**。写「已完成」的三项（D0-01/D0-02）是文档与矩阵类交付，其要求的产物本身存在且可复核；它们在真实环境的适用性仍受 §2.3 约束。

### 2.2 53 项矩阵逐项状态

三列口径：**原状态**＝`docs/D0_D1_DELIVERY_READINESS.md:79-147` 原文；**合成增量**＝`docs/delivery/L08_ACCEPTANCE.md:90-160` 与 `D0_...md:184-195`（G3 增量）；**真实**＝RC1 上确实发生过的子断言（仅此，不改判整项）。

**V01–V15**

| 项 | 范围/版本（原文） | 原状态 | 合成增量 | 真实（RC1） | 剩余动作 |
|---|---|---|---|---|---|
| V01 | 受控、完整；真 T6/T7B/T7C | 部分证据 | 合成通过 | 两单各自 `task_closed` 1 条（子断言） | 双端安装技能+MCP 代码任务闭环 |
| V02 | 受控、完整 | 部分证据 | 合成部分 | 无 | 准备/投递不确定实机 |
| V03 | 受控、完整 | 部分证据 | 合成部分 | **R3 通过**（报告先到→`STOP_UNCONFIRMED`） | accept/rework/new dispatch 三重拒绝 |
| V04 | 受控、完整 | 部分证据 | 合成通过 | **R4 通过**（取消、容量保留、`clamp.mjs` 未变） | 原生误停 |
| V05 | 受控、完整 | 部分证据 | 合成通过 | 无（R5 未做） | 迟到与重连 |
| V06 | 受控、完整 | 部分证据 | 合成部分 | **R7 通过**（同键换执行器 `OPERATION_CONFLICT`） | 双进程并发同键 |
| V07 | 受控、完整 | 部分证据 | 合成部分 | 无（R9 未做） | 真实越界与旧改动 |
| V08 | 受控、完整 | 部分证据 | 合成通过 | 无 | 改源码后的留痕 |
| V09 | 受控、完整 | 部分证据 | 合成通过 | 无 | 双端语义审查 |
| V10 | 受控、完整 | 部分证据 | 合成部分 | **R8 通过**（`maxAttempts=1` 返工被拒） | 三轮耗尽、主动免费 |
| V11 | 受控、完整 | 部分证据 | 合成通过 | 无 | 重开/掉线/旧 revision |
| V12 | 受控、完整；统计 D6 | 部分证据 | 合成部分 | 无 | 人工 episode 与去重 |
| V13 | 受控/完整发行 | **未验证本轮安装** | 未覆盖 | **仅新目录安装 + doctor**（`codeHash ac2a673f…`） | 升级/卸载/回退、运行摘要 |
| V14 | Windows 受控、完整 | 部分证据 | 未覆盖（关键条件缺失） | 部分：中文路径 `F:\新建文件夹 (2)\…` 真实跑通、R4 取消、常驻服务实存 | 返工/重连/服务失败 |
| V15 | 正式发行 | 未验证 | 未覆盖 | **0 个异机** | 第二台物理 Windows |

**C01–C18**

| 项 | 范围/版本 | 原状态 | 合成增量 | 真实（RC1） | 剩余动作 |
|---|---|---|---|---|---|
| C01 | 受控手动；完整含推荐/自动 | 未完成整项 | 合成部分 | 两单均为 manual | 推荐与预授权闭环 |
| C02 | 受控、完整 | 部分证据 | 合成部分 | 两单各 accept 一次（非幂等验证） | 幂等/并发消费实机 |
| C03 | DSH 受控、完整 | 部分证据 | 合成部分（仅拒绝面） | DSH 一单真实会话固定 | 无/多/错目录会话 |
| C04 | DSH 受控、完整 | 部分证据 | 合成部分 | 真实请求模型 `deepseek-v4.1-flash`/high（单样本） | 目录读回一致性 |
| C05 | 受控、完整 | 部分证据 | 合成部分 | 用户当场选型与确认费用（两单） | 价格漂移拒绝 |
| C06 | DSH 受控、完整 | 部分证据 | 合成部分 | DSH 单 accepted（非聊天 MCP 入口） | MCP 代码验收 |
| C07 | 受控、完整 | 部分证据且有占用门槛 | 合成通过 | 容量 1 严格串行；R6 占位后未再派 | 未知占用裁决 |
| C08 | 资源功能上线 | **未完成真实路由** | 未覆盖 | 冒烟 `routingVerified:false` | 真实账号池/Key/区域 |
| C09 | 资源功能上线 | 部分证据 | 合成部分 | 无 | 真实快照与单位 |
| C10 | 资源功能上线 | 部分证据 | 合成部分 | 无 | 来源/执行器交叉 |
| C11 | 资源功能上线 | 部分证据 | 未覆盖 | 无 | 退避/乱序/GET 零副作用 |
| C12 | 完整统计 P1 | 未完成 | 合成部分 | 无 | 请求归因/覆盖/去重 |
| C13 | 付费/硬限上线 | 部分证据 | 未覆盖 | 无 | 来源硬限能力 |
| C14 | 受控方案；完整含撤回/模板 | 未完成整项 | 合成通过（模板子项） | 无 | 方案审计、D5 撤回 |
| C15 | 资源功能上线/发行 | 部分证据 | 合成部分 | 无 | 安装浏览器凭据边界 |
| C16 | 升级/回退 | 部分证据 | 合成部分 | 无 | 真实兼容与回滚 |
| C17 | 受控、完整 | 部分证据 | 合成通过 | R7 换执行器被拒（子断言） | 双端文件保护实机 |
| C18 | 宿主/停止/版本发布 P0 | 部分证据 | 合成部分 | 两单 `native_idle` + `codeHash` 实测 | 统计样本数与区间 |

**F01–F20**

| 项 | 范围/版本 | 原状态 | 合成增量 | 真实/窗口 | 剩余动作 |
|---|---|---|---|---|---|
| F01 | 原型；真实另测 | 待范围决定/未复验 | 未覆盖 | 无 | 关闭真实服务后的冷启动 |
| F02 | 原型/合成展示 | 部分证据 | 未覆盖（视觉） | 无 | 演示入口标注截图 |
| F03 | 原型 10 态/受控展示 | 部分证据 | 合成通过 | 无 | 真实面板 10 态 |
| F04 | 各展示模式 | 部分证据 | 合成通过 | 无 | 报告→等待→待审真实分层 |
| F05 | 原型/真实只读 | 待范围决定/部分证据 | 合成部分 | 无 | 分模式网络记录 |
| F06 | 原型/受控等待 | 部分证据 | 合成部分 | 无 | 实窗渲染 |
| F07 | 原型/受控取消期限 | 部分证据 | 合成部分 | 无 | 文案呈现 |
| F08 | 真实只读/受控 | 部分证据 | 合成通过（数据层） | 无 | 刷新/掉线恢复 |
| F09 | 各展示模式 | 部分证据 | 源级通过 | 无 | 任务 A/B 乱序 |
| F10 | 各展示模式 | 未在本轮复验 | 合成通过（含 O3 限制） | 无 | 固定时钟实窗 |
| F11 | 各展示模式 | 部分证据 | 合成通过 | 无 | 界面零与 null 区分 |
| F12 | 各展示模式 | 未在本轮复验 | 源级通过 | 无 | 运行期双页合并 |
| F13 | 各展示模式 | 部分证据 | 合成通过 | 无 | 全界面降级 |
| F14 | 各展示模式 | 未在本轮全面复验 | 合成通过 | 无 | 真实 DOM 夹具 |
| F15 | 原型/公开材料 | 部分证据 | 合成部分 | 无 | 最终包/截图脱敏 |
| F16 | 各展示模式 | 部分证据 | 合成部分 | 无 | 界面分区展示 |
| F17 | 原型/声明支持页面 | 部分证据 | 未覆盖 | **无窗口** | 四尺寸 + 等待审查页 |
| F18 | 原型/受控主路径 | 部分证据 | 源级通过 | **无窗口** | 键盘主路径、200% 缩放 |
| F19 | 各交付版本 | 部分证据 | 合成通过（本线） | 集成全量见 §1.3 | 最终 SHA 的构建/包 |
| F20 | 各声明发行范围 | 交接材料已补；发行未完成 | 合成通过（交接面） | 部分（本索引） | 对齐安装说明与范围 |

**读法**：53 项里没有任何一项被本线或 L08 改判整项通过；`routingVerified:false`、`actualTaskCredits:null`、`tasksRead:0`（空库）、O1/O3/O4/O6 四条产品缺陷全部保留原状。

### 2.3 四类环境的分界（不许混用）

| 环境 | 本批实际到达 | 覆盖对象 | 不可外推为 |
|---|---|---|---|
| 历史真机（T6/T7B/T7C、11-04 样本） | 已有证据，时间 2026-10-28 – 11-04 | 旧代码（`8427e9e1…` 等） | 当前候选 |
| 当前合成（G0–G3、G3-fix） | `npm test` 多次 0 fail（G3）/ 1 fail（G3-fix）、专项 25/56/19/169/100/76、desktop 92、C# 5 例 | `integration/delivery-finish` 各提交 | 真实模型或原生宿主 |
| 当前真实（RC1，同机） | 1 次安装 + 2 单派工 + 5 张异常卡 | `658a20b1…` 包 | RC2、异机、生产 |
| 窗口 / 异机 / 远端 CI | **0** | — | 任何「已验收」表述 |

---

## 3. 版本与政策的对应关系

### 3.1 五个代码位置互不相同（源：`LIVE_ACCEPTANCE_SUMMARY.md:76-86`，10 自算 `codeHash`）

| 位置 | 版本 | dist js | dist 字节 | codeHash |
|---|---|---|---|---|
| T7B-preview（服务在跑） | 0.7.1 | 93 | 2 200 742 | `8427e9e1a4999a4301eb4d109e35ba383d20856eba69b286ba422a50b6e3d58c` |
| community | 0.7.1 | 55 | 1 171 501 | `d5529e49afe3c6b8b7930374ba538fcf7a61896b1cf758ac548d26125c62d833` |
| integrated-validation | 0.7.1 | 49 | 989 192 | `8110503b3ad6134ea8f44540d5c7ba8fb121488497ee61ed9e82bdaa1391a0c6` |
| `F:\WorkBuddy\codex-workbuddy-gateway` | 0.7.0 | 44 | 859 601 | `a365d16723bdf840028364df3c1b4c11471dc74dd12874ecd1abbaeed5025118` |
| RC（本轮新装） | 0.7.1 | 116 | 3 106 839 | `ac2a673f187546dc9d00c7a20a56ad6fad86adf54a2b0e90d22d1fbcd681e326` |

**结论（成立，但只到 2026-11-06 这个快照）**：四个都叫 0.7.1 的位置跑的是不同代码；新装根 `doctor.mjs` 自报 `ac2a673f…`，与我自算 RC2 包内 `dist/*.js` 116 个文件一致的数量级相同，但**RC2 的 `codeHash` 我没有重算**（未核验）。**任何「0.7.1 就是同一份」的推断都不成立。**

### 3.2 技能六文件在三个位置的状态

- 仓库根 vs `gateway/skills/workbuddy-executor/` 发布副本：6/6 相同（10 自算，`LIVE_ACCEPTANCE_SUMMARY.md:70-74`）。本线未重算（未核验）。
- 安装前磁盘 `C:\Users\LENOVO\.codex\skills\workbuddy-executor`（2026-11-04）与 RC 相比 **4/6 不同**；T7B 安装目录是第三套；`deepseek-executor` 当时未装。
- 安装后（RC1）安装位六文件与清单逐字一致；旧版备份 `C:\Users\LENOVO\.codex\skill-backups\workbuddy-executor-I5FgPH`。**本线未进该目录核对**（未核验）。

### 3.3 MCP、桌面壳、常驻服务

| 对象 | 事实 | 出处 | 本线判定 |
|---|---|---|---|
| MCP 配置 | 聊天 MCP 只注册在 `C:\Users\LENOVO\.codex\config.toml`，指向 T7B 的 `dist/server.js`；新装片段 `data\workbuddy-mcp.toml`（465B = 清单 `snippetHash`）**未合并**；`config.toml` 7449B、0 处 `workbuddy_rc` | `LIVE_ACCEPTANCE_SUMMARY.md:92`、`:144`、`:397` | 未核验（未读该配置文件） |
| 桌面壳 | `WorkBuddy.Workbench.exe`（163 840B）在 T7B 目录，安装前 0 进程；本轮真实派工期间仍为 0 个 Workbench 进程 | `LIVE_ACCEPTANCE_SUMMARY.md:91`、`LIVE_ACCEPTANCE_EVIDENCE_INDEX.md:150-163` | 未核验；**桌面壳在真实场景从未运行过**（这是结论，不是猜测） |
| 常驻服务 | 第一单 WorkBuddy 派工后网关自登记：PID 11672、`data\persistent-service.json`（678B）、`cdpPort 18491`、`workers 4`；该服务把任务库钉死，覆盖 `WORKBUDDY_DB_FILE` 会被 `dist/workspace-manager.js:25-28` 拒绝 | `LIVE_ACCEPTANCE_SUMMARY.md:145` | 未核验（未查进程）；用户已决定**保留**，未执行 `service-cli uninstall` |

### 3.4 政策与容量

- T7B 库政策（历史事实，`LIVE_ACCEPTANCE_SUMMARY.md:96-104`）：`version=policy-4zf1EnD-F3K4-rg70_7szRLJ`、`digest 6bb30e31…`、`requireFree=true`、`maxAttempts=3`、`maxTimeoutSeconds=86400`、只允许 `workbuddy/local-workbuddy/workbuddy-native/deepseek-v4.1-flash/reasoning=null`。
- 新库不继承该政策：`collaboration_policy` 0 行，取代码默认 `requireFree:false` / `selectionMode:"user_choice"` / `allowed:[]`。
- 容量：生产 `workflow_capacity(slot=1)` 仍被占用；RC1 新库的容量行现在指向 R6 的 `d1-workbuddy-2cc8e262-54f5-43a0-8511-b3febf0d4101`（`operationState=outcome_unknown`），已决定原样保留。另有 T7B 库 `t7c-mcp-live-range-20261031-01` 占用未释放。

**因此：现在任何一个新派工都会撞 `CAPACITY_OCCUPIED`，除非换一个全新的库；「真实容量仍为 1」这句必须和「已被占」一起读。**

---

## 4. 候选包、依赖、签名与安装生命周期

### 4.1 包内容（本线自算）

- 695 条目 = 694 声明文件 + `RELEASE_MANIFEST.json`；`node_modules` 0、`.env` 0、`data/` 0 → **不含真实配置、任务库、runs、聊天与 Key**（符合任务书「不把含真实配置/DB/runs/聊天/Key 的 outputs 打包」）。
- `dist` 348 条目（其中 `dist/*.js` 116）、`src` 116、`test` 110、`scripts` 30、`workbench` 27、`docs` 14、`deepseek-plugin` 12、`desktop` 11、`bin` 10、`skills` 8。
- `dist` 未入库：`git ls-files gateway/dist` 计数为 0（G0 也记了 `distTrackedInGit=false`）→ 包里的 `dist` 是打包时构建产物，**不是仓库里的旧 dist**；「最终包不能混入旧 dist」这条只能靠「打包前重建 + 包内自检」保证，本线在 RC2 上跑 `verify-release` 得到 694/694 匹配（成立）。
- 包内 `RESTORE.md` 在顶层，`INSTALL_WINDOWS.md` 在 `docs/` 下（见 K1）。

### 4.2 依赖、运行时与安装前提（源：`L04_ACCEPTANCE.md:80-108`）

- 网关包**不含** `node_modules`、Node、.NET 桌面运行时、WebView2、WorkBuddy 本体、`.env`、任务库。
- 生产依赖 94 个：MIT 84 / ISC 7 / BSD-3-Clause 2 / BSD-2-Clause 1；直接依赖 `@modelcontextprotocol/sdk`、`zod`。
- 运行时前置（不随包分发）：Node ≥ 22.13.0、.NET Desktop Runtime 10、WebView2 Runtime、WorkBuddy 本体。
- 实测环境：node 24.19.0、.NET 10.0.12、WebView2 156.0.4314.58。
- **本线未复算 94 个包的许可分布**（未核验，采信 L04 台账 `production-licenses.json`）。

### 4.3 签名状态

**未签名**（网关包与桌面预览包皆无代码签名；`USER_ACCEPTANCE.md:78-84` 明写可能出现 SmartScreen 提示，且不把关闭系统保护列为前提；`L04_ACCEPTANCE.md:86` 同）。本线没有做任何签名验证（`Get-AuthenticodeSignature` 未跑）——但「无签名」是文档明述事实，不与本线观测冲突。

### 4.4 安装、重复安装、升级、卸载、回退的证据

| 动作 | 合成证据 | 真实证据 | 结论 |
|---|---|---|---|
| 干净安装 | `drill --apply` 4 步 5 检查全 true（G0/G1/G2/G3 均 4/4） | RC1 新目录 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1`，`install --apply` ok、`doctor` ok | 成立（真实安装是一次性、单机、未重复） |
| 重复安装（应保持不变） | `upgrade-drill` 第 2 步 | 未做 | 合成成立，真实未做 |
| 用 install 覆盖（应被拒绝并提示 upgrade） | `upgrade-drill` 第 3 步 | 未做 | 同上 |
| 升级 | `upgrade-drill` 17 步/17 检查/6 负例 | 未做 | 同上 |
| 卸载 | `upgrade-drill` 末段 | 未做；常驻服务仍在（决定保留） | 同上 |
| 回退 | `rollback-plan`（对 G0 包 `safeToApply=true replace=62 remove=113 keep=519`；RC2 跨基线判 `incompatible`） | 未做 | 同上；**跨基线不能用它逐文件回退** |
| 原配置与历史保护 | 安装器只写 `.env`（仅不存在时）、技能、`data\workbuddy-mcp.toml`、`data\deployment-installation.json`；`config.toml` 未被写入 | RC1 同上，`config.toml` 7449B/0 处 `workbuddy_rc` | 成立 |
| 安装事故 | — | PowerShell 传中文路径导致 `.env` 的 `WORKBUDDY_CLI_ELECTRON` 落盘乱码，改用 Node UTF-8 字面量重写后 `envRepaired:true` | 已记录；说明**安装路径对编码敏感**，需写进用户说明 |

### 4.5 旧未知任务（原 P0-1）的裁决状态

**仍未裁决，且按 T7D 口径原样保留**：不关闭、不重派、不释放、不换库、不改写记录（`docs/T7D_P0_1_ORIGINAL_TASK_DECISION.md`；`LIVE_ACCEPTANCE_SUMMARY.md:110`、`:394`；`gates/G3-fix.json` `userDecisionsRecorded`）。产生它的网关库在本机不存在，因此「另立新样本」不会也不得改写它的状态。

### 4.6 RC1 与 RC2 的差异（本线自算的硬证据）

- `git show --stat b37be81`：只改 2 个源文件（`coordinator.ts` +4/-1、`workspace-workers.ts` +6/-1）与 2 个测试。
- 产物检索：RC2 的 `dist/workspace-workers.js` 含 `WORKSPACE_CONFLICT` 1 处，`dist/coordinator.js` 含 `ATTEMPT_LIMIT` 1 处；**RC1 的 `dist/workspace-workers.js` 含 `WORKSPACE_CONFLICT` 0 处、`dist/coordinator.js` 含 `ATTEMPT_LIMIT` 0 处**。（RC1 的 `dist/coordinator.js` 另有 `WORKSPACE_CONFLICT` 2 处，是既有的错误码映射字符串，不是本轮的抛出点；拿「RC1 coordinator 里搜到该词」当反证会是误读。）
- 因此：**RC1 是真实验收时被执行的那份代码，它确实还没有这两个稳定码；RC2 有，但只经过合成/重放验证。**

---

## 5. 真实任务、异常覆盖、路由与归因

### 5.1 两单真实派工（源：`LIVE_ACCEPTANCE_SUMMARY.md:150-214`、`:347-359`；本线未打开原始证据文件）

| 项 | DSH 单 | WorkBuddy 单 |
|---|---|---|
| taskId | `d1-dsh-5f82573e-b87a-4ff1-acd9-ec8d541243f5` | `d1-workbuddy-2fec4908-eb45-45eb-8852-8e8411b0cacf` |
| 模型 / 推理 | `deepseek-v4.1-flash` / `high` | `deepseek-v4.1-flash-sg` / `null`（目录不提供 reasoningEfforts） |
| 费用观测 | `credits x0.00`（观测值） | `credits x0.11`（**相对倍率，不是金额**） |
| attemptId | `run-4fc382d9-daa5-46d8-bc9a-e4ff17f8c532` | `run-bc7288ad-bedb-4593-852d-551e91e6a1e3` |
| 原生停止 | — | `native_idle`（end_turn，06:14:07.761Z） |
| reviewId | `review-684133fe-a47d-46c2-becf-d919c00f18e2` | `review-a7598513-0642-4caf-bc29-9d66886ee3e9` |
| 终态 | accepted 05:55:54.478Z | accepted 06:15:38.488Z |

两单在**同一天、同一台机器、同一份 RC1 代码**上通过；异机 0 个；两个执行器未在同一 workspace 上并跑（容量 1 强制串行）。

### 5.2 异常覆盖（真实 5 / 10，合成 12 类全通过）

| 卡 | 结果 | 真实结论 |
|---|---|---|
| R7 同 operationId 换执行器 | 通过 | `OPERATION_CONFLICT`，tasks/attempts/send 未增 |
| R4 领取后取消 | 通过 | claim 06:31:09.696 → 取消 .710 → `native_idle` 06:31:11.782 → `task_closed` .809；工作区 `clamp.mjs` 仍是基线 `A865956F…` |
| R8 预算耗尽 | 通过 | `maxAttempts=1` 返工被拒；折入停止证据后被接受（revision `hb6o85fI5h8u3uyf`） |
| R6 错会话归属 | **通过（暴露缺陷）** | 无 code `Error` → 任务 `blocked`、`attempt_id:null`、操作 `outcome_unknown`、**容量被占**、`blocking_reason` 无因由 |
| R3 报告先到原生未停 | 通过 | 窗口 07:19:39.124 `needs_review` 且 `digest.stopped:false` → `STOP_UNCONFIRMED` → 折入停止后通过 |
| R1/R2/R5/R9/R10 | **未做** | 理由：需人为中断、会再造 `outcome_unknown`、需拖满 600 秒、需伪造历史 attempt、需故障注入 |

合成侧：12 类异常 12/12 通过（`L08_ACCEPTANCE.md:162-177`），断言落在 SQLite 状态、`runs/` 文件、操作条数、准备/观察/提示计数上。

### 5.3 真实路由与请求级归因

| 项 | 事实 | 出处 |
|---|---|---|
| 资源真实路由 | `routingVerified:false`、`basis:"gateway_observation_only"`、`attribution:"connection_only"`、`actualTaskCredits:null` | G1/G3 冒烟；`D0_...md:110`（C08） |
| 请求级归因 | 缺口 `request-attribution-1` 仍在；D6-01 只到接口面 | `STATUS_INDEX.md`、`D0_...md:114`（C12） |
| 引擎调用计数 | `calls` 恒空；`catalogRateLabel` 与 `activeReasoningSeconds` 恒 `null`；时间窗仅 UTC ISO | `gates/G1.json` openUnknowns |
| 统计空库 | `tasksRead:0`（空库如实为 0，不冒充有数据） | G1/G3 冒烟 |

**所以「真实路由已验收」与「费用可归因」都不成立**；两单的 `credits` 值只能当相对倍率/观测值引用，不能当金额或账单。

### 5.4 证据完整性（10 的三份坏文件，本线读了修复记录）

- `evidence/cards/r6/recovery-view.json`（952B）：不是 JSON，是失败 PowerShell 转录（参数未加引号 → `SyntaxError`）→ 「R6 恢复视图」这条证据原本**不成立**；已用 RC2 的 `dist/recovery-cli.js` 对**库副本**重采，两份各 4667B、`available:[]`、sha `5a4feca1…`。
- `evidence/workbuddy-models.json`（5042B，UTF-16LE）：内容合法，只是编码 → 转码为 2520B、23 模型、sha `2ebda8f8…`，内容未改。
- `evidence/get-task-1.json`（1898B）：同为失败调用转录；`workbuddy_get_task` 对 DSH 任务报 "The original DSH adapter is unavailable"、`deepseek_get_task` 报 "Unknown DeepSeek task"，**无法按原路重采** → 只给库副本投影 `get-task-1.projection.json`（8290B、`task-projection-1`、51 事件/10 操作、sha `92b4e999…`）。
- 修正口径（必须照此引用）：「DSH 单的任务详情证据」是**库内投影，不是 `get` 捕获**；派工与验收结论不受影响。

---

## 6. 许可、第三方声明与用户文档

### 6.1 项目许可：**未决，由权利人决定**

- 仓库根与 `gateway/` 下均无 `LICENSE`、`LICENSE.md`、`COPYING`、`NOTICE`、`THIRD_PARTY_NOTICES.md`（`Test-Path` 逐条 false）。
- 各线一致声明「不代签」：`L04_ACCEPTANCE.md:80-121`、`USER_ACCEPTANCE.md:86-96`、`EXTERNAL_CONDITIONS.md` E11。
- **本索引不代签任何许可文本，也不建议默认 MIT。**

### 6.2 第三方声明（已有台账，位置待权利人定）

- 网关 94 个生产依赖的许可分布见 4.2；桌面壳引用 `Microsoft.Web.WebView2` 1.0.4314.35，包内附 `WEBVIEW2-LICENSE.txt`；.NET 10 按其自身许可分发。
- 台账原始文件在 L04 证据包 `production-licenses.json`（`outputs\finish-l04-20261105\evidence\licenses\`，本线未打开）。

### 6.3 最终用户文档、已知限制、恢复步骤

| 文档 | 内容 | 状态 |
|---|---|---|
| `gateway/docs/INSTALL_WINDOWS.md`（187 行） | 准备、先预览后安装、依赖自检、连接 Codex、首次真实连接、升级/回退/卸载 | 可用；但 176 行的恢复说明链接是坏的（K1） |
| `gateway/RESTORE.md`（被两个文档引用） | 保存内容、恢复程序、版本回退与任务库结构 | **真文件在这里**，不在 `gateway/docs/` |
| `gateway/docs/DEPLOYMENT_ACCEPTANCE.md`（106 行） | 异机可审查部署模板：部署步骤、版本核对、备份与回退、依赖清单 | 可用（模板，不是已执行结论） |
| `gateway/docs/USER_ACCEPTANCE.md:60-96` | v0.7.1 发行准备、产物种类、安装说明摘要、已知限制、第三方与许可 | 可用 |
| `gateway/docs/RELEASE_NOTES.md`、`WORKBENCH.md`、`OPERATION_RECOVERY.md` | 版本说明、面板、恢复 | 存在（未逐字复核） |

已知限制里必须被用户看到的五条（`USER_ACCEPTANCE.md:78-84`）：未签名；源码 ZIP 不是安装器；安装器只写四类文件、不派工、不重启 WorkBuddy、不注册服务；本版安装/升级/回退/卸载验证都在隔离目录与合成夹具上完成；任务库结构更新后旧版可能读不了，且**不提供「删库恢复」**。

### 6.4 功能入口启用状态（真实与合成分开）

| 入口 | 状态 | 证据 |
|---|---|---|
| 任务面板 HTTP（只读） | 合成冒烟 200；真实未在最终候选上验证 | G1/G3 冒烟 9–13 路由 |
| 模板 / 通知 / 导出预览 | 只读 200；`POST` 405 `allow: GET, HEAD` | G2/G3 冒烟 |
| 桌面命令 `recommend` | 已接线 + C# 5 例 + 宿主探针 exit 0；**真实桌面壳 0 进程** | `gates/G2.json` |
| 自动化政策 | CLI 可建政策（`policy-mDHBfEKa…` active）；`armed:false`、`dispatcherWired:false`、`writeEntry:"local_cli_only"`；`execute` → `AUTOMATION_NOT_ARMED`；重启后仍 `armed:false` | `gates/G3.json` |
| 政策建议模板 | 只能保存，激活返回 `policy_activation_unsupported` | `L08_ACCEPTANCE.md:131` |
| DSH 执行器 | RC1 安装时 `WORKBUDDY_DSH_ENABLED=1` 手工追加；两单之一走 DSH | `LIVE_ACCEPTANCE_SUMMARY.md:142` |
| 聊天 MCP | **未合并**片段；本轮真实派工走 `scripts\workbuddy-call.mjs` | `LIVE_ACCEPTANCE_SUMMARY.md:397` |

---

## 7. 远端、PR、CI 与分支保护（如实：全部未办）

| 项 | 事实 | 判定 |
|---|---|---|
| 远端 | `origin = https://github.com/shenmiqinvzi/workbuddy-executor-community.git`（fetch/push 均配置） | 存在 |
| 本分支 upstream | `git rev-parse '@{u}'` → `fatal: no upstream configured for branch 'docs/final-review'` | **未推送** |
| 标签 | `git tag` 计数 0 | 无标签 |
| `main` | 本地 `main = 7c27953`，`[origin/main: behind 38]` | 本批工作未合 main |
| PR | 无（本分支未推送，任何 PR 链接都会是伪造） | 未办 |
| CI 工作流文件 | `.github/workflows/windows-gateway.yml`（`on: pull_request`、`push: branches:[main]`、`workflow_dispatch`）、`.github/workflows/posix-bridge.yml`（同触发器） | 存在 |
| 这些工作流是否跑过本批提交 | 未推送、无 PR → **不可能跑过**；`workflow_dispatch` 需远端权限，本线没有 | 未办，也不得声称成功 |
| 分支保护 | 无远端 API 访问、无仓库设置证据 | **未核验**（不可据此宣称有或没有） |
| 干净构建校验 | 本地 `verify-release` 694/694 匹配（RC2） | 成立（仅包内一致性） |

**结论**：D7-04 的远端条件（对应最终 HEAD 的 CI、分支保护）在本地不可能成立；如果把「CI 绿」写进交付说明，就是伪造。远端步骤清单见 §12。

---

## 8. 发行范围、T7D 补验与分期候选

### 8.1 用户已经实际做过的决定（有记录的三条 + 两条口径）

1. R6 留下的 `blocked` 任务：**按 T7D 口径原样保留**（2026-11-06 15:30，`LIVE_ACCEPTANCE_SUMMARY.md:394`）。
2. `config.toml` 本轮**不合并**新 MCP 片段（15:33，同上 `:397`）。
3. 网关自登记的常驻服务：**保留**，未执行 `service-cli uninstall`（15:30，`:398`）。
4. 授权跑了 R7/R4/R8/R6/R3 五张真实异常卡；未授权 R1/R2/R5/R9/R10。
5. 两单派工前由用户当场选择模型与推理档（AGENTS.md 要求），WorkBuddy 侧选 `deepseek-v4.1-flash-sg` / `reasoningEffort:null`。

### 8.2 仍然未决定（阻塞正式交付）

| 待决定项 | 为什么必须由用户决定 | 出处 |
|---|---|---|
| 正式发行范围（内部预览 / 受控手动分期 / 完整愿景） | 原门槛不能由开发线自行 N/A | `D0_...md:149-159` |
| 原 T7D 补验是否成立 | 新样本不能自动改写旧未知任务状态，需用户明确决定 | 同上 `:159`；`T7D_P0_1_ORIGINAL_TASK_DECISION.md` |
| 项目许可文本与第三方声明位置 | 权利人事项，不代签 | §6.1 |
| 是否在 RC2 上做真实重装 + 一单派工 | 才可写「RC2 已真实验收」；需改安装根与一次真实模型调用 | `RC2_REVERIFY_10.md`（见 K5） |
| 是否补 R1/R2/R5/R9/R10 | 会再造 `outcome_unknown`、占容量、需故障注入 | `LIVE_ACCEPTANCE_SUMMARY.md:298-308` |
| 桌面壳是否本轮验收 | 需 GUI 会话 + 调试端口；本会话拉不起 GUI 进程 | `EXTERNAL_CONDITIONS.md` E08/E16 |

### 8.3 完整愿景不得自动缩水

D4（推荐）、D5（自动政策）、D6（统计/模板/导出）与真实资源、异机、发行条件**仍在范围内**；`MASTER_PLAN.md:63` 明确「不能缩范围自动豁免完整愿景」。任何「已完成交付」的表述若把这些标成可选，都属于擅自缩范围。

### 8.4 分期候选（**不是已选方案**，仅备选项）

`D0_...md:153-157` 给了三档：内部开发预览 / 受控手动版分期发行 / 完整愿景发行。若用户选第二档，仍必须先满足：双端 D1、对应 V/C/F 的 P0、安装回退、原 T7D 判定、最终审查与 CI、适用异机条件，且未交付入口要关闭或标明不可用。**本索引不推荐任何一档。**

---

## 9. 矛盾（文档与事实不符，含双方出处）

> 处理原则：只记录，不改别人的文件；修复建议各自归属到对应线。

**K1｜`INSTALL_WINDOWS.md` 的恢复说明链接是坏的**
- 一方：`gateway/docs/INSTALL_WINDOWS.md:176` 写「按[恢复说明](RESTORE.md)核对」——相对路径解析为 `gateway/docs/RESTORE.md`。
- 另一方：`Test-Path gateway\docs\RESTORE.md` = False；真文件是 `gateway/RESTORE.md`（`git ls-files gateway/RESTORE.md` 有记录）；同仓库的 `gateway/docs/DEPLOYMENT_ACCEPTANCE.md:86` 用的是 `../RESTORE.md`，是对的。
- 判定：链接不可打开，违反任务书「检查链接/命令/索引可打开」。影响：用户在 schema 不兼容时找不到恢复说明。修复属文档级（`INSTALL_WINDOWS.md` 一行），本线不改。

**K2｜`gates/G3-fix.json` 的代码基线字段指向修复前的提交**
- 一方：`gates/G3-fix.json` `codeBaseCommit=91af89ee…`、`codeBaseTree=4c61792a…`。
- 另一方：该 gate 归档的 RC2 由修复后的代码打包；`git show --stat b37be81` 证明 `91af89e` 之后还有 `b37be81`（改 `gateway/src/coordinator.ts`、`gateway/src/workspace-workers.ts`）与 `06d52b1`（只改文档）；二进制证据：RC2 `dist` 有 `WORKSPACE_CONFLICT`/`ATTEMPT_LIMIT`，`91af89e` 对应的 RC1 `dist` 没有。
- 判定：无法仅凭 gate 的 `codeBaseCommit` 复算出 RC2 的输入树。这与 `docs/parallel/DELIVERY_FINISH_20261105/09_INTEGRATION_GATES.md` 要求回执带 baseCommit/commit/tree 的口径不符。建议后续 gate 把「打包输入树」单列一个字段（如 `packageSourceCommit`），不要复用 `codeBaseCommit`。

**K3｜`STATUS_INDEX.md` 仍写「11 交付检查 = 未开始」**
- 一方：`docs/delivery/STATUS_INDEX.md` 阶段表最后一行。
- 另一方：本文件（`docs/delivery/FINAL_REVIEW_INDEX.md`）就是 11 的产物，已随本次提交入库。
- 判定：时间差造成的状态未同步。本线无权改 STATUS_INDEX；需 09/集成人在下一次同步时补一行，否则「唯一现状来源」会与仓库内容冲突。

**K4｜`LIVE_ACCEPTANCE_SUMMARY.md` / `LIVE_ACCEPTANCE_EVIDENCE_INDEX.md` 与被修复的三份证据没有互相回链**
- 一方：`LIVE_ACCEPTANCE_EVIDENCE_INDEX.md:70` 把 `workbuddy-models.json`（5042B）当模型目录证据列出；`:173` 把 `recovery-view.json` 当 R6 的「关键文件」；`LIVE_EVIDENCE_REPAIR.md:9-14` 则判定前者是 UTF-16LE、后者是失败 PowerShell 转录。
- 另一方：`docs/delivery/LIVE_EVIDENCE_REPAIR.md:17-49` 已给出重采/转码/投影三份替代产物与哈希。
- 判定：证据索引里那两行按原样引用会指向不可解析文件。10 的报告正文（`:394`）已按重采结论描述行为，缺口只在索引层。建议索引加一行「见 LIVE_EVIDENCE_REPAIR.md」；本线不改。

**K5｜`11_PROMPT.md` 要求读的 `gateway/docs/RESTORE.md` 不存在**
- 一方：`E:\javaproject\outputs\finish-integration-20261105\G3\prompts\11_PROMPT.md` 必读清单。
- 另一方：文件真身在 `gateway/RESTORE.md`。
- 判定：提示词与仓库不符，但不影响本索引完成（我读的是真文件）。

**K6｜同一份 gate 里「10 真实验收已完成」与「RC2 未真实验收」并存，容易被读成「最终候选已验收」**
- 一方：`docs/delivery/STATUS_INDEX.md` 阶段表「10 真实验收 已完成」。
- 另一方：`gates/G3-fix.json` `status.liveVerifiedForRc1=true`、`rc2LiveVerified=false`，`nextGate="10（RC2 重验）→ 11"`。
- 判定：两者不冲突，但**必须成对引用**；单独引用「10 已完成」会误导。本索引 §2.3、§5.1 已按成对口径写。

**K7｜「解包候选目录」不是纯净解包**
- 一方：任务书与 11 提示词说「解包在 `outputs\finish-integration-20261105\G3-fix\candidate\codex-workbuddy-gateway-v0.7.1`」，暗示这是包的展开。
- 另一方：实测该目录 4099 个文件（排除 `node_modules` 后 696 个），说明合成为冒烟曾在此 `npm ci`，目录里带了依赖。
- 判定：审阅者若直接在这个目录跑「包内自检」，结论会被依赖污染掩盖（例如「缺 zod」这类判断会失真）。复现应解压到全新空目录（命令见 §11）。

**K8｜`I-integration` 工作树有未提交的 `RC2_REVERIFY_10.md`，且不在任何提交里**
- 一方：`git -C …\I-integration status --porcelain` → `?? docs/delivery/RC2_REVERIFY_10.md`（3432B）。
- 另一方：该文件不在 HEAD `06d52b1` 的树里（F11 分支也没有），`STATUS_INDEX.md` 与 `gates/G3-fix.json` 都未提及它；而 `STATUS_INDEX.md` 自称「唯一现状来源」。
- 判定：一份重要的「RC2 重验清单（给 10 线）」处于未入账状态。它本身内容与 `G3-fix.json` 的 `rc2Replay`/`evidenceRepair` 一致，因此不构成事实冲突，但构成**账目缺口**。本线不复制、不代提交。

---

## 10. 不成立与未核验

### 10.1 判定为「不成立」的表述

| # | 表述 | 反证 |
|---|---|---|
| 1 | 「53 项通过」/「可发布」/「已验收」 | 53 项无一整项通过；`L08_ACCEPTANCE.md:237-240` 明写不得据此下此结论；`gates/G3-fix.json` `releaseReady=false` |
| 2 | 「RC2 已真实验收」 | `rc2LiveVerified=false`；RC2 只做过 `dist` 级重放与合成检查；真实验收用的是 RC1 |
| 3 | 「R6/R8 缺陷已修复并已验证」 | 码已改、RC2 产物含稳定码（本线自算）、合成重放通过；但真实环境未重跑，且 R6 的 `outcome_unknown` + 占容量仍存在 |
| 4 | 「全量测试全绿（当前）」 | 最近一次全量为 `1282/1269/1 fail`（`command-cleanup`）；`run-worker` EPERM 属历史偶发、根因未定位 |
| 5 | 「异机验收通过」/「远端 CI 绿」/「已建 PR」/「有分支保护」 | 异机 0 台；未推送；无 PR；无远端设置证据 |
| 6 | 「许可已声明」/「包已签名」 | 无 `LICENSE`；文档明述未签名 |
| 7 | 「真实路由已验证」/「费用可归因」 | `routingVerified:false`、`actualTaskCredits:null`、`request-attribution-1` 缺口、`credits` 是倍率不是金额 |
| 8 | 「10 报告里的 DSH 任务详情是 `get` 捕获」 | `LIVE_EVIDENCE_REPAIR.md:36-49`：只能给库副本投影 |
| 9 | 「`gateway/docs` 内链接全部可打开」 | K1 |
| 10 | 「包可以直接运行」 | `preview` exit 1 `safeToApply=false`；`dependencies` exit 1 `blocksInstall=true`；需 `npm ci` 与三类运行时 |
| 11 | 「桌面壳已验证」 | 真实场景 0 个 Workbench 进程；C# 5 例是策略级单元，不是窗口验收 |
| 12 | 「由 Codex 独立验收通过」 | 任务书禁止代签；索引只是交给 Codex 的输入 |

### 10.2 未核验清单（有记载、本线未独立复算）

| 对象 | 未核验的原因 | 需要谁去核 |
|---|---|---|
| 真实安装根 `E:\javaproject\workbuddy-install\gateway-v0.7.1-rc1` 的全部落盘物与哈希 | 任务书要求不碰真实安装根 | 10 或用户 |
| `outputs\finish-live-20261106` 的 284 个原始文件、两单 review JSON、容量行 | 未打开（只读了 10 与集成人的结论文档） | 独立复核人 |
| `G3-probe\verify-live10.mjs` 与 `live10-verify.json` | 同上 | 同上 |
| 真实两个 `codeHash`（`ac2a673f…`）与技能安装位 6 文件 | 未进安装根与 `CODEX_HOME` | 同上 |
| 94 个生产依赖的许可分布 | 采信 L04 台账 | 发行人复核 |
| `npm test` / `desktop:test` / `dotnet build` 的任何一次当前重跑 | 任务书禁止跑全量与构建 | 集成人/09 |
| 远端仓库状态、CI 运行、分支保护 | 无网络与 API 权限 | 用户 |
| 三份已修复证据产物（`r6-recovery-*.json`、`transcoded/*.json`、`*.projection.json`）的字节 | 未打开，只引用其中记录的哈希 | 独立复核人 |
| 历史 T6/T7B/T7C 的真机结论 | 属历史证据，本线未重跑 | 按原文档引用即可，不得改挂候选 |

---

## 11. 最小复现检查步骤（只读，任何人可照抄）

```powershell
# 0) 定位与身份（不写任何东西）
cd E:\javaproject\workbuddy-finish\F11-final
git rev-parse HEAD           # 期望 06d52b1e3c7d6e9221d618b42737e16cbf91f101
git status --porcelain       # 期望本文件之外无其它改动
git cat-file -p HEAD | Select-Object -First 1   # 期望 tree f2f6553d2bfdb0b49466b8c90d9989f1720fe399
git log --oneline -6

# 1) 三个包的校验和（期望值见本文 §0.2）
Get-FileHash 'E:\javaproject\workbuddy-finish\I-integration\gateway\outputs\release\codex-workbuddy-gateway-v0.7.1.zip' -Algorithm SHA256
Get-FileHash 'E:\javaproject\outputs\finish-integration-20261105\G3-fix\release-rc1\codex-workbuddy-gateway-v0.7.1.zip' -Algorithm SHA256

# 2) 解到全新空目录再自检（不要用已被 npm ci 污染的 G3-fix\candidate 目录）
$dst='D:\review\rc2-20261106'
Expand-Archive -Path 'E:\javaproject\workbuddy-finish\I-integration\gateway\outputs\release\codex-workbuddy-gateway-v0.7.1.zip' -DestinationPath $dst -Force
cd "$dst\codex-workbuddy-gateway-v0.7.1"
node scripts\verify-release.mjs      # 期望 {"version":"0.7.1","verifiedFiles":694,"hashesMatch":true}

# 3) 修复是否在产物里（字符串检索，不需要运行网关）
Select-String -Path .\dist\workspace-workers.js -Pattern 'WORKSPACE_CONFLICT'
Select-String -Path .\dist\coordinator.js        -Pattern 'ATTEMPT_LIMIT'

# 4) 两个稳定码的重放（只用临时目录里的合成 runs 与合成库，禁止指向真实库）
node 'E:\javaproject\outputs\finish-integration-20261105\G3-fix\probe\probe-rc2-replay.mjs' "$dst\codex-workbuddy-gateway-v0.7.1\dist"

# 5) 只读核对文档索引是否自洽
Select-String -Path .\docs\delivery\STATUS_INDEX.md -Pattern '11 交付检查'
Test-Path .\gateway\docs\RESTORE.md   # 期望 False（真文件在 .\gateway\RESTORE.md）
```

```powershell
# 6) 若要复核 R6 的历史记录（只读库副本，切勿指向真实库）
$work='E:\javaproject\outputs\finish-integration-20261105\G3-fix\evidence-repair'
$env:WORKBUDDY_DB_FILE="$work\db\tasks.sqlite"
$env:WORKBUDDY_RUNS_DIR="$work\runs"
node "$dst\codex-workbuddy-gateway-v0.7.1\dist\recovery-cli.js" show card-r6-foreign-session-1793948211334
# 期望 exit 0、available:[]、capacity 段仍显示占用
```

**不要做**：不要用真实库跑 `recovery-cli` 的 `reconcile`/`close`（写操作会动 R6 的容量）；不要把 `WORKBUDDY_DB_FILE` 指到安装根；不要为「让证据好看」重写 `evidence/` 原始文件；不要把 RC1 的证据算到 RC2 头上。

---

## 12. 给 10 与发行人的下一步

| # | 动作 | 谁 | 代价 | 需要什么 | 完成后可改哪一行状态 |
|---|---|---|---|---|---|
| 1 | 在 RC2 上真实重装到**新空目录** + 一单派工 | 10 | 改安装根 + 一次真实模型调用与费用 | 用户明确授权；派工前按 AGENTS 展示执行器/来源/模型/推理/费用 | `rc2LiveVerified` |
| 2 | 补 R1/R2/R5/R9/R10 五张卡 | 10 | 会再造 `outcome_unknown` 并占容量 | 用户确认可制造不确定态与容量被占后果 | D1-04、V02/V05/V07、C17 |
| 3 | 真实升级/卸载/回退（在隔离真实目录，不动 RC1） | 10 | 需一次全新安装 + 两次切换 | 授权；停止证明前置 | D7-01、V13、C16 |
| 4 | 第二台物理 Windows 全流程 | 10 | 需机器与操作者 | 用户提供机器 | D7-02、V14/V15 |
| 5 | 定许可文本与第三方声明位置 | 发行人 | 无技术成本 | 权利人决定 | D7-03、§6 全部 |
| 6 | 推送分支、开 PR、让 CI 跑对应 SHA | 用户/09 | 需远端写权限 | 授权 push（本线未做） | D7-04、§7 |
| 7 | 请求 `request-attribution-1`（请求级归因）与真实账号池 | 用户/03 | 需真实账号与额度 | 授权 | D3-01/D3-02、C08/C12 |
| 8 | 修 K1 的坏链接、给 STATUS_INDEX 补 11 一行、索引层回链 LIVE_EVIDENCE_REPAIR | 09 | 文档级 | 无 | K1/K3/K4 |
| 9 | 决定是否把 `RC2_REVERIFY_10.md` 入库 | 09 | 文档级 | 无 | K8 |
| 10 | 把本索引交 Codex 做独立最终检查 | 用户 | 外部审查 | 索引在分支上可读 | 本文件 |

**发行口径建议（仅供参考，决定权在用户）**：在 §8.2 的六项未决定之前，对外只能声明「内部预览候选，源码与合成候选可复核，真实证据限于 RC1 单机两单 + 五张卡」，不能使用「已验收」「可发布」「生产就绪」。

---

## 13. 固定回执

```
本线:            第 11 条线（交付检查与最终复核），独立于集成人
分支:            docs/final-review
HEAD:            06d52b1e3c7d6e9221d618b42737e16cbf91f101
HEAD 树对象:     f2f6553d2bfdb0b49466b8c90d9989f1720fe399
产出文件:        docs/delivery/FINAL_REVIEW_INDEX.md
本文件提交哈希:  见下方说明（自引用哈希不写入自身，与 gates/G3-fix.json 的 gateRecord.commit=null 同口径）
                 查询命令: git log -1 --format=%H -- docs/delivery/FINAL_REVIEW_INDEX.md
未核验项数量:    9 类对象（§10.2 表 9 行；其中真实安装根、真实原始证据、真实两单 review、远端状态各含多个文件）
阻塞项数量:      6 项（§8.2 表 6 行：发行范围、T7D 补验判定、许可文本、RC2 真实重验授权、五张异常卡授权、桌面壳验收）
矛盾条目:        8 条（K1–K8）
七类交付状态:    开发完成=是（八线 implemented=true）; 合成验收=是（G3 1281/1269/0；G3-fix 1282/1269/1 fail 待复跑）;
                 真实验收=仅 RC1 同机（2 单 + 5 卡）; 异机验证=否（0 台）; 远端 CI=否（未推送、无 PR、无保护证据）;
                 许可与签名=未决（无 LICENSE、未签名）; 部署与发行=否
边界声明:        未推送、未合 main、未打标签、未发布、未部署；未改任何代码/测试/包/配置；
                 未运行 npm test / 构建 / npm ci；未碰真实安装根、真实任务库与真实派工；
                 未替 Codex 签署「已由 Codex 验收」；正式交付状态维持「未完成」
```

**为什么提交哈希不写进文件**：本文件一旦写入自身 SHA，SHA 就会改变（自引用悖论）。仓库既有做法相同（`gates/G3-fix.json` 的 `gateRecord.commit` 为 `null` 并注明哈希存放在 `G3_FIX_RECEIPT.md`）。本文件的 SHA 由本次提交记录在 Git 历史中，并用上面的 `git log -1` 命令取回。

---

## 14. 复核轮 R1–R4 的修复登记（2026-11-06，集成人）

§0–§13 描述的是 `06d52b1` 时的状态。此后 Codex 独立复核给出 R1–R4 四条结论，本轮在独立工作树
`E:\javaproject\workbuddy-finish\R-review-fixes`（分支 `fix/delivery-review-r1-r4`，基线 `218dfe9`）修复。
本文件只登记「改了什么、验证到什么程度」，不改写 §0–§13 的历史结论，也不把 RC1 的真实证据移挂到新候选。

### 14.1 四条结论与处置

| 编号 | 原结论 | 处置 | 证据 |
| --- | --- | --- | --- |
| R1（P0） | 拒绝后被 continue 的任务，rework/queue 已跨原生边界，`neverDispatched` 仍为真，取消直接释放容量并跳过原取消请求 | 已修：判定改为整任务 | `gateway/src/operation-admission.ts`、`gateway/src/coordinator.ts`；`gateway/test/desktop-queue.test.ts` 5 例 |
| R2（P1） | `SECRET_VALUE` 只匹配字符串开头，句子/HTTP 头上下文绕过；note/definition 自由文本仍可能带凭据 | 已修：任意位置扫描 + 先脱敏再截断 | `gateway/src/delivery-export.ts`；`gateway/test/delivery-export.test.ts` 3 例 |
| R3（P1） | CLI 组合根只注入 `{armed, probe}`，没有 `send`，`execute` 在读决策前就报「No guarded dispatcher is wired」 | 已修：CLI 接到共享派工服务 | `gateway/src/automation-cli.ts`；`gateway/test/automation-cli.test.ts` 2 例 |
| R4（P2） | 本索引仍以 `06d52b1`/RC2 为对象，SHA 与安装状态过期 | 已修：本节 + §0 的时效声明 | 本文件 |

### 14.2 R1：容量判定看整条原任务

- `neverDispatched(taskId, attemptId)` 现在要求：容量占用者属于该任务；任务的当前 attempt 与传入一致；
  **该任务的全部持久操作**都不在 `reserved/effect_started/outcome_unknown`，且都没有
  `effectStartedAt`/`dispatchEnteredAt`/`preparationEnteredAt`；至少存在一条 `send` 操作与当前 attempt 的
  `attempt_queued` 事件（缺记录按「未证明」处理，不按「干净」处理）；没有 `native_claimed`、`rework_requested`，
  也没有任何 `task_closed`。
- `coordinator.requestCancellation` 在数据库判定之外再加一次 journal 判定
  （`claim.json`/`request.json`/`model-ready.json`/`worker-context.json` 任一存在即否决；`state.json` 必须是
  `blocked` 且无 `pid`；解析失败即否决）。
- 未派工且证据完整的首次拒绝，取消仍是关闭并释放容量；真实领取之后，取消走原路径：写 `cancel.json`、
  `remoteStopped:false`、`executionState:"stop_unconfirmed"`，容量保留到原生停止可证。
- 组合回归覆盖：拒绝→continue→claim（不得关闭）；缺记录（不得关闭）；`outcome_unknown`（不得关闭）；
  journal 已有 claim（不得关闭）；合法首次拒绝（仍可关闭）。

### 14.3 R2：自由文本里的凭据

- 扫描器改为在字符串任意位置匹配：Authorization / Proxy-Authorization 头（含多行）、裸 `Bearer|Basic`、
  PEM 私钥块、`sk-`/`gh*_`/`xox*`/`AKIA` 前缀、JWT、URL 里的 `user:password@`、以及 `token=`/`password:` 这类内联键值。
  命中时只替换凭据本身，句子其余部分保留，便于复核读懂上下文。
- `clip()` 先脱敏再截断，避免凭据被截断成前缀漏出；截断点落在占位符中间时保留完整 `[redacted]`。
- 回归覆盖：审查 note 里的多行混合凭据（导出字节不含假凭据、普通句子仍可读）；截断边界（不残留 `sk-live`
  等前缀）；`redactSecrets` 对内联键值与头的处理。

### 14.4 R3：CLI 是真实组合根

- `runAutomationCli` 构造 `TaskApplicationService` 时注入 `send: input => service.send(input)`，自动派工因此进入
  与手工派工同一个受信入口（方案/政策/容量/原生身份/范围/费用重校验都在原服务内）。
- 语义不变：默认不 arm（需要 `--enable-dispatch`），安装级 `enabled` 默认关闭（需要 `enable`）；MCP/HTTP 仍没有
  自动写入口。`describe()` 现在如实报告 `dispatcherWired:true`（此前 CLI 恒为 false）。
- CLI 级测试（`test/automation-cli.test.ts`）用合成安装跑真实入口：未 arm 时 `AUTOMATION_NOT_ARMED`；arm 但未
  enable 时 `AUTOMATION_NOT_ENABLED`；enable 且 arm 后读到 `DECISION_NOT_FOUND` —— 说明它确实进入共享服务，
  而不是停在「没有接线」的拒绝上。

### 14.5 仍然开着的项

- F-CONTRACT-1（任务正文允许新增文件与随后 legacy 说明的冲突）本轮未处理。
- 第二台机、R1/R2/R5/R9/R10 五张异常卡、真实窗口/读屏验收未做。
- P0-1 仍按 T7D 原样保留（不关闭、不重派、不释放）。
- RC4 只有在真实重装并派工后才能宣称真实验收；本轮交付的是源码 + 合成候选。

---

## 收口轮回执

| 项 | 值 |
| --- | --- |
| 分支 / 工作树 | `fix/delivery-review-r1-r4` / `E:\javaproject\workbuddy-finish\R-review-fixes` |
| 本轮提交 | 由外部回执 `E:\javaproject\outputs\finish-integration-20261105\closeout\CLOSEOUT_RECEIPT.md` 记录（提交不能包含自身哈希） |
| 提交内容 | C4-1 与同类存活判定、R3 正向接线、R2 边界、F-CONTRACT-1 文档与措辞、打包新鲜度守卫、索引/进度/矩阵增量 |
| 候选 | RC6，696 个受管文件，sha256 `c9f724d4888da5ed2566b464c4b85745693d7dd3b600fed1f622b8f3a10338ff` |
| 已验证 | 构建、类型、完整后端、workbench、桌面策略、解包自检、全部候选工具、三个缺陷探针 |
| 未验证 | 安装、真实派工、异机、远端 CI、真实窗口 UI、许可与发行 |
| 下一步 | 用户在 `docs/delivery/EXTERNAL_DECISIONS.md` 逐项选择；之后一次 Codex 复核本分支与 RC6 |

一句话：**源码与合成候选可以复核；真实环境仍停在 RC2；RC6 没有进过真实环境，也没有部署或发行。**
