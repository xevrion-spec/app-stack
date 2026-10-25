import type { BankLine, ExceptionItem } from "./types.js";
import { normaliseDescription } from "./categorise.js";

/** Flags duplicates, foreign currency, refunds and outliers (|z| > 3 within a description group). */
export function detectAnomalies(lines: BankLine[]): ExceptionItem[] {
  const out: ExceptionItem[] = [];
  const seen = new Map<string, string>();
  for (const l of lines) {
    const key = `${l.date}|${l.amountPence}|${normaliseDescription(l.description)}`;
    const prev = seen.get(key);
    if (prev) out.push({ reasonCode: "POSSIBLE_DUPLICATE", severity: "medium", subjectId: l.id, message: `Same date/amount/description as ${prev}` });
    else seen.set(key, l.id);
    if (l.currency && l.currency !== "GBP")
      out.push({ reasonCode: "FOREIGN_CURRENCY", severity: "medium", subjectId: l.id, message: `Currency ${l.currency}: needs GBP conversion evidence` });
    if (/\b(REFUND|REVERSAL|CHARGEBACK)\b/.test(normaliseDescription(l.description)))
      out.push({ reasonCode: "REFUND_CHECK", severity: "low", subjectId: l.id, message: "Refund: should reverse the original category, not count as income" });
  }
  const amounts = lines.map((l) => Math.abs(l.amountPence));
  if (amounts.length >= 8) {
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const sd = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length) || 1;
    lines.forEach((l, i) => {
      const z = ((amounts[i] ?? 0) - mean) / sd;
      if (z > 3) out.push({ reasonCode: "UNUSUAL_AMOUNT", severity: "medium", subjectId: l.id, message: `Amount is ${z.toFixed(1)} SD above typical` });
    });
  }
  return out;
}
