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
- Next: API endpoints + migrations (tenant learned rules, recurring, reports, forecast, deadlines), then V3 invoicing.

## Remaining
(done on feature/value-max M0: Playwright 10/10 after upgrades; Lighthouse 100 perf / 100 a11y / 96 best practices on all pages; mutation ledger 91.9, webhooks 93.0)
4. Pay down complexity waivers (docs/quality.md list), starting with pipeline runStages.
5. Regex category rules run on normalised text (literal `\.` never matches) — decide: also match raw description.
6. JWT tamper table test; SDK/workflows DLQ extra tests.
7. Notion: Change Log, MVP build status, Decisions (needs a Notion run).
