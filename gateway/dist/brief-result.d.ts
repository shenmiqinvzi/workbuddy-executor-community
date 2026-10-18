export type ResultDetail = "full" | "brief";
export interface BriefResultOptions {
    messageAttemptId?: string;
    sinceEventSeq?: number;
}
/** Presentation only: full returns the original result; brief never edits durable records. */
export declare function resultForDetail(value: unknown, detail?: ResultDetail, options?: BriefResultOptions): unknown;
