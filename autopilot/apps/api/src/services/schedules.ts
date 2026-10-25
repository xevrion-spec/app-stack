/**
 * Daily scheduled jobs (ADR 0022): recurring-invoice drafts, invoice reminder EVENTS, and document retention.
 * - Idempotent per (tenant, job, date) via scheduler_runs' unique key, so cron overlap or retries never double-run.
 * - Failures are isolated per tenant and job and recorded; one tenant cannot block another.
 * - Nothing is emailed or charged. Reminders are outbox events only. Retention is report-only (dry run) unless
 *   DOCUMENT_RETENTION_DAYS is configured; it then removes the stored file only and keeps the document row as a tombstone.
 */
import { hasFeature } from "@xevrion/platform";
import { addDays } from "@xevrion/books";
import type { Env } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { runRecurring, runReminders } from "../routes/invoicing.js";

export const DAILY_JOBS = ["recurring_invoices", "invoice_reminders", "document_retention"] as const;
type DailyJob = (typeof DAILY_JOBS)[number];
const SYSTEM_ACTOR = "system:scheduler";
/** UTC hour from which the daily run may start (cron fires every minute; the KV gate makes it once a day). */
const DAILY_HOUR_UTC = 6;

export async function retentionRun(db: TenantDb, env: Env, today: string) {
  const days = Number(env.DOCUMENT_RETENTION_DAYS);
  const enforce = Number.isInteger(days) && days >= 365;
  const cutoff = addDays(today, -(enforce ? days : 7 * 365));
  const due = await db.all<{ id: string; r2_key: string }>(
    "select id, r2_key from documents where tenant_id = ?1 and purged_at is null and date(created_at) < ?2 order by created_at limit 500",
    cutoff,
  );
  if (!enforce) return { mode: "dry_run" as const, cutoff, eligible: due.length, purged: 0 };
  let purged = 0;
  for (const d of due) {
    await env.DOCS.delete(d.r2_key);
    purged += await db.run("update documents set purged_at = ?3 where tenant_id = ?1 and id = ?2 and purged_at is null", d.id, new Date().toISOString());
  }
  if (purged) await db.batch([auditStmt(db, SYSTEM_ACTOR, "documents.retention_purged", db.tenantId, { purged, cutoff })]);
  return { mode: "enforce" as const, cutoff, eligible: due.length, purged };
}

async function runJob(job: DailyJob, db: TenantDb, env: Env, plan: string | null, today: string): Promise<Record<string, unknown> | null> {
  if (job === "recurring_invoices")
    return hasFeature(plan, "recurring_invoices") ? { issued: (await runRecurring(db, env, SYSTEM_ACTOR, today)).issued.length } : null;
  if (job === "invoice_reminders") return { emitted: (await runReminders(db, env, SYSTEM_ACTOR, today)).emitted.length };
  return retentionRun(db, env, today);
}

export interface DailySummary {
  date: string;
  tenants: number;
  ran: number;
  skipped: number;
  failed: number;
}

/** Runs every daily job for every tenant once for `today`. Safe to call repeatedly. */
export async function runDaily(env: Env, today: string): Promise<DailySummary> {
  // Cross-tenant discovery (ids + plan only), then all work is tenant-scoped.
  const tenants = (await env.DB.prepare("select id, plan from tenants order by id limit 10000").all<{ id: string; plan: string | null }>()).results ?? [];
  const s: DailySummary = { date: today, tenants: tenants.length, ran: 0, skipped: 0, failed: 0 };
  for (const t of tenants) {
    const db = new TenantDb(env.DB, t.id);
    for (const job of DAILY_JOBS) {
      const runId = newId();
      const claimed = await db.run(
        "insert or ignore into scheduler_runs (tenant_id, id, job, run_date, status) values (?1, ?2, ?3, ?4, 'running')",
        runId,
        job,
        today,
      );
      if (!claimed) {
        s.skipped++;
        continue;
      }
      let status = "ok",
        detail: unknown;
      try {
        detail = (await runJob(job, db, env, t.plan, today)) ?? { skipped: "plan" };
        s.ran++;
      } catch (e) {
        status = "failed";
        detail = { error: (e as Error).message.slice(0, 300) };
        s.failed++;
      }
      await db.run(
        "update scheduler_runs set status = ?3, detail_json = ?4, finished_at = ?5 where tenant_id = ?1 and id = ?2",
        runId,
        status,
        JSON.stringify(detail),
        new Date().toISOString(),
      );
    }
  }
  return s;
}

/** Cron entry: at most one full pass per UTC day after DAILY_HOUR_UTC, gated in KV (scheduler_runs keeps it idempotent anyway). */
export async function maybeRunDaily(env: Env, now = new Date()): Promise<DailySummary | null> {
  if (now.getUTCHours() < DAILY_HOUR_UTC) return null;
  const today = now.toISOString().slice(0, 10);
  const key = `sched:daily:${today}`;
  if (await env.CONFIG.get(key)) return null;
  await env.CONFIG.put(key, "1", { expirationTtl: 3 * 86400 });
  return runDaily(env, today);
}
