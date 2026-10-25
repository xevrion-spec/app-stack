# Agent review layer: market sanity check (2026-10-25)

**The idea:** a hosted, developer-first human-in-the-loop (HITL) layer. An AI agent sends a risky or uncertain decision to a review queue through the API or SDK. A policy decides whether it is auto-approved, goes to one reviewer, or needs four-eyes approval. Reviewers approve, reject, edit or escalate. The decision returns through a signed webhook or a wait endpoint. Every step goes into a tamper-evident, hash-chained audit log. It is built into the existing Autopilot API, web app, database, auth and CI.

Sources were checked on 2026-10-25. Prices are the vendors' own, or catalogue pages that cite them, and may change.

## Landscape

| Product                    | What it does for HITL                                                                                                                                                                                                                                                    | Gap relative to our idea                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **HumanLayer**             | Had `require_approval` and `human_as_tool` SDKs with Slack and email approvals. The SDKs were removed in Sept 2025 (PR #646) and the README calls the code "pretty much all deprecated". It is now a coding-agent IDE (free for 3 users, Pro $100/user/month). [1][2][3] | The developer-first approvals API it pioneered is unmaintained, so the slot is open.                                             |
| **gotoHuman**              | A hosted review API: create review, fetch review, results by webhook, review types. Free for 300 reviews/month, Team $79/month, AI-rollout $350/month, enterprise from $950/month. API rate limit 1 req/s. [4][5]                                                        | The closest direct competitor. Public docs show no policy engine with four-eyes, simulation or hash-chained evidence export.     |
| **Pushary**                | A maintained "ask a person" API (`decisions.ask()`): no answer means no, decisions are saved, there are hooks for coding agents. $9.99/month, Partner from $99/month. [3]                                                                                                | Consumer/phone-approval focus. No team review queues with SLAs, routing or an audit chain.                                       |
| **Permit.io**              | Operation-approval and access-request APIs plus an MCP gateway HITL toggle with a risk badge, countdown and J/K/A/R keyboard shortcuts. Gateway HITL is **Enterprise-only**, with a 5-minute default auto-reject. [6][7][8]                                              | An authorization-first product: approvals are tied to Permit roles and policies. There is no self-serve HITL on lower plans.     |
| **LangGraph interrupts**   | `interrupt()` pauses a graph, a checkpointer persists state, and `Command(resume=…)` continues it. [9][10]                                                                                                                                                               | A primitive, not a product. You build the queue, UI, routing, SLAs, audit and notifications yourself. A good integration target. |
| **Temporal signals**       | The approval pattern is a durable wait with a timeout and a signal that carries the decision, with history as the audit trail. [11][12]                                                                                                                                  | Also a primitive: you run Temporal and build the reviewer UI and policy yourself. A good integration target.                     |
| **Zapier / Make**          | Zapier "Human in the Loop" Request Approval lets reviewers approve, decline or edit, with a timeout and email/Slack. It is a premium app. [13] Make's HITL app is **Enterprise**. [14]                                                                                   | Locked to their workflow builders, so code-first agents can't call it as an API. Audit is per-run history.                       |
| **Scale / Labelbox-style** | Human labelling and evaluation workforces.                                                                                                                                                                                                                               | Built for training-data batches, not inline runtime decision gates.                                                              |
| **Slack approval bots**    | Ad-hoc buttons in chat.                                                                                                                                                                                                                                                  | No policy, SLA, idempotency or tamper-evident record.                                                                            |

## Where the gap is

A **self-serve, API-first** decision gate that combines:

1. a policy engine (auto, single reviewer or four-eyes, routing, SLAs and escalation, dry-run simulation);
2. reliable delivery (signed webhooks, retries, DLQ, replay, long-poll/SSE wait, idempotent decisions);
3. **verifiable evidence**: a per-project hash chain with a verify endpoint, export bundles and field-level PII redaction.

The incumbents either gate these behind Enterprise plans (Permit, Make), are primitives (LangGraph, Temporal), are locked to a builder (Zapier), or are lighter (gotoHuman, Pushary). gotoHuman is the main threat and is priced cheaply.

## Honest benchmark (0–10, today, before A1)

|                                  | Policy | Delivery | Audit evidence | Dev experience | Reviewer UI | Self-serve |
| -------------------------------- | ------ | -------- | -------------- | -------------- | ----------- | ---------- |
| gotoHuman                        | 4      | 7        | 4              | 7              | 7           | 9          |
| Permit.io HITL                   | 7      | 6        | 6              | 6              | 7           | 3          |
| Zapier HITL                      | 3      | 6        | 4              | 4              | 6           | 8          |
| LangGraph / Temporal (DIY)       | 2      | 5        | 5              | 6              | 0           | 9          |
| **Autopilot agent review (now)** | **0**  | **3**¹   | **3**¹         | **1**          | **0**       | **0**      |

Competitor scores are judgements from their public docs, not measurements. ¹ Credit only for reusable parts that already exist (webhook outbox with HMAC and retries; hash-chained practice audit). No agent-review feature exists yet. The table will be re-scored after A7.

## Issues to note for later (no action taken; Henry is 17)

- Selling a global service needs a contracting entity, terms, a DPA and possibly a sub-processor list. A minor may not be able to enter binding contracts alone, so this needs adult or guardian sign-off.
- Customer payloads may contain personal data (GDPR/UK GDPR controller vs processor roles). Field-level redaction and retention are planned in A4, but they are not legal compliance.
- Do not claim "EU AI Act compliance". At most, say the product _helps_ record human oversight.

Sources: [1] github.com/humanlayer/humanlayer/blob/main/humanlayer.md · [2] docs.vulnify.io/guides/migrating-from-humanlayer-sdk · [3] pushary.com/vs/humanlayer · [4] gotohuman.com/pricing · [5] docs.gotohuman.com/terms-of-service · [6] docs.permit.io/api/elements/operation_approval · [7] docs.permit.io/permit-mcp-gateway/human-in-the-loop · [8] docs.permit.io/ai-security/access-request-mcp/overview · [9] docs.langchain.com/oss/python/langgraph/interrupts · [10] reference.langchain.com/python/langgraph/types/interrupt · [11] docs.temporal.io/design-patterns/approval · [12] docs.temporal.io/ai-cookbook/human-in-the-loop-python · [13] help.zapier.com/hc/en-us/articles/38731463206029 · [14] make.com/en/integrations/human-in-the-loop-enterprise
