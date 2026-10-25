import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  invoiceBalance,
  creditNoteSplit,
  nextIssueDate,
  dueIssueDates,
  agedDebtors,
  dueReminders,
  MockFxRates,
  convertMinor,
  MockPaymentLinks,
  type FxRateProvider,
  type PaymentLinkProvider,
} from "../src/index.js";

describe("invoiceBalance", () => {
  it("states", () => {
    expect(invoiceBalance(1000, [], []).state).toBe("unpaid");
    expect(invoiceBalance(1000, [400], [])).toMatchObject({ state: "partially_paid", outstandingPence: 600 });
    expect(invoiceBalance(1000, [400], [600])).toMatchObject({ state: "paid", outstandingPence: 0, creditedPence: 600 });
    expect(invoiceBalance(1000, [1200], []).state).toBe("overpaid");
    expect(() => invoiceBalance(1000, [0], [])).toThrow(RangeError);
    expect(() => invoiceBalance(1000, [], [-1])).toThrow(RangeError);
  });
  it("conserves money", () =>
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e7 }), fc.array(fc.integer({ min: 1, max: 1e5 })), fc.array(fc.integer({ min: 1, max: 1e5 })), (g, p, cr) => {
        const b = invoiceBalance(g, p, cr);
        expect(b.paidPence + b.creditedPence + b.outstandingPence).toBe(g);
      }),
    ));
});

describe("creditNoteSplit", () => {
  it("reverses VAT proportionally", () => {
    expect(creditNoteSplit(1200, 1000, 200)).toEqual({ netPence: 1000, vatPence: 200 });
    expect(creditNoteSplit(600, 1000, 200)).toEqual({ netPence: 500, vatPence: 100 });
    expect(creditNoteSplit(500, 0, 0)).toEqual({ netPence: 500, vatPence: 0 });
    expect(() => creditNoteSplit(0, 1, 1)).toThrow(RangeError);
  });
  it("net + vat = gross", () =>
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 0, max: 1e6 }), (c, n, v) => {
        const s = creditNoteSplit(c, n, v);
        expect(s.netPence + s.vatPence).toBe(c);
      }),
    ));
});

describe("recurring schedules", () => {
  it("next dates per cadence", () => {
    expect(nextIssueDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextIssueDate("2026-01-01", "weekly", 2)).toBe("2026-01-15");
    expect(nextIssueDate("2026-01-01", "quarterly")).toBe("2026-04-01");
    expect(nextIssueDate("2026-01-01", "yearly")).toBe("2027-01-01");
    expect(() => nextIssueDate("2026-01-01", "monthly", 0)).toThrow(RangeError);
  });
  it("catches up but respects end date and max", () => {
    expect(dueIssueDates("2026-01-01", "monthly", "2026-03-15")).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"]);
    expect(dueIssueDates("2026-01-01", "monthly", "2026-03-15", { endDate: "2026-02-01" })).toEqual(["2026-01-01", "2026-02-01"]);
    expect(dueIssueDates("2020-01-01", "weekly", "2026-01-01", { max: 3 })).toHaveLength(3);
    expect(dueIssueDates("2027-01-01", "monthly", "2026-01-01")).toEqual([]);
  });
});

describe("agedDebtors", () => {
  it("buckets by days overdue and ranks customers", () => {
    const r = agedDebtors(
      [
        { id: "1", customer: "A", dueDate: "2026-06-30", outstandingPence: 100 },
        { id: "2", customer: "A", dueDate: "2026-05-15", outstandingPence: 200 },
        { id: "3", customer: "B", dueDate: "2026-03-01", outstandingPence: 50 },
        { id: "4", customer: "B", dueDate: "2026-07-20", outstandingPence: 10 },
        { id: "5", customer: "C", dueDate: "2026-01-01", outstandingPence: 0 },
      ],
      "2026-07-01",
    );
    expect(r.totals).toEqual({ current: 10, "1-30": 100, "31-60": 200, "61-90": 0, "90+": 50 });
    expect(r.totalPence).toBe(360);
    expect(r.customers.map((c) => c.customer)).toEqual(["A", "B"]);
  });
  it.each([
    [0, "current"],
    [30, "1-30"],
    [31, "31-60"],
    [60, "31-60"],
    [61, "61-90"],
    [90, "61-90"],
    [91, "90+"],
  ] as const)("%i days overdue -> %s", (days, bucket) => {
    const due = new Date(Date.parse("2026-07-01") - days * 86_400_000).toISOString().slice(0, 10);
    expect(agedDebtors([{ id: "x", customer: "A", dueDate: due, outstandingPence: 1 }], "2026-07-01").totals[bucket]).toBe(1);
  });
});

describe("dueReminders", () => {
  it("only the latest due reminder, never repeats", () => {
    expect(dueReminders("2026-07-10", "2026-07-06", [])).toEqual([]);
    expect(dueReminders("2026-07-10", "2026-07-07", [])).toEqual([{ kind: "before_3d", dueOn: "2026-07-07" }]);
    expect(dueReminders("2026-07-10", "2026-07-10", ["before_3d"])).toEqual([{ kind: "on_due", dueOn: "2026-07-10" }]);
    expect(dueReminders("2026-07-10", "2026-08-30", [])).toEqual([{ kind: "overdue_30d", dueOn: "2026-08-09" }]);
    expect(dueReminders("2026-07-10", "2026-08-30", ["overdue_30d"])).toEqual([]); // no backlog of older reminders
  });
});

// Contract tests: any FxRateProvider / PaymentLinkProvider adapter must pass these.
function fxContract(name: string, make: () => FxRateProvider) {
  describe(`FxRateProvider contract: ${name}`, () => {
    it("identity is 1, inverse round-trips, unknown currency rejects", async () => {
      const p = make();
      expect(await p.rate("GBP", "GBP", "2026-01-01")).toBe(1);
      const a = await p.rate("GBP", "USD", "2026-01-01");
      const b = await p.rate("USD", "GBP", "2026-01-01");
      expect(a).toBeGreaterThan(0);
      expect(a * b).toBeCloseTo(1, 4);
      await expect(p.rate("GBP", "XXX", "2026-01-01")).rejects.toThrow();
    });
  });
}
function payContract(name: string, make: () => PaymentLinkProvider) {
  describe(`PaymentLinkProvider contract: ${name}`, () => {
    it("returns an https link echoing amount/currency; rejects non-positive", async () => {
      const l = await make().createLink({ invoiceId: "i 1", number: "INV-1", amountMinor: 1200, currency: "gbp" });
      expect(l.url.startsWith("https://")).toBe(true);
      expect(l).toMatchObject({ amountMinor: 1200, currency: "GBP" });
      expect(l.providerRef).toBeTruthy();
      await expect(make().createLink({ invoiceId: "i", number: "n", amountMinor: 0, currency: "GBP" })).rejects.toThrow();
    });
  });
}
fxContract("mock-ecb", () => new MockFxRates());
payContract("mock", () => new MockPaymentLinks());

describe("convertMinor", () => {
  it("handles exponents", () => {
    expect(convertMinor(10000, "GBP", "USD", 1.294118)).toBe(12941);
    expect(convertMinor(10000, "GBP", "JPY", 188.235)).toBe(18824);
    expect(convertMinor(1000, "JPY", "GBP", 0.0053)).toBe(530);
    expect(() => convertMinor(1, "GBP", "USD", 0)).toThrow(RangeError);
  });
});
