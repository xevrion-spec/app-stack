-- Agent review layer A1: projects/environments, review requests, decisions; API keys can be bound to one project.
-- Additive only. snapshot_json holds the exact state-machine snapshot (packages/agent-review) so transitions are
-- replayed with the same rules the API enforces; status is denormalised for queue queries.
create table if not exists review_projects (
  id text primary key,
  tenant_id text not null references tenants(id),
  name text not null,
  environment text not null check (environment in ('development', 'staging', 'production')),
  policy_json text,
  created_by text not null,
  created_at text not null,
  archived_at text,
  unique (tenant_id, name, environment)
);
create table if not exists review_requests (
  id text primary key,
  tenant_id text not null references tenants(id),
  project_id text not null references review_projects(id),
  action text not null,
  payload_json text not null,
  current_payload_json text not null,
  context_json text,
  risk text not null check (risk in ('low', 'medium', 'high', 'critical')),
  confidence real,
  status text not null check (status in ('pending', 'escalated', 'approved', 'rejected', 'expired', 'cancelled')),
  required_approvals integer not null,
  snapshot_json text not null,
  requester text not null,
  external_id text,
  tags_json text not null default '[]',
  idempotency_key text,
  request_sha text not null,
  deadline_at text not null,
  decided_at text,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  unique (tenant_id, project_id, idempotency_key)
);
create index if not exists idx_rr_queue on review_requests(tenant_id, project_id, status, created_at);
create index if not exists idx_rr_deadline on review_requests(tenant_id, status, deadline_at);
create index if not exists idx_rr_external on review_requests(tenant_id, external_id);
create table if not exists review_decisions (
  id text primary key,
  tenant_id text not null references tenants(id),
  request_id text not null references review_requests(id),
  reviewer text not null,
  decision text not null check (decision in ('approve', 'reject', 'edit', 'escalate')),
  reason text,
  payload_version integer not null,
  payload_json text,
  created_at text not null
);
create index if not exists idx_rd_request on review_decisions(tenant_id, request_id, created_at);
alter table api_keys add column project_id text;
