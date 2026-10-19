type Action = "plan" | "install" | "upgrade" | "uninstall";
export interface SetupOptions {
    root?: string;
    codexHome?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    workbuddyApp?: string;
    workbuddyConfig?: string;
    apply?: boolean;
}
export declare function assertInstallationIdle(root: string, dbFile: string, runsDir?: string, serviceFile?: string): void;
export declare function setup(action: Action, options?: SetupOptions): {
    ok: boolean;
    action: "uninstall";
    changed: boolean;
    taskDataPreserved: boolean;
    envPreserved: boolean;
    mcpConfigModified: boolean;
    previousSkillRestored: boolean;
    previousSkillWillBeRestored: boolean;
    next: string;
} | {
    ok: boolean;
    action: "install" | "upgrade" | "plan";
    changed: boolean;
    unchanged: boolean;
    application: string;
    configDirectory: string;
    codexHome: string;
    mcpSnippet: string;
    envWillBeCreated: boolean;
    mcpConfigModified: boolean;
    taskSent: boolean;
    next: string;
} | {
    ok: boolean;
    action: "uninstall";
    installed: boolean;
    changed: boolean;
};
export declare function runSetup(args?: string[]): Promise<void>;
export {};
