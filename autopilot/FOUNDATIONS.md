# Xevrion Autopilot Back Office: Foundations

*Built 25 Oct 2026 (UK time). Xevrion is a trading name of Henry Davenhall, sole trader. Nothing here is tax or legal advice.*

**Product:** an autopilot back office for UK sole traders and micro-businesses. AI handles bookkeeping, invoicing, VAT and Self Assessment preparation end to end, and a human reviews only the exceptions.

## Status: built vs live vs local
| Piece | State | Where |
|---|---|---|
| API Worker `autopilot-api` (Hono, security headers, KV rate limit, queue consumer) | **LIVE**, behind your existing Cloudflare Access | https://api.xevrion.co.uk (`/health`, `/v1/*`) |
| Web Worker `autopilot-web` (landing, exceptions review placeholder, docs, status) | **LIVE**, behind Access | https://app.xevrion.co.uk, https://docs.xevrion.co.uk/docs.html, https://status.xevrion.co.uk/status.html |
| D1 `autopilot-db` (12 tables, migration 0001 applied) | LIVE | id 1f882884-8f22-4b89-ac01-438a5b2c6f47 |
| R2 `autopilot-documents` (private, no public access) | LIVE | |
| Queues `autopilot-pipeline` + `autopilot-pipeline-dlq` | LIVE (consumer = autopilot-api) | |
| KV `autopilot-config` | LIVE | id cdf2a12ce4644bce9d9f6a366da05a9a |
| console.xevrion.co.uk | **Not created on purpose**: the console stays local-only (http://localhost:8765/console) | |
| Monorepo skeleton | Pushed to branch `foundation/autopilot-backoffice` | `repo/autopilot/` |
| Temporal worker + workflow | LOCAL, tested (lightweight Temporal dev server, no Docker) | `local/temporal_worker.py --once` |
| Demo job (synthetic data) → ledger + draft VAT + QA score | LOCAL, tested, traced in Langfuse | `local/demo_job.py` |
| Dify categorise step | LOCAL, working (Agent app, streaming) | |
| Crawl4AI research hook (gov.uk) | LOCAL, working | `local/research.py` |
| Daytona sandboxed parsing | **DONE**: guarded client `packages/sandbox` (concurrency 1, 20/day cap, no network, ephemeral, auto-delete, janitor); mocked tests in CI; live smoke + demo passed; 0 sandboxes left | `docs/sandbox.md` |
| Evals gate | LOCAL accuracy 1.000 (gate 0.8); CI runs offline at gate 0.6 | `evals/run_evals.py` |
| CI (lint/typecheck/test/evals) | Workflow pushed; deploy workflow is manual only and needs GitHub secrets | `.github/workflows/autopilot-*.yml` |
| Loops | Template specs only, nothing sent | `local/loops_templates/README.md` |
| Postiz | Untouched, nothing posted | |
| Coolify | Not used yet; the Temporal worker will move there when there's a host | |
| Kapa | Console check fixed (project ID now valid, 1 integration). The docs assistant comes once docs content exists | |

Existing Cloudflare items (xevrion-websites, xevrion-agent, app-stack on the apex, Access apps, DNS, email routing) were **not modified**.

Full status matrix: `docs/foundations-audit.md` (A-Z audit, 25 Oct 2026).

## What you need to do yourself
- [ ] Register with the ICO and pay the data protection fee, as Henry Davenhall t/a Xevrion (costs money)
- [ ] Open a separate business bank account
- [ ] Get professional indemnity and cyber insurance quotes, and ask whether HMRC AML supervision applies
- [ ] Apply on the HMRC Developer Hub: create a sandbox app and subscribe to the MTD VAT and ITSA APIs
- [ ] Choose an Open Banking (AIS) provider: TrueLayer / Yapily / GoCardless Bank Account Data / Plaid
- [ ] Have a professional review the terms, privacy notice and customer DPA
- [ ] Have an accountant verify every rate and rule in `packages/domain-uk-tax` (all marked unverified)
- [ ] Add GitHub repo secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID before using the deploy workflow
- [ ] Add a WAF rate-limit rule (or Zone WAF edit scope on the token)
- [ ] Create the 4 Loops transactional templates in the Loops UI
- [ ] Add a Coolify server (VPS, costs money) to host the Temporal worker
- [ ] Decide whether app/docs/status should become public (currently behind your existing Access policy)

## Next build steps
1. Customer auth (Access for staff, OIDC/magic link for customers) and real tenant scoping on `/v1`
2. Worker → Temporal bridge: the queue consumer calls the worker's HTTP endpoint, and the worker writes results back to D1
3. Receipt OCR/extraction (vision model via FreeLLMAPI) in a sandbox
4. Exceptions review UI with approve / correct; every correction becomes a golden eval case
5. HMRC MTD VAT sandbox integration (OAuth + fraud prevention headers)
6. Open Banking provider integration (read-only)
7. Billing per outcome (billing_events → Stripe, needs approval)

## Run it
```powershell
cd C:\Users\henry\app-stack\repo\autopilot
local\.venv\Scripts\python.exe local\demo_job.py
local\.venv\Scripts\python.exe local\temporal_worker.py --once
local\.venv\Scripts\python.exe evals\run_evals.py
```
Console: `.\start.ps1 console up`, then the green **Foundations** button (or /console/foundations).
