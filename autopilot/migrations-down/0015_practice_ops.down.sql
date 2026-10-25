-- Manual, confirmed rollback only.
drop index if exists idx_assign_tenant;
drop index if exists idx_engagements_status;
drop index if exists idx_portal_users_practice;
drop index if exists idx_rules_status;
drop index if exists idx_docreq_status;
drop table if exists practice_usage;
