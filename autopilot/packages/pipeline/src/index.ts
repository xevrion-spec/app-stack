/** Pipeline contract shared by the edge API and the Temporal worker. */
export const STAGES = ["intake","extract","categorise","reconcile","draft","qa","review","deliver","outcome"] as const;
export type Stage = typeof STAGES[number];
export interface StageResult<T = unknown> { stage: Stage; ok: boolean; confidence: number; output: T; exceptions: ExceptionItem[]; traceId?: string }
export interface ExceptionItem { reason: string; severity: "low" | "medium" | "high"; payload?: unknown }
/** Policy: anything below this confidence, or any high-severity exception, goes to human review. */
export const REVIEW_THRESHOLD = 0.85;
export const needsReview = (r: StageResult) => r.confidence < REVIEW_THRESHOLD || r.exceptions.some(e => e.severity === "high");
