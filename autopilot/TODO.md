# Autopilot TODO (resume point)

Current branch: feature/practice-copilot (from feature/harden). Goal: UK accountant/bookkeeper co-pilot. Push only, no PR, never main.

## Practice co-pilot milestones

- [x] M1 firm model: practices, staff roles, clients, assignments, isolation, dashboards (health/workload/review ageing/deadlines/WIP), bulk preview+confirm. ADR 0024.
- [x] M2 workflow: review queue + SLA + claims, bulk approve with thresholds, auto-approve rules (floor 0.9), QA sampling, close checklists + templates, client queries, task templates, time, billing records, per-client bank CSV import.
      Tests: practice-api (24), practice-lib (7), books practice (15), practice-authz-matrix (44). Full suite 2,362 passed / 1 skipped; coverage 96.32/88.3.
- [x] M3 onboarding/engagement (ADR 0025, migration 0013): engagement letters (hash frozen; client accepts by hash), authorisation records (data only, masked refs), document requests + templates, client portal (/v1/portal: mock magic link returned to staff → session; queries answer, uploads, engagement accept), per-client audit export JSON/CSV + chain verify, working papers (TB/bank rec/VAT rec) with immutable four-eyes sign-off.
      Tests: practice-onboard (13) + matrix extended (practice ops x roles x other firm, portal ops x anon/staff/api key, cross-client portal). Suite 2,435 passed / 1 skipped; coverage 96.43/88.44.
- [x] M4 intelligence (ADR 0026, migration 0014): firm/client learned rules with provenance (firm-wide needs 2+ clients), suggestions with reason codes, anomalies (duplicate, missing receipt, unusual VAT, round sum, weekend) + audited dismissals, accuracy harness (/practice/eval), drift alerts, practice assistant (rules routing + mock LLM intent router, scoped, cited). Fixed: missing-receipt must ignore bank-statement document_id.
      Tests: books intelligence (19) + practice-intel (5 API) + matrix extended. Suite 2,481 passed / 1 skipped; coverage 96.54/88.31.
- [ ] M5 integrations: Xero/QBO/FreeAgent read adapters (mock) + CSV importers, PM/e-sign interfaces, MTD mock HMRC, Open Banking interface, events, API docs.
- [ ] M6 ops: perf 500×5k, indexes, load, quotas/metering, SLOs, backup drill, ASVS, importers mutation 70+, CSP nonce.
- [ ] M7 web: practice console + client portal screens, axe, Playwright.
- [ ] M8 docs + honest benchmark rescore + Notion.
      Ship: box `bash /tmp/ship.sh "msg"` → CopyFromBox /tmp/ship.tgz → PC apply-ship.ps1.

Previous branch: feature/value-max (from feature/quality-1000). Roadmap + status: docs/value-roadmap.md. Constraints: synthetic data, no deploys, no emails/posts, no secrets, no PR, never main.

## H1 — harden (feature/harden) — done

- Perf: migration 0010 (11 additive indexes, EXPLAIN-verified). Bank sync batched (N+1 removed). CSV export streamed (keyset 2k pages). Ledger export O(n²)→O(n). 100k txns: list p50 46.5→0.9 ms. HTTP load A/B: 468→581 rps, p95 65→48 ms (docs/performance.md).
- Guards: perf-guards.test.ts (N+1 query-count invariance ×7 endpoints, 10k budgets, 100k under PERF=1, per-API-key rate limit, body limit, maintenance freeze, log redaction, dev-auth fail-closed).
- Security: authz-matrix.test.ts (every OpenAPI op × anon/non-member/roles + cross-tenant + leak regex, 159 tests). Global 2 MB/10 MB streaming body limit. Per-API-key buckets. x-dev-user fail-closed. Log redaction. docs/security-checklist.md (ASVS L2 + API Top 10).
- Parsers: importers.fuzz.test.ts (OFX/QIF/MT940/CSV properties + ReDoS budgets); MT940 out-of-range amounts rejected.
- Reliability: MAINTENANCE=1 write freeze; docs/disaster-recovery.md (D1 Time Travel, R2, outbox replay).
- Gates: 2,218 tests; coverage 96.42% stmts / 89.07% branches; Playwright+axe 19 passed / 1 skipped; Lighthouse perf 100, a11y 100, best practices 96, SEO 82; npm audit 0; gitleaks clean; knip/madge clean; web bundle 61.1 KB; Worker 368 KB gzip.
- Mutation: importers.ts first scoped run 66.42% (below 70 break). TODO: kill the dedupe/normalise survivors.
- Benchmark: docs/competitive-benchmark.md — Autopilot today 2.7/10 (17th of 17), 6–12 month potential 6.3 (about 6th). Gating items: HMRC MTD recognition and an FCA-authorised AISP partner.
- TODO: WAF hard rate limit; nightly D1 export to R2 + timed restore drill; external pentest; web CSP without unsafe-inline; SEO 82 (meta description).

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

(done on feature/value-max M0: Playwright 10/10 after upgrades; Lighthouse 100 perf / 100 a11y / 96 best practices on all pages; mutation ledger 91.9, webhooks 93.0) 4. Pay down complexity waivers (docs/quality.md list), starting with pipeline runStages. 5. Regex category rules run on normalised text (literal `\.` never matches) — decide: also match raw description. 6. JWT tamper table test; SDK/workflows DLQ extra tests. 7. Notion: Change Log, MVP build status, Decisions (needs a Notion run).
