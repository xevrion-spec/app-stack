import type { BankLine, InvoiceRef, Receipt } from "./types.js";

export interface Match {
  lineId: string;
  kind: "receipt" | "invoice";
  refId: string;
  score: number; // 0..1
}

const daysBetween = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** Token Jaccard similarity on normalised words (cheap fuzzy match for merchant names). */
export function similarity(a: string, b: string): number {
  const t = (s: string) =>
    new Set(
      s
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  const A = t(a);
  const B = t(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface ReconcileOptions {
  amountTolerancePence: number; // e.g. 1p rounding, or card fees
  dateWindowDays: number;
  minScore: number;
}
export const DEFAULT_RECONCILE: ReconcileOptions = { amountTolerancePence: 2, dateWindowDays: 5, minScore: 0.55 };

/** Score = amount closeness (50%) + date closeness (30%) + name similarity (20%). Greedy one-to-one assignment by best score. */
export function reconcile(lines: BankLine[], receipts: Receipt[], invoices: InvoiceRef[], opt: ReconcileOptions = DEFAULT_RECONCILE): Match[] {
  const cands: Match[] = [];
  for (const l of lines) {
    const amt = Math.abs(l.amountPence);
    const consider = (kind: Match["kind"], refId: string, refAmt: number, refDate: string, name: string, sign: number) => {
      if (Math.sign(l.amountPence) !== sign) return;
      const diff = Math.abs(amt - refAmt);
      if (diff > opt.amountTolerancePence) return;
      const dd = daysBetween(l.date, refDate);
      if (dd > opt.dateWindowDays) return;
      const score = 0.5 * (1 - diff / (opt.amountTolerancePence + 1)) + 0.3 * (1 - dd / (opt.dateWindowDays + 1)) + 0.2 * similarity(l.description, name);
      if (score >= opt.minScore) cands.push({ lineId: l.id, kind, refId, score: Math.round(score * 1000) / 1000 });
    };
    receipts.forEach((r) => consider("receipt", r.id, r.totalPence, r.date, r.merchant, -1));
    invoices.forEach((i) => consider("invoice", i.id, i.grossPence, i.issueDate, i.customerName + " " + i.number, 1));
  }
  cands.sort((a, b) => b.score - a.score);
  const usedL = new Set<string>();
  const usedR = new Set<string>();
  const out: Match[] = [];
  for (const c of cands) {
    if (usedL.has(c.lineId) || usedR.has(c.kind + c.refId)) continue;
    usedL.add(c.lineId);
    usedR.add(c.kind + c.refId);
    out.push(c);
  }
  return out;
}
