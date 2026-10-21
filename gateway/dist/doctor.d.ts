import { type DiscoveryOptions } from "./deployment-paths.js";
export declare const APPROVED_FREE_MODEL = "deepseek-v4.1-flash";
export declare function checkNativeSchema(directory: string | undefined): boolean;
export declare function diagnose(options?: DiscoveryOptions & {
    root?: string;
    live?: boolean;
    port?: number;
    probe?: () => Promise<{
        bridgeReady: boolean;
        models?: Array<{
            id: string;
            credits?: unknown;
        }>;
    }>;
}): Promise<{
    ok: boolean;
    readOnly: boolean;
    mode: string;
    runtime: {
        packageVersion: string;
        release: "portability-20261018.1";
        codeHash: string;
    };
    checks: {
        nodeSupported: boolean;
        platformSupported: boolean;
        buildPresent: boolean;
        applicationPresent: boolean;
        configSchemaCompatible: boolean;
        desktopRoute: boolean;
        freePolicyEnabled: boolean;
    };
    localSetupReady: boolean;
    discovery: {
        application: "environment" | "detected" | "missing" | "ambiguous";
        config: "environment" | "detected" | "missing" | "ambiguous";
    };
    connection: "verified" | "unavailable" | "not_checked" | "bridge_missing";
    modelPolicy: "blocked" | "unknown" | "verified" | "not_checked";
    login: string;
    quota: string;
    taskExecutionVerified: boolean;
    taskSent: boolean;
    nextSteps: string[];
}>;
export declare function runDoctor(args?: string[]): Promise<void>;
