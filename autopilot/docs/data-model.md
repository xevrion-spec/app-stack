# Data model (D1, `migrations/0001_init.sql`)
| Table | Purpose |
|---|---|
| tenants | A customer business (sole trader / micro). VAT flags, plan |
| users | People in a tenant; role owner/accountant/staff |
| jobs | A unit of work (e.g. `vat_quarter`, `monthly_books`, `sa_prep`) with QA score |
| job_events | Stage transitions with Langfuse trace id |
| documents | R2 object pointers + extracted JSON |
| transactions | Bank lines / invoices in integer pence |
| ledger_entries | Categorised double-entry-ish lines with VAT, confidence, method (rule/llm/dify/human) |
| vat_returns | Draft/approved 9-box JSON; submission receipt when MTD is live |
| reviews | Human decisions |
| exceptions | Open items needing a human |
| audit_log | Append-only record of every action |
| billing_events | Outcome-based billing signals |
Money is integer pence. Dates ISO-8601. Soft rules: never delete financial rows; correct via new entries.
