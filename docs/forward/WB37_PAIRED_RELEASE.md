# WB37 · 同源网关 / 桌面 / 技能配对包

本轮从 `docs/forward/WB36_FREEZE_CANDIDATE.md` 记录的候选生成配对包，最终产物目录
`E:\javaproject\outputs\executor-plan-20261111\release-wb38\`（`release-wb37` / `-b` / `-c` 是过程中的早期构建，保留作对照）。
所有校验和均可复算，没有手改产物。

> 顺序说明：源码在 WB35/WB38 演练中又修了一处（`scripts/sync-skill.mjs` 让 DSH 变体用自身源比对），
> 因此重新生成过 `gateway/SNAPSHOT_MANIFEST.json`（464 文件，`verify-snapshot.mjs` exit 0）并重新打包。
> **只有 `release-wb38` 的产物与最终源码树一致**，早期目录里的包内清单是旧的。

## 1. 产物与校验和

| 产物 | 文件 | 字节 | sha256 |
| --- | --- | --- | --- |
| 网关 | `codex-workbuddy-gateway-v0.7.1.zip` | 2604199 | `f160410a933fa3e90a659a82f188f3ad087eceb6c4338335036415256fc26631`（782 文件） |
| 桌面预览 | `desktop\workbuddy-desktop-v0.7.1-t7d-desktop-preview.zip` | 3031998 | `a9fd2342d904dbb7e91da2196bf7c774b7991ecc510b4109c6cdb7ec46bd5973`（791 文件） |
| 技能（Codex） | `workbuddy-executor-v0.7.1.zip` | 29367 | `2b39d81cc603219a2938b4cb234c708f5892bb76bf9fed8aaa211d798ba2f8c4`（6 文件） |
| 技能（DSH） | `deepseek-executor-v0.7.1.zip` | 4249 | `22909e1b0654df6eb13b3ccdcf5767ed78e094d416b891821a072c1004318d13`（2 文件） |
| 网关清单 | `codex-workbuddy-gateway-v0.7.1.manifest.json` | 126410 | `version=0.7.1`，`videoAcceptance=pending_user_verification` |
| 配对报告 | `E:\javaproject\outputs\executor-plan-20261111\wb38-pairing.json` | — | `ok: true` |
| 候选预检 | `E:\javaproject\outputs\executor-plan-20261111\wb38-candidate-check.json` | — | `ok: true`，782 files，`problems: []` |

每个 ZIP 旁都有 `.sha256` 边车文件；`verify-pairing.mjs` 会重算并与边车比对，边车不符即判失败。

## 2. 配对（同源）结论

`node scripts/verify-pairing.mjs <gateway.zip> <desktop.zip>`：

| 项 | 值 |
| --- | --- |
| 共用文件（去包装后同路径） | **782**，全部逐字节相同 |
| 内容不一致 | **0** |
| 清单互认条目 | **782**，逐个 `sha256`+`bytes` 相同，分歧 **0** |
| 仅网关有 | 0 |
| 仅桌面有 | 9：`desktop/app/` 8 个编译产物（exe/dll/deps/runtimeconfig/WebView2 运行库与许可）+ `PREVIEW-START-HERE.md` |
| 版本互认 | 网关 `0.7.1` / 桌面 `0.7.1-t7d-desktop-preview`，两侧 `RELEASE_MANIFEST.json` 都存在 |

去包装规则是显式的：只有首段带 `vMAJOR.MINOR.PATCH` 的包装目录才被剥掉，再剥一层 `gateway/`
（桌面包把同一套源码放在 `gateway/` 下）。`deepseek-plugin/` 这类真实目录不会被误剥——
`test/release-pairing.test.ts` 第 5 例把这条锁住。

## 3. 独立解包验证（不用开发期 node_modules）

1. `tar -xf codex-workbuddy-gateway-v0.7.1.zip -C wb37-unpack` → 解出 `codex-workbuddy-gateway-v0.7.1/`（`tar` exit 0）。
2. `node scripts/bootstrap.mjs --install-root . --apply` → `ok npm_ci: npm.cmd ci --omit=dev`（8462ms，来自本地缓存）。
3. 用就绪探针直接拉起解包后的真实入口：
   `probeToolStdio({gatewayRoot: <解包目录>})` →
   `{"responsive":true,"detail":"workbuddy_health answered from this process (backend desktop-queue, online false, ready false)","native":{"bridgeReady":false,…}}`

即：解包 + 首跑依赖 + 真实 MCP 入口三件事分别成立，不依赖仓库里的 `node_modules` 或 `dist`。
后续 WB38 又用 `release-wb37c` 的包在隔离根做过一次完整安装演练（doctor / deployment-check / 技能落位），
见 [WB35_WB38](WB35_WB38_INSTALLED_AND_WINDOW.md)。

## 4. 构建出处与可重建性

| 项 | 值 |
| --- | --- |
| 候选 | 分支 `feat/executor-plan-20261111`，基线 `0919201`，工作区未提交（77 条改动路径） |
| 快照清单 | `gateway/SNAPSHOT_MANIFEST.json` 464 文件，`node verify-snapshot.mjs` → `{"snapshotFilesVerified":464,"hashesMatch":true}` |
| 版本 | `0.7.1`；桌面包 `0.7.1-t7d-desktop-preview` |
| 桌面构建 | `node scripts/build-desktop.mjs`（`dotnet restore --locked-mode` + `publish -c Release -o desktop/app`），输出 `desktop/app/`，未被链接目录替换 |

ZIP 写入器固定时间戳（DOS 时间字段常量 33）、不压缩目录条目，因此**同一输入可逐字节重建**：
在 `release-wb37c` 与 `release-wb37d` 两次独立打包中，网关包与桌面包的 sha256 各自完全相同
（`731dcd81…` / `37083679…`）。`release-wb38` 的哈希与前两者不同是**预期**——它在源码修了
`scripts/sync-skill.mjs` 之后重建。

## 5. 未覆盖

- **安装后运行身份**：解包验证只到「依赖 + MCP 应答」；`codeHash` 读回、常驻服务切换、升级/回退/卸载属 WB38（安装演练已在本机做完，切换运行安装未做）。
- **窗口 smoke**：桌面壳能启动并给出分阶段文案，但本机会话拿不到 WebView2 控制器，面板未渲染（WB35）。
- **签名**：产物未签名，Windows 会给出未签名提示；签名状态与第三方声明属 WB41。
- **用户视频验收**：清单里如实保留 `videoAcceptance: pending_user_verification`。

## 6. 复现命令

```powershell
cd gateway
node scripts/package.mjs ..\..\..\outputs\executor-plan-20261111\release-wb38
node scripts/package-desktop.mjs ..\..\..\outputs\executor-plan-20261111\release-wb38\desktop
node scripts/verify-pairing.mjs <gateway.zip> <desktop.zip>
node scripts/candidate-installation.mjs check --package <gateway.zip> --expect-sha256 <sha256>
```
