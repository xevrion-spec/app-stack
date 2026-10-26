-- R1 reviewer notifications: channels (Slack / Teams / email / generic webhook), a per-message delivery outbox,
-- Slack user -> reviewer email links, and single-use nonces for one-click action tokens. Payloads are never copied
-- here: messages are rendered at send time from the (possibly redacted) request.
create table if not exists notify_channels (
  id text primary key,
  tenant_id text not null references tenants(id),
  kind text not null check (kind in ('slack', 'teams', 'email', 'webhook')),
  name text not null,
  url text not null,
  secret text not null,
  signing_secret text,
  project_id text,
  min_risk text not null default 'low' check (min_risk in ('low', 'medium', 'high', 'critical')),
  recipients_json text not null default '[]',
  active integer not null default 1,
  created_by text not null,
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_nc_tenant on notify_channels(tenant_id, active);
create table if not exists notify_deliveries (
  id text primary key,
  tenant_id text not null references tenants(id),
  channel_id text not null,
  request_id text not null,
  recipient text,
  status text not null check (status in ('pending', 'sent', 'dead', 'skipped')),
  attempt integer not null default 0,
  next_attempt_at text not null,
  response_status integer,
  last_error text,
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_nd_due on notify_deliveries(status, next_attempt_at);
create index if not exists idx_nd_request on notify_deliveries(tenant_id, request_id);
create table if not exists notify_identities (
  tenant_id text not null references tenants(id),
  channel_id text not null,
  external_id text not null,
  email text not null,
  created_at text not null,
  primary key (tenant_id, channel_id, external_id)
);
create table if not exists notify_action_nonces (
  tenant_id text not null references tenants(id),
  nonce text not null,
  request_id text not null,
  used_at text not null,
  primary key (tenant_id, nonce)
);
