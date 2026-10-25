# ADR 0021: Grounded "ask your books" assistant and sample-data onboarding

Status: Accepted (2026-10-25)

## Context
Owners want plain-English answers ("what did I spend on travel in July?", "who owes me?"). Free-form LLM answers about money are a correctness and trust risk.

## Decision
- Questions are parsed into a fixed intent set (spend, income, profit, top_merchants, outstanding_invoices, recurring, runway, tax_estimate, vat) plus a period, by a deterministic rules parser (`parseQuestion`).
- An optional `LlmRouter` may only map a question to one of these intents; it never produces figures. Only `MockLlmRouter` exists; no real model provider is wired.
- Every figure comes from this tenant's ledger/transactions via existing report code, and each answer carries citations (transactions, invoices, series, or report endpoints). Unknown questions return `grounded: false` with suggestions — no guessing.
- Tax answers always include the UNVERIFIED notice; rates are unverified.
- Gated by the `assistant` plan feature and owner/reviewer roles; every question is audited.
- Onboarding: a 7-step checklist computed from data; owners can load 9 synthetic `source='sample'` transactions into an empty account (409 otherwise) and remove them, including any journals, reversals, ledger entries, exceptions and tags derived from them.

## Consequences
Answers are reproducible and testable; paraphrase coverage is limited until a real router is approved. No secrets or external calls.
