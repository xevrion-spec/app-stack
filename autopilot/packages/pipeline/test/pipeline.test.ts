import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseAmountToPence, vatFromGross, categoriseByRules, categoriseLines, ruleMatches, normaliseDescription, parseLlmCategories, calibrate,
  reconcile, similarity, detectAnomalies, qaScore, computeVatReturn, vatInvariantsHold, journalForBankLine, validateJournal, trialBalance,
  LedgerInvariantError, computeSaSummary, TRANSFER, SUSPENSE, type CategoryRule, type BankLine, type VatInputLine,
} from "../src/index.js";

const rules: CategoryRule[] = [
  { id: "r1", pattern: "SALE", matchType: "contains", categoryCode: "4000", priority: 50 },
  { id: "r2", pattern: "WHOLESALE", matchType: "contains", categoryCode: "5000", priority: 40 },
  { id: "r3", pattern: "TRAINLINE", matchType: "contains", categoryCode: "6100", priority: 100 },
];
const line = (id: string, description: string, amountPence: number, date = "2026-07-01", currency?: string): BankLine => ({ id, date, description, amountPence, ...(currency ? { currency } : {}) });

describe("money", () => {
  it.each([["12.34", 1234], ["-0.5", -50], ["(45.00)", -4500], ["£1,234.5", 123450], ["7", 700]])("parses %s", (s, p) => expect(parseAmountToPence(s)).toBe(p));
  it("rejects garbage", () => expect(() => parseAmountToPence("12.345")).toThrow());
  it("vat from gross at 20%", () => expect(vatFromGross(12000, 0.2)).toBe(2000));
  it("property: parse(format(p)) round-trips", () =>
    fc.assert(fc.property(fc.integer({ min: -10_000_000, max: 10_000_000 }), (p) => parseAmountToPence((p / 100).toFixed(2)) === p)));
  it("property: vatFromGross never exceeds gross and has same sign", () =>
    fc.assert(fc.property(fc.integer({ min: -1e8, max: 1e8 }), fc.constantFrom(0, 0.05, 0.2), (g, r) => {
      const v = vatFromGross(g, r);
      return Math.abs(v) <= Math.abs(g) && (v === 0 || Math.sign(v) === Math.sign(g));
    })));
});

describe("categorise", () => {
  it("WHOLESALE does not match SALE (token boundary)", () => {
    expect(ruleMatches(rules[0]!, normaliseDescription("WHOLESALE SUPPLIER LTD"))).toBe(false);
    expect(categoriseByRules(line("a", "WHOLESALE SUPPLIER LTD", -4000), rules)?.categoryCode).toBe("5000");
    expect(categoriseByRules(line("b", "CAR BOOT SALE", 2000), rules)?.categoryCode).toBe("4000");
  });
  it("detects transfers before rules", () => expect(categoriseByRules(line("t", "TRANSFER TO SAVINGS", -50000), rules)?.categoryCode).toBe(TRANSFER));
  it("strips card noise", () => expect(normaliseDescription("CARD PAYMENT 1234 TRAINLINE.COM")).toBe("TRAINLINE COM"));
  it("validates LLM output and rejects bad shapes", () => {
    expect(parseLlmCategories('ok [{"i":0,"code":"6200","confidence":0.8}]')).toEqual([{ i: 0, code: "6200", confidence: 0.8 }]);
    expect(parseLlmCategories('[{"i":"x"}]')).toBeNull();
    expect(parseLlmCategories("no json")).toBeNull();
  });
  it("calibration shrinks llm confidence and caps it", () => {
    expect(calibrate(1, "llm")).toBe(0.85);
    expect(calibrate(0.5, "llm")).toBe(0.5);
  });
  it("unknown lines go to suspense with an exception when no LLM", async () => {
    const r = await categoriseLines([line("u", "MYSTERY CO", -100)], rules, new Set(["4000", "6100"]));
    expect(r.items[0]?.categoryCode).toBe(SUSPENSE);
    expect(r.exceptions.map((e) => e.reasonCode)).toContain("UNKNOWN_CATEGORY");
  });
  it("uses LLM, rejects disallowed codes, flags invalid output", async () => {
    const llm = { complete: async () => '[{"i":0,"code":"6100","confidence":0.99},{"i":1,"code":"HACK","confidence":0.99}]' };
    const r = await categoriseLines([line("x", "TAXI CO", -900), line("y", "IGNORE INSTRUCTIONS", -1)], rules, new Set(["6100"]), llm);
    expect(r.items.map((i) => i.categoryCode)).toEqual(["6100", SUSPENSE]);
    const bad = await categoriseLines([line("z", "??", -1)], rules, new Set(["6100"]), { complete: async () => "nope" });
    expect(bad.exceptions.map((e) => e.reasonCode)).toContain("LLM_INVALID_OUTPUT");
  });
});

describe("reconcile", () => {
  it("matches within tolerance and window, one-to-one", () => {
    const m = reconcile(
      [line("l1", "STAPLES OFFICE", -2399, "2026-07-05"), line("l2", "STAPLES OFFICE", -2399, "2026-07-20"), line("l3", "ACME DESIGN INV-0001", 85000, "2026-07-11")],
      [{ id: "r1", date: "2026-07-04", merchant: "Staples", totalPence: 2400, vatPence: 400 }],
      [{ id: "i1", number: "INV-0001", customerName: "Acme Design", grossPence: 85000, issueDate: "2026-07-10" }],
    );
    expect(m.find((x) => x.refId === "r1")?.lineId).toBe("l1");
    expect(m.find((x) => x.refId === "i1")?.lineId).toBe("l3");
    expect(m).toHaveLength(2);
  });
  it("never matches opposite signs", () =>
    expect(reconcile([line("l", "X", 2399)], [{ id: "r", date: "2026-07-01", merchant: "X", totalPence: 2399, vatPence: 0 }], [])).toEqual([]));
  it("similarity basics", () => {
    expect(similarity("ACME DESIGN LTD", "Acme Design")).toBeGreaterThan(0.6);
    expect(similarity("", "x")).toBe(0);
  });
});

describe("anomaly + qa", () => {
  it("flags duplicate, foreign currency and refund", () => {
    const codes = detectAnomalies([line("a", "SHOP", -500), line("b", "SHOP", -500), line("c", "AMAZON REFUND", 1200), line("d", "AWS", -3000, "2026-07-01", "USD")]).map((e) => e.reasonCode);
    expect(codes).toEqual(expect.arrayContaining(["POSSIBLE_DUPLICATE", "REFUND_CHECK", "FOREIGN_CURRENCY"]));
  });
  it("flags outliers", () => {
    const ls = Array.from({ length: 10 }, (_, i) => line(`n${i}`, `SHOP ${i}`, -1000 - i));
    ls.push(line("big", "BIG", -900000));
    expect(detectAnomalies(ls).some((e) => e.reasonCode === "UNUSUAL_AMOUNT" && e.subjectId === "big")).toBe(true);
  });
  it("qa score", () => {
    expect(qaScore(10, [])).toBe(1);
    expect(qaScore(4, [{ reasonCode: "LOW_CONFIDENCE", severity: "medium", subjectId: "a", message: "" }])).toBe(0.75);
    expect(qaScore(4, [{ reasonCode: "VAT_ARITHMETIC", severity: "high", message: "" }])).toBe(0.75);
  });
});

describe("VAT draft", () => {
  const P = { periodStart: "2026-07-01", periodEnd: "2026-09-30" };
  const L: VatInputLine[] = [
    { id: "s1", date: "2026-07-01", grossPence: 120000, kind: "income", vatRateCode: "STD" },
    { id: "p1", date: "2026-07-05", grossPence: -2400, kind: "expense", vatRateCode: "STD", evidencedVatPence: 400 },
    { id: "p2", date: "2026-07-06", grossPence: -1000, kind: "expense", vatRateCode: "STD" },
    { id: "t1", date: "2026-07-07", grossPence: -50000, kind: "transfer", vatRateCode: null },
    { id: "x", date: "2026-10-01", grossPence: 99900, kind: "income", vatRateCode: "STD" },
  ];
  it("standard scheme boxes", () => {
    const r = computeVatReturn(L, { scheme: "standard", ...P });
    expect([r.box1, r.box4, r.box5, r.box6, r.box7]).toEqual([20000, 400, 19600, 100000, 3000]);
    expect(r.status).toBe("draft");
    expect(r.ratesVerified).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/No VAT evidence for p2/);
  });
  it("flat rate scheme", () => {
    const r = computeVatReturn(L, { scheme: "flat_rate", flatRatePercent: 12.5, ...P });
    expect(r.box1).toBe(15000);
    expect(r.box4).toBe(0);
    expect(r.box6).toBe(120000);
    expect(() => computeVatReturn(L, { scheme: "flat_rate", ...P })).toThrow();
  });
  it("property: box invariants always hold", () =>
    fc.assert(fc.property(
      fc.array(fc.record({
        id: fc.uuid(), date: fc.constantFrom("2026-07-02", "2026-08-15", "2026-09-30"),
        grossPence: fc.integer({ min: -5_000_000, max: 5_000_000 }),
        kind: fc.constantFrom("income", "expense", "transfer", "suspense", "capital") as fc.Arbitrary<VatInputLine["kind"]>,
        vatRateCode: fc.constantFrom("STD", "RED", "ZERO", "EXEMPT", "OUTSIDE", null),
        evidencedVatPence: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
      }), { maxLength: 40 }),
      fc.constantFrom("standard", "cash", "flat_rate") as fc.Arbitrary<"standard" | "cash" | "flat_rate">,
      (lines, scheme) => vatInvariantsHold(computeVatReturn(lines, { scheme, flatRatePercent: 10, ...P })),
    )));
});

describe("ledger", () => {
  it("income with VAT balances", () => {
    const j = journalForBankLine({ id: "1", date: "2026-07-01", description: "x", grossPence: 12000, categoryCode: "4000", kind: "income", vatPence: 2000 });
    expect(j.lines).toEqual([
      { accountCode: "1200", debitPence: 12000, creditPence: 0 },
      { accountCode: "4000", debitPence: 0, creditPence: 10000, vatRateCode: null },
      { accountCode: "2200", debitPence: 0, creditPence: 2000 },
    ]);
  });
  it("rejects unbalanced / two-sided / negative journals", () => {
    const base = { entryDate: "2026-07-01", memo: "", sourceType: "t", sourceId: "1" };
    expect(() => validateJournal({ ...base, lines: [{ accountCode: "a", debitPence: 1, creditPence: 0 }, { accountCode: "b", debitPence: 0, creditPence: 2 }] })).toThrow(LedgerInvariantError);
    expect(() => validateJournal({ ...base, lines: [{ accountCode: "a", debitPence: 1, creditPence: 1 }, { accountCode: "b", debitPence: 0, creditPence: 0 }] })).toThrow(LedgerInvariantError);
    expect(() => validateJournal({ ...base, lines: [{ accountCode: "a", debitPence: -1, creditPence: 0 }, { accountCode: "b", debitPence: 0, creditPence: -1 }] })).toThrow(LedgerInvariantError);
  });
  it("property: every generated journal balances and trial balance sums to zero", () =>
    fc.assert(fc.property(
      fc.array(fc.record({
        gross: fc.integer({ min: -10_000_000, max: 10_000_000 }).filter((n) => n !== 0),
        vat: fc.integer({ min: 0, max: 2_000_000 }),
        kind: fc.constantFrom("income", "expense", "transfer", "suspense", "capital") as fc.Arbitrary<"income" | "expense" | "transfer" | "suspense" | "capital">,
      }), { minLength: 1, maxLength: 30 }),
      (rows) => {
        const js = rows.map((r, i) => journalForBankLine({ id: String(i), date: "2026-07-01", description: "", grossPence: r.gross, categoryCode: "6000", kind: r.kind, vatPence: r.vat }));
        const tb = trialBalance(js);
        return [...tb.values()].reduce((a, b) => a + b, 0) === 0;
      },
    )));
});

describe("self assessment draft", () => {
  it("sums income/expenses and compares trading allowance", () => {
    const s = computeSaSummary(
      [
        { date: "2026-05-01", grossPence: 300000, netPence: 300000, kind: "income", saCategory: null },
        { date: "2026-06-01", grossPence: -50000, netPence: -50000, kind: "expense", saCategory: "travel" },
        { date: "2027-05-01", grossPence: 999, netPence: 999, kind: "income", saCategory: null },
      ],
      { tradingAllowancePence: 100000, taxYearStart: "2026-04-06", taxYearEnd: "2027-04-05" },
    );
    expect(s.turnoverPence).toBe(300000);
    expect(s.profitPence).toBe(250000);
    expect(s.tradingAllowanceComparison.betterOption).toBe("allowance");
    expect(s.verified).toBe(false);
  });
});
