-- V7: scheduler run log (idempotent daily jobs), bank-feed connections (mock provider), document retention marker. Additive only.
create table if not exists scheduler_runs (
  id text primary key, tenant_id text not null references tenants(id), job text not null, run_date text not null,
  status text not null, detail_json text, created_at text default (datetime('now')), finished_at text,
  unique (tenant_id, job, run_date));
create index if not exists idx_sched_date on scheduler_runs(run_date, status);
create table if not exists bank_feed_connections (
  id text primary key, tenant_id text not null references tenants(id), provider text not null, account_id text not null,
  account_name text, status text not null default 'active', synced_until text, created_by text,
  created_at text default (datetime('now')), unique (tenant_id, provider, account_id));
alter table documents add column purged_at text;
