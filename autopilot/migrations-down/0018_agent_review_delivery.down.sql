-- Reverts 0018_agent_review_delivery.sql (agent review layer A3). Manual, confirmed rollback only.
drop index if exists idx_rcb_request;
drop index if exists idx_rcb_due;
drop table if exists review_callbacks;
alter table review_requests drop column callback_url;
alter table review_projects drop column callback_secret;
