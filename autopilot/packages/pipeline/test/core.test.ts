import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  computeVatReturn,
  vatInvariantsHold,
  validateJournal,
  journalForBankLine,
  trialBalance,
  LedgerInvariantError,
  computeSaSummary,
  reconcile,
  similarity,
  detectAnomalies,
  qaScore,
  isBillableOutcome,
  vatFromGross,
  vatOnNet,
  roundHalfAway,
  formatGBP,
  assertPence,
  type VatInputLine,
  type Journal,
} from "../src/index.js";

const P = { periodStart: "2026-04-01", periodEnd: "2026-06-30" };
const L = (
  id: string,
  date: string,
  grossPence: number,
  kind: VatInputLine["kind"],
  vatRateCode: string | null = "STD",
  evidencedVatPence?: number | null,
): VatInputLine => ({ id, date, grossPence, kind, vatRateCode, evidencedVatPence });

describe("money", () => {
  it.each([
    [0.5, 1],
    [-0.5, -1],
    [1.49, 1],
    [-1.5, -2],
    [2.5, 3],
    [0, 0],
    [-0.49, -0],
  ])("roundHalfAway(%d)=%d", (x, y) => expect(roundHalfAway(x)).toBe(y));
  it.each([
    [12000, 0.2, 2000],
    [100, 0.2, 17],
    [1, 0.2, 0],
    [3, 0.2, 1],
    [-12000, 0.2, -2000],
    [10500, 0.05, 500],
    [5000, 0, 0],
    [5000, -0.1, 0],
  ])("vatFromGross(%i,%d)=%i", (g, r, v) => expect(vatFromGross(g, r)).toBe(v));
  it.each([
    [10000, 0.2, 2000],
    [333, 0.2, 67],
    [-333, 0.2, -67],
    [100, 0, 0],
  ])("vatOnNet(%i,%d)=%i", (n, r, v) => expect(vatOnNet(n, r)).toBe(v));
  it.each([
    [0, "£0.00"],
    [123456, "£1,234.56"],
    [-5, "-£0.05"],
    [100, "£1.00"],
  ])("formatGBP(%i)", (p, s) => expect(formatGBP(p)).toBe(s));
  it.each([1.5, NaN, Infinity, 2 ** 60])("assertPence rejects %d", (n) => expect(() => assertPence(n)).toThrow(RangeError));
  it("net + vatFromGross never exceeds gross and is symmetric in sign", () =>
    fc.assert(
      fc.property(fc.integer({ min: -1e9, max: 1e9 }), fc.constantFrom(0.2, 0.05, 0), (g, r) => {
        const v = vatFromGross(g, r);
        return Math.abs(v) <= Math.abs(g) && vatFromGross(-g, r) === -v;
      }),
    ));
});

describe("VAT: standard / cash schemes", () => {
  it.each(["standard", "cash"] as const)("%s: sale and evidenced purchase fill boxes 1,4,5,6,7", (scheme) => {
    const r = computeVatReturn([L("s", "2026-05-01", 12000, "income"), L("p", "2026-05-02", -6000, "expense", "STD", 1000)], { scheme, ...P });
    expect([r.box1, r.box3, r.box4, r.box5, r.box6, r.box7]).toEqual([2000, 2000, 1000, 1000, 10000, 5000]);
    expect(r.status).toBe("draft");
    expect(r.ratesVerified).toBe(false);
  });
  it.each([
    ["STD sale", [L("a", "2026-05-01", 12000, "income")], { box1: 2000, box6: 10000 }],
    ["RED sale", [L("a", "2026-05-01", 10500, "income", "RED")], { box1: 500, box6: 10000 }],
    ["ZERO sale", [L("a", "2026-05-01", 10000, "income", "ZERO")], { box1: 0, box6: 10000 }],
    ["EXEMPT sale", [L("a", "2026-05-01", 10000, "income", "EXEMPT")], { box1: 0, box6: 10000 }],
    ["no rate code", [L("a", "2026-05-01", 10000, "income", null)], { box1: 0, box6: 10000 }],
    ["unknown rate code", [L("a", "2026-05-01", 10000, "income", "BOGUS")], { box1: 0, box6: 10000 }],
    ["transfer ignored", [L("a", "2026-05-01", 99999, "transfer")], { box1: 0, box6: 0, box7: 0 }],
    ["suspense ignored", [L("a", "2026-05-01", -99999, "suspense")], { box4: 0, box7: 0 }],
    ["purchase w/o evidence claims nothing", [L("a", "2026-05-01", -12000, "expense")], { box4: 0, box7: 12000 }],
    ["capital purchase with evidence", [L("a", "2026-05-01", -120000, "capital", "STD", 20000)], { box4: 20000, box7: 100000 }],
    ["sales refund reduces outputs", [L("a", "2026-05-01", 12000, "income"), L("b", "2026-05-03", -1200, "income")], { box1: 1800, box6: 9000 }],
    [
      "purchase refund reduces inputs",
      [L("a", "2026-05-01", -12000, "expense", "STD", 2000), L("b", "2026-05-05", 1200, "expense", "STD", 200)],
      { box4: 1800, box7: 9000 },
    ],
    ["box6 truncated to whole pounds", [L("a", "2026-05-01", 12099, "income")], { box1: 2017, box6: 10000 }],
    ["penny rounding: 1p sale", [L("a", "2026-05-01", 1, "income")], { box1: 0, box6: 0 }],
    ["penny rounding: 3p sale", [L("a", "2026-05-01", 3, "income")], { box1: 1, box6: 0 }],
    ["repayment return (box5 negative)", [L("a", "2026-05-01", -60000, "expense", "STD", 10000)], { box5: -10000 }],
  ] as [string, VatInputLine[], Record<string, number>][])("%s", (_n, lines, want) => {
    const r = computeVatReturn(lines, { scheme: "standard", ...P });
    expect(r).toMatchObject(want);
    expect(vatInvariantsHold(r)).toBe(true);
  });
  it.each([
    ["2026-03-31", false],
    ["2026-04-01", true],
    ["2026-06-30", true],
    ["2026-07-01", false],
    ["2025-05-01", false],
  ])("boundary date %s included=%s", (date, inc) =>
    expect(computeVatReturn([L("a", date, 12000, "income")], { scheme: "standard", ...P }).box1).toBe(inc ? 2000 : 0),
  );
  it("warns per purchase without VAT evidence, not for zero-rated", () => {
    const r = computeVatReturn([L("a", "2026-05-01", -100, "expense"), L("b", "2026-05-01", -100, "expense", "ZERO")], { scheme: "standard", ...P });
    expect(r.warnings.filter((w) => w.includes("No VAT evidence"))).toHaveLength(1);
  });
  it("cash scheme adds a payment-date warning", () => expect(computeVatReturn([], { scheme: "cash", ...P }).warnings.join()).toMatch(/Cash scheme/));
  it("empty period is all zeros", () =>
    expect(computeVatReturn([], { scheme: "standard", ...P })).toMatchObject({
      box1: 0,
      box3: 0,
      box4: 0,
      box5: 0,
      box6: 0,
      box7: 0,
      box8: 0,
      box9: 0,
      box2: 0,
    }));
  it("invariants hold for arbitrary lines", () =>
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            g: fc.integer({ min: -1e8, max: 1e8 }),
            k: fc.constantFrom("income", "expense", "transfer", "suspense", "capital"),
            c: fc.constantFrom("STD", "RED", "ZERO", "EXEMPT", "OUTSIDE", null),
            e: fc.option(fc.integer({ min: 0, max: 1e6 })),
            d: fc.constantFrom("2026-03-31", "2026-04-01", "2026-05-15", "2026-06-30", "2026-07-01"),
          }),
        ),
        fc.constantFrom("standard", "cash") as fc.Arbitrary<"standard" | "cash">,
        (ls, scheme) => {
          const r = computeVatReturn(
            ls.map((x, i) => L(String(i), x.d, x.g, x.k as VatInputLine["kind"], x.c, x.e)),
            { scheme, ...P },
          );
          return vatInvariantsHold(r);
        },
      ),
    ));
  it("output VAT is additive over disjoint sales sets (no hidden state)", () =>
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 1e7 }), { maxLength: 20 }), (gs) => {
        const one = computeVatReturn(
          gs.map((g, i) => L(String(i), "2026-05-01", g, "income")),
          { scheme: "standard", ...P },
        ).box1;
        const each = gs.reduce((a, g) => a + vatFromGross(g, 0.2), 0);
        return one === each;
      }),
    ));
});

describe("VAT: flat rate scheme", () => {
  const fr = (lines: VatInputLine[], pct: number | null = 12.5) => computeVatReturn(lines, { scheme: "flat_rate", ...P, flatRatePercent: pct });
  it.each([
    [12000, 12.5, 1500],
    [12000, 16.5, 1980],
    [10001, 12.5, 1250],
    [10004, 12.5, 1251],
    [0, 12.5, 0],
  ])("gross %i at %d%% -> box1 %i", (g, pct, b1) => expect(fr([L("a", "2026-05-01", g, "income")], pct).box1).toBe(b1));
  it.each([0, -1, 100, 150, null])("rejects flatRatePercent %j", (p) => expect(() => fr([], p)).toThrow(RangeError));
  it("excludes EXEMPT / OUTSIDE income from turnover", () =>
    expect(
      fr([L("a", "2026-05-01", 10000, "income", "EXEMPT"), L("b", "2026-05-01", 10000, "income", "OUTSIDE"), L("c", "2026-05-01", 10000, "income")]).box6,
    ).toBe(10000));
  it("purchases go to box7 gross, no input VAT reclaim", () => {
    const r = fr([L("a", "2026-05-01", -6000, "expense", "STD", 1000)]);
    expect([r.box4, r.box7]).toEqual([0, 6000]);
  });
  it("warns about capital purchases", () => expect(fr([L("a", "2026-05-01", -300000, "capital")]).warnings.join()).toMatch(/Capital purchase a/));
  it("ignores lines outside the period", () => expect(fr([L("a", "2026-07-01", 12000, "income")]).box1).toBe(0));
});

describe("ledger", () => {
  const kinds = ["income", "expense", "transfer", "suspense", "capital"] as const;
  it.each(
    kinds.flatMap(
      (k) =>
        [
          [k, 12000, 2000],
          [k, -12000, 2000],
          [k, 500, 0],
          [k, -1, 0],
        ] as const,
    ),
  )("%s gross %i vat %i balances", (kind, gross, vat) => {
    const j = journalForBankLine({ id: "t", date: "2026-05-01", description: "x", grossPence: gross, categoryCode: "6200", kind, vatPence: vat });
    const dr = j.lines.reduce((a, l) => a + l.debitPence, 0);
    expect(dr).toBe(Math.abs(gross));
    expect(j.lines.reduce((a, l) => a + l.creditPence, 0)).toBe(dr);
    expect(j.lines.some((l) => l.accountCode === "1200")).toBe(true);
    if (kind === "transfer") expect(j.lines.map((l) => l.accountCode).sort()).toEqual(["1200", "1210"]);
  });
  it("money in debits bank; money out credits bank", () => {
    const i = journalForBankLine({ id: "t", date: "d", description: "x", grossPence: 100, categoryCode: "4000", kind: "income", vatPence: 0 });
    const o = journalForBankLine({ id: "t", date: "d", description: "x", grossPence: -100, categoryCode: "6200", kind: "expense", vatPence: 0 });
    expect(i.lines.find((l) => l.accountCode === "1200")!.debitPence).toBe(100);
    expect(o.lines.find((l) => l.accountCode === "1200")!.creditPence).toBe(100);
  });
  it("VAT larger than gross is clamped (never a negative net)", () => {
    const j = journalForBankLine({ id: "t", date: "d", description: "x", grossPence: -100, categoryCode: "6200", kind: "expense", vatPence: 500 });
    expect(j.lines.every((l) => l.debitPence >= 0 && l.creditPence >= 0)).toBe(true);
  });
  it("rejects a zero journal", () =>
    expect(() => journalForBankLine({ id: "t", date: "d", description: "x", grossPence: 0, categoryCode: "6200", kind: "expense", vatPence: 0 })).toThrow(
      LedgerInvariantError,
    ));
  it("rejects fractional pence", () =>
    expect(() => journalForBankLine({ id: "t", date: "d", description: "x", grossPence: 1.5, categoryCode: "6200", kind: "expense", vatPence: 0 })).toThrow(
      RangeError,
    ));
  const J = (lines: [string, number, number][]): Journal => ({
    entryDate: "d",
    memo: "",
    sourceType: "manual",
    sourceId: "x",
    lines: lines.map(([a, d, c]) => ({ accountCode: a, debitPence: d, creditPence: c })),
  });
  it.each([
    ["one line", J([["1200", 1, 0]]), /two lines/],
    [
      "unbalanced",
      J([
        ["1200", 100, 0],
        ["6200", 0, 99],
      ]),
      /unbalanced/,
    ],
    [
      "negative",
      J([
        ["1200", -1, 0],
        ["6200", 0, -1],
      ]),
      /negative/,
    ],
    [
      "two-sided line",
      J([
        ["1200", 1, 1],
        ["6200", 0, 0],
      ]),
      /both/,
    ],
    [
      "all zero",
      J([
        ["1200", 0, 0],
        ["6200", 0, 0],
      ]),
      /empty/,
    ],
    [
      "float",
      J([
        ["1200", 0.5, 0],
        ["6200", 0, 0.5],
      ]),
      /integer/,
    ],
  ])("validateJournal rejects %s", (_n, j, err) => expect(() => validateJournal(j)).toThrow(err));
  it("trial balance always sums to zero for generated journals", () =>
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            g: fc.integer({ min: -1e9, max: 1e9 }).filter((x) => x !== 0),
            v: fc.integer({ min: 0, max: 1e8 }),
            k: fc.constantFrom(...kinds),
            c: fc.constantFrom("4000", "6100", "6200", "9999"),
          }),
          { maxLength: 40 },
        ),
        (xs) => {
          const tb = trialBalance(
            xs.map((x, i) =>
              journalForBankLine({ id: String(i), date: "2026-01-01", description: "p", grossPence: x.g, categoryCode: x.c, kind: x.k, vatPence: x.v }),
            ),
          );
          return [...tb.values()].reduce((a, b) => a + b, 0) === 0;
        },
      ),
    ));
  it("bank balance in the trial balance equals the sum of bank lines", () =>
    fc.assert(
      fc.property(
        fc.array(
          fc.integer({ min: -1e7, max: 1e7 }).filter((x) => x !== 0),
          { maxLength: 30 },
        ),
        (gs) => {
          const tb = trialBalance(
            gs.map((g, i) =>
              journalForBankLine({ id: String(i), date: "d", description: "", grossPence: g, categoryCode: "6200", kind: "expense", vatPence: 0 }),
            ),
          );
          return (tb.get("1200") ?? 0) === gs.reduce((a, b) => a + b, 0);
        },
      ),
    ));
});

describe("Self Assessment summary", () => {
  const cfg = { tradingAllowancePence: 100000, taxYearStart: "2026-04-06", taxYearEnd: "2027-04-05" };
  const S = (date: string, net: number, kind: string, saCategory: string | null = "office") => ({ date, grossPence: net, netPence: net, kind, saCategory });
  it.each([
    ["2026-04-05", false],
    ["2026-04-06", true],
    ["2027-04-05", true],
    ["2027-04-06", false],
  ])("tax-year boundary %s included=%s", (d, inc) => expect(computeSaSummary([S(d, 5000, "income")], cfg).turnoverPence).toBe(inc ? 5000 : 0));
  it.each([
    ["expenses better", 500000, 200000, "expenses"],
    ["allowance better", 500000, 50000, "allowance"],
    ["tie prefers expenses", 500000, 100000, "expenses"],
    ["turnover below allowance", 80000, 0, "allowance"],
  ] as const)("%s", (_n, inc, exp, better) => {
    const r = computeSaSummary([S("2026-05-01", inc, "income"), S("2026-05-01", -exp, "expense")], cfg);
    expect(r.profitPence).toBe(inc - exp);
    expect(r.tradingAllowanceComparison.betterOption).toBe(better);
    expect(r.tradingAllowanceComparison.profitIfAllowanceUsed).toBe(Math.max(0, inc - 100000));
  });
  it("unknown allowance -> 'unknown'", () =>
    expect(computeSaSummary([], { ...cfg, tradingAllowancePence: null }).tradingAllowanceComparison.betterOption).toBe("unknown"));
  it("groups expenses by SA category, null -> other; ignores transfers/suspense", () => {
    const r = computeSaSummary(
      [
        S("2026-05-01", -100, "expense", "travel"),
        S("2026-05-01", -200, "expense", "travel"),
        S("2026-05-01", -50, "expense", null),
        S("2026-05-01", -999, "transfer"),
        S("2026-05-01", -999, "suspense"),
      ],
      cfg,
    );
    expect(r.expensesByCategory).toEqual({ travel: 300, other: 50 });
    expect(r.allowableExpensesPence).toBe(350);
  });
  it("is always a draft and unverified", () => expect(computeSaSummary([], cfg)).toMatchObject({ status: "draft", verified: false }));
  it("profit = turnover - expenses for any input", () =>
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: -1e7, max: 1e7 }), fc.constantFrom("income", "expense", "transfer"))), (xs) => {
        const r = computeSaSummary(
          xs.map(([n, k]) => S("2026-06-01", n, k)),
          cfg,
        );
        return r.profitPence === r.turnoverPence - r.allowableExpensesPence && r.allowableExpensesPence >= 0;
      }),
    ));
});

describe("reconciliation", () => {
  const bl = (id: string, date: string, amountPence: number, description = "RYMAN") => ({ id, date, amountPence, description });
  const rc = (id: string, date: string, totalPence: number, merchant = "Ryman") => ({ id, date, totalPence, merchant, vatPence: 0 });
  it.each([
    ["exact", 0, 0, true],
    ["1p off", 1, 0, true],
    ["2p off", 2, 0, true],
    ["3p off", 3, 0, false],
    ["5 days", 0, 5, true],
    ["6 days", 0, 6, false],
    ["receipt before bank", 0, -3, true],
  ])("receipt %s matched=%s", (_n, dAmt, dDays, ok) => {
    const date = new Date(Date.parse("2026-05-10") + dDays * 864e5).toISOString().slice(0, 10);
    expect(reconcile([bl("l", "2026-05-10", -1000)], [rc("r", date, 1000 + dAmt)], []).length).toBe(ok ? 1 : 0);
  });
  it("never matches a receipt to money coming in", () => expect(reconcile([bl("l", "2026-05-10", 1000)], [rc("r", "2026-05-10", 1000)], [])).toEqual([]));
  it("never matches an invoice to money going out", () =>
    expect(
      reconcile([bl("l", "2026-05-10", -1000)], [], [{ id: "i", number: "INV-1", customerName: "Ryman", grossPence: 1000, issueDate: "2026-05-01" }]),
    ).toEqual([]));
  it.each([
    ["paid on due date", "2026-05-31", true],
    ["paid 60 days late", "2026-07-30", true],
    ["paid 61 days late", "2026-07-31", false],
    ["2 days before issue", "2026-04-29", true],
    ["3 days before issue", "2026-04-28", false],
  ])("invoice %s matched=%s", (_n, date, ok) =>
    expect(
      reconcile(
        [bl("l", date, 1000, "ACME LTD INV 42")],
        [],
        [{ id: "i", number: "INV-0042", customerName: "Acme Ltd", grossPence: 1000, issueDate: "2026-05-01", dueDate: "2026-05-31" }],
      ).length,
    ).toBe(ok ? 1 : 0),
  );
  it("is one-to-one: two identical receipts, one bank line -> one match", () =>
    expect(reconcile([bl("l", "2026-05-10", -1000)], [rc("a", "2026-05-10", 1000), rc("b", "2026-05-10", 1000)], [])).toHaveLength(1));
  it("prefers the closer date", () =>
    expect(reconcile([bl("l", "2026-05-10", -1000)], [rc("far", "2026-05-14", 1000), rc("near", "2026-05-10", 1000)], [])[0]!.refId).toBe("near"));
  it("finds a split payment of 2 receipts", () => {
    const m = reconcile(
      [bl("l", "2026-05-10", -3000, "AMAZON MARKETPLACE")],
      [rc("a", "2026-05-10", 1000, "Amazon"), rc("b", "2026-05-10", 2000, "Amazon")],
      [],
    );
    expect(m.map((x) => x.refId).sort()).toEqual(["a", "b"]);
    expect(m.every((x) => x.split)).toBe(true);
  });
  it("does not split across unrelated merchants", () =>
    expect(reconcile([bl("l", "2026-05-10", -3000, "AMAZON")], [rc("a", "2026-05-10", 1000, "Tesco"), rc("b", "2026-05-10", 2000, "Boots")], [])).toEqual([]));
  it.each([
    ["RYMAN", "Ryman", 1],
    ["RYMAN LTD", "ryman", 0.5],
    ["", "x", 0],
    ["A", "A", 0],
    ["TFL TRAVEL", "Uber", 0],
  ])("similarity(%j,%j)=%d", (a, b, s) => expect(similarity(a, b)).toBeCloseTo(s));
  it("matches are one-to-one on both sides for arbitrary inputs", () =>
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 15 }), fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 15 }), (ls, rs) => {
        const m = reconcile(
          ls.map((a, i) => bl("l" + i, "2026-05-10", -a)),
          rs.map((a, i) => rc("r" + i, "2026-05-10", a)),
          [],
        );
        const refs = m.map((x) => x.refId);
        return new Set(refs).size === refs.length && m.every((x) => x.score >= 0 && x.score <= 1);
      }),
    ));
});

describe("anomalies and QA", () => {
  const b = (id: string, description: string, amountPence = -100, date = "2026-05-01", currency?: string) => ({ id, description, amountPence, date, currency });
  it.each([
    ["duplicate", [b("a", "X"), b("b", "X")], "POSSIBLE_DUPLICATE", 1],
    ["duplicate ignoring case/whitespace", [b("a", "acme  ltd"), b("b", "ACME LTD")], "POSSIBLE_DUPLICATE", 1],
    ["not duplicate on different day", [b("a", "X"), b("b", "X", -100, "2026-05-02")], "POSSIBLE_DUPLICATE", 0],
    ["foreign currency", [b("a", "X", -1, "2026-05-01", "USD")], "FOREIGN_CURRENCY", 1],
    ["GBP fine", [b("a", "X", -1, "2026-05-01", "GBP")], "FOREIGN_CURRENCY", 0],
    ["refund", [b("a", "AMAZON REFUND")], "REFUND_CHECK", 1],
    ["chargeback", [b("a", "CHARGEBACK ACME")], "REFUND_CHECK", 1],
    ["no refund in REFUNDABLE", [b("a", "REFUNDABLE DEPOSIT")], "REFUND_CHECK", 0],
    ["outlier", [...Array.from({ length: 10 }, (_, i) => b("n" + i, "N" + i, -1000)), b("big", "BIG", -1_000_000)], "UNUSUAL_AMOUNT", 1],
    ["no outlier with < 8 lines", [b("a", "A", -1), b("big", "B", -1e7)], "UNUSUAL_AMOUNT", 0],
  ] as const)("%s", (_n, lines, code, n) => expect(detectAnomalies([...lines]).filter((e) => e.reasonCode === code)).toHaveLength(n));
  const E = (severity: "low" | "medium" | "high", subjectId = "a") => ({ reasonCode: "UNKNOWN_CATEGORY" as const, severity, subjectId, message: "" });
  it.each([
    [0, [], 1],
    [10, [], 1],
    [10, [E("low")], 1],
    [10, [E("medium")], 0.9],
    [10, [E("medium"), E("medium")], 0.9],
    [10, [E("medium", "a"), E("medium", "b")], 0.8],
    [10, [E("high")], 0.65],
    [2, [E("high", "a"), E("high", "b")], 0],
    [4, [E("high"), E("high"), E("high"), E("high"), E("high")], 0],
  ] as const)("qaScore(%i, %j)=%d", (n, ex, s) => expect(qaScore(n, [...ex])).toBe(s));
  it.each([
    [0.85, [], true],
    [0.849, [], false],
    [1, [E("high")], false],
    [0.9, [E("medium")], true],
  ] as const)("billable(%d)=%s", (s, ex, ok) => expect(isBillableOutcome(s, [...ex])).toBe(ok));
  it("qaScore is in [0,1] and monotone non-increasing in exceptions", () =>
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), fc.array(fc.constantFrom("low", "medium", "high")), (n, sev) => {
        const ex = sev.map((s, i) => E(s as "low", "s" + i));
        const a = qaScore(n, ex),
          b2 = qaScore(n, ex.slice(0, -1));
        return a >= 0 && a <= 1 && a <= b2;
      }),
    ));
});

import { isSafeRuleRegex, ruleMatches, normaliseDescription } from "../src/index.js";
describe("regex rules", () => {
  it.each(["^AMZN", "STRIPE\\s+PAYOUT", "INV\\d{3,6}", "(UBER|BOLT) TRIP", "[A-Z]+ LTD$", "TFL.*CH"])("safe: %s", (p) => expect(isSafeRuleRegex(p)).toBe(true));
  it.each(["(a+)+$", "(.*a){20}", "([a-z]+)*X", "(\\w+\\s?)+$", "(a|aa)+".replace("|", "+|"), "(x)\\1", "(?=A)", "(?<!A)B", "[", "x".repeat(81)])(
    "unsafe/invalid: %s",
    (p) => expect(isSafeRuleRegex(p)).toBe(false),
  );
  it("keeps \\d semantics (case-preserving) and matches case-insensitively", () =>
    expect(ruleMatches({ id: "r", pattern: "inv\\d{4}", matchType: "regex", categoryCode: "4000", priority: 1 }, normaliseDescription("Payment INV2231"))).toBe(
      true,
    ));
  it("unsafe regex never matches (and never hangs)", () =>
    expect(ruleMatches({ id: "r", pattern: "(A+)+$", matchType: "regex", categoryCode: "4000", priority: 1 }, "A".repeat(40) + "!")).toBe(false));
  it.each([
    ["exact", "ACME LTD", "ACME LTD", true],
    ["exact", "ACME", "ACME LTD", false],
    ["prefix", "ACME", "ACME LTD", true],
    ["prefix", "LTD", "ACME LTD", false],
    ["contains", "ACME", "MY ACME LTD", true],
    ["contains", "ACM", "ACME", false],
    ["contains", "booking.com", "BOOKING.COM AMSTERDAM", true],
  ] as const)("%s %j vs %j -> %s", (matchType, pattern, desc, ok) =>
    expect(ruleMatches({ id: "r", pattern, matchType, categoryCode: "6200", priority: 1 }, normaliseDescription(desc))).toBe(ok),
  );
});
