import type { Config } from "./config.js";
export interface ValidationEvidence {
    path: string;
    sha256: string;
}
export declare function readWorkerObject(config: Config, attemptId: string, file: string, filename: string, maxBytes: number): Record<string, unknown>;
/** Only cited command records and their declared inputs are covered by this check. */
export declare function readValidationEvidence(config: Config, attemptId: string, records: unknown): ValidationEvidence[];
export declare function verifyValidationEvidence(config: Config, attemptId: string, records: ValidationEvidence[]): void;
/** Parse bounded, file-based results; DesktopQueue still proves native ancestry and lease. */
export declare function readWorkerContext(config: Config, claimFile: string): {
    sessionId: string;
    attemptId: string;
    leaseToken: string;
};
export declare function readWorkerResult(config: Config, claimFile: string, resultFile: string): {
    sessionId: string;
    attemptId: string;
    leaseToken: string;
    status: "completed" | "blocked" | "failed" | "cancelled";
    text: string;
    artifacts: string[];
    validationRecords: ValidationEvidence[];
};
