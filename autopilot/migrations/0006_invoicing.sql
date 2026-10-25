-- 0006 invoicing upgrades. ADDITIVE ONLY.
create table if not exists invoice_payments (
  id text primary key, tenant_id text not null references tenants(id), invoice_id text not null references invoices(id),
  amount_pence integer not null check (amount_pence > 0), paid_date text not null, transaction_id text, method text,
  created_by text, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create index if not exists idx_invoice_payments on invoice_payments (tenant_id, invoice_id);
create table if not exists credit_notes (
  id text primary key, tenant_id text not null references tenants(id), invoice_id text not null references invoices(id),
  number text not null, issue_date text not null, net_pence integer not null, vat_pence integer not null,
  gross_pence integer not null check (gross_pence > 0), reason text, created_by text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), unique (tenant_id, number));
create table if not exists recurring_invoices (
  id text primary key, tenant_id text not null references tenants(id), template_json text not null,
  cadence text not null check (cadence in ('weekly','monthly','quarterly','yearly')), interval_n integer not null default 1,
  next_issue_date text not null, end_date text, payment_terms_days integer not null default 30, active integer not null default 1,
  created_by text, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create table if not exists invoice_reminders (
  id text primary key, tenant_id text not null references tenants(id), invoice_id text not null references invoices(id),
  kind text not null, due_on text not null, emitted_at text not null, unique (tenant_id, invoice_id, kind));
alter table invoices add column currency text default 'GBP';
alter table invoices add column fx_rate_to_gbp real;
alter table invoices add column payment_link_url text;
alter table invoices add column recurring_id text;
