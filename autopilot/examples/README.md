# Examples (local, synthetic data only)
- `verify-webhook.mjs` — receiver that verifies `Autopilot-Signature` (the same algorithm is unit-tested in `packages/platform`).
- `api-key-client.mjs` — paginate transactions with a scoped key and create an automation from a template.
Run `npm run local -- --api-only` first. Local webhooks to `http://127.0.0.1` are allowed only in development (`WEBHOOK_DEV_HTTP_HOSTS`).
