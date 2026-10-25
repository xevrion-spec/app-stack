import { describe, it, expect, beforeEach } from "vitest";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";
import { handlePipelineBatch, handleDeadLetters } from "../src/queue.js";
import { TenantDb } from "../src/lib/db.js";

const txns0 = (r: { json: { items: unknown[] } }) => r.json.items;
const A = "owner-a@example.test", B = "owner-b@example.test", R = "reviewer-a@example.test";

async function setup(vat: Record<string, unknown> = { vatRegistered: true, vatScheme: "standard" }) {
  const h = makeEnv();
  const call = client(h.env);
  const ta = await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha Design", ...vat } });
  const tb = await call("POST", "/v1/tenants", { user: B, body: { name: "Beta Plumbing" } });
  return { ...h, call, ta: ta.json.id as string, tb: tb.json.id as string };
}
async function uploadAndRun(s: Awaited<ReturnType<typeof setup>>, user = A, csv = BANK_CSV) {
  const up = await s.call("POST", "/v1/uploads/bank-csv", { user, raw: csv, headers: { "content-type": "text/csv" } });
  expect(up.status).toBe(201);
  const msg = s.sent.at(-1)!;
  const sum = await runPipeline(s.env, msg.tenantId, msg.jobId, undefined);
  return { up: up.json, sum };
}

describe("platform", () => {
  it("health, request ids and security headers", async () => {
    const { env } = makeEnv(); const call = client(env);
    const r = await call("GET", "/health", { headers: { "x-request-id": "rid-123" } });
    expect(r.status).toBe(200); expect(r.headers.get("x-request-id")).toBe("rid-123");
    expect(r.headers.get("x-frame-options")).toBeTruthy();
  });
  it("rejects unauthenticated calls with typed error", async () => {
    const { env } = makeEnv(); const r = await client(env)("GET", "/v1/me");
    expect(r.status).toBe(401); expect(r.json.error.code).toBeTypeOf("string"); expect(r.json.error.requestId).toBeTruthy();
  });
  it("dev header is ignored in production (Access JWT required)", async () => {
    const { env } = makeEnv({ ENVIRONMENT: "production", ACCESS_AUD: "aud", ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com" });
    const r = await client(env)("GET", "/v1/me", { user: A });
    expect(r.status).toBe(401);
  });
  it("serves an OpenAPI 3.1 document covering the API", async () => {
    const { env } = makeEnv(); const r = await client(env)("GET", "/openapi.json");
    expect(r.json.openapi).toBe("3.1.0");
    expect(Object.keys(r.json.paths).length).toBeGreaterThanOrEqual(25);
    expect(r.json.paths["/v1/export/transactions.csv"]).toBeTruthy();
  });
  it("validation errors are 400 validation_failed", async () => {
    const { env } = makeEnv(); const r = await client(env)("POST", "/v1/tenants", { user: A, body: { name: "" } });
    expect(r.status).toBe(400); expect(r.json.error.code).toBe("validation_failed");
  });
});

describe("tenancy and roles", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { s = await setup(); });

  it("tenant bootstrap seeds categories and rules", async () => {
    const cats = await s.call("GET", "/v1/categories", { user: A });
    expect(cats.status).toBe(200); expect(cats.json.length).toBeGreaterThan(5);
    const me = await s.call("GET", "/v1/me", { user: A });
    expect(me.json.role).toBe("owner"); expect(me.json.tenantId).toBe(s.ta);
  });
  it("tenant B never sees tenant A data", async () => {
    await uploadAndRun(s);
    const a = await s.call("GET", "/v1/transactions", { user: A });
    const b = await s.call("GET", "/v1/transactions", { user: B });
    expect(a.json.items.length).toBe(11); expect(b.json.items.length).toBe(0);
    const id = a.json.items[0].id;
    const steal = await s.call("PATCH", `/v1/transactions/${id}`, { user: B, body: { categoryCode: "6300" } });
    expect(steal.status).toBe(404);
    const exB = await s.call("GET", "/v1/export/transactions.csv", { user: B });
    expect(exB.text).not.toContain("STRIPE");
  });
  it("x-tenant-id cannot select a tenant the user is not a member of", async () => {
    const r = await s.call("GET", "/v1/me", { user: B, headers: { "x-tenant-id": s.ta } });
    expect(r.status).toBe(403);
  });
  it("TenantDb refuses SQL that is not tenant-scoped", async () => {
    const db = new TenantDb(s.env.DB, s.ta);
    expect(() => db.stmt("select * from transactions")).toThrow();
    expect(() => db.stmt("delete from invoices where id = ?2", "x")).toThrow();
  });
  it("reviewer can resolve exceptions but not change tenant settings or users", async () => {
    expect((await s.call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } })).status).toBe(201);
    expect((await s.call("PATCH", "/v1/tenant", { user: R, body: { name: "Hacked" } })).status).toBe(403);
    expect((await s.call("POST", "/v1/users", { user: R, body: { email: "x@example.test", role: "owner" } })).status).toBe(403);
    expect((await s.call("GET", "/v1/exceptions", { user: R })).status).toBe(200);
  });
});

describe("ingestion, pipeline, ledger", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { s = await setup(); });

  it("stores the CSV in R2 under the tenant prefix with checksum and dedupes re-uploads", async () => {
    const { up } = await uploadAndRun(s);
    expect(up.inserted).toBe(11); expect(up.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect([...s.objects.keys()][0]!.startsWith(`${s.ta}/`)).toBe(true);
    const again = await s.call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    expect(again.json.inserted).toBe(0); expect(again.json.duplicates).toBe(11);
  });
  it("rejects wrong content-type and oversize files", async () => {
    expect((await s.call("POST", "/v1/uploads/bank-csv", { user: A, raw: "x", headers: { "content-type": "application/json" } })).status).toBe(415);
    const big = "Date,Description,Amount\n" + "01/07/2026,X,1.00\n".repeat(130_000);
    expect((await s.call("POST", "/v1/uploads/bank-csv", { user: A, raw: big, headers: { "content-type": "text/csv" } })).status).toBe(413);
  });
  it("pipeline categorises, raises exceptions for unknowns, and posts a balanced ledger", async () => {
    const { sum } = await uploadAndRun(s);
    expect(sum.processed).toBe(11);
    expect(sum.exceptions).toBeGreaterThanOrEqual(1);
    expect(sum.qaScore).toBeGreaterThan(0);
    const tb = await s.call("GET", "/v1/ledger/trial-balance", { user: A });
    expect(tb.status).toBe(200);
    expect(tb.json.totalDebit).toBe(tb.json.totalCredit);
    const ex = await s.call("GET", "/v1/exceptions", { user: A });
    expect(ex.json.items.some((e: { reason_code: string }) => e.reason_code === "UNKNOWN_CATEGORY")).toBe(true);
    expect(txns0(await s.call("GET", "/v1/transactions?status=needs_review", { user: A })).length).toBe(1);
    const txns = (await s.call("GET", "/v1/transactions", { user: A })).json.items as { description: string; category_code: string }[];
    expect(txns.find((t) => t.description.includes("TRANSFER TO SAVINGS"))!.category_code).toBe("8000");
    expect(txns.find((t) => t.description.includes("WHOLESALE"))!.category_code).not.toBe("4000");
  });
  it("pipeline is idempotent when re-run", async () => {
    const { up } = await uploadAndRun(s);
    const before = s.raw.prepare("select count(*) n from journals").get() as { n: number };
    await runPipeline(s.env, s.ta, up.jobId, undefined);
    const after = s.raw.prepare("select count(*) n from journals").get() as { n: number };
    expect(after.n).toBe(before.n);
    const tl = await s.call("GET", `/v1/jobs/${up.jobId}`, { user: A });
    expect(tl.json.events.length).toBeGreaterThan(3);
  });
  it("recategorising posts a reversal and keeps the ledger balanced, with audit entries", async () => {
    await uploadAndRun(s);
    const t = (await s.call("GET", "/v1/transactions", { user: A })).json.items.find((x: { description: string }) => x.description.includes("MYSTERY"));
    const r = await s.call("PATCH", `/v1/transactions/${t.id}`, { user: A, body: { categoryCode: "6300", vatRateCode: "STD", vatPence: 1333 } });
    expect(r.status).toBe(200);
    const tb = (await s.call("GET", "/v1/ledger/trial-balance", { user: A })).json;
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const audits = s.raw.prepare("select action from audit_log where tenant_id = ?").all(s.ta) as { action: string }[];
    expect(audits.map((a) => a.action)).toContain("transaction.categorised");
  });
  it("queue consumer acks on success, retries with backoff on failure, DLQ marks job failed", async () => {
    const up = await s.call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    const acks: string[] = [], retries: number[] = [];
    const mk = (body: { jobId: string; tenantId: string }) => ({ body, attempts: 2, ack: () => acks.push(body.jobId), retry: (o?: { delaySeconds?: number }) => retries.push(o?.delaySeconds ?? 0) });
    await handlePipelineBatch({ messages: [mk({ jobId: up.json.jobId, tenantId: s.ta })] } as never, s.env);
    expect(acks).toEqual([up.json.jobId]);
    const broken = { ...s.env, DB: { prepare: () => { throw new Error("db down"); }, batch: () => { throw new Error("db down"); } } } as never;
    await handlePipelineBatch({ messages: [mk({ jobId: "j", tenantId: s.ta })] } as never, broken);
    expect(retries).toEqual([20]);
    await handleDeadLetters({ messages: [mk({ jobId: up.json.jobId, tenantId: s.ta })] } as never, s.env);
    const job = s.raw.prepare("select status from jobs where id = ?").get(up.json.jobId) as { status: string };
    expect(job.status).toBe("failed");
  });
});

describe("invoices, VAT, SA, review, export, idempotency", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { s = await setup(); });
  const inv = { customerName: "Acme Ltd", issueDate: "2026-07-02", dueDate: "2026-08-01", lines: [{ description: "Design work", quantity: 2, unitPence: 25000, vatRateCode: "STD" }] };

  it("numbers invoices sequentially, computes VAT, and enforces status transitions", async () => {
    const a = await s.call("POST", "/v1/invoices", { user: A, body: inv });
    const b = await s.call("POST", "/v1/invoices", { user: A, body: inv });
    expect(a.status).toBe(201);
    expect(a.json.net_pence).toBe(50000); expect(a.json.vat_pence).toBe(10000); expect(a.json.gross_pence).toBe(60000);
    expect(a.json.number).not.toBe(b.json.number);
    expect((await s.call("POST", `/v1/invoices/${a.json.id}/status`, { user: A, body: { status: "paid" } })).status).toBe(409);
    expect((await s.call("POST", `/v1/invoices/${a.json.id}/status`, { user: A, body: { status: "sent" } })).status).toBe(200);
    expect((await s.call("POST", `/v1/invoices/${a.json.id}/status`, { user: A, body: { status: "paid" } })).status).toBe(200);
    const pdf = await s.call("GET", `/v1/invoices/${a.json.id}/pdf`, { user: A });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.text.startsWith("%PDF-")).toBe(true);
    expect((await s.call("GET", `/v1/invoices/${a.json.id}/pdf`, { user: B })).status).toBe(404);
    const other = await s.call("POST", "/v1/invoices", { user: B, body: inv });
    expect(other.json.number).toBe(a.json.number); // per-tenant sequences
  });
  it("Idempotency-Key replays the first response and rejects reuse for another path", async () => {
    const h = { "idempotency-key": "k-1" };
    const a = await s.call("POST", "/v1/invoices", { user: A, body: inv, headers: h });
    const b = await s.call("POST", "/v1/invoices", { user: A, body: inv, headers: h });
    expect(b.json.id).toBe(a.json.id);
    expect((s.raw.prepare("select count(*) n from invoices where tenant_id = ?").get(s.ta) as { n: number }).n).toBe(1);
    expect((await s.call("POST", "/v1/vat/drafts", { user: A, body: { periodStart: "2026-07-01", periodEnd: "2026-09-30" }, headers: h })).status).toBe(409);
  });
  it("VAT draft has boxes 1-9, is marked draft/unverified, and satisfies box invariants", async () => {
    await uploadAndRun(s);
    await s.call("POST", "/v1/invoices", { user: A, body: inv });
    const v = await s.call("POST", "/v1/vat/drafts", { user: A, body: { periodStart: "2026-07-01", periodEnd: "2026-09-30" } });
    expect(v.status).toBe(201);
    const bx = v.json;
    for (let i = 1; i <= 9; i++) expect(bx[`box${i}`]).toBeTypeOf("number");
    expect(bx.box3).toBe(bx.box1 + bx.box2); expect(bx.box5).toBe(bx.box3 - bx.box4);
    expect(v.json.status).toBe("draft"); expect(v.json.ratesVerified).toBe(false);
  });
  it("flat-rate VAT applies the tenant percentage", async () => {
    const f = await setup({ vatRegistered: true, vatScheme: "flat_rate", flatRatePercent: 12.5 });
    await uploadAndRun(f, A, "Date,Description,Amount\n01/07/2026,STRIPE PAYOUT,1200.00\n");
    const v = await f.call("POST", "/v1/vat/drafts", { user: A, body: { periodStart: "2026-07-01", periodEnd: "2026-09-30" } });
    // VAT drafts are computed from categorised bank transactions (invoices feed reconciliation, not VAT, to avoid double counting).
    expect(v.json.box1).toBe(Math.round(120000 * 0.125));
  });
  it("accrual VAT counts an invoice once (issue date), excluding the bank receipt that paid it; cash uses the receipt date", async () => {
    const a = await s.call("POST", "/v1/invoices", { user: A, body: { ...inv, issueDate: "2026-06-20" } });
    await s.call("POST", `/v1/invoices/${a.json.id}/status`, { user: A, body: { status: "sent" } });
    // receipt of the full gross lands in July and is reconciled to the invoice by the pipeline
    await uploadAndRun(s, A, "Date,Description,Amount\n05/07/2026,ACME LTD INV " + a.json.number + ",600.00\n");
    const invNow = (await s.call("GET", "/v1/invoices", { user: A })).json.find((x: { id: string }) => x.id === a.json.id);
    expect(invNow.status).toBe("paid");
    const q2 = (await s.call("POST", "/v1/vat/drafts", { user: A, body: { periodStart: "2026-04-01", periodEnd: "2026-06-30" } })).json;
    const q3 = (await s.call("POST", "/v1/vat/drafts", { user: A, body: { periodStart: "2026-07-01", periodEnd: "2026-09-30" } })).json;
    expect(q2.box1).toBe(10000); expect(q2.box6).toBe(50000);
    expect(q3.box1).toBe(0); expect(q3.box6).toBe(0);
    const cashQ3 = (await s.call("POST", "/v1/vat/drafts", { user: A, body: { periodStart: "2026-07-01", periodEnd: "2026-09-30", scheme: "cash" } })).json;
    expect(cashQ3.box1).toBe(10000);
  });
  it("SA summary is a draft with income and expenses", async () => {
    await uploadAndRun(s);
    const r = await s.call("GET", "/v1/sa/summary", { user: A });
    expect(r.status).toBe(200); expect(r.json.status).toBe("draft"); expect(r.json.verified).toBe(false);
    expect(r.json.turnoverPence).toBeGreaterThan(0);
  });
  it("resolving an exception with override updates the transaction and closes it", async () => {
    await uploadAndRun(s);
    const ex = (await s.call("GET", "/v1/exceptions", { user: A })).json.items[0];
    const r = await s.call("POST", `/v1/exceptions/${ex.id}/resolve`, { user: A, body: { decision: "override", override: { categoryCode: "6300" }, note: "phone" } });
    expect(r.status).toBe(200);
    const again = await s.call("POST", `/v1/exceptions/${ex.id}/resolve`, { user: A, body: { decision: "approve" } });
    expect(again.status).toBe(409);
  });
  it("CSV export neutralises formula injection; JSON ledger export works; billing event recorded", async () => {
    await uploadAndRun(s, A, "Date,Description,Amount\n01/07/2026,=HYPERLINK(\"x\"),-1.00\n");
    const csv = await s.call("GET", "/v1/export/transactions.csv", { user: A });
    expect(csv.text).toContain("'=HYPERLINK");
    const j = await s.call("GET", "/v1/export/ledger.json", { user: A });
    expect(j.status).toBe(200);
    const bill = await s.call("GET", "/v1/billing/events", { user: A });
    expect(bill.status).toBe(200);
  });
  it("paginates with an opaque cursor", async () => {
    await uploadAndRun(s);
    const p1 = await s.call("GET", "/v1/transactions?limit=5", { user: A });
    expect(p1.json.items.length).toBe(5); expect(p1.json.nextCursor).toBeTruthy();
    const p2 = await s.call("GET", `/v1/transactions?limit=5&cursor=${encodeURIComponent(p1.json.nextCursor)}`, { user: A });
    expect(p2.json.items[0].id).not.toBe(p1.json.items[0].id);
    const ids = new Set([...p1.json.items, ...p2.json.items].map((x: { id: string }) => x.id));
    expect(ids.size).toBe(10);
  });
});
