import { type NativeProcess } from "./native-process.js";
/** A killed supervisor cannot write its final record. Its non-inheritable Job
 * handle is closed by Windows, killing all owned descendants. Prove the exact
 * supervisor is absent; never infer ownership or terminate by process name. */
export declare function reconcileOwnedCommands(directory: string, inspect?: () => NativeProcess[]): {
    recovered: string[];
};
