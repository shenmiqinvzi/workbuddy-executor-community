import { DeepSeekClient, type DeepSeekTransport, type DeepSeekSession } from "./deepseek-client.js";
import type { ExecutionSelection } from "./task-contract.js";
export type DshSelection = Pick<ExecutionSelection, "providerId" | "modelId" | "reasoningEffort">;
export interface DshSession extends DeepSeekSession {
    selectedModel: DshSelection | null;
}
export interface DshCatalog {
    models: Array<{
        providerId: string;
        modelId: string;
        reasoningEfforts: string[];
        credits: string | null;
    }>;
    pricingVerified: boolean;
}
export interface DshTransport extends DeepSeekTransport {
    models(hostId: string): Promise<DshCatalog>;
    selectModel(input: DshSelection & {
        hostId: string;
        sessionId: string;
    }): Promise<DshSession>;
    session(input: {
        hostId: string;
        sessionId: string;
    }): Promise<DshSession>;
    prompt(input: {
        hostId: string;
        sessionId: string;
        requestId: string;
        text: string;
        expectedSelection?: DshSelection;
    }): Promise<{
        requestId: string;
        accepted: boolean;
        turnId?: string;
    }>;
}
export declare class DshClient extends DeepSeekClient implements DshTransport {
    models(hostId: string): Promise<DshCatalog>;
    selectModel({ hostId, ...input }: DshSelection & {
        hostId: string;
        sessionId: string;
    }): Promise<DshSession>;
    session({ hostId, ...input }: {
        hostId: string;
        sessionId: string;
    }): Promise<DshSession>;
    prompt({ hostId, ...input }: Parameters<DshTransport["prompt"]>[0]): Promise<{
        requestId: string;
        accepted: boolean;
        turnId?: string;
    }>;
}
/** Read-only CLI discovery. No BridgeStore.init(), lease renewal, native
 * session activation or credentials are involved. Missing and unreadable differ. */
export declare function discoverDshSessions(directory: string, sessionId?: string, registryFile?: string): {
    queriedDirectory: string;
    registry: "missing";
    reason: "registry_missing";
    candidates: never[];
    selected?: undefined;
} | {
    queriedDirectory: string;
    registry: "available";
    reason: "ambiguous" | "matched" | "session_not_matched" | "no_matching_live_session";
    candidates: {
        sessionId: string;
        workspace: string;
    }[];
    selected: {
        sessionId: string;
        workspace: string;
    } | undefined;
} | {
    queriedDirectory: string;
    registry: "unreadable";
    reason: "registry_unreadable";
    candidates: never[];
    selected?: undefined;
};
