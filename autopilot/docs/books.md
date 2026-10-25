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
