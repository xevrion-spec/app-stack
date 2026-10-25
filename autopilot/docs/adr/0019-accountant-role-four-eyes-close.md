# ADR 0019: Accountant role, four-eyes period close, entitlements and seats

Status: Accepted (2026-10-25)

- New role `accountant`: everything a reviewer can do, plus signing off period closes. Owners can also sign off. The requester can never approve their own close (four-eyes).
- An approved close **locks** manual re-categorisation of transactions dated inside it (409) until it is reopened. Every step is audited and notifies the people involved.
- Plan entitlements (`PLAN_FEATURES`) gate features with 403 `plan_required`. Seats (`PLAN_SEATS`) cap non-owner users. Trial shows everything. **Plan names, prices and the split are placeholders for Henry to decide.**
- Comments attach to any record. `@email` mentions notify tenant members only, never outsiders and never the author. Notifications are in-app only, with per-kind opt-out.
