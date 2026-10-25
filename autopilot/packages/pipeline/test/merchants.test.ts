/**
 * Table-driven categorisation tests: real-world UK bank renderings (card, DD, POS, star-suffixed refs, city/country suffix)
 * for the default rule set, plus edge cases (refunds, outflows on income merchants, transfers, lookalikes, personal spend).
 */
import { describe, it, expect } from "vitest";
import cats from "../../domain-uk-tax/categories.json" with { type: "json" };
import { categoriseByRules, categoriseLines, SUSPENSE, type CategoryRule } from "../src/index.js";
import table from "./fixtures/merchants.json" with { type: "json" };

const rules: CategoryRule[] = cats.accounts.flatMap((a) =>
  a.kw.filter((k) => k.trim().length >= 2).map((k, i) => ({ id: `${a.code}-${i}`, pattern: k, matchType: "contains" as const, categoryCode: a.code, priority: 100 })),
);
const codes = new Set([...cats.accounts.map((a) => a.code), "8000"]);
const rowsT = table as [string, number, string, string][];

describe("UK merchant rule table", () => {
  it.each(rowsT)("%s (%i) -> %s [%s]", async (desc, pence, expected) => {
    const line = { id: "x", date: "2026-07-01", description: desc, amountPence: pence };
    const r = await categoriseLines([line], rules, codes);
    expect(r.items[0]!.categoryCode).toBe(expected);
    if (expected === SUSPENSE) expect(r.exceptions.some((e) => e.reasonCode === "UNKNOWN_CATEGORY")).toBe(true);
    // a rule hit is deterministic and never depends on the LLM
    if (expected !== SUSPENSE && expected !== "8000") expect(categoriseByRules(line, rules)?.method).toBe("rule");
  });
});
