/**
 * Recurring transaction detection (subscriptions, rent, direct debits, retainers). Groups by merchant key and sign, then
 * looks for a stable cadence (weekly / fortnightly / monthly / quarterly / yearly) and a stable amount.
 */
import { merchantKey, daysBetween, addDays } from "./text.js";

export type Cadence = "weekly" | "fortnightly" | "monthly" | "quarterly" | "yearly";
const CADENCES: [Cadence, number, number][] = [
  ["weekly", 7, 1],
  ["fortnightly", 14, 2],
  ["monthly", 30.44, 4],
  ["quarterly", 91.3, 7],
  ["yearly", 365.25, 10],
];
export interface RecurringSeries {
  key: string;
  direction: "in" | "out";
  cadence: Cadence;
  occurrences: number;
  typicalAmountPence: number;
  amountVaries: boolean;
  lastDate: string;
  nextExpectedDate: string;
  transactionIds: string[];
  confidence: number;
}
interface Tx {
  id: string;
  date: string;
  description: string;
  amountPence: number;
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

export function detectRecurring(txns: Tx[], opts: { minOccurrences?: number; amountTolerance?: number } = {}): RecurringSeries[] {
  const minOcc = opts.minOccurrences ?? 3;
  const tol = opts.amountTolerance ?? 0.15;
  const groups = new Map<string, Tx[]>();
  for (const t of txns) {
    if (!t.amountPence) continue;
    const k = merchantKey(t.description);
    if (!k) continue;
    const g = `${t.amountPence > 0 ? "in" : "out"}|${k}`;
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const out: RecurringSeries[] = [];
  for (const [g, list] of groups) {
    if (list.length < minOcc) continue;
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const gaps = sorted
      .slice(1)
      .map((t, i) => daysBetween(sorted[i]!.date, t.date))
      .filter((d) => d > 0);
    if (gaps.length < minOcc - 1) continue;
    const mg = median(gaps);
    const match = CADENCES.find(([, days, slack]) => Math.abs(mg - days) <= slack);
    if (!match) continue;
    const [cadence, days, slack] = match;
    const onCadence = gaps.filter((d) => Math.abs(d - days) <= slack * 2).length / gaps.length;
    if (onCadence < 0.75) continue;
    const amounts = sorted.map((t) => Math.abs(t.amountPence));
    const typical = median(amounts);
    const varies = amounts.some((a) => Math.abs(a - typical) > typical * tol);
    const last = sorted[sorted.length - 1]!;
    const [direction, key] = g.split("|") as ["in" | "out", string];
    const confidence = Math.round(Math.min(1, onCadence * (varies ? 0.8 : 1) * Math.min(1, sorted.length / 6 + 0.5)) * 100) / 100;
    out.push({
      key,
      direction,
      cadence,
      occurrences: sorted.length,
      typicalAmountPence: typical,
      amountVaries: varies,
      lastDate: last.date,
      nextExpectedDate:
        cadence === "monthly"
          ? addMonths(last.date, 1)
          : cadence === "quarterly"
            ? addMonths(last.date, 3)
            : cadence === "yearly"
              ? addMonths(last.date, 12)
              : addDays(last.date, days),
      transactionIds: sorted.map((t) => t.id),
      confidence,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key));
}

/** Calendar month arithmetic clamped to month end (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
