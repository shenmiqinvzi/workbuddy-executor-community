/**
 * Composition root for stage-2 task reads and optional quota observations.
 *
 * Run with the built dist: `node dist/workbench-entry.js`.
 *
 * It constructs the same shared service the MCP server builds (config, store,
 * coordinator) and binds the read-only adapter on the loopback port. It
 * starts no native work, dispatch or model request. The optional background
 * quota collector writes only independent resource observations. HTTP GETs
 * read saved task/resource facts and never start collection.
 */

import { loadConfig } from "./config.js";
import { TaskStore } from "./task-store.js";
import { TaskCoordinator } from "./coordinator.js";
import { TaskApplicationService } from "./task-application-service.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { runtimeVersion } from "./runtime-version.js";
import { runsDirectory } from "./run-journal.js";
import { WorkbenchHttpServer, workbenchHealth, workbenchPortFromEnv } from "./workbench-http.js";
import { statisticsSources } from "./statistics-http.js";
import { exportStatisticsFrom, openProductivityRuntime } from "./productivity-runtime.js";
import { attributeTaskUsageFromLedger } from "./usage-attribution.js";
import { WorkBuddyQuotaCollector } from "./quota-observation.js";
import { WorkBuddyCreditBalanceCollector } from "./credit-balance.js";
import { configuredDshCoordinator } from "./dsh-runtime.js";
import { desktopJournal } from "./desktop-dispatch-runtime.js";

const config = loadConfig();
const store = new TaskStore(config.dbFile);
const client = new WorkBuddyClient(config);
const coordinator = new TaskCoordinator(config, store, client);
// The runs directory resolves exactly like the rest of the execution chain:
// WORKBUDDY_RUNS_DIR when set, otherwise the runs directory next to the task
// database. An empty fallback here would make the read paths resolve run
// records against the process working directory and silently misread them.
// R12: the dispatch journal is read-only evidence for the panel; the journal
// constructor never creates the file, and reads return null while it is absent.
const service = new TaskApplicationService(coordinator, config.maxTaskAttempts ?? 3, runsDirectory(config), configuredDshCoordinator(store, runsDirectory(config)), taskId => desktopJournal(config).leaseByTask(taskId));
// The statistics surface reads the same database file through a read-only
// handle per request: a ledger that was never written reports "unavailable"
// instead of creating the table, so a GET cannot migrate anything.
const statistics = statisticsSources(store, (taskId, attemptIds) =>
  attributeTaskUsageFromLedger({ file: store.file, taskId, attemptIds }));
// L06: templates and the notification ledger are read from the config directory.
// This entry never delivers a notification and never writes a template; a GET
// only reports what the desktop surface saved earlier.
const productivity = openProductivityRuntime({
  configDir: config.workbuddyConfigDir,
  store,
  statistics: exportStatisticsFrom(statistics),
});
const server = new WorkbenchHttpServer({
  service,
  statistics,
  productivity: productivity.sources,
  // L07: the saved automation policy, its revisions, recorded decisions and the
  // audit trail are readable here. Nothing on this surface writes: the policy and
  // dispatch seam is scripts/automation.mjs, and this entry starts unarmed.
  automation: service.automation,
  health: () => workbenchHealth({
    runtime: { release: runtimeVersion.release, packageVersion: runtimeVersion.packageVersion, startedAt: runtimeVersion.startedAt },
  }),
});

const port = workbenchPortFromEnv();
let quota:WorkBuddyQuotaCollector|undefined;
let credit:WorkBuddyCreditBalanceCollector|undefined;
try {
  if(process.env.WORKBUDDY_QUOTA_SOURCE_URL){
    try {quota=new WorkBuddyQuotaCollector(store.quotas,{id:process.env.WORKBUDDY_QUOTA_SOURCE_ID??"workbuddy2api-local",baseUrl:process.env.WORKBUDDY_QUOTA_SOURCE_URL,
      apiKey:process.env.WORKBUDDY_QUOTA_API_KEY??"",panelToken:process.env.WORKBUDDY_QUOTA_PANEL_TOKEN});}
    catch {
      try {store.quotas.configurationError(process.env.WORKBUDDY_QUOTA_SOURCE_ID??"workbuddy2api-local");}catch { /* optional source bookkeeping cannot prevent task reads */ }
      console.error(JSON.stringify({event:"quota_source_configuration_invalid",message:"Quota observation is unavailable; task reads remain available. No source credentials are included."}));
    }
  }
  if(process.env.WORKBUDDY_CREDIT_SOURCE_URL){
    try {credit=new WorkBuddyCreditBalanceCollector(store.creditBalances,{id:process.env.WORKBUDDY_CREDIT_SOURCE_ID??"workbuddy2api-credit",baseUrl:process.env.WORKBUDDY_CREDIT_SOURCE_URL,apiKey:process.env.WORKBUDDY_CREDIT_API_KEY??""});}
    catch {try{store.creditBalances.configurationError(process.env.WORKBUDDY_CREDIT_SOURCE_ID??"workbuddy2api-credit");}catch{/* optional source bookkeeping cannot prevent task reads */}
      console.error(JSON.stringify({event:"credit_source_configuration_invalid",message:"Credit observations are unavailable; task reads remain available."}));}
  }
  const bound = await server.listen(port);
  quota?.start();
  credit?.start();
  console.log(JSON.stringify({ ok: true, event: "workbench_http_listening", port: bound, backend: config.backend, readOnly: true }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, event: "workbench_http_bind_failed", message: error instanceof Error ? error.message : String(error) }));
  store.close();
  process.exit(1);
}

let closing:Promise<void>|undefined;
const close=()=>closing??=(async()=>{await Promise.all([quota?.stop(),credit?.stop()]);await server.close();store.close();})();
process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
