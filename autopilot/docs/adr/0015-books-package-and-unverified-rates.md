# ADR 0015: `@xevrion/books` analytics package and config-driven UNVERIFIED UK rates

Status: Accepted (2026-10-25)

## Context
Customers need more than categorisation: importing from any bank or tool, de-duplication, recurring detection, learning from
their corrections, reports, cash forecasting and tax set-aside estimates. Tax figures change every year and we have not had them
checked by a qualified adviser.

## Decision
- A new pure-TypeScript package `packages/books` holds this logic. It has no I/O, depends only on `@xevrion/pipeline` (for money
  helpers), and works on integer pence.
- All UK rates, thresholds and deadlines live in `packages/domain-uk-tax/uk-rates.unverified.json` with `verified: false`.
  Every estimate returns `verified: false` and `UNVERIFIED_NOTICE`, and lists its workings. Nothing here files, submits or advises.
- Deadlines are dated data only. Reminders are emitted as events; sending is a separate, consented, provider-gated step.

## Consequences
- Logic is fast to test (unit, property-based and mutation) and reusable from the API, workers and the web app.
- Before any figure is shown as fact, someone must verify the rates file and flip `verified`. That needs a decision from Henry plus an accountant review.
