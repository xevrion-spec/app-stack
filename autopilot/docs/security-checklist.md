# Security checklist: OWASP ASVS 4.0.3 L2 + OWASP API Security Top 10 (2023)

Reviewed on feature/harden, 25 Oct 2026. Evidence points to code or tests.

Status key:

- ✅ **done** — the control is in place, with code or test evidence;
- ⚠️ **partial** — some of the control is in place;
- ❌ **gap** — the control is missing;
- ⏳ **depends on a live provider** — it cannot be completed until a real provider is connected.

This is a self-assessment, not a penetration test. An external pentest is still required before real customer data
is handled.

## OWASP API Top 10 (2023)

| Risk                                                 | Status | Evidence / note                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API1 Broken object-level authz                       | ✅     | `TenantDb` requires `tenant_id = ?1`. `authz-matrix.test.ts` checks every OpenAPI operation for cross-tenant access: tenant B on A's ids always gets ≥ 400 and never leaks A's data                                                                                                            |
| API2 Broken authentication                           | ✅/⏳  | Cloudflare Access JWT (JWKS + AUD). API keys are sha256-hashed and compared in constant time, with expiry and revocation. `x-dev-user` is accepted **only** when ENVIRONMENT is `development` or `test`; this was fail-open before this branch and is fixed. Access is not yet configured live |
| API3 Broken object-property authz                    | ✅     | Zod response schemas whitelist fields. Mass assignment is blocked because input schemas are strict per route                                                                                                                                                                                   |
| API4 Unrestricted resource consumption               | ✅/⚠️  | Global streaming body limit (2 MB; receipts 10 MB; **new**). Per-user and **per-API-key** token buckets (**new**). Monthly plan quotas. Export is streamed. Rate-limit state is per isolate, so the hard limit must come from a WAF rule (not configured)                                      |
| API5 Broken function-level authz                     | ✅     | Role matrix (`matrix.test.ts`) and spec-driven `authz-matrix.test.ts` (anonymous, non-member, reviewer, accountant, owner × every operation)                                                                                                                                                   |
| API6 Unrestricted access to sensitive business flows | ⚠️     | Idempotency keys. LLM never approves or submits. HMRC submission is not live. No bot/abuse scoring on signup yet                                                                                                                                                                               |
| API7 SSRF                                            | ✅     | Webhook URL allowlist + private-range block, re-checked at send time (`reliability.test.ts`)                                                                                                                                                                                                   |
| API8 Security misconfiguration                       | ✅     | API: `secureHeaders`, HSTS preload, `default-src 'none'`, `frame-ancestors 'none'`, `no-referrer`. Web `_headers`: CSP `default-src 'self'` (style `'unsafe-inline'`; remove when CSS-in-JS goes). No stack traces in responses (leak regex in authz-matrix)                                   |
| API9 Improper inventory                              | ✅     | 109 paths in `openapi/openapi.json`, generated from code; versioning plus Deprecation/Sunset headers                                                                                                                                                                                           |
| API10 Unsafe consumption of APIs                     | ⏳     | Open Banking / HMRC / OCR are mocks. Every provider response must be zod-validated when the real integrations land                                                                                                                                                                             |

## ASVS L2 highlights

| Chapter                                 | Status | Note                                                                                                                                                                          |
| --------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1 Architecture / threat model          | ⚠️     | `threat-model.md` is a first-pass STRIDE; it needs an update for webhooks, API keys and the assistant                                                                         |
| V2/V3 Authentication & session          | ⏳     | Delegated to Cloudflare Access (MFA, session). Not live                                                                                                                       |
| V4 Access control                       | ✅     | Deny by default: authz matrix, tenant scoping, owner-only writes                                                                                                              |
| V5 Validation / sanitisation / encoding | ✅     | Zod on every route. Parsers (CSV/OFX/QIF/MT940) are fuzzed with fast-check (`importers.fuzz.test.ts`), including ReDoS time budgets. CSV export neutralises formula injection |
| V7 Errors & logging                     | ✅     | Error envelope with requestId and no internals. Structured logs with **redaction** of credential-shaped keys and values (**new**). Append-only audit log                      |
| V8 Data protection                      | ⚠️     | Private R2, retention sweep, DSAR export/erase. Field-level encryption of bank data is not implemented                                                                        |
| V9 Communications                       | ✅     | TLS only (HSTS preload)                                                                                                                                                       |
| V10 Malicious code / supply chain       | ✅     | `npm audit`: 0 vulnerabilities (prod and dev, 25 Oct 2026). gitleaks: no leaks. Lockfile committed. Licence check in quality gates                                            |
| V12 Files                               | ✅     | Content-type allowlist, size caps, sha256 de-dupe; untrusted parsing is sandbox-designed                                                                                      |
| V13 API                                 | ✅     | OpenAPI contract, idempotency, ETag/If-Match on invoices                                                                                                                      |
| V14 Configuration                       | ✅     | No secrets in the repo. `.dev.vars` is gitignored. Secrets come only from Wrangler secrets                                                                                    |

## Secrets handling

- API keys are shown once and only `sha256` is stored.
- Webhook secrets are HMAC-SHA256 signed, with a timestamp tolerance.
- Logs never include bodies or documents, and the logger now masks `ap_*`, Bearer tokens, JWTs and `?token=`-style
  query strings.
- gitleaks runs in CI.

## Open gaps (ranked)

1. No external pentest.
2. Rate limits are per isolate; a WAF/Durable Object hard limit is needed.
3. No field-level encryption for bank data.
4. Real provider responses (HMRC, Open Banking) are unvalidated because those integrations do not exist yet.
5. The web CSP still allows `'unsafe-inline'` styles.
6. The threat model needs a refresh.
