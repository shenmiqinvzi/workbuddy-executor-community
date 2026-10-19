export interface DetectedPath {
    value?: string;
    source: "environment" | "detected" | "missing" | "ambiguous";
    candidates: string[];
}
export interface DiscoveryOptions {
    env?: NodeJS.ProcessEnv;
    home?: string;
    platform?: NodeJS.Platform;
    runningExecutables?: () => string[];
}
export declare function discoverDesktopPaths(options?: DiscoveryOptions): {
    executable: DetectedPath;
    config: DetectedPath;
};
export declare function supportedNode(version?: string): boolean;
