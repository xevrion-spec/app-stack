import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { __setInvoiceProviders } from "../src/routes/invoicing.js";
import { MockPaymentLinks, MockFxRates } from "@xevrion/books";

const A = "owner-a@example.test",
  B = "owner-b@example.test",
  R = "reviewer-a@example.test";
const inv = {
  customerName: "Acme Ltd",
  customerEmail: "ap@acme.example.test",
  issueDate: "2026-07-01",
  dueDate: "2026-07-31",
  lines: [{ description: "Design", quantity: 1, unitPence: 10000, vatRateCode: "STD" }],
};

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha", vatRegistered: true, vatScheme: "standard" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Beta" } });
  await call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } });
  const tA = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  const sent = async (body = inv) => {
    const i = (await call("POST", "/v1/invoices", { user: A, body })).json;
    await call("POST", `/v1/invoices/${i.id}/status`, { user: A, body: { status: "sent" } });
    return i as { id: string; number: string; gross_pence: number };
  };
  const evTypes = () => (h.raw.prepare("select type from events where tenant_id = ? order by created_at").all(tA) as { type: string }[]).map((r) => r.type);
  return { ...h, call, tA, sent, evTypes };
}
afterEach(() => __setInvoiceProviders({ paymentLinks: new MockPaymentLinks(), fx: new MockFxRates() }));

describe("partial payments", () => {
  it("records partial then final payment; settles to paid with events and audit", async () => {
    const { call, sent, evTypes } = await setup();
    const i = await sent();
    const p1 = await call("POST", `/v1/invoices/${i.id}/payments`, { user: A, body: { amountPence: 5000, paidDate: "2026-07-10", method: "bank_transfer" } });
    expect(p1.status).toBe(201);
    expect(p1.json).toMatchObject({ state: "partially_paid", outstandingPence: 7000, status: "sent" });
    expect((await call("POST", `/v1/invoices/${i.id}/payments`, { user: A, body: { amountPence: 7001, paidDate: "2026-07-11" } })).status).toBe(409);
    const p2 = await call("POST", `/v1/invoices/${i.id}/payments`, { user: A, body: { amountPence: 7000, paidDate: "2026-07-12" } });
    expect(p2.json).toMatchObject({ state: "paid", outstandingPence: 0, status: "paid" });
    expect(p2.json.payments).toHaveLength(2);
    expect(evTypes().filter((t) => t === "invoice.payment_recorded")).toHaveLength(2);
    expect(evTypes()).toContain("invoice.paid");
    expect((await call("POST", `/v1/invoices/${i.id}/payments`, { user: A, body: { amountPence: 1, paidDate: "2026-07-12" } })).status).toBe(409);
  });
  it("drafts cannot take payments; reviewers forbidden; other tenants 404", async () => {
    const { call } = await setup();
    const d = (await call("POST", "/v1/invoices", { user: A, body: inv })).json;
    expect((await call("POST", `/v1/invoices/${d.id}/payments`, { user: A, body: { amountPence: 1, paidDate: "2026-07-10" } })).status).toBe(409);
    expect((await call("POST", `/v1/invoices/${d.id}/payments`, { user: R, body: { amountPence: 1, paidDate: "2026-07-10" } })).status).toBe(403);
    expect((await call("GET", `/v1/invoices/${d.id}/balance`, { user: B })).status).toBe(404);
    expect((await call("POST", `/v1/invoices/${d.id}/payments`, { user: A, body: { amountPence: 0, paidDate: "2026-07-10" } })).status).toBe(400);
  });
});

describe("credit notes", () => {
  it("issues numbered credit notes with proportional VAT; full credit settles", async () => {
    const { call, sent, raw, tA } = await setup();
    const i = await sent();
    const c1 = await call("POST", `/v1/invoices/${i.id}/credit-notes`, { user: A, body: { grossPence: 6000, reason: "Partial refund" } });
    expect(c1.status).toBe(201);
    expect(c1.json.creditNotes[0]).toMatchObject({ number: `CN-${i.number}-1`, gross_pence: 6000, vat_pence: 1000 });
    expect((await call("POST", `/v1/invoices/${i.id}/credit-notes`, { user: A, body: { grossPence: 6001 } })).status).toBe(409);
    const c2 = await call("POST", `/v1/invoices/${i.id}/credit-notes`, { user: A, body: { grossPence: 6000 } });
    expect(c2.json).toMatchObject({ status: "paid", creditedPence: 12000, outstandingPence: 0 });
    expect((raw.prepare("select count(*) n from audit_log where tenant_id = ? and action = 'invoice.credit_note'").get(tA) as { n: number }).n).toBe(2);
  });
  it("drafts cannot be credited", async () => {
    const { call } = await setup();
    const d = (await call("POST", "/v1/invoices", { user: A, body: inv })).json;
    expect((await call("POST", `/v1/invoices/${d.id}/credit-notes`, { user: A, body: { grossPence: 1 } })).status).toBe(409);
  });
});

describe("payment links and FX (mock providers)", () => {
  it("creates a mock link for the outstanding amount and stores it", async () => {
    const { call, sent, raw } = await setup();
    const i = await sent();
    await call("POST", `/v1/invoices/${i.id}/payments`, { user: A, body: { amountPence: 2000, paidDate: "2026-07-10" } });
    const l = await call("POST", `/v1/invoices/${i.id}/payment-link`, { user: A });
    expect(l.status).toBe(201);
    expect(l.json).toMatchObject({ provider: "mock", amountMinor: 10000, currency: "GBP" });
    expect((raw.prepare("select payment_link_url u from invoices where id = ?").get(i.id) as { u: string }).u).toBe(l.json.url);
  });
  it("a different adapter can be injected (contract seam)", async () => {
    const { call, sent } = await setup();
    __setInvoiceProviders({
      paymentLinks: {
        name: "fake",
        createLink: async (x) => ({ url: "https://fake.example.test/x", providerRef: "f1", amountMinor: x.amountMinor, currency: x.currency }),
      },
    });
    const i = await sent();
    expect((await call("POST", `/v1/invoices/${i.id}/payment-link`, { user: A })).json.provider).toBe("fake");
  });
  it("no link for drafts", async () => {
    const { call } = await setup();
    const d = (await call("POST", "/v1/invoices", { user: A, body: inv })).json;
    expect((await call("POST", `/v1/invoices/${d.id}/payment-link`, { user: A })).status).toBe(409);
  });
  it("sets currency on drafts using mock FX; rejects unknown or sent", async () => {
    const { call, sent } = await setup();
    const d = (await call("POST", "/v1/invoices", { user: A, body: inv })).json;
    const r = await call("POST", `/v1/invoices/${d.id}/currency`, { user: A, body: { currency: "usd" } });
    expect(r.json).toMatchObject({ currency: "USD", provider: "mock-ecb" });
    expect(r.json.grossInGbpPence).toBe(Math.round(120 * r.json.fxRateToGbp * 100));
    expect((await call("POST", `/v1/invoices/${d.id}/currency`, { user: A, body: { currency: "XXX" } })).status).toBe(400);
    const s = await sent();
    expect((await call("POST", `/v1/invoices/${s.id}/currency`, { user: A, body: { currency: "EUR" } })).status).toBe(409);
    expect((await call("POST", `/v1/invoices/nope/currency`, { user: A, body: { currency: "EUR" } })).status).toBe(404);
  });
});

describe("receivables", () => {
  it("aged debtors and reminders (events only, never repeated)", async () => {
    const { call, sent, evTypes } = await setup();
    const i = await sent();
    await call("POST", `/v1/invoices/${i.id}/payments`, { user: A, body: { amountPence: 2000, paidDate: "2026-07-10" } });
    const aged = await call("GET", "/v1/receivables/aged?today=2026-08-15", { user: A });
    expect(aged.json.totals["1-30"]).toBe(10000);
    expect(aged.json.customers[0].customer).toBe("Acme Ltd");
    const r1 = await call("POST", "/v1/receivables/reminders/run", { user: A, body: { today: "2026-08-15" } });
    expect(r1.json.emitted).toEqual([{ invoiceId: i.id, kind: "overdue_14d" }]);
    expect((await call("POST", "/v1/receivables/reminders/run", { user: A, body: { today: "2026-08-15" } })).json.emitted).toEqual([]);
    expect(evTypes().filter((t) => t === "invoice.reminder_due")).toHaveLength(1);
    expect((await call("GET", "/v1/receivables/aged", { user: B })).json.totalPence).toBe(0);
    expect((await call("GET", "/v1/receivables/aged", { user: R })).status).toBe(200); // reviewers/accountants may read receivables
    expect((await call("POST", "/v1/receivables/reminders/run", { user: R, body: {} })).status).toBe(403);
  });
});

describe("recurring invoices", () => {
  const tpl = { customerName: "Retainer Co", lines: [{ description: "Monthly retainer", quantity: 1, unitPence: 50000, vatRateCode: "STD" }] };
  it("issues due drafts with catch-up, advances, is idempotent, and finishes at end date", async () => {
    const { call, raw, tA, evTypes } = await setup();
    const s = await call("POST", "/v1/recurring-invoices", {
      user: A,
      body: { template: tpl, cadence: "monthly", startDate: "2026-01-15", endDate: "2026-03-31", paymentTermsDays: 14 },
    });
    expect(s.status).toBe(201);
    const r1 = await call("POST", "/v1/recurring-invoices/run", { user: A, body: { today: "2026-02-20" } });
    expect(r1.json.issued.map((x: { issueDate: string }) => x.issueDate)).toEqual(["2026-01-15", "2026-02-15"]);
    expect((await call("POST", "/v1/recurring-invoices/run", { user: A, body: { today: "2026-02-20" } })).json.issued).toEqual([]);
    const r3 = await call("POST", "/v1/recurring-invoices/run", { user: A, body: { today: "2026-12-01" } });
    expect(r3.json.issued).toHaveLength(1);
    const sched = (await call("GET", "/v1/recurring-invoices", { user: A })).json[0];
    expect(sched).toMatchObject({ active: 0, next_issue_date: "2026-04-15" });
    const invs = raw
      .prepare("select status, due_date, gross_pence from invoices where tenant_id = ? and recurring_id is not null order by issue_date")
      .all(tA) as { status: string; due_date: string; gross_pence: number }[];
    expect(invs).toHaveLength(3);
    expect(invs[0]).toEqual({ status: "draft", due_date: "2026-01-29", gross_pence: 60000 });
    expect(evTypes().filter((t) => t === "invoice.recurring_issued")).toHaveLength(3);
  });
  it("validates and is owner-only and tenant isolated", async () => {
    const { call } = await setup();
    expect(
      (await call("POST", "/v1/recurring-invoices", { user: A, body: { template: tpl, cadence: "monthly", startDate: "2026-02-01", endDate: "2026-01-01" } }))
        .status,
    ).toBe(400);
    expect((await call("POST", "/v1/recurring-invoices", { user: R, body: { template: tpl, cadence: "monthly", startDate: "2026-02-01" } })).status).toBe(403);
    await call("POST", "/v1/recurring-invoices", { user: A, body: { template: tpl, cadence: "weekly", startDate: "2026-02-01" } });
    expect((await call("GET", "/v1/recurring-invoices", { user: B })).json).toEqual([]);
    expect((await call("POST", "/v1/recurring-invoices/run", { user: B, body: { today: "2026-03-01" } })).json.issued).toEqual([]);
  });
});
