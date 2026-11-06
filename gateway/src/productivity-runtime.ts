/**
 * Composition for the productivity surfaces.
 *
 * Both entry points (the read-only HTTP gateway and the desktop host) build the
 * same three local stores from `WORKBUDDY_CONFIG_DIR`. Keeping the paths in one
 * place means the read views and the desktop commands can never disagree about
 * which file holds the saved templates or the notification ledger.
 */

import path from "node:path";

import type { DeliveryExportStore, ExportStatistics } from "./delivery-export.js";
import { NotificationCenter, type DesktopNotification, type NotificationStore } from "./notification-center.js";
import type { ProductivityCommandSources } from "./desktop-productivity.js";
import type { ProductivitySources } from "./productivity-service.js";
import { ProjectTemplateStore } from "./project-template.js";
import { readStatisticsOverview, type StatisticsSources } from "./statistics-service.js";

export const PRODUCTIVITY_FILES = {
  templates: "project-templates.json",
  notificationConfig: "notification-config.json",
  notificationLedger: "notification-ledger.json",
} as const;

export interface ProductivityRuntimeOptions {
  /** `config.workbuddyConfigDir`; the three files above live directly in it. */
  configDir: string;
  /** One read handle that serves templates, notifications and export reads. */
  store: NotificationStore & DeliveryExportStore;
  /** Desktop-only delivery sink; the HTTP gateway leaves it out. */
  deliver?: (notification: DesktopNotification) => void;
  /** Overview-derived coverage for the export document, when measured. */
  statistics?: (taskId: string) => ExportStatistics | null;
  now?: () => Date;
}

export interface ProductivityRuntime {
  sources: ProductivitySources;
  commands: ProductivityCommandSources;
}

export function openProductivityRuntime(options: ProductivityRuntimeOptions): ProductivityRuntime {
  const templates = new ProjectTemplateStore({
    file: path.join(options.configDir, PRODUCTIVITY_FILES.templates),
    ...(options.now ? { now: options.now } : {}),
  });
  const notifications = new NotificationCenter({
    store: options.store,
    configFile: path.join(options.configDir, PRODUCTIVITY_FILES.notificationConfig),
    ledgerFile: path.join(options.configDir, PRODUCTIVITY_FILES.notificationLedger),
    ...(options.deliver ? { deliver: options.deliver } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const sources: ProductivitySources = {
    templates,
    notifications,
    exportStore: options.store,
    ...(options.statistics ? { statistics: options.statistics } : {}),
  };
  return { sources, commands: sources };
}

/**
 * The export document carries the same coverage/limitations a statistics read
 * would show, so an export can never look more complete than the overview.
 * A failed overview returns null and the export records that it was missing.
 */
export function exportStatisticsFrom(sources: StatisticsSources, limit = 100): () => ExportStatistics | null {
  return () => {
    const overview = readStatisticsOverview(sources, { window: { from: null, to: null }, limit });
    if (!overview.ok) return null;
    return {
      window: overview.window,
      coverage: overview.coverage,
      limitations: overview.limitations,
      limitationCounts: overview.limitationCounts,
    };
  };
}
