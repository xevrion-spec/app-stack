import type { BankLine, InvoiceRef, Receipt } from "./types.js";

export interface Match {
  lineId: string;
  kind: "receipt" | "invoice";
  refId: string;
  score: number; // 0..1
  /** Part of a split payment (several receipts for one bank line). */
  split?: boolean;
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
// eslint-disable-next-line complexity -- known debt (docs/quality.md): split in a follow-up
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
    // Invoices are paid after issue, often weeks later: accept receipts from 2 days before issue to 60 days after due date.
    // A quoted invoice number in the bank reference is strong evidence.
    for (const i of invoices) {
      if (l.amountPence <= 0) continue;
      const diff = Math.abs(amt - i.grossPence);
      if (diff > opt.amountTolerancePence) continue;
      const after = (Date.parse(l.date) - Date.parse(i.issueDate)) / 86_400_000;
      const lateBy = (Date.parse(l.date) - Date.parse(i.dueDate ?? i.issueDate)) / 86_400_000;
      if (after < -2 || lateBy > 60) continue;
      const quotesNumber = new RegExp(`(^|\\D)${i.number.replace(/\D/g, "").replace(/^0+/, "") || "#"}(\\D|$)`).test(l.description.replace(/[^0-9 ]/g, " "))
        ? 1
        : 0;
      const score =
        0.5 * (1 - diff / (opt.amountTolerancePence + 1)) +
        0.15 * (lateBy <= 0 ? 1 : 1 - lateBy / 61) +
        0.2 * quotesNumber +
        0.15 * similarity(l.description, i.customerName);
      if (score >= opt.minScore) cands.push({ lineId: l.id, kind: "invoice", refId: i.id, score: Math.round(score * 1000) / 1000 });
    }
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
  // Split payments: one card payment covering 2-3 receipts from the same merchant (e.g. a basket split into orders).
  // Bounded search (max 10 nearby candidates -> at most 165 combinations per line) keeps this cheap.
  for (const l of lines) {
    if (usedL.has(l.id) || l.amountPence >= 0) continue;
    const near = receipts
      .filter((r) => !usedR.has("receipt" + r.id) && daysBetween(l.date, r.date) <= opt.dateWindowDays && similarity(l.description, r.merchant) > 0)
      .slice(0, 10);
    const target = -l.amountPence;
    let best: Receipt[] | null = null;
    const pick = (start: number, chosen: Receipt[], sum: number) => {
      if (best) return;
      if (chosen.length >= 2 && Math.abs(sum - target) <= opt.amountTolerancePence) best = [...chosen];
      if (chosen.length === 3) return;
      for (let i = start; i < near.length; i++) pick(i + 1, [...chosen, near[i]!], sum + near[i]!.totalPence);
    };
    pick(0, [], 0);
    if (best) {
      usedL.add(l.id);
      for (const r of best as Receipt[]) {
        usedR.add("receipt" + r.id);
        out.push({ lineId: l.id, kind: "receipt", refId: r.id, score: 0.7, split: true });
      }
    }
  }
  return out;
}
