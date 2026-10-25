-- A9a: API key IP allowlists + tenant key policy (max lifetime, allowlist required).
alter table api_keys add column allowed_cidrs_json text;
create table if not exists key_policies (
  tenant_id text primary key references tenants(id),
  max_expiry_days integer check (max_expiry_days is null or max_expiry_days between 1 and 730),
  require_ip_allowlist integer not null default 0 check (require_ip_allowlist in (0, 1)),
  updated_by text not null,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
