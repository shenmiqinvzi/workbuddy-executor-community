# WB37 · 同源网关 / 桌面 / 技能配对包

最终产物目录 `E:\javaproject\outputs\executor-plan-20261111\release-wb40\`。
`release-wb37` / `-b` / `-c` / `-d` / `-wb38` / `-wb39` 是过程中的早期构建，保留作对照；只有 `release-wb40`
与最终源码树一致。所有校验和均可复算，没有手改产物。

> 为什么还有 wb39/wb40：演练中发现**发布包漏装维护脚本**（`scripts/sync-skill.mjs`、
> `scripts/verify-pairing.mjs`、`scripts/check-acceptance-matrix.mjs` 只存在于源码树），而
> `package.json` 的 `skill:check` / `release:pairing` / `acceptance:check` 又指向它们 ——
> 装好的包跑不了自己文档里写的自检命令。修法是把三个脚本加进 `scripts/package.mjs` 的
> `scripts` 允许清单；wb39 是加上它们后的包，wb40 在 wb39 基础上再修掉「包内没有仓库根，
> `skill:check` 误报 bundled/codex 漂移」这一条（`sourceMode: "bundled"`）。

## 1. 产物与校验和

| 产物 | 文件 | 字节 | sha256 |
| --- | --- | --- | --- |
| 网关 | `codex-workbuddy-gateway-v0.7.1.zip` | 2614018 | `3897d4e2163bf3abbf6b6e1209d44eda34fd73e5890fbc23b0d6416174849a0d`（786 条目） |
| 桌面预览 | `desktop\workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip` | 3041940 | `fb03b905882f1d1f34f75cb72d2f8599b860b5785ea1397135b2130311a9c386`（795 条目） |
| 技能（Codex） | `workbuddy-executor-v0.7.1.zip` | 29367 | `2b39d81cc603219a2938b4cb234c708f5892bb76bf9fed8aaa211d798ba2f8c4`（6 文件） |
| 技能（DSH） | `deepseek-executor-v0.7.1.zip` | 4249 | `22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13`（2 文件） |
| 网关清单 | `codex-workbuddy-gateway-v0.7.1.manifest.json` | 127038 | `version=0.7.1`，`videoAcceptance=pending_user_verification` |
| 配对报告 | `E:\javaproject\outputs\executor-plan-20261111\wb40-pairing.json` | — | `ok: true` |
| 候选预检 | `E:\javaproject\outputs\executor-plan-20261111\wb40-candidate-check.json` | — | `ok: true`，785 files，`problems: []` |

每个 ZIP 旁都有 `.sha256` 边车文件；`verify-pairing.mjs` 会重算并与边车比对，边车不符即判失败。

## 2. 配对（同源）结论

`node scripts/verify-pairing.mjs <gateway.zip> <desktop.zip>`：

| 项 | 值 |
| --- | --- |
| 共用文件（去包装后同路径） | **785**，全部逐字节相同 |
| 内容不一致 | **0** |
| 清单互认条目 | **785**，逐个 `sha256`+`bytes` 相同，分歧 **0** |
| 仅网关有 | 0 |
| 仅桌面有 | 9：`desktop/app/` 8 个编译产物（exe/dll/deps/runtimeconfig/WebView2 运行库与许可）+ `PREVIEW-START-HERE.md` |
| 版本互认 | 网关 `0.7.1` / 桌面 `0.7.1-t7d-desktop-preview`，两侧 `RELEASE_MANIFEST.json` 都存在 |

去包装规则是显式的：只有首段带 `vMAJOR.MINOR.PATCH` 的包装目录才被剥掉，再剥一层 `gateway/`
（桌面包把同一套源码放在 `gateway/` 下）。`deepseek-plugin/` 这类真实目录不会被误剥——
`test/release-pairing.test.ts` 第 5 例把这条锁住。

## 3. 包内自检（本轮修掉的缺陷）

装好的候选必须能自己诊断，这条现在有实测：

| 检查 | wb37c 时代的包 | wb40 |
| --- | --- | --- |
| `node scripts/sync-skill.mjs --check --json` | 文件不存在（`MODULE_NOT_FOUND`，exit 1） | exit 0，`sourceMode: "bundled"`，`inSync: true`，`drifted: []` |
| `npm run release:pairing` | 文件不存在 | 可用（`scripts/verify-pairing.mjs` 随包发） |
| `npm run acceptance:check` | 文件不存在 | 可用（`scripts/check-acceptance-matrix.mjs` 随包发，需仓库矩阵文件；包内只发脚本） |

实测命令（隔离根 `gateway-v0.7.1-plan20261111-wb40`）：

```powershell
node scripts/bootstrap.mjs --install-root . --apply      # ok npm_ci: npm.cmd ci --omit=dev (8393ms)
node scripts/sync-skill.mjs --check --json               # exit 0，sourceMode=bundled，三份副本全 inSync
node scripts/doctor.mjs                                  # exit 0
```

`sourceMode: "bundled"` 的含义：安装位没有仓库根，只有 `skills/workbuddy-executor`，因此**包内以
bundled 副本为参照**比较安装位；有仓库根时仍是「仓库根 → bundled → 安装位」的严格链条。
`test/skill-sync.test.ts` 的 `a packaged installation compares installed copies with its bundled skill`
把这条锁住（含故意改一个字节后仍能报出 `SKILL.md` 漂移）。

## 4. 升级 / 回退演练（WB38）

在隔离安装根上做的真实替换，不是纸面步骤：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 记录升级前身份 | 读 `package.json` + 关键文件 | `version 0.7.1`，无 `scripts/sync-skill.mjs`（旧包） |
| 备份 | `Rename-Item gateway-v0.7.1-plan20261111 → …-plan20261111.rollback-wb37c` | 旧目录整棵保留 |
| 升级 | `tar -xf release-wb40\codex-workbuddy-gateway-v0.7.1.zip` | exit 0，`scripts/sync-skill.mjs`、`scripts/verify-pairing.mjs` 出现 |
| 首跑 | `bootstrap --apply` + `doctor` + `sync-skill --check` | `npm ci` 8393ms；doctor exit 0；skill:check exit 0（`sourceMode=bundled`） |
| 回退 | 删除升级树 + `Rename-Item …rollback-wb37c → 原名` | `doctor` exit 0；`sync-skill --check` 复现旧包限制（脚本不存在，exit 1） |

结论：升级与回退都可逆，且回退后系统回到升级前的确切状态（含旧包的自检缺口）——这正是
「回退不是回到更好，是回到原样」的验证。

## 5. 构建出处与可重建性

| 项 | 值 |
| --- | --- |
| 候选 | 分支 `feat/executor-plan-20261111`，基线 `0919201`，工作区未提交 |
| 快照清单 | `gateway/SNAPSHOT_MANIFEST.json` 464 文件，`node verify-snapshot.mjs` → `{"snapshotFilesVerified":464,"hashesMatch":true,"manifestCompleteness":"checked"}` |
| 版本 | `0.7.1`；桌面包 `0.7.1-t7d-desktop-preview` |
| 桌面构建 | `node scripts/build-desktop.mjs`（`dotnet restore --locked-mode` + `publish -c Release -o desktop/app`），输出 `desktop/app/`，未被链接目录替换 |

ZIP 写入器固定时间戳（DOS 时间字段常量 33）、不压缩目录条目，因此**同一输入可逐字节重建**：
`release-wb37c` 与 `release-wb37d` 两次独立打包的网关包与桌面包 sha256 各自完全相同
（`731dcd81…` / `37083679…`）。wb38/wb39/wb40 的哈希与它们不同是**预期**——中间动过
`scripts/sync-skill.mjs` 与 `scripts/package.mjs`。

## 6. 未覆盖

- **安装后运行身份**：解包 + 首跑依赖 + 包内自检已验证；常驻服务切换、卸载属 WB38 的其余部分（本轮做了升级/回退）。
- **窗口 smoke**：桌面壳能启动并给出分阶段文案，但本机会话拿不到 WebView2 控制器，面板未渲染（WB35）。
- **签名**：产物未签名，Windows 会给出未签名提示；签名状态与第三方声明属 WB41。
- **用户视频验收**：清单里如实保留 `videoAcceptance: pending_user_verification`。

## 7. 复现命令

```powershell
cd gateway
node scripts/package.mjs ..\..\..\outputs\executor-plan-20261111\release-wb40
node scripts/package-desktop.mjs ..\..\..\outputs\executor-plan-20261111\release-wb40\desktop
node scripts/verify-pairing.mjs <gateway.zip> <desktop.zip>
node scripts/candidate-installation.mjs check --package <gateway.zip> --expect-sha256 <sha256>
```
