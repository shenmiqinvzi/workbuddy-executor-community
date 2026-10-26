# 验收记录（F01–F20）

- 记录时间：2026-10-26
- 对应分支：`feat/read-only-task-panel`
- 基线：main `0e9d96b`（已合并 PR #10–#17，T1–T6）；本分支 rebase 到该基线后重新跑过 build 与 test
- 结论：**mock 前端可用**；真实接口联调、Windows 实机、200% 缩放等仍是未验证项（见文末）。

## 环境

| 项 | 值 |
|---|---|
| 系统 | macOS 26.3.1（25D771280a） |
| Node / npm | v24.20.0 / 11.19.0 |
| 浏览器 | Google Chrome 155.0.8059.85（无头模式） |
| 窗口 / 设备比例 | 1440×900、1280×720、768×1024、390×844、320×720；DPR = 1 |
| 是否启动 WorkBuddy / 网关 | **否**（全程未启动，也未连接任何后端） |

## 命令与结果

| 命令 | 结果 |
|---|---|
| `npm ci --no-audit --no-fund --cache /tmp/npm-cache-wb` | 退出 0（干净安装；本机 `~/.npm` 缓存有 root 权限文件，故改用独立 cache，与项目无关） |
| 干净安装后再跑 build + test | 退出 0；7 个文件 / 48 个用例全部通过 |
| `npm run build`（`tsc --noEmit && vite build`） | 退出 0；`dist/index.html` 0.42 kB、CSS 11.8 kB、JS 194.6 kB |
| `npm run test`（`vitest run`） | 退出 0；**7 个测试文件 / 48 个用例全部通过** |
| `npm run preview`（127.0.0.1:4175） | HTTP 200；不依赖任何后端 |
| `npm run screenshots`（`scripts/capture-screenshots.mjs`） | 退出 0；5 张截图；5 个视口 `scrollWidth == innerWidth`；每张都检测到"模拟数据"标记 |

## 逐项结果

| 编号 | 必验项 | 结果 | 证据 |
|---|---|---|---|
| F01 | 环境独立 | 通过 | 未启动 WorkBuddy / 网关；`npm run preview` 返回 200；截图全部离线生成 |
| F02 | 明确模拟 | 通过 | 截图脚本对 5 张图逐张断言 `.mock-badge` 文本含"模拟数据"，全部为 true |
| F03 | 状态覆盖 | 通过 | `tests/fixtures.test.ts` 断言 M01–M09 覆盖 10 种 `displayState`；顶栏选择器列出 10 种状态 |
| F04 | 报告不等于完成 | 通过 | `tests/app.test.tsx` M02：`waiting_stop` 帧显示"仍在等待原生停止确认"，下一帧才"尚未独立验收" |
| F05 | 严格只读 | 通过 | `src/` 内无 `fetch / XMLHttpRequest / WebSocket / EventSource / sendBeacon / localStorage`，也无 `http(s)://`；`tests/mock-source.test.ts` 断言只读接口只有 4 个方法且无 `submit/rework/cancel/accept/respond` |
| F06 | 原生等待 | 通过 | M03 截图（会话标题 / 工具 / 请求摘要 / 处理位置，无代批按钮）；`tests/app.test.tsx` M04 断言"具体请求详情不可用"且不出现工具名 |
| F07 | 取消与到期 | 通过 | `tests/app.test.tsx`：M05 显示"等待停止确认"且不出现"已取消"；M06 无验收 / 取消 / 继续 / 重试 / 恢复按钮，期限显示"已结束"；M07 显示"已超过期限"、迟到报告可读、无"已独立验收" |
| F08 | 原身份恢复 | 通过 | `tests/fixtures.test.ts` 断言 M10 三帧的 `taskId / attempt.id / attemptDeadlineAt` 不变；`tests/app.test.tsx` 断言断线提示"仅显示旧快照" |
| F09 | 旧响应丢弃 | 部分 | `tests/request-gate.test.ts` 验证 generation 使旧请求失效；**UI 层延迟注入未做**（`MockPanelDataSource` 固定延迟 0） |
| F10 | 时间正确 | 部分 | `tests/format.test.ts` 覆盖非法 / 缺失时间、倒计时归零文案；`tests/demo-controller.test.ts` 覆盖时钟推进、重置、切帧、后台恢复；**真机后台节流未实测** |
| F11 | 未知值保留 | 通过 | `tests/app.test.tsx` M12：实际积分显示"未知"，无"0 秒"；`tests/format.test.ts` 断言字节 null → "未知"、已知 0 → "0 B" |
| F12 | 事件与历史 | 通过 | `tests/mock-source.test.ts` 事件按 `eventId` 去重 + 游标；`tests/format.test.ts` 观测滞后提示；M11 fixture 保留两次返工事件 |
| F13 | 数据矛盾降级 | 通过 | `tests/app.test.tsx` M15：未知枚举 → "未知状态，需核查"、"未识别的展示状态"提示；fixture 含非法时间与矛盾证据 |
| F14 | 内容安全 | 通过 | `tests/app.test.tsx` M16：`<script>` 字符串以文本出现，`document.querySelectorAll('script')` 长度为 0 |
| F15 | 内容范围 | 部分 | 自动断言所有 `taskId / workspace.id` 以 `example-` 开头、不存在绝对路径；**人工抽查合成数据尚未逐条完成** |
| F16 | 文件 / 检查语义 | 通过 | `tests/app.test.tsx` M13：未授权变化单独标注并有提示；M12：`checker_error` 显示"检查器错误"，不当作通过 |
| F17 | 响应式 | 通过（Chrome/macOS） | 5 个视口审计：1440/1280/768/390/320 全部 `scrollWidth == innerWidth`；390 与 320 单列 + "返回任务列表" |
| F18 | 键盘与缩放 | 部分 | `tests/app.test.tsx` 方向键切换标签页；搜索 / 筛选 / 复制等使用原生控件；**200% 缩放未实测** |
| F19 | 构建与必要测试 | 通过 | 见"命令与结果"：build 退出 0、test 48/48、screenshots 退出 0 |
| F20 | 交接清楚 | 通过 | README、`docs/scenario-index.md`、`docs/implementation-notes.md`、`docs/integration-gaps.md`、本文件、5 张截图齐全 |

## 截图

| 文件 | 内容 |
|---|---|
| `docs/screenshots/01-m01-desktop.png` | 1440×900，M01 待验收帧：列表 + 详情 + 概况 |
| `docs/screenshots/02-m03-waiting-input.png` | 1280×720，原生等待且详情可用 |
| `docs/screenshots/03-m02-report-first.png` | 1280×720，报告先到、等待停止确认 |
| `docs/screenshots/04-m10-disconnected.png` | 1280×720，连接中断，保留旧快照 |
| `docs/screenshots/05-m14-narrow.png` | 390×844，单列布局与返回按钮 |

## 未验证 / 留待后续

1. **Windows 实机浏览器**（Edge / Chrome）四尺寸与 200% 缩放。
2. **真实屏幕阅读器**行为（只做了语义与 live region 的静态检查）。
3. **真机后台节流**：只验证了固定时钟与 `resumeVisible()` 逻辑。
4. **UI 层乱序注入**（F09 剩余部分）。
5. **深色主题**（本期不作门槛）。
6. **真实接口联调**：明确不在本期范围，见 `docs/integration-gaps.md`。
