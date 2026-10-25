-- Rollback for 0004 (local/test only; production policy is roll-forward). Requires SQLite >= 3.35 for drop column.
drop trigger if exists trg_inv_search_ins;
drop trigger if exists trg_txn_search_upd;
drop trigger if exists trg_txn_search_ins;
drop table if exists search_index;
drop table if exists transaction_tags;
drop table if exists inbound_triggers;
drop table if exists usage_counters;
drop table if exists api_keys;
drop table if exists action_executions;
drop table if exists automation_runs;
drop table if exists automations;
drop table if exists webhook_deliveries;
drop table if exists webhook_endpoints;
drop table if exists events;
alter table tenants drop column version;
alter table invoices drop column deleted_at;
alter table invoices drop column version;
