/**
 * Ops console API (ADR 0022).
 *  - /ops/summary: the signed-in business's operational health (owner/accountant/reviewer): jobs, exceptions, webhook
 *    deliveries, event backlog, scheduled runs, retention.
 *  - /admin/overview: operator-only cross-tenant AGGREGATES (counts, no names, emails or amounts), allowed for emails in
 *    ADMIN_EMAILS. No impersonation and no write actions exist.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireRole } from "../lib/auth.js";
import { TenantDb } from "../lib/db.js";
import { forbidden } from "../lib/errors.js";
import { def, validationHook } from "../lib/route.js";
import { DAILY_JOBS } from "../services/schedules.js";

type C = Context<AppEnv>;
const scope = (c: C) => new TenantDb(c.env.DB, c.get("principal").tenantId);
export const ops = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never });
ops.use("/ops/*", requireRole("owner", "reviewer"));

const Counts = z.record(z.string(), z.number());
const Run = z.object({ job: z.string(), run_date: z.string(), status: z.string(), detail_json: z.string().nullable(), finished_at: z.string().nullable() });
const byStatus = (rows: { k: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k, r.n]));

ops.openapi(
  def({
    method: "get",
    path: "/ops/summary",
    tag: "Ops",
    summary: "Operational health for this business",
    response: z.object({
      jobs: Counts,
      failedJobs7d: z.number(),
      openExceptions: z.number(),
      webhookDeliveries: Counts,
      undispatchedEvents: z.number(),
      scheduledJobs: z.array(z.string()),
      recentRuns: z.array(Run),
      documents: z.object({ stored: z.number(), purged: z.number() }),
      health: z.enum(["ok", "degraded"]),
    }),
  }),
  async (c) => {
    const db = scope(c);
    const n = async (sql: string, ...p: unknown[]) => (await db.first<{ n: number }>(sql, ...p))?.n ?? 0;
    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const jobs = byStatus(await db.all("select status k, count(*) n from jobs where tenant_id = ?1 group by status"));
    const deliveries = byStatus(await db.all("select status k, count(*) n from webhook_deliveries where tenant_id = ?1 group by status"));
    const failedJobs7d = await n("select count(*) n from jobs where tenant_id = ?1 and status = 'failed' and created_at >= ?2", since);
    const recentRuns = await db.all<z.infer<typeof Run>>(
      "select job, run_date, status, detail_json, finished_at from scheduler_runs where tenant_id = ?1 order by run_date desc, job limit 30",
    );
    const failedRuns = recentRuns.filter((r) => r.status === "failed").length;
    return c.json(
      {
        jobs,
        failedJobs7d,
        openExceptions: await n("select count(*) n from exceptions where tenant_id = ?1 and status = 'open'"),
        webhookDeliveries: deliveries,
        undispatchedEvents: await n("select count(*) n from events where tenant_id = ?1 and dispatched_at is null"),
        scheduledJobs: [...DAILY_JOBS],
        recentRuns,
        documents: {
          stored: await n("select count(*) n from documents where tenant_id = ?1 and purged_at is null"),
          purged: await n("select count(*) n from documents where tenant_id = ?1 and purged_at is not null"),
        },
        health: failedJobs7d > 0 || failedRuns > 0 || (deliveries.failed ?? 0) > 0 ? ("degraded" as const) : ("ok" as const),
      },
      200,
    );
  },
);

const isAdmin = (email: string, list: string | undefined) =>
  (list ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());

ops.openapi(
  def({
    method: "get",
    path: "/admin/overview",
    tag: "Ops",
    summary: "Operator-only cross-tenant aggregates (no PII); requires ADMIN_EMAILS",
    response: z.object({
      tenants: Counts,
      jobs: Counts,
      webhookDeliveries: Counts,
      undispatchedEvents: z.number(),
      schedulerRuns: z.array(z.object({ run_date: z.string(), status: z.string(), n: z.number() })),
      generatedAt: z.string(),
    }),
  }),
  async (c) => {
    const p = c.get("principal");
    if (p.apiKey || !isAdmin(p.email, c.env.ADMIN_EMAILS)) throw forbidden("Operators only");
    // Cross-tenant aggregate queries: counts only, never row data.
    const q = async <T>(sql: string) => (await c.env.DB.prepare(sql).all<T>()).results ?? [];
    return c.json(
      {
        tenants: byStatus(await q("select coalesce(plan, 'free') k, count(*) n from tenants group by k")),
        jobs: byStatus(await q("select status k, count(*) n from jobs group by status")),
        webhookDeliveries: byStatus(await q("select status k, count(*) n from webhook_deliveries group by status")),
        undispatchedEvents: (await q<{ n: number }>("select count(*) n from events where dispatched_at is null"))[0]?.n ?? 0,
        schedulerRuns: await q<{ run_date: string; status: string; n: number }>(
          "select run_date, status, count(*) n from scheduler_runs group by run_date, status order by run_date desc limit 60",
        ),
        generatedAt: new Date().toISOString(),
      },
      200,
    );
  },
);
