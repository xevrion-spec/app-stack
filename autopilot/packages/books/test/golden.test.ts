import { describe, it, expect } from "vitest";
import { estimateTax, mileageAllowance, homeOffice, annualInvestmentAllowance, findDuplicates } from "../src/index.js";

// Worked examples against the UNVERIFIED placeholder rates file (not tax advice).
describe("estimateTax golden examples", () => {
  it("£60k profit, no other income", () => {
    const t = estimateTax({ turnoverPence: 6_000_000, expensesPence: 0, useTradingAllowance: false });
    expect(t).toMatchObject({
      profitPence: 6_000_000,
      personalAllowancePence: 1_257_000,
      taxableProfitPence: 4_743_000,
      incomeTaxPence: 1_143_200,
      class4Pence: 245_660,
      totalPence: 1_388_860,
      paymentsOnAccountPence: 694_430,
      effectiveRate: 0.231,
      setAsidePercent: 24,
      usedTradingAllowance: false,
    });
    expect(t.bands).toEqual([
      { name: "basic", pence: 3_770_000, rate: 0.2, taxPence: 754_000 },
      { name: "higher", pence: 973_000, rate: 0.4, taxPence: 389_200 },
    ]);
  });
  it("£200k: allowance fully tapered, additional rate", () => {
    const t = estimateTax({ turnoverPence: 20_000_000, expensesPence: 0, useTradingAllowance: false });
    expect(t.personalAllowancePence).toBe(0);
    expect(t.incomeTaxPence).toBe(7_620_300);
    expect(t.bands.map((b) => b.pence)).toEqual([3_770_000, 8_744_000, 7_486_000]);
  });
  it("partial taper at £110k", () =>
    expect(estimateTax({ turnoverPence: 11_000_000, expensesPence: 0, useTradingAllowance: false }).personalAllowancePence).toBe(757_000));
  it("other income shares the bands; income tax attributed pro rata", () => {
    const t = estimateTax({ turnoverPence: 2_000_000, expensesPence: 0, otherIncomePence: 2_000_000, useTradingAllowance: false });
    expect(t.taxableProfitPence).toBe(2_743_000);
    expect(t.incomeTaxPence).toBe(274_300);
    expect(t.class4Pence).toBe(44_580);
  });
  it("expenses reduce profit; trading allowance used when better", () => {
    expect(estimateTax({ turnoverPence: 3_000_000, expensesPence: 1_000_000 }).profitPence).toBe(2_000_000);
    const ta = estimateTax({ turnoverPence: 3_000_000, expensesPence: 50_000 });
    expect(ta).toMatchObject({ usedTradingAllowance: true, profitPence: 2_900_000 });
    expect(estimateTax({ turnoverPence: 3_000_000, expensesPence: 100_000 }).usedTradingAllowance).toBe(false);
  });
  it("zero turnover is all zeros; tiny tax has no payments on account", () => {
    expect(estimateTax({ turnoverPence: 0, expensesPence: 0 })).toMatchObject({ totalPence: 0, effectiveRate: 0, setAsidePercent: 0, bands: [] });
    expect(estimateTax({ turnoverPence: 1_500_000, expensesPence: 0, useTradingAllowance: false }).paymentsOnAccountPence).toBe(0);
    expect(() => estimateTax({ turnoverPence: 0, expensesPence: -1 })).toThrow("non-negative");
  });
});

describe("calculator boundaries and workings", () => {
  it("mileage workings and validation", () => {
    expect(mileageAllowance(10_100, "car_van").workings).toEqual(["10000 mi × 45p", "100 mi × 25p"]);
    expect(mileageAllowance(5, "bicycle").workings).toEqual(["5 mi × 20p"]);
    expect(mileageAllowance(0, "car_van").value).toBe(0);
    expect(() => mileageAllowance(NaN, "car_van")).toThrow("non-negative");
    expect(() => mileageAllowance(1, "car_van", -1)).toThrow(RangeError);
  });
  it.each([
    [24, 0],
    [25, 1000],
    [50, 1000],
    [51, 1800],
    [100, 1800],
    [101, 2600],
  ])("home office %i hours -> %i pence", (hours, pence) => expect(homeOffice([{ hours }]).value.flatRatePence).toBe(pence));
  it("home office workings, ties and validation edges", () => {
    expect(homeOffice([{ hours: 30 }, { hours: 10 }]).workings).toEqual(["month 1: 30h -> 1000p", "month 2: 10h -> 0p"]);
    const tie = homeOffice([{ hours: 30 }], { annualCostsPence: 4000, businessRooms: 1, totalRooms: 2, businessUseFraction: 0.5 });
    expect(tie.value).toEqual({ flatRatePence: 1000, actualPence: 1000, better: "flat_rate" });
    expect(tie.workings[1]).toBe("actual: 4000p × 1/2 rooms × 0.5 use = 1000p");
    expect(homeOffice([], { annualCostsPence: 900, businessRooms: 3, totalRooms: 3, businessUseFraction: 1 }).value.actualPence).toBe(900);
    expect(homeOffice([], { annualCostsPence: 900, businessRooms: 0, totalRooms: 3, businessUseFraction: 0 }).value.actualPence).toBe(0);
    expect(homeOffice([]).value).toEqual({ flatRatePence: 0, actualPence: null, better: "flat_rate" });
    expect(() => homeOffice([], { annualCostsPence: 1, businessRooms: 0, totalRooms: 0, businessUseFraction: 0 })).toThrow("invalid room counts");
    expect(() => homeOffice([], { annualCostsPence: 1, businessRooms: -1, totalRooms: 2, businessUseFraction: 0 })).toThrow("invalid room counts");
    expect(() => homeOffice([], { annualCostsPence: 1, businessRooms: 1, totalRooms: 2, businessUseFraction: -0.1 })).toThrow("0..1");
  });
  it("AIA edges and workings", () => {
    expect(annualInvestmentAllowance([{ costPence: 0 }], 18).value.claimPence).toBe(0);
    expect(() => annualInvestmentAllowance([], 19)).toThrow("1..18");
    expect(() => annualInvestmentAllowance([{ costPence: -1 }])).toThrow("non-negative");
    const big = annualInvestmentAllowance([{ costPence: 150_000_000 }]);
    expect(big.value).toEqual({ claimPence: 100_000_000, excessPence: 50_000_000, excludedCarsPence: 0 });
    expect(annualInvestmentAllowance([{ costPence: 10, isCar: true }], 12).workings).toEqual([
      "limit 100000000p for 12 months",
      "qualifying 0p",
      "cars excluded 10p (writing-down allowances instead)",
    ]);
  });
});

describe("duplicate scoring", () => {
  const e = (id: string, date: string, d = "TESCO STORES", amt = -100, ref?: string) => ({
    id,
    date,
    description: d,
    amountPence: amt,
    ...(ref ? { externalId: ref } : {}),
  });
  it("window boundary is inclusive", () => {
    expect(findDuplicates([e("n", "2026-01-04")], [e("x", "2026-01-01", "TESCO STORES LTD")])).toHaveLength(1);
    expect(findDuplicates([e("n", "2026-01-05")], [e("x", "2026-01-01", "TESCO STORES LTD")])).toHaveLength(0);
  });
  it("scores and prefers the closest date", () => {
    const m = findDuplicates([e("n", "2026-01-03")], [e("far", "2026-01-01", "TESCO STORES LTD"), e("near", "2026-01-03", "TESCO STORES LTD")]);
    expect(m).toEqual([
      { id: "n", duplicateOf: "near", kind: "probable", score: expect.any(Number), reason: "same amount, 0 day(s) apart, similar description" },
    ]);
    expect(m[0]!.score).toBeGreaterThan(0.5);
    expect(m[0]!.score).toBeLessThanOrEqual(1);
  });
  it("same-date exact text gives the exact reason; different refs do not force a match", () => {
    expect(findDuplicates([e("n", "2026-01-01")], [e("x", "2026-01-01")])[0]).toEqual({
      id: "n",
      duplicateOf: "x",
      kind: "exact",
      score: 1,
      reason: "same date, amount and description",
    });
    expect(findDuplicates([e("n", "2026-01-01", "TESCO STORES", -100, "R1")], [e("x", "2026-01-01", "TESCO STORES", -100, "R1")])[0]!.reason).toBe(
      "same bank reference",
    );
    expect(findDuplicates([e("n", "2026-03-01", "A", -5, "R2")], [e("x", "2026-01-01", "B", -100, "R1")])).toEqual([]);
    expect(findDuplicates([e("n", "2026-01-01", "ZZZ QQQ")], [e("x", "2026-01-01", "ABC DEF")])).toEqual([]);
  });
  it("a second incoming copy matches the first incoming copy", () => {
    const m = findDuplicates([e("a", "2026-01-01", "CAFE NERO"), e("b", "2026-01-02", "CAFE NERO")], [], {});
    expect(m).toEqual([expect.objectContaining({ id: "b", duplicateOf: "a" })]);
  });
});
