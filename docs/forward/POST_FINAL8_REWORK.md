# post-final8 返工（final10 验收后）

对应复核 `E:\javaproject\outputs\codex-post-final8-review-20261107\REVIEW.md` 的三项，全部落在本轮分支上，
证据在 `E:\javaproject\outputs\forward-delivery-20261107\post-final8\`。

## 1. 快照遗漏一条已跟踪测试

`verify-snapshot.mjs` 原先报 `Snapshot manifest omits 1 tracked file(s): test/readiness-pipe-identity.test.ts`。
原因是生成清单时该文件还没进入 Git 跟踪集，生成器看不见它。

修法：先提交文件，再在**干净树**上重生成，然后在最终提交后复验。

```
{"files":438,"capturedAt":"2026-10-23T00:39:39.586Z"}
{"snapshotFilesVerified":438,"hashesMatch":true,"manifestCompleteness":"checked"}
```

提交 `a10600c`；复验输出存 `post-final8\snapshot-verify-clean.txt`。

## 2. 回退示例原先指向「旧包→旧包」

`INSTALL_PLAN.md` 把 `--package` 与 `--to` 都写成旧候选，只能生成旧包到旧包的计划。
现改为「当前包 → 实际回退目标」，并在 final10 演练根实跑：

`rollback-plan-final10-to-final8.json`：`safeToApply:true`、9 步、保留 745 个文件、
`from.sha256 = d2177267…`、`to.sha256 = 8ca1e719…`；同时声明 `.env` 不改、`data/runs/` 不被重写、
已注册常驻服务须先卸载、替换文件不改变正在运行的进程。

## 3. 双端样本从概述变成可执行

`post-final8\samples\` 下两个独立工作区，各有：唯一写权限的目标文件、非空 `CommandSpec`、
**不复用测试文件**的独立语义检查、参考改动。

| 样本 | 写范围 | 命令 | 语义检查 |
|---|---|---|---|
| `workbuddy-sample` | `src/summarize.mjs` | `node --test test/summarize.test.mjs` | `node semantic.mjs` |
| `dsh-sample` | `src/ranges.mjs` | `node --test test/ranges.test.mjs` | `node semantic.mjs` |

`node samples\run-sample.mjs` → `{"samples":2,"ok":true}`：两个样本基线都红（命令 1 / 语义 1），
套用参考改动后都绿（0 / 0）。输出存 `post-final8\samples-run.json`。

绑定改为当前候选：`candidate-final10`（`d2177267…`）+ `install-prep-final10\gateway`（`doctor ok`，`codeHash e9992226…`）。
DSH 的模型目录写清来自 Harness 自身，不是 `workbuddy_list_models`。

## 4. 验收顺序改正

原先文档把「程序批次」写在「服务端按原 CommandSpec 复跑」之前。现按
原生停止确认 → 服务端复跑 → `check_task` 批次 → 独立语义与 inspection → `review_task` → 当前 revision `accept_task` → `task_closed`。

## 5. 可独立交付的材料

`CROSS_MACHINE_INDEX.md`（待机器）、`CI_MATERIALS.md`（待远端）、`RELEASE_MATERIALS.md`（待权利人/远端），
逐项标出谁提供、判据是什么、以及哪些话不许说。

## 6. 本轮补上的程序级保护（junction）


pm ci 会清空它写入的目录。当安装根的 
ode_modules 是目录联接时，npm 跟随联接，被清空的是**联接目标**——可能是另一棵树的依赖。

现在两个入口都在 
pm ci 之前拒绝：

| 入口 | 位置 | 拒绝方式 |
|---|---|---|
| 编译路径 | gateway/src/installation-bootstrap.ts 的 planInstallationBootstrap | blocker 
ode_modules_link / 
ode_modules_link_dangling / 
ode_modules_unverifiable，该步 skipped，runner 不会被调用 |
| 无 dist 首次运行 | gateway/scripts/bootstrap.mjs | 打印 locked node_modules_link… 与 Refusing to run npm ci through it…，exit 1，在 
pm ci 之前 |

正常路径不变：真实目录与空安装根照常安装（install-prep-final11 实测 
pm ci --omit=dev ok、93 包）。

对照证据：修前 ootstrap-compiled-link-before.log 里联接下 ok npm_ci 且哨兵文件被删；修后 ootstrap-compiled-link-after.log 里 locked node_modules_link 且哨兵完好。
