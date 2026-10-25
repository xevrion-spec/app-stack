-- A8c: custom roles for agent review (RBAC permissions + ABAC conditions on project, environment and risk).
create table if not exists custom_roles (
  tenant_id text not null references tenants(id),
  id text not null,
  name text not null,
  permissions_json text not null,
  projects_json text,
  environments_json text,
  max_risk text check (max_risk is null or max_risk in ('low', 'medium', 'high', 'critical')),
  created_at text not null,
  updated_at text not null,
  primary key (tenant_id, id),
  unique (tenant_id, name)
);
alter table users add column custom_role_id text;
