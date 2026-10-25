# Quality gates (CI: `.github/workflows/autopilot-ci.yml`)

| Gate | Command | Threshold | Current (2026-10-25) |
|---|---|---|---|
| Types | `npm run typecheck` | strict, 0 errors | 0 |
| Lint + format | `npm run lint` | 0 errors; complexity ≤ 20, max-depth 4, max-params 6, ≤ 150 lines/function | 0 (9 functions carry a documented debt waiver, below) |
| Tests | `npm test` | all pass | see `mvp-status.json` |
| Coverage | `npm run coverage` | lines/statements/functions ≥ 90, branches ≥ 85 | see `mvp-status.json` |
| Mutation | `npm run mutation` | break < 70 (high 85) on ledger, VAT, categoriser, automation engine, webhooks | see `mvp-status.json` |
| Dead code | `npm run knip` | no unused files/exports/deps | clean |
| Cycles | `npm run madge` | no circular imports | clean |
| Licences | `npm run licenses` | allow-list (MIT/ISC/Apache-2.0/BSD/0BSD/…) | 69 prod packages OK |
| Vulnerabilities | `npm run audit:prod` | no high/critical in production deps | 0 |
| Secrets | gitleaks (full history in CI) | no findings | clean |
| Bundle | `npm run bundle:budget` | gzip JS ≤ 80 KB, CSS ≤ 10 KB | JS ≈ 55 KB, CSS ≈ 2 KB |
| Lighthouse | `lhci autorun` | perf ≥ 0.9, a11y ≥ 0.95, best practices ≥ 0.9 | CI only |
| Load | `npm run load` (local API) | read p95 ≤ 250 ms, < 1% 5xx | see report |
| OpenAPI drift | `npm run openapi:check` | spec + SDK committed | clean |

## Complexity debt (waived with `eslint-disable-next-line … -- known debt`)
`createApp` (route wiring), `runStages` (pipeline orchestration, complexity 43), `runAutomation`, `attemptDelivery`, `categoriseTransaction` (7 params),
`reconcile`, `computeVatReturn`, `isPrivateAddress`, and the `Invoices` / `Transactions` page components. Each is covered by tests; splitting them is tracked as follow-up work, and the waiver list must only shrink.

## Known limitations surfaced by tests
- Regex category rules run on the *normalised* description (punctuation removed), so a literal `\.` never matches; write `adobe com` instead.
- The in-isolate rate limiter is per isolate (best effort); Cloudflare WAF rate rules are the real limit.
- Load-test write latency is dominated by the local single-process server running the pipeline inline; production uses Queues.
