// Resource reference for a prepared task draft. Read-only: it reads the same
// saved gateway snapshot the resource page uses and never collects upstream.
import { formatStamp, formatCredits, formatTokens } from "./resources-model.mjs";

export const PLAN_REFERENCE_PATH = "/workbench/v1/resources/plan-reference";

export function executionKey(execution) {
  if (!execution) return null;
  return [
    execution.executorId,
    execution.connectionId,
    execution.providerId,
    execution.modelId,
    execution.reasoningEffort ?? "",
  ].join("|");
}

export function referenceQuery(execution) {
  const params = new URLSearchParams({
    executorId: execution.executorId,
    connectionId: execution.connectionId,
    providerId: execution.providerId,
    modelId: execution.modelId,
  });
  if (execution.reasoningEffort) params.set("reasoningEffort", execution.reasoningEffort);
  return `${PLAN_REFERENCE_PATH}?${params.toString()}`;
}

const HEADLINES = {
  unlinked: "尚未建立该执行来源与统计连接的关联。",
  link_invalid: "关联声明无法作为依据，按未建立关联处理。",
  linked_not_configured: "已声明关联，但该统计来源尚未配置。",
  linked_not_observed: "已声明关联，但尚未观测到该模型的读数。",
  linked_no_snapshot: "已声明关联，但该统计连接还没有已保存的快照。",
  linked_rows_elsewhere: "已声明关联，但这张池的汇总行由其他来源提供，因此不借用其数值。",
  linked_realm_mismatch: "已声明关联，但该统计来源在声明限定的区域内没有该模型的读数。",
  linked_ambiguous: "关联声明存在冲突，无法确定该方案对应的统计来源。",
  linked: "已按声明关联到该执行选择的统计来源。",
};

const FRESHNESS_TEXT = { fresh: "新鲜（在有效期内）", stale: "陈旧（超出有效期或最近一次采集报错）", unavailable: "无法判断（缺少来源时间）" };
const AVAILABILITY_TEXT = { available: "未观测到耗尽证据", exhausted: "已证实耗尽（存在触顶证据）", unknown: "可用性未知" };
const COVERAGE_TEXT = { complete: "完整", partial: "部分覆盖（只为已知部分之和）", unavailable: "不可用" };

function limitationsOf(list) {
  return Array.isArray(list) ? list : [];
}

export function describeReference(document) {
  if (!document) return { headline: "尚未读取资源参考。", lines: [], caveats: [] };
  const status = document.association?.status ?? "unlinked";
  const headline = HEADLINES[status] ?? HEADLINES.unlinked;
  const lines = [];
  const caveats = [];
  const quota = document.quota ?? null;
  const credit = document.credit ?? null;
  const quotaLimitations = limitationsOf(quota?.limitations);
  const creditLimitations = limitationsOf(credit?.limitations);

  if (quota) {
    lines.push({ label: "统计来源", value: quota.connectionId });
    lines.push({ label: "剩余 token", value: quota.remaining === null ? "未提供" : formatTokens(quota.remaining) });
    lines.push({ label: "已用 token", value: quota.used === null ? "未提供" : formatTokens(quota.used) });
    lines.push({ label: "预算 token", value: quota.budget === null ? "未提供" : formatTokens(quota.budget) });
    lines.push({ label: "单位", value: "token" });
    lines.push({ label: "估算属性", value: quota.valueKind === "estimated" ? "估算值，不是上游精确计量" : "不可得" });
    lines.push({ label: "可用性", value: AVAILABILITY_TEXT[quota.availability] ?? "可用性未知" });
    lines.push({ label: "共享范围", value: "网关共享池（不是本任务独占）" });
    lines.push({ label: "来源时间", value: formatStamp(quota.sourceObservedAt) });
    lines.push({ label: "采集时间", value: formatStamp(quota.collectedAt) });
    lines.push({ label: "有效期", value: formatStamp(quota.expiresAt) });
    lines.push({ label: "新鲜度", value: FRESHNESS_TEXT[quota.freshness] ?? "无法判断" });
    lines.push({ label: "快照", value: quota.snapshotId ?? "未提供" });
    if (quota.resetAt) lines.push({ label: "重置时间", value: formatStamp(quota.resetAt) });
  }

  if (credit) {
    lines.push({ label: "积分来源", value: credit.connectionId });
    lines.push({ label: "积分余额", value: credit.balance === null ? "未提供" : formatCredits(credit.balance) });
    lines.push({ label: "单位", value: "积分（不是货币）" });
    lines.push({ label: "覆盖范围", value: COVERAGE_TEXT[credit.coverage] ?? "不可用" });
    lines.push({ label: "账号覆盖", value: `${credit.accountsWithData} / ${credit.accountsEnabled}` });
    lines.push({ label: "成员最新观测", value: formatStamp(credit.latestMemberObservedAt) });
    lines.push({ label: "缓存读取", value: FRESHNESS_TEXT[credit.cacheFreshness] ?? "无法判断" });
    lines.push({ label: "余额新鲜度", value: credit.balanceFreshness === "stale" ? "陈旧（成员观测早于缓存窗口）" : "无法判断" });
  }

  if (document.otherQuotaSources?.length) {
    caveats.push(`另有 ${document.otherQuotaSources.length} 个来源报告过该范围，仅作为独立证据列出，不参与这里的读数。`);
  }
  caveats.push("token 与积分分开展示；积分不是货币，两者不相加。");
  if (credit?.coverage === "partial") caveats.push("积分覆盖不完整，余额只是已知部分之和。");
  if (quota && quota.freshness !== "fresh") caveats.push("该快照不是新鲜的：读数保留，但不代表当前上游状态。");
  if (quotaLimitations.includes("budget_estimated")) caveats.push("预算与剩余量是估算，不是上游精确计量。");
  if (quotaLimitations.includes("shared_pool") || creditLimitations.includes("shared_region_pool")) {
    caveats.push("这是区域共享池，不是本任务独占或已预留的额度。");
  }
  if (status === "unlinked") caveats.push("没有可核验的执行来源与统计连接关联，因此这里不展示该方案的资源读数。");
  if (status === "link_invalid") caveats.push("关联声明文件不可用或格式不符，无法作为关联依据。");
  if (status === "linked_rows_elsewhere") caveats.push("汇总行由其他连接提供，本次不借用其数值，也不提升证据等级。");
  if (status === "linked_realm_mismatch") caveats.push("该统计来源在此声明区域内没有该模型的读数，因此不展示读数；这不表示余额为零、未配置或尚未采集。");
  if (status === "linked_ambiguous") {
    caveats.push("同一执行选择有多条关联声明；这里不按声明顺序选择来源。");
    caveats.push("因此不展示任何一条来源的 token 或积分读数。");
    caveats.push("关联冲突只影响资源参考，核对、确认与准入仍按原流程进行。");
  }
  if (document.creditState === "realm_mismatch") caveats.push("积分来源的区域与声明限定的区域不一致，因此不展示该积分余额；这不表示余额为零、未配置或尚未采集。");
  if (document.creditState === "ambiguous") caveats.push("关联存在冲突，不展示任何积分余额。");
  if (document.creditState === "not_observed") caveats.push("积分连接已配置，但尚未观测到积分数据。");
  if (document.creditState === "no_snapshot") caveats.push("积分连接还没有已保存的积分缓存。");
  caveats.push("这些数据是资源参考，不证明本任务实际可用，不代表任务费用，也不是硬费用上限。");
  caveats.push("来源与本任务的路由仍未验证（routing_unverified），不能据此推断本任务可用额度。");
  caveats.push("推理档位不单独计量。");

  return { headline, lines, caveats, attribution: document.attribution ?? "none" };
}

export function createReferenceLoader({
  fetchImpl = (url, init) => globalThis.fetch(url, init),
  timeoutMs = 8000,
  onChange = () => {},
} = {}) {
  let serial = 0;
  let controller = null;
  let destroyed = false;
  const state = { execution: null, identity: null, loading: false, document: null, error: null };

  function abort() {
    serial += 1;
    controller?.abort();
    controller = null;
  }

  return {
    state,
    bind(execution, identity = null) {
      if (destroyed) return false;
      if (executionKey(execution) === executionKey(state.execution) && identity === state.identity) return false;
      abort();
      state.execution = execution ?? null;
      state.identity = identity;
      state.document = null;
      state.error = null;
      state.loading = false;
      onChange(state);
      return true;
    },
    async load(force = false) {
      if (destroyed || !state.execution) return;
      if (!force && state.loading) return;
      abort();
      const ticket = serial;
      const execution = state.execution;
      controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      state.loading = true;
      state.error = null;
      onChange(state);
      try {
        const response = await fetchImpl(referenceQuery(execution), {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal,
        });
        const body = await response.json().catch(() => null);
        if (ticket !== serial || destroyed) return;
        if (!response.ok) {
          state.error = { code: body?.error?.code ?? "HTTP_STATUS" };
        } else if (body?.execution?.modelId && body.execution.modelId !== execution.modelId) {
          // The answer must describe this exact selection; a different model means
          // the transport mixed two reads and the panel keeps nothing.
          state.error = { code: "IDENTITY_MISMATCH" };
        } else {
          state.document = body;
        }
      } catch (error) {
        if (ticket !== serial || destroyed) return;
        if (error?.name !== "AbortError") state.error = { code: error?.code ?? "NETWORK_ERROR" };
      } finally {
        if (ticket === serial && !destroyed) {
          state.loading = false;
          onChange(state);
        }
      }
    },
    reset() {
      abort();
      state.execution = null;
      state.identity = null;
      state.document = null;
      state.error = null;
      state.loading = false;
      if (!destroyed) onChange(state);
    },
    destroy() {
      destroyed = true;
      abort();
      state.document = null;
    },
  };
}

export function mountPlanReference(host, { onOpenResources = null, now = () => new Date() } = {}) {
  const root = document.createElement("section");
  root.className = "plan-resource";
  root.id = "plan-resource";
  root.setAttribute("aria-label", "资源参考");
  const head = document.createElement("header");
  head.className = "plan-resource-head";
  const title = document.createElement("h3");
  title.textContent = "资源参考";
  head.append(title);
  const body = document.createElement("div");
  body.id = "plan-resource-body";
  body.className = "plan-resource-body";
  body.setAttribute("aria-busy", "false");
  root.append(head, body);
  host.replaceChildren(root);

  let destroyed = false;
  const loader = createReferenceLoader({ onChange: () => render() });
  const state = loader.state;

  function actionBar() {
    const actions = document.createElement("div");
    actions.className = "plan-resource-actions";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "text-button";
    refresh.id = "plan-resource-refresh";
    refresh.textContent = "重新读取已保存快照";
    refresh.onclick = () => { void loader.load(true); };
    actions.append(refresh);
    if (onOpenResources) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "text-button";
      open.id = "plan-resource-open";
      open.textContent = "查看网关资源汇总";
      open.onclick = () => onOpenResources();
      actions.append(open);
    }
    return actions;
  }

  function answer(message, className = "plan-resource-empty") {
    const node = document.createElement("p");
    node.className = className;
    node.setAttribute("role", "status");
    node.textContent = message;
    return node;
  }

  function render() {
    if (destroyed) return;
    body.setAttribute("aria-busy", state.loading ? "true" : "false");
    if (!state.execution) {
      body.replaceChildren(answer("选择完整的执行来源与模型后显示资源参考。"));
      return;
    }
    if (state.loading && !state.document) {
      body.replaceChildren(answer("正在读取该执行选择已保存的资源快照…"));
      return;
    }
    if (state.error && !state.document) {
      body.replaceChildren(
        answer(`资源参考读取失败（${state.error.code}）。核对与确认仍按原流程进行，不因此放宽或收紧。`, "plan-resource-headline"),
        actionBar(),
      );
      return;
    }
    const view = describeReference(state.document);
    const children = [answer(view.headline, "plan-resource-headline")];
    const selection = document.createElement("p");
    selection.className = "plan-resource-selection";
    selection.textContent = `执行选择：${state.execution.executorId} / ${state.execution.connectionId} / ${state.execution.providerId} / ${state.execution.modelId}${state.execution.reasoningEffort ? ` / 档位 ${state.execution.reasoningEffort}` : ""}`;
    children.push(selection);
    if (view.lines.length) {
      const facts = document.createElement("dl");
      facts.className = "plan-resource-facts";
      for (const line of view.lines) {
        const dt = document.createElement("dt");
        dt.textContent = line.label;
        const dd = document.createElement("dd");
        dd.textContent = line.value;
        facts.append(dt, dd);
      }
      children.push(facts);
    }
    const details = document.createElement("details");
    details.className = "plan-resource-limits";
    const summary = document.createElement("summary");
    summary.textContent = "限制与不能证明的范围";
    const list = document.createElement("ul");
    for (const item of view.caveats) {
      const li = document.createElement("li");
      li.textContent = item;
      list.append(li);
    }
    details.append(summary, list);
    children.push(details);
    if (document_link_invalid(state.document)) {
      const invalid = document.createElement("p");
      invalid.className = "plan-resource-error";
      invalid.textContent = `关联声明被拒绝：${state.document.link.code ?? "未知原因"}`;
      children.push(invalid);
    }
    if (state.error) {
      const stale = document.createElement("p");
      stale.className = "plan-resource-error";
      stale.textContent = `最近一次读取失败（${state.error.code}），上面显示的是上次成功读取的快照。`;
      children.push(stale);
    }
    const stamp = document.createElement("p");
    stamp.className = "plan-resource-stamp";
    stamp.textContent = `读取时间 ${formatStamp(now().toISOString())} · 数据来自网关已保存快照`;
    children.push(stamp, actionBar());
    body.replaceChildren(...children);
  }

  function document_link_invalid(document) {
    return document?.link?.status === "invalid";
  }

  render();

  return {
    element: root,
    state,
    /** Binds the panel to one prepared draft; a different identity drops old data. */
    setExecution(execution, identity = null) {
      if (destroyed) return;
      if (loader.bind(execution ?? null, identity) && execution) void loader.load(false);
    },
    refresh() { void loader.load(true); },
    reset() { loader.reset(); },
    destroy() {
      destroyed = true;
      loader.destroy();
      host.replaceChildren();
    },
  };
}
