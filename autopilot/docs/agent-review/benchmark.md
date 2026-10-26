# Agent review layer: honest re-scored benchmark (2026-10-26)

Re-score of the table in [agent-review-market.md](../agent-review-market.md). **Competitor scores are carried over
from the 2026-10-25 research (their public docs) and were not re-verified today.** Ours are judged against what the
code on `feature/agent-review-layer` does in tests. Mocked integrations count as missing.

## Two scores, kept separate

- **Capability (code):** what the software can do, proven by automated tests (2,783 unit/integration, property and
  contract tests; Playwright E2E with axe; mutation testing on the cores).
- **Market-ready (real world):** what a paying customer could rely on today. This needs things code alone cannot
  provide: a production deployment, uptime history, real integrations, published SDKs, security attestation,
  support, a legal entity and contracts.

## Scores (0–10)

|                                    | Policy | Delivery | Audit evidence | Dev experience | Reviewer UI | Enterprise | Self-serve |
| ---------------------------------- | ------ | -------- | -------------- | -------------- | ----------- | ---------- | ---------- |
| gotoHuman                          | 4      | 7        | 4              | 7              | 7           | 3          | 9          |
| Permit.io HITL                     | 7      | 6        | 6              | 6              | 7           | 8          | 3          |
| Zapier HITL                        | 3      | 6        | 4              | 4              | 6           | 6          | 8          |
| LangGraph / Temporal (DIY)         | 2      | 5        | 5              | 6              | 0           | 5          | 9          |
| Autopilot before A1 (2026-10-25)   | 0      | 3        | 3              | 1              | 0           | 1          | 0          |
| **Autopilot capability (code)**    | **9**  | **7**    | **9**          | **6**          | **6**       | **6**      | **2**      |
| **Autopilot market-ready (today)** | **3**  | **1**    | **4**          | **2**          | **3**       | **1**      | **0**      |

The "Enterprise" column is new (SSO/SCIM/RBAC/audit streaming/compliance). Competitor values in it are rough judgements
from public plan pages and should be treated as estimates.

Averages: capability **6.4**, market-ready **2.0**. Before A1: 1.1.

## Why each capability score

- **Policy 9:** versioned, hashed policy-as-code; canary %; dry-run simulate; replay-gated activation (blocks a policy
  that would auto-approve what humans rejected/edited); time-travel replay diff; hard guardrails; four-eyes; SLA
  escalation; learned auto-approve suggestions with Wilson bound and shadow replay. Not 10: no visual rule builder,
  conditions are single-path comparisons.
- **Delivery 7:** signed callbacks + webhooks, retries, DLQ, redelivery, long-poll, SSE, idempotent writes, TS + Python
  SDKs, framework adapters. Not higher: wait/SSE poll D1 (no push), adapters untested against the real frameworks,
  **no Slack/email/Teams reviewer notifications** (competitors have these).
- **Audit evidence 9:** per-request hash chain with verification, Ed25519 receipts, evidence packs, signed regulator
  pack with evaluated controls, SIEM streaming (JSON/CEF), retention/legal hold/redaction. Not 10: no PDF/human-readable
  pack, no external timestamping/anchoring, redaction does not reach backups.
- **Dev experience 6:** OpenAPI, generated SDK types, quickstart, simulator, consistent errors. Missing: SDKs not
  published to npm/PyPI, no hosted sandbox, no Python receipt verification.
- **Reviewer UI 6:** inbox with diff, context, keyboard shortcuts, accessible (axe clean light/dark, mobile), audit
  badge, hold/redaction badges. Missing: bulk actions, assignment/claiming, notifications, mobile app.
- **Enterprise 6:** OIDC SSO, SCIM Users, custom roles (RBAC + project/env/risk ABAC), IP allow-lists, key policy,
  audit streaming, reviewer analytics. Missing: SAML, SSO enforcement, SCIM Groups, KMS/BYOK, data residency, SOC 2.
- **Self-serve 2:** sign-up, console, keys and metering exist in code, but there is no live deployment or billing.

## What code improved vs what needs real-world factors

| Improved by code (done)                                         | Needs real-world factors (not doable by code alone)                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Policy engine, canary, replay safety, suggestions               | Production deployment with monitoring and an uptime record                        |
| Delivery guarantees (idempotency, retries, DLQ), SDKs           | Real Slack/email/Teams reviewer channels (accounts, app review)                   |
| Hash-chained evidence, receipts, regulator pack, SIEM streaming | Publishing SDKs (npm/PyPI accounts), docs site, support channel                   |
| SSO/SCIM/RBAC/IP rules, retention and legal hold                | Real IdP testing (Okta/Entra/Google), SAML, penetration test, SOC 2 / ISO 27001   |
| Analytics (reviewer quality, cost/latency/outcomes)             | Customers and case studies; pricing validation against gotoHuman ($79–$950/month) |
| A11y and E2E quality gates                                      | Legal entity, terms, DPA, sub-processors; legal review of the EU AI Act mapping   |

## Bottom line

As software, the layer now exceeds the researched competitors on policy safety and audit evidence and roughly matches
them on delivery and UI. As a product, it is **not yet competitive**: nobody can use it, and the integrations reviewers
expect (Slack/email) are missing. The cheapest real-world wins are a deployment with monitoring, Slack/email
notifications, and published SDKs. These need decisions and accounts from Henry, plus an adult for contracts.
