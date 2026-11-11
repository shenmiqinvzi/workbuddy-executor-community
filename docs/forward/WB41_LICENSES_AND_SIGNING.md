# WB41 · 第三方组件与签名披露

本文件只陈述事实：哪些东西随包分发、各自许可、哪些没做、为什么没做。**本仓库自身代码的许可决定权属权利人**，本文件不授予任何许可。

## 1. 本仓库代码的许可状态

- 仓库根**没有** `LICENSE` / `COPYING` 文件（本轮用 `Get-ChildItem -Filter 'LICENSE*' -Recurse -Depth 1` 确认，只命中文档与依赖自带的许可文本）。
- `README.md` 第 7 行原文保留：「统一开源许可证尚待明确」，来源与授权事实见 `AUTHORIZATION.md`。
- 结论：**未新增、未改写任何许可声明**。给仓库选许可证是权利人的决定，不是开发任务可以代替的；本轮只把「第三方是什么许可」讲清楚，避免发行时误以为已授权。

## 2. 运行时依赖（随网关包分发）

来源 `gateway/package-lock.json`（lockfileVersion 3），范围 `npm ci --omit=dev`，逐包清单见 [WB41_THIRD_PARTY_INVENTORY.json](WB41_THIRD_PARTY_INVENTORY.json)。

| 项 | 值 |
|---|---|
| 运行时依赖包数 | **91** |
| 直接依赖 | `@modelcontextprotocol/sdk ^1.21.0`、`zod ^3.25.76` |
| 许可分布 | MIT **81**、ISC **7**、BSD-3-Clause **2**、BSD-2-Clause **1** |
| 未声明许可 | **0** |
| copyleft（GPL/LGPL/AGPL/MPL 类） | **0** |

即：全部 91 个运行时依赖都是宽松许可且带声明，没有需要开源本方源码的传染性条款。复算方式：

```powershell
cd gateway
node -e "const l=require('./package-lock.json');const p=l.packages||{};const s=new Set();const walk=n=>{const k='node_modules/'+n;const e=p[k];if(!e||s.has(k))return;s.add(k);for(const d of Object.keys(e.dependencies||{}))walk(d)};for(const d of Object.keys(p[''].dependencies||{}))walk(d);const c={};for(const k of s){const x=p[k].license||'UNKNOWN';c[x]=(c[x]||0)+1}console.log(s.size,c)"
```

## 3. 开发工具链（不进发行包）

`typescript 5.9.2`（Apache-2.0）、`tsx 4.20.x`（MIT）、`@types/node 24.x`（MIT）。它们只在构建/测试期使用，`npm ci --omit=dev` 不安装，配对包里也没有。

## 4. 桌面外壳的第三方

| 组件 | 版本 / 形式 | 许可与义务 |
|---|---|---|
| Microsoft.Web.WebView2 | `1.0.4314.35`（NuGet，随 `desktop/app` 分发 `Microsoft.Web.WebView2.Core.dll` 703328B） | 随包附 `WEBVIEW2-LICENSE.txt`（1486B），未改动 |
| .NET 10 Desktop Runtime | **未捆绑**（`dotnet publish --no-self-contained`） | 由使用者自备，许可属 Microsoft；安装前置条件写在 [WB40](WB40_USER_AND_MAINTAINER_MANUAL.md) 第 1 节 |
| Evergreen WebView2 Runtime | 未捆绑 | 同上，系统级运行时 |

因此桌面包**不含**任何需要随包转发的 .NET 运行时二进制，只含本项目编译产物与 WebView2 的托管 DLL 及其许可文本。

## 5. 签名状态

- 网关、桌面、技能四类 ZIP 与桌面 EXE **均未签名**。配对包只有 `.sha256` 边车做完整性校验（`verify-pairing.mjs` 会重算并比对，边车不符即失败）。
- 后果：Windows SmartScreen / 下载标记会提示未知发布者；企业环境可能直接拦截。这是事实，不是待办勾选。
- 做到签名需要：代码签名证书（EV/OV，需购买或组织签发）、时间戳服务、`signtool` 流程，以及把签名步骤接进 `package.mjs` / `package-desktop.mjs`。证书与私钥不在这台机器上，也没有可用的签发身份 —— 属外部条件。
- 在此之前可做的替代（已做）：sha256 边车 + 配对校验 + `candidate-installation check` 的清单核对，保证「拿到的包就是候选产物」，但**不证明发布者身份**。

## 6. 未覆盖

- 许可证选择本身（权利人决定）。
- 证书申请、签名、时间戳与 SmartScreen 信誉积累。
- 法务复核：本文件是工程披露，不是法律意见。
