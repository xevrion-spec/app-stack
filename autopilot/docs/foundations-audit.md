# Foundations A-Z audit (25 Oct 2026, 01:35 UK time)

Legend: **Done**, **Local only**, **Blocked by Henry**, **Not started**

| Area | Status | Evidence | Next action |
|---|---|---|---|
| Cloudflare resources (D1, R2, Queues+DLQ, KV) | Done | All present via API; D1 migration 0001 applied | none |
| Cloudflare Workers api./app./docs./status. | Done (private) | Custom domains bound; 302 to Access | Henry: decide if app/docs/status go public (Access policy change) |
| Cloudflare Access | Done (existing policy covers new hosts) | Existing Access apps unchanged | Dedicated Access app per host when customer auth lands |
| Security headers | Done | Hono secureHeaders (API) + `_headers` (web) | Verify once public |
| WAF rate-limit rule | Done | http_ratelimit rule: per-IP 30/10s on api./v1/* (Free plan max 1 rule; 2nd upload rule rejected: 'exceeded the maximum number of rules... 2 out of 1') | Stricter upload limit needs a paid plan; KV limiter covers it meanwhile |
| console.xevrion.co.uk | Local only (by design) | localhost:8765/console | none |
| Repo / monorepo | Done | branch foundation/autopilot-backoffice | none |
| CI: lint/typecheck/test/evals | Done | autopilot-ci green | none |
| CI: sandbox mocked tests | Done | autopilot-sandbox-tests workflow | none |
| CI: deploy | Done (armed, manual-only) | Secrets set; workflow_dispatch only; never run | Run manually when ready to redeploy |
| Pipeline (9 stages) | Local only | demo job end to end, QA 0.75, 5 exceptions | Connect queue to worker; real receipt OCR |
| Evals gate | Done | accuracy 1.000 / gate 0.8 (Langfuse score) | Add a golden case per human correction |
| Temporal worker | Local only | workflow ran via dev server; Docker Temporal stopped (RAM) | Host on Coolify/VPS (costs money: Henry) |
| Langfuse | Done (local) | 18+ traces; all 8 steps in each job trace | none |
| Dify | Done (local) | categorise step via Agent app (streaming) | Dedicated workflow app for categorise |
| Daytona sandboxes | Done | guarded client, mocked tests 6/6, live smoke + demo (parser=daytona), 0 sandboxes left, 3 creates today / cap 20 | Register PDF parser snapshot when needed (may cost credit) |
| Crawl4AI | Done (local) | research.py fetched gov.uk/vat-rates | none |
| Steel | Local only (stopped) | Stopped to save Docker RAM | Start only when browser research is needed |
| Loops | Templates specced only | API key valid; no sends | Henry: create the 4 templates in Loops UI |
| Postiz | Done (untouched) | connected, 0 channels, 0 posts | Connect channels when marketing starts |
| Coolify | Not started | API OK (v4.4.7), 0 servers / 0 projects | Henry: add a server (VPS costs money) |
| Kapa | Done (check fixed) | 1 integration (Internal Assistant) | Add docs source once docs content exists |
| Notion hub | Done | Change Log, Plans, Stack, audit pages | none |
| Console panels | Done | Foundations panel + sandbox usage + janitor button | none |
| Customer auth / tenant scoping | Not started | /v1 returns 401 without Access JWT | Next build step |
| HMRC MTD, Open Banking, ICO, insurance, legal review | Blocked by Henry | docs/compliance research notes | See FOUNDATIONS.md checklist |

Fixed during the audit: the smoke test now waits for Daytona's asynchronous delete; common.py routes parsing through the guarded sandbox package.
