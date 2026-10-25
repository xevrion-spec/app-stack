# ADR 0010: Domain events via a transactional outbox
Status: accepted (2026-10-25)

Every state change that matters to integrations writes an `events` row in the **same D1 batch** as the change (and its audit row). After commit the Worker enqueues `{ kind: "events", eventIds }`; the queue consumer fans out to webhooks, automations and the realtime Durable Object, then marks `dispatched_at`. A cron sweep republishes undispatched events older than 60 s.
Why: D1 has no cross-service transactions, and "write then publish" loses events on crashes. The outbox gives at-least-once publication; consumers are idempotent (unique `(endpoint_id, event_id)` deliveries, unique `(automation_id, event_id)` runs, `action_executions` keys).
Trade-offs: events are also the activity source, so the table grows; retention/archival to R2 is future work. Ordering is per-tenant best effort (created_at, id), not strict.
