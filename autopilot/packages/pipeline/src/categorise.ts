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
export function ruleMatches(rule: CategoryRule, normDesc: string): boolean {
  const p = rule.pattern.toUpperCase().trim();
  switch (rule.matchType) {
    case "exact":
      return normDesc === p;
    case "prefix":
      return normDesc.startsWith(p);
    case "regex":
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

const TRANSFER_RE = /\b(TRANSFER|TFR|TO SAVINGS|FROM SAVINGS|OWN ACCOUNT|POT)\b/;

export function categoriseByRules(line: BankLine, rules: CategoryRule[]): Categorisation | null {
  const norm = normaliseDescription(line.description);
  if (TRANSFER_RE.test(norm)) return { lineId: line.id, categoryCode: TRANSFER, confidence: 0.9, method: "transfer" };
  const hit = [...rules].sort((a, b) => a.priority - b.priority).find((r) => ruleMatches(r, norm));
  if (!hit) return null;
  return { lineId: line.id, categoryCode: hit.categoryCode, confidence: 0.95, method: "rule", ruleId: hit.id, vatRateCode: hit.vatRateCode ?? null };
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
