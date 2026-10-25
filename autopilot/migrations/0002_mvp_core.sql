-- 0002 MVP core. ADDITIVE ONLY (no drops/renames) so it is safe on the live autopilot-db.
-- Rollback note: D1 has no down-migrations; to roll back, deploy code that ignores these tables/columns.
-- Dropping is a manual, confirmed operation (see docs/runbook.md).

alter table users add column access_subject text;            -- Cloudflare Access `sub` claim
alter table users add column display_name text;
alter table tenants add column flat_rate_percent real;          -- flat-rate scheme % (data, unverified)
alter table tenants add column vat_basis text default 'accrual'; -- accrual | cash
alter table transactions add column status text default 'new'; -- new | categorised | reconciled | excluded
alter table transactions add column category_code text;
alter table transactions add column confidence real;
alter table transactions add column fingerprint text;           -- dedupe key (date|amount|desc hash)
alter table transactions add column vat_rate_code text;
alter table transactions add column vat_pence integer default 0;
alter table transactions add column original_currency text;
alter table transactions add column original_amount_minor integer;
alter table documents add column size_bytes integer;
alter table documents add column content_type text;
alter table documents add column scan_status text default 'pending'; -- pending | clean | rejected
alter table exceptions add column reason_code text;
alter table exceptions add column subject_type text;
alter table exceptions add column subject_id text;
alter table exceptions add column resolution_json text;

create table if not exists categories (
  tenant_id text not null references tenants(id), code text not null, name text not null,
  kind text not null check (kind in ('income','expense','asset','liability','equity')),
  sa_box text, default_vat_rate_code text, created_at text default (datetime('now')),
  primary key (tenant_id, code));

create table if not exists category_rules (
  id text primary key, tenant_id text not null references tenants(id), pattern text not null,
  match_type text not null default 'contains' check (match_type in ('contains','prefix','exact','regex')),
  category_code text not null, vat_rate_code text, priority integer not null default 100,
  created_by text, created_at text default (datetime('now')));

create table if not exists journals (
  id text primary key, tenant_id text not null references tenants(id), entry_date text not null,
  memo text, source_type text, source_id text, created_by text, created_at text default (datetime('now')));

create table if not exists journal_lines (
  id text primary key, tenant_id text not null references tenants(id), journal_id text not null references journals(id),
  account_code text not null, debit_pence integer not null default 0 check (debit_pence >= 0),
  credit_pence integer not null default 0 check (credit_pence >= 0), vat_rate_code text,
  check (not (debit_pence > 0 and credit_pence > 0)));

create table if not exists invoices (
  id text primary key, tenant_id text not null references tenants(id), number text not null,
  customer_name text not null, customer_email text, issue_date text not null, due_date text not null,
  status text not null default 'draft' check (status in ('draft','sent','paid','void')),
  net_pence integer not null, vat_pence integer not null, gross_pence integer not null,
  lines_json text not null, paid_transaction_id text, created_at text default (datetime('now')),
  unique (tenant_id, number));

create table if not exists invoice_sequences (tenant_id text primary key references tenants(id), prefix text not null default 'INV-', next_value integer not null default 1);

create table if not exists idempotency_keys (
  tenant_id text not null, key text not null, method text not null, path text not null,
  status integer not null, response_json text not null, created_at text default (datetime('now')),
  primary key (tenant_id, key));

create unique index if not exists idx_txn_fingerprint on transactions(tenant_id, fingerprint);
create unique index if not exists idx_job_stage on job_events(job_id, stage, status);
create index if not exists idx_journal_tenant on journals(tenant_id, entry_date);
create index if not exists idx_jlines_journal on journal_lines(journal_id);
create index if not exists idx_rules_tenant on category_rules(tenant_id, priority);
create index if not exists idx_invoices_tenant on invoices(tenant_id, status);
create index if not exists idx_users_subject on users(access_subject);
