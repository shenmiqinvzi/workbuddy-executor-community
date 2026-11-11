# WB42 · CI 就绪、本地复演与未取得回执

结论先说：**CI 定义已就绪，本地可复演的部分全部跑过；远端回执（`ci` 证据维度）仍为空。** 本文件不把「workflow 文件写好了」当成「CI 通过了」。

## 1. CI 作业清单

| 文件 | 运行器 | 覆盖 | 本轮变化 |
|---|---|---|---|
| `.github/workflows/forward-gate.yml` | windows-latest | 快照校验 → `npm ci` → build → `typecheck:task-view` → **`npm run acceptance:check`** → 串行后端套件 → workbench → desktop:test → 打包 + `candidate-installation check` → workbench HTTP smoke | 新增验收矩阵守卫步骤 |
| `.github/workflows/release-pairing.yml` | windows-latest | `npm ci` → build → `package` → `desktop:build` → `desktop:package` → **`verify-pairing`** → `candidate-installation check` → 上传两个 ZIP | **新增** |
| `.github/workflows/posix-bridge.yml` | ubuntu-latest | 三个 POSIX 专有测试（Unix socket、`*.sock` 隐私、`#!/bin/sh` 启动器） | 未改 |
| `.github/workflows/windows-gateway.yml` | windows-latest | 显式文件清单 + 技能六文件逐字比对 | 未改 |

`forward-gate.yml` 顶部注释保留原意：CI 层证据在**真的跑过之前为空**。`release-pairing.yml` 沿用同一口径，并写清「本地配对报告不借用 CI 回执」。

## 2. 本地复演（本机，2026-11-11）

| CI 步骤 | 本地等价命令 | 结果 |
|---|---|---|
| Install locked dependencies | `npm ci` | 早期在 `Q-desktop-closeout` 上跑过；本轮工作树用 junction 复用 `node_modules`，未重复 `npm ci`（会影响共享目录） |
| Build | `npx tsc -p tsconfig.json` | exit 0 |
| Type check TaskView | `npm run typecheck:task-view` | exit 0 |
| Acceptance matrix guard | `npm run acceptance:check` | `acceptance matrix ok: 53 scenarios, 31 original tasks mapped` |
| Backend suite | `node --import tsx --test test/**/*.test.ts`（**并行**，CI 是 `--test-concurrency=1`） | 1563 / 1551 pass / 0 fail / 12 skip |
| Workbench frontend | `npm run test:workbench` | 169 / 169 |
| Desktop policy | `npm run desktop:test` | 133 pass / 0 fail / 1 skip（symlink 权限） |
| Package + candidate check | `npm run package` + `candidate-installation check` | `ok:true`、782 files、`problems:[]` |
| Pairing | `npm run release:pairing` | `ok:true`、shared 782、mismatched 0 |
| Snapshot verify | `node verify-snapshot.mjs` | **先失败**：`Snapshot mismatch: package.json` —— 见下节，属冻结步骤的顺序要求 |

差异要说清：CI 用**串行**跑后端套件（并发下 SQLite/命名管道会互相干扰，历史上出现过三次 flap），本轮全绿证据是**并行**跑出来的；串行在本机没有重跑（约 60 分钟），因此「CI 的串行模式通过」这一条**没有**本地证据，只能靠远端回执。

## 3. 顺序要求：快照清单必须在冻结前重生成

`verify-snapshot.mjs` 逐文件比对 `gateway/SNAPSHOT_MANIFEST.json` 的 `bytes` + `sha256`。只要本轮还改过 gateway 里的源码、脚本或技能文档，它就会失败（本轮实测：`Snapshot mismatch: package.json`）。正确顺序：

1. 所有 gateway 源码/脚本/技能改动结束；
2. `git add -N` 新增文件（生成器走 `git ls-files`，未跟踪文件不会进清单）；
3. `node scripts/generate-snapshot-manifest.mjs`；
4. `node verify-snapshot.mjs` → 必须 exit 0；
5. 再打包、再配对、再记录候选。

这条顺序也是 CI 第一道门禁能过的前提；把它写在这里，是因为「最后再生成清单」很容易被漏掉。

## 4. 为什么回执为空

- 本会话没有推送权限与远端触发：没有 `gh` 凭据，也没有向仓库 push（未获授权）。因此 `ci` 维度下所有项保持 `unknown`。
- `posix-bridge.yml` 在 ubuntu 跑，本机是 Windows，无法本地复演。
- 远端 CI 回执要能作为证据，还需要：一次成功运行 + 运行 ID + 提交 SHA 与候选 SHA 一致。三者缺一，都不能写成「CI 通过」。

## 5. 未覆盖

- 远端 CI 实跑回执（需 push + 触发）。
- 串行套件在本机的复跑（时间成本，且串行口径与并行结论不冲突，但不等价）。
- `actions/upload-artifact` 上传后的可下载性验证（需远端）。

## 6. 首轮远端运行：零作业失败的真因（已修）

推送后远端确实起了运行，但两个工作流都以「零作业」失败。配额恢复后读到注解，真因不是策略拦截，
而是**工作流在启动前就被判定非法**：

```
Invalid workflow file: .github/workflows/forward-gate.yml#L1
(Line: 31, Col: 29): Unrecognized named-value: 'runner'.
Located at position 1 within expression: runner.temp
```

两个文件都在 `jobs.<id>.env` 里写了 `WORKBUDDY_CONFIG_DIR: ${{ runner.temp }}\…`。
`runner` 上下文要等 runner 分配后才存在，而 job 级 `env` 在此之前求值，所以 GitHub 直接拒绝整个工作流——
连一个 job 都不会创建。运行页只显示 Failure，`/jobs` 返回 `total_count: 0`，看起来像基础设施故障。

| 运行 | 工作流 | head | 结果 | 原因 |
| --- | --- | --- | --- | --- |
| [43008444151](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/runs/43008444151) | Forward gate | `41e9595` | Failure，0 作业 | `runner` 出现在 job `env` |
| [43008446862](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/runs/43008446862) | Release pairing | `41e9595` | Failure，0 作业 | 同上 |
| [43025909035](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/runs/43025909035) | Forward gate | `5bd3c14` | Failure，0 作业 | 同上（未修之前） |
| [43025910876](https://github.com/shenmiqinvzi/workbuddy-executor-community/actions/runs/43025910876) | Release pairing | `5bd3c14` | Failure，0 作业 | 同上 |

### 修法（提交 `b8d0c09`）

1. 删掉两个 job 的 `env:` 块；改由第一步在 runner 上决定目录并写进 `GITHUB_ENV`：

```yaml
- name: Prepare an empty configuration directory
  run: |
    $config = Join-Path $env:RUNNER_TEMP 'workbuddy-gate-config'
    New-Item -ItemType Directory -Force -Path $config | Out-Null
    "WORKBUDDY_CONFIG_DIR=$config" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
    "config dir: $config"
```

   后续每个 step 都能读到它，语义与原来一致：测试仍然不会碰到任何用户配置目录。
2. 新增 `gateway/test/workflow-contexts.test.ts`：扫描 `.github/workflows/*.yml`，只要 job 级 `env` 里出现
   `${{ runner.` 就失败；同时要求每个工作流有 `name`/`on`/`permissions`/`jobs`、无制表符缩进、并且两个 gate
   都用 `GITHUB_ENV` 发布配置目录。这类错误在本地跑不出来（本地没有 GitHub 的求值器），只能靠结构守卫。
3. 给两个工作流补 `push` 触发（`main` 与 `feat/**`）：没有它时，想看到 gate 跑起来需要登录态 dispatch
   或开一个 PR，正是这一轮拿不到回执的另一半原因。

### 现在的状态

修复后推送会真的创建作业（`jobs=1`, `gate in_progress`），CI 这一维从「定义就绪但从未启动」变成
「能启动，等一次绿色运行」。**在绿色运行出现之前，CI 仍记为 `notObserved`**；出现之后才把
`evidence.ci` 写进 `final-state.json` 并同步本节。

### 这轮学到的两件事

- 「零作业的 Failure」优先怀疑工作流求值失败，而不是 runner 或配额；运行页里那句
  `Invalid workflow file … Unrecognized named-value` 才是唯一可信的线索，注解读不到时不要猜。
- `runner` / `env` 这类上下文在不同层级可用性不同，属于「本地一定过、远端必挂」的类别，适合用结构测试兜住。
