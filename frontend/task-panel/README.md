# WorkBuddy Executor · 只读任务面板原型

不启动 WorkBuddy、不连接真实网关，也能在本地浏览器完整演示任务状态与异常场景的只读面板。

- 关联任务：[Issue #6](https://github.com/shenmiqinvzi/workbuddy-executor-community/issues/6)
- 设计依据：[`docs/FRONTEND_TASK_PANEL_DESIGN.md`](../../docs/FRONTEND_TASK_PANEL_DESIGN.md)（F01–F20、M01–M16）
- 契约依据：[`docs/INTERFACE_CONTRACT.md`](../../docs/INTERFACE_CONTRACT.md) §3（TaskView）、§6（事件）、§7（错误）

> **本期只证明 mock 前端可用。** 没有真实 MCP / HTTP / 原生会话请求，也不代表真实面板联调或第二台 Windows 验收。

## 技术栈

| 项 | 选择 |
|---|---|
| 框架 | React 18 + TypeScript（strict） |
| 构建 | Vite 5 |
| 测试 | Vitest 2 + Testing Library + jsdom |
| 样式 | 原生 CSS 变量 + 语义类名，无 UI 框架 |
| 日期 | 原生 `Intl.DateTimeFormat`，无日期库 |
| 路由 | 无（单页 + 标签页） |

## 快速开始

要求 Node.js ≥ 22.13.0。

```bash
cd frontend/task-panel
npm ci            # 首次可用 npm install 生成锁文件
npm run dev       # http://127.0.0.1:5175
```

其他命令：

```bash
npm run build     # tsc --noEmit && vite build
npm run test      # vitest run
npm run preview   # 预览构建产物，127.0.0.1:4175
npm run screenshots  # 可选：用本机 Chrome 重新生成 docs/screenshots
```

`npm run screenshots` 依赖 `puppeteer-core` + 本机 Chrome（`CHROME_PATH` 可覆盖），只用于验收截图与视口溢出检查，不参与 build / test / dev。

- 开发服务只监听 loopback，端口与网关（8787 一类）分开。
- 安装依赖需要网络；**运行时完全离线**，不需要任何后端。
- 没有隐藏的 live 模式，也不会在后端不可用时自动派工。

## 场景与演示

顶栏可选择 M01–M16 场景、播放/暂停/逐帧查看、重置演示时钟、刷新模拟快照。

- 所有场景共用固定演示起点 `2026-10-20T01:10:00Z`。
- 每帧都是完整、合法的合成快照；"重置"只重置演示时钟与帧指针，不修改任何任务事实。
- 也支持用 URL 直接定位：`?scene=M02&frame=1`（frame 从 0 开始）。

场景清单与触发方式见 [`docs/scenario-index.md`](docs/scenario-index.md)。

## 目录

```text
src/
  app/         页面壳、选中任务、筛选、请求归属判断
  components/  顶栏、列表、详情、四个标签页、技术详情
  data/
    contracts/ TaskView / Event / Health / Error 类型
    mock/      16 个场景 fixture 与只读 mock 数据源
    panel-data-source.ts
  demo/        演示控制器（场景、帧、固定时钟）
  presentation/ 状态文案、时间格式、补充 mock 类型
  clock/       可注入时钟
  styles/
tests/         自动化测试
docs/          场景索引、实现说明、验收记录、截图
```

## 数据规则

- 所有任务、项目、会话、路径、日志均为合成数据（`example-*`）。
- `null` 表示未知 / 未观测；`[]` 表示已知没有；`0` 只在已知为零时使用。
- 面板只展示服务端 / fixture 给定的 `displayState`，前端不推导业务状态。
- 目标 TaskView 未定义的字段（任务目标正文、进度、报告正文、允许修改范围、变更是否已观测）放在独立的补充 mock 中，不修改契约。
- 只读边界：`PanelDataSource` 只有 `getHealth / listTasks / getTask / listEvents`，没有任何写方法。

## 已知限制

- 不连接真实 WorkBuddy、任务数据库、MCP 或网关执行接口。
- 不提供派工、返工、取消、验收、代批原生权限、真实文件打开或下载。
- 不生成 WorkBuddy deep link（`capabilities.nativeSessionNavigation` 固定为 false）。
- 深色主题、真实费用统计、登录与多用户不在本期范围。
- 设计 v1.1 第 17 节（模型选择 / 额度页，MC01–MC10）属后续独立交付，本期不实现；后续按 main 现行的 `selectionMode=user_choice` 政策实现，不预选模型。
- 仅在本机 macOS + Chrome 上做过浏览器检查；Windows 实机尺寸与 200% 缩放仍需人工复核。

## 验证状态

自动化测试覆盖：状态文案、场景完整性、只读接口边界、时间 / 倒计时格式、筛选与空态、阶段顺序、未知值保留。
逐项 F01–F20 记录见 [`docs/verification.md`](docs/verification.md)。

## 截图

`docs/screenshots/` 下有 5 张演示截图，均保留"模拟数据"标记。
