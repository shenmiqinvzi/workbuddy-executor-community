import { type StatisticsCredentials } from "./local-statistics-client.js";
import type { DshFreeRateVerifier } from "./dsh-coordinator.js";
/** Operator-owned mapping of the actual DSH route to its existing gateway key.
 * The browser cannot submit this mapping or a claimed-free rate. This observes
 * the source catalog, not account balances or downstream physical models. */
export declare function workBuddyDshFreeRateVerifier(input: StatisticsCredentials & {
    connectionId: string;
    providerId: string;
}): DshFreeRateVerifier;
