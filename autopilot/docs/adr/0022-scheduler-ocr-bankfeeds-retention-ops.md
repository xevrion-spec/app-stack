# ADR 0022: Daily scheduler, OCR interface, bank-feed routes, document retention, ops console

Status: Accepted (2026-10-25)

## Decisions
- **Daily scheduler** (`services/schedules.ts`): the existing every-minute cron calls `maybeRunDaily`, which runs once per UTC day after 06:00 (KV gate) and, per tenant, the jobs `recurring_invoices` (plan feature), `invoice_reminders` (outbox **events only**, no email) and `document_retention`. Each (tenant, job, date) is claimed in `scheduler_runs` (unique key), so overlaps/retries never double-run; failures are isolated and recorded per tenant and job. Cross-tenant discovery reads tenant ids and plan only.
- **Document retention**: report-only (dry run, 7-year cutoff) unless `DOCUMENT_RETENTION_DAYS` (≥ 365) is set. Enforce mode deletes the stored file and sets `documents.purged_at`; the row stays as a tombstone because transactions reference it. Retention periods are UNVERIFIED.
- **OCR**: `ImageOcr` interface + `MockOcr` only (returns an embedded `SYNTHETIC-RECEIPT` block or empty/zero confidence, never guesses). `POST /v1/extract/documents/{id}` runs OCR → `TextReceiptExtractor`, stores the result for review.
- **Bank feeds**: `/v1/bank-feeds/*` (owner, `imports_advanced`) over `BankFeed`; only `MockBankFeed`. Sync is incremental (first window 90 days) and de-duplicated by provider transaction id.
- **Ops console**: `/v1/ops/summary` (tenant health) and `/v1/admin/overview` (operators in `ADMIN_EMAILS`, cross-tenant counts only, no PII, no impersonation, no writes).

## Consequences
Recurring drafts and reminder events now happen without anyone pressing a button, still with no external sends. Real OCR, Open Banking and retention enforcement each need Henry's provider choice / sign-off.
