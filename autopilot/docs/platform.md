# Platform: API conventions, events, webhooks, automations

All of this runs on the existing Worker (D1 + Queues + KV + one Durable Object). Nothing here sends email or posts anywhere.

## REST conventions (every `/v1` list and resource)
| Concern | Contract |
|---|---|
| Pagination | `?limit=1..200` + opaque `cursor`; response `{ items, nextCursor }`. Keyset on `(created_at,id)` by default; custom sorts use an offset cursor bound to the sort. |
| Filtering / sorting / sparse fields | e.g. `GET /v1/transactions?status=needs_review&min_amount=-5000&q=adobe&tag=travel&sort=-amount_pence,txn_date&fields=id,amount_pence`. Unknown sort/field names are 400s (allow-listed; `__proto__` and friends rejected). |
| Search | `GET /v1/search?q=` over transactions, invoices and exceptions (SQLite FTS5, triggers keep it in sync; prefix matching, safe tokenisation). |
| ETags / concurrency | Resources return a weak `ETag` (`W/"<version>"`). `If-None-Match` → 304. `If-Match` on PATCH/PUT/DELETE → 412 `precondition_failed` on mismatch; body `version` mismatch → 409 `version_conflict`. |
| Idempotency | `Idempotency-Key` on every POST/PATCH/DELETE: same key + same body replays the stored response; same key + different body → 409. |
| Bulk | `POST /v1/transactions/bulk-categorise` (≤200 items) → partial success: per-item `{ id, ok, error? }` results; one bad item never fails the batch. |
| Soft delete | `DELETE` sets `deleted_at` (hidden from lists), `POST …/restore` undoes it. Invoices and automations. |
| Errors | Always `{ error: { code, message, requestId, details? } }` with stable codes (`validation_failed`, `not_found`, `forbidden`, `insufficient_scope`, `conflict`, `version_conflict`, `precondition_failed`, `rate_limited`, `quota_exceeded`, …). |
| Rate limits | `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` on every response; 429 with `Retry-After`. In-isolate token bucket per principal (best effort); Cloudflare WAF rate rules are the hard limit. |
| Versioning | `api-version` response header; deprecated routes return `Deprecation` + `Sunset` + `Link` headers (e.g. `GET /v1/billing/events` → `/v1/usage`, sunset 2027-06-30). |
| Correlation | `x-request-id` accepted (or generated), echoed, and attached to every log line and error envelope. |
| Health | `GET /health` (liveness) and `GET /health/ready` (D1, applied migrations, KV and queue binding; 503 with per-check status and latency when degraded). |

## API keys
`POST /v1/api-keys { name, scopes[] }` returns `ap_live_<prefix>_<secret>` **once**; only `sha256(key)` is stored. Scopes:
`transactions:read|write`, `invoices:read|write`, `reports:read`, `automations:write`, `webhooks:write`, `events:read`.
Keys act as the tenant with exactly those scopes (missing scope → 403 `insufficient_scope`), can be rotated and revoked, record `last_used_at`, and cannot create tenants or manage users/keys.

## Events (versioned catalog)
`GET /v1/events/catalog` lists every type with its version and JSON schema: `transaction.created`, `transaction.categorised`,
`invoice.created`, `invoice.paid`, `exception.opened`, `exception.resolved`, `vat_draft.ready`, `job.completed`, `trigger.received`.
Events are written in the **same D1 batch** as the change that caused them (transactional outbox), then published to the queue.
A cron sweep republishes anything not dispatched within 60 s, so a crash between commit and publish loses nothing.
`GET /v1/events` (cursor, `type=invoice.*` filters), `GET /v1/events/{id}`, `GET /v1/activity` (audit feed), and
`GET /v1/realtime` (SSE via the per-tenant Durable Object, `Last-Event-ID` resume; WebSocket upgrade on the same route).

## Webhooks
- `POST /v1/webhooks { url, events: ["invoice.*"], description }` → returns the signing secret once. HTTPS only; private, loopback,
  link-local, CGNAT, metadata and IPv6 ULA/mapped addresses are rejected (SSRF guard), including decimal/hex/short IPv4 forms.
- Signature: `Autopilot-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`; also `Autopilot-Event-Id`,
  `Autopilot-Event-Type`. During `rotate-secret` both old and new secrets sign (`v1=…,v1=…`) for 24 h.
- Delivery: 10 s timeout, retries on network errors/408/429/5xx with exponential backoff + full jitter (30 s base, 6 h cap, 8 attempts),
  then `dead`. Endpoints auto-disable after 20 consecutive failures spanning 72 h. Full delivery log (status, attempt, response status, error, latency, next attempt); `POST …/deliveries/{id}/replay` and `POST …/test`.
- Each event is delivered at most once per endpoint (unique `(endpoint_id, event_id)`), even with duplicate queue messages.

Verify in Node (see `examples/verify-webhook.mjs`):
```js
import { createHmac, timingSafeEqual } from "node:crypto";
const [t, ...sigs] = header.split(",").map((p) => p.split("="));
const expected = createHmac("sha256", secret).update(`${t[1]}.${rawBody}`).digest("hex");
const ok = Math.abs(Date.now() / 1000 - Number(t[1])) < 300 && sigs.some(([k, v]) => k === "v1" && timingSafeEqual(Buffer.from(v), Buffer.from(expected)));
```

## Automations (rules engine)
Definition (zod-validated JSON; `POST /v1/automations`, `PUT` to edit with `If-Match`/version checks, soft delete/restore):
```json
{ "name": "Categorise Adobe", "trigger": { "event": "transaction.created" },
  "conditions": [{ "op": "contains", "path": "data.description", "value": "ADOBE" }],
  "actions": [{ "type": "categorise_transaction", "categoryCode": "6200", "vatRateCode": "STD" }],
  "maxRunsPerHour": 500 }
```
Operators: `eq neq gt gte lt lte contains in exists` over dot paths (`data.*`, `event.type`, `event.actor`).
Actions: `categorise_transaction`, `tag_transaction`, `open_exception`, `emit_notification` (an event only — **no email**).
- `POST /v1/automations/{id}/dry-run { eventId | sample: { type, data } }` shows the plan without side effects.
- Every evaluation is logged (`GET …/runs`): matched / skipped (`conditions_false`, `rate_capped`, `loop_detected`, `disabled`) and per-action results.
- Actions are idempotent (`automationId:eventId:index` in `action_executions`), so retries never double-apply.
- Loop protection: causation chains; an automation stops after 3 self-caused hops or any chain of depth 10. Re-categorising on
  `transaction.categorised` requires a condition. Per-automation hourly rate caps.
- Templates: `GET /v1/automations/templates`, `POST /v1/automations/from-template`.

## Inbound triggers
`POST /v1/triggers` creates a signed inbound URL (`/hooks/inbound/{id}`) and secret. Callers sign exactly like outbound webhooks;
valid calls become `trigger.received` events (≤16 KB JSON, 5-minute timestamp tolerance), which automations can use.

## Quotas, metering and flags
Imported transactions, automation runs and webhook deliveries are metered per tenant per month (`GET /v1/usage`). Plan quotas
return 429 `quota_exceeded` (enforced on CSV import before anything is written). When a month closes, the cron sweep rolls counters into `billing_events` exactly once
(`external_ref = usage:<period>:<metric>`). No billing provider is called. Feature flags live in KV (`GET /v1/flags`), with
per-tenant overrides, deterministic percentage rollouts by tenant hash, and fail-safe (all off) on bad JSON.
