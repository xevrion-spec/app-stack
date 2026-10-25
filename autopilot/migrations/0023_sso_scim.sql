-- A8: tenant OIDC SSO (JIT provisioning, revocable sessions) + SCIM 2.0 user lifecycle.
create table if not exists sso_connections (
  tenant_id text primary key references tenants(id),
  issuer text not null,
  client_id text not null,
  client_secret text not null,
  authorization_endpoint text not null,
  token_endpoint text not null,
  jwks_uri text not null,
  allowed_domains_json text not null default '[]',
  default_role text not null default 'reviewer' check (default_role in ('reviewer', 'accountant')),
  created_by text not null,
  updated_at text not null
);
create table if not exists sso_sessions (
  id text primary key,
  tenant_id text not null references tenants(id),
  email text not null,
  subject text not null,
  expires_at text not null,
  revoked_at text,
  created_at text not null
);
create index if not exists idx_sso_sessions_user on sso_sessions(tenant_id, email);
alter table users add column deactivated_at text;
alter table users add column external_id text;
