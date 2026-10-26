# Agent review: security notes

Honest status as of 2026-10-26. "Tested" means automated tests against the code, with outbound services **mocked**;
nothing here has had an external penetration test or audit, and there is no production deployment.

## Identity and access

| Control          | Status                                                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation | Every query goes through `TenantDb`, which rejects SQL not scoped by `tenant_id = ?1`; authz matrix test covers every route × role.                                                                      |
| API keys         | Hashed at rest, scoped (`reviews:write`, `reviews:read`, `scim:write`, …), optional project binding, expiry, CIDR allow-list (fails closed), tenant key policy.                                          |
| Human sign-in    | Cloudflare Access, or OIDC SSO (PKCE S256, state + nonce single-use, issuer/audience/expiry checks, required email-domain allow-list, never JIT as owner). **No SAML yet; no "enforce SSO" switch yet.** |
| Provisioning     | SCIM 2.0 Users (create/patch/deactivate; owner protected). **No Groups, bulk or ETags.**                                                                                                                 |
| RBAC / ABAC      | Fixed roles plus custom roles: approve/reject/edit/escalate permissions, limited by project, environment and max risk. Custom roles apply to agent-review routes only.                                   |
| Rate limits      | Per principal and per API key (soft, per isolate); public SSO endpoints per IP (20/min default). **WAF hard limits not configured** (no deployment).                                                     |

## Integrity and evidence

- Each request has a SHA-256 hash chain (`prevHash` → `hash` over canonical JSON); `/audit` re-verifies it, receipts
  are only signed over a verified chain, and the regulator pack marks any broken chain as a control gap.
- Receipts and packs are Ed25519-signed (`RECEIPT_SIGNING_JWK`); retired public keys stay published so old signatures
  verify after rotation.
- Callbacks/webhooks: HMAC-SHA256 with timestamp, SSRF guard on destinations, retries with backoff, DLQ, redelivery.
- Audit streaming to a SIEM endpoint (JSON or CEF) with a resumable cursor; pull export via NDJSON.

## Data protection

- Retention per project (sweeper runs hourly), legal hold (blocks redaction and retention), on-demand redaction of
  payload and context while keeping decisions and the chain. Guarded batches make hold/redact races fail closed.
- Regulator packs pseudonymise reviewer identities by default.
- **Gaps:** secrets (IdP client secrets, sink secrets) are stored in D1 without a KMS/envelope encryption; redaction does
  not reach R2 objects, backups or D1 Time Travel copies; no data-residency choice; no customer-managed keys.

## Supply chain and quality gates

CI runs typecheck, lint (complexity ≤ 20, functions ≤ 150 lines), unit/integration tests with coverage thresholds
(90% lines / 85% branches), property tests, mutation testing on the cores, knip, madge, gitleaks, licence and
`npm audit` checks, bundle budget, axe accessibility checks and Playwright E2E.

## Reporting

There is no security contact or bug-bounty programme yet. That needs an owner who can accept legal responsibility.
