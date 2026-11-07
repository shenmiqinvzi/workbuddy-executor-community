/**
 * L07 automation view: the saved dispatch policy, its revisions, the recorded
 * decisions and their audit trail.
 *
 * Boundaries this file keeps:
 *   - GET only. Saving a policy, revising it, revoking it and dispatching an
 *     automatic decision are trusted local operations (`scripts/automation.mjs`).
 *     There is no write verb on `/workbench/v1/automation`, and this file never
 *     asks for one: a browser tab holds no management authority.
 *   - textContent only. A policy scope, a block message and an audit detail are
 *     user or operator text and are never parsed as markup.
 *   - A recorded decision is not a running task. "结果不明" is printed as such,
 *     with the original operation named, instead of being retried or hidden.
 *   - A policy narrows dispatch. It never authorizes commit, push, deploy or a
 *     native approval, and the page says so where the policy is shown.
 */

const NA = "NA";
const ROOT = "/workbench/v1/automation";

export const POLICY_STATUS_LABELS = Object.freeze({
  active: "生效中",
  expired: "已过期",
  revoked: "已撤回",
  superseded: "已被新版本替代",
});

export const DECISION_STATUS_LABELS = Object.freeze({
  pending: "待派工",
  executing: "派工中",
  dispatched: "已派工",
  blocked: "已阻塞（未派工）",
  outcome_unknown: "结果不明（只观察原操作）",
  revoked: "撤回后未派工",
});

export const COST_MODE_LABELS = Object.freeze({
  free_only: "只允许可验证的免费模型",
  known_cost: "已知费用上限",
  unknown_allowed: "费用未知（不构成硬上限）",
});

/** A stored status code is shown with its label; an unknown code is shown as-is. */
export function statusLabel(status, table) {
  if (typeof status !== "string" || !status) return NA;
  return table[status] ?? status;
}

export function policyStatusLabel(status) {
  return statusLabel(status, POLICY_STATUS_LABELS);
}

export function decisionStatusLabel(status) {
  return statusLabel(status, DECISION_STATUS_LABELS);
}

/** One line describing what a saved policy actually permits. */
export function policyLine(policy) {
  if (!policy || typeof policy !== "object") return NA;
  const model = policy.executor?.modelId ?? NA;
  const effort = policy.executor?.reasoningEffort ? ` · 推理 ${policy.executor.reasoningEffort}` : " · 推理默认";
  const rounds = typeof policy.maxTasksPerWindow === "number" ? `${policy.maxTasksPerWindow} 次/窗口` : `${NA} 次/窗口`;
  return `${policy.workspaceId ?? NA} · ${model}${effort} · ${rounds} · ${policyStatusLabel(policy.status)}`;
}

export function costLine(cost) {
  if (!cost || typeof cost !== "object") return NA;
  const mode = COST_MODE_LABELS[cost.mode] ?? (typeof cost.mode === "string" ? cost.mode : NA);
  const unit = typeof cost.unit === "string" ? cost.unit : NA;
  if (cost.mode === "known_cost") return `${mode}：不超过 ${typeof cost.ceiling === "number" ? cost.ceiling : NA} ${unit}`;
  if (cost.mode === "free_only") return `${mode}：需要新鲜的 x0.00 证据，未取到即阻塞`;
  return `${mode}：未知价格不当作零，也不当作硬上限`;
}

export function scopeLine(scope) {
  if (!scope || typeof scope !== "object") return NA;
  const changes = Array.isArray(scope.allowedChanges) && scope.allowedChanges.length ? scope.allowedChanges.join("、") : NA;
  const metadata = Array.isArray(scope.permittedMetadata) && scope.permittedMetadata.length ? scope.permittedMetadata.join("、") : "无";
  return `可改：${changes}；允许的元数据：${metadata}`;
}

/** The blocking reason of a decision, in the order the server recorded it. */
export function blockLines(decision) {
  const blocks = Array.isArray(decision?.blocks) ? decision.blocks : [];
  if (!blocks.length) return [];
  return blocks.map(block => `${block?.code ?? NA}（${block?.field ?? NA}）：${block?.message ?? NA}`);
}

export function decisionLine(decision) {
  if (!decision || typeof decision !== "object") return NA;
  const rounds = decision.rounds && typeof decision.rounds.used === "number"
    ? `${decision.rounds.used}/${decision.rounds.limit} 次`
    : `${NA} 次`;
  const blocked = typeof decision.blockedCode === "string" && decision.blockedCode ? ` · ${decision.blockedCode}` : "";
  return `${decision.taskId ?? NA} · ${decisionStatusLabel(decision.status)}${blocked} · 窗口内 ${rounds}`;
}

/** An audit line names the action, the source that authorized it and when. */
export function auditLine(entry) {
  if (!entry || typeof entry !== "object") return NA;
  const target = entry.decisionId ?? entry.policyId ?? NA;
  return `${entry.action ?? NA} · ${entry.source ?? NA} · ${entry.actor ?? NA} · ${target} · ${entry.at ?? NA}`;
}

export const LAYER_LABELS = Object.freeze({
  installation_enabled: "① 安装级启用",
  process_armed: "② 进程内武装",
  policy_authorization: "③ 政策授权",
  per_task_selection: "④ 逐任务选择",
  recorded_decision: "⑤ 已记录决定",
  actual_dispatch: "⑥ 实际派工",
});

/**
 * One line per layer. The six are shown separately on purpose: a saved policy that is
 * enabled is still not armed, and an armed process still has not chosen a model for the
 * task in front of it.
 */
export function layerLine(layer) {
  if (!layer || typeof layer !== "object" || typeof layer.layer !== "string") return NA;
  const label = LAYER_LABELS[layer.layer] ?? layer.layer;
  const off = (value) => (value === true ? "是" : "否");
  switch (layer.layer) {
    case "installation_enabled":
      return `${label}：${off(layer.enabled)}（来源 ${layer.source ?? NA}）`;
    case "process_armed":
      return `${label}：武装 ${off(layer.armed)} · 派工器已接 ${off(layer.dispatcherWired)} · 观测 ${layer.probeKind ?? NA}`;
    case "policy_authorization": {
      const accepted = Array.isArray(layer.acceptedSources) ? layer.acceptedSources.join("/") : NA;
      return `${label}：只经 ${layer.writeEntry ?? NA} 写入 · 接受来源 ${accepted} · 当前政策 ${layer.policiesCurrent ?? NA}`;
    }
    case "per_task_selection":
      return `${label}：${layer.mode ?? NA} — ${layer.note ?? "每个新任务仍需用户确认选择"}`;
    case "recorded_decision":
      return `${label}：待派工 ${layer.pending ?? 0} · 阻塞 ${layer.blocked ?? 0} · 派工中 ${layer.executing ?? 0} · 已派工 ${layer.dispatched ?? 0} · 结果不明 ${layer.outcomeUnknown ?? 0} · 撤回未派工 ${layer.revoked ?? 0}`;
    case "actual_dispatch":
      return `${label}：经 ${layer.guardedService ?? NA} · 容量 ${layer.capacity ?? NA}`;
    default:
      return label;
  }
}

export function layerLines(describe) {
  const layers = Array.isArray(describe?.layers) ? describe.layers : [];
  return layers.map(layerLine);
}

/** What a blocked decision is actually waiting for, from the codes the server recorded. */
export const WAITING_LABELS = Object.freeze({
  QUOTA_UNAVAILABLE: "等新的额度观测（旧快照不算实时）",
  MODEL_UNVERIFIED: "等目录重新观测到该模型与推理档",
  EXECUTOR_UNAVAILABLE: "等执行器恢复可派工",
  EXECUTOR_BUSY: "等唯一容量位释放（不抢、不换机、不换库）",
  OBSERVATION_UNAVAILABLE: "等观测面可读后再评估",
  SCOPE_VIOLATION: "等范围内的任务，或由人修订政策",
  MODEL_POLICY_BLOCKED: "等模型策略允许该选择",
  DEADLINE_EXCEEDED: "等新政策或更短的任务时限",
  ATTEMPT_LIMIT: "等窗口内的轮次释放",
  TASK_CONFLICT: "该任务标识已被占用，不会替换",
  POLICY_EXPIRED: "政策已到期，需要人重新保存",
  POLICY_REVOKED: "政策已撤回，不再派工",
  COST_CONTROL_UNAVAILABLE: "费用无法硬封顶，不做自动派工",
  QUOTA_EXHAUSTED: "额度不足",
  WORKSPACE_CONFLICT: "工作区身份不一致，需要人确认",
});

export function waitingLine(decision) {
  const blocks = Array.isArray(decision?.blocks)
    ? decision.blocks
    : (Array.isArray(decision?.evaluation?.blocks) ? decision.evaluation.blocks : []);
  if (!blocks.length) return "没有记录等待条件。";
  return blocks
    .map(block => `${block?.code ?? NA}：${WAITING_LABELS[block?.code] ?? "等该阻塞原因消失"}`)
    .join("；");
}

/** The observation a decision was taken under: when, from which surface, with what coverage. */
export function probeLine(probe) {
  if (!probe || typeof probe !== "object") return "没有记录观测；未声明的观测不等于免费。";
  const coverage = probe.coverage && typeof probe.coverage === "object" ? probe.coverage : {};
  return `观测 ${probe.observedAt ?? NA} · ${probe.probeVersion ?? NA} · 执行器 ${coverage.executors ?? NA} · 目录 ${coverage.catalog ?? NA} · 费用证据 ${coverage.costEvidence ?? NA} · 任务归因 ${coverage.taskAttribution ?? NA}`;
}

/** Each read surface with the status it reported, so a stale or missing one is visible. */
export function probeSourceLines(probe) {
  const sources = Array.isArray(probe?.sources) ? probe.sources : [];
  return sources.map((source) => {
    const head = `${source?.source ?? NA}：${source?.status ?? NA}（${source?.entries ?? 0} 条）`;
    return source?.detail ? `${head}— ${source.detail}` : head;
  });
}

/** The shell's declared task deep link; a decision is only ever linked, never re-opened here. */
export function taskLink(taskId) {
  if (typeof taskId !== "string" || !taskId) return null;
  return `#taskId=${encodeURIComponent(taskId)}`;
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "onclick" || key === "onchange" || key === "oninput") node.addEventListener(key.slice(2), value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
  return node;
}

function section(title, note) {
  return h("section", { class: "automation-section" },
    h("h2", { class: "automation-heading", text: title }),
    note ? h("p", { class: "automation-note", text: note }) : null);
}

function lines(list, className, empty) {
  return h("ul", { class: "automation-list" },
    ...(list.length ? list.map(text => h("li", { class: className === "block" ? "automation-block" : "automation-limit", text })) : [h("li", { class: "automation-empty", text: empty })]));
}

/** Mount the automation view into a host element owned by the shell. */
export function mountAutomation({ root, fetchJson }) {
  if (!root) throw new Error("mountAutomation needs a root element");
  if (typeof fetchJson !== "function") throw new Error("mountAutomation needs a fetchJson function");
  let disposed = false;
  let snapshotRequest = 0;
  let policyRequest = 0;
  let decisionRequest = 0;

  const stateHost = h("dl", { class: "automation-config" });
  const layerList = h("ul", { class: "automation-list", "aria-live": "polite" });
  const refresh = h("button", { type: "button", class: "automation-button", text: "刷新政策快照" });
  const snapshotIssues = h("p", { class: "automation-issue", role: "status" });
  const policyList = h("ul", { class: "automation-list", "aria-live": "polite" });
  const policyDetail = h("div", { class: "automation-detail" });
  const decisionList = h("ul", { class: "automation-list", "aria-live": "polite" });
  const decisionDetail = h("div", { class: "automation-detail" });
  const auditList = h("ul", { class: "automation-list", "aria-live": "polite" });

  async function loadSnapshot() {
    const request = ++snapshotRequest;
    refresh.disabled = true;
    try {
      const body = await fetchJson(ROOT);
      if (disposed || request !== snapshotRequest) return;
      stateHost.replaceChildren(
        h("dt", { text: "政策保存入口" }),
        h("dd", { text: body?.writeEntry === "local_cli_only" ? "本机命令行（scripts/automation.mjs）" : NA }),
        h("dt", { text: "浏览器可写" }),
        h("dd", { text: body?.httpWrites === true ? "未知" : "没有；此页只读" }),
        h("dt", { text: "政策已启用" }),
        h("dd", { text: body?.enabled === true ? "已启用" : "未启用（默认）" }),
        h("dt", { text: "派工闸门" }),
        h("dd", { text: body?.armed === true ? "运行进程已武装" : "未武装：即使有政策也不会派工" }),
        h("dt", { text: "观测方式" }),
        h("dd", { text: body?.probeKind === "read_only_local" ? "本机只读组合观测（资源声明/额度/信用/目录）" : body?.probeKind === "snapshot_file" ? "录制的观测文件（非实时）" : body?.probeKind === "injected" ? "注入的观测（调用方提供）" : "未记录观测" }),
        h("dt", { text: "存储 schema" }),
        h("dd", { text: typeof body?.schemaVersion === "number" ? String(body.schemaVersion) : NA }));
      const layers = layerLines(body);
      layerList.replaceChildren(...(layers.length
        ? layers.map(text => h("li", { class: "automation-item" }, h("span", { class: "automation-item-text", text })))
        : [h("li", { class: "automation-empty", text: "分层信息未提供：无法区分安装启用、进程武装与政策授权。" })]));
      const policies = Array.isArray(body?.policies) ? body.policies : [];
      policyList.replaceChildren(...(policies.length
        ? policies.map(policy => h("li", { class: "automation-item" },
          h("span", { class: "automation-item-text", text: policyLine(policy) }),
          h("button", {
            type: "button",
            class: "automation-link",
            text: "版本历史",
            "aria-label": `查看政策 ${policy.policyId} 的版本`,
            onclick: () => loadPolicyDetail(policy.policyId),
          })))
        : [h("li", { class: "automation-empty", text: "还没有保存的自动政策；默认模式仍是推荐。" })]));
      const decisions = Array.isArray(body?.decisions) ? body.decisions : [];
      decisionList.replaceChildren(...(decisions.length
        ? decisions.map(decision => h("li", { class: "automation-item" },
          h("span", { class: "automation-item-text", text: decisionLine(decision) }),
          h("button", {
            type: "button",
            class: "automation-link",
            text: "决定详情",
            "aria-label": `查看决定 ${decision.decisionId} 的评估`,
            onclick: () => loadDecisionDetail(decision.decisionId),
          })))
        : [h("li", { class: "automation-empty", text: "还没有记录到自动决定。" })]));
      const audit = Array.isArray(body?.audit) ? body.audit : [];
      auditList.replaceChildren(...(audit.length
        ? audit.map(entry => h("li", { class: "automation-item" },
          h("span", { class: "automation-item-text", text: auditLine(entry) })))
        : [h("li", { class: "automation-empty", text: "还没有审计记录。" })]));
      snapshotIssues.textContent = "";
    }
    catch (error) {
      if (disposed || request !== snapshotRequest) return;
      snapshotIssues.textContent = `政策快照读取失败：${error?.message ?? "未知错误"}`;
      // A failed read is not an empty policy: say that the lists could not be
      // read instead of painting "no policy saved".
      policyList.replaceChildren(h("li", { class: "automation-empty", text: "政策列表未能读取。" }));
      decisionList.replaceChildren(h("li", { class: "automation-empty", text: "决定列表未能读取。" }));
      auditList.replaceChildren(h("li", { class: "automation-empty", text: "审计列表未能读取。" }));
      layerList.replaceChildren(h("li", { class: "automation-empty", text: "分层信息未能读取。" }));
    }
    finally {
      if (!disposed && request === snapshotRequest) refresh.disabled = false;
    }
  }

  async function loadPolicyDetail(policyId) {
    const request = ++policyRequest;
    try {
      const body = await fetchJson(`${ROOT}/policies/${encodeURIComponent(policyId)}`);
      if (disposed || request !== policyRequest) return;
      const policy = body?.policy ?? {};
      const revisions = Array.isArray(body?.revisions) ? body.revisions : [];
      policyDetail.replaceChildren(
        h("h3", { class: "automation-subheading", text: `政策 ${policyId}` }),
        h("p", { class: "automation-item-text", text: `当前版本 ${policy.revision ?? NA} · ${policyStatusLabel(body?.status)}` }),
        h("p", { class: "automation-item-text", text: costLine(policy.cost) }),
        h("p", { class: "automation-item-text", text: scopeLine(policy.scope) }),
        h("p", { class: "automation-item-text", text: `到期 ${policy.expiresAt ?? NA} · 授权来源 ${policy.authorizationSource ?? NA}` }),
        policy.revocationReason ? h("p", { class: "automation-issue", text: `撤回原因：${policy.revocationReason}` }) : null,
        h("h3", { class: "automation-subheading", text: "版本" }),
        h("ul", { class: "automation-list" }, ...(revisions.length
          ? revisions.map(item => h("li", { class: "automation-item" },
            h("span", { class: "automation-item-text", text: `${item.revision ?? NA} · ${policyStatusLabel(item.status)}${item.current ? " · 当前" : ""}` }),
            h("span", { class: "automation-meta", text: item.createdAt ?? NA })))
          : [h("li", { class: "automation-empty", text: "没有版本记录。" })])),
        h("p", { class: "automation-note", text: "修订、撤回与续期都在本机命令行完成，并留下授权来源和审计；页面不能修改政策。" }));
    }
    catch (error) {
      if (disposed || request !== policyRequest) return;
      policyDetail.replaceChildren(h("p", { class: "automation-issue", text: `政策读取失败：${error?.message ?? "未知错误"}` }));
    }
  }

  async function loadDecisionDetail(decisionId) {
    const request = ++decisionRequest;
    try {
      const body = await fetchJson(`${ROOT}/decisions/${encodeURIComponent(decisionId)}`);
      if (disposed || request !== decisionRequest) return;
      const decision = body?.decision ?? {};
      const evaluation = decision.evaluation ?? {};
      const blocks = blockLines(evaluation);
      const limits = Array.isArray(evaluation.limits) ? evaluation.limits : [];
      const probe = decision.probe ?? evaluation.probe ?? null;
      const sources = probeSourceLines(probe);
      const link = taskLink(decision.taskId);
      decisionDetail.replaceChildren(
        h("h3", { class: "automation-subheading", text: `决定 ${decisionId}` }),
        h("p", { class: "automation-item-text", text: `${decision.taskId ?? NA} · ${decisionStatusLabel(decision.status)}` }),
        h("p", { class: "automation-item-text", text: `政策 ${decision.policyId ?? NA}@${decision.policyRevision ?? NA} · 评估 ${evaluation.decision ?? NA}` }),
        h("p", { class: "automation-item-text", text: costLine(evaluation.cost) }),
        h("p", { class: "automation-item-text", text: `方案 ${decision.planId ?? NA} · 操作 ${decision.operationId ?? NA}` }),
        link ? h("p", { class: "automation-item-text" }, h("a", { class: "automation-link", href: link, text: "查看原任务" })) : null,
        h("p", { class: "automation-item-text", text: `实际请求身份 ${decision.requestedBy ?? NA}` }),
        h("h3", { class: "automation-subheading", text: "等待条件" }),
        h("p", { class: "automation-item-text", text: waitingLine(decision) }),
        h("h3", { class: "automation-subheading", text: "当时的观测" }),
        h("p", { class: "automation-item-text", text: probeLine(probe) }),
        lines(sources, "limit", "没有记录观测来源；未声明不等于免费。"),
        h("h3", { class: "automation-subheading", text: "阻塞原因" }),
        lines(blocks, "block", "没有阻塞原因。"),
        h("h3", { class: "automation-subheading", text: "已知限制" }),
        lines(limits, "limit", "没有记录额外限制；这不等于没有限制。"),
        h("p", { class: "automation-note", text: "结果不明时只能观察原操作：不新建任务、不换执行器、不按超时释放占用。" }));
    }
    catch (error) {
      if (disposed || request !== decisionRequest) return;
      decisionDetail.replaceChildren(h("p", { class: "automation-issue", text: `决定读取失败：${error?.message ?? "未知错误"}` }));
    }
  }

  refresh.addEventListener("click", loadSnapshot);

  root.replaceChildren(h("div", { class: "automation" },
    section("授权状态", "自动政策只收窄派工范围。它不授权提交、推送、部署或原生权限批准，也不替代 AGENTS.md 的逐任务选择确认。"),
    h("div", { class: "automation-toolbar" }, refresh),
    snapshotIssues,
    stateHost,
    h("h3", { class: "automation-subheading", text: "六层边界" }),
    h("p", { class: "automation-note", text: "启用、武装、政策授权、逐任务选择、记录决定与实际派工是六件不同的事；任何一层没到位，都不会有自动派工。" }),
    layerList,
    section("已保存政策", "政策绑定工作区、执行器、精确模型、范围、轮次、费用条件与到期；修订产生新版本，旧版本保留并标记为已被替代。"),
    policyList,
    policyDetail,
    section("自动决定", "每个决定绑定任务、方案、政策版本、评估解释和操作意图；派工前会在同一事务里重新核验授权、撤回、到期、范围、费用与容量。"),
    decisionList,
    decisionDetail,
    section("审计", "保存、修订、撤回、记录决定与派工意图都留一条审计，含授权来源。这里只显示已存的记录。"),
    auditList));

  loadSnapshot();
  return {
    dispose() { disposed = true; },
    reload() {
      if (disposed) return;
      loadSnapshot();
    },
  };
}
