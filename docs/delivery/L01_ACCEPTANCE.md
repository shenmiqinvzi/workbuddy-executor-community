# L01 项目、模型与手动协作流程 — 交付记录

范围：`D2-01`–`D2-04`、`V02`/`V06`/`V10`/`V11`、`C01`–`C05`/`C14`/`C16`/`C17` 及对应 `F` 项中属于桌面“新建任务”准备面的部分。

## 1. 所有权与边界

本线拥有并已改动的产品面：

- `gateway/src/desktop-dispatch*.ts`（目录、草稿、修订、单次消费、来源状态）
- 本线新增 `gateway/src/desktop-projects.ts`（项目身份登记与核验）
- `gateway/workbench/dispatch.mjs`（真实工作台里的“新建任务”视图）
- 相关定向测试（`gateway/test/desktop-*`、`gateway/workbench/test/dispatch-project.test.mjs`）
- 根技能六文件第一批：`SKILL.md`、`agents/openai.yaml`、`references/{agent-hub,dispatch,execution,setup}.md` 与网关发布副本 `gateway/skills/workbuddy-executor/`

未改动：`collaboration` 与 `task-application-service` 的核心准入、统一 DB schema/migration、桌面宿主路由入口（`gateway/src/workbench-http.ts`、`gateway/scripts/workbench-desktop-commands.mjs`、`gateway/desktop/*.cs`）、02 资源模块、03 统计、04 安装模块。

因此本线**没有产生 integration-request**：桌面命令的动作名仍是 `catalog`/`preview`/`dispatch`/`status`/`latest`/`observe`/`recovery_show`，`dispatch` 仍映射到 `commit`；项目身份与修订都作为 `preview` 的附加参数字段传递，C# 侧动作白名单（`gateway/desktop/DesktopControlPolicy.cs:24`）与只对 `catalog`/`choose_workspace`/`latest` 强制空参数的规则（同文件第 27 行）无需变更即可接受这些字段。

## 2. 基线与提交

- 工作树：`E:\javaproject\workbuddy-finish\L01-project`
- 分支：`feat/finish-l01-project`
- 基线：`1f60374a889ae5acb442affff7a59f3e045a1277`（开工前 `git rev-parse HEAD` 一致、`git status --porcelain` 为空）
- 本线提交：见外部 `HANDOFF.json` 的 `commits`（提交后回填，本文件不预填通过）

## 3. 变更文件

| 文件 | 变更 |
| --- | --- |
| `gateway/src/desktop-projects.ts` | 新增：目录身份解析、登记表（上限 20）、核验与歧义匹配 |
| `gateway/src/desktop-dispatch.ts` | 目录增加 `sources`/`projects`/`projectIssues`；`preview` 支持 `projectId` 与 `draftId`+`digest` 修订；单次消费改为按经济条款哈希；会话拒绝细化文案 |
| `gateway/src/desktop-dispatch-runtime.ts` | 抽出 `desktopStateDir`，新增 `desktopProjects`，会话注入项目登记表 |
| `gateway/workbench/dispatch.mjs` | 已登记项目选择、来源状态行、修订往返、一次性确认、刷新保留选择 |
| `gateway/test/support/desktop-dispatch-fixture.mjs` | 合成宿主注入真实项目登记表（仅测试支持，不随发布打包） |
| `gateway/test/desktop-projects.test.ts` | 新增 7 项 |
| `gateway/test/desktop-dispatch-terms.test.ts` | 新增 8 项 |
| `gateway/test/desktop-dispatch-e2e.test.ts` | 新增 1 项端到端合成用例 |
| `gateway/workbench/test/dispatch-project.test.mjs` | 新增 4 项视图用例 |
| `SKILL.md`、`gateway/skills/workbuddy-executor/SKILL.md` | 新增“准备任务与核对”一节，六文件与发布副本逐字一致 |

## 4. 冻结契约（给 05/06/07）

`catalog` 返回值新增（未列出的字段保持原样）：

```json
{
  "sources": [{"sourceId":"[\"workbuddy\",\"local-workbuddy\",\"workbuddy-native\"]","executorId":"workbuddy","connectionId":"local-workbuddy","providerId":"workbuddy-native","label":"WorkBuddy · 本机原生来源","state":"online|disabled|unverified|unavailable|unknown","stateReason":null,"dispatchable":true,"stoppable":"unknown","models":["精确模型选择"]}],
  "projects": [{"projectId":"project-<32hex>","realPath":"<已核验的绝对路径>","displayName":"<目录名>","state":"unverified","observedAt":"<ISO>"}],
  "projectIssues": ["<不含绝对路径的登记问题>"]
}
```

- `sourceId` 与视图原有的 `sourceKey(execution)` 逐字相同，可直接复用；来源失败不会让整份目录失败，空模型列表必须同时给出非 `online` 的来源行或 `errors`。
- `projects` 只来自本机登记表，不含 `device`/`inode`；`state` 恒为 `unverified`，每次预览都重新核验。

`preview` 输入：

- 原有 12 个键不变（`catalogId`、`modelKey`、`workspace`、`title`、`objective`、`allowedChanges`、`permittedMetadata`、`checks`、`maxAttempts`、`timeoutSeconds`、`sessionId`）。
- 新增可选 `projectId`：存在时 `workspace` 必须为 `null`；两者都给或都不给 → `PROJECT_SELECTION_REQUIRED`。
- 新增可选 `draftId`+`digest`：二者同时存在表示“修订原草案”，保留 `taskId`/`operationId`，`revision` 加一，`expiresAt` 不延长，旧摘要进 `superseded`。
- 返回 `{draftId,taskId,operationId,revision,projectId,workspace{realPath,device,inode},sessionId,digest,quote{credits,pricingVerified,observedAt},policyVersion,expiresAt,contract}`。

拒绝码：`PROJECT_PATH_REQUIRED`、`PROJECT_PATH_NOT_ABSOLUTE`、`PROJECT_NOT_FOUND`、`PROJECT_ACCESS_DENIED`、`PROJECT_NOT_DIRECTORY`、`PROJECT_UNREADABLE`、`PROJECT_LINK_UNRESOLVED`、`PROJECT_NOT_REGISTERED`、`PROJECT_IDENTITY_CHANGED`、`PROJECT_SELECTION_REQUIRED`、`DRAFT_CHANGED`、`DRAFT_EXPIRED`、`DRAFT_CONSUMED`、`DRAFT_LIMIT`、`MODEL_SWITCH_REQUIRES_PREVIEW`、`MODEL_UNVERIFIED`、`QUOTE_CHANGED`、`WORKSPACE_CONFLICT`、`DISPATCH_NOT_ENABLED`、`SESSION_REQUIRED`、`PLAN_ALREADY_CONSUMED`。

会话拒绝沿用同一 `SESSION_REQUIRED` 码（既有测试依赖），`message` 区分：未选择、身份不唯一、未连接、忙碌、状态未知、不属于当前项目、项目无法核验。

给 03 的可关联标识：`taskId`、`operationId`、`draftId`、`projectId` 均为定长哈希/编号，不含路径、模型凭据或用户信息，可在统计侧做关联而无需读取目录或配置；`projectId` 由目录设备号与 inode 派生，不可反推路径。

## 5. 验证

环境：每条命令前清理继承的 `WORKBUDDY_*`/`WORKBENCH_*`，显式 `WORKBUDDY_CLI_ELECTRON=E:\javaproject\outputs\finish-l01-20261105\env\WorkBuddy.exe`、`WORKBUDDY_CONFIG_DIR=E:\javaproject\outputs\finish-l01-20261105\env\config`（本机存在多份 WorkBuddy 安装，未显式指定时 `loadConfig` 直接报歧义），`NO_PROXY=127.0.0.1,localhost`；依赖按本树 `gateway/package-lock.json` 用 `npm ci` 安装，未改版本。

| 检查 | 命令 | 退出码 | 计数 | 日志 |
| --- | --- | --- | --- | --- |
| 构建 | `npm run build` | 0 | — | `logs/build.log` |
| 类型（任务视图） | `npm run typecheck:task-view` | 0 | — | `logs/typecheck-task-view.log` |
| 工作台视图 | `node --test workbench/test/*.test.mjs` | 0 | 107 tests / 107 pass / 0 fail | `logs/workbench-test.log` |
| 本线定向 | `node --import tsx --test test/desktop-projects.test.ts test/desktop-dispatch-terms.test.ts test/desktop-dispatch.test.ts test/desktop-catalog-diagnostics.test.ts test/desktop-dispatch-e2e.test.ts` | 0 | 32 tests / 32 pass / 0 fail | `logs/desktop-focused.log` |
| 全量 | `npm test` | 1 | 1064 tests / 1051 pass / 1 fail / 12 skipped | `logs/gateway-test.log` |
| 失败单飞复跑 | `node --import tsx --test test/run-worker.test.ts` | 0 | 5 tests / 5 pass | 见下方失败历史 |

端到端用例走的是**真实**父子命令传输（`scripts/workbench-desktop-commands.mjs` 的 `installDesktopCommands`）与真实 `DesktopDispatchSession`，只把原生边界替换成带标记的合成根（`.synthetic-workbench`、技能库与运行目录都在其中，绑定假原生客户端并把调用计数写到 `actor-stats.json`）。它验证：预览阶段 `actor-stats.json` 不存在任何计数且 `status` 无派工记录；按 `projectId` 派工后只有 `workbuddyPreparations=1`、`workbuddyPrompts=1`、`dshSelections=0`、`dshPrompts=0`；相同条款二次派工被 `PLAN_ALREADY_CONSUMED` 拒绝；修订返回 `revision=2` 且 `taskId` 不变、仍不产生任何模型准备。

## 6. 失败历史

1. `desktop-dispatch-terms.test.ts` 首跑失败：`desktopExact` 要求全部键存在，而新用例缺 `projectId`；同时 `revise` 会把 `projectId` 与 `workspace` 同时带入，触发 `PROJECT_SELECTION_REQUIRED`。改为只用 `desktopFields` 校验（`projectId` 可选）并在 `revise` 里让身份选择优先于路径后，既有 24 项与本线用例全部通过。
2. `npm run build` 首轮报 `TS2339`（在联合类型上直接取 `draftId`/`digest`）；改为先 `desktopExact` 再局部断言后通过。
3. 第一次全量（1063 项）唯一失败为 `workbench-http.test.ts` 的“entry subprocess resolves the default runs directory next to the database”（`status 400`）。原因是验证命令把 `WORKBUDDY_RUNS_DIR` 也导出，覆盖了该用例“默认运行目录必须由数据库位置推导”的前提；去掉 `WORKBUDDY_RUNS_DIR` 后单跑 13/13 通过。
4. 第二次全量（1064 项）唯一失败为 `run-worker.test.ts` 的“an actual detached worker survives its launcher exiting and writes its final evidence”，错误是这个用例自己的状态文件重命名 `EPERM`（Windows 下临时目录被占用），与桌面准备面无关；单跑 5/5 通过。按项目既有记录，这类失败属整轮高负载下的时序/文件锁抖动。

## 7. 局限与未验证

- 未在正式桌面壳内跑通“项目→选择→核对→可信确认→回执/恢复”的可视化链路：原生确认窗口与 WebView2 宿主属于 10 线的实机验收范围，本线只有源码与合成传输证据。视图侧用的是工作台真实模块 + 最小 DOM 桩，不是自建简化页；页面钩子（`.page-heading`、`.heading-tools`、`#page-title`、`.page-intro`、`.readonly-top`、`#data-source`）与 `dispatch.mjs` 的静态资源路由已核对确实存在于真实页面与资源表。
- 未读取真实原生目录、未派工给真实模型、未安装到用户技能目录（安装副本由 10 办理）。
- 项目登记表按目录设备号与 inode 记录身份；整盘克隆到另一台机器后同一目录会被视为“未登记”，需重新选择（这是有意的安全缺省，但未在真实跨机场景验证）。
- 修订只允许在 `preview` 上追加字段，因此“返回修改”无法在宿主侧弹出区别于首次核对的独立动作；语义靠 `revision`/`superseded` 与文案表达。

## 8. 运行/部署状态

未 push、未合入 `main`、未发布、未部署、未更换任何本机运行实例；工作树在提交后保持干净。所有验证都在本树隔离依赖、隔离配置目录与合成数据库下完成，未触碰真实任务库、原生历史或凭据。
