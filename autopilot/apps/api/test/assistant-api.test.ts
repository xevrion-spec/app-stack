import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";
import { __setAssistantRouter } from "../src/routes/assistant.js";
import { MockLlmRouter } from "@xevrion/books";

const A = "owner-a@example.test",
  B = "owner-b@example.test",
  R = "reviewer-a@example.test";
async function setup(withBooks = true) {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha", vatRegistered: true, vatScheme: "standard" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Beta" } });
  await call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } });
  const tA = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  if (withBooks) {
    const up = await call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    await runPipeline(h.env, tA, up.json.jobId);
  }
  const ask = (question: string, user = A) => call("POST", "/v1/assistant/ask", { user, body: { question, today: "2026-08-20" } });
  return { ...h, call, tA, ask };
}
afterEach(() => __setAssistantRouter(null));

describe("assistant", () => {
  it("spend by category with citations", async () => {
    const { ask } = await setup();
    const r = await ask("How much did I spend on travel in July 2026?");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ intent: "spend", grounded: true, router: "rules" });
    expect(r.json.figures.totalPence).toBeGreaterThan(0);
    expect(r.json.citations.length).toBeGreaterThan(0);
    expect(r.json.citations[0].type).toBe("transaction");
    expect(r.json.answer).toMatch(/£/);
  });
  it("income, profit, top merchants, vat, recurring, runway, tax", async () => {
    const { ask } = await setup();
    expect((await ask("What was my income in July 2026")).json.figures.totalPence).toBe(205000);
    const p = await ask("What was my profit in July 2026");
    expect(p.json.citations[0]).toMatchObject({ type: "report" });
    expect(p.json.figures.netProfitPence).toBe(p.json.figures.incomePence - p.json.figures.expensesPence);
    expect((await ask("Who are my biggest suppliers in July 2026")).json.intent).toBe("top_merchants");
    expect((await ask("What is my VAT for July 2026")).json.figures).toHaveProperty("netPence");
    expect((await ask("What subscriptions am I paying for")).json.intent).toBe("recurring");
    expect((await ask("How long will my cash last")).json.figures).toHaveProperty("runwayDays");
    const t = await ask("How much tax should I set aside");
    expect(t.json.answer).toMatch(/UNVERIFIED/);
  });
  it("outstanding invoices cites invoices", async () => {
    const { ask, call } = await setup();
    const i = (
      await call("POST", "/v1/invoices", {
        user: A,
        body: {
          customerName: "Acme",
          issueDate: "2026-07-01",
          dueDate: "2026-07-31",
          lines: [{ description: "d", quantity: 1, unitPence: 10000, vatRateCode: "STD" }],
        },
      })
    ).json;
    await call("POST", `/v1/invoices/${i.id}/status`, { user: A, body: { status: "sent" } });
    const r = await ask("Who owes me money?");
    expect(r.json.figures).toMatchObject({ outstandingPence: 12000, count: 1, overdue: 1 });
    expect(r.json.citations[0]).toMatchObject({ type: "invoice", id: i.id });
    expect((await ask("Who owes me money?", B)).json.figures.count).toBe(0);
  });
  it("unknown questions are not guessed; an LLM router can map paraphrases", async () => {
    const { ask } = await setup(false);
    const u = await ask("Tell me a joke");
    expect(u.json).toMatchObject({ grounded: false, intent: "unknown" });
    expect(u.json.suggestions.length).toBeGreaterThan(3);
    __setAssistantRouter(new MockLlmRouter());
    const m = await ask("how much money left do I have?");
    expect(m.json).toMatchObject({ intent: "runway", router: "mock-llm" });
  });
  it("tenant isolated and plan gated", async () => {
    const { ask, raw, tA, call } = await setup();
    expect((await ask("What was my income in July 2026", B)).json.figures.totalPence).toBe(0);
    raw.prepare("update tenants set plan = 'free' where id = ?").run(tA);
    expect((await ask("What was my income in July 2026")).status).toBe(403);
    expect((await call("GET", "/v1/assistant/suggestions", { user: B })).status).toBe(200);
  });
});

describe("onboarding", () => {
  it("checklist reflects data; sample data loads only when empty and is removable", async () => {
    const { call } = await setup(false);
    const o = await call("GET", "/v1/onboarding", { user: A });
    expect(o.json.steps.find((s: { id: string }) => s.id === "import").done).toBe(false);
    expect(o.json.steps.find((s: { id: string }) => s.id === "accountant").done).toBe(true);
    expect((await call("POST", "/v1/onboarding/sample-data", { user: R })).status).toBe(403);
    expect((await call("POST", "/v1/onboarding/sample-data", { user: A })).json.inserted).toBe(9);
    expect((await call("GET", "/v1/onboarding", { user: A })).json.sampleData).toBe(true);
    expect((await call("POST", "/v1/onboarding/sample-data", { user: A })).status).toBe(409);
    // categorise one sample row twice (journal + reversal) so removal must clean the ledger too
    const sid = (await call("GET", "/v1/transactions", { user: A })).json.items?.[0]?.id ?? (await call("GET", "/v1/transactions", { user: A })).json[0]?.id;
    for (const code of ["6200", "6100"])
      expect((await call("PATCH", `/v1/transactions/${sid}`, { user: A, body: { categoryCode: code, vatRateCode: null, vatPence: 0 } })).status).toBe(200);
    expect((await call("DELETE", "/v1/onboarding/sample-data", { user: A })).json.removed).toBe(9);
    expect((await call("GET", "/v1/onboarding", { user: A })).json.sampleData).toBe(false);
  });
  it("import step completes after a real upload", async () => {
    const { call } = await setup(true);
    const o = await call("GET", "/v1/onboarding", { user: A });
    expect(o.json.steps.find((s: { id: string }) => s.id === "import").done).toBe(true);
    expect(o.json.total).toBe(7);
  });
});
