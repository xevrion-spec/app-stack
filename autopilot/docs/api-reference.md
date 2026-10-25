# API reference

Generated from `openapi/openapi.json` (source of truth: zod schemas in `apps/api/src`). Regenerate with `npm run openapi && npm run docs:api`.

Auth: Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`). Local dev only: `x-dev-user: <email>`. Optional `x-tenant-id` selects a tenant; `Idempotency-Key` makes unsafe requests replay-safe. Errors: `{ error: { code, message, requestId, details? } }`.

| Method | Path | Summary | Tag |
|---|---|---|---|
| POST | `/v1/tenants` | Create a tenant (caller becomes owner) with default chart of accounts | Account |
| GET | `/v1/me` | Current principal | Account |
| GET | `/v1/tenant` | Current tenant | Account |
| PATCH | `/v1/tenant` | Update VAT settings | Account |
| GET | `/v1/users` | List users | Account |
| POST | `/v1/users` | Add a user | Account |
| POST | `/v1/uploads/bank-csv` | Upload a bank statement CSV (creates a job and queues the pipeline) | Ingestion |
| POST | `/v1/uploads/receipt` | Upload a receipt (PDF/image). Optional x-receipt-* headers carry known totals until OCR lands. | Ingestion |
| GET | `/v1/transactions` | List transactions | Transactions |
| PATCH | `/v1/transactions/{id}` | Manually categorise (posts reversing + new journal) | Transactions |
| GET | `/v1/categories` | Chart of accounts | Categories |
| POST | `/v1/categories` | Add a category | Categories |
| GET | `/v1/rules` | Categorisation rules | Categories |
| POST | `/v1/rules` | Add a rule | Categories |
| GET | `/v1/ledger/trial-balance` | Trial balance (must net to zero) | Ledger |
| GET | `/v1/ledger/journals` | Journals | Ledger |
| GET | `/v1/invoices` | List invoices | Invoices |
| POST | `/v1/invoices` | Create a draft invoice (sequential numbering) | Invoices |
| POST | `/v1/invoices/{id}/status` | Change status (draft→sent→paid, or void). Does not email anyone. | Invoices |
| GET | `/v1/invoices/{id}/pdf` | Render the invoice as PDF (A4, pdf-lib) | Invoices |
| POST | `/v1/vat/drafts` | Compute and store a DRAFT VAT return (unverified rates, never submitted) | VAT |
| GET | `/v1/vat/drafts` | List VAT drafts | VAT |
| GET | `/v1/sa/summary` | DRAFT self-employment summary | Self Assessment |
| GET | `/v1/exceptions` | Exceptions queue | Review |
| POST | `/v1/exceptions/{id}/resolve` | Approve, override (re-categorise) or dismiss an exception | Review |
| GET | `/v1/jobs` | Jobs | Jobs |
| GET | `/v1/jobs/{id}` | Job with event timeline | Jobs |
| POST | `/v1/jobs/{id}/rerun` | Re-queue a job (idempotent stages) | Jobs |
| GET | `/v1/billing/events` | Outcome/billing events | Billing |
| GET | `/v1/export/transactions.csv` | Transactions as CSV | Export |
| GET | `/v1/export/ledger.json` | Journals with lines as JSON | Export |
| GET | `/v1/events/catalog` | Versioned event catalog | Events |
| GET | `/v1/events` | Event log (newest first); filter by type or entity.* | Events |
| GET | `/v1/events/{id}` | One event | Events |
| GET | `/v1/activity` | Audit timeline (who did what, newest first) | Events |
| POST | `/v1/webhooks` | Create endpoint (secret returned once) | Webhooks |
| GET | `/v1/webhooks` | List endpoints | Webhooks |
| GET | `/v1/webhooks/{id}` | Get endpoint | Webhooks |
| PATCH | `/v1/webhooks/{id}` | Update endpoint (optimistic concurrency via version) | Webhooks |
| DELETE | `/v1/webhooks/{id}` | Delete endpoint (soft) | Webhooks |
| POST | `/v1/webhooks/{id}/rotate-secret` | Rotate signing secret (old one valid for 24h) | Webhooks |
| GET | `/v1/webhooks/{id}/deliveries` | Delivery log | Webhooks |
| POST | `/v1/webhooks/{id}/deliveries/{deliveryId}/replay` | Replay a delivery now | Webhooks |
| POST | `/v1/webhooks/{id}/test` | Send a signed test ping to this endpoint | Webhooks |
| GET | `/v1/automations/templates` | Starter templates | Automations |
| POST | `/v1/automations` | Create automation (JSON definition) | Automations |
| GET | `/v1/automations` | List automations | Automations |
| POST | `/v1/automations/from-template` | Create from a template | Automations |
| GET | `/v1/automations/{id}` | Get automation | Automations |
| PUT | `/v1/automations/{id}` | Replace definition (requires current version) | Automations |
| DELETE | `/v1/automations/{id}` | Soft-delete | Automations |
| POST | `/v1/automations/{id}/restore` | Restore a soft-deleted automation | Automations |
| POST | `/v1/automations/{id}/dry-run` | Test an automation against a stored event or a sample payload (no side effects) | Automations |
| GET | `/v1/automations/{id}/runs` | Run history | Automations |
| POST | `/v1/api-keys` | Create a scoped API key (shown once) | API keys |
| GET | `/v1/api-keys` | List keys (never returns secrets) | API keys |
| POST | `/v1/api-keys/{id}/rotate` | Rotate: new key now, old key valid 24h | API keys |
| DELETE | `/v1/api-keys/{id}` | Revoke immediately | API keys |
| POST | `/v1/triggers` | Create an inbound webhook trigger (secret shown once) | Automations |
| GET | `/v1/triggers` | List inbound triggers | Automations |
| DELETE | `/v1/triggers/{id}` | Revoke trigger | Automations |
| GET | `/v1/search` | Full-text search over transactions and invoices | Search |
| POST | `/v1/transactions/bulk-categorise` | Categorise up to 200 transactions; partial success, per-item results | Transactions |
| GET | `/v1/invoices/{id}` | Get invoice (ETag; send If-None-Match for 304) | Invoices |
| PATCH | `/v1/invoices/{id}` | Edit a draft invoice (If-Match or version required) | Invoices |
| DELETE | `/v1/invoices/{id}` | Soft-delete a draft or void invoice | Invoices |
| POST | `/v1/invoices/{id}/restore` | Restore a soft-deleted invoice | Invoices |
| GET | `/v1/usage` | This month's metered usage vs plan quota | Billing |
| GET | `/v1/flags` | Feature flags effective for this tenant | Account |
| GET | `/v1/realtime` | Live event stream (SSE, or WebSocket with Upgrade); ?types=transaction.* | Events |
