# ADR 0013: Realtime via one Durable Object per tenant
Status: accepted (2026-10-25)

`GET /v1/realtime` is proxied (after auth) to the tenant's `TenantRealtime` DO, which serves SSE (or WebSocket on Upgrade) with `types=` filters and a bounded ring buffer for `Last-Event-ID` replay. The queue consumer POSTs dispatched events to the DO. Fan-out logic lives in a plain `Hub` class so it is unit-tested without the runtime.
Why: DOs give a single, strongly consistent coordination point per tenant with no extra infrastructure. Trade-off: the ring buffer is in memory, so after DO eviction clients must re-sync from `GET /v1/events?cursor=` (documented).
