# ADR 0020: UK GDPR tools: DSAR, erasure with retention holds, consent log, portability export

Status: Accepted (2026-10-25)

Owner-only endpoints under `/v1/privacy`:
- **DSAR** returns every record about an email.
- **Erasure** (`confirm: true`) deletes memberships, notifications and preferences. It pseudonymises comments and consents (`erased:<sha256 prefix>`), minimises invoice emails, and **retains** accounting records and the audit log under legal obligation, reporting what was retained and why. Owners cannot be erased.
- **Consent log** is append-only; the latest record wins.
- **Tenant export** returns JSON of every tenant table.

Requests are logged in `privacy_requests` with the subject hashed. Retention periods are **unverified placeholders** (`GET /privacy/retention`).
