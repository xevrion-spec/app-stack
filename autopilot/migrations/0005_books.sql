-- 0005 books. ADDITIVE ONLY. Corrections feed learned rules; mileage log feeds the mileage calculator.
create table if not exists category_corrections (
  id text primary key, tenant_id text not null references tenants(id), transaction_id text,
  description text not null, category_code text not null, vat_rate_code text, amount_pence integer,
  created_by text, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create index if not exists idx_corrections_tenant on category_corrections (tenant_id, created_at);
create table if not exists mileage_trips (
  id text primary key, tenant_id text not null references tenants(id), trip_date text not null,
  miles real not null check (miles > 0), vehicle text not null check (vehicle in ('car_van','motorcycle','bicycle')),
  purpose text, created_by text, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create index if not exists idx_mileage_tenant on mileage_trips (tenant_id, trip_date);
alter table category_rules add column source text default 'manual'; -- manual | learned
alter table category_rules add column confidence real;
