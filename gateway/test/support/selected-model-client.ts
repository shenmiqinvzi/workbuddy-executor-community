import path from "node:path";
import type { Config } from "../../src/config.js";
import { WorkBuddyClient } from "../../src/workbuddy-client.js";
import { RunJournal, runsDirectory, writePrivateJson } from "../../src/run-journal.js";

/** Positive transport fixtures explicitly choose this synthetic native model.
 * Its native readback is supplied here; other model IDs still need the wake
 * adapter to verify them. Missing-selection tests use the production client.
 */
export class SelectedModelClient extends WorkBuddyClient {
  constructor(private readonly fixtureConfig: Config) { super(fixtureConfig); }
  override async sendMessage(...args: Parameters<WorkBuddyClient["sendMessage"]>) {
    const result = await super.sendMessage(...args);
    const options = args[4];
    if (this.fixtureConfig.backend === "desktop-queue" && options?.model === "synthetic-user-choice" && options.attemptId) {
      const journal = new RunJournal(runsDirectory(this.fixtureConfig), options.attemptId);
      const request = journal.request();
      writePrivateJson(path.join(journal.dir, "model-ready.json"), { model: request.model, sessionId: request.sessionId, attemptId: request.attemptId });
    }
    return result;
  }
}
