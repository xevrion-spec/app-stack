# ADR 0023: Web V7 — command palette, forced themes, i18n scaffold, screens for V3–V7

Status: Accepted (2026-10-25)

## Decisions
- **Command palette** (Ctrl/Cmd+K): ARIA combobox + listbox, keyboard-first; lists the pages the user's role can see plus a theme switch. No new dependency.
- **Themes**: "system" follows `prefers-color-scheme`; "light"/"dark" set `data-theme` on `<html>` and persist in localStorage. Both themes pass axe (serious/critical) on every new screen.
- **i18n scaffold**: typed message keys (`src/i18n.ts`), en-GB source dictionary, pseudo-locale `en-XA` (`?lang=en-XA`) to find hard-coded strings. Navigation, palette, theme and footer use it; page copy migrates incrementally.
- **New screens**: Get started, Receivables (aged debtors, reminder check, recurring schedules), Reports (P&L, balance sheet, forecast, deadlines), Ask (assistant with sources), Team & close (notifications, four-eyes close: only owner/accountant see Approve, never the requester), Bank feeds (demo provider banner), Privacy (DSAR, confirmed erasure, export, consents, retention policy), Ops (tenant health; operator overview only when the API allows).
- **Role scoping fixes found while building the UI**: `GET /v1/onboarding` was accidentally owner-only (Hono `"/onboarding/*"` also matches `/onboarding`); now owner-only applies to sample data only. Reviewers/accountants may now **read** receivables (`/receivables/aged`); running reminders stays owner-only.

## Consequences
Bundle stays inside the budget. Remaining copy is English-only until a second locale is wanted.
