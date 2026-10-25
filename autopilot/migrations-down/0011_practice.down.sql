-- Manual, confirmed rollback only.
drop index if exists idx_txn_review;
alter table transactions drop column qa_result;
alter table transactions drop column qa_sample;
alter table transactions drop column review_method;
alter table transactions drop column reviewed_at;
alter table transactions drop column reviewed_by;
drop trigger if exists practice_audit_no_delete;
drop trigger if exists practice_audit_no_update;
drop table if exists practice_audit;
drop table if exists client_assignments;
drop table if exists practice_clients;
drop table if exists practice_staff;
drop table if exists practices;
