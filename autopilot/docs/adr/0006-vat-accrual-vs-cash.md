# ADR 0006: VAT drafts: accrual uses invoices, cash uses bank receipts
Status: accepted (2026-10-25). Rules remain UNVERIFIED; outputs are drafts only and are never submitted.

- Standard and flat-rate schemes (accrual): sales are dated by invoice issue date (tax point). Issued invoices (sent/paid) become income lines; bank receipts the pipeline reconciled to those invoices are excluded, so nothing is counted twice. Bank income with no invoice (e.g. card payouts) still counts.
- Cash accounting: bank-dated receipts only; invoices are ignored.
- Purchases: input VAT only when evidenced (receipt or manual entry); otherwise not claimed and a warning is added.
Known limits: invoice-line VAT is recomputed from gross at the line rate (can differ by 1p from the invoice); partial payments and credit notes are not modelled; flat-rate first-year discount and limited-cost-trader test are not applied.
