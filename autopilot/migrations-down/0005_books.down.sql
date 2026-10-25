-- Manual, confirmed rollback only (docs/runbook.md).
drop table if exists mileage_trips;
drop table if exists category_corrections;
alter table category_rules drop column confidence;
alter table category_rules drop column source;
