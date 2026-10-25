# ADR 0028: Practice ops: metering, indexes, backup drill, CSP (M6)

Status: accepted (2026-10-25)

## Decision
- **Metering.** `practice_usage(practice_id, period, metric)` is updated by one atomic `insert … select … where n <= cap on conflict do update … where count + n <= cap`. If no row changes, the cap has been reached and the API returns `429 quota_exceeded`. Concurrent callers therefore can't overshoot the cap. Metered actions: assistant questions, integration syncs, portal uploads and working papers. `GET /v1/practice/usage` reports usage to any staff role. **Caps are placeholders: no plans or prices exist, and nothing is billed.**
- **Indexes (migration 0015, additive only).** `document_requests(practice_id,status,due_date)`, `practice_rules(practice_id,status,scope)`, `portal_users(practice_id,tenant_id)`, `engagements(practice_id,status)` and `client_assignments(practice_id,tenant_id,role)`. `EXPLAIN QUERY PLAN` checks in `practice-ops.test.ts` confirm they are used.
- **Backup drill.** This is an automated test, run on every CI build. It takes an online sqlite backup, opens the copy read-only, runs `integrity_check`, compares a per-table row count and sha256 against the live database, re-verifies the practice audit hash chain on the restored copy, and checks that tampering is detected.
- **CSP.** `'unsafe-inline'` is removed from `style-src`. Also added: `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` and `img-src 'self' data:`. No inline script or style exists, so no nonce is needed. A test enforces this.
- **Importer mutation score.** A scoped Stryker run (`stryker.importers.config.mjs`) went from 66.7% to 93.2%.

## Limits (honest)
- The perf test uses 25 API-created clients (the trial cap) plus bulk-inserted transactions: 2k by default, 250k with `PERF=1`. It is **not** a 500-client production load test. No test has run against real D1 or Workers.
- The drill runs against the sqlite test harness, not Cloudflare D1 Time Travel. The D1 restore is still the manual runbook step in `disaster-recovery.md`, and nobody has rehearsed it against a live database.
