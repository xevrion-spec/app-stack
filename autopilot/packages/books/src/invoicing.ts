/**
 * Invoicing logic: balances with partial payments and credit notes, recurring schedules, aged debtors, reminder
 * schedules (emitted as events, never sent), and provider interfaces for FX rates and payment links (mock adapters only).
 */
import { addDays } from "./text.js";
import { addMonths } from "./recurring.js";

export interface Balance {
  grossPence: number;
  paidPence: number;
  creditedPence: number;
  outstandingPence: number;
  state: "unpaid" | "partially_paid" | "paid" | "overpaid";
}
export function invoiceBalance(grossPence: number, payments: number[], credits: number[]): Balance {
  if (payments.some((p) => p <= 0) || credits.some((c) => c <= 0)) throw new RangeError("payments and credits must be positive");
  const paid = payments.reduce((a, b) => a + b, 0);
  const credited = credits.reduce((a, b) => a + b, 0);
  const outstanding = grossPence - paid - credited;
  const state = outstanding < 0 ? "overpaid" : outstanding === 0 ? "paid" : paid + credited > 0 ? "partially_paid" : "unpaid";
  return { grossPence, paidPence: paid, creditedPence: credited, outstandingPence: outstanding, state };
}

/** Split a gross credit amount into net + VAT at the invoice's effective VAT ratio, so credit notes reverse VAT proportionally. */
export function creditNoteSplit(creditGrossPence: number, invoiceNetPence: number, invoiceVatPence: number): { netPence: number; vatPence: number } {
  if (creditGrossPence <= 0) throw new RangeError("credit must be positive");
  const gross = invoiceNetPence + invoiceVatPence;
  if (gross <= 0) return { netPence: creditGrossPence, vatPence: 0 };
  const vat = Math.round((creditGrossPence * invoiceVatPence) / gross);
  return { netPence: creditGrossPence - vat, vatPence: vat };
}

export type InvoiceCadence = "weekly" | "monthly" | "quarterly" | "yearly";
export function nextIssueDate(date: string, cadence: InvoiceCadence, interval = 1): string {
  if (!Number.isInteger(interval) || interval < 1) throw new RangeError("interval must be a positive integer");
  return cadence === "weekly" ? addDays(date, 7 * interval) : addMonths(date, (cadence === "monthly" ? 1 : cadence === "quarterly" ? 3 : 12) * interval);
}
/** Issue dates due on or before `upto`, starting at `next`, stopping at `endDate` and after `max` dates (catch-up guard). */
export function dueIssueDates(
  next: string,
  cadence: InvoiceCadence,
  upto: string,
  opts: { interval?: number; endDate?: string | null; max?: number } = {},
): string[] {
  const out: string[] = [];
  let d = next;
  const max = opts.max ?? 12;
  while (d <= upto && (!opts.endDate || d <= opts.endDate) && out.length < max) {
    out.push(d);
    d = nextIssueDate(d, cadence, opts.interval ?? 1);
  }
  return out;
}

export interface Receivable {
  id: string;
  customer: string;
  dueDate: string;
  outstandingPence: number;
}
export const AGE_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export function agedDebtors(items: Receivable[], today: string) {
  const bucketOf = (days: number) => (days <= 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+");
  const totals: Record<(typeof AGE_BUCKETS)[number], number> = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const byCustomer = new Map<string, Record<string, number>>();
  for (const r of items) {
    if (r.outstandingPence <= 0) continue;
    const b = bucketOf(Math.round((Date.parse(today) - Date.parse(r.dueDate)) / 86_400_000));
    totals[b] += r.outstandingPence;
    const c = byCustomer.get(r.customer) ?? {};
    c[b] = (c[b] ?? 0) + r.outstandingPence;
    byCustomer.set(r.customer, c);
  }
  const customers = [...byCustomer]
    .map(([customer, buckets]) => ({ customer, buckets, totalPence: Object.values(buckets).reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.totalPence - a.totalPence || a.customer.localeCompare(b.customer));
  return { totals, totalPence: Object.values(totals).reduce((a, b) => a + b, 0), customers };
}

/** Reminder kinds that are due today or earlier for an unpaid invoice (offsets in days relative to the due date). */
export const DEFAULT_REMINDER_OFFSETS = [-3, 0, 7, 14, 30];
export function dueReminders(dueDate: string, today: string, alreadySent: string[], offsets = DEFAULT_REMINDER_OFFSETS): { kind: string; dueOn: string }[] {
  const sent = new Set(alreadySent);
  // Only the most recent due reminder is ever eligible: skipped older ones are never sent later as a backlog.
  const latest = offsets
    .map((o) => ({ kind: o < 0 ? `before_${-o}d` : o === 0 ? "on_due" : `overdue_${o}d`, dueOn: addDays(dueDate, o) }))
    .filter((r) => r.dueOn <= today)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn))
    .at(-1);
  return latest && !sent.has(latest.kind) ? [latest] : [];
}

// ---------- provider interfaces (mock adapters only; no live providers) ----------
export interface FxRateProvider {
  readonly name: string;
  /** Units of `to` per 1 unit of `from` on `date`. */
  rate(from: string, to: string, date: string): Promise<number>;
}
export class MockFxRates implements FxRateProvider {
  readonly name = "mock-ecb";
  // Synthetic fixed rates vs EUR (NOT real market data).
  private static readonly PER_EUR: Record<string, number> = { EUR: 1, GBP: 0.85, USD: 1.1, JPY: 160, CHF: 0.95 };
  async rate(from: string, to: string, _date: string): Promise<number> {
    const f = MockFxRates.PER_EUR[from.toUpperCase()],
      t = MockFxRates.PER_EUR[to.toUpperCase()];
    if (!f || !t) throw new RangeError(`unsupported currency ${!f ? from : to}`);
    return Math.round((t / f) * 1e6) / 1e6;
  }
}
/** Convert minor units between currencies with different exponents (JPY has 0 decimals). */
const EXP: Record<string, number> = { JPY: 0 };
export function convertMinor(amountMinor: number, from: string, to: string, rate: number): number {
  if (!(rate > 0)) throw new RangeError("rate must be positive");
  const major = amountMinor / 10 ** (EXP[from.toUpperCase()] ?? 2);
  return Math.round(major * rate * 10 ** (EXP[to.toUpperCase()] ?? 2));
}

export interface PaymentLink {
  url: string;
  providerRef: string;
  amountMinor: number;
  currency: string;
}
export interface PaymentLinkProvider {
  readonly name: string;
  createLink(i: { invoiceId: string; number: string; amountMinor: number; currency: string }): Promise<PaymentLink>;
}
export class MockPaymentLinks implements PaymentLinkProvider {
  readonly name = "mock";
  async createLink(i: { invoiceId: string; number: string; amountMinor: number; currency: string }): Promise<PaymentLink> {
    if (!(i.amountMinor > 0)) throw new RangeError("amount must be positive");
    return {
      url: `https://pay.example.test/i/${encodeURIComponent(i.invoiceId)}`,
      providerRef: `mock_${i.number}`,
      amountMinor: i.amountMinor,
      currency: i.currency.toUpperCase(),
    };
  }
}
