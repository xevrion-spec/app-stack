import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  TextReceiptExtractor,
  MockExtractor,
  MockMtdGateway,
  MtdValidationError,
  MockBankFeed,
  buildQuarterlyUpdate,
  type DocumentExtractor,
  type MtdGateway,
  type BankFeed,
} from "../src/index.js";

const RECEIPT = `ACME OFFICE SUPPLIES
12 High Street
Receipt No: R-10023
Date: 14/07/2026
Paper A4            £10.00
Subtotal            £10.00
VAT 20%             £2.00
TOTAL               £12.00`;

function extractorContract(name: string, make: () => DocumentExtractor) {
  describe(`DocumentExtractor contract: ${name}`, () => {
    it("returns the full shape with bounded confidence and never throws on junk", async () => {
      const e = make();
      for (const text of [RECEIPT, "", "\u0000\u0001", "x".repeat(10000)]) {
        const r = await e.extract({ text });
        expect(r.confidence).toBeGreaterThanOrEqual(0);
        expect(r.confidence).toBeLessThanOrEqual(1);
        expect(typeof r.needsReview).toBe("boolean");
        expect(r.currency).toMatch(/^[A-Z]{3}$/);
        if (r.totalPence !== null && r.vatPence !== null) expect(r.vatPence).toBeLessThanOrEqual(r.totalPence);
      }
    });
  });
}
extractorContract("text-rules", () => new TextReceiptExtractor());
extractorContract("mock", () => new MockExtractor());

describe("TextReceiptExtractor", () => {
  const x = new TextReceiptExtractor();
  it("extracts a UK receipt", async () => {
    expect(await x.extract({ text: RECEIPT })).toMatchObject({
      vendor: "ACME OFFICE SUPPLIES",
      date: "2026-07-14",
      totalPence: 1200,
      vatPence: 200,
      currency: "GBP",
      invoiceNumber: "R-10023",
      needsReview: false,
    });
  });
  it("handles long dates, thousands, EUR/USD and grand total over subtotal", async () => {
    const r = await x.extract({ text: "Hotel Europa\nInvoice # INV-77\n3rd March 2026\nTotal €1,234.50\nTax €100.00\nGrand Total €1,334.50" });
    expect(r).toMatchObject({ date: "2026-03-03", totalPence: 133450, vatPence: 10000, currency: "EUR", invoiceNumber: "INV-77" });
    expect((await x.extract({ text: "Shop\n2026-01-02\nTotal $5.00" })).currency).toBe("USD");
  });
  it("flags missing totals and insane VAT for review", async () => {
    const a = await x.extract({ text: "Some shop\nthanks" });
    expect(a).toMatchObject({ totalPence: null, needsReview: true });
    const b = await x.extract({ text: "Shop\n01/01/2026\nVAT £50.00\nTotal £10.00" });
    expect(b.vatPence).toBeNull();
    expect(b.fields.vat).toBe(0);
  });
  it("rejects impossible dates", async () => expect((await x.extract({ text: "Shop\n31/02/2026\nTotal £1.00" })).date).toBeNull());
  it("never throws on arbitrary text", () =>
    fc.assert(fc.asyncProperty(fc.string(), async (s) => typeof (await x.extract({ text: s })).confidence === "number")));
});

function mtdContract(name: string, make: () => MtdGateway) {
  describe(`MtdGateway contract: ${name}`, () => {
    it("four contiguous obligations; submit fulfils once; validation errors", async () => {
      const g = make();
      const ob = await g.obligations("2026-27");
      expect(ob.map((o) => o.periodKey)).toEqual(["2026-27-Q1", "2026-27-Q2", "2026-27-Q3", "2026-27-Q4"]);
      expect(ob[0]).toMatchObject({ start: "2026-04-06", end: "2026-07-05", status: "open" });
      const r = await g.submitQuarterlyUpdate({ periodKey: "2026-27-Q1", turnoverPence: 100, otherIncomePence: 0, expenses: { travel: 5 } });
      expect(r).toMatchObject({ periodKey: "2026-27-Q1", sandbox: true });
      expect((await g.obligations("2026-27"))[0]!.status).toBe("fulfilled");
      await expect(g.submitQuarterlyUpdate({ periodKey: "2026-27-Q1", turnoverPence: 1, otherIncomePence: 0, expenses: {} })).rejects.toThrow(
        MtdValidationError,
      );
      await expect(g.submitQuarterlyUpdate({ periodKey: "bad", turnoverPence: 1, otherIncomePence: 0, expenses: {} })).rejects.toThrow(MtdValidationError);
      await expect(g.submitQuarterlyUpdate({ periodKey: "2026-27-Q2", turnoverPence: -1, otherIncomePence: 0, expenses: {} })).rejects.toThrow(/non-negative/);
      await expect(g.submitQuarterlyUpdate({ periodKey: "2026-27-Q2", turnoverPence: 1, otherIncomePence: 0, expenses: { x: 1.5 } })).rejects.toThrow(
        /integer/,
      );
      await expect(g.obligations("2026")).rejects.toThrow(MtdValidationError);
    });
  });
}
mtdContract("mock-hmrc", () => new MockMtdGateway(() => new Date("2026-08-01T00:00:00Z")));

function feedContract(name: string, make: () => BankFeed) {
  describe(`BankFeed contract: ${name}`, () => {
    it("accounts and bounded, dated, unique transactions", async () => {
      const f = make();
      const [acc] = await f.accounts();
      const tx = await f.transactions(acc!.id, "2026-01-01", "2026-01-31");
      expect(tx.length).toBeGreaterThan(0);
      expect(tx.every((t) => t.date >= "2026-01-01" && t.date <= "2026-01-31" && Number.isInteger(t.amountPence))).toBe(true);
      expect(new Set(tx.map((t) => t.id)).size).toBe(tx.length);
      expect(await f.transactions(acc!.id, "2026-02-01", "2026-01-01")).toEqual([]);
      await expect(f.transactions("nope", "2026-01-01", "2026-01-02")).rejects.toThrow();
    });
  });
}
feedContract("mock-openbanking", () => new MockBankFeed());

describe("buildQuarterlyUpdate", () => {
  it("drops zero/negative boxes and clamps income", () => {
    expect(buildQuarterlyUpdate("2026-27-Q1", -5, { travel: 100, other: 0, refunds: -3 }, 7)).toEqual({
      periodKey: "2026-27-Q1",
      turnoverPence: 0,
      otherIncomePence: 7,
      expenses: { travel: 100 },
    });
  });
});
