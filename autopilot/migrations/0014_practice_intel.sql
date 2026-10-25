-- Practice co-pilot M4: learned rules with provenance (practice-wide or per client) and anomaly dismissals. Additive.
create table if not exists practice_rules (
  practice_id text not null references practices(id),
  id text not null primary key,
  scope text not null check (scope in ('practice','client')),
  tenant_id text references tenants(id),
  pattern text not null,
  category_code text not null,
  direction text not null default 'any',
  confidence real not null,
  evidence integer not null,
  conflicting integer not null default 0,
  clients integer not null default 1,
  provenance_json text not null,
  status text not null default 'active' check (status in ('active','disabled')),
  derived_at text not null,
  disabled_by text
);
create unique index if not exists idx_practice_rules_key on practice_rules(practice_id, scope, coalesce(tenant_id, ''), pattern);
create table if not exists anomaly_dismissals (
  practice_id text not null references practices(id),
  tenant_id text not null references tenants(id),
  transaction_id text not null,
  code text not null,
  note text,
  dismissed_by text not null,
  dismissed_at text not null,
  primary key (practice_id, tenant_id, transaction_id, code)
);
