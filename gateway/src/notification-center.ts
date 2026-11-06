/**
 * Desktop notification derivation.
 *
 * Notifications are *derived views* over the saved task event stream. They are
 * not task state, they never approve, retry, defer or cancel anything, and
 * turning them off removes no evidence: the store is opened read-only here.
 *
 * Delivery is keyed by a real episode, never by "the current state":
 *  - `input_requested` / `task_state_changed` events supply the anchor event id;
 *  - the deadline episode is derived from the saved contract timeout plus the
 *    task's saved creation time, anchored on the task revision, and is labelled
 *    `derived` so it is never mistaken for a stored event.
 * A ledger on disk keeps delivered episodes across restarts, so reopening the
 * window does not replay old notifications, and two episodes of the same reason
 * on one task are still two distinct notifications.
 *
 * Throttling is per reason. A throttled episode is remembered as deferred and
 * delivered once its window opens; it is never dropped silently.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { StoredTask, StoredTaskEvent, TaskContractRead } from "./task-store.js";

export const NOTIFICATION_SCHEMA = "workbuddy-executor/notification-1";
export const NOTIFICATION_LEDGER_SCHEMA = 1;
export const NOTIFICATION_CONFIG_SCHEMA = 1;

export const NOTIFICATION_REASONS = ["input_requested", "needs_review", "failed", "deadline"] as const;
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];
export const NOTIFICATION_REASON_LABELS: Record<NotificationReason, string> = {
  input_requested: "等待用户输入",
  needs_review: "停止待验收",
  failed: "执行失败",
  deadline: "超过约定时限",
};

export const NOTIFICATION_LIMITS = {
  tasksPerPoll: 200,
  eventsPerTask: 400,
  episodes: 2000,
  watermarks: 500,
  pending: 50,
  minIntervalMs: 60_000,
  maxIntervalMs: 3_600_000,
} as const;

export interface NotificationConfig {
  enabled: boolean;
  reasons: Record<NotificationReason, boolean>;
  /** Per-reason minimum spacing; a higher value only delays, never drops. */
  minIntervalMs: number;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  reasons: { input_requested: true, needs_review: true, failed: true, deadline: true },
  minIntervalMs: 60_000,
};

export interface NotificationAnchor {
  kind: "event" | "derived";
  eventId: number | null;
  revision: string | null;
}

export interface DesktopNotification {
  schemaVersion: typeof NOTIFICATION_SCHEMA;
  notificationId: string;
  episodeKey: string;
  reason: NotificationReason;
  taskId: string;
  taskTitle: string;
  state: string;
  anchor: NotificationAnchor;
  occurredAt: string;
  message: string;
}

export interface PendingNotification {
  episodeKey: string;
  reason: NotificationReason;
  taskId: string;
  taskTitle: string;
  state: string;
  anchor: NotificationAnchor;
  occurredAt: string;
  /** Null when it can be delivered now, otherwise the throttle window end. */
  readyAt: string | null;
}

export interface NotificationRejection {
  code: "not_an_object" | "unknown_field" | "invalid_type" | "invalid_value" | "unknown_enum";
  field: string;
  message: string;
  allowed?: readonly string[];
}

export interface NotificationStore {
  get(taskId: string): StoredTask | undefined;
  listTasksByCreatedCursor(options: { limit: number; afterTaskId?: string }): { tasks: StoredTask[]; anchorFound: boolean };
  listTaskEvents(taskId: string, options?: { afterEventId?: number; limit?: number }): { events: StoredTaskEvent[]; nextEventId: number };
  getContract(taskId: string): TaskContractRead;
}

/** A candidate episode: everything a balloon needs except its identity. */
type Candidate = Omit<PendingNotification, "episodeKey" | "readyAt">;

/**
 * A deferred episode keeps the whole candidate. The event watermark advances as
 * soon as an event is considered, so without this record a throttled or failed
 * episode could never be rebuilt and would be lost silently.
 */
interface DeferredEpisode extends Candidate {
  readyAt: string;
}

interface LedgerFile {
  schemaVersion: 1;
  episodes: Record<string, { taskId: string; reason: NotificationReason; anchor: string; deliveredAt: string }>;
  deferred: Record<string, DeferredEpisode>;
  watermarks: Record<string, number>;
  lastDeliveredAt: Partial<Record<NotificationReason, string>>;
}

type Ledger = LedgerFile;

function emptyLedger(): Ledger {
  return { schemaVersion: NOTIFICATION_LEDGER_SCHEMA, episodes: {}, deferred: {}, watermarks: {}, lastDeliveredAt: {} };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function episodeKey(taskId: string, reason: NotificationReason, anchor: NotificationAnchor): string {
  return `${taskId}|${reason}|${anchor.kind}:${anchor.kind === "event" ? anchor.eventId : anchor.revision ?? "0"}`;
}

function notificationId(key: string): string {
  return `ntf-${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}`;
}

function anchorText(anchor: NotificationAnchor): string {
  return `${anchor.kind}:${anchor.kind === "event" ? anchor.eventId : anchor.revision ?? "0"}`;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function reasonMessage(reason: NotificationReason, title: string): string {
  const name = clip(title, 60);
  switch (reason) {
    case "input_requested": return `「${name}」在等你提供信息，任务已暂停。`;
    case "needs_review": return `「${name}」已停止，等待你验收；这不是通过结论。`;
    case "failed": return `「${name}」执行失败，保留原记录，需你决定下一步。`;
    case "deadline": return `「${name}」超过约定的执行时限，任务库状态未被这条通知改变。`;
  }
}

/** Events that open an episode, keyed by the real stored event id. */
function episodeFromEvent(event: StoredTaskEvent, task: StoredTask): { reason: NotificationReason; anchor: NotificationAnchor } | null {
  if (event.type === "input_requested") return { reason: "input_requested", anchor: { kind: "event", eventId: event.eventId, revision: null } };
  if (event.type === "task_state_changed") {
    const payload = event.payload as { patch?: { state?: unknown } } | null;
    const state = payload?.patch?.state;
    if (state === "needs_review") return { reason: "needs_review", anchor: { kind: "event", eventId: event.eventId, revision: null } };
    if (state === "failed") return { reason: "failed", anchor: { kind: "event", eventId: event.eventId, revision: null } };
  }
  if (event.type === "task_closed" && task.state === "failed") return { reason: "failed", anchor: { kind: "event", eventId: event.eventId, revision: null } };
  return null;
}

/** Validate a config patch without accepting unknown keys or reasons. */
export function applyNotificationConfig(current: NotificationConfig, patch: unknown): { ok: true; config: NotificationConfig } | { ok: false; rejection: NotificationRejection } {
  if (!isObject(patch)) return { ok: false, rejection: { code: "not_an_object", field: "config", message: "A config patch must be an object." } };
  const next: NotificationConfig = { ...current, reasons: { ...current.reasons } };
  for (const key of Object.keys(patch)) {
    if (!["enabled", "reasons", "minIntervalMs"].includes(key)) {
      return { ok: false, rejection: { code: "unknown_field", field: key, message: `Unknown config field "${key}".` } };
    }
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return { ok: false, rejection: { code: "invalid_type", field: "enabled", message: "enabled must be a boolean." } };
    next.enabled = patch.enabled;
  }
  if (patch.reasons !== undefined) {
    if (!isObject(patch.reasons)) return { ok: false, rejection: { code: "invalid_type", field: "reasons", message: "reasons must be an object." } };
    for (const [key, value] of Object.entries(patch.reasons)) {
      if (!(NOTIFICATION_REASONS as readonly string[]).includes(key)) {
        return { ok: false, rejection: { code: "unknown_enum", field: `reasons.${key}`, message: `Unknown notification reason "${key}".`, allowed: NOTIFICATION_REASONS } };
      }
      if (typeof value !== "boolean") return { ok: false, rejection: { code: "invalid_type", field: `reasons.${key}`, message: "Each reason switch must be a boolean." } };
      next.reasons[key as NotificationReason] = value;
    }
  }
  if (patch.minIntervalMs !== undefined) {
    if (typeof patch.minIntervalMs !== "number" || !Number.isInteger(patch.minIntervalMs) || patch.minIntervalMs < 0 || patch.minIntervalMs > NOTIFICATION_LIMITS.maxIntervalMs) {
      return { ok: false, rejection: { code: "invalid_value", field: "minIntervalMs", message: `minIntervalMs must be an integer between 0 and ${NOTIFICATION_LIMITS.maxIntervalMs}.` } };
    }
    next.minIntervalMs = patch.minIntervalMs;
  }
  return { ok: true, config: next };
}

export interface NotificationPollResult {
  delivered: DesktopNotification[];
  deferred: number;
  suppressedByReasonOff: number;
  tasksRead: number;
  eventsRead: number;
  unreadableTasks: number;
  truncated: boolean;
}

/**
 * Read-only notification center. It owns two local files (config and ledger)
 * and never opens the task database for writing.
 */
export class NotificationCenter {
  private configCache: NotificationConfig | null = null;
  private ledgerCache: Ledger | null = null;
  private readonly problems: string[] = [];
  private readonly now: () => Date;
  constructor(private readonly options: {
    store: NotificationStore;
    configFile?: string | null;
    ledgerFile?: string | null;
    deliver?: (notification: DesktopNotification) => void;
    now?: () => Date;
    tasksPerPoll?: number;
    eventsPerTask?: number;
  }) {
    this.now = options.now ?? (() => new Date());
  }

  issues(): string[] { return [...this.problems]; }

  config(): NotificationConfig { return this.loadConfig(); }

  setConfig(patch: unknown): { ok: true; config: NotificationConfig } | { ok: false; rejection: NotificationRejection } {
    const applied = applyNotificationConfig(this.loadConfig(), patch);
    if (!applied.ok) return applied;
    this.configCache = applied.config;
    this.writeJson(this.options.configFile, { schemaVersion: NOTIFICATION_CONFIG_SCHEMA, config: applied.config });
    return { ok: true, config: applied.config };
  }

  /** Episodes that would be delivered now, and those waiting on a throttle. */
  pending(): PendingNotification[] {
    const scan = this.scan();
    const config = this.loadConfig();
    const now = this.now().getTime();
    const ledger = this.loadLedger();
    const out: PendingNotification[] = [];
    for (const candidate of this.candidatesFor(scan.candidates, ledger)) {
      const key = episodeKey(candidate.taskId, candidate.reason, candidate.anchor);
      if (ledger.episodes[key]) continue;
      if (!this.reasonEnabled(candidate.reason, config)) continue;
      const ready = this.readyAtMs(candidate.reason, ledger.deferred[key], config, ledger);
      out.push({ ...candidate, episodeKey: key, readyAt: ready > now ? new Date(ready).toISOString() : null });
    }
    return out.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(0, NOTIFICATION_LIMITS.pending);
  }

  poll(): NotificationPollResult {
    const scan = this.scan();
    const config = this.loadConfig();
    const ledger = this.loadLedger();
    const now = this.now();
    const nowMs = now.getTime();
    const result: NotificationPollResult = { delivered: [], deferred: 0, suppressedByReasonOff: 0, tasksRead: scan.tasksRead, eventsRead: scan.eventsRead, unreadableTasks: scan.unreadableTasks, truncated: scan.truncated };

    for (const candidate of this.candidatesFor(scan.candidates, ledger)) {
      const key = episodeKey(candidate.taskId, candidate.reason, candidate.anchor);
      if (ledger.episodes[key]) { delete ledger.deferred[key]; continue; }
      if (!config.enabled || !this.reasonEnabled(candidate.reason, config)) {
        // Nothing is shown while notifications are off; the episode is closed
        // out so switching them back on cannot replay a stale balloon. The
        // task store is never touched either way.
        result.suppressedByReasonOff++;
        delete ledger.deferred[key];
        continue;
      }
      const readyAtMs = this.readyAtMs(candidate.reason, ledger.deferred[key], config, ledger);
      if (nowMs < readyAtMs) {
        ledger.deferred[key] = { ...candidate, readyAt: new Date(readyAtMs).toISOString() };
        result.deferred++;
        continue;
      }
      const notification: DesktopNotification = {
        schemaVersion: NOTIFICATION_SCHEMA,
        notificationId: notificationId(key),
        episodeKey: key,
        reason: candidate.reason,
        taskId: candidate.taskId,
        taskTitle: clip(candidate.taskTitle, 80),
        state: candidate.state,
        anchor: candidate.anchor,
        occurredAt: candidate.occurredAt,
        message: reasonMessage(candidate.reason, candidate.taskTitle),
      };
      try {
        this.options.deliver?.(notification);
      }
      catch {
        // A failing presenter must not consume the episode. It stays deferred
        // and is retried on the next poll, still subject to the throttle.
        ledger.deferred[key] = { ...candidate, readyAt: new Date(nowMs).toISOString() };
        continue;
      }
      delete ledger.deferred[key];
      ledger.episodes[key] = { taskId: candidate.taskId, reason: candidate.reason, anchor: anchorText(candidate.anchor), deliveredAt: now.toISOString() };
      ledger.lastDeliveredAt[candidate.reason] = now.toISOString();
      result.delivered.push(notification);
    }
    this.prune(ledger);
    for (const [taskId, value] of Object.entries(scan.watermarks)) ledger.watermarks[taskId] = Math.max(ledger.watermarks[taskId] ?? 0, value);
    this.ledgerCache = ledger;
    this.persistLedger();
    return result;
  }

  /** Scanned candidates plus episodes still deferred from earlier polls. */
  private candidatesFor(scanned: Candidate[], ledger: Ledger): Candidate[] {
    const merged = new Map<string, Candidate>();
    for (const candidate of scanned) merged.set(episodeKey(candidate.taskId, candidate.reason, candidate.anchor), candidate);
    for (const [key, entry] of Object.entries(ledger.deferred)) {
      if (merged.has(key)) continue;
      const { readyAt: _readyAt, ...candidate } = entry;
      merged.set(key, candidate);
    }
    return [...merged.values()];
  }

  /** Earliest moment this episode may be shown: throttle end or a retry time. */
  private readyAtMs(reason: NotificationReason, deferred: DeferredEpisode | undefined, config: NotificationConfig, ledger: Ledger = this.loadLedger()): number {
    const last = ledger.lastDeliveredAt[reason];
    const throttled = last ? Date.parse(last) + config.minIntervalMs : 0;
    const retry = deferred ? Date.parse(deferred.readyAt) : 0;
    return Math.max(Number.isFinite(throttled) ? throttled : 0, Number.isFinite(retry) ? retry : 0);
  }

  private reasonEnabled(reason: NotificationReason, config: NotificationConfig = this.loadConfig()): boolean {
    return config.reasons[reason] === true;
  }

  private scan(): { candidates: Array<Omit<PendingNotification, "episodeKey" | "readyAt">>; watermarks: Record<string, number>; tasksRead: number; eventsRead: number; unreadableTasks: number; truncated: boolean } {
    const ledger = this.loadLedger();
    const candidates: Array<Omit<PendingNotification, "episodeKey" | "readyAt">> = [];
    // The watermark is only committed by poll(); a read-only preview of pending
    // episodes must not consume events that were never delivered.
    const watermarks: Record<string, number> = {};
    const taskLimit = Math.max(1, Math.min(this.options.tasksPerPoll ?? NOTIFICATION_LIMITS.tasksPerPoll, 500));
    const eventLimit = Math.max(1, Math.min(this.options.eventsPerTask ?? NOTIFICATION_LIMITS.eventsPerTask, 2000));
    let tasksRead = 0, eventsRead = 0, unreadableTasks = 0, truncated = false, afterTaskId: string | undefined;
    while (tasksRead < taskLimit) {
      let page: { tasks: StoredTask[]; anchorFound: boolean };
      try { page = this.options.store.listTasksByCreatedCursor({ limit: Math.min(50, taskLimit - tasksRead), ...(afterTaskId ? { afterTaskId } : {}) }); }
      catch { this.problems.push("任务列表读取失败，本次未生成通知；任务库未被修改。"); break; }
      if (!page.tasks.length) break;
      for (const task of page.tasks) {
        tasksRead++;
        const contract = this.options.store.getContract(task.taskId);
        // A notification shows a short label, never the objective body: a
        // desktop balloon is the least private surface in the product.
        const label = contract.state === "found" ? clip(contract.record.contract.title, 80) : `任务 ${task.taskId}`;
        const watermark = ledger.watermarks[task.taskId] ?? 0;
        let cursor: number | undefined = watermark > 0 ? watermark : undefined;
        let highWater = watermark;
        let taskEvents = 0;
        try {
          for (;;) {
            const chunk = this.options.store.listTaskEvents(task.taskId, { ...(cursor !== undefined ? { afterEventId: cursor } : {}), limit: 200 });
            if (!chunk.events.length) break;
            for (const event of chunk.events) {
              taskEvents++;
              if (event.eventId > highWater) highWater = event.eventId;
              if (event.eventId <= watermark) continue;
              const episode = episodeFromEvent(event, task);
              if (!episode) continue;
              candidates.push({ reason: episode.reason, taskId: task.taskId, taskTitle: label, state: task.state, anchor: episode.anchor, occurredAt: event.occurredAt });
            }
            eventsRead += chunk.events.length;
            if (chunk.nextEventId <= (cursor ?? 0)) break;
            cursor = chunk.nextEventId;
            if (taskEvents >= eventLimit) { truncated = true; break; }
          }
        }
        catch { unreadableTasks++; continue; }
        // The watermark is only reported here. `poll()` commits it after the
        // episodes are resolved, so a read-only `pending()` cannot move it.
        watermarks[task.taskId] = highWater;
        const deadline = this.deadlineEpisode(task, contract);
        if (deadline) candidates.push(deadline);
      }
      afterTaskId = page.tasks.at(-1)?.taskId;
      if (!page.tasks.length || page.tasks.length < 50) break;
      if (tasksRead >= taskLimit) { truncated = true; break; }
    }
    candidates.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return { candidates, watermarks, tasksRead, eventsRead, unreadableTasks, truncated };
  }

  private deadlineEpisode(task: StoredTask, contract: TaskContractRead): Omit<PendingNotification, "episodeKey" | "readyAt"> | null {
    if (task.state !== "queued" && task.state !== "working") return null;
    if (contract.state !== "found") return null;
    const createdAt = Date.parse(task.createdAt);
    if (!Number.isFinite(createdAt)) return null;
    const deadline = createdAt + contract.record.contract.timeoutSeconds * 1000;
    if (this.now().getTime() < deadline) return null;
    return {
      reason: "deadline",
      taskId: task.taskId,
      taskTitle: clip(contract.record.contract.title, 80),
      state: task.state,
      anchor: { kind: "derived", eventId: null, revision: task.revision ?? "0" },
      occurredAt: new Date(deadline).toISOString(),
    };
  }

  private prune(ledger: Ledger): void {
    const episodes = Object.entries(ledger.episodes);
    if (episodes.length > NOTIFICATION_LIMITS.episodes) {
      const keep = episodes.sort((a, b) => b[1].deliveredAt.localeCompare(a[1].deliveredAt)).slice(0, NOTIFICATION_LIMITS.episodes);
      ledger.episodes = Object.fromEntries(keep);
    }
    const watermarks = Object.entries(ledger.watermarks);
    if (watermarks.length > NOTIFICATION_LIMITS.watermarks) {
      ledger.watermarks = Object.fromEntries(watermarks.slice(-NOTIFICATION_LIMITS.watermarks));
    }
    const now = this.now().getTime();
    for (const [key, deferred] of Object.entries(ledger.deferred)) {
      if (Date.parse(deferred.readyAt) < now - 24 * 60 * 60 * 1000) delete ledger.deferred[key];
    }
  }

  private loadConfig(): NotificationConfig {
    if (this.configCache) return this.configCache;
    this.configCache = { ...DEFAULT_NOTIFICATION_CONFIG, reasons: { ...DEFAULT_NOTIFICATION_CONFIG.reasons } };
    const file = this.options.configFile;
    if (!file) return this.configCache;
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.problems.push("通知配置文件无法读取，已使用默认设置；任务证据不受影响。");
      return this.configCache;
    }
    try {
      const parsed = JSON.parse(raw) as { schemaVersion?: unknown; config?: unknown };
      if (parsed.schemaVersion !== NOTIFICATION_CONFIG_SCHEMA) throw Error("schema");
      const applied = applyNotificationConfig(DEFAULT_NOTIFICATION_CONFIG, parsed.config);
      if (!applied.ok) throw Error("shape");
      this.configCache = applied.config;
    }
    catch {
      this.problems.push("通知配置无法解释，已使用默认设置；原文件保持原样。");
    }
    return this.configCache;
  }

  private loadLedger(): Ledger {
    if (this.ledgerCache) return this.ledgerCache;
    const ledger = emptyLedger();
    const file = this.options.ledgerFile;
    if (!file) { this.ledgerCache = ledger; return ledger; }
    let raw: string;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.problems.push("通知账本无法读取，本次按空账本继续；可能重复一次通知，但不会改动任务状态。");
      this.ledgerCache = ledger;
      return ledger;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LedgerFile>;
      if (parsed.schemaVersion !== NOTIFICATION_LEDGER_SCHEMA) throw Error("schema");
      if (isObject(parsed.episodes)) {
        for (const [key, value] of Object.entries(parsed.episodes)) {
          if (!isObject(value) || typeof value.deliveredAt !== "string") continue;
          ledger.episodes[key] = value as LedgerFile["episodes"][string];
        }
      }
      if (isObject(parsed.deferred)) {
        for (const [key, value] of Object.entries(parsed.deferred)) {
          // A deferred record must be able to rebuild a balloon on its own; a
          // record that cannot is dropped rather than guessed at.
          if (!isObject(value) || typeof value.readyAt !== "string") continue;
          if (typeof value.taskId !== "string" || typeof value.taskTitle !== "string" || typeof value.state !== "string" || typeof value.occurredAt !== "string") continue;
          if (typeof value.reason !== "string" || !(NOTIFICATION_REASONS as readonly string[]).includes(value.reason)) continue;
          const anchor = value.anchor;
          if (!isObject(anchor) || (anchor.kind !== "event" && anchor.kind !== "derived")) continue;
          ledger.deferred[key] = value as unknown as DeferredEpisode;
        }
      }
      if (isObject(parsed.watermarks)) {
        for (const [key, value] of Object.entries(parsed.watermarks)) if (typeof value === "number" && Number.isInteger(value) && value >= 0) ledger.watermarks[key] = value;
      }
      if (isObject(parsed.lastDeliveredAt)) {
        for (const [key, value] of Object.entries(parsed.lastDeliveredAt)) {
          if ((NOTIFICATION_REASONS as readonly string[]).includes(key) && typeof value === "string") ledger.lastDeliveredAt[key as NotificationReason] = value;
        }
      }
    }
    catch {
      this.problems.push("通知账本格式无效，本次按空账本继续；不会改动任务库。");
    }
    this.ledgerCache = ledger;
    return ledger;
  }

  private persistLedger(): void {
    const file = this.options.ledgerFile;
    if (!file) return;
    this.writeJson(file, this.ledgerCache ?? emptyLedger());
  }

  private writeJson(file: string | null | undefined, value: unknown): void {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, file);
    }
    catch {
      this.problems.push("通知本地状态写入失败；任务库未被修改，下次轮询会再试。");
    }
  }
}
