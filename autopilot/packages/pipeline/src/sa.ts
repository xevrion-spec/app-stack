import saData from "../../domain-uk-tax/self_assessment.json" with { type: "json" };
import type { Pence } from "./money.js";

/** Self Assessment (self-employment) DRAFT summary. No rates/allowances are verified; values are config-driven placeholders. */
export interface SaConfig {
  tradingAllowancePence: Pence | null;
  taxYearStart: string;
  taxYearEnd: string;
}
export interface SaLine {
  date: string;
  grossPence: Pence;
  netPence: Pence;
  kind: string;
  saCategory: string | null;
}

export interface SaSummary {
  taxYear: string;
  turnoverPence: Pence;
  expensesByCategory: Record<string, Pence>;
  allowableExpensesPence: Pence;
  profitPence: Pence;
  tradingAllowanceComparison: { allowancePence: Pence | null; profitIfAllowanceUsed: Pence | null; betterOption: "expenses" | "allowance" | "unknown" };
  status: "draft";
  verified: false;
  notes: string[];
}

export const SA_CATEGORIES: string[] = saData.sa103_expense_categories_to_verify;

export function computeSaSummary(lines: SaLine[], cfg: SaConfig): SaSummary {
  const inYear = lines.filter((l) => l.date >= cfg.taxYearStart && l.date <= cfg.taxYearEnd);
  const turnover = inYear.filter((l) => l.kind === "income").reduce((a, l) => a + l.netPence, 0);
  const byCat: Record<string, Pence> = {};
  for (const l of inYear.filter((x) => x.kind === "expense")) {
    const k = l.saCategory ?? "other";
    byCat[k] = (byCat[k] ?? 0) + Math.abs(l.netPence);
  }
  const expenses = Object.values(byCat).reduce((a, b) => a + b, 0);
  const profit = turnover - expenses;
  const allow = cfg.tradingAllowancePence;
  const profitAllow = allow == null ? null : Math.max(0, turnover - allow);
  return {
    taxYear: `${cfg.taxYearStart}..${cfg.taxYearEnd}`,
    turnoverPence: turnover,
    expensesByCategory: byCat,
    allowableExpensesPence: expenses,
    profitPence: profit,
    tradingAllowanceComparison: {
      allowancePence: allow,
      profitIfAllowanceUsed: profitAllow,
      betterOption: profitAllow == null ? "unknown" : profitAllow < profit ? "allowance" : "expenses",
    },
    status: "draft",
    verified: false,
    notes: ["Draft for preparation only. Allowances, categories and deadlines must be verified on gov.uk.", "Not tax advice."],
  };
}
