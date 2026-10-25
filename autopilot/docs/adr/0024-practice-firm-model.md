# ADR 0024 — Practice (firm) model for the accountant co-pilot

Status: accepted (2026-10-25). Branch: feature/practice-copilot.

## Context

The 2026-10 benchmark scored Autopilot 2.7/10 as a sole-trader bookkeeping app. We are repositioning it as a co-pilot for UK
accounting and bookkeeping practices. That needs a firm that sees many client businesses, staff roles, and strict isolation.

## Decision

- New tables (migrations 0011, 0012, each with a down script): `practices`, `practice_staff`, `practice_clients`,
  `client_assignments`, `practice_audit`, plus workflow tables (review claims/log, close templates/checklists/items,
  client queries, task templates/tasks, time entries, billing records).
- Each client is an ordinary tenant. A tenant can belong to only ONE practice (unique index). Staff never get tenant
  memberships. All practice access goes through `PracticeDb`, which refuses SQL not scoped to `practice_id = ?1` and
  auto-binds ?1 = practice and ?2 = staff email.
- Roles: partner, manager and readonly see every client. Preparer and reviewer see only assigned clients
  (`clientScopeSql`). Out-of-scope or foreign clients return 404, never 403, so ids do not leak. Readonly can never write.
  API-key identities are refused on practice routes.
- Practice audit is hash-chained (sha256 over prev hash + fields). DB triggers block update/delete, and
  `verifyAuditChain` detects edited, deleted or reordered rows below the triggers.
- Bulk actions use a preview → confirm-token step, not the tenant-keyed idempotency middleware.
- Quotas per plan: trial 25 clients / 5 staff; practice 500/50; enterprise 5000/500. Plans are data only; no billing calls.
- Auto-approve rules have a hard confidence floor of 0.9, need an explicit category allowlist, and never approve
  9999/needs_review. Auto-approved items are QA-sampled deterministically (FNV-1a), at a rate configured per client.
- Deadlines are generated from configured obligations (VAT stagger, MTD ITSA, SA) and are always marked `verified:false`.

## Consequences

- Proven by `practice-api.test.ts`, `practice-lib.test.ts` and `practice-authz-matrix.test.ts` (every /v1/practice op ×
  anon, non-staff, 5 roles, other firm, plus cross-firm writes with valid bodies).
- Not real yet: no client portal or engagement records (M3), no email, no HMRC, no live bank feeds.
