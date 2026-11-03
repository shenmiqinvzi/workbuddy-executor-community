import type { Config } from "./config.js";
import type { NativeDesktopTrigger } from "./persistent-service.js";
export declare const RENDERER_BRIDGE: string;
/** One place that decides which native model policy the gateway asks for.
 * WORKBUDDY_PINNED_MODEL pins an exact model without demanding a zero rate;
 * WORKBUDDY_REQUIRED_FREE_MODEL is the legacy pin that also demands x0. */
export declare function nativeModelPolicy(env?: NodeJS.ProcessEnv): {
    model: string;
    requireZeroRate: boolean;
};
export declare function rendererBridgeForFreeModel(model: string): string;
/** Injects the exact model the native app is pinned to, plus whether that pin
 * also demands a verified zero rate. A pinned paid model is allowed only when
 * the caller says the pin does not carry the free-only rule. */
export declare function rendererBridgeForPolicy(policy: {
    model: string;
    requireZeroRate: boolean;
}): string;
export declare function matchesNativeRendererFileUrl(url: string | undefined, archivePath: string): boolean;
export interface NativeDesktopProcessControl {
    run(file: string, args: string[], timeoutMs: number): string;
    launch(executable: string, cdpPort: number): void;
    pause(milliseconds: number): Promise<void>;
}
export declare class NativeDesktopRpcTrigger implements NativeDesktopTrigger {
    private readonly config;
    readonly cdpPort: number;
    private readonly autoLaunch;
    private readonly processControl;
    private observer?;
    private socket?;
    private sequence;
    private pending;
    private connection?;
    constructor(config: Config, cdpPort: number, autoLaunch?: boolean, processControl?: NativeDesktopProcessControl);
    private portState;
    /** Windows port ownership is proven by the process that listens on it. */
    private portStateWindows;
    /** Get-Process reports the image path without WMI, so it still answers in filtered sessions. */
    private executablePathOf;
    private ownerIsNative;
    private nativePids;
    /** Root WorkBuddy processes: the executable matches and it is not a helper child. */
    private nativePidsWindows;
    private rootPidExists;
    /**
     * Close the native app the way the ordinary quit command does, then wait for
     * it to disappear so the startup switch can be applied by a fresh launch.
     */
    private quitNativeWindows;
    private canEnablePortWithoutInterruptingWork;
    private discover;
    /** A renderer belongs to this app when its decoded file URL lives under the asar bundle beside the configured executable. */
    private isAppUrl;
    /** Ownership proof that does not depend on the OS process table: the renderer must belong to the configured app. */
    private identifiesAsNative;
    private discoverWindows;
    private connect;
    private evaluateConnected;
    private call;
    listModels(sessionId?: string): Promise<{
        models: Array<{
            id: string;
            name: string;
        }>;
        currentModel?: string;
        sessionId?: string;
    }>;
    setModel(sessionId: string, model: string): Promise<{
        sessionId: string;
        model: string;
    }>;
    /** Inspect an existing bridge without installing/configuring it or launching the app. */
    diagnoseReadOnly(): Promise<{
        bridgeReady: boolean;
        models?: Array<{
            id: string;
            credits?: unknown;
        }>;
    }>;
    createWorker(workspace: string, sessionId: string, title?: string): Promise<{
        sessionId: string;
        workspace: string;
    }>;
    inspect(sessionId: string, options?: {
        readOnly?: boolean;
    }): ReturnType<NativeDesktopTrigger["inspect"]>;
    findWake(sessionId: string, wakeId: string): Promise<boolean>;
    cancelAttempt(sessionId: string, wakeId: string, workspace: string): Promise<void>;
    wakeIdle(sessionId: string, wakeId: string, prompt: string, model?: string): ReturnType<NativeDesktopTrigger["wakeIdle"]>;
    close(): void;
}
export declare function createNativeDesktopTrigger(config: Config, options: {
    cdpPort: number;
}): NativeDesktopRpcTrigger;
