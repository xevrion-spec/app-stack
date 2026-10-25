-- 0007 MTD (MOCK gateway only). ADDITIVE ONLY.
create table if not exists mtd_submissions (
  id text primary key, tenant_id text not null references tenants(id), period_key text not null,
  payload_json text not null, receipt_json text not null, gateway text not null, sandbox integer not null default 1,
  created_by text, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique (tenant_id, period_key));
