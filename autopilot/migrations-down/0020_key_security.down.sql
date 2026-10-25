drop table if exists key_policies;
alter table api_keys drop column allowed_cidrs_json;
