import type { Config } from "./config.js";
import { NativeDesktopRpcTrigger } from "./native-desktop-trigger.js";
import { registeredServiceConfig } from "./persistent-service.js";
import { workerRegistration } from "./workspace-manager.js";

/**
 * R1 — the observation-only catalog read.
 *
 * `listModels` builds a desktop trigger with the default `autoLaunch = true`. On Windows that path
 * is allowed to quit a running WorkBuddy and launch a replacement to enable its local port, and its
 * ordinary `connect()` writes the renderer bridge. That is correct for a dispatch path, and wrong
 * for a read-only evaluation: an unarmed `evaluate` must not start, restart or reconfigure anything.
 *
 * This reader never launches and never writes the bridge. It opens the trigger with
 * `autoLaunch = false`, asks `diagnoseReadOnly()` to inspect whatever bridge already exists, and
 * reports "unavailable" when the native side is not ready instead of preparing it.
 */
export interface WorkbuddyModelReading {
  models: Array<{ id: string; credits?: unknown }>;
}

export interface ReadOnlyCatalogOptions {
  /** Test seam: production resolves the persistent-service registration itself. */
  resolveEndpoint?: (config: Config) => { bound: Config; cdpPort: number };
  /** Test seam: production constructs a non-launching `NativeDesktopRpcTrigger`. */
  createObserver?: (bound: Config, cdpPort: number) => { diagnoseReadOnly(): Promise<{ bridgeReady: boolean; models?: Array<{ id: string; credits?: unknown }> }>; close(): void };
}

export function readOnlyDesktopEndpoint(config: Config): { bound: Config; cdpPort: number } {
  const registration = workerRegistration(config);
  return { bound: registration ? registeredServiceConfig(config, registration) : config, cdpPort: registration?.cdpPort ?? 18491 };
}

/** Reads the current WorkBuddy model catalog without launching, restarting or reconfiguring it. */
export async function readOnlyWorkbuddyCatalog(config: Config, options: ReadOnlyCatalogOptions = {}): Promise<WorkbuddyModelReading> {
  if (config.backend !== "desktop-queue") throw new Error("Native model discovery requires desktop-queue");
  const { bound, cdpPort } = (options.resolveEndpoint ?? readOnlyDesktopEndpoint)(config);
  // The third argument is the whole point: `false` = never launch, never restart, never inject.
  const observer = (options.createObserver ?? ((target: Config, port: number) => new NativeDesktopRpcTrigger(target, port, false)))(bound, cdpPort);
  try {
    const diagnosis = await observer.diagnoseReadOnly();
    if (!diagnosis.bridgeReady) throw new Error("The WorkBuddy renderer bridge is not ready; no model catalog was read and nothing was started.");
    return { models: (diagnosis.models ?? []).map((model) => ({ id: model.id, credits: model.credits })) };
  } finally {
    observer.close();
  }
}
