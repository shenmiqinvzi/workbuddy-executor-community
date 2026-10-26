import { DshClient } from "./dsh-client.js";
import { DshTaskCoordinator } from "./dsh-coordinator.js";
import { workBuddyDshFreeRateVerifier } from "./dsh-rate-verifier.js";
/** Explicit private configuration only; enabling an adapter never widens the
 * persisted model policy, confirms a plan or starts a provider request. */
export function configuredDshCoordinator(store, runsDir, env = process.env) {
    if (env.WORKBUDDY_DSH_ENABLED !== "1")
        return undefined;
    try {
        const hostId = env.WORKBUDDY_DSH_HOST_ID;
        const providerId = env.WORKBUDDY_DSH_PROVIDER_ID;
        const client = new DshClient(env.WORKBUDDY_DSH_REGISTRY_DIR, hostId);
        const rate = env.WORKBUDDY_DSH_RATE_SOURCE_URL && hostId && providerId
            ? workBuddyDshFreeRateVerifier({ baseUrl: env.WORKBUDDY_DSH_RATE_SOURCE_URL, apiKey: env.WORKBUDDY_DSH_RATE_API_KEY ?? "", connectionId: hostId, providerId }) : undefined;
        return new DshTaskCoordinator(store, client, runsDir, rate);
    }
    catch {
        console.error(JSON.stringify({ event: "dsh_configuration_invalid", message: "The optional DSH adapter is unavailable; no credentials are included." }));
        return undefined;
    }
}
//# sourceMappingURL=dsh-runtime.js.map