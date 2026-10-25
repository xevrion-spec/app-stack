drop index if exists idx_rr_retention;
alter table review_requests drop column redacted_at;
alter table review_requests drop column legal_hold_reason;
alter table review_requests drop column legal_hold_by;
alter table review_requests drop column legal_hold_at;
alter table review_projects drop column retention_days;
