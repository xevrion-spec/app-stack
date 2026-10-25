import { describe, it, expect, afterEach, vi } from "vitest";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";
import { __setComplianceProviders } from "../src/routes/compliance.js";
import { MockMtdGateway, TextReceiptExtractor, MockExtractor } from "@xevrion/books";

const A = "owner-a@example.test",
  B = "owner-b@example.test",
  R = "reviewer-a@example.test";
async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Beta" } });
  await call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } });
  const tA = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  const up = await call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
  await runPipeline(h.env, tA, up.json.jobId);
  return { ...h, call, tA };
}
afterEach(() => __setComplianceProviders({ extractor: new TextReceiptExtractor(), gateway: () => new MockMtdGateway() }));

describe("extraction", () => {
  it("extracts from text; reviewers allowed; validates body", async () => {
    const { call } = await setup();
    const r = await call("POST", "/v1/extract/text", {
      user: R,
      raw: "Cafe Nero\n01/08/2026\nVAT £0.50\nTotal £3.00",
      headers: { "content-type": "text/plain" },
    });
    expect(r.json).toMatchObject({ extractor: "text-rules", totalPence: 300, vatPence: 50, date: "2026-08-01" });
    expect((await call("POST", "/v1/extract/text", { user: A, raw: "", headers: { "content-type": "text/plain" } })).status).toBe(400);
    __setComplianceProviders({ extractor: new MockExtractor() });
    expect((await call("POST", "/v1/extract/text", { user: A, raw: "x", headers: { "content-type": "text/plain" } })).json.extractor).toBe("mock");
  });
});

describe("extraction with a configured LLM (FreeLLMAPI-compatible, stubbed)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("asks the LLM only when rules are unsure, validates its reply and keeps it in review", async () => {
    const { call, env } = await setup();
    Object.assign(env, { LLM_BASE_URL: "http://llm.invalid/v1", LLM_API_KEY: "test-key", LLM_MODEL: "auto" });
    const fetchMock = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"vendor":"Demo Cafe","date":"2026-08-01","totalPence":300,"vatPence":null}' } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const confident = await call("POST", "/v1/extract/text", {
      user: A,
      raw: "Cafe Nero\n01/08/2026\nVAT £0.50\nTotal £3.00",
      headers: { "content-type": "text/plain" },
    });
    expect(confident.json).toMatchObject({ extractor: "text-rules+llm", totalPence: 300 });
    expect(fetchMock).not.toHaveBeenCalled();
    const messy = await call("POST", "/v1/extract/text", {
      user: A,
      raw: "Demo Cafe\nthree pounds, first of August",
      headers: { "content-type": "text/plain" },
    });
    expect(messy.json).toMatchObject({ extractor: "text-rules+llm", totalPence: 300, date: "2026-08-01", needsReview: true });
    expect(messy.json.confidence).toBeLessThanOrEqual(0.8);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementationOnce(async () => new Response("down", { status: 503 }));
    const down = await call("POST", "/v1/extract/text", { user: A, raw: "Demo Cafe\nthree pounds", headers: { "content-type": "text/plain" } });
    expect(down.json).toMatchObject({ totalPence: null, needsReview: true });
  });
});

describe("MTD (mock)", () => {
  it("obligations, preview from ledger, confirmed submit once, history; owner-only; tenant isolated", async () => {
    const { call, raw, tA } = await setup();
    const ob = await call("GET", "/v1/mtd/obligations?taxYear=2026-27", { user: A });
    expect(ob.json).toMatchObject({ gateway: "mock-hmrc", sandbox: true });
    expect(ob.json.obligations[0]).toMatchObject({ periodKey: "2026-27-Q1", status: "open" });
    const pv = await call("POST", "/v1/mtd/quarterly-updates/preview", { user: A, body: { periodKey: "2026-27-Q2" } });
    expect(pv.json.update.turnoverPence).toBeGreaterThan(0); // July 2026 bank lines fall in Q2 (6 Jul - 5 Oct)
    expect(pv.json.verified).toBe(false);
    expect((await call("POST", "/v1/mtd/quarterly-updates", { user: A, body: { periodKey: "2026-27-Q2" } })).status).toBe(400); // confirm required
    const s = await call("POST", "/v1/mtd/quarterly-updates", { user: A, body: { periodKey: "2026-27-Q2", confirm: true } });
    expect(s.status).toBe(201);
    expect(s.json).toMatchObject({ sandbox: true, gateway: "mock-hmrc" });
    expect(s.json.notice).toMatch(/nothing was sent to HMRC/);
    expect((await call("POST", "/v1/mtd/quarterly-updates", { user: A, body: { periodKey: "2026-27-Q2", confirm: true } })).status).toBe(409);
    expect((await call("GET", "/v1/mtd/obligations?taxYear=2026-27", { user: A })).json.obligations[1].status).toBe("fulfilled");
    expect((await call("GET", "/v1/mtd/submissions", { user: A })).json).toHaveLength(1);
    expect((await call("GET", "/v1/mtd/submissions", { user: B })).json).toHaveLength(0);
    expect((await call("GET", "/v1/mtd/obligations?taxYear=2026-27", { user: R })).status).toBe(403);
    expect((raw.prepare("select count(*) n from audit_log where tenant_id = ? and action = 'mtd.quarterly_update.mock'").get(tA) as { n: number }).n).toBe(1);
  });
  it("bad tax year and gateway validation map to 400", async () => {
    const { call } = await setup();
    expect((await call("GET", "/v1/mtd/obligations?taxYear=2026", { user: A })).status).toBe(400);
    __setComplianceProviders({
      gateway: () => ({
        name: "strict",
        obligations: (ty) => new MockMtdGateway().obligations(ty),
        submitQuarterlyUpdate: async () => {
          const { MtdValidationError } = await import("@xevrion/books");
          throw new MtdValidationError("rejected by gateway");
        },
      }),
    });
    const r = await call("POST", "/v1/mtd/quarterly-updates", { user: A, body: { periodKey: "2026-27-Q1", confirm: true } });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe("rejected by gateway");
  });
});
