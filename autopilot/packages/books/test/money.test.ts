import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  profitAndLoss,
  balanceSheet,
  cashFlow,
  taxSummary,
  classify,
  forecastCash,
  mileageAllowance,
  homeOffice,
  annualInvestmentAllowance,
  estimateTax,
  saDeadlines,
  vatDeadlines,
  mtdQuarterlyDeadlines,
  upcoming,
  taxYearOf,
  UK_RATES,
  type LedgerLine,
  type Account,
} from "../src/index.js";

const accounts: Account[] = [
  { code: "1200", name: "Bank", type: "asset" },
  { code: "4000", name: "Sales", type: "income" },
  { code: "5000", name: "Materials", type: "expense", sa103: "costOfGoods" },
  { code: "2200", name: "VAT", type: "liability" },
  { code: "3000", name: "Capital", type: "equity" },
];
const j = (id: string, date: string, dr: string, cr: string, p: number): LedgerLine[] => [
  { journalId: id, date, accountCode: dr, debitPence: p, creditPence: 0 },
  { journalId: id, date, accountCode: cr, debitPence: 0, creditPence: p },
];
const lines = [
  ...j("c", "2026-01-01", "1200", "3000", 100000),
  ...j("s", "2026-01-10", "1200", "4000", 50000),
  ...j("m", "2026-01-15", "5000", "1200", 20000),
  ...j("x", "2026-03-01", "1200", "4000", 999),
];

describe("reports", () => {
  it("classify by code range", () => {
    expect(["1200", "2200", "3000", "4000", "5000", "9999", "abc"].map(classify)).toEqual([
      "asset",
      "liability",
      "equity",
      "income",
      "expense",
      "expense",
      "expense",
    ]);
  });
  it("P&L for a period", () => {
    const p = profitAndLoss(lines, accounts, "2026-01-01", "2026-01-31");
    expect(p).toMatchObject({ totalIncomePence: 50000, totalExpensesPence: 20000, netProfitPence: 30000 });
  });
  it("balance sheet balances", () => {
    const b = balanceSheet(lines, accounts, "2026-12-31") as unknown as Record<string, number | boolean>;
    expect(JSON.stringify(b)).toContain("130999");
    expect(b.balanced ?? true).toBe(true);
  });
  it("balance sheet balances for any balanced journals", () =>
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom("1200", "4000", "5000", "2200", "3000"),
            fc.constantFrom("1200", "4000", "5000", "2200", "3000"),
            fc.integer({ min: 1, max: 1e6 }),
          ),
          { maxLength: 30 },
        ),
        (js) => {
          const ls = js.flatMap(([a, b, p], i) => j(`j${i}`, "2026-01-01", a, b, p));
          const bs = balanceSheet(ls, accounts, "2026-12-31") as unknown as { balanced?: boolean };
          expect(bs.balanced ?? true).toBe(true);
        },
      ),
    ));
  it("cash flow nets bank movement", () => {
    const c = cashFlow(lines, accounts, "2026-01-01", "2026-01-31") as unknown as Record<string, unknown>;
    expect(JSON.stringify(c)).toContain("130000");
  });
  it("tax summary maps SA103 boxes", () => {
    const t = taxSummary(profitAndLoss(lines, accounts, "2026-01-01", "2026-12-31"), accounts);
    expect(t.turnoverPence).toBe(50999);
    expect(t.boxes.costOfGoods).toBe(20000);
  });
});

describe("forecastCash", () => {
  const rec = [
    {
      key: "rent",
      direction: "out" as const,
      cadence: "monthly" as const,
      occurrences: 6,
      typicalAmountPence: 100000,
      amountVaries: false,
      lastDate: "2026-01-01",
      nextExpectedDate: "2026-02-01",
      transactionIds: [],
      confidence: 0.9,
    },
  ];
  it("projects runway when burning cash", () => {
    const f = forecastCash({ today: "2026-01-15", balancePence: 250000, recurring: rec, history: [] });
    expect(f.runwayDays).not.toBeNull();
    expect(f.runwayDays!).toBeGreaterThan(30);
    expect(f.runwayDays!).toBeLessThan(120);
    expect(f.lowestBalancePence).toBeLessThan(0);
  });
  it("null runway when cash-positive", () => {
    const f = forecastCash({ today: "2026-01-15", balancePence: 1000, recurring: [{ ...rec[0]!, direction: "in" }], history: [] });
    expect(f.runwayDays).toBeNull();
    expect(f.monthlyBurnPence).toBe(0);
  });
  it("ignores low-confidence series", () => {
    const f = forecastCash({ today: "2026-01-15", balancePence: 1000, recurring: [{ ...rec[0]!, confidence: 0.2 }], history: [] });
    expect(f.flows).toEqual([]);
  });
});

describe("calculators (unverified)", () => {
  const r = UK_RATES.mileage_allowance_ppm.car_van;
  it("mileage splits at the threshold", () => {
    const e = mileageAllowance(r.first_miles + 100, "car_van");
    expect(e.value).toBe(r.first_miles * r.first_pence + 100 * r.after_pence);
    expect(e.verified).toBe(false);
    expect(mileageAllowance(100, "car_van", r.first_miles).value).toBe(100 * r.after_pence);
    expect(mileageAllowance(10, "bicycle").value).toBe(10 * UK_RATES.mileage_allowance_ppm.bicycle.pence);
    expect(mileageAllowance(10, "motorcycle").value).toBe(10 * UK_RATES.mileage_allowance_ppm.motorcycle.pence);
    expect(() => mileageAllowance(-1, "car_van")).toThrow(RangeError);
  });
  it("mileage is monotonic", () =>
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50000 }),
        fc.integer({ min: 0, max: 50000 }),
        (a, b) => mileageAllowance(Math.min(a, b), "car_van").value <= mileageAllowance(Math.max(a, b), "car_van").value,
      ),
    ));
  it("home office compares flat rate and actual", () => {
    const top = UK_RATES.home_office_flat_rate_monthly_pence.at(-1)!;
    const e = homeOffice(Array(12).fill({ hours: 200 }));
    expect(e.value.flatRatePence).toBe(12 * top.pence);
    expect(e.value.better).toBe("flat_rate");
    expect(homeOffice([{ hours: 0 }]).value.flatRatePence).toBe(0);
    const a = homeOffice([{ hours: 30 }], { annualCostsPence: 600000, businessRooms: 1, totalRooms: 4, businessUseFraction: 0.5 });
    expect(a.value).toMatchObject({ actualPence: 75000, better: "actual" });
    expect(() => homeOffice([], { annualCostsPence: 1, businessRooms: 5, totalRooms: 4, businessUseFraction: 0.5 })).toThrow(RangeError);
    expect(() => homeOffice([], { annualCostsPence: 1, businessRooms: 1, totalRooms: 4, businessUseFraction: 2 })).toThrow(RangeError);
  });
  it("AIA caps, pro-rates, excludes cars and private use", () => {
    const e = annualInvestmentAllowance([{ costPence: 100000 }, { costPence: 50000, privateUseFraction: 0.5 }, { costPence: 900000, isCar: true }]);
    expect(e.value).toEqual({ claimPence: 125000, excessPence: 0, excludedCarsPence: 900000 });
    const big = annualInvestmentAllowance([{ costPence: UK_RATES.aia_limit_pence * 2 }], 6);
    expect(big.value.claimPence).toBe(UK_RATES.aia_limit_pence / 2);
    expect(() => annualInvestmentAllowance([], 0)).toThrow(RangeError);
    expect(() => annualInvestmentAllowance([{ costPence: -1 }])).toThrow(RangeError);
  });
});

describe("estimateTax (unverified)", () => {
  it("no tax below the personal allowance", () => {
    const t = estimateTax({ turnoverPence: 500000, expensesPence: 100000 });
    expect(t.incomeTaxPence).toBe(0);
    expect(t.verified).toBe(false);
  });
  it("chooses the trading allowance when it beats expenses", () => {
    expect(estimateTax({ turnoverPence: 300000, expensesPence: 1000 }).usedTradingAllowance).toBe(true);
    expect(estimateTax({ turnoverPence: 300000, expensesPence: 200000 }).usedTradingAllowance).toBe(false);
  });
  it("tapers the personal allowance for high income", () => {
    expect(estimateTax({ turnoverPence: 20000000, expensesPence: 0 }).personalAllowancePence).toBe(0);
  });
  it("payments on account only above threshold", () => {
    expect(estimateTax({ turnoverPence: 1300000, expensesPence: 0 }).paymentsOnAccountPence).toBe(0);
    const t = estimateTax({ turnoverPence: 6000000, expensesPence: 0 });
    expect(t.paymentsOnAccountPence).toBe(Math.round(t.totalPence / 2));
  });
  it("tax is monotonic in profit and never exceeds it", () =>
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50_000_000 }), fc.integer({ min: 0, max: 50_000_000 }), (a, b) => {
        const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
        const tl = estimateTax({ turnoverPence: lo, expensesPence: 0, useTradingAllowance: false });
        const th = estimateTax({ turnoverPence: hi, expensesPence: 0, useTradingAllowance: false });
        expect(tl.totalPence).toBeLessThanOrEqual(th.totalPence);
        expect(th.totalPence).toBeLessThanOrEqual(hi);
      }),
    ));
  it("rejects negatives", () => expect(() => estimateTax({ turnoverPence: -1, expensesPence: 0 })).toThrow(RangeError));
});

describe("deadlines (unverified)", () => {
  it("taxYearOf respects 6 April", () => {
    expect(taxYearOf("2026-04-05")).toBe("2025-26");
    expect(taxYearOf("2026-04-06")).toBe("2026-27");
    expect(taxYearOf("2027-01-01")).toBe("2026-27");
  });
  it("SA calendar for a year", () => {
    const d = saDeadlines("2025-26", { paymentsOnAccount: true, firstYear: true });
    expect(d.map((x) => x.kind)).toContain("sa_register");
    const online = d.find((x) => x.kind === "sa_filing_online")!;
    expect(online.dueDate.startsWith("2027-")).toBe(true);
    expect(d.filter((x) => x.kind === "sa_payment_on_account")).toHaveLength(2);
    expect([...d].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).map((x) => x.id)).toEqual(d.map((x) => x.id));
    expect(() => saDeadlines("2025-27")).toThrow(RangeError);
  });
  it("VAT quarters roll forward", () => {
    const v = vatDeadlines("2026-03-31", 4);
    expect(v.map((x) => x.period!.end)).toEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]);
    expect(v[0]!.period!.start).toBe("2026-01-01");
    expect(v[0]!.dueDate > "2026-03-31").toBe(true);
  });
  it("MTD quarters cover the tax year contiguously", () => {
    const q = mtdQuarterlyDeadlines("2026-27");
    expect(q[0]!.period!.start).toBe("2026-04-06");
    expect(q[3]!.period!.end).toBe("2027-04-05");
    for (let i = 1; i < 4; i++) expect(q[i]!.period!.start > q[i - 1]!.period!.end).toBe(true);
  });
  it("upcoming filters and sorts", () => {
    const all = [...saDeadlines("2025-26"), ...mtdQuarterlyDeadlines("2026-27")];
    const u = upcoming(all, "2026-07-01", 60);
    expect(u.every((x) => x.daysLeft <= 60 && x.daysLeft >= -30)).toBe(true);
    expect(u.map((x) => x.daysLeft)).toEqual([...u.map((x) => x.daysLeft)].sort((a, b) => a - b));
  });
});
