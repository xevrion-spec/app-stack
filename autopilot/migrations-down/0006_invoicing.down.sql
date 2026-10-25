-- Manual, confirmed rollback only (docs/runbook.md).
drop table if exists invoice_reminders;
drop table if exists recurring_invoices;
drop table if exists credit_notes;
drop table if exists invoice_payments;
alter table invoices drop column recurring_id;
alter table invoices drop column payment_link_url;
alter table invoices drop column fx_rate_to_gbp;
alter table invoices drop column currency;
