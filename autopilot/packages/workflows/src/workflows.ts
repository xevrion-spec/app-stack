/**
 * Temporal workflow: durable monthly close for one tenant.
 * ingest -> wait for the pipeline (Cloudflare Queue / local in-process) -> wait for a human to clear the review queue
 * (signal or polling, with a timeout) -> compute the DRAFT VAT return. Never submits anything to HMRC.
 * Deterministic: only @temporalio/workflow APIs and type imports here; all I/O is in activities.
 */
import { ApplicationFailure, condition, defineQuery, defineSignal, proxyActivities, setHandler, sleep } from "@temporalio/workflow";
import type { Activities, MonthlyCloseInput, MonthlyCloseResult, MonthlyCloseState } from "./types.js";

export const reviewCompleteSignal = defineSignal<[{ by: string }]>("reviewComplete");
export const statusQuery = defineQuery<MonthlyCloseState>("status");

const acts = proxyActivities<Activities>({
  startToCloseTimeout: "2 minutes",
  retry: { initialInterval: "2s", backoffCoefficient: 2, maximumInterval: "1 minute", maximumAttempts: 6, nonRetryableErrorTypes: ["ClientError"] },
});

export async function monthlyClose(input: MonthlyCloseInput): Promise<MonthlyCloseResult> {
  const state: MonthlyCloseState = { stage: "ingest" };
  let reviewedBy: string | undefined;
  setHandler(statusQuery, () => ({ ...state }));
  setHandler(reviewCompleteSignal, ({ by }) => {
    reviewedBy = by;
  });

  const up = await acts.uploadStatement(input.csv, input.filename ?? "statement.csv");
  const base = { inserted: up.inserted, duplicates: up.duplicates };
  if (!up.jobId) throw ApplicationFailure.nonRetryable("Upload produced no job", "NoJob");
  state.jobId = up.jobId;

  state.stage = "processing";
  let job = await acts.getJob(up.jobId);
  for (let i = 0; i < 120 && (job.status === "queued" || job.status === "running"); i++) {
    await sleep(input.processingPoll ?? "5 seconds");
    job = await acts.getJob(up.jobId);
  }
  if (job.status === "failed") {
    state.stage = "failed";
    return { ...state, ...base, qaScore: job.qaScore };
  }
  if (job.status === "queued" || job.status === "running") throw ApplicationFailure.nonRetryable("Pipeline did not finish in time", "PipelineTimeout");

  state.openExceptions = await acts.countOpenExceptions();
  if (state.openExceptions > 0) {
    state.stage = "awaiting_review";
    const deadline = Date.now() + msOf(input.reviewTimeout ?? "72 hours"); // workflow Date.now() is deterministic
    while (!reviewedBy && state.openExceptions > 0 && Date.now() < deadline) {
      await condition(() => !!reviewedBy, input.reviewPoll ?? "1 hour");
      state.openExceptions = await acts.countOpenExceptions();
    }
    if (!reviewedBy && state.openExceptions > 0) {
      state.stage = "review_timeout";
      return { ...state, ...base, qaScore: job.qaScore };
    }
    if (reviewedBy) state.reviewedBy = reviewedBy;
  }

  state.stage = "vat_draft";
  const vat = await acts.computeVatDraft(input.periodStart, input.periodEnd);
  state.stage = "done";
  return { ...state, ...base, qaScore: job.qaScore, vat };
}

/** Tiny duration parser ("5 seconds", "1 hour", "72 hours", "30 minutes", "2 days"). */
export function msOf(d: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i.exec(d.trim());
  if (!m) throw new Error(`bad duration ${d}`);
  const n = Number(m[1]);
  const u = m[2]!.toLowerCase();
  const mult = u.startsWith("ms") || u.startsWith("milli") ? 1 : u.startsWith("s") ? 1e3 : u.startsWith("m") ? 6e4 : u.startsWith("h") ? 36e5 : 864e5;
  return n * mult;
}
