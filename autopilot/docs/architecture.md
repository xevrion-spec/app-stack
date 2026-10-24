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
