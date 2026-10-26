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

## 3b. Notify reviewers where they work (R1)

`POST /v1/notify/channels` (owner) adds a channel: `slack` (incoming-webhook URL plus the app signing secret for
interactive buttons; link Slack users to reviewers with `PUT /v1/notify/channels/{id}/identities`), `teams`
(incoming-webhook Adaptive Card with open links), `email` (your provider's HTTP send endpoint and token, plus
recipients), or `webhook` (signed JSON for your own bot). Filter channels by project and minimum risk. Email links carry
a signed, single-use token bound to one reviewer that expires at the request deadline (7 days at most). The link opens a
confirm page; **opening it never decides**. Slack buttons decide as the linked clicking user. Every path goes through
the same role, risk and group checks as the inbox. Deliveries retry with backoff and dead-letter after 8 attempts.
See `GET /v1/agent-reviews/{id}/notifications` and `POST /v1/notify/deliveries/{id}/retry`. Set `NOTIFY_ACTION_KEY`
to enable action links. Without it, messages carry open links only.

**Status:** tested against fake Slack/Teams/email/webhook receivers only. No real Slack app or email provider has been
connected.

## 3c. Live updates (R2)

- `GET /v1/agent-reviews/{id}/wait` and `/stream` now wake on the decision itself (in-process push). The poll interval
  is only a fallback for writes that land on another Workers isolate.
- `GET /v1/agent-review/events` is a tenant change feed (id, project, action, risk, status, version; never payloads)
  after an opaque `cursor`. Call it without a cursor to get the head.
- `GET /v1/agent-review/events/stream` streams the same feed as server-sent events. Each event `id` is a resume cursor,
  so reconnecting with `Last-Event-ID` (or `?cursor=`) continues without gaps. A 2-second rescan delivers commits that
  land out of timestamp order exactly once per stream. The console inbox uses it: new requests appear without a reload,
  and an open request changed by someone else is flagged instead of overwritten.

**Honest limits:** cross-isolate wake-ups are not built (they would need a Durable Object fan-out), so on a busy
production deployment the latency is the poll interval (500 ms), not instant. The JSON page endpoint has no late-commit
rescan; use the stream for exactly-once delivery.

## 3d. Approval chains, quorum, delegation and business hours (R3)

- **Chains:** a rule's `then.steps` (1–5) must clear in order, for example `[{ "name": "lead", "group": "leads",
  "approvals": 1 }, { "name": "finance", "group": "finance", "quorumPercent": 60 }]`. Only the current step's group may
  decide (owners can always decide). A person counts in one step only. Reject vetoes the whole chain. An edit restarts
  the chain so every step approves exactly what will run. Progress is returned in `routing.chain` and shown in the
  inbox.
- **Quorum:** `quorumPercent` resolves to a count of the group's *active* reviewers when the request is created (at
  least 1, at most 10). Guardrails `quorum_empty_group:<step>` and `quorum_capped:<step>` say when that happened.
  Critical requests still need two people in total.
- **Delegation:** `POST /v1/review-delegations` (`toEmail`, `endsAt` at most 90 days away, optional `startsAt` and
  `reason`). It is one hop and time-boxed. The delegate decides as themselves, with their own role limits, on requests
  routed to the delegator's groups. Every such decision is audited as `review.delegated_decision` with `onBehalfOf`.
  Owners can delegate for a reviewer. A deactivated delegator's delegation stops working.
- **Business hours:** `PUT /v1/review-projects/{id}/business-hours` (IANA time zone, ISO weekdays, `start`/`end`,
  holidays). Rules with `clock: "business"` count their timeout and escalation in business time only (DST-correct).
  Without a calendar they fall back to wall time with the `business_clock_without_calendar` guardrail.

**Honest limits:** reviewers of later chain steps are not re-notified when a step clears (notifications fire at
creation only). Delegation does not redirect notifications. Quorum is fixed at creation, so later group changes do not
re-resolve it.

## 3e. Templates, edit diffs and evidence (R4)

- **Action templates:** `PUT /v1/review-projects/{id}/templates/{action}` with a JSON Schema subset (`type`,
  `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, min/max, lengths, `pattern`, `format`).
  Agents whose payload breaks it get **422 `payload_invalid`** with every field error. An optional `title` (with
  `{{field}}` placeholders) and `instructions` appear on the request for reviewers. Schemas are interpreted, never
  compiled. Patterns prone to catastrophic backtracking are refused, and schemas are capped at depth 8.
- **Edit diff:** after an edit, `payloadDiff` lists path-level changes (`amount`, `lines[1].sku`) versus the agent's
  original. The inbox shows them.
- **Evidence attachments:** `POST /v1/agent-reviews/{id}/attachments` (raw body, `Content-Type` from PDF, PNG, JPEG,
  GIF, WebP, text, CSV or JSON, plus `X-Filename`; at most 10 MB and 20 per request; open requests only). Every file is
  checked before storage: the bytes must match the declared type, and executables are refused. Only clean files are
  stored and downloadable (always as a download, with `nosniff`). Redaction deletes the bytes and the names.

**Honest limits:** the malware engine is a **stub** that recognises only the EICAR test file (`engine: "stub-eicar"`).
A real AV engine still needs plugging in. Type and executable checks are real.

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
