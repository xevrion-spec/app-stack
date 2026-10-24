# Threat model (STRIDE, first pass)
| Threat | Example | Mitigation (status) |
|---|---|---|
| Spoofing | Someone calls /v1 as another tenant | Access/OIDC JWT + tenant scoping (TODO: auth not live; /v1 returns 401 in prod) |
| Tampering | Altered ledger after approval | Append-only audit_log, corrections as new rows (schema ready) |
| Repudiation | "I never approved that VAT return" | reviews + audit_log with actor/time (ready) |
| Info disclosure | Bank data leak | Private R2, no public buckets, least-privilege tokens, no secrets in repo (in place) |
| DoS | Upload floods | KV rate limit (basic), add WAF rate-limit rule (needs scope/plan) |
| Elevation | Prompt injection in a receipt makes LLM approve | LLM never approves/submits; deterministic QA; untrusted file parsing in Daytona sandbox |
| Supply chain | Malicious dependency | Lockfiles, Dependabot, CODEOWNERS review (TODO) |
