# Books engine (`@xevrion/books`)

Pure functions; all amounts are integer pence. Tax and allowance outputs are **estimates on UNVERIFIED placeholder rates** (see ADR 0015).

| Area | Functions | Notes |
|---|---|---|
| Statement import | `detectFormat`, `parseOfx` (1.x SGML / 2.x XML), `parseQif` (UK day-first default), `parseMt940`, `readCsv` | Bad rows go to `rejected[]`; never throws on arbitrary input (property-tested) |
| Switching tools | `detectAccountingSource`, `parseAccountingExport` | Xero, QuickBooks (debit/credit), FreshBooks; keeps source category to seed rules |
| Duplicates | `findDuplicates` | Exact match on bank ref (FITID), or on same date+amount+text. Probable match on same amount, ±3 days and similar merchant. Each existing row is claimed only once |
| Recurring | `detectRecurring` | weekly → yearly cadences, amount variance, next expected date, confidence |
| Learning | `learnRules` | Corrections become per-tenant rules, with a half-life decay; conflicts suppress a rule |
| Reports | `profitAndLoss`, `balanceSheet`, `cashFlow`, `taxSummary` (SA103-style boxes) | Uses the code-range fallback when the chart has no account type |
| Forecast | `forecastCash` | Recurring flows plus the average of ad-hoc flows; gives runway, lowest balance and burn |
| Calculators | `mileageAllowance`, `homeOffice` (flat rate vs actual), `annualInvestmentAllowance` | Returns `verified:false` + workings |
| Tax pot | `estimateTax` | Trading allowance vs expenses, PA taper, bands, Class 4, payments on account, set-aside % |
| Deadlines | `saDeadlines`, `vatDeadlines`, `mtdQuarterlyDeadlines`, `upcoming`, `taxYearOf` | Data only; nothing is sent |

## API (`/v1/books`, reviewer+; API keys: `reports:read` for GET, `transactions:write` for imports/mileage/rules)
| Endpoint | What |
|---|---|
| `POST /imports/statement?source=auto\|bank\|xero\|quickbooks\|freshbooks&dryRun=` | Raw text body. Auto-detects the format. Exact duplicates (fingerprint) are skipped, probable ones reported, rejects listed. Audited and metered; queues the pipeline |
| `GET /rules/suggestions`, `POST /rules/learn` (owner) | Learned from `category_corrections` (written on every manual `PATCH /transactions/{id}`). Suppressed only when an identical rule exists |
| `GET /recurring`, `/forecast?horizonDays=`, `/spikes?month=` | Recurring series; cash forecast (bank balance from ledger 1200/1210); spend spikes vs 3-month median |
| `GET /reports/pnl\|cash-flow\|sa103?from&to`, `/reports/balance-sheet?asAt` | From journal lines plus the tenant chart. SA103 is `verified:false` |
| `POST /calculators/mileage\|home-office\|aia`, `GET /tax-estimate?taxYear` | Estimates with workings. **UNVERIFIED** |
| `GET /deadlines?today&days&vatFirstPeriodEnd&paymentsOnAccount` | SA + MTD always, VAT if registered. Data only |
| `GET/POST /mileage-trips` | Mileage log; feeds the mileage calculator when `miles` omitted |

Migration `0005_books.sql` (additive): `category_corrections`, `mileage_trips`, `category_rules.source/confidence`.

## Invoicing (V3)
- `GET /invoices/{id}/balance`, `POST /invoices/{id}/payments` (partial; overpayment → 409; settles to `paid`), `POST /invoices/{id}/credit-notes` (`CN-<number>-n`, VAT reversed proportionally, ≤ outstanding).
- `POST /invoices/{id}/payment-link` (mock provider), `POST /invoices/{id}/currency` (drafts; mock FX to GBP).
- `GET /receivables/aged`, `POST /receivables/reminders/run`: emits `invoice.reminder_due`. Only the latest due reminder fires, never a backlog, and each fires once.
- `POST/GET /recurring-invoices`, `POST /recurring-invoices/run`: issues drafts. Catch-up is capped at 12, a run is idempotent per period, and the schedule ends at `endDate`.
Migration `0006_invoicing.sql` (additive). ADR 0017.

## Extraction and MTD (V4, mock providers)
- `POST /extract/text`: `TextReceiptExtractor` (deterministic: vendor, date, total, VAT including "VAT 20% £2.00", currency, number, confidence, `needsReview`).
- `GET /mtd/obligations?taxYear`, `POST /mtd/quarterly-updates/preview`, `POST /mtd/quarterly-updates` (`confirm:true`, owner), `GET /mtd/submissions`. **Mock gateway only** (ADR 0018).
- `BankFeed` interface + `MockBankFeed` (contract-tested; no routes or live provider yet).
