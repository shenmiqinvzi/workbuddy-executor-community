# WB37 配对发布包（release-wb41b）

最终产物目录 `E:\javaproject\outputs\executor-plan-20261111\release-wb41b\`。

`release-wb37` / `-b` / `-c` / `-d` / `-wb38` / `-wb39` / `-wb40` 是过程中的早期构建，保留作对照；
只有 **`release-wb41b`** 是本轮（REVIEW.md R1–R5 返修后）的候选，其余包的哈希与它不同是预期结果。

> 为什么又往前一版：R2 让 readiness 的探针改走只读入口 `dist/health-entry.js`，R5 让安装包自带验收矩阵的
> 四份输入。两者都改变了包内容，因此 wb40 的配对结果与哈希不再适用；`wb41` 是第一次打出的新结构，
> `wb41b` 是在它上面修完 `createPackage` 接线后重打的同结构包（同结构重打两次哈希一致，见“可重建性”）。

## 1 产物与校验和

| 产物 | 文件 | 字节数 | SHA-256（条目数） |
| --- | --- | --- | --- |
| 网关 | `codex-workbuddy-gateway-v0.7.1.zip` | 2672611 | `f932d07f96331d3958156b48da14a8e2691e3ba6a578afae1b26173c224fc1f3`（798 条目） |
| 桌面预览 | `desktop\workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip` | 3101103 | `3b0b84dda9fe4a8e8f6e1858416b759fa6276e521f97936c92edf24274661160`（807 条目） |
| 技能（Codex） | `workbuddy-executor-v0.7.1.zip` | 29367 | `2b39d81cc603219a2938b4cb234c708f5892bb76bf9fed8aaa211d798ba2f8c4`（6 文件） |
| 技能（DSH 派生） | `deepseek-executor-v0.7.1.zip` | 4249 | `22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13`（2 文件） |
| 网关清单 | `codex-workbuddy-gateway-v0.7.1.manifest.json` | 126898 | 逐文件 `bytes` + `sha256` |
| 配对报告 | `E:\javaproject\outputs\executor-plan-20261111\wb41-pairing.json` | — | `ok: true` |
| 候选预检 | `E:\javaproject\outputs\executor-plan-20261111\wb41-candidate-check.json` | — | `ok: true`，798 files，`problems: []` |

每个 ZIP 旁都有 `.sha256` 边车；清单里 `videoAcceptance` 仍为 `pending_user_verification`。

## 2 配对结论

| 项目 | 结果 |
| --- | --- |
| 共用文件（去包装后同路径） | **798**，全部逐字节相同 |
| 必需共享清单（`REQUIRED_SHARED`） | 11 项全部存在，`missing: []` |
| 清单互认条目 | **798**，逐个 `sha256`+`bytes` 相同，分歧 **0** |
| 两包各自的 manifest 与实际条目 | 双向一致（清单列出的都在包里，包里的都在清单里） |
| 网关独有 / 桌面独有 | 0 / 9（`desktop/app/` 8 个编译产物 + `PREVIEW-START-HERE.md`，属允许例外） |
| 版本 | 网关 `0.7.1`、桌面 `0.7.1-t7d-desktop-preview`（`versionCore` 相同，允许配对） |

R4 之后 `verify-pairing` 不再只比交集：缺必需文件、缺清单、清单与条目不符、非法或重复路径、
版本不同、非预期单边文件、`.sha256` 不符都会让 `ok=false` 并 `exit 1`。
用 wb40 旧包复跑，它立刻以 `dist/health-entry.js is missing from both archives` 失败——规则生效的证据。

## 3 安装树自证（R2 + R5）

在 `E:\javaproject\outputs\executor-plan-20261111\install-wb41\codex-workbuddy-gateway-v0.7.1`：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 解包 | `tar -xf release-wb41b\codex-workbuddy-gateway-v0.7.1.zip -C install-wb41` | exit 0 |
| 首跑依赖 | `node scripts/bootstrap.mjs --install-root . --apply` | exit 0（`wb41-bootstrap.log`） |
| **包内验收自检** | `node scripts/check-acceptance-matrix.mjs` | **exit 0**：`acceptance matrix ok: 53 scenarios, 31 original tasks mapped`（`wb41-installed-acceptance.log`） |
| 技能自检 | `node scripts/sync-skill.mjs --check --json` | exit 0，`sourceMode: "bundled"`，三副本 inSync（`wb41-installed-skill-check.json`） |
| 只读诊断 | `node scripts/readiness.mjs --json`（临时库路径） | 跑完且 `tasks.sqlite` 前后均**不存在**（`wb41-installed-readiness.json`） |

只读诊断的分层结果：`toolResponsive ready`（由只读入口 `health-entry.js` 应答、带 `observer` 身份），
`nativeOnline blocked`（本机桥未连接），`projectSessionDispatchable unknown`、`candidateDeployed unknown`、
`desktopPageReady absent`——与 `WB06_READINESS_FACTS.md` 的契约一致，没有把未观测层写成 ready。

## 4 升级与回退（已在 wb40 演练，wb41b 结构相同）

| 动作 | 命令 | 观察 |
| --- | --- | --- |
| 备份 | `Rename-Item gateway-v0.7.1-plan20261111 gateway-v0.7.1-plan20261111.rollback-wb37c` | 原目录完整保留 |
| 升级 | `tar -xf release-wb40\codex-workbuddy-gateway-v0.7.1.zip` | exit 0，维护脚本随包出现 |
| 首跑 | `bootstrap --apply` / `doctor` / `sync-skill --check` | 三项均 exit 0 |
| 回退 | 删除升级树 + 把备份改回原名 | `doctor` exit 0 |
| 旧包自检 | 在回退后的旧安装上跑 `sync-skill --check` | exit 1「脚本不存在」——回退后能力确实回到旧水平 |

## 5 构建出处与可重建性

- 源码：`E:\javaproject\workbuddy-forward-20261107\R-executor-plan-20261111`，分支 `feat/executor-plan-20261111`，
  起点 `0919201`，本轮改动提交落在 `41e9595` 之后（见 `任务台账.json` 的 `delivery_commits`）。
- 打包命令（在 `gateway/` 下）：

```
node scripts/generate-snapshot-manifest.mjs
node verify-snapshot.mjs
node scripts/package.mjs ..\..\..\outputs\executor-plan-20261111\release-wb41b
node scripts/package-desktop.mjs ..\..\..\outputs\executor-plan-20261111\release-wb41b\desktop
node scripts/verify-pairing.mjs <网关 zip> <桌面 zip>
node scripts/candidate-installation.mjs check --package <网关 zip> --expect-sha256 <sha>
```

- 快照清单：`gateway/SNAPSHOT_MANIFEST.json` 467 文件，
  `node verify-snapshot.mjs` → `{"snapshotFilesVerified":467,"hashesMatch":true,"manifestCompleteness":"checked"}`。
- 可重建性：wb37c 与 wb37d 两次独立打包在源码未变时得到相同 sha256；wb41b 与 wb41 结构相同但内容不同，
  是因为中间修了 `createPackage` 的接线，属预期差异。

## 6 这证明了什么 / 不证明什么

证明了：两个包的内容一致（798 文件逐字节相同）、清单与实际条目互相吻合、必需文件齐备、
安装树里的维护脚本和验收矩阵能独立跑起来、只读诊断不会建库。

不证明了：安装后的**运行身份**切换、桌面窗口的面板渲染（WebView2 控制器在本机不可用，见
[WB35_WB38](WB35_WB38_INSTALLED_AND_WINDOW.md)）、代码签名（未签，只有 `.sha256` 与配对校验）、
视频验收（`pending_user_verification`）、CI 回执（见 [WB42](WB42_CI_READINESS.md)）。

## 7 复现步骤

1. `node scripts/generate-snapshot-manifest.mjs && node verify-snapshot.mjs`
2. `node scripts/package.mjs <out>` 与 `node scripts/package-desktop.mjs <out>\desktop`
3. `node scripts/verify-pairing.mjs <out>\codex-workbuddy-gateway-v0.7.1.zip <out>\desktop\workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip`
4. `node scripts/candidate-installation.mjs check --package <网关 zip> --expect-sha256 <sha>`
5. 解包到新目录 → `bootstrap --apply` → `check-acceptance-matrix.mjs` / `sync-skill.mjs --check` / `readiness.mjs --json`
