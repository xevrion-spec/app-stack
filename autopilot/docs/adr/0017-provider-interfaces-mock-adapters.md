# ADR 0017: External providers behind interfaces, with mock adapters and contract tests only

Status: Accepted (2026-10-25)

## Context
Payment links, FX rates, OCR/extraction, HMRC MTD and bank feeds all need third-party providers. Choosing, contracting and paying
for them is Henry's decision, and live calls must not happen during this build.

## Decision
Each capability is a TypeScript interface (`PaymentLinkProvider`, `FxRateProvider`, and later `DocumentExtractor`, `MtdGateway`,
`BankFeed`) with a deterministic **mock** adapter that is clearly labelled (`mock`, `mock-ecb`) and returns synthetic data. A shared
contract test suite (`fxContract`, `payContract`, …) states the behaviour every adapter must have. The API reads the adapter
through a module seam (`__setInvoiceProviders`); swapping in a real adapter is a separate change that needs approval and secrets.
Customer communications (reminders) are **events only** (`invoice.reminder_due`); delivery is for webhooks, automations or a future
approved mail provider.

## Consequences
The features work end to end on synthetic data and are testable now. Real adapters need provider choice, credentials, a DPA
and pricing sign-off.
