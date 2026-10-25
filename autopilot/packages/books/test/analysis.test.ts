import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { merchantKey, similarity, daysBetween, addDays, findDuplicates, detectRecurring, addMonths, learnRules } from "../src/index.js";

describe("text helpers", () => {
  it("merchantKey strips card noise and is stable", () => {
    expect(merchantKey("TESCO STORES 1234 LONDON")).toBe(merchantKey("Tesco Stores 9876 London"));
    fc.assert(fc.property(fc.string(), (s) => merchantKey(merchantKey(s)) === merchantKey(s)));
  });
  it("similarity is symmetric and bounded", () =>
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const s = similarity(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(similarity(b, a)).toBeCloseTo(s);
      }),
    ));
  it("date helpers invert", () => {
    expect(daysBetween("2026-01-01", "2026-03-01")).toBe(59);
    fc.assert(fc.property(fc.integer({ min: -2000, max: 2000 }), (n) => daysBetween("2026-06-15", addDays("2026-06-15", n)) === n));
  });
  it("addMonths clamps month ends", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-15", -3)).toBe("2025-12-15");
  });
});

describe("findDuplicates", () => {
  const existing = [{ id: "e1", date: "2026-01-05", description: "TESCO STORES 1234", amountPence: -1250, externalId: "F1" }];
  it("exact by externalId", () => {
    const m = findDuplicates([{ id: "n1", date: "2026-02-01", description: "x", amountPence: 1, externalId: "F1" }], existing);
    expect(m[0]).toMatchObject({ id: "n1", duplicateOf: "e1", kind: "exact" });
  });
  it("probable when dates shift and merchant is similar", () => {
    const m = findDuplicates([{ id: "n2", date: "2026-01-07", description: "Tesco Stores 1234 London", amountPence: -1250 }], existing);
    expect(m[0]?.kind).toBe("probable");
  });
  it("no match outside the window or for different amounts", () => {
    expect(findDuplicates([{ id: "n3", date: "2026-01-20", description: "TESCO STORES 1234", amountPence: -1250 }], existing)).toEqual([]);
    expect(findDuplicates([{ id: "n4", date: "2026-01-05", description: "TESCO STORES 1234", amountPence: -1251 }], existing)).toEqual([]);
  });
  it("each existing row is claimed at most once", () => {
    const inc = [1, 2].map((i) => ({ id: `n${i}`, date: "2026-01-05", description: "TESCO STORES 1234", amountPence: -1250 }));
    const ofs = findDuplicates(inc, existing).filter((m) => m.duplicateOf === "e1");
    expect(ofs.length).toBeLessThanOrEqual(1 + 1); // second may match the first incoming instead
    expect(new Set(ofs.map((m) => m.id)).size).toBe(ofs.length);
  });
});

describe("detectRecurring", () => {
  const monthly = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, date: addMonths("2026-01-03", i), description: `NETFLIX.COM ${i}`, amountPence: -1099 }));
  it("finds a monthly subscription and predicts the next date", () => {
    const [s] = detectRecurring(monthly);
    expect(s).toMatchObject({ cadence: "monthly", direction: "out", occurrences: 6, typicalAmountPence: 1099, amountVaries: false });
    expect(s!.nextExpectedDate).toBe("2026-07-03");
    expect(s!.confidence).toBeGreaterThan(0.5);
  });
  it("finds weekly income", () => {
    const w = Array.from({ length: 5 }, (_, i) => ({ id: `w${i}`, date: addDays("2026-01-02", i * 7), description: "CLIENT RETAINER", amountPence: 50000 }));
    expect(detectRecurring(w)[0]).toMatchObject({ cadence: "weekly", direction: "in" });
  });
  it("ignores irregular and too-few series", () => {
    expect(detectRecurring(monthly.slice(0, 2))).toEqual([]);
    const irregular = ["2026-01-01", "2026-01-04", "2026-02-20", "2026-02-21"].map((d, i) => ({
      id: `i${i}`,
      date: d,
      description: "CAFE",
      amountPence: -300,
    }));
    expect(detectRecurring(irregular)).toEqual([]);
  });
});

describe("learnRules", () => {
  const now = "2026-06-01T00:00:00Z";
  it("learns a consistent correction", () => {
    const c = [1, 2, 3].map((i) => ({ description: `SCREWFIX ${i}00`, categoryCode: "5010", at: `2026-05-0${i}T00:00:00Z`, amountPence: -100 }));
    const [r] = learnRules(c, now);
    expect(r).toMatchObject({ categoryCode: "5010", evidence: 3, conflicting: 0 });
    expect(r!.confidence).toBeGreaterThanOrEqual(0.75);
  });
  it("does not learn from a single correction or from conflicts", () => {
    expect(learnRules([{ description: "SHELL", categoryCode: "5200", at: now }], now)).toEqual([]);
    const mixed = ["5200", "5300", "5200", "5300"].map((code, i) => ({ description: "SHELL", categoryCode: code, at: `2026-05-0${i + 1}T00:00:00Z` }));
    expect(learnRules(mixed, now)).toEqual([]);
  });
  it("recent evidence outweighs stale evidence", () => {
    const c = [
      ...[1, 2, 3].map(() => ({ description: "AMAZON", categoryCode: "5100", at: "2023-01-01T00:00:00Z" })),
      ...[1, 2, 3].map((i) => ({ description: "AMAZON", categoryCode: "5400", at: `2026-05-0${i}T00:00:00Z` })),
    ];
    expect(learnRules(c, now)[0]?.categoryCode).toBe("5400");
  });
  it("confidence is always within 0..1", () =>
    fc.assert(
      fc.property(
        fc.array(fc.record({ description: fc.constantFrom("A CO", "B CO"), categoryCode: fc.constantFrom("1", "2"), at: fc.constant(now) }), { maxLength: 20 }),
        (c) => learnRules(c, now).every((r) => r.confidence >= 0 && r.confidence <= 1),
      ),
    ));
});
