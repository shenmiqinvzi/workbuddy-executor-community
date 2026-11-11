import path from "node:path";

export interface CommandSpecOverrides {
  executable?: string;
  args?: string[];
  cwd?: string;
  timeoutSeconds?: number;
  inputs?: string[];
}

/**
 * The exact JSON CommandSpec text a caller must submit for an acceptance
 * command. Tests that only need a well-formed check use this instead of a
 * free-text line, because free text is rejected at admission.
 */
export function commandSpec(workspace: string, overrides: CommandSpecOverrides = {}): string {
  return JSON.stringify({
    executable: process.execPath,
    args: ["-p", "'checked'"],
    cwd: path.resolve(workspace),
    timeoutSeconds: 60,
    inputs: ["RESULT.md"],
    ...overrides,
  });
}
