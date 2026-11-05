# A 线开工提示词：可回退候选安装准备

你负责 A 线。先读同目录 COMMON.md，再在 A 工作树执行。目标对应 D1-01 的准备部分及 D7-01 的隔离安装演练，不在本轮升级真实安装。

## 小目标

交付一套可审查、可重复执行的候选安装预览和隔离演练：能够核对候选包、显示安装差异、保留配置和历史、验证升级失败及回退。真实安装目录只读，实际写入限制在本轮自建演练目录和假 CODEX_HOME。

## 先复用

阅读 gateway/src/setup.ts、deployment-safety.ts、deployment-paths.ts、deployment-acceptance.ts，scripts/setup.mjs、package.mjs、package-desktop.mjs，test/deployment.test.ts、gateway/docs/INSTALL_WINDOWS.md。现有 setup 已有 plan/install/upgrade/uninstall、备份与保护机制，先核对哪些能力已满足，不再写一套互不兼容的安装器。

当前候选可作为输入：
`E:\javaproject\outputs\dsh-discovery-fix-20261105\package\codex-workbuddy-gateway-v0.7.1.zip`
SHA256：`003417bce7b41e4b9bdc3400d3a5d779f80d8dc9fed53437db52f63e964546b8`。
包是 gateway 候选；不要宣称它已包含可直接运行的桌面完整安装。另行说明桌面程序、Node/.NET/WebView2 与 npm 依赖的实际条件。

## 文件归属

可负责：
- gateway/src/setup.ts、deployment-safety.ts、deployment-paths.ts；
- gateway/scripts/setup.mjs；
- gateway/test/deployment.test.ts；
- 必要的新安装准备模块/测试，名称以 candidate-installation 或 installation-readiness 为前缀；
- gateway/docs/INSTALL_WINDOWS.md；
- docs/CANDIDATE_INSTALLATION_READINESS.md。

不改 B 的 desktop-dispatch、dispatch UI 和相关测试，不改 C 的交付矩阵或共同清单。新脚本入包需求单独列给集成人。

## 必须完成

1. 预览默认只读：核对候选清单和哈希，列出新建/变更/保留项、依赖条件、备份与回退步骤。遇到不可读或不受管理的安装不猜测其状态。
2. 预览不修改 .env、用户 config.toml、技能、任务库、原生 profile 或安装目录，不启动/停止生产进程。
3. 演练只使用本轮新建目录。显式传入自有路径及假 CODEX_HOME，不能因参数缺失回落到真实用户目录；清理只删除自己拥有的子目录。
4. 覆盖首次安装、相同内容重复安装、候选升级、失败中断及回退、卸载/恢复原技能。现有功能可直接复用并验明，不强行新增命令。
5. 配置、任务历史、原模型政策与用户修改保留；未管理文件不得被覆盖或整体删除。备份含敏感配置时只在本机演练目录使用合成内容，验收报告不导出配置正文。
6. 有活动任务、停止未确认、容量未知、库不可读或服务状态不明时，实际变更必须拒绝；不得按 TTL 或换库制造空闲。
7. 路径含中文、空格、已有文件和链接/junction 时有明确行为；zip 解包保持路径边界。不要为通过演练关闭安全设置或放宽权限校验。
8. 真实部署前给出具体操作清单、受影响文件、前置检查和可回退证据。生产切换与模型验证仍是独立动作。

## 验证和交付

为发现的实际缺口补失败回归，再做最小修复；已有能力仅增加必要交叉验证。至少验证无写预览、幂等、配置保留、用户改动拒绝、活动/未知占用拒绝、失败回退和清理归属。运行相关部署/安装测试、必要构建和类型检查。

输出独立验收记录，逐项写明实现、隔离验证、真实未执行。记录旧实现已具备哪些能力，本轮新增什么。不要把隔离安装演练称为真实安装、异机验收或 D1 完成。

最终提交并提供文件清单、命令与结果、演练目录、回退证明、生产切换所需的最少条件。不要自动部署、合入集成分支或生成正式发行结论。
