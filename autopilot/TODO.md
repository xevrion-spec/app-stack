# Autopilot TODO (resume point)
Branch: feature/quality-1000. Constraints: synthetic data, no deploys, no emails/posts, no secrets, no PR, never main.

## Done (this commit)
- A: 1,612 tests (unit/property/integration/RTL/chaos/migration/perf 10k); coverage 93.9/86.0 gated 90/85; Stryker 89.3% (break 70);
  knip, madge, licence allow-list, prod npm audit, gitleaks, ESLint complexity, bundle budget, Lighthouse CI config, load script; split CI jobs.
- B/C: events outbox + catalog, signed webhooks (retries/jitter/DLQ/replay/auto-disable/SSRF incl. send-time re-check), automations engine,
  inbound triggers, scoped hashed API keys, ETags/412/409, bulk, soft delete, FTS search, rate-limit + deprecation headers, realtime DO.
- D: docs/platform.md, docs/quality.md, ADRs 0010-0014, examples/, usage→billing_events rollup in cron sweep.
- Upgrades: zod 4 + @hono/zod-openapi 1.x (fixes high advisory), vitest 4, vite 7, wrangler 4.152, undici override.

## Remaining
1. Run Playwright e2e + axe on the PC/CI after the vite 7 / zod 4 upgrades (not re-run this session).
2. Lighthouse CI first run in GitHub Actions; tune thresholds if needed.
3. Raise mutation score on webhooks.ts (80.5) and ledger.ts (84.8) to ≥ 85.
4. Pay down complexity waivers (docs/quality.md list), starting with pipeline runStages.
5. Regex category rules run on normalised text (literal `\.` never matches) — decide: also match raw description.
6. JWT tamper table test; SDK/workflows DLQ extra tests.
7. Notion: Change Log, MVP build status, Decisions (needs a Notion run).
