-- A9b: per-project retention (content redaction of final requests) + per-request legal hold.
alter table review_projects add column retention_days integer check (retention_days is null or retention_days between 1 and 3650);
alter table review_requests add column legal_hold_at text;
alter table review_requests add column legal_hold_by text;
alter table review_requests add column legal_hold_reason text;
alter table review_requests add column redacted_at text;
create index if not exists idx_rr_retention on review_requests(tenant_id, project_id, decided_at) where redacted_at is null and legal_hold_at is null;
