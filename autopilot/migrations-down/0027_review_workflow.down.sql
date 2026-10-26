drop index if exists idx_rdel_from;
drop index if exists idx_rdel_to;
drop table if exists review_delegations;
alter table review_projects drop column business_hours_json;
