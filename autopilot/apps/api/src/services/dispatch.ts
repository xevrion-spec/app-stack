import { matchesFilter, type EventEnvelope } from "@xevrion/platform";
import { deliverReviewCallbacks } from "./agent-review-delivery.js";
import type { Env } from "../env.js";
import { TenantDb } from "../lib/db.js";
import { log } from "../lib/log.js";
import { runAutomation, type AutomationRow } from "./automations.js";
import { publish, rowToEnvelope, type EventRow } from "./events.js";
import { rollupUsageStmts } from "./usage.js";
import { attemptDelivery, deliveryStmts, devHttpHosts, type EndpointRow } from "./webhooks.js";

export interface DispatchReport {
  events: number;
  automationRuns: number;
  emitted: number;
  deliveries: Record<string, number>;
  realtime: "sent" | "skipped" | "failed";
  /** Agent review per-request callbacks attempted for review.completed events. */
  callbacks?: Record<string, number>;
}

/**
 * Fan one batch of outbox events out to automations, webhooks and realtime. Safe to run more than once for the same
 * events (queue redelivery, sweeper): automation runs and action executions are unique per (automation, event) and
 * deliveries are unique per (endpoint, event).
 */
export async function dispatchEvents(env: Env, tenantId: string, eventIds: string[], rand: () => number = Math.random): Promise<DispatchReport> {
  const db = new TenantDb(env.DB, tenantId);
  const report: DispatchReport = { events: 0, automationRuns: 0, emitted: 0, deliveries: {}, realtime: "skipped" };
  if (!eventIds.length) return report;
  const placeholders = eventIds.map((_, i) => `?${i + 2}`).join(",");
  const rows = await db.all<EventRow>(
    `select id, type, version, actor, causation_json, payload_json, created_at, dispatched_at from events where tenant_id = ?1 and id in (${placeholders}) order by created_at, id`,
    ...eventIds,
  );
  const events = rows.map((r) => rowToEnvelope(tenantId, r));
  report.events = events.length;
  const autos = await db.all<AutomationRow & { trigger_event: string }>(
    "select id, name, definition_json, enabled, trigger_event from automations where tenant_id = ?1 and enabled = 1 and deleted_at is null",
  );
  const endpoints = await db.all<EndpointRow & { event_filters_json: string }>(
    "select id, url, secret, status, consecutive_failures, first_failure_at, event_filters_json from webhook_endpoints where tenant_id = ?1 and status = 'active' and deleted_at is null",
  );
  const emitted: string[] = [];
  for (const ev of events) {
    for (const a of autos.filter((x) => x.trigger_event === ev.type)) {
      const r = await runAutomation(db, a, ev, false);
      if (r.runId) report.automationRuns++;
      emitted.push(...r.emitted);
    }
    const targets = endpoints.filter((e) => matchesFilter(ev.type, JSON.parse(e.event_filters_json) as string[]));
    if (targets.length)
      await db.batch(
        deliveryStmts(
          db,
          targets.map((t) => t.id),
          ev.id,
        ),
      );
    for (const ep of targets) {
      const d = await db.first<{ id: string }>("select id from webhook_deliveries where tenant_id = ?1 and endpoint_id = ?2 and event_id = ?3", ep.id, ev.id);
      if (!d) continue;
      const outcome = await attemptDelivery(db, d.id, ev, ep, rand, devHttpHosts(env));
      report.deliveries[outcome] = (report.deliveries[outcome] ?? 0) + 1;
    }
  }
  report.callbacks = await deliverReviewCallbacks(env, db, events, rand);
  report.realtime = await pushRealtime(env, tenantId, events);
  await db.run(
    `update events set dispatched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where tenant_id = ?1 and dispatched_at is null and id in (${placeholders})`,
    ...eventIds,
  );
  // events produced by automations are dispatched in a follow-up message (keeps each batch bounded; loop guard applies)
  report.emitted = emitted.length;
  if (emitted.length) await publish(env, tenantId, emitted);
  return report;
}

/** Best effort: realtime is an optimisation, never a reason to fail dispatch. */
async function pushRealtime(env: Env, tenantId: string, events: EventEnvelope[]): Promise<DispatchReport["realtime"]> {
  if (!env.REALTIME || !events.length) return "skipped";
  try {
    const stub = env.REALTIME.get(env.REALTIME.idFromName(tenantId));
    const res = await stub.fetch("https://realtime/publish", {
      method: "POST",
      body: JSON.stringify(events.map((e) => ({ id: e.id, type: e.type, occurredAt: e.occurredAt, data: e.data }))),
    });
    return res.ok ? "sent" : "failed";
  } catch (e) {
    log("warn", "realtime.publish_failed", { tenantId, err: String(e) });
    return "failed";
  }
}

/** Retry due webhook deliveries (called from the cron sweeper). */
export async function retryDueDeliveries(env: Env, tenantId: string, now = new Date().toISOString(), limit = 100, rand: () => number = Math.random) {
  const db = new TenantDb(env.DB, tenantId);
  const due = await db.all<{ id: string; endpoint_id: string; event_id: string }>(
    "select id, endpoint_id, event_id from webhook_deliveries where tenant_id = ?1 and status in ('pending','failed') and next_attempt_at <= ?2 order by next_attempt_at limit ?3",
    now,
    limit,
  );
  const out: Record<string, number> = {};
  for (const d of due) {
    const ep = await db.first<EndpointRow>(
      "select id, url, secret, status, consecutive_failures, first_failure_at from webhook_endpoints where tenant_id = ?1 and id = ?2 and deleted_at is null",
      d.endpoint_id,
    );
    const er = await db.first<EventRow>(
      "select id, type, version, actor, causation_json, payload_json, created_at, dispatched_at from events where tenant_id = ?1 and id = ?2",
      d.event_id,
    );
    if (!ep || !er) continue;
    const r = await attemptDelivery(db, d.id, rowToEnvelope(tenantId, er), ep, rand, devHttpHosts(env));
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

/** Cron sweeper: re-publish stale undispatched outbox events and retry due deliveries, for every tenant with work. */
export async function sweep(env: Env, now = new Date()): Promise<{ republished: number; retried: number; rolledUp: number }> {
  const stale = new Date(now.getTime() - 60_000).toISOString();
  // Cross-tenant discovery query (like membership lookup): returns only tenant ids + event ids, then work is tenant-scoped.
  const rows =
    (
      await env.DB.prepare("select tenant_id, id from events where dispatched_at is null and created_at < ?1 order by created_at limit 1000")
        .bind(stale)
        .all<{ tenant_id: string; id: string }>()
    ).results ?? [];
  const byTenant = new Map<string, string[]>();
  for (const r of rows) byTenant.set(r.tenant_id, [...(byTenant.get(r.tenant_id) ?? []), r.id]);
  for (const [t, ids] of byTenant) await publish(env, t, ids);
  const due =
    (
      await env.DB.prepare("select distinct tenant_id from webhook_deliveries where status in ('pending','failed') and next_attempt_at <= ?1 limit 200")
        .bind(now.toISOString())
        .all<{ tenant_id: string }>()
    ).results ?? [];
  let retried = 0;
  for (const d of due) retried += Object.values(await retryDueDeliveries(env, d.tenant_id, now.toISOString())).reduce((a, b) => a + b, 0);
  // Metering -> billing: once a month has closed, roll its usage counters into billing_events (idempotent via external_ref).
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const toRoll =
    (
      await env.DB.prepare(
        "select distinct u.tenant_id from usage_counters u where u.period = ?1 and not exists (select 1 from billing_events b where b.tenant_id = u.tenant_id and b.external_ref like 'usage:' || ?1 || ':%') limit 200",
      )
        .bind(prev)
        .all<{ tenant_id: string }>()
    ).results ?? [];
  let rolledUp = 0;
  for (const t of toRoll) {
    const stmts = await rollupUsageStmts(new TenantDb(env.DB, t.tenant_id), prev);
    if (stmts.length) await env.DB.batch(stmts);
    rolledUp += stmts.length;
  }
  return { republished: rows.length, retried, rolledUp };
}
