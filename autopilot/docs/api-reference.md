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
