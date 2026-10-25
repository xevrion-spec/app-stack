-- Reverts 0016_agent_review.sql (agent review layer A1).
alter table api_keys drop column project_id;
drop index if exists idx_rd_request;
drop table if exists review_decisions;
drop index if exists idx_rr_external;
drop index if exists idx_rr_deadline;
drop index if exists idx_rr_queue;
drop table if exists review_requests;
drop table if exists review_projects;
