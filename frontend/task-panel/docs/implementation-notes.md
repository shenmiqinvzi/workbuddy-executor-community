# 实现说明

## 分层

```text
场景 fixture（合成快照）
      ↓
PanelDataSource（只读：getHealth / listTasks / getTask / listEvents）
      ↓
App（选中任务、筛选、请求归属、标签页）
      ↓
展示组件（文案、格式、数据质量提示）
```

`DemoController` 独立于数据源，只负责"看哪一帧"：场景选择、播放 / 暂停、重置演示时钟、刷新快照。它不修改任何任务事实。

## 关键决定

### 1. 只读在类型层就成立

`PanelDataSource` 只有 4 个方法，没有 `submit / rework / cancel / accept / respond`。
按钮类操作在原型里不存在；`allowedActions` 只展示，不渲染成可点击控件。

### 2. 前端不推导业务状态

`displayState` 直接来自 fixture。前端只做文案映射；未知枚举降级为"未知状态，需核查"，并在技术详情保留原值。
数据自相矛盾（如 `needs_review` + `remoteStopped=false`）显示"数据不一致"，不自动修正。

### 3. 时间只有一个来源

组件不直接 `new Date()`。倒计时与"最后观测"都基于 `Clock`：

- 生产 / 演示用 `FixedClock`，初值取场景 `fixtureNow`；
- 播放时由 `DemoController` 每秒推进 1 秒；
- 手动切帧时把时钟设到该帧的 `offsetMs`。

因此任何截图与断言都可复现。倒计时归零只显示"期限已到，等待服务端确认状态"，不改写业务状态。

### 4. 请求归属用 generation

`RequestGate` 只认最近一次选择，不比较 `revision` 字符串的字典序。
场景切换、任务切换、刷新都会产生新 generation，旧响应被丢弃。

### 5. 未知值不补齐

- `null` → "未知"；
- `[]` → "已知没有"；
- `changesStatus / artifactsStatus = unavailable` → "变更/产物信息不可用"，不显示"没有改动"。

### 6. 补充 mock 不污染契约

目标 TaskView 没有"目标正文、进度、报告正文、允许修改范围、变更是否已观测"这些字段。
它们集中在 `MockPresentationSupplement`，文件头注明"非正式 wire 字段，后续需契约变更"。

### 7. 阶段区分

事件面板固定展示"已回报 → 停止确认 → 独立验收"三段；报告到达不会被渲染成验收通过。
`remoteStopped` 在概况里单独解释为"停止已确认 / 尚未确认"，并注明 false 不代表仍在运行。

## 播放语义

| 操作 | 影响 |
|---|---|
| 播放 | 时钟每秒推进，到达下一帧偏移时切换帧；到最后一帧自动暂停 |
| 暂停 | 停止时钟推进，保留当前帧（截图用这个状态） |
| 上一帧 / 下一帧 | 暂停并跳到相邻帧，时钟同步到该帧偏移 |
| 重新播放 | 回到第 1 帧、重置演示时钟与刷新计数 |
| 刷新模拟快照 | 重读同一帧（不换场景、不新建任务、不推进轮次） |

## 未实现（留给后续阶段）

- 真实 HTTP 提供器与 stage-2 DTO 兼容层；
- 派工 / 返工 / 取消 / 验收写操作与 `allowedActions` 执行；
- 会话导航 deep link（需 `capabilities.nativeSessionNavigation` 验证为 true）；
- 模型选择与额度页（设计 v1.1 §17，属独立交付）；
- 深色主题、i18n。
