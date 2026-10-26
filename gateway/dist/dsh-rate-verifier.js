import { LocalStatisticsClient } from "./local-statistics-client.js";
import { AdmissionError } from "./collaboration.js";
/** Operator-owned mapping of the actual DSH route to its existing gateway key.
 * The browser cannot submit this mapping or a claimed-free rate. This observes
 * the source catalog, not account balances or downstream physical models. */
export function workBuddyDshFreeRateVerifier(input) {
    const client = new LocalStatisticsClient(input);
    const connectionId = input.connectionId, providerId = input.providerId;
    return async (execution) => {
        if (execution.executorId !== "dsh" || execution.connectionId !== connectionId || execution.providerId !== providerId)
            throw new AdmissionError("MODEL_BINDING_CHANGED", "The rate source is not mapped to this DSH connection and provider.");
        let payload;
        try {
            payload = await client.read("/v1/models", AbortSignal.timeout(5000));
        }
        catch {
            throw new AdmissionError("COST_VERIFICATION_UNAVAILABLE", "The configured source catalog could not verify this rate.");
        }
        const data = payload?.data;
        if (!Array.isArray(data) || data.length > 2000)
            throw new AdmissionError("COST_VERIFICATION_UNAVAILABLE", "Invalid source model catalog.");
        const candidates = data.filter(model => model && typeof model === "object" && model.id === execution.modelId);
        if (candidates.length !== 1 || typeof candidates[0].credits !== "string" || !/^x0(?:\.0+)?(?: credits)?$/i.test(candidates[0].credits.trim()))
            throw new AdmissionError("MODEL_UNVERIFIED", "The exact source model has no verified zero credit rate.");
        return { credits: candidates[0].credits.trim(), observedAt: new Date().toISOString() };
    };
}
//# sourceMappingURL=dsh-rate-verifier.js.map