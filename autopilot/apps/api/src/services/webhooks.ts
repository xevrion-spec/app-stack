import {
  RETRY_POLICY,
  backoffSeconds,
  isRetryable,
  shouldDisable,
  signPayload,
  SIGNATURE_HEADER,
  validateWebhookUrl,
  type EventEnvelope,
} from "@xevrion/platform";
import type { Env } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { log } from "../lib/log.js";
import { meter } from "./usage.js";

/** Hosts allowed over plain http (development only, e.g. 127.0.0.1). */
export const devHttpHosts = (env: Pick<Env, "WEBHOOK_DEV_HTTP_HOSTS">): string[] =>
  (env.WEBHOOK_DEV_HTTP_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (u, i) => fetch(u, i);
/** Test/chaos hook: replace the outbound HTTP client. */
export const __setWebhookFetcher = (f: Fetcher | null) => {
  fetcher = f ?? ((u, i) => fetch(u, i));
};
let clock: () => number = () => Date.now();
export const __setWebhookClock = (f: (() => number) | null) => {
  clock = f ?? (() => Date.now());
};

export interface EndpointRow {
  id: string;
  url: string;
  secret: string;
  status: string;
  consecutive_failures: number;
  first_failure_at: string | null;
}

/** Create (idempotently) one pending delivery per matching active endpoint. */
export function deliveryStmts(db: TenantDb, endpointIds: string[], eventId: string) {
  return endpointIds.map((eid) =>
    db.stmt(
      "insert or ignore into webhook_deliveries (tenant_id, id, endpoint_id, event_id, status, next_attempt_at) values (?1, ?2, ?3, ?4, 'pending', ?5)",
      newId(),
      eid,
      eventId,
      new Date(clock()).toISOString(),
    ),
  );
}

const webhookBody = (ev: EventEnvelope) =>
  JSON.stringify({ id: ev.id, type: ev.type, version: ev.version, created: ev.occurredAt, tenant: ev.tenantId, data: ev.data });

/**
 * One delivery attempt. Never throws: outcome is recorded on the delivery row and the endpoint health counters.
 * Success = any 2xx within 10 s. Retryable failures get next_attempt_at with jittered backoff; after maxAttempts the
 * delivery is 'dead' (replayable by the user). Sustained failure disables the endpoint.
 */
// eslint-disable-next-line complexity -- known debt (docs/quality.md): split in a follow-up
export async function attemptDelivery(
  db: TenantDb,
  deliveryId: string,
  ev: EventEnvelope,
  ep: EndpointRow,
  rand: () => number = Math.random,
  allowHttpHosts: string[] = [],
): Promise<"succeeded" | "failed" | "dead" | "skipped"> {
  const d = await db.first<{ attempt: number; status: string }>("select attempt, status from webhook_deliveries where tenant_id = ?1 and id = ?2", deliveryId);
  if (!d || d.status === "succeeded" || d.status === "dead") return "skipped";
  if (ep.status !== "active") return "skipped";
  const attempt = d.attempt + 1;
  const body = webhookBody(ev);
  const t0 = clock();
  let status: number | null = null;
  let error: string | null = null;
  // Re-check at send time: the guard may have tightened since the endpoint was saved. A blocked URL is never retried.
  const urlCheck = validateWebhookUrl(ep.url, { allowHttpHosts });
  let blocked = false;
  if (!urlCheck.ok) {
    blocked = true;
    error = `url_blocked: ${urlCheck.reason}`;
  } else
    try {
      const sig = await signPayload(ep.secret, body, Math.floor(t0 / 1000));
      const res = await fetcher(ep.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: sig,
          "autopilot-event-id": ev.id,
          "autopilot-event-type": ev.type,
          "autopilot-delivery-attempt": String(attempt),
          "user-agent": "Autopilot-Webhooks/1",
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
    } catch (e) {
      error = String((e as Error).message ?? e).slice(0, 300);
    }
  const ms = clock() - t0;
  const now = new Date(clock()).toISOString();
  const ok = status !== null && status >= 200 && status < 300;
  await meter(db, "webhook_deliveries");
  if (ok) {
    await db.batch([
      db.stmt(
        "update webhook_deliveries set status = 'succeeded', attempt = ?3, response_status = ?4, error = null, duration_ms = ?5, next_attempt_at = null, updated_at = ?6 where tenant_id = ?1 and id = ?2",
        deliveryId,
        attempt,
        status,
        ms,
        now,
      ),
      db.stmt("update webhook_endpoints set consecutive_failures = 0, first_failure_at = null where tenant_id = ?1 and id = ?2", ep.id),
    ]);
    return "succeeded";
  }
  const dead = blocked || attempt >= RETRY_POLICY.maxAttempts || !isRetryable(status);
  const next = dead ? null : new Date(clock() + backoffSeconds(attempt, rand) * 1000).toISOString();
  const failures = ep.consecutive_failures + 1;
  const firstFailure = ep.first_failure_at ?? now;
  const disable = shouldDisable(failures, firstFailure, now);
  await db.batch([
    db.stmt(
      "update webhook_deliveries set status = ?3, attempt = ?4, response_status = ?5, error = ?6, duration_ms = ?7, next_attempt_at = ?8, updated_at = ?9 where tenant_id = ?1 and id = ?2",
      deliveryId,
      dead ? "dead" : "failed",
      attempt,
      status,
      error ?? (status ? `HTTP ${status}` : "error"),
      ms,
      next,
      now,
    ),
    db.stmt(
      "update webhook_endpoints set consecutive_failures = ?3, first_failure_at = ?4, status = ?5, disabled_reason = ?6 where tenant_id = ?1 and id = ?2",
      ep.id,
      failures,
      firstFailure,
      disable ? "disabled" : "active",
      disable ? `auto-disabled after ${failures} consecutive failures` : null,
    ),
  ]);
  ep.consecutive_failures = failures;
  ep.first_failure_at = firstFailure;
  if (disable) {
    ep.status = "disabled";
    log("warn", "webhook.auto_disabled", { tenant: db.tenantId, endpoint: ep.id, failures });
  }
  return dead ? "dead" : "failed";
}
