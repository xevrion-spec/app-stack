import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createActivities, TASK_QUEUE } from "../src/index.js";
import { msOf } from "../src/workflows.js";
import { createApp } from "../../../apps/api/src/app.js";
import { makeLocalEnv } from "../../../apps/api/dev/local-env.js";

const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
const CSV = "Date,Description,Amount\n01/07/2026,STRIPE PAYOUT REF 1,1200.00\n05/07/2026,MYSTERY PAYEE 99,-80.00\n";
const CLEAN = "Date,Description,Amount\n01/07/2026,STRIPE PAYOUT REF 2,600.00\n03/07/2026,GITHUB INC,-3.20\n";

describe("Temporal monthlyClose workflow (real API code in-process, time-skipping server)", () => {
  let env: TestWorkflowEnvironment;
  let dir: string;
  let local: ReturnType<typeof makeLocalEnv>;
  const app = createApp();
  const appFetch = ((req: Request) => Promise.resolve(app.request(req, undefined, local.env))) as unknown as typeof fetch;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    dir = mkdtempSync(join(tmpdir(), "wf-"));
    local = makeLocalEnv(dir);
  }, 120_000);
  afterAll(async () => {
    await env?.teardown();
    local?.raw.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function tenant(email: string) {
    const r = await app.request("/v1/tenants", { method: "POST", headers: { "x-dev-user": email, "content-type": "application/json" }, body: JSON.stringify({ name: "WF Co (synthetic)", vatRegistered: true, vatScheme: "standard" }) }, local.env);
    expect(r.status).toBe(201);
  }
  async function worker(email: string) {
    return Worker.create({ connection: env.nativeConnection, taskQueue: TASK_QUEUE, workflowsPath, activities: createActivities({ baseUrl: "http://api.test", devUser: email, fetch: appFetch }) });
  }
  const input = (csv: string) => ({ csv, periodStart: "2026-07-01", periodEnd: "2026-09-30", processingPoll: "1 second", reviewPoll: "1 hour", reviewTimeout: "72 hours" });

  it("clean month: ingests, waits for the pipeline, drafts VAT without human review", async () => {
    await tenant("wf.clean@example.test");
    const w = await worker("wf.clean@example.test");
    const res = await w.runUntil(env.client.workflow.execute("monthlyClose", { taskQueue: TASK_QUEUE, workflowId: "wf-clean", args: [input(CLEAN)] }));
    expect(res.stage).toBe("done");
    expect(res.inserted).toBe(2);
    expect(res.vat.status).toBe("draft");
    expect(res.vat.box1).toBe(10000);
  }, 60_000);

  it("month with exceptions waits for the reviewComplete signal, then drafts VAT", async () => {
    await tenant("wf.review@example.test");
    const w = await worker("wf.review@example.test");
    await w.runUntil(async () => {
      const h = await env.client.workflow.start("monthlyClose", { taskQueue: TASK_QUEUE, workflowId: "wf-review", args: [input(CSV)] });
      // wait until the workflow is parked on review
      for (let i = 0; i < 100; i++) {
        const s = await h.query<{ stage: string }>("status");
        if (s.stage === "awaiting_review") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect((await h.query<{ stage: string; openExceptions: number }>("status")).openExceptions).toBeGreaterThan(0);
      await h.signal("reviewComplete", { by: "reviewer@example.test" });
      const res = await h.result();
      expect(res.stage).toBe("done");
      expect(res.reviewedBy).toBe("reviewer@example.test");
    });
  }, 60_000);

  it("gives up after the review timeout without drafting VAT (time-skipped 72h)", async () => {
    await tenant("wf.timeout@example.test");
    const w = await worker("wf.timeout@example.test");
    const res = await w.runUntil(env.client.workflow.execute("monthlyClose", { taskQueue: TASK_QUEUE, workflowId: "wf-timeout", args: [input(CSV.replace("REF 1", "REF 3").replace("99", "77"))] }));
    expect(res.stage).toBe("review_timeout");
    expect(res.vat).toBeUndefined();
  }, 60_000);

  it("duration parser", () => {
    expect(msOf("5 seconds")).toBe(5000);
    expect(msOf("72 hours")).toBe(72 * 3600_000);
    expect(() => msOf("soon")).toThrow();
  });
});
