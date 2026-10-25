# Autopilot TODO (resume point)
Branch: feature/value-max (from feature/quality-1000). Roadmap + status: docs/value-roadmap.md. Constraints: synthetic data, no deploys, no emails/posts, no secrets, no PR, never main.

## Done (this commit)
- A: 1,612 tests (unit/property/integration/RTL/chaos/migration/perf 10k); coverage 93.9/86.0 gated 90/85; Stryker 89.3% (break 70);
  knip, madge, licence allow-list, prod npm audit, gitleaks, ESLint complexity, bundle budget, Lighthouse CI config, load script; split CI jobs.
- B/C: events outbox + catalog, signed webhooks (retries/jitter/DLQ/replay/auto-disable/SSRF incl. send-time re-check), automations engine,
  inbound triggers, scoped hashed API keys, ETags/412/409, bulk, soft delete, FTS search, rate-limit + deprecation headers, realtime DO.
- D: docs/platform.md, docs/quality.md, ADRs 0010-0014, examples/, usage→billing_events rollup in cron sweep.
- Upgrades: zod 4 + @hono/zod-openapi 1.x (fixes high advisory), vitest 4, vite 7, wrangler 4.152, undici override.

## V1/V2 (books library) — done
- packages/books: OFX/QIF/MT940/CSV importers, Xero/QuickBooks/FreshBooks imports, duplicates, recurring, learning rules,
  P&L/balance sheet/cash flow/tax summary, cash forecast + runway, mileage/home-office/AIA calculators, tax-pot estimate,
  SA/VAT/MTD deadline calendar. 91 tests (unit/property/golden); Stryker on tax/calculators/duplicates 92.1%.
- Fixed: income-tax bands now on taxable income (basic band width was too wide); FITID duplicate match no longer requires same amount.
- Rates: packages/domain-uk-tax/uk-rates.unverified.json (verified:false). ADR 0015, docs/books.md.
- Books API (/v1/books): importers, learned rules (corrections captured on PATCH), recurring, forecast, spikes, reports,
  calculators, tax estimate, deadlines, mileage log. Migration 0005 (+down). ADR 0016. OpenAPI + SDK regenerated. 15 API tests.
- V3 invoicing: partial payments, credit notes, aged debtors, reminders (events only, no backlog), recurring invoices,
  payment-link + FX provider interfaces with mock adapters + contract tests. Migration 0006, ADR 0017, 4 new event types.
  Note: cron wiring for recurring/reminder runs is not done yet (endpoints exist; sweep is cross-tenant and needs care).
- V4: DocumentExtractor (TextReceiptExtractor + mock), MtdGateway (mock only; preview + confirm-gated submit, sandbox rows),
  BankFeed (mock, contract-tested). Migration 0007, ADR 0018. Image OCR / LLM-vision adapter not done (needs provider choice).
- V5: accountant role + four-eyes period close (locks period), comments + @mentions, notifications centre + prefs,
  memberships (multi-business), plan entitlements + seats, GDPR (DSAR, erasure w/ retention holds, consents, export).
  Migration 0008, ADR 0019/0020. Not done: web UI for these, document vault retention job, cost model.
- Mutation: scoped run (stryker.books.config.mjs) on invoicing/spikes/assistant/providers = 88.02% (providers 68% → 97% after hardening tests). Full nightly config not re-run here (~2.5 h+ on the box); last full score 89.3%.
- V7b web: command palette, dark/light/system theme, i18n scaffold (en-GB + pseudo), screens for onboarding, receivables, reports, assistant, team/close, bank feeds, privacy, ops; RTL + Playwright/axe (19 e2e). ADR 0023. Fixed: reviewers could not see onboarding; reviewers can now read aged debtors.
- V7a: daily scheduler (recurring drafts, reminder events, retention dry-run), MockOcr + /extract/documents/{id}, bank-feed routes (mock), ops summary + operator overview, migration 0009, ADR 0022, cost-model.md, slo.md.
- Flaky API test found (1 in 25 runs): consent 'latest wins' ordered by random UUID within the same second; fixed with rowid ordering + deterministic regression test.
- Done: V4 extraction/MTD mock, V5 accountant/GDPR/notifications/plans, V6 grounded assistant + onboarding (ADR 0021). Next: V7 web/admin/SLOs; cron wiring for recurring invoices/reminders; V5 web UI.

- Fixed flaky property test: merchantKey was not idempotent ("SO0"); fixed root cause (strip non-letters before noise words).
- CI: licence gate failed under npm 10 (extraneous @img/sharp-wasm32 listed); script now skips extraneous. gitleaks clean on full history.

## Remaining
(done on feature/value-max M0: Playwright 10/10 after upgrades; Lighthouse 100 perf / 100 a11y / 96 best practices on all pages; mutation ledger 91.9, webhooks 93.0)
4. Pay down complexity waivers (docs/quality.md list), starting with pipeline runStages.
5. Regex category rules run on normalised text (literal `\.` never matches) — decide: also match raw description.
6. JWT tamper table test; SDK/workflows DLQ extra tests.
7. Notion: Change Log, MVP build status, Decisions (needs a Notion run).
