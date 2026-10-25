/** Per-practice monthly metering with atomic cap enforcement (ADR 0028). One upsert both checks and counts. */
import { AppError } from "../lib/errors.js";
import type { PracticeDb } from "../lib/practice.js";
import { practiceQuota, type MeteredMetric } from "./practice.js";

const usagePeriod = (d = new Date()) => d.toISOString().slice(0, 7);
/** Counts one unit of `metric`, or throws 429 quota_exceeded when this month's cap is reached. */
export async function meterPractice(pdb: PracticeDb, metric: MeteredMetric, n = 1): Promise<number> {
  const plan = (await pdb.first<{ plan: string }>("select plan from practices where id = ?1"))?.plan ?? "trial";
  const cap = practiceQuota(plan).monthly[metric];
  const period = usagePeriod();
  const changed = await pdb.run(
    "insert into practice_usage (practice_id, period, metric, count) select ?1, ?3, ?4, ?5 where ?5 <= ?6 on conflict(practice_id, period, metric) do update set count = count + ?5 where count + ?5 <= ?6",
    period,
    metric,
    n,
    cap,
  );
  if (!changed) throw new AppError(429, "quota_exceeded", `Monthly ${metric.replace(/_/g, " ")} quota (${cap}) reached for this plan`, { metric, cap, period });
  return cap;
}
export async function practiceUsage(pdb: PracticeDb, period = usagePeriod()) {
  const plan = (await pdb.first<{ plan: string }>("select plan from practices where id = ?1"))?.plan ?? "trial";
  const rows = await pdb.all<{ metric: string; count: number }>("select metric, count from practice_usage where practice_id = ?1 and period = ?3", period);
  const used = new Map(rows.map((r) => [r.metric, r.count]));
  const q = practiceQuota(plan).monthly;
  return {
    plan,
    period,
    metrics: (Object.keys(q) as MeteredMetric[]).map((m) => ({
      metric: m,
      used: used.get(m) ?? 0,
      cap: q[m],
      remaining: Math.max(0, q[m] - (used.get(m) ?? 0)),
    })),
  };
}
