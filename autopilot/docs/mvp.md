# MVP: how to run, what works, what does not

## Run locally (no Docker)
```
cd autopilot
npm ci
npm run local          # seeds .local/ (synthetic), API on :8787, web on :5173
# sign in at http://127.0.0.1:5173 as demo.owner@example.test (dev header; production uses Cloudflare Access)
npm run seed           # seed only (idempotent; delete .local/ to reset)
npm test               # unit + property + integration + Temporal workflow tests
npm run coverage       # with thresholds (80% lines / 75% branches)
npm run evals          # golden gate
npm run e2e -w apps/web  # Playwright smoke + axe (starts its own API and web server)
npm run worker -w packages/workflows -- --demo   # Temporal dev server + one synthetic monthly close (needs the local API running)
```

## Works (tested)
- Multi-tenant API with Access auth, roles, isolation guard, idempotency, audit, pagination, OpenAPI + typed SDK.
- Bank CSV ingestion to R2 with checksum, dedupe, limits; receipts upload with known totals.
- Pipeline: rules -> LLM (validated), refunds as contra-expense, outflows never become sales, transfers, FX flagged, reconciliation to receipts, invoices (late payments, quoted numbers) and split payments; anomalies; QA score; billing outcome event.
- Double-entry ledger with reversals; trial balance always balances (tested).
- Invoices with per-tenant numbering, status rules, PDF.
- VAT drafts (standard accrual with invoices, cash, flat rate), SA summary draft; both labelled unverified.
- Review queue, job timeline, CSV/JSON exports.
- Temporal monthly close with human-review signal and timeout.
- Langfuse tracing (summaries only).

## Stubs and gaps
- Receipt OCR/extraction: not built (receipt totals come from headers); Daytona parser exists separately.
- Virus scan is a stub hook (`scanHook`), PDFs are not stored.
- VAT/SA rules and rates are UNVERIFIED placeholders; no MTD/HMRC submission (by design for now).
- No email delivery (invoices are never sent), no billing provider.
- Partial invoice payments, credit notes and multi-currency conversion are not modelled.
- Live Workers are NOT updated with this code until a manual deploy.
