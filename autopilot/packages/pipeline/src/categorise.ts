import { z } from "zod";
import type { BankLine, ExceptionItem, LlmClient } from "./types.js";

export interface CategoryRule {
  id: string;
  pattern: string;
  matchType: "contains" | "prefix" | "exact" | "regex";
  categoryCode: string;
  vatRateCode?: string | null;
  priority: number; // lower wins
}

export interface Categorisation {
  lineId: string;
  categoryCode: string;
  confidence: number;
  method: "rule" | "transfer" | "llm" | "fallback";
  ruleId?: string;
  vatRateCode?: string | null;
}

export const SUSPENSE = "9999";
export const TRANSFER = "8000";

/** Normalise bank descriptions: uppercase, collapse whitespace, strip card/ref noise. */
export function normaliseDescription(d: string): string {
  return d
    .toUpperCase()
    .replace(/\b(CARD|VISA|DEBIT|PAYMENT|POS|CONTACTLESS)\b/g, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/[^A-Z0-9&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whole-word / token-boundary match, so "SALE" doesn't match "WHOLESALE". */
/**
 * Conservative ReDoS guard for user regex rules: bounded length, no backreferences/lookarounds, and no quantified group
 * that itself contains a quantifier (the classic "(a+)+" catastrophic-backtracking shape).
 */
export function isSafeRuleRegex(pattern: string): boolean {
  if (pattern.length > 80) return false;
  if (/\\[1-9]|\(\?[=!<]/.test(pattern)) return false;
  if (/\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)\s*[+*{?]/.test(pattern)) return false;
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

export function ruleMatches(rule: CategoryRule, normDesc: string): boolean {
  // Patterns are normalised exactly like descriptions, so "booking.com" or "B&Q" match "BOOKING COM" / "B&Q".
  const p = rule.matchType === "regex" ? rule.pattern : normaliseDescription(rule.pattern);
  if (!p) return false;
  switch (rule.matchType) {
    case "exact":
      return normDesc === p;
    case "prefix":
      return normDesc.startsWith(p);
    case "regex":
      if (!isSafeRuleRegex(rule.pattern)) return false;
      try {
        return new RegExp(rule.pattern, "i").test(normDesc);
      } catch {
        return false;
      }
    case "contains": {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^A-Z0-9])${esc}($|[^A-Z0-9])`).test(normDesc);
    }
  }
}

const REFUND_RE = /\b(REFUND|RFND|REFD|REVERSAL|RETURN)\b/;
export const SALES = "4000";
const TRANSFER_RE = /\b(TRANSFER|TFR|TO SAVINGS|FROM SAVINGS|OWN ACCOUNT|POT)\b/;

export function categoriseByRules(line: BankLine, rules: CategoryRule[]): Categorisation | null {
  const norm = normaliseDescription(line.description);
  if (TRANSFER_RE.test(norm)) return { lineId: line.id, categoryCode: TRANSFER, confidence: 0.9, method: "transfer" };
  const isIn = line.amountPence > 0;
  const isRefund = REFUND_RE.test(norm);
  // Priority first, then the most specific (longest) pattern: "GOOGLE ADS" beats "GOOGLE".
  const ordered = [...rules].sort((a, b) => a.priority - b.priority || b.pattern.trim().length - a.pattern.trim().length);
  const skipped: string[] = [];
  for (const r of ordered) {
    if (!ruleMatches(r, norm)) continue;
    // Review-list rules (personal / not allowable spend, e.g. "UBER EATS" vs "UBER") force a human decision.
    if (r.categoryCode === SUSPENSE) return null;
    const ruleIsIncome = r.categoryCode === SALES;
    const p = normaliseDescription(r.pattern);
    // Don't fall back to a shorter pattern of the same merchant ("SHOPIFY PAYMENTS" outflow must not become "SHOPIFY" software).
    if (skipped.some((s) => s.includes(p))) return null;
    // Money going out can never be a sale (e.g. "INVOICE PAYMENT TO PRINTER").
    if (ruleIsIncome && !isIn) {
      skipped.push(p);
      continue;
    }
    // Money coming in on an expense rule: a refund is a contra-expense (same account); otherwise it is suspicious.
    const confidence = !ruleIsIncome && isIn ? (isRefund ? 0.9 : 0.6) : 0.95;
    return { lineId: line.id, categoryCode: r.categoryCode, confidence, method: "rule", ruleId: r.id, vatRateCode: r.vatRateCode ?? null };
  }
  return null;
}

export const LlmCategorySchema = z.array(
  z.object({ i: z.number().int().nonnegative(), code: z.string().min(1).max(10), confidence: z.number().min(0).max(1) }),
);

/** Extract the first JSON array from model text and validate. */
export function parseLlmCategories(text: string): z.infer<typeof LlmCategorySchema> | null {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const r = LlmCategorySchema.safeParse(JSON.parse(m[0]));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Calibrate raw model confidence: models over-claim, so shrink toward 0.5 and cap below rule confidence. */
export function calibrate(raw: number, method: Categorisation["method"]): number {
  if (method === "rule") return Math.min(raw, 0.97);
  if (method === "llm") return Math.round(Math.min(0.9, 0.5 + (raw - 0.5) * 0.7) * 100) / 100;
  return Math.min(raw, 0.5);
}

export interface CategoriseResult {
  items: Categorisation[];
  exceptions: ExceptionItem[];
}

export async function categoriseLines(
  lines: BankLine[],
  rules: CategoryRule[],
  allowedCodes: Set<string>,
  llm?: LlmClient,
  reviewThreshold = 0.85,
): Promise<CategoriseResult> {
  const items: Categorisation[] = [];
  const unknown: BankLine[] = [];
  for (const l of lines) {
    const c = categoriseByRules(l, rules);
    if (c) items.push(c);
    else unknown.push(l);
  }
  const exceptions: ExceptionItem[] = [];
  if (unknown.length) {
    let parsed: ReturnType<typeof parseLlmCategories> = null;
    if (llm) {
      const prompt =
        `You are a UK bookkeeping assistant. Allowed account codes: ${[...allowedCodes].join(", ")}. ` +
        `Use ${SUSPENSE} if unsure. Reply ONLY with a JSON array of {"i":number,"code":string,"confidence":number}.\n` +
        JSON.stringify(unknown.map((l, i) => ({ i, desc: l.description, pence: l.amountPence })));
      try {
        parsed = parseLlmCategories(await llm.complete(prompt));
      } catch {
        parsed = null;
      }
      if (!parsed) exceptions.push({ reasonCode: "LLM_INVALID_OUTPUT", severity: "low", message: "LLM output failed validation; lines sent to review" });
    }
    unknown.forEach((l, i) => {
      const r = parsed?.find((p) => p.i === i);
      const code = r && allowedCodes.has(r.code) ? r.code : SUSPENSE;
      const method = r ? "llm" : "fallback";
      items.push({ lineId: l.id, categoryCode: code, confidence: calibrate(r?.confidence ?? 0, method), method });
    });
  }
  for (const it of items) {
    if (it.categoryCode === SUSPENSE)
      exceptions.push({ reasonCode: "UNKNOWN_CATEGORY", severity: "medium", subjectId: it.lineId, message: "Could not categorise" });
    else if (it.confidence < reviewThreshold)
      exceptions.push({ reasonCode: "LOW_CONFIDENCE", severity: "medium", subjectId: it.lineId, message: `Confidence ${it.confidence}` });
    else if (it.categoryCode === TRANSFER)
      exceptions.push({ reasonCode: "TRANSFER_CHECK", severity: "low", subjectId: it.lineId, message: "Confirm own-account transfer" });
  }
  const order = new Map(lines.map((l, i) => [l.id, i]));
  items.sort((a, b) => (order.get(a.lineId) ?? 0) - (order.get(b.lineId) ?? 0));
  return { items, exceptions };
}
