-- Practice co-pilot M6: per-practice monthly metering + additive indexes for 500-client practices (EXPLAIN-verified in
-- practice-ops.test.ts). Additive only.
create table if not exists practice_usage (
  practice_id text not null references practices(id),
  period text not null,
  metric text not null,
  count integer not null default 0,
  primary key (practice_id, period, metric)
);
create index if not exists idx_docreq_status on document_requests(practice_id, status, due_date);
create index if not exists idx_rules_status on practice_rules(practice_id, status, scope);
create index if not exists idx_portal_users_practice on portal_users(practice_id, tenant_id);
create index if not exists idx_engagements_status on engagements(practice_id, status);
create index if not exists idx_assign_tenant on client_assignments(practice_id, tenant_id, role);
