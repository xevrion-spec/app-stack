/**
 * Activities call the Autopilot API through the generated SDK, so Temporal orchestrates exactly the code paths the app uses.
 * Auth: production uses a Cloudflare Access service token (headers supplied by the operator); dev uses x-dev-user.
 */
import { createSdk } from "@xevrion/sdk";
import { ApplicationFailure } from "@temporalio/activity";
import type { Activities } from "./types.js";

export interface ActivityConfig {
  baseUrl: string;
  devUser?: string;
  tenantId?: string;
  /** e.g. { "CF-Access-Client-Id": ..., "CF-Access-Client-Secret": ... } from the environment; never logged. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

function fail(status: number, what: string, body: unknown): never {
  const msg = `${what} failed: HTTP ${status} ${JSON.stringify((body as { error?: unknown })?.error ?? "").slice(0, 200)}`;
  // 4xx (except 408/429) will not succeed on retry.
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) throw ApplicationFailure.nonRetryable(msg, "ClientError");
  throw new Error(msg);
}

export function createActivities(cfg: ActivityConfig): Activities {
  const f: typeof fetch = (input, init) => {
    const req = new Request(input as Request, init);
    for (const [k, v] of Object.entries(cfg.headers ?? {})) req.headers.set(k, v);
    return (cfg.fetch ?? fetch)(req);
  };
  const sdk = createSdk({
    baseUrl: cfg.baseUrl,
    fetch: f,
    ...(cfg.devUser ? { devUser: cfg.devUser } : {}),
    ...(cfg.tenantId ? { tenantId: cfg.tenantId } : {}),
  });
  return {
    async uploadStatement(csv, filename) {
      const r = await sdk.POST("/v1/uploads/bank-csv", {
        body: csv as never,
        bodySerializer: (b: unknown) => b as string,
        headers: { "content-type": "text/csv", "x-filename": filename },
      });
      if (!r.data) fail(r.response.status, "upload", r.error);
      return { jobId: r.data.jobId ?? null, inserted: r.data.inserted, duplicates: r.data.duplicates };
    },
    async getJob(jobId) {
      const r = await sdk.GET("/v1/jobs/{id}", { params: { path: { id: jobId } } });
      if (!r.data) fail(r.response.status, "getJob", r.error);
      return { status: r.data.job.status, qaScore: r.data.job.qa_score ?? null };
    },
    async countOpenExceptions() {
      let n = 0;
      let cursor: string | undefined;
      for (let i = 0; i < 50; i++) {
        const r = await sdk.GET("/v1/exceptions", { params: { query: { status: "open", limit: 100, ...(cursor ? { cursor } : {}) } as never } });
        if (!r.data) fail(r.response.status, "exceptions", r.error);
        n += r.data.items.length;
        cursor = r.data.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return n;
    },
    async computeVatDraft(periodStart, periodEnd) {
      const r = await sdk.POST("/v1/vat/drafts", { body: { periodStart, periodEnd } });
      if (!r.data) fail(r.response.status, "vat", r.error);
      return { id: r.data.id, box1: r.data.box1, box4: r.data.box4, box5: r.data.box5, status: r.data.status };
    },
  };
}
