# API reference

Generated from `openapi/openapi.json` (source of truth: zod schemas in `apps/api/src`). Regenerate with `npm run openapi && npm run docs:api`.

Auth: Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`). Local dev only: `x-dev-user: <email>`. Optional `x-tenant-id` selects a tenant; `Idempotency-Key` makes unsafe requests replay-safe. Errors: `{ error: { code, message, requestId, details? } }`.

Practice endpoints (`/v1/practice*`): same staff identity; `x-practice-id` selects a firm; API keys are refused; roles partner/manager/preparer/reviewer/readonly; out-of-scope clients return 404. Client portal (`/v1/portal/*`): `Authorization: Bearer ps_…` session from `POST /v1/portal/session` (mock magic link; never emailed); staff identities are not accepted there. Integration adapters are MOCKS unless the catalogue (`GET /v1/practice/integrations`) says `real`.

| Method | Path | Summary | Tag |
|---|---|---|---|
| GET | `/sso/oidc/start` | Begin OIDC login: returns the IdP authorization URL (PKCE S256, state, nonce) | Account |
| POST | `/sso/oidc/callback` | Finish OIDC login: exchanges the code, verifies the ID token, returns a session token (Bearer ses_...) | Account |
| POST | `/v1/tenants` | Create a tenant (caller becomes owner) with default chart of accounts | Account |
| POST | `/v1/practices` | Create an accountancy practice (caller becomes partner); seeds default close templates | Practice |
| GET | `/v1/practice` | The signed-in staff member's practice, role and plan quota | Practice |
| GET | `/v1/practice/staff` | List staff | Practice |
| POST | `/v1/practice/staff` | Add or change a staff member (partner only) | Practice |
| DELETE | `/v1/practice/staff/{email}` | Remove a staff member and their assignments (partner only; the last partner cannot be removed) | Practice |
| GET | `/v1/practice/clients` | Clients visible to me with health, review backlog, queries and next deadline (worst health first) | Practice |
| POST | `/v1/practice/clients` | Add a client business (creates its books with the default chart of accounts); partner/manager | Practice |
| GET | `/v1/practice/clients/{id}` | Client detail: settings, health, deadlines and assignments | Practice |
| PATCH | `/v1/practice/clients/{id}` | Change client settings: deadlines config, fees, auto-approve policy, QA sampling, SLA, status (partner/manager) | Practice |
| PUT | `/v1/practice/clients/{id}/assignments` | Replace a client's preparer/reviewer assignments (partner/manager) | Practice |
| GET | `/v1/practice/deadlines` | Deadlines across all my clients (VAT, Self Assessment, MTD ITSA), overdue first. UNVERIFIED dates. | Practice |
| GET | `/v1/practice/dashboard` | Practice dashboard: client health, workload, review backlog by age, deadlines, risk flags, WIP and billing-ready | Practice |
| POST | `/v1/practice/bulk` | Cross-client bulk action. Without confirmToken: dry-run preview + token. With the matching token: executes. Max 50 clients. | Practice |
| GET | `/v1/practice/review-queue` | Items awaiting first-pass review across my clients, oldest first, with SLA state and auto-approve eligibility | Practice workflow |
| POST | `/v1/practice/review/approve` | Approve review items (optionally correcting the category first). Corrections feed learning and the eval harness. | Practice workflow |
| POST | `/v1/practice/review/bulk-approve` | Bulk-approve high-confidence items (confidence floor 0.9) across clients. Preview first; execute with confirmToken. Max 1000. | Practice workflow |
| POST | `/v1/practice/review/claim` | Claim review items for yourself or assign them to a colleague (managers may assign to others) | Practice workflow |
| POST | `/v1/practice/clients/{id}/auto-approve` | Apply the client's auto-approve policy (allowlisted categories at >= threshold, floor 0.9) and QA-sample the result | Practice workflow |
| GET | `/v1/practice/qa` | Auto-approved items sampled for QA and not yet checked, plus the QA pass rate so far | Practice workflow |
| POST | `/v1/practice/qa/{clientId}/{transactionId}` | Record a QA check of an auto-approved item; a fail must give the correct category (recategorises + logs) | Practice workflow |
| GET | `/v1/practice/close-templates` | Close checklist templates | Practice workflow |
| POST | `/v1/practice/close-templates` | Create a close checklist template (partner/manager) | Practice workflow |
| POST | `/v1/practice/clients/{id}/checklists` | Start a close checklist for a client and period from a template | Practice workflow |
| GET | `/v1/practice/checklists` | Close checklists across my clients | Practice workflow |
| GET | `/v1/practice/checklists/{id}` | Checklist with items and live evidence (review backlog, open queries, exceptions up to the period end) | Practice workflow |
| POST | `/v1/practice/checklists/{id}/items/{idx}` | Tick or untick a checklist item (not on a completed checklist) | Practice workflow |
| POST | `/v1/practice/checklists/{id}/complete` | Complete and lock a checklist (reviewer/manager/partner; all required items done; no items awaiting review in the period) | Practice workflow |
| POST | `/v1/practice/clients/{id}/queries` | Ask the client a question, optionally about a transaction (shows in their portal; emits query.raised; no email) | Practice workflow |
| GET | `/v1/practice/queries` | Client queries across my clients | Practice workflow |
| POST | `/v1/practice/queries/{id}/close` | Close a query (after the client answered, or to withdraw it) | Practice workflow |
| GET | `/v1/practice/task-templates` | Recurring work templates | Practice workflow |
| POST | `/v1/practice/task-templates` | Create a recurring work template (partner/manager) | Practice workflow |
| POST | `/v1/practice/tasks/generate` | Generate this month's recurring tasks for all active clients (idempotent per template, client and due date) | Practice workflow |
| GET | `/v1/practice/tasks` | Tasks across my clients | Practice workflow |
| PATCH | `/v1/practice/tasks/{id}` | Update a task's status or assignee (assigning others needs partner/manager) | Practice workflow |
| POST | `/v1/practice/time` | Record time against a client (internal) | Practice billing |
| GET | `/v1/practice/time` | Time entries (mine, or everyone's for partners/managers) | Practice billing |
| GET | `/v1/practice/billing/wip` | Work in progress and billing-ready clients (internal valuation; nothing is invoiced or charged) | Practice billing |
| POST | `/v1/practice/billing/records` | Turn a client's WIP into an internal billing record (marks the time as billed). Not an invoice; nothing is sent. | Practice billing |
| GET | `/v1/practice/billing/records` | Internal billing records | Practice billing |
| POST | `/v1/practice/clients/{id}/imports/bank-csv` | Import a client's bank statement CSV (text/csv body); de-duplicated, then the AI first pass runs | Practice workflow |
| POST | `/v1/practice/clients/{id}/engagements` | Draft an engagement letter (managers). The letter text is hashed; the hash is frozen once sent. | Practice onboarding |
| GET | `/v1/practice/clients/{id}/engagements` | Engagement letters for a client | Practice onboarding |
| POST | `/v1/practice/engagements/{id}/send` | Mark a draft as sent: it appears in the client portal for acceptance. Nothing is emailed. | Practice onboarding |
| POST | `/v1/practice/engagements/{id}/withdraw` | Withdraw a draft or sent letter | Practice onboarding |
| POST | `/v1/practice/clients/{id}/authorisations` | Record an agent authorisation (64-8 style). DATA ONLY: no HMRC request is made. References are masked on write. | Practice onboarding |
| GET | `/v1/practice/clients/{id}/authorisations` | Authorisation records for a client | Practice onboarding |
| POST | `/v1/practice/authorisations/{id}/{action}` | Confirm or revoke an authorisation record | Practice onboarding |
| POST | `/v1/practice/clients/{id}/document-requests` | Request documents from a client (explicit titles and/or a template). Shown in the portal; nothing is emailed. | Practice onboarding |
| GET | `/v1/practice/document-requests` | Document requests across my clients (the upload checklist) | Practice onboarding |
| POST | `/v1/practice/document-requests/{id}/waive` | Waive an open document request | Practice onboarding |
| POST | `/v1/practice/clients/{id}/portal-users` | Invite a client contact to the portal. MOCK delivery: the single-use magic token (15 min) is returned here for staff to hand over; Autopilot never emails it. | Practice onboarding |
| GET | `/v1/practice/clients/{id}/portal-users` | Portal users for a client | Practice onboarding |
| POST | `/v1/practice/portal-users/{id}/revoke` | Revoke a portal user and every token they hold | Practice onboarding |
| GET | `/v1/practice/clients/{id}/audit-export` | Per-client audit trail (practice chain entries + the client's own audit log) with whole-chain verification | Practice onboarding |
| GET | `/v1/practice/audit/verify` | Recompute the practice's hash chain (partners) | Practice onboarding |
| POST | `/v1/practice/clients/{id}/working-papers` | Prepare a working paper: an immutable, hashed snapshot of the client ledger at a period end | Practice onboarding |
| GET | `/v1/practice/clients/{id}/working-papers` | Working papers for a client | Practice onboarding |
| GET | `/v1/practice/working-papers/{id}` | One working paper with integrity check | Practice onboarding |
| POST | `/v1/practice/working-papers/{id}/sign-off` | Four-eyes sign-off (reviewer/manager/partner, never the preparer). Refused if the ledger changed since the snapshot. Immutable after. | Practice onboarding |
| POST | `/v1/practice/learning/derive` | Re-derive learned rules from reviewer corrections. Firm-wide rules need 2+ clients to agree. Disabled rules stay disabled. | Practice intelligence |
| GET | `/v1/practice/rules` | Learned rules visible to me (firm-wide rules + rules of clients I can see), with provenance | Practice intelligence |
| POST | `/v1/practice/rules/{id}/{action}` | Disable or re-enable a learned rule (managers) | Practice intelligence |
| GET | `/v1/practice/clients/{id}/suggestions` | Explain unreviewed items: current AI category vs learned-rule suggestion, with reason codes and evidence | Practice intelligence |
| GET | `/v1/practice/clients/{id}/anomalies` | Explainable anomalies for a client (duplicates, missing receipts, unusual VAT, round sums, weekend postings) | Practice intelligence |
| POST | `/v1/practice/clients/{id}/anomalies/dismiss` | Dismiss one anomaly with a note (audited) | Practice intelligence |
| GET | `/v1/practice/anomalies` | Anomaly counts by client and severity across my clients (last 12 months) | Practice intelligence |
| GET | `/v1/practice/eval` | Accuracy harness: how often AI categories survive accountant review, by month, client and confidence band | Practice intelligence |
| GET | `/v1/practice/drift` | Drift alerts: accuracy drop vs baseline, overconfidence, QA failure rate | Practice intelligence |
| POST | `/v1/practice/assistant` | Ask about your clients. Rules-based intent routing first, then a MOCK LLM router that may only pick an intent. Answers are computed from ledger data you can see, with citations. | Practice intelligence |
| GET | `/v1/practice/integrations` | What integrations exist and how real each one is (real / mock / interface) | Practice integrations |
| POST | `/v1/practice/clients/{id}/integrations/{provider}/sync` | Pull transactions from a client's ledger (MOCK adapter) into Autopilot via the normal dedupe + categorisation pipeline | Practice integrations |
| GET | `/v1/practice/usage` | This month's metered usage vs plan caps (plans are placeholders; nothing is billed) | Practice integrations |
| POST | `/v1/portal/session` | Exchange a single-use magic token for an 8-hour portal session (mock magic-link flow; no email) | Client portal |
| POST | `/v1/portal/logout` | End this portal session | Client portal |
| GET | `/v1/portal/me` | Who I am, my business and my practice, with counts of things waiting for me | Client portal |
| GET | `/v1/portal/queries` | Questions from my accountant | Client portal |
| POST | `/v1/portal/queries/{id}/answer` | Answer an open query (emits query.answered; the practice sees it in its queue) | Client portal |
| GET | `/v1/portal/document-requests` | Documents my accountant needs from me | Client portal |
| POST | `/v1/portal/document-requests/{id}/upload` | Upload the requested document (raw body; PDF/image/CSV/XLSX up to 10 MB; scanned; stored privately) | Client portal |
| GET | `/v1/portal/engagements` | Engagement letters sent to me | Client portal |
| POST | `/v1/portal/engagements/{id}/accept` | Accept a letter. The client echoes the sha256 of the text they read, which must match the frozen hash. | Client portal |
| GET | `/v1/me` | Current principal | Account |
| GET | `/v1/tenant` | Current tenant | Account |
| PATCH | `/v1/tenant` | Update VAT settings | Account |
| GET | `/v1/users` | List users | Account |
| POST | `/v1/users` | Add a user | Account |
| POST | `/v1/uploads/bank-csv` | Upload a bank statement CSV (creates a job and queues the pipeline) | Ingestion |
| POST | `/v1/uploads/receipt` | Upload a receipt (PDF/image). Optional x-receipt-* headers carry known totals until OCR lands. | Ingestion |
| GET | `/v1/transactions` | List transactions | Transactions |
| PATCH | `/v1/transactions/{id}` | Manually categorise (posts reversing + new journal) | Transactions |
| GET | `/v1/categories` | Chart of accounts | Categories |
| POST | `/v1/categories` | Add a category | Categories |
| GET | `/v1/rules` | Categorisation rules | Categories |
| POST | `/v1/rules` | Add a rule | Categories |
| GET | `/v1/ledger/trial-balance` | Trial balance (must net to zero) | Ledger |
| GET | `/v1/ledger/journals` | Journals | Ledger |
| GET | `/v1/invoices` | List invoices | Invoices |
| POST | `/v1/invoices` | Create a draft invoice (sequential numbering) | Invoices |
| POST | `/v1/invoices/{id}/status` | Change status (draft→sent→paid, or void). Does not email anyone. | Invoices |
| GET | `/v1/invoices/{id}/pdf` | Render the invoice as PDF (A4, pdf-lib) | Invoices |
| POST | `/v1/vat/drafts` | Compute and store a DRAFT VAT return (unverified rates, never submitted) | VAT |
| GET | `/v1/vat/drafts` | List VAT drafts | VAT |
| GET | `/v1/sa/summary` | DRAFT self-employment summary | Self Assessment |
| GET | `/v1/exceptions` | Exceptions queue | Review |
| POST | `/v1/exceptions/{id}/resolve` | Approve, override (re-categorise) or dismiss an exception | Review |
| GET | `/v1/jobs` | Jobs | Jobs |
| GET | `/v1/jobs/{id}` | Job with event timeline | Jobs |
| POST | `/v1/jobs/{id}/rerun` | Re-queue a job (idempotent stages) | Jobs |
| GET | `/v1/billing/events` | Outcome/billing events | Billing |
| GET | `/v1/export/transactions.csv` | Transactions as CSV | Export |
| GET | `/v1/export/ledger.json` | Journals with lines as JSON | Export |
| GET | `/v1/events/catalog` | Versioned event catalog | Events |
| GET | `/v1/events` | Event log (newest first); filter by type or entity.* | Events |
| GET | `/v1/events/{id}` | One event | Events |
| GET | `/v1/activity` | Audit timeline (who did what, newest first) | Events |
| POST | `/v1/webhooks` | Create endpoint (secret returned once) | Webhooks |
| GET | `/v1/webhooks` | List endpoints | Webhooks |
| GET | `/v1/webhooks/{id}` | Get endpoint | Webhooks |
| PATCH | `/v1/webhooks/{id}` | Update endpoint (optimistic concurrency via version) | Webhooks |
| DELETE | `/v1/webhooks/{id}` | Delete endpoint (soft) | Webhooks |
| POST | `/v1/webhooks/{id}/rotate-secret` | Rotate signing secret (old one valid for 24h) | Webhooks |
| GET | `/v1/webhooks/{id}/deliveries` | Delivery log | Webhooks |
| POST | `/v1/webhooks/{id}/deliveries/{deliveryId}/replay` | Replay a delivery now | Webhooks |
| POST | `/v1/webhooks/{id}/test` | Send a signed test ping to this endpoint | Webhooks |
| GET | `/v1/automations/templates` | Starter templates | Automations |
| POST | `/v1/automations` | Create automation (JSON definition) | Automations |
| GET | `/v1/automations` | List automations | Automations |
| POST | `/v1/automations/from-template` | Create from a template | Automations |
| GET | `/v1/automations/{id}` | Get automation | Automations |
| PUT | `/v1/automations/{id}` | Replace definition (requires current version) | Automations |
| DELETE | `/v1/automations/{id}` | Soft-delete | Automations |
| POST | `/v1/automations/{id}/restore` | Restore a soft-deleted automation | Automations |
| POST | `/v1/automations/{id}/dry-run` | Test an automation against a stored event or a sample payload (no side effects) | Automations |
| GET | `/v1/automations/{id}/runs` | Run history | Automations |
| POST | `/v1/api-keys` | Create a scoped API key (shown once) | API keys |
| GET | `/v1/api-keys` | List keys (never returns secrets) | API keys |
| POST | `/v1/api-keys/{id}/rotate` | Rotate: new key now, old key valid 24h | API keys |
| DELETE | `/v1/api-keys/{id}` | Revoke immediately | API keys |
| GET | `/v1/security/key-policy` | Tenant API key policy | API keys |
| PUT | `/v1/security/key-policy` | Set the API key policy (applies to keys created or rotated from now on) | API keys |
| POST | `/v1/triggers` | Create an inbound webhook trigger (secret shown once) | Automations |
| GET | `/v1/triggers` | List inbound triggers | Automations |
| DELETE | `/v1/triggers/{id}` | Revoke trigger | Automations |
| GET | `/v1/search` | Full-text search over transactions and invoices | Search |
| POST | `/v1/transactions/bulk-categorise` | Categorise up to 200 transactions; partial success, per-item results | Transactions |
| GET | `/v1/invoices/{id}` | Get invoice (ETag; send If-None-Match for 304) | Invoices |
| PATCH | `/v1/invoices/{id}` | Edit a draft invoice (If-Match or version required) | Invoices |
| DELETE | `/v1/invoices/{id}` | Soft-delete a draft or void invoice | Invoices |
| POST | `/v1/invoices/{id}/restore` | Restore a soft-deleted invoice | Invoices |
| GET | `/v1/usage` | This month's metered usage vs plan quota | Billing |
| GET | `/v1/flags` | Feature flags effective for this tenant | Account |
| GET | `/v1/realtime` | Live event stream (SSE, or WebSocket with Upgrade); ?types=transaction.* | Events |
| POST | `/v1/books/imports/statement` | Import a bank statement (OFX/QIF/MT940/CSV) or a Xero/QuickBooks/FreshBooks export; exact duplicates skipped, probable ones reported | Books |
| GET | `/v1/books/rules/suggestions` | Rules learned from your corrections (not yet applied) | Books |
| POST | `/v1/books/rules/learn` | Apply learned rules (owner); returns the rules created | Books |
| GET | `/v1/books/recurring` | Recurring payments and income (subscriptions, rent, DDs) | Books |
| GET | `/v1/books/forecast` | Cash forecast and runway from recurring flows and recent history | Books |
| GET | `/v1/books/spikes` | Categories whose spend jumped vs the trailing 3-month median | Books |
| GET | `/v1/books/reports/pnl` | Profit and loss for a period | Books |
| GET | `/v1/books/reports/balance-sheet` | Balance sheet at a date | Books |
| GET | `/v1/books/reports/cash-flow` | Cash flow (direct method) for a period | Books |
| GET | `/v1/books/reports/sa103` | SA103-style expense summary (UNVERIFIED mapping) | Books |
| POST | `/v1/books/calculators/mileage` | Mileage allowance estimate (from body, or this tax year's mileage log) | Books |
| POST | `/v1/books/calculators/home-office` | Home office: flat rate vs actual proportion | Books |
| POST | `/v1/books/calculators/aia` | Annual Investment Allowance estimate | Books |
| GET | `/v1/books/tax-estimate` | Tax pot estimate for a tax year from the ledger (UNVERIFIED rates; not advice) | Books |
| GET | `/v1/books/deadlines` | Upcoming SA, VAT and MTD deadlines (UNVERIFIED dates; reminders are events only) | Books |
| GET | `/v1/books/mileage-trips` | Mileage log | Books |
| POST | `/v1/books/mileage-trips` | Log a business trip | Books |
| GET | `/v1/invoices/{id}/balance` | Balance with payments and credit notes | Invoices |
| POST | `/v1/invoices/{id}/payments` | Record a full or partial payment (overpayment rejected) | Invoices |
| POST | `/v1/invoices/{id}/credit-notes` | Issue a credit note (≤ outstanding; VAT reversed proportionally) | Invoices |
| POST | `/v1/invoices/{id}/payment-link` | Create a payment link via the configured provider (MOCK only; nothing is charged or sent) | Invoices |
| POST | `/v1/invoices/{id}/currency` | Set a draft invoice's currency; stores the FX rate to GBP from the provider (MOCK rates) | Invoices |
| GET | `/v1/receivables/aged` | Aged debtors (current, 1-30, 31-60, 61-90, 90+ days overdue) | Invoices |
| POST | `/v1/receivables/reminders/run` | Emit invoice.reminder_due events for unpaid invoices (no emails are sent) | Invoices |
| POST | `/v1/recurring-invoices` | Create a recurring invoice schedule (issues drafts; never sends) | Invoices |
| GET | `/v1/recurring-invoices` | Recurring schedules | Invoices |
| POST | `/v1/recurring-invoices/run` | Issue any due drafts (idempotent per date; catch-up capped at 12) | Invoices |
| POST | `/v1/extract/text` | Extract receipt/invoice fields from text (OCR/PDF text). Low confidence → needsReview | Extraction |
| POST | `/v1/extract/documents/{id}` | OCR a stored receipt (MOCK OCR engine) and extract fields; stores the result on the document for review | Extraction |
| GET | `/v1/mtd/obligations` | Quarterly obligations for a tax year (MOCK gateway) | MTD (mock) |
| POST | `/v1/mtd/quarterly-updates/preview` | Build the quarterly update from the ledger without submitting | MTD (mock) |
| POST | `/v1/mtd/quarterly-updates` | Submit a quarterly update to the MOCK gateway (owner; confirm required). Never reaches HMRC | MTD (mock) |
| GET | `/v1/mtd/submissions` | Mock submissions history | MTD (mock) |
| GET | `/v1/comments` | Comments on a record | Collaboration |
| POST | `/v1/comments` | Comment on any record; @email mentions notify tenant members | Collaboration |
| POST | `/v1/comments/{id}/resolve` | Resolve a comment thread item | Collaboration |
| GET | `/v1/periods/closes` | Period close requests and sign-offs | Collaboration |
| POST | `/v1/periods/closes` | Request sign-off to close a period (notifies accountants and owners) | Collaboration |
| POST | `/v1/periods/closes/{id}/decision` | Approve or reject a close (accountant or owner; never the requester) | Collaboration |
| GET | `/v1/notifications` | My notifications (newest first) | Notifications |
| POST | `/v1/notifications/{id}/read` | Mark one read | Notifications |
| POST | `/v1/notifications/read-all` | Mark all read | Notifications |
| GET | `/v1/notifications/preferences` | My notification preferences (default on) | Notifications |
| PUT | `/v1/notifications/preferences` | Update my preferences | Notifications |
| GET | `/v1/me/memberships` | Businesses I belong to (switch with the x-tenant-id header) | Account |
| GET | `/v1/privacy/retention` | Data retention policy (UNVERIFIED placeholders) | Privacy |
| POST | `/v1/privacy/dsar` | Subject access request: everything held about an email in this tenant | Privacy |
| POST | `/v1/privacy/erasure` | Erase or pseudonymise a person's data; accounting records are retained (legal obligation) and reported | Privacy |
| POST | `/v1/privacy/consents` | Record a consent grant or withdrawal (append-only log) | Privacy |
| GET | `/v1/privacy/consents` | Current consent state per subject and purpose (latest record wins) plus history | Privacy |
| GET | `/v1/privacy/export` | Full tenant data export (portability), JSON; document files are referenced by key | Privacy |
| POST | `/v1/assistant/ask` | Ask a question about your books; grounded answer with citations | Assistant |
| GET | `/v1/assistant/suggestions` | Example questions | Assistant |
| GET | `/v1/onboarding` | Setup checklist computed from your data | Onboarding |
| POST | `/v1/onboarding/sample-data` | Load clearly-labelled synthetic sample transactions (only into an empty account) | Onboarding |
| DELETE | `/v1/onboarding/sample-data` | Remove sample transactions (and anything linked to them) | Onboarding |
| GET | `/v1/bank-feeds/accounts` | Accounts available from the bank-feed provider (MOCK provider, synthetic) | Bank feeds |
| POST | `/v1/bank-feeds/connections` | Connect a provider account (mock) | Bank feeds |
| GET | `/v1/bank-feeds/connections` | Bank-feed connections | Bank feeds |
| POST | `/v1/bank-feeds/connections/{id}/sync` | Pull new transactions since the last sync (de-duplicated; first sync covers 90 days) | Bank feeds |
| DELETE | `/v1/bank-feeds/connections/{id}` | Disconnect (keeps imported transactions) | Bank feeds |
| GET | `/v1/ops/summary` | Operational health for this business | Ops |
| GET | `/v1/admin/overview` | Operator-only cross-tenant aggregates (no PII); requires ADMIN_EMAILS | Ops |
| POST | `/v1/review-projects` | Create a review project in one environment (owner only; API keys cannot create projects) | Agent review |
| GET | `/v1/review-projects` | List review projects | Agent review |
| POST | `/v1/review-projects/{id}/rotate-callback-secret` | Replace the project's callback signing secret (owner only; shown once). Callbacks sent after this use the new secret. | Agent review |
| POST | `/v1/review-projects/{id}/policies` | Save a new immutable policy version (draft). Unsafe rules (auto-approve without confidence, critical auto-approve) are refused. | Agent review |
| GET | `/v1/review-projects/{id}/policies` | List policy versions (newest first) | Agent review |
| POST | `/v1/review-projects/{id}/policies/replay` | Time-travel replay: re-run past requests against a candidate policy (a document or a saved version) and diff the outcomes | Agent review |
| POST | `/v1/review-projects/{id}/policies/{version}/activate` | Activate a version for all traffic, or as a canary for canaryPercent of new requests. Refused (409 unsafe_policy) if replaying recent history shows it would auto-approve anything a human rejected or edited, unless force is set. | Agent review |
| PUT | `/v1/review-groups/{name}` | Set the members of a reviewer group (owner only). Requests routed to a group can only be decided by its members or an owner. | Agent review |
| GET | `/v1/review-groups` | List reviewer groups and members | Agent review |
| POST | `/v1/agent-reviews` | Ask for a human decision. The project's policy routes it (auto-approve, human, four-eyes or reject). Send Idempotency-Key: a retry with the same key and body returns the original request (200); the same key with a different body is 409. | Agent review |
| GET | `/v1/agent-reviews` | List review requests (newest first), filterable by project, status, risk, group and externalId | Agent review |
| POST | `/v1/agent-reviews/simulate` | Dry run: how would this request be routed by the live policy (or a draft document)? Nothing is stored. | Agent review |
| GET | `/v1/agent-reviews/{id}` | Get a review request with its decisions | Agent review |
| POST | `/v1/agent-reviews/{id}/decisions` | Record a decision: approve, reject (veto), edit (replaces the payload; earlier approvals stop counting) or escalate. Routed requests need a member of the group (or an owner). | Agent review |
| POST | `/v1/agent-reviews/{id}/cancel` | Cancel a pending request (requester only) | Agent review |
| GET | `/v1/agent-reviews/{id}/callbacks` | Callback delivery log for a request | Agent review |
| POST | `/v1/agent-reviews/{id}/callbacks/redeliver` | Redeliver the request's callbacks now (including dead or already-succeeded ones). Receivers dedupe by callback id. | Agent review |
| GET | `/v1/agent-reviews/{id}/wait` | Long-poll: returns as soon as the request is final, or after timeoutSeconds with its current state (check status; call again to keep waiting). | Agent review |
| GET | `/v1/agent-reviews/{id}/stream` | Server-sent events: `review` on every state change, then `end` (reason final | timeout). maxSeconds 1..55 (default 55); reconnect to continue. | Agent review |
| GET | `/v1/agent-reviews/{id}/audit` | Hash-chained audit trail for a request, with a full integrity check | Agent review |
| GET | `/v1/agent-reviews/{id}/receipt` | Ed25519-signed decision receipt (final requests with a verified trail only); verifiable offline | Agent review |
| GET | `/v1/agent-reviews/{id}/evidence` | Self-contained evidence pack: request, decisions, ledger, integrity, policy document, callbacks, receipt, public keys | Agent review |
| GET | `/v1/agent-review/receipt-keys` | Public keys for verifying decision receipts (current first, then retired) | Agent review |
| GET | `/v1/agent-review/audit/export` | Ledger entries after `since` as NDJSON (SIEM ingestion). Content-free: payloads appear only as hashes. Page with the last line's `at`. | Agent review |
| PUT | `/v1/review-projects/{id}/retention` | Set how long final requests keep their content (null = forever). Held requests are never redacted. | Agent review |
| POST | `/v1/agent-reviews/{id}/legal-hold` | Place a legal hold | Agent review |
| DELETE | `/v1/agent-reviews/{id}/legal-hold` | Release a legal hold | Agent review |
| POST | `/v1/agent-reviews/{id}/redact` | Erase a final request's content now (e.g. an erasure request). Refused under legal hold. The hash chain is kept. | Agent review |
| GET | `/v1/agent-review/usage` | This month's agent review usage vs plan quota | Agent review |
| GET | `/v1/agent-review/analytics/reviewers` | Reviewer quality: latency, approve rates, co-reviewer disagreement and rubber-stamp signals | Agent review |
| GET | `/v1/review-projects/{id}/suggestions` | Learn when to stop asking: guarded auto-approve rule suggestions with a shadow replay (draft only) | Agent review |
| GET | `/v1/agent-review/analytics/outcomes` | Cost, latency and outcome analytics per action (cost only from your own reviewer-cost inputs) | Agent review |
| GET | `/v1/review-projects/{id}/regulator-pack` | Regulator-style evidence pack for a period: control statements, policies, outcomes, reviewers, verified trails; signed | Agent review |
| GET | `/v1/agent-review/events` | Change feed of review requests visible to the caller, oldest first after `cursor` (omit it to get the head cursor only). No payloads. | Agent review |
| GET | `/v1/agent-review/events/stream` | Server-sent events: `change` per request change (id = resume cursor; honours Last-Event-ID or `cursor`), then `end` after maxSeconds (1..55, default 55). Reconnect to continue. | Agent review |
| GET | `/v1/review-projects/{id}/business-hours` | The project's business-hours calendar (null = none; business-clock rules then fall back to wall time, flagged) | Agent review |
| PUT | `/v1/review-projects/{id}/business-hours` | Set or clear (null) the business-hours calendar. Applies to requests created afterwards. | Agent review |
| POST | `/v1/review-delegations` | Delegate your review duties (owners may delegate for anyone) to another reviewer for up to 90 days. Replaces your current delegation. | Agent review |
| GET | `/v1/review-delegations` | Delegations: owners see all; reviewers see the ones from or to them | Agent review |
| DELETE | `/v1/review-delegations/{id}` | End a delegation now (the delegator or an owner) | Agent review |
| GET | `/v1/review-projects/{id}/templates` | Action templates for a project | Agent review |
| PUT | `/v1/review-projects/{id}/templates/{action}` | Create or replace the template for an action. New requests whose payload breaks the schema get 422 payload_invalid. | Agent review |
| DELETE | `/v1/review-projects/{id}/templates/{action}` | Remove an action template | Agent review |
| POST | `/v1/notify/channels` | Add a reviewer notification channel (Slack, Teams, email or webhook) | Agent review |
| GET | `/v1/notify/channels` | List notification channels (secrets are never returned) | Agent review |
| DELETE | `/v1/notify/channels/{id}` | Delete a channel (pending deliveries are skipped) | Agent review |
| POST | `/v1/notify/channels/{id}/test` | Send a synthetic test message now | Agent review |
| PUT | `/v1/notify/channels/{id}/identities` | Link a Slack user id to a reviewer, so their button clicks decide as them | Agent review |
| POST | `/v1/notify/deliveries/{id}/retry` | Re-queue a dead delivery | Agent review |
| GET | `/v1/agent-reviews/{id}/notifications` | Notification delivery log for a request | Agent review |
| PUT | `/v1/agent-review/audit-sink` | Create or replace the tenant's audit sink (signed push of ledger entries, NDJSON or CEF) | Agent review |
| GET | `/v1/agent-review/audit-sink` | Audit sink status and cursor | Agent review |
| DELETE | `/v1/agent-review/audit-sink` | Remove the audit sink | Agent review |
| POST | `/v1/agent-review/audit-sink/resume` | Resume a paused sink from its cursor (nothing is skipped) | Agent review |
| POST | `/v1/agent-review/audit-sink/rotate-secret` | Rotate the signing secret (returned once) | Agent review |
| PUT | `/v1/sso/oidc` | Configure OIDC single sign-on (JIT provisioning, never as owner) | Account |
| GET | `/v1/sso/oidc` | OIDC connection (client secret is never returned) | Account |
| DELETE | `/v1/sso/oidc` | Remove SSO and revoke every SSO session | Account |
| POST | `/v1/sso/logout` | Revoke all of the caller's SSO sessions | Account |
| GET | `/v1/roles` | List custom roles | Account |
| POST | `/v1/roles` | Create a custom role (permissions + project/environment/risk conditions) | Account |
| PUT | `/v1/roles/{id}` | Replace a custom role (takes effect on the next request) | Account |
| DELETE | `/v1/roles/{id}` | Delete an unassigned custom role | Account |
| PUT | `/v1/users/{id}/custom-role` | Assign (or clear with null) a user's custom role. Owners cannot be narrowed. | Account |
