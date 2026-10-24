# Xevrion Autopilot Back Office

AI that does the whole back-office job for UK sole traders and micro-businesses: bookkeeping,
invoicing, VAT and Self Assessment **preparation**, with a human reviewing only the exceptions.

> Xevrion is a trading name of Henry Davenhall, sole trader. Not a firm of accountants or tax advisers.
> Nothing produced by this software is tax or legal advice; every rate/rule in `packages/domain-uk-tax`
> must be verified against current HMRC guidance before use.

## Layout
| Path | What |
|---|---|
| `apps/api` | Cloudflare Worker (Hono) – `api.xevrion.co.uk`. D1, R2, Queues, KV bindings. |
| `apps/web` | Static customer app + exceptions review queue + docs + status – `app.`, `docs.`, `status.xevrion.co.uk` |
| `packages/pipeline` | Pipeline stage contract (intake → extract → categorise → reconcile → draft → QA → review → deliver → outcome) |
| `packages/domain-uk-tax` | UK tax concepts as data (VAT, Self Assessment, MTD). Unverified stubs. |
| `local/` | Local runtime: Temporal worker, demo job, Langfuse tracing, Dify/Daytona/Crawl4AI hooks |
| `evals/` | Golden cases + scoring harness + accuracy gate (CI) |
| `migrations/` | D1 schema migrations |
| `docs/` | Architecture, data model, threat model, compliance research prompts, ADRs, runbook |

## Quick start (local)
```powershell
cd autopilot
npm install
npm run -w apps/api dev            # wrangler dev, local D1/R2/Queues
python local/demo_job.py           # synthetic demo job end to end (needs bridge + Langfuse running)
python evals/run_evals.py          # accuracy gate
```
Secrets live in `C:\Users\henry\app-stack\.env` (never committed) and in Wrangler/GitHub secrets.
