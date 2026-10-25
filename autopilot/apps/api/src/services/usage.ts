import { quotaCheck } from "@xevrion/platform";
import { TenantDb } from "../lib/db.js";
import { AppError } from "../lib/errors.js";

export const period = (d = new Date()) => d.toISOString().slice(0, 7);

export async function meter(db: TenantDb, metric: string, n = 1): Promise<void> {
  await db.run(
    "insert into usage_counters (tenant_id, metric, period, count) values (?1, ?2, ?3, ?4) on conflict (tenant_id, metric, period) do update set count = count + excluded.count",
    metric,
    period(),
    n,
  );
}
export const meterStmt = (db: TenantDb, metric: string, n = 1) =>
  db.stmt(
    "insert into usage_counters (tenant_id, metric, period, count) values (?1, ?2, ?3, ?4) on conflict (tenant_id, metric, period) do update set count = count + excluded.count",
    metric,
    period(),
    n,
  );

async function usageFor(db: TenantDb, metric: string): Promise<number> {
  return (
    (await db.first<{ count: number }>("select count from usage_counters where tenant_id = ?1 and metric = ?2 and period = ?3", metric, period()))?.count ?? 0
  );
}

/** Throws 429 quota_exceeded when adding `n` units would exceed the tenant's plan quota this month. */
export async function enforceQuota(db: TenantDb, metric: string, n: number): Promise<void> {
  const plan = (await db.tenantRowStmt("plan").first<{ plan: string | null }>())?.plan ?? "free";
  const q = quotaCheck(plan === "trial" ? "starter" : plan, metric, await usageFor(db, metric), n);
  if (!q.allowed) throw new AppError(429, "quota_exceeded", `Monthly ${metric} quota (${q.limit}) would be exceeded`, { metric, limit: q.limit });
}

/** Month-end rollup into billing_events (idempotent per tenant/metric/period via external_ref). */
export async function rollupUsageStmts(db: TenantDb, forPeriod: string) {
  const rows = await db.all<{ metric: string; count: number }>("select metric, count from usage_counters where tenant_id = ?1 and period = ?2", forPeriod);
  const stmts = [];
  for (const r of rows) {
    const ref = `usage:${forPeriod}:${r.metric}`;
    stmts.push(
      db.stmt(
        "insert into billing_events (tenant_id, id, job_id, event, amount_pence, external_ref) select ?1, ?2, null, ?3, ?4, ?5 where not exists (select 1 from billing_events where tenant_id = ?1 and external_ref = ?5)",
        crypto.randomUUID(),
        `usage.${r.metric}`,
        r.count,
        ref,
      ),
    );
  }
  return stmts;
}
