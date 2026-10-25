# Value roadmap (UK sole traders and micro-businesses)

Scoring: **Value** to the customer (1–5), **Effort** (S/M/L), **Risk** (L/M/H: tax-correctness, security, external dependency).
Status: ✅ built and tested · 🟡 interface + mock adapter (needs a provider or Henry's decision) · ⏳ planned · ⛔ blocked on a decision.
Principles: synthetic data only; tax rates/rules are config-driven and **UNVERIFIED** until checked on gov.uk with an accountant;
nothing sends email, posts, submits to HMRC or connects to a bank. External providers get an interface, a mock adapter and contract tests.

| # | Item | Value | Effort | Risk | Status | Milestone |
|---|---|---|---|---|---|---|
| 1 | Bank statement importers: CSV (existing), OFX, QIF, MT940 + auto-detect | 5 | M | L | ✅ lib + API | V1 |
| 2 | Import from Xero / QuickBooks / FreshBooks CSV exports | 4 | S | L | ✅ lib + API | V1 |
| 3 | Duplicate detection (cross-file, fuzzy date/amount/description) | 5 | S | L | ✅ lib + API | V1 |
| 4 | Recurring transaction detection (subscriptions, rent, DDs) with next-expected date | 4 | M | L | ✅ lib + API | V1 |
| 5 | Categorisation that learns from corrections (per-tenant rules, confidence, decay) | 5 | M | M | ✅ lib + API | V1 |
| 6 | Anomaly detection (existing) + spend spikes vs baseline | 3 | S | L | ✅ lib + API | V1 |
| 7 | Reports: P&L, balance sheet, cash flow, tax summary | 5 | M | M | ✅ lib + API | V2 |
| 8 | Cash-flow forecast and cash runway (from recurring + history) | 5 | M | M | ✅ lib + API | V2 |
| 9 | Calculators: mileage, home office (simplified flat rate vs proportion), simplified expenses | 4 | S | M | ✅ lib + API | V2 |
| 10 | Capital allowances (AIA estimate) and tax-pot / set-aside estimate (income tax + Class 4) | 5 | M | H | ✅ lib + API | V2 |
| 11 | SA + VAT deadline calendar, payments on account, reminders as **events** only | 5 | S | M | ✅ lib + API | V2 |
| 12 | Invoicing: credit notes, partial payments, recurring invoices, overdue reminders as events | 5 | M | L | ✅ (aged debtors too) | V3 |
| 13 | Payment links (interface + mock provider), multi-currency invoices with an FX-rates interface (ECB-style mock) | 4 | M | M | ✅ interfaces + mock adapters + contract tests | V3 |
| 14 | MTD-ready data model (obligations, quarterly updates, submissions) + HMRC adapter interface + **mock** HMRC | 5 | L | H | ✅ mock gateway + confirm-gated API | V4 |
| 15 | Receipt/invoice OCR & extraction: pluggable extractor (LLM-vision via FreeLLMAPI if supported, deterministic text parser, mock) | 5 | M | M | ✅ deterministic text extractor + mock + contract tests (no image OCR) | V4 |
| 16 | Bank feed abstraction (Open Banking provider interface + mock; no live provider) | 4 | M | H | 🟡 interface + mock + contract tests (no routes) | V4 |
| 17 | Accountant/bookkeeper role, comments on any record, approval workflow (period close sign-off) | 4 | M | M | ⏳ | V5 |
| 18 | Multi-business (one user, several tenants; switcher) | 3 | S | M | ⏳ | V5 |
| 19 | Document vault with retention policy; UK GDPR DSAR export, erasure (with statutory-retention holds), consent log, audit export | 4 | M | H | ⏳ | V5 |
| 20 | In-app notifications centre (from events; read/unread; preferences) | 4 | S | L | ⏳ | V5 |
| 21 | Plans and entitlements (feature gates + quotas per plan) | 3 | S | L | ⏳ | V5 |
| 22 | “Ask your books” assistant grounded in the ledger with citations (tools over reports; LLM via Dify/FreeLLMAPI; deterministic fallback) | 5 | M | M | ⏳ | V6 |
| 23 | Onboarding checklist and sample-data mode | 4 | S | L | ⏳ | V6 |
| 24 | Web: command palette, keyboard shortcuts, dark mode, i18n scaffold, accessibility polish | 3 | M | L | ⏳ | V7 |
| 25 | Web: webhooks / API keys / automations UI; public API docs page | 3 | M | L | ⏳ | V7 |
| 26 | Admin/ops console (tenants, jobs, DLQ, webhook health, usage) | 3 | M | M | ⏳ | V7 |
| 27 | Per-tenant usage and cost metering (existing counters + cost model) | 3 | S | L | ⏳ | V5 |
| 28 | SLOs and error budgets (doc + burn-rate maths + health metrics) | 3 | S | L | ⏳ | V7 |
| 29 | Search (existing FTS) across all entities | 3 | S | L | ✅ (transactions, invoices, exceptions) | — |
| 30 | Webhooks, automations, API keys, realtime | 4 | — | — | ✅ | quality-1000 |

## Decisions needed from Henry (not automatable)
- Verify every rate and threshold in `packages/domain-uk-tax/uk-rates.unverified.json` with an accountant, then mark verified.
- HMRC Developer Hub app + fraud-prevention headers before any real MTD submission (mock only until then).
- Choose Open Banking (e.g. TrueLayer/GoCardless/Yapily) and payment-link providers; contracts/costs are yours to approve.
- Whether FreeLLMAPI exposes a vision model for receipts; otherwise the text extractor + mock is the default.
