# Agent review API reference

Generated from `openapi/openapi.json` by `npm run docs:api`. Base URL: your API host. Agents authenticate with `Authorization: Bearer ap_…` (scopes `reviews:write` / `reviews:read`); people use Cloudflare Access or an SSO session (`Bearer ses_…`). SCIM (`/v1/scim/v2/*`, scope `scim:write`) is plain JSON and not in this spec yet.

| Method | Path | Summary | Request | Response |
|---|---|---|---|---|
| GET | `/sso/oidc/start` | Begin OIDC login: returns the IdP authorization URL (PKCE S256, state, nonce) |  | object |
| POST | `/sso/oidc/callback` | Finish OIDC login: exchanges the code, verifies the ID token, returns a session token (Bearer ses_...) | object | object |
| GET | `/v1/security/key-policy` | Tenant API key policy |  | KeyPolicy |
| PUT | `/v1/security/key-policy` | Set the API key policy (applies to keys created or rotated from now on) | KeyPolicy | KeyPolicy |
| POST | `/v1/review-projects` | Create a review project in one environment (owner only; API keys cannot create projects) | object |  |
| GET | `/v1/review-projects` | List review projects |  | object |
| POST | `/v1/review-projects/{id}/rotate-callback-secret` | Replace the project's callback signing secret (owner only; shown once). Callbacks sent after this use the new secret. |  | object |
| POST | `/v1/review-projects/{id}/policies` | Save a new immutable policy version (draft). Unsafe rules (auto-approve without confidence, critical auto-approve) are refused. | object | ReviewPolicy |
| GET | `/v1/review-projects/{id}/policies` | List policy versions (newest first) |  | object |
| POST | `/v1/review-projects/{id}/policies/replay` | Time-travel replay: re-run past requests against a candidate policy (a document or a saved version) and diff the outcomes | object | PolicyReplayReport |
| POST | `/v1/review-projects/{id}/policies/{version}/activate` | Activate a version for all traffic, or as a canary for canaryPercent of new requests. Refused (409 unsafe_policy) if replaying recent history shows it would auto-approve anything a human rejected or edited, unless force is set. | object | object |
| PUT | `/v1/review-groups/{name}` | Set the members of a reviewer group (owner only). Requests routed to a group can only be decided by its members or an owner. | object | object |
| GET | `/v1/review-groups` | List reviewer groups and members |  | object |
| POST | `/v1/agent-reviews` | Ask for a human decision. The project's policy routes it (auto-approve, human, four-eyes or reject). Send Idempotency-Key: a retry with the same key and body returns the original request (200); the same key with a different body is 409. | object | ReviewRequest |
| GET | `/v1/agent-reviews` | List review requests (newest first), filterable by project, status, risk, group and externalId |  | object |
| POST | `/v1/agent-reviews/simulate` | Dry run: how would this request be routed by the live policy (or a draft document)? Nothing is stored. | object | ReviewRoutingSimulation |
| GET | `/v1/agent-reviews/{id}` | Get a review request with its decisions |  | ReviewRequest |
| POST | `/v1/agent-reviews/{id}/decisions` | Record a decision: approve, reject (veto), edit (replaces the payload; earlier approvals stop counting) or escalate. Routed requests need a member of the group (or an owner). | object | ReviewRequest |
| POST | `/v1/agent-reviews/{id}/cancel` | Cancel a pending request (requester only) |  | ReviewRequest |
| GET | `/v1/agent-reviews/{id}/callbacks` | Callback delivery log for a request |  | object |
| POST | `/v1/agent-reviews/{id}/callbacks/redeliver` | Redeliver the request's callbacks now (including dead or already-succeeded ones). Receivers dedupe by callback id. |  | object |
| GET | `/v1/agent-reviews/{id}/wait` | Long-poll: returns as soon as the request is final, or after timeoutSeconds with its current state (check status; call again to keep waiting). |  | ReviewRequest |
| GET | `/v1/agent-reviews/{id}/stream` | Server-sent events: `review` on every state change, then `end` (reason final | timeout). maxSeconds 1..55 (default 55); reconnect to continue. |  |  |
| GET | `/v1/agent-reviews/{id}/audit` | Hash-chained audit trail for a request, with a full integrity check |  | object |
| GET | `/v1/agent-reviews/{id}/receipt` | Ed25519-signed decision receipt (final requests with a verified trail only); verifiable offline |  | DecisionReceipt |
| GET | `/v1/agent-reviews/{id}/evidence` | Self-contained evidence pack: request, decisions, ledger, integrity, policy document, callbacks, receipt, public keys |  | object |
| GET | `/v1/agent-review/receipt-keys` | Public keys for verifying decision receipts (current first, then retired) |  | object |
| GET | `/v1/agent-review/audit/export` | Ledger entries after `since` as NDJSON (SIEM ingestion). Content-free: payloads appear only as hashes. Page with the last line's `at`. |  |  |
| PUT | `/v1/review-projects/{id}/retention` | Set how long final requests keep their content (null = forever). Held requests are never redacted. | ReviewRetention | ReviewRetention |
| POST | `/v1/agent-reviews/{id}/legal-hold` | Place a legal hold | LegalHoldIn | ReviewRequest |
| DELETE | `/v1/agent-reviews/{id}/legal-hold` | Release a legal hold |  | ReviewRequest |
| POST | `/v1/agent-reviews/{id}/redact` | Erase a final request's content now (e.g. an erasure request). Refused under legal hold. The hash chain is kept. |  | ReviewRequest |
| GET | `/v1/agent-review/usage` | This month's agent review usage vs plan quota |  | AgentReviewUsage |
| GET | `/v1/agent-review/analytics/reviewers` | Reviewer quality: latency, approve rates, co-reviewer disagreement and rubber-stamp signals |  | ReviewerQualityReport |
| GET | `/v1/review-projects/{id}/suggestions` | Learn when to stop asking: guarded auto-approve rule suggestions with a shadow replay (draft only) |  | AutoApproveSuggestions |
| GET | `/v1/agent-review/analytics/outcomes` | Cost, latency and outcome analytics per action (cost only from your own reviewer-cost inputs) |  | AgentReviewOutcomes |
| GET | `/v1/review-projects/{id}/regulator-pack` | Regulator-style evidence pack for a period: control statements, policies, outcomes, reviewers, verified trails; signed |  | RegulatorEvidencePack |
| GET | `/v1/agent-review/events` | Change feed of review requests visible to the caller, oldest first after `cursor` (omit it to get the head cursor only). No payloads. |  | object |
| GET | `/v1/agent-review/events/stream` | Server-sent events: `change` per request change (id = resume cursor; honours Last-Event-ID or `cursor`), then `end` after maxSeconds (1..55, default 55). Reconnect to continue. |  |  |
| GET | `/v1/review-projects/{id}/business-hours` | The project's business-hours calendar (null = none; business-clock rules then fall back to wall time, flagged) |  | object |
| PUT | `/v1/review-projects/{id}/business-hours` | Set or clear (null) the business-hours calendar. Applies to requests created afterwards. | object | object |
| POST | `/v1/review-delegations` | Delegate your review duties (owners may delegate for anyone) to another reviewer for up to 90 days. Replaces your current delegation. | object | ReviewDelegation |
| GET | `/v1/review-delegations` | Delegations: owners see all; reviewers see the ones from or to them |  | object |
| DELETE | `/v1/review-delegations/{id}` | End a delegation now (the delegator or an owner) |  | ReviewDelegation |
| POST | `/v1/agent-reviews/{id}/attachments` | Attach evidence (raw body; Content-Type one of application/pdf, image/png, image/jpeg, image/gif, image/webp, text/plain, text/csv, application/json; X-Filename; at most 10 MB, 20 per request). Scanned before storage. |  | ReviewAttachment |
| GET | `/v1/agent-reviews/{id}/attachments` | Attachments on a request, with scan results |  | object |
| GET | `/v1/agent-reviews/{id}/attachments/{attachmentId}/content` | Download a clean attachment (always as a file; 409 attachment_blocked when infected or rejected) |  |  |
| GET | `/v1/review-projects/{id}/templates` | Action templates for a project |  | object |
| PUT | `/v1/review-projects/{id}/templates/{action}` | Create or replace the template for an action. New requests whose payload breaks the schema get 422 payload_invalid. | object | ReviewActionTemplate |
| DELETE | `/v1/review-projects/{id}/templates/{action}` | Remove an action template |  | object |
| POST | `/v1/notify/channels` | Add a reviewer notification channel (Slack, Teams, email or webhook) | NotifyChannelIn | NotifyChannel |
| GET | `/v1/notify/channels` | List notification channels (secrets are never returned) |  | object |
| DELETE | `/v1/notify/channels/{id}` | Delete a channel (pending deliveries are skipped) |  | object |
| POST | `/v1/notify/channels/{id}/test` | Send a synthetic test message now |  | object |
| PUT | `/v1/notify/channels/{id}/identities` | Link a Slack user id to a reviewer, so their button clicks decide as them | NotifyIdentity | NotifyIdentity |
| POST | `/v1/notify/deliveries/{id}/retry` | Re-queue a dead delivery |  | NotifyDelivery |
| GET | `/v1/agent-reviews/{id}/notifications` | Notification delivery log for a request |  | object |
| PUT | `/v1/agent-review/audit-sink` | Create or replace the tenant's audit sink (signed push of ledger entries, NDJSON or CEF) | AuditSinkIn | AuditSink |
| GET | `/v1/agent-review/audit-sink` | Audit sink status and cursor |  | AuditSink |
| DELETE | `/v1/agent-review/audit-sink` | Remove the audit sink |  | object |
| POST | `/v1/agent-review/audit-sink/resume` | Resume a paused sink from its cursor (nothing is skipped) |  | AuditSink |
| POST | `/v1/agent-review/audit-sink/rotate-secret` | Rotate the signing secret (returned once) |  | AuditSink |
| PUT | `/v1/sso/oidc` | Configure OIDC single sign-on (JIT provisioning, never as owner) | OidcConnectionIn | OidcConnection |
| GET | `/v1/sso/oidc` | OIDC connection (client secret is never returned) |  | OidcConnection |
| DELETE | `/v1/sso/oidc` | Remove SSO and revoke every SSO session |  | object |
| POST | `/v1/sso/logout` | Revoke all of the caller's SSO sessions |  | object |
| GET | `/v1/roles` | List custom roles |  | object |
| POST | `/v1/roles` | Create a custom role (permissions + project/environment/risk conditions) | CustomRoleIn | CustomRole |
| PUT | `/v1/roles/{id}` | Replace a custom role (takes effect on the next request) | CustomRoleIn | CustomRole |
| DELETE | `/v1/roles/{id}` | Delete an unassigned custom role |  | object |
| PUT | `/v1/users/{id}/custom-role` | Assign (or clear with null) a user's custom role. Owners cannot be narrowed. | object | object |
