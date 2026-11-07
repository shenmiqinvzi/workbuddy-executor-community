# post-final8 轮（指针）

本文件只做指路，完整回执在证据根：

- 总回执：`E:\javaproject\outputs\forward-delivery-20261107\post-final8\TOTAL_RECEIPT.md`
- 续接说明：`E:\javaproject\outputs\forward-delivery-20261107\post-final8\RESUME.md`

## 本轮两个修复

| 提交 | 内容 | 为什么 |
|---|---|---|
| `1e244d1` | 桌面壳宿主挂上 `readiness`（`scripts/workbench-desktop-host.mjs`） | 窗口里 `GET /workbench/v1/readiness` 是 404，CLI 却能打印五层 |
| `7ea66cd` | `desktopInstanceKey` 哈希前去尾部分隔符，`desktopWindowPaths` 同 | 模块根带 `\`、启动器不带 → 管道名不同 → `desktopPageReady` 恒 `absent` |

回归锁：`gateway/test/desktop-host-wiring.test.ts`、`gateway/test/readiness-pipe-identity.test.ts`。

## 候选

`post-final8\candidate-final10\codex-workbuddy-gateway-v0.7.1.zip`（752 受管文件 / 2,500,437 B /
`d2177267206d417bb3cbc4193f641b7e1604724a8070ea459946bb7d9c38b824`），
桌面成品 `post-final8\desktop-final10\…zip`（2,922,312 B / `ee35cf3b9b8e7f4138d4fb338f2f35b2e6b365fdc691d6237f1392f9eec21f5a`）。
两包网关字节相同 752、不同 0。

## 未做

真实派工（需用户逐任务选择执行器/模型/费用并授权）、F 标准页面验收（四尺寸/320px/键盘/200%/读屏）、
异机安装、CI 实跑、许可与发行档案。
