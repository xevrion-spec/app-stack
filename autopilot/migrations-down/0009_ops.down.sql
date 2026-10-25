-- Manual, confirmed rollback only.
alter table documents drop column purged_at;
drop table if exists bank_feed_connections;
drop table if exists scheduler_runs;
