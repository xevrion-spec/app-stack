import { describe, it, expect } from "vitest";
import { makeEnv, client, BANK_CSV } from "./harness.js";
import { runPipeline } from "../src/services/pipeline.js";

const A = "owner-a@example.test",
  B = "owner-b@example.test",
  R = "reviewer-a@example.test";
const OFX = `OFXHEADER:100
<OFX><STMTTRN><DTPOSTED>20260801<TRNAMT>-12.50<FITID>A1<NAME>TESCO STORES
<STMTTRN><DTPOSTED>20260802<TRNAMT>100.00<FITID>A2<NAME>CLIENT CO
<STMTTRN><DTPOSTED>bad<TRNAMT>1<FITID>A3
</OFX>`;
const XERO = "Date,Description,Reference,Amount,Account Code\n2026-08-05,Adobe,R1,-19.99,6200\n";

async function setup() {
  const h = makeEnv();
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: A, body: { name: "Alpha", vatRegistered: true, vatScheme: "standard" } });
  await call("POST", "/v1/tenants", { user: B, body: { name: "Beta" } });
  await call("POST", "/v1/users", { user: A, body: { email: R, role: "reviewer" } });
  const tA = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
  const imp = (raw: string, q = "", user = A) => call("POST", `/v1/books/imports/statement${q}`, { user, raw, headers: { "content-type": "text/plain" } });
  const books = async () => {
    const up = await call("POST", "/v1/uploads/bank-csv", { user: A, raw: BANK_CSV, headers: { "content-type": "text/csv" } });
    await runPipeline(h.env, tA, up.json.jobId);
  };
  return { ...h, call, tA, imp, books };
}

describe("books imports", () => {
  it("imports OFX, skips exact duplicates on re-import, reports rejects, audits and meters", async () => {
    const { imp, raw, tA } = await setup();
    const r = await imp(OFX);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ format: "ofx", inserted: 2, duplicates: 0, dryRun: false });
    expect(r.json.rejectedRows).toHaveLength(1);
    const again = await imp(OFX);
    expect(again.json).toMatchObject({ inserted: 0, duplicates: 2 });
    expect((raw.prepare("select count(*) n from transactions where tenant_id = ? and source = 'import_ofx'").get(tA) as { n: number }).n).toBe(2);
    expect((raw.prepare("select count(*) n from audit_log where tenant_id = ? and action = 'books.import'").get(tA) as { n: number }).n).toBe(2);
  });
  it("dry run writes nothing", async () => {
    const { imp, raw } = await setup();
    const r = await imp(OFX, "?dryRun=true");
    expect(r.json).toMatchObject({ dryRun: true, inserted: 2 });
    expect((raw.prepare("select count(*) n from transactions").get() as { n: number }).n).toBe(0);
  });
  it("auto-detects Xero exports, QIF and MT940; explicit source works", async () => {
    const { imp } = await setup();
    expect((await imp(XERO)).json).toMatchObject({ source: "xero", inserted: 1 });
    expect((await imp("!Type:Bank\nD03/08/2026\nT-5.00\nPCAFE\n^\n")).json).toMatchObject({ format: "qif", inserted: 1 });
    expect((await imp(":20:X\n:61:2608040804D7,00NTRF\n:86:SHOP\n")).json).toMatchObject({ format: "mt940", inserted: 1 });
    expect((await imp("Date,Description,Debit,Credit,Account\n2026-08-06,Shell,40.00,,Motor\n", "?source=quickbooks")).json).toMatchObject({
      source: "quickbooks",
      inserted: 1,
    });
  });
  it("plain bank CSV falls back to the CSV parser; flags probable duplicates across formats", async () => {
    const { imp } = await setup();
    await imp(OFX);
    const r = await imp("Date,Description,Amount\n03/08/2026,TESCO STORES LONDON,-12.50\n");
    expect(r.json.inserted).toBe(1);
    expect(r.json.probableDuplicates[0]).toMatchObject({ line: 1 });
  });
  it("rejects empty, bad and unknown inputs", async () => {
    const { imp } = await setup();
    expect((await imp("")).status).toBe(400);
    expect((await imp("x,y\n1,2", "?source=xero")).status).toBe(400);
    expect((await imp("a", "?source=nope")).status).toBe(400);
  });
  it("is tenant isolated", async () => {
    const { imp, call } = await setup();
    await imp(OFX);
    expect((await imp(OFX, "", B)).json.inserted).toBe(2);
    const rec = await call("GET", "/v1/books/recurring", { user: B });
    expect(rec.status).toBe(200);
  });
});

describe("learned rules", () => {
  it("corrections become suggestions; owner applies them once; reviewers cannot apply", async () => {
    const { call, imp, raw, tA } = await setup();
    await imp("Date,Description,Amount\n01/08/2026,SCREWFIX 100,-10.00\n02/08/2026,SCREWFIX 200,-20.00\n03/08/2026,SCREWFIX 300,-30.00\n");
    const ids = (raw.prepare("select id from transactions where tenant_id = ?").all(tA) as { id: string }[]).map((r) => r.id);
    for (const id of ids)
      expect((await call("PATCH", `/v1/transactions/${id}`, { user: A, body: { categoryCode: "6200", vatRateCode: null, vatPence: 0 } })).status).toBe(200);
    const s = await call("GET", "/v1/books/rules/suggestions", { user: R });
    expect(s.json[0]).toMatchObject({ pattern: "SCREWFIX", categoryCode: "6200", evidence: 3, direction: "out" });
    expect((await call("POST", "/v1/books/rules/learn", { user: R })).status).toBe(403);
    const l = await call("POST", "/v1/books/rules/learn", { user: A });
    expect(l.status).toBe(201);
    expect(l.json.created).toHaveLength(1);
    expect((raw.prepare("select source from category_rules where tenant_id = ? and source = 'learned'").all(tA) as unknown[]).length).toBe(1);
    expect((await call("GET", "/v1/books/rules/suggestions", { user: A })).json).toEqual([]);
    expect((await call("POST", "/v1/books/rules/learn", { user: A })).json.created).toEqual([]);
  });
});

describe("reports, forecast, spikes, tax, deadlines", () => {
  it("P&L, balance sheet, cash flow and SA103 from the ledger", async () => {
    const { call, books } = await setup();
    await books();
    const pnl = await call("GET", "/v1/books/reports/pnl?from=2026-07-01&to=2026-07-31", { user: A });
    expect(pnl.status).toBe(200);
    expect(pnl.json.totalIncomePence).toBeGreaterThan(0);
    expect(pnl.json.netProfitPence).toBe(pnl.json.totalIncomePence - pnl.json.totalExpensesPence);
    const bs = await call("GET", "/v1/books/reports/balance-sheet?asAt=2026-12-31", { user: A });
    expect(bs.status).toBe(200);
    expect((await call("GET", "/v1/books/reports/cash-flow?from=2026-07-01&to=2026-07-31", { user: A })).status).toBe(200);
    const sa = await call("GET", "/v1/books/reports/sa103?from=2026-04-06&to=2027-04-05", { user: A });
    expect(sa.json).toMatchObject({ verified: false });
    expect((await call("GET", "/v1/books/reports/pnl?from=bad&to=2026-01-01", { user: A })).status).toBe(400);
  });
  it("tenant B sees an empty P&L for A's data", async () => {
    const { call, books } = await setup();
    await books();
    expect((await call("GET", "/v1/books/reports/pnl?from=2026-01-01&to=2026-12-31", { user: B })).json.totalIncomePence).toBe(0);
  });
  it("forecast, recurring and spikes respond", async () => {
    const { call, books } = await setup();
    await books();
    const f = await call("GET", "/v1/books/forecast?horizonDays=30", { user: A });
    expect(f.status).toBe(200);
    expect(f.json).toHaveProperty("runwayDays");
    expect((await call("GET", "/v1/books/forecast?horizonDays=1", { user: A })).status).toBe(400);
    expect(Array.isArray((await call("GET", "/v1/books/spikes?month=2026-07", { user: A })).json)).toBe(true);
    expect((await call("GET", "/v1/books/spikes?month=2026-7", { user: A })).status).toBe(400);
  });
  it("tax estimate is marked unverified", async () => {
    const { call, books } = await setup();
    await books();
    const t = await call("GET", "/v1/books/tax-estimate?taxYear=2026-27", { user: A });
    expect(t.status).toBe(200);
    expect(t.json.estimate).toMatchObject({ verified: false });
    expect(t.json.taxYear).toBe("2026-27");
  });
  it("deadlines include SA and MTD, VAT when registered", async () => {
    const { call } = await setup();
    const d = await call("GET", "/v1/books/deadlines?today=2026-12-01&days=90&vatFirstPeriodEnd=2026-09-30", { user: A });
    const kinds = new Set(d.json.map((x: { kind: string }) => x.kind));
    expect(kinds.has("sa_filing_online")).toBe(true);
    expect(kinds.has("vat_return")).toBe(true);
    const dB = await call("GET", "/v1/books/deadlines?today=2026-12-01&days=90&vatFirstPeriodEnd=2026-09-30", { user: B });
    expect(dB.json.some((x: { kind: string }) => x.kind === "vat_return")).toBe(false);
  });
});

describe("calculators and mileage log", () => {
  it("calculators return estimates and validate", async () => {
    const { call } = await setup();
    const m = await call("POST", "/v1/books/calculators/mileage", { user: A, body: { miles: 100 } });
    expect(m.json).toMatchObject({ value: 4500, verified: false });
    expect((await call("POST", "/v1/books/calculators/home-office", { user: A, body: { months: [{ hours: 60 }] } })).json.value.flatRatePence).toBe(1800);
    expect(
      (
        await call("POST", "/v1/books/calculators/home-office", {
          user: A,
          body: { months: [], actual: { annualCostsPence: 1, businessRooms: 3, totalRooms: 2, businessUseFraction: 1 } },
        })
      ).status,
    ).toBe(400);
    expect((await call("POST", "/v1/books/calculators/aia", { user: A, body: { items: [{ costPence: 1000 }] } })).json.value.claimPence).toBe(1000);
    expect((await call("POST", "/v1/books/calculators/mileage", { user: A, body: { miles: -1 } })).status).toBe(400);
  });
  it("mileage log feeds the calculator; tenant isolated; audited", async () => {
    const { call, raw, tA } = await setup();
    const d = new Date().toISOString().slice(0, 10);
    expect(
      (await call("POST", "/v1/books/mileage-trips", { user: A, body: { tripDate: d, miles: 10, vehicle: "car_van", purpose: "Client visit" } })).status,
    ).toBe(201);
    expect((await call("GET", "/v1/books/mileage-trips", { user: A })).json).toHaveLength(1);
    expect((await call("GET", "/v1/books/mileage-trips", { user: B })).json).toHaveLength(0);
    expect((await call("POST", "/v1/books/calculators/mileage", { user: A, body: {} })).json.value).toBe(450);
    expect((await call("POST", "/v1/books/calculators/mileage", { user: B, body: {} })).json.value).toBe(0);
    expect((raw.prepare("select count(*) n from audit_log where tenant_id = ? and action = 'mileage.logged'").get(tA) as { n: number }).n).toBe(1);
    expect((await call("POST", "/v1/books/mileage-trips", { user: A, body: { tripDate: d, miles: 0, vehicle: "car_van" } })).status).toBe(400);
  });
  it("requires authentication", async () => {
    const { call } = await setup();
    expect((await call("GET", "/v1/books/recurring")).status).toBe(401);
  });
});
