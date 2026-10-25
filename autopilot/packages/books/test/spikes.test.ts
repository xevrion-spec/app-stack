import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { detectSpikes, monthsBack } from "../src/index.js";

const l = (date: string, categoryCode: string, amountPence: number) => ({ date, categoryCode, amountPence });
const base = [l("2026-03-10", "fuel", -10000), l("2026-04-10", "fuel", -10000), l("2026-05-10", "fuel", -12000)];

describe("detectSpikes", () => {
  it("monthsBack crosses years", () => {
    expect(monthsBack("2026-01", 1)).toBe("2025-12");
    expect(monthsBack("2026-06", 0)).toBe("2026-06");
  });
  it("flags a material rise with ratio and severity", () => {
    const s = detectSpikes([...base, l("2026-06-02", "fuel", -25000), l("2026-06-03", "fuel", -5000)], "2026-06");
    expect(s).toEqual([{ categoryCode: "fuel", month: "2026-06", spendPence: 30000, baselinePence: 10000, increasePence: 20000, ratio: 3, severity: "high" }]);
  });
  it("medium severity between 1x and 2x the ratio threshold", () => {
    expect(detectSpikes([...base, l("2026-06-02", "fuel", -20000)], "2026-06")[0]).toMatchObject({ ratio: 2, severity: "medium" });
  });
  it("high severity at 2x the ratio threshold or for new spend", () => {
    expect(detectSpikes([...base, l("2026-06-02", "fuel", -40000)], "2026-06")[0]!.severity).toBe("high");
    expect(detectSpikes([l("2026-06-02", "new", -9000)], "2026-06")[0]).toMatchObject({ ratio: null, severity: "high", baselinePence: 0 });
  });
  it("ignores small rises, income, other months and sub-threshold ratios", () => {
    expect(detectSpikes([...base, l("2026-06-02", "fuel", -14000)], "2026-06")).toEqual([]);
    expect(detectSpikes([l("2026-06-02", "sales", 900000)], "2026-06")).toEqual([]);
    expect(detectSpikes([l("2025-01-02", "x", -900000)], "2026-06")).toEqual([]);
    expect(detectSpikes([...base, l("2026-06-02", "fuel", -14000)], "2026-06", { minIncreasePence: 1 })).toEqual([]);
    expect(detectSpikes([...base, l("2026-06-02", "fuel", -15000)], "2026-06", { minIncreasePence: 5000, minRatio: 1.5 })).toHaveLength(1);
  });
  it("validates inputs", () => {
    expect(() => detectSpikes([], "2026-6")).toThrow(RangeError);
    expect(() => detectSpikes([], "2026-06", { baselineMonths: 0 })).toThrow(RangeError);
  });
  it("sorted by increase; spend never negative", () =>
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            date: fc.constantFrom("2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01"),
            categoryCode: fc.constantFrom("a", "b", "c"),
            amountPence: fc.integer({ min: -1e6, max: 1e6 }),
          }),
        ),
        (ls) => {
          const s = detectSpikes(ls, "2026-06");
          for (let i = 1; i < s.length; i++) expect(s[i - 1]!.increasePence).toBeGreaterThanOrEqual(s[i]!.increasePence);
          expect(s.every((x) => x.spendPence > 0 && x.increasePence >= 5000)).toBe(true);
        },
      ),
    ));
});
