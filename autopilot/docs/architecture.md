# Architecture
```
Customer ─▶ app.xevrion.co.uk (Worker static assets) ─▶ api.xevrion.co.uk (Hono Worker)
                                                      ├─ D1 autopilot-db (system of record)
                                                      ├─ R2 autopilot-documents (private, per-tenant prefixes)
                                                      ├─ KV autopilot-config (flags, rate-limit counters)
                                                      └─ Queue autopilot-pipeline (+DLQ) ─▶ Temporal worker
Temporal worker (local now → Coolify/VPS later): extract (Daytona sandbox) → categorise (rules → Dify/FreeLLMAPI)
  → reconcile → draft (code) → QA (code + LLM critique) → review queue → deliver (Loops) → outcome (billing_events)
Every step → Langfuse trace/span; evals gate releases.
console (internal Dify/Langfuse/bridge dashboard) is NOT exposed publicly.
```
Principles: LLMs classify/explain, code does arithmetic; every number traceable to a source document; humans see only exceptions;
tenant isolation by `tenant_id` on every row and R2 prefix; append-only audit_log.

## MVP code map (feature/mvp-core)
```
apps/api            Hono Worker: routes/v1.ts (25 OpenAPI paths), lib/{auth,db(TenantDb),idempotency,audit,log,errors},
                    services/{pipeline,ledger,csv,invoice-pdf,defaults}, queue.ts (retry + DLQ), dev/ (SQLite D1 adapter, local server)
apps/web            React + Vite SPA on the generated SDK (review queue, transactions, upload, invoices, VAT/SA, jobs, settings)
packages/pipeline   pure domain logic: categorise (rules -> LLM, validated), reconcile (incl. invoices, split payments),
                    anomalies, QA, VAT (standard/cash/flat-rate), ledger, SA, LLM client, Langfuse tracer
packages/sdk        typed client generated from openapi/openapi.json (openapi-typescript + openapi-fetch)
packages/workflows  Temporal monthlyClose workflow (ingest -> wait for pipeline -> human review -> VAT draft), activities via SDK
migrations          0001 init, 0002 mvp core (additive)
scripts             seed.ts, local.mjs (Docker-free run), evals.ts (golden gate), api-docs.mjs
```
Request path: Access JWT -> identity -> principal (membership) -> idempotency -> route (zod) -> TenantDb -> audit entry in the same batch.
Pipeline path: upload -> R2 + transactions(new) -> Queue -> runPipeline (idempotent stages via job_events) -> exceptions -> review.
