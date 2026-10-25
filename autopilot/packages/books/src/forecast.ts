/**
 * Cash forecast and runway: projects the bank balance forward from recurring series (known future flows) plus the average
 * of non-recurring net flow over the lookback window. Deterministic and explainable: every projected flow has a source.
 */
import type { RecurringSeries } from "./recurring.js";
import { addMonths } from "./recurring.js";
import { addDays } from "./text.js";

export interface ForecastPoint {
  date: string;
  balancePence: number;
}
export interface Forecast {
  startBalancePence: number;
  points: ForecastPoint[]; // one per week
  flows: { date: string; pence: number; source: string }[];
  runwayDays: number | null; // null = balance never goes negative in the horizon
  lowestBalancePence: number;
  monthlyBurnPence: number; // average net outflow per 30 days (0 if cash-positive)
}

export function forecastCash(p: {
  today: string;
  balancePence: number;
  recurring: RecurringSeries[];
  history: { date: string; amountPence: number; recurring: boolean }[];
  horizonDays?: number;
  lookbackDays?: number;
}): Forecast {
  const horizon = p.horizonDays ?? 180;
  const lookback = p.lookbackDays ?? 90;
  const end = addDays(p.today, horizon);
  const flows: Forecast["flows"] = [];
  for (const r of p.recurring) {
    if (r.confidence < 0.5) continue;
    let d = r.nextExpectedDate;
    let guard = 0;
    while (d <= p.today && guard++ < 1000) d = step(d, r.cadence);
    while (d <= end && guard++ < 2000) {
      flows.push({ date: d, pence: r.direction === "in" ? r.typicalAmountPence : -r.typicalAmountPence, source: `recurring:${r.key}` });
      d = step(d, r.cadence);
    }
  }
  const since = addDays(p.today, -lookback);
  const adhoc = p.history.filter((h) => !h.recurring && h.date > since && h.date <= p.today).reduce((a, h) => a + h.amountPence, 0);
  const weeklyAdhoc = Math.round((adhoc / lookback) * 7);
  for (let d = addDays(p.today, 7); d <= end; d = addDays(d, 7)) if (weeklyAdhoc) flows.push({ date: d, pence: weeklyAdhoc, source: "average non-recurring" });
  flows.sort((a, b) => a.date.localeCompare(b.date) || a.source.localeCompare(b.source));
  const points: ForecastPoint[] = [];
  let bal = p.balancePence;
  let lowest = bal;
  let runway: number | null = bal < 0 ? 0 : null;
  let i = 0;
  for (let d = p.today; d <= end; d = addDays(d, 1)) {
    while (i < flows.length && flows[i]!.date <= d) bal += flows[i++]!.pence;
    lowest = Math.min(lowest, bal);
    if (runway === null && bal < 0) runway = Math.round((Date.parse(d) - Date.parse(p.today)) / 86_400_000);
    if ((Date.parse(d) - Date.parse(p.today)) % (7 * 86_400_000) === 0) points.push({ date: d, balancePence: bal });
  }
  const net = flows.reduce((a, f) => a + f.pence, 0);
  return {
    startBalancePence: p.balancePence,
    points,
    flows,
    runwayDays: runway,
    lowestBalancePence: lowest,
    monthlyBurnPence: net < 0 ? Math.round((-net / horizon) * 30) : 0,
  };
}
function step(d: string, c: RecurringSeries["cadence"]): string {
  return c === "weekly"
    ? addDays(d, 7)
    : c === "fortnightly"
      ? addDays(d, 14)
      : c === "monthly"
        ? addMonths(d, 1)
        : c === "quarterly"
          ? addMonths(d, 3)
          : addMonths(d, 12);
}
