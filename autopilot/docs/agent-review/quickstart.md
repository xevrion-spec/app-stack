# Agent review quickstart

Gate a risky agent action behind a human decision in about 10 minutes. Everything below runs against a local API
(`npm run local`, http://127.0.0.1:8787) with synthetic data. **There is no hosted production deployment yet.**

## 1. Project and API key (owner, once)

In the web app open **Agents → developer console**, create a project, then create an API key (shown once).
Or with the API (local dev identity header shown; production uses Cloudflare Access or SSO):

```bash
curl -s -X POST localhost:8787/v1/review-projects -H 'x-dev-user: owner@example.test' -H 'content-type: application/json' -d '{"name":"support-agent"}'
curl -s -X POST localhost:8787/v1/api-keys -H 'x-dev-user: owner@example.test' -H 'content-type: application/json' \
  -d '{"name":"agent","scopes":["reviews:write","reviews:read"],"projectId":"<project id>"}'
```

Keys can be IP-restricted (`allowedCidrs`) and the tenant can require expiry/CIDRs via `PUT /v1/security/key-policy`.

## 2. Ask before acting

TypeScript (`packages/sdk`, dependency-free, Node 18+/Workers/Deno/browsers):

```ts
import { ReviewClient } from "@xevrion/sdk";
const reviews = new ReviewClient({ baseUrl: "http://127.0.0.1:8787", apiKey: process.env.REVIEW_KEY! });
const r = await reviews.requestAndWait({ action: "refund.issue", payload: { amount: 120 }, risk: "high", confidence: 0.82 });
if (r.status === "approved") await issueRefund(r.payload); // payload may have been edited by the reviewer
```

Python (`sdks/python`, stdlib only):

```python
from xevrion_review import ReviewClient, guard
client = ReviewClient("http://127.0.0.1:8787", api_key=KEY)

@guard(client, action="refund.issue", risk="high")
def refund(amount, note=None): ...   # runs only if approved, with the approved (possibly edited) arguments
```

Writes are idempotent (`Idempotency-Key` is pinned per call, so retries never create duplicates).

## 3. Get the decision

Pick one: `GET /v1/agent-reviews/{id}/wait?timeoutSeconds=…` (long-poll), `GET …/stream` (SSE), or a signed
callback (`callbackUrl` on create). Verify callbacks with `verifyCallback(rawBody, header, [secret])` (TS) or
`verify_callback(...)` (Python): HMAC-SHA256 over `t.body` in the `autopilot-signature` header, 5-minute replay window,
old + new secrets accepted during rotation. Dedupe on the callback `id`.

## 4. Route with policy instead of asking every time

```json
{
  "rules": [
    {
      "id": "small-refunds",
      "when": { "action": "refund.*", "risk": ["low"], "minConfidence": 0.9, "payload": [{ "path": "amount", "op": "lte", "value": 50 }] },
      "then": { "outcome": "auto_approve" }
    }
  ]
}
```

`POST /v1/review-projects/{id}/policies` saves an immutable version; `POST /v1/agent-reviews/simulate` dry-runs it;
activate with a canary percentage and an impact preview. Guardrails the policy cannot override: critical risk is never
auto-approved and needs two approvers; auto-approve rules must require `minConfidence ≥ 0.5`.

`GET /v1/review-projects/{id}/suggestions` proposes auto-approve rules learned from your own human decisions
(low/medium risk only, Wilson lower bound ≥ 0.97 over ≥ 50 decisions, shadow replay counts). It returns a draft;
nothing is activated for you.

## 5. Evidence

- Per request: `GET /v1/agent-reviews/{id}/audit` (hash chain + verification), `/receipt` (Ed25519-signed),
  `/evidence` (self-contained JSON pack).
- Per period: `GET /v1/review-projects/{id}/regulator-pack?from=…&to=…` (signed pack with evaluated controls; a mapping
  aid, not legal advice).
- Analytics: `/v1/agent-review/analytics/reviewers`, `/v1/agent-review/analytics/outcomes`, `/v1/agent-review/usage`.

Full endpoint list: [api-reference.md](api-reference.md). Security model: [security.md](security.md).
