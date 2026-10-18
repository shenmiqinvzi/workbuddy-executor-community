/** Absolute path of this installation, independent of the caller's cwd. */
export declare const PROJECT_ROOT: string;
/**
 * Load this installation's .env the way the POSIX launchers do.
 *
 * The sh launchers in bin/ source .env before starting Node; environments that
 * cannot run a sh launcher (Windows, editors, MCP hosts) call this instead.
 * Values already present in the environment always win, so the .env file can
 * never override an explicit host configuration.
 */
export declare function loadDotEnv(file?: string): void;
