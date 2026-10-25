import { describe, it, expect, afterEach } from "vitest";
import { makeEnv, client } from "./harness.js";
import { runDaily, maybeRunDaily, retentionRun } from "../src/services/schedules.js";
import { __setBankFeed } from "../src/routes/banking.js";
import { __setComplianceProviders } from "../src/routes/compliance.js";
import { TenantDb } from "../src/lib/db.js";
import { MockBankFeed, MockOcr, type BankFeed, type ImageOcr } from "@xevrion/books";

const A = "owner-a@example.test",
  B = "owner-b@example.test",
  R = "reviewer-a@example.test",
  OP = "ops@example.test";
const inv = {
  customerName: "Acme",
  issueDate: "2026-07-01",
  dueDate: "2026-07-31",
  lines: [{ description: "d", quantity: 1, unitPence: 10000, vatRateCode: "STD" }],
};
const tpl = { customerName: "Retainer Co", lines: [{ description: "Retainer", quantity: 1, unitPence: 50000, vatRateCode: "STD" }] };

async function setup(over = {}) {
  const h = makeEnv(over);
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha", vatRegistered: true, vatScheme: "standard" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Beta" } });
  await call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } });
  const tA = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  const tB = (await call("GET", "/v1/me", { user: B })).json.tenantId as string;
  const runs = (t: string) =>
    h.raw.prepare("select job, status, detail_json from scheduler_runs where tenant_id = ? order by job").all(t) as {
      job: string;
      status: string;
      detail_json: string;
    }[];
  return { ...h, call, tA, tB, runs };
}
afterEach(() => {
  __setBankFeed(new MockBankFeed());
  __setComplianceProviders({ ocr: new MockOcr() });
});

describe("daily scheduler", () => {
  it("issues recurring drafts and emits reminder events once per day per tenant; idempotent", async () => {
    const { env, call, tA, tB, runs, raw } = await setup();
    await call("POST", "/v1/recurring-invoices", { user: A, body: { template: tpl, cadence: "monthly", startDate: "2026-08-01" } });
    const i = (await call("POST", "/v1/invoices", { user: A, body: inv })).json;
    await call("POST", `/v1/invoices/${i.id}/status`, { user: A, body: { status: "sent" } });
    const s1 = await runDaily(env, "2026-08-20");
    expect(s1).toMatchObject({ date: "2026-08-20", tenants: 2, ran: 6, failed: 0, skipped: 0 });
    const r = runs(tA);
    expect(r.map((x) => x.job)).toEqual(["document_retention", "invoice_reminders", "recurring_invoices"]);
    expect(JSON.parse(r.find((x) => x.job === "recurring_invoices")!.detail_json)).toEqual({ issued: 1 });
    expect(JSON.parse(r.find((x) => x.job === "invoice_reminders")!.detail_json)).toEqual({ emitted: 1 });
    expect(runs(tB).every((x) => x.status === "ok")).toBe(true);
    const ev = raw.prepare("select type, actor from events where tenant_id = ? and type like 'invoice.re%'").all(tA) as { type: string; actor: string }[];
    expect(ev.map((e) => e.type).sort()).toEqual(["invoice.recurring_issued", "invoice.reminder_due"]);
    expect(ev.every((e) => e.actor === "system:scheduler")).toBe(true);
    expect(await runDaily(env, "2026-08-20")).toMatchObject({ ran: 0, skipped: 6 });
    expect((raw.prepare("select count(*) n from invoices where tenant_id = ? and recurring_id is not null").get(tA) as { n: number }).n).toBe(1);
  });
  it("skips plan-gated jobs and isolates failures per tenant", async () => {
    const { env, tA, tB, runs, raw } = await setup();
    raw.prepare("update tenants set plan = 'free' where id = ?").run(tB);
    raw.prepare("drop table invoice_reminders").run(); // force reminders to fail everywhere
    const s = await runDaily(env, "2026-09-01");
    expect(s.failed).toBe(2);
    expect(JSON.parse(runs(tB).find((x) => x.job === "recurring_invoices")!.detail_json)).toEqual({ skipped: "plan" });
    expect(runs(tA).find((x) => x.job === "invoice_reminders")!.status).toBe("failed");
    expect(runs(tA).find((x) => x.job === "document_retention")!.status).toBe("ok");
  });
  it("maybeRunDaily runs once per UTC day after 06:00", async () => {
    const { env } = await setup();
    expect(await maybeRunDaily(env, new Date("2026-08-20T05:59:00Z"))).toBeNull();
    expect((await maybeRunDaily(env, new Date("2026-08-20T06:01:00Z")))?.tenants).toBe(2);
    expect(await maybeRunDaily(env, new Date("2026-08-20T07:00:00Z"))).toBeNull();
  });
});

describe("document retention", () => {
  async function withDoc(over = {}) {
    const s = await setup(over);
    const up = await s.call("POST", "/v1/uploads/receipt", { user: A, raw: new Uint8Array([1, 2, 3, 4]), headers: { "content-type": "image/png" } });
    s.raw.prepare("update documents set created_at = '2010-01-01 00:00:00' where id = ?").run(up.json.documentId);
    return { ...s, docId: up.json.documentId as string };
  }
  it("is a dry run unless DOCUMENT_RETENTION_DAYS is configured", async () => {
    const { env, tA, objects } = await withDoc();
    const r = await retentionRun(new TenantDb(env.DB, tA), env, "2026-08-20");
    expect(r).toMatchObject({ mode: "dry_run", eligible: 1, purged: 0 });
    expect(objects.size).toBe(1);
  });
  it("enforce mode removes the file, keeps a tombstone row, audits; ignores unsafe values", async () => {
    const { env, tA, tB, objects, raw, docId, call } = await withDoc({ DOCUMENT_RETENTION_DAYS: "2555" });
    expect(await retentionRun(new TenantDb(env.DB, tB), env, "2026-08-20")).toMatchObject({ eligible: 0, purged: 0 });
    const r = await retentionRun(new TenantDb(env.DB, tA), env, "2026-08-20");
    expect(r).toMatchObject({ mode: "enforce", cutoff: "2019-08-22", purged: 1 });
    expect(objects.size).toBe(0);
    expect((raw.prepare("select purged_at from documents where id = ?").get(docId) as { purged_at: string | null }).purged_at).not.toBeNull();
    expect((raw.prepare("select count(*) n from audit_log where tenant_id = ? and action = 'documents.retention_purged'").get(tA) as { n: number }).n).toBe(1);
    expect((await call("POST", `/v1/extract/documents/${docId}`, { user: A })).status).toBe(409);
    env.DOCUMENT_RETENTION_DAYS = "30";
    expect((await retentionRun(new TenantDb(env.DB, tA), env, "2026-08-20")).mode).toBe("dry_run");
  });
});

describe("bank feeds (mock provider)", () => {
  it("connect, sync (90-day first window), incremental + dedupe, disconnect", async () => {
    const { call, raw, tA } = await setup();
    const acc = await call("GET", "/v1/bank-feeds/accounts", { user: A });
    expect(acc.json).toMatchObject({ provider: "mock-openbanking", mock: true });
    expect((await call("POST", "/v1/bank-feeds/connections", { user: A, body: { accountId: "nope" } })).status).toBe(400);
    const c = await call("POST", "/v1/bank-feeds/connections", { user: A, body: { accountId: "mock-acc-1" } });
    expect(c.status).toBe(201);
    expect((await call("POST", "/v1/bank-feeds/connections", { user: A, body: { accountId: "mock-acc-1" } })).status).toBe(409);
    const s1 = await call("POST", `/v1/bank-feeds/connections/${c.json.id}/sync`, { user: A, body: { today: "2026-08-20" } });
    expect(s1.json).toMatchObject({ fetched: 31, inserted: 31, duplicates: 0, syncedUntil: "2026-08-20" });
    const s2 = await call("POST", `/v1/bank-feeds/connections/${c.json.id}/sync`, { user: A, body: { today: "2026-08-20" } });
    expect(s2.json).toMatchObject({ fetched: 0, inserted: 0 });
    const s3 = await call("POST", `/v1/bank-feeds/connections/${c.json.id}/sync`, { user: A, body: { today: "2026-08-30" } });
    expect(s3.json.fetched).toBeGreaterThan(0);
    expect((raw.prepare("select count(*) n from transactions where tenant_id = ? and source = 'bank_feed'").get(tA) as { n: number }).n).toBe(
      31 + s3.json.inserted,
    );
    expect((await call("GET", "/v1/bank-feeds/connections", { user: B })).json).toEqual([]);
    expect((await call("POST", `/v1/bank-feeds/connections/${c.json.id}/sync`, { user: B, body: {} })).status).toBe(404);
    expect((await call("DELETE", `/v1/bank-feeds/connections/${c.json.id}`, { user: A })).json.status).toBe("revoked");
    expect((await call("POST", `/v1/bank-feeds/connections/${c.json.id}/sync`, { user: A, body: {} })).status).toBe(409);
    expect((await call("POST", "/v1/bank-feeds/connections", { user: A, body: { accountId: "mock-acc-1" } })).json.status).toBe("active");
  });
  it("re-delivered provider rows are de-duplicated by provider id", async () => {
    const { call } = await setup();
    const fixed: BankFeed = {
      name: "mock-fixed",
      accounts: async () => [{ id: "x", name: "X", currency: "GBP" }],
      transactions: async () => [{ id: "t1", accountId: "x", date: "2026-08-01", description: "SAME", amountPence: -100 }],
    };
    __setBankFeed(fixed);
    const c = await call("POST", "/v1/bank-feeds/connections", { user: A, body: { accountId: "x" } });
    await call("POST", `/v1/bank-feeds/connections/${c.json.id}/sync`, { user: A, body: { today: "2026-08-01" } });
    const again = await call("POST", `/v1/bank-feeds/connections/${c.json.id}/sync`, { user: A, body: { today: "2026-08-02" } });
    expect(again.json).toMatchObject({ fetched: 1, inserted: 0, duplicates: 1 });
  });
  it("owner only and plan gated", async () => {
    const { call, raw, tA } = await setup();
    expect((await call("GET", "/v1/bank-feeds/accounts", { user: R })).status).toBe(403);
    raw.prepare("update tenants set plan = 'free' where id = ?").run(tA);
    expect((await call("GET", "/v1/bank-feeds/accounts", { user: A })).json.error.code).toBe("plan_required");
  });
});

describe("OCR extraction of stored receipts (mock OCR)", () => {
  const receipt = "SYNTHETIC-RECEIPT\nSynthetic Stationers\nDate: 12/07/2026\nVAT 20% £2.00\nTotal £12.00\nEND-RECEIPT";
  it("extracts fields, stores them on the document, audits", async () => {
    const { call, raw } = await setup();
    const up = await call("POST", "/v1/uploads/receipt", {
      user: A,
      raw: new TextEncoder().encode(`\x89PNG fake ${receipt}`),
      headers: { "content-type": "image/png" },
    });
    const r = await call("POST", `/v1/extract/documents/${up.json.documentId}`, { user: A });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ocrEngine: "mock-ocr", totalPence: 1200, vatPence: 200, date: "2026-07-12" });
    const ex = JSON.parse(
      (raw.prepare("select extracted_json from documents where id = ?").get(up.json.documentId) as { extracted_json: string }).extracted_json,
    );
    expect(ex).toMatchObject({ totalPence: 1200, source: "ocr:mock-ocr" });
    expect((await call("POST", `/v1/extract/documents/${up.json.documentId}`, { user: B })).status).toBe(404);
  });
  it("unreadable images go to review with zero confidence; OCR errors map to 415", async () => {
    const { call } = await setup();
    const up = await call("POST", "/v1/uploads/receipt", { user: A, raw: new Uint8Array([9, 9, 9]), headers: { "content-type": "image/jpeg" } });
    const r = await call("POST", `/v1/extract/documents/${up.json.documentId}`, { user: A });
    expect(r.json).toMatchObject({ needsReview: true, confidence: 0, totalPence: null });
    const broken: ImageOcr = { name: "broken", recognise: async () => Promise.reject(new RangeError("unsupported content type x")) };
    __setComplianceProviders({ ocr: broken });
    expect((await call("POST", `/v1/extract/documents/${up.json.documentId}`, { user: A })).status).toBe(415);
  });
});

describe("ops console", () => {
  it("summary reflects health and scheduled runs; tenant scoped", async () => {
    const { env, call, raw, tA } = await setup();
    let s = await call("GET", "/v1/ops/summary", { user: R });
    expect(s.json).toMatchObject({ health: "ok", openExceptions: 0, scheduledJobs: ["recurring_invoices", "invoice_reminders", "document_retention"] });
    await runDaily(env, "2026-08-20");
    raw.prepare("insert into jobs (id, tenant_id, kind, status, created_at) values ('j1', ?, 'bank_csv', 'failed', ?)").run(tA, new Date().toISOString());
    s = await call("GET", "/v1/ops/summary", { user: A });
    expect(s.json.recentRuns).toHaveLength(3);
    expect(s.json).toMatchObject({ health: "degraded", failedJobs7d: 1, jobs: { failed: 1 } });
    expect((await call("GET", "/v1/ops/summary", { user: B })).json.failedJobs7d).toBe(0);
  });
  it("admin overview: operators only, aggregates only", async () => {
    const { call } = await setup({ ADMIN_EMAILS: ` ${OP.toUpperCase()} , other@example.test` });
    await call("POST", "/v1/tenants", { user: OP, body: { name: "Ops (synthetic)" } });
    expect((await call("GET", "/v1/admin/overview", { user: A })).status).toBe(403);
    const o = await call("GET", "/v1/admin/overview", { user: OP });
    expect(o.status).toBe(200);
    expect(Object.values(o.json.tenants as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(3);
    expect(JSON.stringify(o.json)).not.toMatch(/@|Alpha|Beta/);
  });
  it("admin overview is closed when ADMIN_EMAILS is unset", async () => {
    const { call } = await setup();
    expect((await call("GET", "/v1/admin/overview", { user: A })).status).toBe(403);
  });
});
