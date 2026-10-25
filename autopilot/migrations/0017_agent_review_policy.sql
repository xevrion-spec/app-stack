-- Agent review layer A2: versioned policy-as-code (immutable versions, one active + optional canary per project),
-- reviewer groups, and the routing decision recorded on each request (so any request can be replayed later).
-- Additive only.
create table if not exists review_policies (
  id text primary key,
  tenant_id text not null references tenants(id),
  project_id text not null references review_projects(id),
  version integer not null,
  description text,
  document_json text not null,
  sha256 text not null,
  status text not null check (status in ('draft', 'active', 'canary', 'retired')),
  canary_percent integer,
  created_by text not null,
  created_at text not null,
  activated_at text,
  unique (tenant_id, project_id, version)
);
create index if not exists idx_rp_status on review_policies(tenant_id, project_id, status);
create table if not exists review_group_members (
  tenant_id text not null references tenants(id),
  group_name text not null,
  email text not null,
  added_by text not null,
  added_at text not null,
  primary key (tenant_id, group_name, email)
);
alter table review_requests add column policy_version integer;
alter table review_requests add column policy_rule_id text;
alter table review_requests add column route_outcome text;
alter table review_requests add column review_group text;
alter table review_requests add column escalate_at text;
alter table review_requests add column escalate_to_group text;
alter table review_requests add column min_approvals integer;
alter table review_requests add column guardrails_json text;
create index if not exists idx_rr_escalate on review_requests(tenant_id, status, escalate_at);
