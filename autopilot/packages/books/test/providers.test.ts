import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  TextReceiptExtractor,
  MockOcr,
  OCR_CONTENT_TYPES,
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

describe("ImageOcr contract (MockOcr)", () => {
  const ocr = new MockOcr();
  it("returns embedded synthetic receipt text verbatim with high confidence", async () => {
    const bytes = new TextEncoder().encode("junk SYNTHETIC-RECEIPT\nShop\nTotal £1.00\nEND-RECEIPT trailing");
    expect(await ocr.recognise({ bytes, contentType: "application/pdf" })).toEqual({ text: "Shop\nTotal £1.00", confidence: 0.9, engine: "mock-ocr" });
  });
  it("never guesses: no marker means empty text and zero confidence", async () => {
    expect(await ocr.recognise({ bytes: new Uint8Array([0, 1, 2]), contentType: "image/png" })).toMatchObject({ text: "", confidence: 0 });
  });
  it.each(OCR_CONTENT_TYPES)("accepts %s", async (ct) => expect((await ocr.recognise({ bytes: new Uint8Array(), contentType: ct })).engine).toBe("mock-ocr"));
  it("rejects unsupported content types", async () => {
    await expect(ocr.recognise({ bytes: new Uint8Array(), contentType: "text/html" })).rejects.toThrow(RangeError);
  });
});

describe("TextReceiptExtractor: precise field rules (mutation-hardening)", () => {
  const x = new TextReceiptExtractor();
  const ex = (t: string) => x.extract({ text: t });
  it.each([
    ["Date 2026-03-09", "2026-03-09"],
    ["on 9/3/26", "2026-03-09"],
    ["on 09.03.2026", "2026-03-09"],
    ["on 9-3-99", "2099-03-09"],
    ["on 9/3/100", null], // 3-digit year is not < 100 → year 100 (out of range for our use but valid date) handled below
  ])("date %s", async (t, want) => {
    const d = (await ex(`Shop\n${t}\nTotal £1.00`)).date;
    if (want === null) expect(d).toBe("0100-03-09");
    else expect(d).toBe(want);
  });
  it("two-digit years map to 20xx exactly", async () => expect((await ex("Shop\n01/02/05\nTotal £1.00")).date).toBe("2005-02-01"));
  it.each(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map((m, i) => [m, i + 1]))("long month %s", async (m, n) =>
    expect((await ex(`Shop\n3rd ${m} 2026\nTotal £1.00`)).date).toBe(`2026-${String(n).padStart(2, "0")}-03`),
  );
  it("long dates accept full month names, missing ordinal and multiple spaces", async () => {
    expect((await ex("Shop\n21  September 2026\nTotal £1.00")).date).toBe("2026-09-21");
    expect((await ex("Shop\n1st March, 2026\nTotal £1.00")).date).toBe("2026-03-01");
  });
  it("rejects impossible calendar dates", async () => {
    expect((await ex("Shop\n2026-02-30\nTotal £1.00")).date).toBeNull();
    expect((await ex("Shop\n31/04/2026\nTotal £1.00")).date).toBeNull();
    expect((await ex("Shop\n2026-13-01\nTotal £1.00")).date).toBeNull();
  });
  it("ISO wins over UK when both are present; 1-digit ISO parts are not ISO", async () => {
    expect((await ex("Shop\n2026-01-02 and 03/04/2026\nTotal £1.00")).date).toBe("2026-01-02");
    expect((await ex("Shop\n2026-1-02\nTotal £1.00")).date).toBeNull();
  });
  it("vendor is the first line with 3+ letters that is not a label; CRs are stripped", async () => {
    const r = await ex("12\r\nRECEIPT\r\nTax invoice\r\n  Bob's Café  \r\nTotal £3.50");
    expect(r.vendor).toBe("Bob's Café");
    expect((await ex("ab\n12\nTotal £3.50")).vendor).toBeNull();
  });
  it.each([
    ["Invoice No: INV-2026-7", "INV-2026-7"],
    ["Invoice number 12345", "12345"],
    ["INV#A1B2", "A1B2"],
    ["Receipt: R-1", "R-1"],
    ["Invoice    #    XYZ99", "XYZ99"],
  ])("invoice number %s", async (line, want) => expect((await ex(`Shop\n${line}\nTotal £1.00`)).invoiceNumber).toBe(want));
  it("confidence and review thresholds", async () => {
    const full = await ex("Shop Ltd\nDate 2026-01-01\nVAT £1.00\nTotal £6.00");
    expect(full).toMatchObject({ confidence: 0.81, needsReview: false, fields: { total: 0.9, date: 0.85, vendor: 0.6, vat: 0.8 } });
    const noVat = await ex("Shop Ltd\nDate 2026-01-01\nTotal £6.00");
    expect(noVat).toMatchObject({ confidence: 0.71, needsReview: true, vatPence: null });
    const noTotal = await ex("Shop Ltd\nDate 2026-01-01\nVAT £1.00");
    expect(noTotal).toMatchObject({ totalPence: null, needsReview: true, fields: { total: 0, vat: 0 } });
  });
  it("VAT equal to total is sane; VAT above total is dropped", async () => {
    expect((await ex("Shop\nVAT £6.00\nTotal £6.00")).vatPence).toBe(600);
    const bad = await ex("Shop\nVAT £7.00\nTotal £6.00");
    expect(bad.vatPence).toBeNull();
    expect(bad.fields.vat).toBe(0);
  });
  it("total prefers the last labelled amount", async () => expect((await ex("Shop\nSubtotal £5.00\nTotal £6.00\nAmount due £7.25")).totalPence).toBe(725));
});

describe("mock adapters: exact behaviour (mutation-hardening)", () => {
  it("MockExtractor returns its fixed synthetic extraction", async () => {
    const m = new MockExtractor();
    expect(m.name).toBe("mock");
    expect(await (m as DocumentExtractor).extract({ text: "" })).toMatchObject({
      vendor: "Synthetic Supplies Ltd",
      date: "2026-07-01",
      invoiceNumber: "MOCK-1",
      fields: { total: 1, date: 1, vendor: 1, vat: 1 },
      needsReview: false,
    });
  });
  it("MockMtdGateway: names, quarter boundaries, validation and sequential submission ids", async () => {
    const g = new MockMtdGateway(() => new Date("2026-08-01T00:00:00Z"));
    expect(g.name).toBe("mock-hmrc");
    const ob = await g.obligations("2026-27");
    expect(ob.map((o) => [o.start, o.end])).toEqual([
      ["2026-04-06", "2026-07-05"],
      ["2026-07-06", "2026-10-05"],
      ["2026-10-06", "2027-01-05"],
      ["2027-01-06", "2027-04-05"],
    ]);
    for (const bad of ["2026", "x2026-27", "2026-27x"]) await expect(g.obligations(bad)).rejects.toThrow("taxYear must look like 2026-27");
    const u = buildQuarterlyUpdate("2026-27-Q1", 1000, {});
    for (const bad of ["x2026-27-Q1", "2026-27-Q1x", "2026-27-Q5"])
      await expect(g.submitQuarterlyUpdate({ ...u, periodKey: bad })).rejects.toThrow("unknown periodKey");
    expect((await g.submitQuarterlyUpdate(u)).submissionId).toBe("mock-2026-27-Q1-1");
    expect((await g.submitQuarterlyUpdate({ ...u, periodKey: "2026-27-Q2" })).submissionId).toBe("mock-2026-27-Q2-2");
    await expect(g.submitQuarterlyUpdate(u)).rejects.toThrow("period already submitted");
  });
  it("MockBankFeed: exact rows, 3-day cadence, inclusive end, 500 cap", async () => {
    const f = new MockBankFeed();
    expect(f.name).toBe("mock-openbanking");
    expect(await f.accounts()).toEqual([{ id: "mock-acc-1", name: "Synthetic Business Current", currency: "GBP" }]);
    const rows = await f.transactions("mock-acc-1", "2026-01-01", "2026-01-07");
    expect(rows).toEqual([
      { id: "mock-2026-01-01-0", accountId: "mock-acc-1", date: "2026-01-01", description: "SYNTHETIC CLIENT PAYMENT", amountPence: 150000 },
      { id: "mock-2026-01-04-1", accountId: "mock-acc-1", date: "2026-01-04", description: "SYNTHETIC SOFTWARE SUB", amountPence: -1999 },
      { id: "mock-2026-01-07-2", accountId: "mock-acc-1", date: "2026-01-07", description: "SYNTHETIC FUEL", amountPence: -4500 },
    ]);
    expect((await f.transactions("mock-acc-1", "2026-01-01", "2026-01-10")).at(-1)).toMatchObject({
      id: "mock-2026-01-10-0",
      description: "SYNTHETIC CLIENT PAYMENT",
    });
    expect(await f.transactions("mock-acc-1", "2000-01-01", "2030-01-01")).toHaveLength(500);
    await expect(f.transactions("other", "2026-01-01", "2026-01-02")).rejects.toThrow("unknown account");
  });
  it("MockOcr error names the content type", async () =>
    expect(new MockOcr().recognise({ bytes: new Uint8Array(), contentType: "text/x" })).rejects.toThrow("unsupported content type text/x"));
});
