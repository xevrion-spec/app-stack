# Collaboration, notifications, plans and privacy (V5)
| Endpoint | Who | What |
|---|---|---|
| `GET/POST /comments`, `POST /comments/{id}/resolve` | members | Comments on transaction/invoice/exception/journal/period_close/document/vat_return; @mentions notify |
| `GET/POST /periods/closes`, `POST /periods/closes/{id}/decision` | request: members; decide: accountant/owner (not the requester) | Approve, reject or reopen; approval locks transactions in the period |
| `GET /notifications?unread`, `POST /notifications/{id}/read`, `POST /notifications/read-all`, `GET/PUT /notifications/preferences` | self | In-app only |
| `GET /me/memberships` | self | Multi-business; switch with `x-tenant-id` |
| `/privacy/dsar`, `/privacy/erasure`, `/privacy/consents`, `/privacy/export`, `/privacy/retention` | owner | ADR 0020 |
Plans: `free`, `starter`, `pro`, `trial` (feature lists in `packages/platform/src/flags.ts`). MTD needs `mtd`, recurring invoices need `recurring_invoices`, payment links need `payment_links`, currency needs `multi_currency`. Migration 0008.
