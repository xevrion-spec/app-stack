/**
 * Agent review delivery (A3): per-request signed callbacks with at-least-once semantics.
 * When a request reaches a final status and has a callbackUrl, the event dispatcher enqueues one callback
 * (unique per request + event type, so re-dispatching an event never duplicates it) and attempts it at once; failures
 * retry with the webhook engine's jittered backoff, and become 'dead' after the max attempts or on a non-retryable
 * status. Dead callbacks can be redelivered. Bodies carry a stable callback id + request version so receivers can dedupe.
 * Signing, SSRF guard, backoff and the HTTP fetcher are the existing webhook primitives.
 */
import { RETRY_POLICY, SIGNATURE_HEADER, backoffSeconds, isRetryable, signPayload, validateWebhookUrl, type EventEnvelope } from "@xevrion/platform";
import type { Env } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { devHttpHosts, webhookFetch, webhookNow } from "./webhooks.js";

export type CallbackRow = {
  id: string;
  request_id: string;
  url: string;
  event_type: string;
  body_json: string;
  attempt: number;
  status: "pending" | "failed" | "succeeded" | "dead";
  response_status: number | null;
  error: string | null;
  duration_ms: number | null;
  next_attempt_at: string | null;
  created_at: string;
  updated_at: string | null;
};
export const CALLBACK_COLS =
  "id, request_id, url, event_type, body_json, attempt, status, response_status, error, duration_ms, next_attempt_at, created_at, updated_at";
const iso = (ms: number) => new Date(ms).toISOString();

/** Enqueue callbacks for review.completed events whose request asked for one. Idempotent (unique request + type). */
async function enqueueCallbacks(db: TenantDb, events: EventEnvelope[]): Promise<string[]> {
  const done = events.filter((e) => e.type === "review.completed");
  const ids: string[] = [];
  for (const ev of done) {
    const data = ev.data as { requestId: string };
    const r = await db.first<{ callback_url: string | null; version: number; decided_at: string | null }>(
      "select callback_url, version, decided_at from review_requests where tenant_id = ?1 and id = ?2",
      data.requestId,
    );
    if (!r?.callback_url) continue;
    const id = newId();
    const body = JSON.stringify({
      id,
      type: ev.type,
      eventId: ev.id,
      created: ev.occurredAt,
      requestVersion: r.version,
      decidedAt: r.decided_at,
      data: ev.data,
    });
    const n = await db.run(
      "insert or ignore into review_callbacks (tenant_id, id, request_id, url, event_type, body_json, status, next_attempt_at, created_at) values (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, ?7)",
      id,
      data.requestId,
      r.callback_url,
      ev.type,
      body,
      iso(webhookNow()),
    );
    if (n) ids.push(id);
  }
  return ids;
}

/** One attempt. Never throws; the outcome is recorded on the row. */
export async function attemptCallback(env: Env, db: TenantDb, id: string, rand: () => number = Math.random): Promise<CallbackRow["status"] | "skipped"> {
  const cb = await db.first<CallbackRow & { secret: string | null }>(
    `select c.id, c.request_id, c.url, c.event_type, c.body_json, c.attempt, c.status, c.response_status, c.error, c.duration_ms, c.next_attempt_at, c.created_at, c.updated_at, p.callback_secret secret
       from review_callbacks c join review_requests r on r.tenant_id = c.tenant_id and r.id = c.request_id join review_projects p on p.tenant_id = r.tenant_id and p.id = r.project_id
      where c.tenant_id = ?1 and c.id = ?2`,
    id,
  );
  if (!cb || cb.status === "succeeded" || cb.status === "dead") return "skipped";
  const attempt = cb.attempt + 1;
  const t0 = webhookNow();
  let status: number | null = null;
  let error: string | null = null;
  let permanent = false;
  const check = validateWebhookUrl(cb.url, { allowHttpHosts: devHttpHosts(env) });
  if (!check.ok) [permanent, error] = [true, `url_blocked: ${check.reason}`];
  else if (!cb.secret) [permanent, error] = [true, "no_callback_secret: rotate the project callback secret"];
  else
    try {
      const res = await webhookFetch(cb.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: await signPayload(cb.secret, cb.body_json, Math.floor(t0 / 1000)),
          "autopilot-callback-id": cb.id,
          "autopilot-review-request-id": cb.request_id,
          "autopilot-delivery-attempt": String(attempt),
          "user-agent": "Autopilot-AgentReview/1",
        },
        body: cb.body_json,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
    } catch (e) {
      error = String((e as Error).message ?? e).slice(0, 300);
    }
  const ok = status !== null && status >= 200 && status < 300;
  const dead = !ok && (permanent || attempt >= RETRY_POLICY.maxAttempts || (status !== null && !isRetryable(status)));
  const next: CallbackRow["status"] = ok ? "succeeded" : dead ? "dead" : "failed";
  await db.run(
    "update review_callbacks set status = ?3, attempt = ?4, response_status = ?5, error = ?6, duration_ms = ?7, next_attempt_at = ?8, updated_at = ?9 where tenant_id = ?1 and id = ?2",
    id,
    next,
    attempt,
    status,
    ok ? null : (error ?? `http_${status}`),
    webhookNow() - t0,
    next === "failed" ? iso(webhookNow() + backoffSeconds(attempt, rand) * 1000) : null,
    iso(webhookNow()),
  );
  return next;
}

/** Called by the event dispatcher (queue consumer) after webhooks: enqueue + first attempt. */
export async function deliverReviewCallbacks(env: Env, db: TenantDb, events: EventEnvelope[], rand?: () => number): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const id of await enqueueCallbacks(db, events)) {
    const r = await attemptCallback(env, db, id, rand);
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

/** Cron: retry due callbacks across tenants (discovery returns ids only; attempts run tenant-scoped). */
export async function retryDueCallbacks(env: Env, at = new Date(), limit = 100, rand?: () => number): Promise<number> {
  const due =
    (
      await env.DB.prepare(
        "select tenant_id, id from review_callbacks where status in ('pending', 'failed') and next_attempt_at <= ?1 order by next_attempt_at limit ?2",
      )
        .bind(at.toISOString(), limit)
        .all<{ tenant_id: string; id: string }>()
    ).results ?? [];
  for (const d of due) await attemptCallback(env, new TenantDb(env.DB, d.tenant_id), d.id, rand);
  return due.length;
}
