export interface MonthlyCloseInput {
  /** Bank statement CSV (synthetic in dev/test). */
  csv: string;
  filename?: string;
  periodStart: string;
  periodEnd: string;
  /** How long to wait for a human to clear the review queue before giving up (default 72h). */
  reviewTimeout?: string;
  /** Poll interval while waiting for review (default 1h) and for processing (default 5s). */
  reviewPoll?: string;
  processingPoll?: string;
}
export type Stage = "ingest" | "processing" | "awaiting_review" | "vat_draft" | "done" | "review_timeout" | "failed";
export interface MonthlyCloseState {
  stage: Stage;
  jobId?: string;
  openExceptions?: number;
  reviewedBy?: string;
}
export interface MonthlyCloseResult extends MonthlyCloseState {
  inserted: number;
  duplicates: number;
  qaScore: number | null;
  vat?: { id: string; box1: number; box4: number; box5: number; status: string };
}
export interface JobStatus {
  status: string;
  qaScore: number | null;
}
export interface Activities {
  uploadStatement(csv: string, filename: string): Promise<{ jobId: string | null; inserted: number; duplicates: number }>;
  getJob(jobId: string): Promise<JobStatus>;
  countOpenExceptions(): Promise<number>;
  computeVatDraft(periodStart: string, periodEnd: string): Promise<{ id: string; box1: number; box4: number; box5: number; status: string }>;
}
