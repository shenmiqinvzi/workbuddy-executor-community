/**
 * L06 productivity view: saved project templates, the notification snapshot
 * and the delivery-export preview.
 *
 * Boundaries this file keeps:
 *   - GET only. Nothing here saves a template, archives one, changes a
 *     notification setting or writes an export file; those four writes exist
 *     only as desktop commands behind a native confirmation.
 *   - textContent only. A task title, template name or check definition is
 *     user text and is never parsed as markup.
 *   - A preview is not a delivery: the pending list is a server snapshot, and
 *     "NA" is printed when a value was not measured instead of a zero.
 */

const NA = "NA";
const TEMPLATES = "/workbench/v1/templates";
const NOTIFICATIONS = "/workbench/v1/notifications";
const PREVIEW = "/workbench/v1/export-preview";

export const REASON_LABELS = Object.freeze({
  input_requested: "等待用户信息",
  needs_review: "停止待验收",
  failed: "执行失败",
  deadline: "超过时限",
});

const KIND_LABELS = Object.freeze({ manual: "手动模板", "policy-suggestion": "政策建议（未启用）" });

/** The label for a stored reason; an unknown code is shown as-is, never guessed. */
export function reasonLabel(reason) {
  return typeof reason === "string" && REASON_LABELS[reason] ? REASON_LABELS[reason] : typeof reason === "string" ? reason : NA;
}

export function templateKindLabel(kind) {
  return typeof kind === "string" && KIND_LABELS[kind] ? KIND_LABELS[kind] : NA;
}

/** Byte counts are printed with a unit; a missing count stays NA. */
export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return NA;
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(2)} MiB`;
}

/** One line per saved template; archived versions say so instead of hiding. */
export function templateLine(summary) {
  if (!summary || typeof summary !== "object") return NA;
  const version = typeof summary.templateVersion === "number" ? `v${summary.templateVersion}` : NA;
  const checks = typeof summary.checks === "number" ? `${summary.checks} 项检查` : `${NA} 项检查`;
  const archived = summary.archivedAt ? " · 已归档" : "";
  return `${summary.name ?? NA} · ${version} · ${templateKindLabel(summary.kind)} · ${checks}${archived}`;
}

/** The export preview's identity lines: digest, size and the whitelist size. */
export function exportSummaryLines(preview) {
  if (!preview || typeof preview !== "object") return [NA];
  const fields = Array.isArray(preview.whitelist) ? preview.whitelist.length : null;
  return [
    `任务：${preview.taskId ?? NA}`,
    `摘要：${typeof preview.digest === "string" && preview.digest ? preview.digest : NA}`,
    `大小：${formatBytes(preview.bytes)}（上限 ${formatBytes(preview.bytesLimit)}）`,
    `白名单字段：${fields === null ? NA : fields}`,
    `证据类型：${Array.isArray(preview.evidenceTypes) && preview.evidenceTypes.length ? preview.evidenceTypes.join("、") : NA}`,
    `脱敏命中：${typeof preview.redactionCount === "number" ? preview.redactionCount : NA}`,
  ];
}

/** Known limits, one per line; an empty list says so instead of implying none. */
export function limitationLines(preview) {
  if (!preview || !Array.isArray(preview.limitations) || !preview.limitations.length) return ["没有记录额外限制；这不等于没有限制，导出仍只含白名单字段。"];
  return preview.limitations.map(item => String(item));
}

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === "onclick" || key === "onchange" || key === "oninput") node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = String(value);
    else if (key === "checked") node.checked = value === true;
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
  return h("section", { class: "productivity-section" },
    h("h2", { class: "productivity-heading", text: title }),
    note ? h("p", { class: "productivity-note", text: note }) : null);
}

/** Mount the productivity view into a host element owned by the shell. */
export function mountProductivity({ root, fetchJson }) {
  if (!root) throw new Error("mountProductivity needs a root element");
  if (typeof fetchJson !== "function") throw new Error("mountProductivity needs a fetchJson function");
  let disposed = false;
  let templatesRequest = 0;
  let detailRequest = 0;
  let notificationsRequest = 0;
  let previewRequest = 0;

  const templateList = h("ul", { class: "productivity-list", "aria-live": "polite" });
  const templateIssues = h("p", { class: "productivity-issue", role: "status" });
  const detailHost = h("div", { class: "productivity-detail" });
  const includeArchived = h("input", { type: "checkbox", id: "productivity-archived" });
  const refreshTemplates = h("button", { type: "button", class: "productivity-button", text: "刷新模板" });

  const configHost = h("dl", { class: "productivity-config" });
  const pendingList = h("ul", { class: "productivity-list", "aria-live": "polite" });
  const notificationIssues = h("p", { class: "productivity-issue", role: "status" });
  const refreshNotifications = h("button", { type: "button", class: "productivity-button", text: "刷新待办" });

  const taskInput = h("input", { type: "text", id: "productivity-task-id", class: "productivity-input", placeholder: "任务编号", autocomplete: "off", spellcheck: "false" });
  const previewButton = h("button", { type: "button", class: "productivity-button", text: "预览导出" });
  const previewHost = h("div", { class: "productivity-detail", "aria-live": "polite" });

  async function loadTemplates() {
    const request = ++templatesRequest;
    refreshTemplates.disabled = true;
    try {
      const suffix = includeArchived.checked ? "?includeArchived=1" : "";
      const body = await fetchJson(`${TEMPLATES}${suffix}`);
      if (disposed || request !== templatesRequest) return;
      templateList.replaceChildren(...(Array.isArray(body?.templates) && body.templates.length
        ? body.templates.map(summary => h("li", { class: "productivity-item" },
          h("span", { class: "productivity-item-text", text: templateLine(summary) }),
          h("button", {
            type: "button",
            class: "productivity-link",
            text: "版本历史",
            "aria-label": `查看 ${summary.name ?? summary.templateId} 的版本`,
            onclick: () => loadDetail(summary.templateId),
          })))
        : [h("li", { class: "productivity-empty", text: "还没有保存的模板。" })]));
      templateIssues.textContent = Array.isArray(body?.issues) && body.issues.length ? body.issues.join(" ") : "";
    }
    catch (error) {
      if (disposed || request !== templatesRequest) return;
      templateList.replaceChildren(h("li", { class: "productivity-empty", text: `模板读取失败：${error?.message ?? "未知错误"}` }));
    }
    finally {
      if (!disposed && request === templatesRequest) refreshTemplates.disabled = false;
    }
  }

  async function loadDetail(templateId) {
    const request = ++detailRequest;
    try {
      const body = await fetchJson(`${TEMPLATES}/${encodeURIComponent(templateId)}`);
      if (disposed || request !== detailRequest) return;
      const versions = Array.isArray(body?.versions) ? body.versions : [];
      detailHost.replaceChildren(
        h("h3", { class: "productivity-subheading", text: `版本历史：${templateId}` }),
        h("ul", { class: "productivity-list" }, ...versions.map(item => h("li", { class: "productivity-item" },
          h("span", { class: "productivity-item-text", text: `${templateLine(item)} · ${item.createdAt ?? NA}` })))),
        h("p", { class: "productivity-note", text: "保存新版本与归档都需要在受控桌面壳中确认；这里只读。" }));
    }
    catch (error) {
      if (disposed || request !== detailRequest) return;
      detailHost.replaceChildren(h("p", { class: "productivity-issue", text: `版本读取失败：${error?.message ?? "未知错误"}` }));
    }
  }

  async function loadNotifications() {
    const request = ++notificationsRequest;
    refreshNotifications.disabled = true;
    try {
      const body = await fetchJson(NOTIFICATIONS);
      if (disposed || request !== notificationsRequest) return;
      const config = body?.config ?? {};
      const reasons = config.reasons ?? {};
      configHost.replaceChildren(
        h("dt", { text: "通知开关" }),
        h("dd", { text: config.enabled === true ? "已开启" : "已关闭" }),
        h("dt", { text: "节流间隔" }),
        h("dd", { text: typeof config.minIntervalMs === "number" ? `${Math.round(config.minIntervalMs / 1000)} 秒` : NA }),
        h("dt", { text: "类别" }),
        h("dd", { text: Object.keys(REASON_LABELS).map(reason => `${reasonLabel(reason)}${reasons[reason] === true ? "✓" : "✕"}`).join(" · ") }));
      const pending = Array.isArray(body?.pending) ? body.pending : [];
      pendingList.replaceChildren(...(pending.length
        ? pending.map(item => h("li", { class: "productivity-item" },
          h("span", { class: "productivity-item-text", text: `${reasonLabel(item.reason)} · ${item.taskTitle ?? item.taskId ?? NA}` }),
          h("span", { class: "productivity-meta", text: item.readyAt ? `节流至 ${item.readyAt}` : (item.occurredAt ?? NA) })))
        : [h("li", { class: "productivity-empty", text: "当前没有待发出的通知。" })]));
      notificationIssues.textContent = Array.isArray(body?.issues) && body.issues.length ? body.issues.join(" ") : "";
    }
    catch (error) {
      if (disposed || request !== notificationsRequest) return;
      pendingList.replaceChildren(h("li", { class: "productivity-empty", text: `通知读取失败：${error?.message ?? "未知错误"}` }));
    }
    finally {
      if (!disposed && request === notificationsRequest) refreshNotifications.disabled = false;
    }
  }

  async function loadPreview() {
    const request = ++previewRequest;
    const taskId = taskInput.value.trim();
    if (!taskId) {
      previewHost.replaceChildren(h("p", { class: "productivity-issue", text: "先填写任务编号。" }));
      return;
    }
    previewButton.disabled = true;
    try {
      const body = await fetchJson(`${PREVIEW}/${encodeURIComponent(taskId)}`);
      if (disposed || request !== previewRequest) return;
      previewHost.replaceChildren(
        h("ul", { class: "productivity-list" }, ...exportSummaryLines(body).map(line => h("li", { class: "productivity-item-text", text: line }))),
        h("h3", { class: "productivity-subheading", text: "已知限制" }),
        h("ul", { class: "productivity-list" }, ...limitationLines(body).map(line => h("li", { class: "productivity-item-text", text: line }))),
        h("p", { class: "productivity-note", text: "保存导出需要在受控桌面壳中选择目标目录并确认；页面不会写入任何文件。" }));
    }
    catch (error) {
      if (disposed || request !== previewRequest) return;
      previewHost.replaceChildren(h("p", { class: "productivity-issue", text: `预览失败：${error?.message ?? "未知错误"}` }));
    }
    finally {
      if (!disposed && request === previewRequest) previewButton.disabled = false;
    }
  }

  refreshTemplates.addEventListener("click", loadTemplates);
  includeArchived.addEventListener("change", loadTemplates);
  refreshNotifications.addEventListener("click", loadNotifications);
  previewButton.addEventListener("click", loadPreview);
  taskInput.addEventListener("keydown", event => { if (event.key === "Enter") loadPreview(); });

  root.replaceChildren(
    section("项目模板", "模板只保存预设：名称、范围、检查定义和可选的选择建议。实例化会产生新的任务身份，旧模板不携带授权。"),
    h("div", { class: "productivity-toolbar" }, refreshTemplates, h("label", { class: "productivity-check", for: "productivity-archived" }, includeArchived, " 显示已归档")),
    templateIssues,
    templateList,
    detailHost,
    section("桌面通知", "通知只在受控桌面壳中显示，按真实事件去重；它不是任务状态，也不会替你批准、重试或延时。"),
    h("div", { class: "productivity-toolbar" }, refreshNotifications),
    configHost,
    notificationIssues,
    pendingList,
    section("脱敏导出", "导出只包含白名单字段，目标是你在原生对话框中选择的目录；页面只做预览。"),
    h("div", { class: "productivity-toolbar" }, taskInput, previewButton),
    previewHost);

  loadTemplates();
  loadNotifications();
  return {
    dispose() { disposed = true; },
    reload() {
      if (disposed) return;
      loadTemplates();
      loadNotifications();
    },
  };
}
