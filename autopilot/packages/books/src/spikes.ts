/**
 * Spending-spike detection: for each category, compare the latest month's spend with a trailing baseline
 * (median of the previous `baselineMonths` months). Flags rises that are both relatively and absolutely material.
 */
export interface SpendLine {
  date: string;
  categoryCode: string;
  amountPence: number; // negative = spend
}
export interface Spike {
  categoryCode: string;
  month: string;
  spendPence: number;
  baselinePence: number;
  increasePence: number;
  ratio: number | null; // null when the baseline is zero (new spend)
  severity: "medium" | "high";
}
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
export function monthsBack(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
}

export function detectSpikes(lines: SpendLine[], month: string, opts: { baselineMonths?: number; minRatio?: number; minIncreasePence?: number } = {}): Spike[] {
  const n = opts.baselineMonths ?? 3;
  const minRatio = opts.minRatio ?? 1.5;
  const minInc = opts.minIncreasePence ?? 5000;
  if (!/^\d{4}-\d{2}$/.test(month)) throw new RangeError("month must be YYYY-MM");
  if (n < 1) throw new RangeError("baselineMonths must be >= 1");
  const window = new Set([month, ...Array.from({ length: n }, (_, i) => monthsBack(month, i + 1))]);
  const spend = new Map<string, Map<string, number>>();
  for (const l of lines) {
    if (l.amountPence >= 0) continue;
    const mo = l.date.slice(0, 7);
    if (!window.has(mo)) continue;
    const byMonth = spend.get(l.categoryCode) ?? new Map<string, number>();
    byMonth.set(mo, (byMonth.get(mo) ?? 0) - l.amountPence);
    spend.set(l.categoryCode, byMonth);
  }
  const out: Spike[] = [];
  for (const [code, byMonth] of spend) {
    const cur = byMonth.get(month) ?? 0;
    const base = med(Array.from({ length: n }, (_, i) => byMonth.get(monthsBack(month, i + 1)) ?? 0));
    const inc = cur - base;
    if (inc < minInc) continue;
    const ratio = base ? Math.round((cur / base) * 100) / 100 : null;
    if (ratio !== null && ratio < minRatio) continue;
    out.push({
      categoryCode: code,
      month,
      spendPence: cur,
      baselinePence: base,
      increasePence: inc,
      ratio,
      severity: ratio === null || ratio >= minRatio * 2 ? "high" : "medium",
    });
  }
  return out.sort((a, b) => b.increasePence - a.increasePence || a.categoryCode.localeCompare(b.categoryCode));
}
