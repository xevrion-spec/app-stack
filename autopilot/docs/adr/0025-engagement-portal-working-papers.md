# ADR 0025 — Engagement, client portal (mock magic link) and working papers

Status: accepted (2026-10-25). Branch: feature/practice-copilot. Migration 0013 (+down).

## Decision

- **Engagement letters:** the letter text is stored with its sha256. A trigger freezes the text, hash, services and fees
  once the letter leaves draft. The client accepts in the portal by sending back the hash of the text they read; any
  mismatch is refused (409).
- **Authorisation records (64-8 style):** DATA ONLY. Autopilot makes no HMRC agent-services call. References (UTR, VRN,
  PAYE) are masked on write (last 3 characters kept); the full value is never stored. Only one active record per kind.
- **Document requests:** explicit titles or templates (year end, VAT quarter, onboarding), de-duplicated against open
  requests. Portal uploads are checked against a type allowlist, a 10 MB limit (declared and actual), the scan hook (still a
  STUB that marks every file clean), sha256 and a private R2 key under `portal/<tenant>/<request>/`.
- **Client portal auth (MOCK magic link):** a manager invites a contact. The single-use 256-bit magic token (15 min) is
  RETURNED TO STAFF in the API response for manual hand-over; nothing is emailed. It is exchanged once for an 8-hour
  session token. Only sha256 hashes are stored. Logout, revocation and client archiving all end access. `/v1/portal/*`
  skips staff identity entirely, so dev headers, Access JWTs and API keys never authenticate there. A portal session sees
  exactly one business at one practice.
- **Audit export:** per-client practice-chain entries plus the client's own audit log, as JSON or CSV (cells that look
  like formulas are neutralised), with whole-chain verification (`x-audit-chain-ok`). Partners can verify the chain on demand.
- **Working papers:** trial balance, bank reconciliation and VAT reconciliation snapshots, as canonical JSON plus sha256.
  Sign-off is four-eyes (never the preparer, and only signer roles), and is refused if the ledger changed since the snapshot or
  the stored hash no longer matches. Triggers make the snapshot immutable, and a signed-off paper cannot be updated or deleted.

## Not real

There is no email delivery, real virus scan, e-signature provider or HMRC authorisation API. These are swap-in points (M5 interfaces).
