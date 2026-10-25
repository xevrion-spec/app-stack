-- Hardening: indexes for the hottest queries found with EXPLAIN QUERY PLAN (docs/performance.md). Additive only.
create index if not exists idx_users_email on users(email);                                      -- membership lookup on EVERY request (was a full scan)
create index if not exists idx_docs_sha on documents(tenant_id, sha256);                         -- receipt de-duplication (was a full scan)
create index if not exists idx_docs_retention on documents(tenant_id, purged_at, created_at);    -- retention job (was a full scan)
create index if not exists idx_txn_list on transactions(tenant_id, created_at, id);              -- keyset pagination without a temp sort
create index if not exists idx_events_list on events(tenant_id, created_at, id);
create index if not exists idx_audit_list on audit_log(tenant_id, created_at, id);
create index if not exists idx_journals_source on journals(tenant_id, source_type, source_id);   -- re-categorise / reversal lookup
create index if not exists idx_exc_tenant_status on exceptions(tenant_id, status, created_at);   -- review queue
create index if not exists idx_credit_notes_invoice on credit_notes(tenant_id, invoice_id);      -- receivables balance subquery
create index if not exists idx_sched_tenant on scheduler_runs(tenant_id, run_date);
create index if not exists idx_notifications_list on notifications(tenant_id, user_email, created_at);
