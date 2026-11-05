# D2 任务准备：来源诊断与会话选择

日期：2026-11-05。B 线范围为 D2-01/02 的任务准备子项，不是完整 D2、生产部署或真实模型链路验收。

## 版本与改动

- 基线 `882acc8a21dd750c19683efb53951c67bec22309`；工作树 `E:\javaproject\workbuddy-next-round\B-task-preparation`，分支 `feat/task-preparation-diagnostics`。
- 代码与测试提交 `f8015c937075993182dd9c003010e109a4c0ccea`；文档作为后续独立提交。
- `gateway/src/desktop-dispatch-runtime.ts`：在保留 `errors` 的同时新增可选结构化 `diagnostics`；区分 DSH 未启用、宿主缺失/不唯一、注册不可核验、模型目录或会话读取失败，以及 WorkBuddy 目录失败。坏结构不当成空目录；单侧失败不丢另一侧候选，DSH 会话读取失败保留已读取的 DSH 模型。诊断使用固定文案，不输出原始异常、认证头或凭据；目录读取不准备模型或派工。
- `gateway/src/desktop-dispatch.ts`：会话状态增加可选字段区分空闲、忙碌、未连接和未知，未知不升级为空闲；精确 host/session 存在重复时拒绝猜测；项目路径无法核验或不匹配时返回固定的 SESSION_REQUIRED 提示。既有预览、原生确认、费率和政策准入保持。
- `gateway/workbench/dispatch.mjs`：刷新后保留仍有效的明确来源、模型、档位和会话并更新费率/政策；失效时不换选项并提示重选。显示会话状态和项目待核验信息，不在会话选项中展示目录路径。项目改变清除会话但保留模型档位；关闭重开后旧目录结果和旧目录选择器结果不能覆盖新表单。目录别名仅作提示，最终项目身份仍由后端真实路径核验。
- `gateway/test/desktop-catalog-diagnostics.test.ts` 和 `gateway/workbench/test/dispatch-diagnostics.test.mjs`：增加合成目录、政策和真实视图模块行为回归。无新运行时静态文件；现有白名单无需新条目。集成时由集成人按约定重生成快照清单。

现有 catalog 会话对象的 `workspace` 字段因兼容既有调用者和后端精确核验而保留在桌面本机通道中；新诊断文本及会话选项不展示该路径。若将来要求本机通道也不传该字段，需要另行设计兼容协议，不能把当前显示处理当作通道级路径隐藏。

## 验证

命令均在隔离工作树 `gateway` 运行，清除继承的 `WORKBUDDY_*`，为需要 loadConfig 的后端测试显式指定合成 CLI 与配置路径并设置 loopback NO_PROXY；没有访问真实账号或执行模型。

- `npm run build`、`npm run typecheck:task-view`：退出码 0；新增后端测试另以严格 `tsc --noEmit` 核验，退出码 0。
- `node --import ./test/support/typescript-loader.mjs --test --test-concurrency=1 test/desktop-catalog-diagnostics.test.ts test/desktop-dispatch.test.ts test/desktop-dispatch-runtime.test.ts test/dsh-discovery.test.ts test/dsh-adapter.test.ts`：退出码 0，56/56；日志 `E:\javaproject\outputs\task-preparation-diagnostics-20261105\related-tests-final.log`。
- `npm run test:workbench`：退出码 0，103/103；后续新增费率/政策刷新断言后，`node --test workbench/test/dispatch-diagnostics.test.mjs` 再次退出码 0，3/3。最终全量集成回归仍由集成人执行。
- impeccable 上下文与 detector：检测 `gateway/workbench/dispatch.mjs`，退出码 0，结果 `[]`；机械扫描不是无障碍验收。
- `git diff --check`：退出码 0。依赖从具有相同 lockfile SHA-256 的隔离集成工作树复制，`npm ls --all --omit=optional` 退出码 0；未更改锁文件或全局安装。该检查不是一次全新 npm ci。

## 界面证据和边界

- Chrome 合成测试：`E:\javaproject\outputs\task-preparation-diagnostics-20261105\browser-scenarios.json` 和 `browser-synthetic-420.png`。测试宿主模拟目录/会话与另一来源失败；验证多会话需明确选择、忙碌项不可选、刷新保留、项目切换清除会话、关闭重开后迟到结果不覆盖、来源失效提示与 420px 视口。只发生 latest/catalog 请求，无模型准备或派工。此浏览器使用测试静态服务器，不是正式网关集成验收。
- WebView2：独立构建当前 C# 桌面壳，在独立目录、数据库路径和 profile 下运行；工作台文件取本线最终版本，宿主为测试专用的合成只读实现，非正式后端。`webview-scenarios.json`、`webview-host-actions.json` 和 `webview-synthetic.png` 记录多会话、未知价格、选择保留/失效，以及一次键盘 Tab 焦点。420px 为 CDP 视口模拟，不代表实际窄窗口或完整读屏器验收；窗口正常关闭，进程退出码 0，宿主仅收到 latest/catalog。截图均标识合成测试数据。
- 没有测试真实桥接注册、真实模型目录、原生会话可派工/可停止状态或真实费用；在线不推断这些能力。未在 WebView2 逐项复现目录重叠及文件夹选择器迟到；对应自动 DOM/浏览器测试覆盖，集成后仍应在正式宿主复验。

## 集成提示

B 线与 A 安装模块、C 文档矩阵没有共同修改；`desktop-dispatch-runtime.ts` 与 `desktop-dispatch.ts` 是共享运行模块，合并时应按最新集成版本审查；不需要新增 `workbench-assets.ts` 或 `scripts/package.mjs` 白名单项。可将 D2-01/02 更新为“任务准备诊断和选择刷新子项已实现、合成验证通过；完整项目发现、真实桥接/模型与最终集成验收待完成”。未推送、合并、部署或发布。
