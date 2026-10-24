# Runbook
- **Deploy API**: `cd autopilot/apps/api && npx wrangler deploy` (CI: manual `deploy` workflow).
- **Migrate D1**: `npm run -w apps/api db:migrate:remote`.
- **Health**: https://api.xevrion.co.uk/health ; status page https://status.xevrion.co.uk/status.html
- **DLQ**: `npx wrangler queues consumer ...` / inspect `autopilot-pipeline-dlq`.
- **Local demo**: `python local/demo_job.py`; Temporal: `python local/temporal_worker.py --once` (needs Temporal on :7233).
- **Evals**: `python evals/run_evals.py`.
- **Incident**: disable route in Cloudflare dashboard, freeze queue consumer, record in Notion Change Log + audit.
