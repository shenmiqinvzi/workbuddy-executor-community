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
        h("dt", { text: "存储 schema" }),
        h("dd", { text: typeof body?.schemaVersion === "number" ? String(body.schemaVersion) : NA }));
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
      decisionDetail.replaceChildren(
        h("h3", { class: "automation-subheading", text: `决定 ${decisionId}` }),
        h("p", { class: "automation-item-text", text: `${decision.taskId ?? NA} · ${decisionStatusLabel(decision.status)}` }),
        h("p", { class: "automation-item-text", text: `政策 ${decision.policyId ?? NA}@${decision.policyRevision ?? NA} · 评估 ${evaluation.decision ?? NA}` }),
        h("p", { class: "automation-item-text", text: costLine(evaluation.cost) }),
        h("p", { class: "automation-item-text", text: `方案 ${decision.planId ?? NA} · 操作 ${decision.operationId ?? NA}` }),
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
