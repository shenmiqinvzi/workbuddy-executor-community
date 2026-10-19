# Windows 社区版安装

目标：使用自己的 WorkBuddy、配置与业务目录完成安装，无需修改源码。当前提供可迁移安装程序；第二台物理机器的真实验收仍待完成，不能把本机隔离测试当作跨机器通过。

## 1. 准备

安装 Git、Node.js >=22.13.0、npm 和 WorkBuddy。先自行打开并登录 WorkBuddy，让应用建立本机数据目录。登录、权限及账号由使用者在原生界面处理。

```powershell
git clone https://github.com/shenmiqinvzi/workbuddy-executor-community.git
cd workbuddy-executor-community/gateway
node verify-snapshot.mjs
npm ci
npm run build
```

快照核验应在修改或重新构建之前执行。Node 和 WorkBuddy 可以安装在不同目录，项目路径允许中文和空格。当前安装向导以 Windows 为支持范围，其他平台沿用上游代码不等于经过本版验证。

如果使用完整发布 ZIP，在解压后的网关目录先运行 `node scripts/verify-release.mjs` 核对发布清单，再运行 `npm ci`。包内已有构建产物，可直接进入下一步；源码 clone 使用上述 verify-snapshot/build 流程。单独技能 ZIP 只有指令，不包含网关或可用连接。

## 2. 先预览，再安装

```powershell
node scripts/setup.mjs plan
node scripts/setup.mjs install --apply
node scripts/doctor.mjs
```

plan 不写入文件。安装会探测常见位置和正在运行的 WorkBuddy 可执行文件；数据目录只在发现原生 workbuddy.db 时作为候选。有多个候选时要求明确选择。自定义安装路径或进程信息不可读时：

```powershell
node scripts/setup.mjs plan --workbuddy-app "D:/Apps/WorkBuddy/WorkBuddyAI.exe" --workbuddy-config "D:/My WorkBuddy Data"
node scripts/setup.mjs install --apply --workbuddy-app "D:/Apps/WorkBuddy/WorkBuddyAI.exe" --workbuddy-config "D:/My WorkBuddy Data"
```

上述路径是占位示例，替换为自己的实际位置。也可通过 WORKBUDDY_CLI_ELECTRON、WORKBUDDY_CONFIG_DIR 指定。--codex-home 或 CODEX_HOME 可选择独立的技能安装目录。

安装写入本机 .env（仅原来不存在时）、技能文件、data/workbuddy-mcp.toml 和 data/deployment-installation.json。旧技能先备份；同样内容重复安装不改变文件。既有 .env 不覆盖；配置冲突或缺少免费政策时明确报错，由使用者核对修改。整个安装不发送任务、不启动或重启 WorkBuddy、不安装常驻服务，也不改变执行策略。

## 3. 连接 Codex

打开生成的 data/workbuddy-mcp.toml，核对命令和路径。将其中 workbuddy 配置合并进自己的 Codex config.toml；如已有同名项，只替换明确指向这次安装的条目，保留其他设置。安装程序不会替你修改用户配置。

配置格式依据 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp)，使用 command、args、cwd 和 env。片段内的绝对路径由实际安装位置生成，不要求 F 盘。配置文件和片段含本机路径，不要提交到仓库。

配置后按客户端的 MCP 管理入口重新连接 workbuddy；已有旧进程不会因文件更新而升级。可以先调用 workbuddy_health 观察网关连接；这不证明原生登录、模型额度或真实执行成功。

## 4. 首次真实连接

先确认没有其他 WorkBuddy 任务运行，明确允许本次原生连接初始化；首次建立原生连接可能需要应用正常重启。通过 Codex 按技能流程核对免费模型并调用 ensure_workspace，使用新的专用样本目录及稳定任务身份。模型未知、不免费或原生权限等待时如实处理，不自动切模型。

```powershell
node scripts/doctor.mjs --live
```

本地诊断只查环境与原生 sessions 表结构；--live 进一步观察已存在的原生桥接和模型目录，不安装桥接、不重配模型、不重启应用。初装时 bridge_missing 是可解释状态，须先完成上述首次连接；不能靠重复运行 doctor 自动修复。login/quota 保持 unknown，诊断通过不等于任务已执行。

## 5. 升级、回退和卸载

先让所有任务完成验收或明确结束，并取得停止证明。仍有 working、needs_review 或停止不明记录时，安装程序拒绝变更。

若已安装常驻服务，先在原安装目录执行：

```powershell
node dist/service-cli.js uninstall --config "./data/persistent-service.json"
```

该流程先核对任务停止，再核对 Windows 服务 PID 的可执行文件和启动参数；归属不明则拒绝停止。它不停止 WorkBuddy 原生应用，不删除业务文件或任务历史。若使用自定义服务配置，传入对应真实路径。修改源码前退出旧 MCP 连接并备份原目录；保留自己的 .env、data 和旧版本源码/包。

```powershell
npm ci
npm run build
node scripts/setup.mjs upgrade --apply
node scripts/doctor.mjs
```

重新检查生成片段并连接 MCP。升级不会重放任务。需要回退时先按同样步骤确认停止，恢复之前备份的源码/包后重新构建，再运行 upgrade；不要使用另一份旧任务数据库覆盖现有历史。

```powershell
node scripts/setup.mjs uninstall
node scripts/setup.mjs uninstall --apply
```

前一条只预览。卸载删除未被本地修改的托管技能和生成片段，恢复首次安装前的技能备份，保留 .env、网关目录、任务数据与版本备份。用户改过的技能或片段会被保留并报错，不直接覆盖。Codex 配置条目需自行核对移除；不能盲目移除指向其他安装的 workbuddy 项。

若进程崩溃留下 data/setup-in-progress.json，先检查本轮结果与备份，确认没有另一个安装进程后再处理该记录。锁不会按时间自行失效，也不能以反复安装覆盖不明结果。

完成安装后按 [独立部署验收](DEPLOYMENT_ACCEPTANCE.md)检查。报告默认保留本机，公开前按贡献指南脱敏。
