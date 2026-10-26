-- R4: per-project action templates (payload JSON schema + reviewer-facing title/instructions).
create table if not exists review_action_templates (
  tenant_id text not null references tenants(id),
  project_id text not null,
  action text not null,
  title text,
  instructions text,
  schema_json text not null,
  updated_by text not null,
  updated_at text not null,
  primary key (tenant_id, project_id, action)
);
