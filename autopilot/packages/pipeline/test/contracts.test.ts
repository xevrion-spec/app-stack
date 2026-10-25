/** Contract tests for the categoriser's LLM/exception paths and VAT scheme edge cases (targeted at Stryker survivors). */
import { describe, it, expect } from "vitest";
import {
  categoriseLines,
  categoriseByRules,
  calibrate,
  parseLlmCategories,
  normaliseDescription,
  isSafeRuleRegex,
  computeVatReturn,
  vatInvariantsHold,
  SUSPENSE,
  TRANSFER,
  type CategoryRule,
  type BankLine,
  type LlmClient,
} from "../src/index.js";

const line = (id: string, description: string, amountPence = -1000): BankLine => ({ id, date: "2026-07-01", description, amountPence }) as BankLine;
const rule = (pattern: string, categoryCode: string, over: Partial<CategoryRule> = {}): CategoryRule =>
  ({ id: `r-${pattern}`, pattern, matchType: "contains", categoryCode, priority: 100, ...over }) as CategoryRule;
const allowed = new Set(["6200", "7100", "4000", SUSPENSE, TRANSFER]);
const llm = (reply: string | Error): LlmClient & { prompts: string[] } => {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (p) => {
      prompts.push(p);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
};

describe("normalisation", () => {
  it.each([
    ["CARD PAYMENT TO ADOBE", "TO ADOBE"],
    ["VISA ADOBE*CC 12345678", "ADOBE CC"],
    ["ADOBE.COM", "ADOBE COM"],
    ["M&S SIMPLY FOOD", "M&S SIMPLY FOOD"],
    ["O'NEILLS", "O'NEILLS"],
    ["REF 123", "REF 123"],
    ["REF 1234", "REF"],
    ["CONTACTLESSADOBE", "CONTACTLESSADOBE"],
    ["pos  shell", "SHELL"],
    ["DEBIT-SHELL", "SHELL"],
  ])("%j -> %j", (i, o) => expect(normaliseDescription(i)).toBe(o));
  it("removed tokens become word breaks, not glue", () => expect(normaliseDescription("ADOBECARDCLOUD CARD X")).toBe("ADOBECARDCLOUD X"));
});

describe("isSafeRuleRegex", () => {
  it.each([
    ["a".repeat(80), true],
    ["a".repeat(81), false],
    ["(a+)+", false],
    ["(a*) *", false],
    ["(ab)+", true],
    ["(a|b)c", true],
    ["[", false],
    ["^ADOBE\\b", true],
  ])("%j -> %s", (p, ok) => expect(isSafeRuleRegex(p)).toBe(ok));
});

describe("rule matching details", () => {
  it("an empty or punctuation-only contains pattern never matches", () => {
    expect(categoriseByRules(line("1", "ANYTHING"), [rule("***", "6200")])).toBeNull();
    expect(categoriseByRules(line("1", "ANYTHING"), [rule("   ", "6200")])).toBeNull();
  });
  it("regex rules keep their pattern (not normalised), are case-insensitive, and run on the normalised description", () => {
    expect(categoriseByRules(line("1", "ADOBE.COM"), [rule("^adobe com$", "6200", { matchType: "regex" })])?.categoryCode).toBe("6200");
    // Documented limitation: punctuation is normalised away before regex rules run, so a literal "\\." never matches.
    expect(categoriseByRules(line("1", "ADOBE.COM"), [rule("adobe\\.com", "6200", { matchType: "regex" })])).toBeNull();
    expect(categoriseByRules(line("1", "REF 12"), [rule("ref \\d{2}$", "6200", { matchType: "regex" })])?.categoryCode).toBe("6200");
  });
  it("an invalid regex rule is skipped, not thrown", () => expect(categoriseByRules(line("1", "X"), [rule("(", "6200", { matchType: "regex" })])).toBeNull());
  it("contains patterns with regex metacharacters are matched literally", () => {
    expect(categoriseByRules(line("1", "PAY C++ CLUB"), [rule("C++", "6200", { matchType: "regex" })])).toBeNull();
    expect(categoriseByRules(line("1", "AB CO"), [rule("A.", "6200")])).toBeNull();
  });
  it("longer pattern wins within the same priority, ignoring surrounding spaces", () => {
    const r = categoriseByRules(line("1", "AMAZON WEB SERVICES"), [rule("AMAZON", "7100"), rule("  AMAZON WEB  ", "6200")]);
    expect(r?.categoryCode).toBe("6200");
    const r2 = categoriseByRules(line("1", "AMAZON WEB SERVICES"), [rule("  AMAZON WEB  ", "6200"), rule("AMAZON", "7100")]);
    expect(r2?.categoryCode).toBe("6200");
  });
  it("transfers short-circuit with method transfer at 0.9", () =>
    expect(categoriseByRules(line("1", "TRANSFER TO SAVINGS"), [rule("SAVINGS", "6200")])).toEqual({
      lineId: "1",
      categoryCode: TRANSFER,
      confidence: 0.9,
      method: "transfer",
    }));
  it("a zero-amount line is not treated as income", () => expect(categoriseByRules(line("1", "ADOBE", 0), [rule("ADOBE", "6200")])?.confidence).toBe(0.95));
  it("vatRateCode is null when the rule has none, kept when present", () => {
    expect(categoriseByRules(line("1", "ADOBE"), [rule("ADOBE", "6200")])?.vatRateCode).toBeNull();
    expect(categoriseByRules(line("1", "ADOBE"), [rule("ADOBE", "6200", { vatRateCode: "STD" })])?.vatRateCode).toBe("STD");
  });
  it("an expense rule matched by money in is a refund (0.9) only when the text says so, else 0.6", () => {
    expect(categoriseByRules(line("1", "ADOBE REFUND", 500), [rule("ADOBE", "6200")])?.confidence).toBe(0.9);
    expect(categoriseByRules(line("1", "ADOBE", 500), [rule("ADOBE", "6200")])?.confidence).toBe(0.6);
  });
});

describe("calibrate", () => {
  it.each([
    [1, "rule", 0.97],
    [0.5, "rule", 0.5],
    [0.99, "rule", 0.97],
    [1, "llm", 0.85],
    [0.5, "llm", 0.5],
    [0, "llm", 0.15],
    [0.9, "llm", 0.78],
    [0.9, "fallback", 0.5],
    [0.2, "fallback", 0.2],
    [0, "transfer", 0],
  ] as [number, "rule" | "llm" | "fallback" | "transfer", number][])("calibrate(%s, %s) = %s", (raw, m, want) => expect(calibrate(raw, m)).toBe(want));
});

describe("parseLlmCategories", () => {
  it.each([
    ['[{"i":0,"code":"6200","confidence":0.8}]', [{ i: 0, code: "6200", confidence: 0.8 }]],
    ['Sure!\n[{"i":0,"code":"6200","confidence":0.8}]\nthanks', [{ i: 0, code: "6200", confidence: 0.8 }]],
    ['[\n {"i":1,\n "code":"7100","confidence":1}\n]', [{ i: 1, code: "7100", confidence: 1 }]],
    ["no json here", null],
    ["[not json]", null],
    ['[{"i":-1,"code":"6200","confidence":0.5}]', null],
    ['[{"i":0,"code":"","confidence":0.5}]', null],
    ['[{"i":0,"code":"6200","confidence":1.5}]', null],
    ["{}", null],
  ])("%j", (t, want) => expect(parseLlmCategories(t)).toEqual(want));
});

describe("categoriseLines: LLM path, exceptions and ordering", () => {
  const rules = [rule("ADOBE", "6200"), rule("GITHUB", "6200")];
  it("without an LLM, unknown lines fall back to suspense with an UNKNOWN_CATEGORY exception", async () => {
    const r = await categoriseLines([line("a", "MYSTERY")], rules, allowed);
    expect(r.items).toEqual([{ lineId: "a", categoryCode: SUSPENSE, confidence: 0, method: "fallback" }]);
    expect(r.exceptions).toEqual([{ reasonCode: "UNKNOWN_CATEGORY", severity: "medium", subjectId: "a", message: "Could not categorise" }]);
  });
  it("no LLM call when every line matched a rule", async () => {
    const m = llm("[]");
    const r = await categoriseLines([line("a", "ADOBE")], rules, allowed, m);
    expect(m.prompts).toEqual([]);
    expect(r.exceptions).toEqual([]);
  });
  it("the prompt lists allowed codes, the suspense code and only the unknown lines with their index", async () => {
    const m = llm('[{"i":0,"code":"7100","confidence":0.95}]');
    await categoriseLines([line("a", "ADOBE"), line("b", "MYSTERY", -250)], rules, allowed, m);
    expect(m.prompts).toHaveLength(1);
    expect(m.prompts[0]).toContain("Allowed account codes: 6200, 7100, 4000, 9999, 8000.");
    expect(m.prompts[0]).toContain(`Use ${SUSPENSE} if unsure.`);
    expect(m.prompts[0]).toContain('[{"i":0,"desc":"MYSTERY","pence":-250}]');
    expect(m.prompts[0]).not.toContain("ADOBE");
  });
  it("LLM answers are calibrated, mapped by index, and low confidence goes to review", async () => {
    const m = llm('[{"i":1,"code":"7100","confidence":1},{"i":0,"code":"4000","confidence":0.5}]');
    const r = await categoriseLines([line("x", "AAA"), line("y", "BBB")], rules, allowed, m);
    expect(r.items).toEqual([
      { lineId: "x", categoryCode: "4000", confidence: 0.5, method: "llm" },
      { lineId: "y", categoryCode: "7100", confidence: 0.85, method: "llm" },
    ]);
    expect(r.exceptions).toEqual([{ reasonCode: "LOW_CONFIDENCE", severity: "medium", subjectId: "x", message: "Confidence 0.5" }]);
  });
  it("a disallowed code from the LLM becomes suspense; a missing index falls back", async () => {
    const m = llm('[{"i":0,"code":"1234","confidence":0.99}]');
    const r = await categoriseLines([line("x", "AAA"), line("y", "BBB")], rules, allowed, m);
    expect(r.items.map((i) => [i.lineId, i.categoryCode, i.method])).toEqual([
      ["x", SUSPENSE, "llm"],
      ["y", SUSPENSE, "fallback"],
    ]);
    expect(r.exceptions.map((e) => e.reasonCode)).toEqual(["UNKNOWN_CATEGORY", "UNKNOWN_CATEGORY"]);
  });
  it.each([["garbage"], [new Error("timeout")]])("invalid LLM output (%s) records LLM_INVALID_OUTPUT and sends lines to review", async (reply) => {
    const r = await categoriseLines([line("x", "AAA")], rules, allowed, llm(reply as string | Error));
    expect(r.exceptions[0]).toEqual({ reasonCode: "LLM_INVALID_OUTPUT", severity: "low", message: "LLM output failed validation; lines sent to review" });
    expect(r.exceptions[1]?.reasonCode).toBe("UNKNOWN_CATEGORY");
  });
  it("review threshold is exclusive: confidence equal to it passes", async () => {
    const r = await categoriseLines([line("a", "ADOBE", 500)], rules, allowed, undefined, 0.6);
    expect(r.exceptions).toEqual([]);
    const r2 = await categoriseLines([line("a", "ADOBE", 500)], rules, allowed, undefined, 0.61);
    expect(r2.exceptions.map((e) => e.reasonCode)).toEqual(["LOW_CONFIDENCE"]);
  });
  it("confident transfers get a TRANSFER_CHECK, low-confidence ones LOW_CONFIDENCE only", async () => {
    const r = await categoriseLines([line("t", "TRANSFER TO SAVINGS")], rules, allowed);
    expect(r.exceptions).toEqual([{ reasonCode: "TRANSFER_CHECK", severity: "low", subjectId: "t", message: "Confirm own-account transfer" }]);
    const r2 = await categoriseLines([line("t", "TRANSFER TO SAVINGS")], rules, allowed, undefined, 0.95);
    expect(r2.exceptions.map((e) => e.reasonCode)).toEqual(["LOW_CONFIDENCE"]);
  });
  it("output preserves input order even when rule and LLM results interleave", async () => {
    const m = llm('[{"i":0,"code":"7100","confidence":1},{"i":1,"code":"7100","confidence":1}]');
    const ids = ["u1", "r1", "u2", "r2"];
    const r = await categoriseLines([line("u1", "AAA"), line("r1", "ADOBE"), line("u2", "BBB"), line("r2", "GITHUB")], rules, allowed, m);
    expect(r.items.map((i) => i.lineId)).toEqual(ids);
  });
});

describe("VAT scheme edge cases", () => {
  const period = { periodStart: "2026-04-01", periodEnd: "2026-06-30" };
  const L = (id: string, kind: string, grossPence: number, vatRateCode: string | null, over: object = {}) =>
    ({ id, date: "2026-05-01", kind, grossPence, vatRateCode, ...over }) as Parameters<typeof computeVatReturn>[0][number];
  it("always starts with the unverified-draft warning", () =>
    expect(computeVatReturn([], { scheme: "standard", ...period }).warnings).toEqual([
      "Draft only: VAT rates/rules are UNVERIFIED placeholders. Not for submission.",
    ]));
  it("cash scheme adds its warning; standard does not", () => {
    expect(computeVatReturn([], { scheme: "cash", ...period }).warnings[1]).toBe("Cash scheme: bank-dated lines used as payment dates.");
    expect(computeVatReturn([], { scheme: "standard", ...period }).warnings).toHaveLength(1);
  });
  it.each([[null], [0], [100], [-1], [150]])("flat rate rejects percent %s", (pct) =>
    expect(() => computeVatReturn([], { scheme: "flat_rate", ...period, flatRatePercent: pct as number | null })).toThrow(
      "flat_rate scheme requires flatRatePercent in (0,100)",
    ),
  );
  it("flat rate: only positive, VAT-able income counts; expenses go to box 7; capital only warns", () => {
    const r = computeVatReturn(
      [
        L("i1", "income", 12000, "STD"),
        L("i2", "income", 1000, "EXEMPT"),
        L("i3", "income", 1000, "OUTSIDE"),
        L("i4", "income", -500, "STD"),
        L("i5", "expense", 3000, "STD"),
        L("e1", "expense", -2400, "STD"),
        L("e2", "expense", 500, "STD"),
        L("c1", "capital", -50000, "STD"),
        L("c2", "capital", 100, "STD"),
      ],
      { scheme: "flat_rate", ...period, flatRatePercent: 12.5 },
    );
    expect(r.box1).toBe(1500);
    expect(r.box6).toBe(12000);
    expect(r.box7).toBe(2400);
    expect(r.box4).toBe(0);
    expect(r.warnings).toEqual([
      "Draft only: VAT rates/rules are UNVERIFIED placeholders. Not for submission.",
      "Flat rate 12.5% (UNVERIFIED for this trade sector).",
      "Capital purchase c1: may be reclaimable under flat rate if over threshold (verify).",
    ]);
  });
  it("standard: income with no or unknown rate code adds no output VAT", () => {
    const r = computeVatReturn([L("a", "income", 1200, null), L("b", "income", 1200, "NOPE")], { scheme: "standard", ...period });
    expect([r.box1, r.box6]).toEqual([0, 2400]);
  });
  it("standard: input VAT only from evidence; refunds reverse the evidenced VAT sign", () => {
    const r = computeVatReturn(
      [
        L("e", "expense", -1200, "STD", { evidencedVatPence: 200 }),
        L("r", "expense", 600, "STD", { evidencedVatPence: 100 }),
        L("z", "expense", 0, "STD", { evidencedVatPence: 50 }),
      ],
      { scheme: "standard", ...period },
    );
    expect(r.box4).toBe(200 - 100 + 50);
    expect(r.box7).toBe(Math.trunc((1000 - 500 - 50) / 100) * 100);
    expect(r.warnings).toHaveLength(1);
  });
  it("standard: a VAT-able purchase with no evidence warns; zero-rated or unknown codes do not", () => {
    const r = computeVatReturn([L("n", "expense", -1200, "STD"), L("z", "expense", -1200, "ZERO"), L("u", "expense", -1200, null)], {
      scheme: "standard",
      ...period,
    });
    expect(r.warnings.slice(1)).toEqual(["No VAT evidence for n: input VAT not claimed."]);
    expect(r.box4).toBe(0);
  });
  it("transfers and suspense lines are ignored", () => {
    const r = computeVatReturn([L("t", "transfer", -5000, "STD"), L("s", "suspense", -5000, "STD")], { scheme: "standard", ...period });
    expect([r.box1, r.box4, r.box6, r.box7]).toEqual([0, 0, 0, 0]);
  });
  it("lines outside the period are excluded at both edges", () => {
    const r = computeVatReturn(
      [
        L("a", "income", 1200, "STD", { date: "2026-03-31" }),
        L("b", "income", 1200, "STD", { date: "2026-04-01" }),
        L("c", "income", 1200, "STD", { date: "2026-06-30" }),
        L("d", "income", 1200, "STD", { date: "2026-07-01" }),
      ],
      { scheme: "standard", ...period },
    );
    expect(r.box1).toBe(400);
  });
  it("invariants: detect a tampered box 3, box 5, or a non-whole-pound box 6-9", () => {
    const r = computeVatReturn([L("a", "income", 1234, "STD")], { scheme: "standard", ...period });
    expect(vatInvariantsHold(r)).toBe(true);
    expect(vatInvariantsHold({ ...r, box3: r.box3 + 1 })).toBe(false);
    expect(vatInvariantsHold({ ...r, box2: 5 })).toBe(false);
    expect(vatInvariantsHold({ ...r, box5: r.box5 + 1 })).toBe(false);
    for (const k of ["box6", "box7", "box8", "box9"] as const) expect(vatInvariantsHold({ ...r, [k]: 150 })).toBe(false);
  });
});
