/**
 * Contract tests every integration adapter must pass, mock or live. A real adapter is added to the lists below and must
 * stay green (run against a sandbox, never production, with synthetic data).
 */
import { describe, it, expect } from "vitest";
import {
  FREEAGENT_FIXTURE,
  HMRC_SANDBOX_CONFIG,
  INTEGRATION_CATALOG,
  MockESign,
  MockFreeAgentAdapter,
  MockHmrcVatAdapter,
  MockOpenBanking,
  MockPracticeManagement,
  MockQuickBooksAdapter,
  MockXeroAdapter,
  buildFraudPreventionHeaders,
  ledgerAdapterFor,
  mapAccountName,
  mapFreeAgent,
  mapQbo,
  mapXero,
  normaliseForDedupe,
  validateVatReturn,
  type LedgerReadAdapter,
  type VatReturn,
} from "../src/integrations.js";
import { parseAccountingExport } from "../src/accounting-imports.js";

const LEDGERS: LedgerReadAdapter[] = [new MockXeroAdapter(), new MockQuickBooksAdapter(), new MockFreeAgentAdapter()];
describe.each(LEDGERS.map((a) => [a.provider, a] as const))("ledger read adapter contract: %s", (_name, a) => {
  it("returns integer-pence, ISO-dated, uniquely-identified transactions sorted by date, within range", async () => {
    const all = await a.transactions("2000-01-01", "2100-01-01");
    expect(all.length).toBeGreaterThan(0);
    for (const t of all) {
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(t.amountPence)).toBe(true);
      expect(t.amountPence).not.toBe(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.externalId.startsWith(`${a.provider === "quickbooks" ? "qbo" : a.provider}:`)).toBe(true);
    }
    expect(new Set(all.map((t) => t.externalId)).size).toBe(all.length);
    expect(all.map((t) => t.date)).toEqual([...all.map((t) => t.date)].sort());
    const one = all[0]!.date;
    expect((await a.transactions(one, one)).every((t) => t.date === one)).toBe(true);
    await expect(a.transactions("2026-02-01", "2026-01-01")).rejects.toThrow();
    expect(all.some((t) => t.amountPence > 0) && all.some((t) => t.amountPence < 0)).toBe(true);
  });
  it("is idempotent (same window, same result) and exposes a chart", async () => {
    expect(await a.transactions("2026-01-01", "2026-12-31")).toEqual(await a.transactions("2026-01-01", "2026-12-31"));
    const chart = await a.accounts();
    expect(chart.length).toBeGreaterThan(0);
    expect(new Set(chart.map((x) => x.code)).size).toBe(chart.length);
    expect(a.mode).toBe("mock");
  });
});

describe("mappers", () => {
  it("Xero: /Date()/ and ISO dates, SPEND negative, tax types, fallbacks", () => {
    const t = mapXero({
      BankTransactionID: "1",
      Type: "SPEND",
      Date: "/Date(1782950400000+0000)/",
      Total: 10.005,
      LineItems: [{ TaxType: "RRINPUT" }],
      Contact: { Name: "C" },
    });
    expect(t).toMatchObject({ date: "2026-07-02", amountPence: -1001, vatRateCode: "RED", description: "C", accountCode: null });
    expect(mapXero({ BankTransactionID: "2", Type: "RECEIVE", Date: "2026-07-01", Total: -5, LineItems: [] }).amountPence).toBe(500);
    expect(mapXero({ BankTransactionID: "3", Type: "SPEND", Date: "2026-07-01", Total: 1, LineItems: [{ TaxType: "WEIRD" }] }).vatRateCode).toBeNull();
    expect(() => mapXero({ BankTransactionID: "4", Type: "SPEND", Date: "nope", Total: 1, LineItems: [] })).toThrow(/invalid date/);
    expect(() => mapXero({ BankTransactionID: "5", Type: "SPEND", Date: "2026-07-01", Total: Number.NaN, LineItems: [] })).toThrow(/invalid amount/);
  });
  it("QuickBooks and FreeAgent", () => {
    expect(mapQbo({ Id: "9", entity: "Purchase", TxnDate: "2026-07-04", TotalAmt: 12, Line: [] })).toMatchObject({
      amountPence: -1200,
      description: "(no description)",
      accountCode: null,
      vatRateCode: null,
    });
    expect(
      mapQbo({
        Id: "9",
        entity: "Purchase",
        TxnDate: "2026-07-04",
        TotalAmt: 12,
        Line: [{ Amount: 12, AccountBasedExpenseLineDetail: { AccountRef: { value: "7" }, TaxCodeRef: { value: "20.0% S" } } }],
      }).vatRateCode,
    ).toBe("STD");
    const f = mapFreeAgent(FREEAGENT_FIXTURE[0]!);
    expect(f).toMatchObject({ externalId: "freeagent:9001", amountPence: -2399, accountCode: "285", vatRateCode: "STD" });
    expect(mapFreeAgent({ url: "u/1", dated_on: "2026-01-01", gross_value: "1,000.50", sales_tax_rate: "5" })).toMatchObject({
      amountPence: 100050,
      vatRateCode: "RED",
      description: "(no description)",
    });
    expect(mapFreeAgent({ url: "u/2", dated_on: "2026-01-01", gross_value: "1", sales_tax_rate: "0" }).vatRateCode).toBe("ZERO");
    expect(mapFreeAgent({ url: "u/3", dated_on: "2026-01-01", gross_value: "1", sales_tax_rate: "17.5" }).vatRateCode).toBeNull();
  });
  it("account names map by keyword or fall back to 9999 with a reason", () => {
    expect(mapAccountName("Motor Vehicle Expenses").code).toBe("6400");
    expect(mapAccountName("Sales").code).toBe("4000");
    expect(mapAccountName("IT Software and Consumables").code).toBe("6300");
    expect(mapAccountName("Accountancy fees").code).toBe("6700");
    expect(mapAccountName("Directors Loan")).toMatchObject({ code: "9999", reason: expect.stringContaining("needs review") });
  });
  it("dedupe key ignores reference noise", () => {
    const base = { externalId: "a", date: "2026-07-01", amountPence: -100, accountCode: null, vatRateCode: null, contact: null };
    expect(normaliseForDedupe({ ...base, description: "SHELL 12/07 REF 88" })).toBe(normaliseForDedupe({ ...base, description: "SHELL" }));
  });
  it("ledgerAdapterFor + honest catalogue", () => {
    expect(ledgerAdapterFor("xero").provider).toBe("xero");
    expect(ledgerAdapterFor("quickbooks").provider).toBe("quickbooks");
    expect(ledgerAdapterFor("freeagent").provider).toBe("freeagent");
    expect(INTEGRATION_CATALOG.filter((x) => x.status === "real").map((x) => x.id)).toEqual(["csv_imports"]);
  });
  it("FreeAgent CSV export import (real importer)", () => {
    const r = parseAccountingExport(
      "Dated On,Description,Category,Gross Value\n2026-07-01,Synthetic fuel,Travel,-45.00\n01/07/2026,Synthetic sale,Sales,120.50\nbad,x,y,1\n",
    );
    expect(r.source).toBe("freeagent");
    expect(r.lines.map((l) => [l.date, l.amountPence, l.sourceCategory])).toEqual([
      ["2026-07-01", -4500, "Travel"],
      ["2026-07-01", 12050, "Sales"],
    ]);
    expect(r.rejected).toEqual([{ row: 4, error: "invalid date" }]);
  });
});

describe("practice management + e-sign contracts", () => {
  it("PM upsert is idempotent by key and lists by client", async () => {
    const pm = new MockPracticeManagement();
    const a = await pm.upsertJob({ idempotencyKey: "k1", clientRef: "c1", title: "VAT Q3", dueDate: "2026-11-07", status: "open" });
    const b = await pm.upsertJob({ idempotencyKey: "k1", clientRef: "c1", title: "VAT Q3", dueDate: "2026-11-07", status: "done" });
    expect(b.externalId).toBe(a.externalId);
    await pm.upsertJob({ idempotencyKey: "k2", clientRef: "c2", title: "Accounts", dueDate: "2026-12-31", status: "open" });
    expect((await pm.listJobs("c1")).map((j) => j.status)).toEqual(["done"]);
    await expect(pm.upsertJob({ idempotencyKey: "k3", clientRef: "c1", title: " ", dueDate: "2026-01-01", status: "open" })).rejects.toThrow();
  });
  it("e-sign envelope lifecycle", async () => {
    const e = new MockESign();
    const sha = "a".repeat(64);
    await expect(e.createEnvelope("x", ["a@b.test"])).rejects.toThrow();
    await expect(e.createEnvelope(sha, [])).rejects.toThrow();
    await expect(e.createEnvelope(sha, ["not-an-email"])).rejects.toThrow();
    const env = await e.createEnvelope(sha, ["A@b.test", "a@b.test"]);
    expect(env).toMatchObject({ status: "sent", signers: ["a@b.test"] });
    e.complete(env.envelopeId);
    expect((await e.status(env.envelopeId)).status).toBe("completed");
    await expect(e.void(env.envelopeId)).rejects.toThrow(/completed/);
    const e2 = await e.createEnvelope(sha, ["c@d.test"]);
    expect((await e.void(e2.envelopeId)).status).toBe("voided");
    await expect(e.status("nope")).rejects.toThrow();
  });
});

const ret = (o: Partial<VatReturn> = {}): VatReturn => ({
  periodKey: "26A1",
  vatDueSales: 200,
  vatDueAcquisitions: 0,
  totalVatDue: 200,
  vatReclaimedCurrPeriod: 50.5,
  netVatDue: 149.5,
  totalValueSalesExVAT: 1000,
  totalValuePurchasesExVAT: 252,
  totalValueGoodsSuppliedExVAT: 0,
  totalAcquisitionsExVAT: 0,
  finalised: true,
  ...o,
});
describe("MTD VAT submission (mock HMRC) contract", () => {
  const fph = buildFraudPreventionHeaders({ userId: "staff@firm.test", timezone: "UTC+00:00", vendorVersion: "1.0.0" });
  it("validates box arithmetic and declaration", () => {
    expect(validateVatReturn(ret())).toEqual([]);
    expect(validateVatReturn(ret({ totalVatDue: 201 }))).toContain("box 3 must equal box 1 + box 2");
    expect(validateVatReturn(ret({ netVatDue: 150 }))).toContain("box 5 must equal |box 3 - box 4|");
    expect(validateVatReturn(ret({ totalValueSalesExVAT: 1000.5 }))).toContain("totalValueSalesExVAT must be whole pounds");
    expect(validateVatReturn(ret({ vatDueSales: 200.001, totalVatDue: 200.001 }))).toEqual(
      expect.arrayContaining(["vatDueSales must have at most 2 decimals"]),
    );
    expect(validateVatReturn(ret({ finalised: false }))).toContain("the return must be finalised (legal declaration) before submission");
    expect(validateVatReturn(ret({ periodKey: "toolong" }))).toContain("periodKey must be 4 characters");
    expect(validateVatReturn(ret({ vatReclaimedCurrPeriod: 300, netVatDue: 100 }))).toEqual([]);
  });
  it("submits once per period with fraud headers; duplicate refused; sandbox receipt", async () => {
    const a = new MockHmrcVatAdapter(() => new Date("2026-10-25T10:00:00Z"));
    await expect(a.submit("12345678", ret(), fph)).rejects.toThrow(/VRN/);
    await expect(a.submit("123456789", ret(), {})).rejects.toThrow(/fraud prevention/);
    await expect(a.submit("123456789", ret({ finalised: false }), fph)).rejects.toThrow(/finalised/);
    const r = await a.submit("123456789", ret(), fph);
    expect(r).toMatchObject({ sandbox: true, formBundleNumber: "MOCK00000001", processingDate: "2026-10-25T10:00:00.000Z" });
    expect(r.chargeRefNumber).not.toBeNull();
    await expect(a.submit("123456789", ret(), fph)).rejects.toThrow("DUPLICATE_SUBMISSION");
    expect((await a.submit("123456789", ret({ periodKey: "26A2", vatReclaimedCurrPeriod: 200, netVatDue: 0 }), fph)).chargeRefNumber).toBeNull();
  });
  it("fraud headers + sandbox config are shaped for HMRC and carry no credentials", () => {
    expect(fph["Gov-Client-Connection-Method"]).toBe("WEB_APP_VIA_SERVER");
    expect(buildFraudPreventionHeaders({ userId: "u", timezone: "UTC+00:00", vendorVersion: "1", publicIp: "198.51.100.7" })["Gov-Client-Public-IP"]).toBe(
      "198.51.100.7",
    );
    expect(HMRC_SANDBOX_CONFIG.baseUrl).toMatch(/^https:\/\/test-api\./);
    expect(HMRC_SANDBOX_CONFIG.vatReturnPath("123456789")).toBe("/organisations/vat/123456789/returns");
    expect(JSON.stringify(HMRC_SANDBOX_CONFIG)).not.toMatch(/secret|client_id|password/i);
    expect(HMRC_SANDBOX_CONFIG.verified).toBe(false);
  });
});

describe("Open Banking provider contract (mock AISP)", () => {
  it("consent lifecycle: create → authorise → read → revoke; expiry after 90 days", async () => {
    let now = new Date("2026-07-01T00:00:00Z");
    const ob = new MockOpenBanking(() => now);
    await expect(ob.createConsent("bank", "http://insecure")).rejects.toThrow(/https/);
    const c = await ob.createConsent("synthetic-bank", "https://app.example.test/cb");
    expect(c.status).toBe("awaiting_authorisation");
    expect(c.redirectUrl).toContain(encodeURIComponent("https://app.example.test/cb"));
    await expect(ob.accounts(c.consentId)).rejects.toThrow(/awaiting/);
    await expect(ob.completeConsent(c.consentId, "bad")).rejects.toThrow();
    expect((await ob.completeConsent(c.consentId, "mock-ok")).status).toBe("authorised");
    await expect(ob.completeConsent(c.consentId, "mock-ok")).rejects.toThrow();
    expect(await ob.accounts(c.consentId)).toHaveLength(1);
    const tx = await ob.transactions(c.consentId, "acc-1", "2026-06-01", "2026-06-10");
    expect(tx.map((t) => t.date)).toEqual(["2026-06-01", "2026-06-03", "2026-06-05", "2026-06-07", "2026-06-09"]);
    await expect(ob.transactions(c.consentId, "acc-9", "2026-06-01", "2026-06-02")).rejects.toThrow();
    now = new Date("2026-09-30T00:00:01Z");
    await expect(ob.accounts(c.consentId)).rejects.toThrow(/expired/);
    const c2 = await ob.createConsent("synthetic-bank", "https://app.example.test/cb");
    await ob.completeConsent(c2.consentId, "mock-ok");
    expect((await ob.revoke(c2.consentId)).status).toBe("revoked");
    await expect(ob.accounts(c2.consentId)).rejects.toThrow(/revoked/);
    await expect(ob.revoke("nope")).rejects.toThrow();
  });
});
