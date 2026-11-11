# WB10 / WB12 选择主路径与三模式一致性

日期：2026-11-11。工作树：`E:/javaproject/workbuddy-forward-20261107/R-executor-plan-20261111`（分支 `feat/executor-plan-20261111`）。

## 1. 结论

主路径已经成形，本轮没有改产品行为，只补了**可执行证据**与一条跨端一致性守卫。理由：`workbench/dispatch.mjs` 的目录/模型/档位/费用/范围预览及 `src/recommendation.ts` 的 direct/delegate/wait 评估均已存在，缺的是“谁能证明它没被悄悄默认成别的样子”。

## 2. 选择主路径（WB10）

| 步骤 | 界面事实 | 证据 |
| --- | --- | --- |
| 项目 | 已登记项目按目录身份列出（`projectId` + `realPath` + 状态），手填路径同样有效，中文与空格路径按同一规则归一（去尾分隔符、反斜杠转正斜杠、小写） | `workbench/dispatch.mjs:259-264`；新用例「a Chinese project path is located by identity among several candidates」 |
| 执行来源 | 下拉列出可执行来源，未启用的来源保留并写明原因，不用“没有可用执行器”掩盖 | `workbench/test/dispatch-project.test.mjs`「a source that failed or is disabled stays visible with its own reason」 |
| 精确模型 | 初始值为空，占位文案是「请先选择来源」→「请选择精确模型」；没有任何“最新/推荐”默认值 | 新用例「the composer preselects no model or effort…」 |
| 推理档位 | 与模型联动，空值占位是「请先选择模型」→「请选择推理档位」 | 同上 |
| 费率 | `compose-rate` 明写「费用未知，可能计费」，未知费率**不阻塞**选择，只要求核对后在本机确认窗口同意 | 新用例「an unknown price is a choice the user makes knowingly, not a silent block」 |
| 只读 / 编辑 | 允许修改留空 = 只读，预览页写「只读，不授予文件写权限」；填写后逐条列出，`directory/**` 之外不自动扩大 | `workbench/dispatch.mjs:401`；`dispatch-project.test.mjs`「a scope warning is shown on the terms it belongs to…」 |
| 目录读取的副作用 | 说明文案「读取可用目录不会准备或切换模型」，读取只用只读命令，不准备模型、不建原生会话 | 同一新用例断言该文案与 `preview`/`dispatch` 调用数为 0 |

错误文案的下一步（错目录、多会话、无会话）由 `updateSessions()` 的三条提示承担：没有可选会话 → 去原应用检查项目后刷新；路径不一致 → 核对项目、目录别名在预览时校验；身份不唯一/忙/未连接 → 该会话置灰并标注原因。这三条属 WB08 实窗复核范围，源码级已具备。

## 3. 三模式一致性（WB12）

| 模式 | 行为 | 证据 |
| --- | --- | --- |
| `direct` 直接处理 | 只落协作决策：`attempt:null`、`nativeAttempt:"none"`，记录的执行轮次显示「无」，原生派工显示「未发生」，且不出现 `dispatch` 调用 | `workbench/test/recommendation-view.test.mjs`「a direct decision names the recomposition and still creates no attempt」；`src/recommendation.ts:124` 注释与 `directReasons()` |
| `manual` 手动选择 | 用户的选择优先于排序与 direct 建议；选择不可用时进入 `wait`，不替换成更便宜的候选 | `test/recommendation.test.ts`「an explicit user choice wins over the ranking…」「an unavailable user choice waits…」 |
| `recommend` 推荐 | 推荐只把选择**填回表单**（`applySelection` 设置来源/模型/档位并提示「仍需核对约定」），不派工、不授权 | 新用例「adopting a recommendation only fills the form and never dispatches」 |

跨端同一性：技能用决策码（`direct`/`delegate`/`wait`）、桌面用中文标签（建议直接处理/暂不派工/建议交给执行器），两者必须覆盖同一组三种情形；执行器身份只有 `workbuddy` 与 `dsh` 两个，技能、桌面分组、契约三处一致。守卫测试：`gateway/test/executor-modes-consistency.test.ts`（3 例）。

## 4. 验证记录

```
node --test workbench/test/recommendation-view.test.mjs      tests 12 / pass 12 / fail 0  (2535ms)
node --test workbench/test/dispatch-project.test.mjs         5/5
npx tsx --test test/recommendation.test.ts                   18/18
npx tsx --test test/executor-modes-consistency.test.ts        3/3  (870ms)
```

新增用例 4 条（推荐视图）+ 3 条（一致性守卫），没有放宽任何既有断言。

## 5. 未覆盖

- 真实窗口内的键盘/读屏主路径（WB14/WB08 的实窗部分）不在本轮证据内。
- `direct` 模式下的“零原生轮次”是评估器与视图两层证据；真实原生计数核对需连接真实来源（WB15/WB35）。
