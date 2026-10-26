-- R3: business-hours calendars per project and time-boxed reviewer delegation (out of office).
alter table review_projects add column business_hours_json text;
create table if not exists review_delegations (
  tenant_id text not null references tenants(id),
  id text not null,
  from_email text not null,
  to_email text not null,
  starts_at text not null,
  ends_at text not null,
  reason text,
  created_by text not null,
  created_at text not null,
  revoked_at text,
  primary key (tenant_id, id)
);
create index if not exists idx_rdel_to on review_delegations(tenant_id, to_email, ends_at);
create index if not exists idx_rdel_from on review_delegations(tenant_id, from_email);
