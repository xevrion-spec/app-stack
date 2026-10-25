/**
 * Deadline calendar: Self Assessment (registration, filing, balancing payment, payments on account), VAT returns per period,
 * and MTD ITSA quarterly updates. Produces dated items; reminders are emitted as events by the API (never sent).
 */
import { UK_RATES, type UkRates } from "./rates.js";
import { addMonths } from "./recurring.js";
import { addDays } from "./text.js";

export interface Deadline {
  id: string;
  kind: "sa_register" | "sa_filing_online" | "sa_filing_paper" | "sa_balancing_payment" | "sa_payment_on_account" | "vat_return" | "mtd_quarterly_update";
  dueDate: string;
  title: string;
  taxYear?: string;
  period?: { start: string; end: string };
  verified: false;
}
const md = (year: number, mmdd: string) => `${year}-${mmdd}`;

/** UK tax year label for a date: 6 April to 5 April. */
export function taxYearOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const start = m > 4 || (m === 4 && d >= 6) ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function saDeadlines(taxYear: string, opts: { paymentsOnAccount?: boolean; firstYear?: boolean } = {}, r: UkRates = UK_RATES): Deadline[] {
  const start = Number(taxYear.slice(0, 4));
  if (!/^\d{4}-\d{2}$/.test(taxYear) || (start + 1) % 100 !== Number(taxYear.slice(5))) throw new RangeError("taxYear must look like 2026-27");
  const d = r.deadlines;
  const end = start + 1; // tax year ends 5 April `end`
  const out: Deadline[] = [];
  const add = (kind: Deadline["kind"], dueDate: string, title: string) =>
    out.push({ id: `${kind}:${taxYear}:${dueDate}`, kind, dueDate, title, taxYear, verified: false });
  if (opts.firstYear) add("sa_register", md(end, d.sa_register_by), `Register for Self Assessment (${taxYear})`);
  add("sa_filing_paper", md(end, d.sa_paper_filing), `Paper return deadline (${taxYear})`);
  add("sa_filing_online", md(end + 1, d.sa_online_filing), `Online return deadline (${taxYear})`);
  add("sa_balancing_payment", md(end + 1, d.sa_balancing_payment), `Balancing payment for ${taxYear}`);
  if (opts.paymentsOnAccount) {
    add("sa_payment_on_account", md(end + 1, d.sa_balancing_payment), `1st payment on account for ${end}-${String((end + 1) % 100).padStart(2, "0")}`);
    add("sa_payment_on_account", md(end + 1, d.sa_second_payment_on_account), `2nd payment on account for ${end}-${String((end + 1) % 100).padStart(2, "0")}`);
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.kind.localeCompare(b.kind));
}

/** VAT periods are quarters ending on the stagger month; due 1 month + 7 days after period end (configurable). */
export function vatDeadlines(firstPeriodEnd: string, count: number, r: UkRates = UK_RATES): Deadline[] {
  const rule = r.deadlines.vat_return_due_months_and_days_after_period_end;
  const out: Deadline[] = [];
  let end = firstPeriodEnd;
  for (let i = 0; i < count; i++) {
    const start = addDays(addMonths(end, -3), 1);
    const due = addDays(addMonths(end, rule.months), rule.days);
    out.push({ id: `vat_return:${end}`, kind: "vat_return", dueDate: due, title: `VAT return ${start} to ${end}`, period: { start, end }, verified: false });
    end = monthEnd(addMonths(end, 3));
  }
  return out;
}
const monthEnd = (d: string) => {
  const [y, m] = d.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** MTD ITSA standard quarters (6 Apr–5 Jul, …); updates due a configurable number of days after each quarter end. */
export function mtdQuarterlyDeadlines(taxYear: string, r: UkRates = UK_RATES): Deadline[] {
  const y = Number(taxYear.slice(0, 4));
  const ends = [`${y}-07-05`, `${y}-10-05`, `${y + 1}-01-05`, `${y + 1}-04-05`];
  let start = `${y}-04-06`;
  return ends.map((end, i) => {
    const d: Deadline = {
      id: `mtd_q${i + 1}:${taxYear}`,
      kind: "mtd_quarterly_update",
      dueDate: addDays(end, r.deadlines.mtd_itsa_quarterly_update_days_after_quarter_end),
      title: `MTD quarterly update Q${i + 1} ${taxYear}`,
      taxYear,
      period: { start, end },
      verified: false,
    };
    start = addDays(end, 1);
    return d;
  });
}

/** Items due within `days` of `today`, soonest first, with days remaining (negative = overdue). */
export function upcoming(deadlines: Deadline[], today: string, days = 60): (Deadline & { daysLeft: number })[] {
  return deadlines
    .map((d) => ({ ...d, daysLeft: Math.round((Date.parse(d.dueDate) - Date.parse(today)) / 86_400_000) }))
    .filter((d) => d.daysLeft <= days && d.daysLeft >= -30)
    .sort((a, b) => a.daysLeft - b.daysLeft || a.id.localeCompare(b.id));
}
