# EXTERNAL_DECISIONS：只能由用户拍板的事项

本文件只列**需要用户实际选择**的项。每项写明「已准备好的材料」「需要你选什么」「选完会发生什么」。未收到选择时保持「待外部条件」，不以时间流逝当作同意。

---

## D1. 是否用新候选替换当前安装

- 已准备：候选包与 SHA、`candidate-installation.mjs` 的 `check`/`preview`/`version-check`/`drill`/`upgrade-drill`/`rollback-plan` 全部合成演练结果；安装根差异清单（与已安装版本逐文件比对）。
- 需要你选：
  1. 装到新目录（建议 `E:\javaproject\workbuddy-install\gateway-<RC 名>`）还是升级现有 `gateway-v0.7.1-rc2`；
  2. 安装前是否允许 `setup install --apply` 替换 `C:\Users\LENOVO\.codex\skills\workbuddy-executor`（会先备份旧目录）；
  3. 回退目标：回到 RC2 还是更早的 RC1（`rollback-plan --to <旧包>` 已能算出 replace/create/remove/keep 计数）。
- 选完会做：备份 → 安装 → 版本核对 → 回退演练一份可执行计划（不立即执行）→ 记录安装差异。
- 不会做：不经你确认就改 `~/.codex/config.toml`、不经你确认就动生产政策与常驻服务。

## D2. 真实派工（含模型与费用）

- 已准备：`live-acceptance-fixture.mjs` 生成的合成双端样本、每样本的目标/验收命令、证据字段清单、异常卡（R3/R4/R6/R7/R8 现状与已知缺陷修复情况）。
- 需要你选：每条样本用哪个执行器与精确模型（例如 `workbuddy + deepseek-v4.1-flash-sg`、`dsh + deepseek-v4.1-flash`），以及该模型已知费率；未知费率会按未知披露，不会写成免费或硬上限。
- 选完会做：逐任务展示「执行器/来源/模型/推理/费用」并取得确认后派工，一单一记录；`operationId` 固定，不重试覆盖。
- 不会做：不预选模型、不默认零费率、不在未确认时派工。

## D3. 原未知任务与共享容量

- 现状：RC2 的 `blocked` 任务仍占 slot 1；按 T7D 决定不关闭、不重派、不释放。仓库里还有更早的 `outcome_unknown` 记录。
- 需要你选：是否授权对这**一个**已确认身份的 blocked 任务执行 `recovery reconcile/close`（当前工具只能观察到 `available: []`，没有可用的恢复证据）；若不授权，真实派工需换用独立库或用 10 的第二台机。
- 不会做：不换库绕过、不改 `taskId`/`operationId` 规避容量、不把 TTL 当释放。

## D4. 第二台 Windows 机器

- 已准备：异机步骤（安装、登录输入、单样本、证据回收）与「异机不得用来绕 D3」的判定口径。
- 需要你选：是否有可用机器、是否允许在其上安装与登录（登录输入由你完成，我不代填）。
- 没有机器时：异机项保持「待外部条件」，不影响源码与合成候选结论。

## D5. 生产政策与常驻服务

- 现状：`collaboration_policy` 为 `requireFree=true`、`maxAttempts=3`、allowlist 只含 `workbuddy/local-workbuddy/workbuddy-native/deepseek-v4.1-flash`；网关常驻服务 PID 11672（`data\persistent-service.json`）。
- 需要你选：是否放宽 `requireFree`/allowlist（仅供真实验收用），以及是否允许重启/停用常驻服务。
- 不会做：不因为「开发自动政策」就放宽历史任务准入或已安装部署设置。

## D6. 许可与发行

- 现状：仓库与 `gateway/` 根都没有 LICENSE/COPYING；包内不含许可证文件。
- 需要你选：许可证类型与版权归属行、发行渠道（本地 zip / 内部目录 / 公开发布）、是否签名。
- 在你决定前：候选包只作内部验收产物，不写「可公开发布」，不推送远端。

## D7. 推送与合 main

- 现状：本轮所有提交都在 `fix/delivery-review-r1-r4`（以及历史 `integration/delivery-finish`），**未推送、未合 main、未发布**。
- 需要你选：是否推送、推到哪个远端、是否合并到 main。
- 在你决定前：不执行任何远端写操作。

---

## 附：不需要你决定、由我自主完成的部分

- 源码修复、回归、文档、锁定版本的构建与测试、打包与解包自检、隔离演练、候选影响表、失败记录。
- 这些完成后会给一份总回执，只等你对上面 D1–D7 逐项选择。
