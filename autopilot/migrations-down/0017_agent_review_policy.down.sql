-- Reverts 0017_agent_review_policy.sql (agent review layer A2). Manual, confirmed rollback only.
drop index if exists idx_rr_escalate;
alter table review_requests drop column guardrails_json;
alter table review_requests drop column min_approvals;
alter table review_requests drop column escalate_to_group;
alter table review_requests drop column escalate_at;
alter table review_requests drop column review_group;
alter table review_requests drop column route_outcome;
alter table review_requests drop column policy_rule_id;
alter table review_requests drop column policy_version;
drop table if exists review_group_members;
drop index if exists idx_rp_status;
drop table if exists review_policies;
