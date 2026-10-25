alter table users drop column external_id;
alter table users drop column deactivated_at;
drop index if exists idx_sso_sessions_user;
drop table if exists sso_sessions;
drop table if exists sso_connections;
