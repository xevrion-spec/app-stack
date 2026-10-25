-- Platform layer (additive only): event outbox, webhooks, automations, API keys, usage metering, inbound triggers,
-- optimistic concurrency + soft delete on invoices, tags, and full-text search.
alter table invoices add column version integer not null default 1;
alter table invoices add column deleted_at text;
alter table tenants add column version integer not null default 1;

create table if not exists events (
  tenant_id text not null references tenants(id), id text primary key, type text not null, version integer not null,
  actor text not null, causation_json text not null default '[]', payload_json text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), dispatched_at text);
create index if not exists idx_events_tenant on events(tenant_id, created_at);
create index if not exists idx_events_undispatched on events(dispatched_at) where dispatched_at is null;

create table if not exists webhook_endpoints (
  tenant_id text not null references tenants(id), id text primary key, url text not null, description text,
  secret text not null, previous_secret text, previous_secret_expires_at text,
  event_filters_json text not null default '["*"]', status text not null default 'active' check (status in ('active','disabled')),
  disabled_reason text, consecutive_failures integer not null default 0, first_failure_at text,
  version integer not null default 1, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), deleted_at text);
create index if not exists idx_webhooks_tenant on webhook_endpoints(tenant_id, status);

create table if not exists webhook_deliveries (
  tenant_id text not null references tenants(id), id text primary key, endpoint_id text not null references webhook_endpoints(id),
  event_id text not null references events(id), attempt integer not null default 0,
  status text not null default 'pending' check (status in ('pending','succeeded','failed','dead')),
  response_status integer, error text, duration_ms integer, next_attempt_at text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at text,
  unique (endpoint_id, event_id));
create index if not exists idx_deliveries_due on webhook_deliveries(status, next_attempt_at);
create index if not exists idx_deliveries_tenant on webhook_deliveries(tenant_id, created_at);

create table if not exists automations (
  tenant_id text not null references tenants(id), id text primary key, name text not null, trigger_event text not null,
  definition_json text not null, enabled integer not null default 1, version integer not null default 1,
  created_by text, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at text, deleted_at text);
create index if not exists idx_automations_trigger on automations(tenant_id, trigger_event, enabled);

create table if not exists automation_runs (
  tenant_id text not null references tenants(id), id text primary key, automation_id text not null references automations(id),
  event_id text not null, dry_run integer not null default 0, status text not null, skipped_reason text, result_json text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create unique index if not exists idx_runs_once on automation_runs(automation_id, event_id) where dry_run = 0;
create index if not exists idx_runs_tenant on automation_runs(tenant_id, automation_id, created_at);

create table if not exists action_executions (
  tenant_id text not null references tenants(id), idempotency_key text not null, run_id text not null,
  action_type text not null, outcome text not null, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  primary key (tenant_id, idempotency_key));

create table if not exists api_keys (
  tenant_id text not null references tenants(id), id text primary key, prefix text not null unique, key_hash text not null,
  name text not null, scopes_json text not null, created_by text not null, last_used_at text, expires_at text, revoked_at text,
  replaced_by text, created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create index if not exists idx_api_keys_tenant on api_keys(tenant_id);

create table if not exists usage_counters (
  tenant_id text not null references tenants(id), metric text not null, period text not null, count integer not null default 0,
  primary key (tenant_id, metric, period));

create table if not exists inbound_triggers (
  tenant_id text not null references tenants(id), id text primary key, name text not null, secret text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), revoked_at text);

create table if not exists transaction_tags (
  tenant_id text not null references tenants(id), transaction_id text not null references transactions(id), tag text not null,
  primary key (tenant_id, transaction_id, tag));

create virtual table if not exists search_index using fts5(tenant_id unindexed, kind unindexed, ref_id unindexed, body, tokenize = 'unicode61 remove_diacritics 2');
create trigger if not exists trg_txn_search_ins after insert on transactions begin
  insert into search_index (tenant_id, kind, ref_id, body) values (new.tenant_id, 'transaction', new.id, coalesce(new.description, '') || ' ' || coalesce(new.counterparty, ''));
end;
create trigger if not exists trg_txn_search_upd after update of description on transactions begin
  delete from search_index where kind = 'transaction' and ref_id = old.id;
  insert into search_index (tenant_id, kind, ref_id, body) values (new.tenant_id, 'transaction', new.id, coalesce(new.description, '') || ' ' || coalesce(new.counterparty, ''));
end;
create trigger if not exists trg_inv_search_ins after insert on invoices begin
  insert into search_index (tenant_id, kind, ref_id, body) values (new.tenant_id, 'invoice', new.id, new.number || ' ' || new.customer_name || ' ' || coalesce(new.customer_email, ''));
end;
insert into search_index (tenant_id, kind, ref_id, body) select tenant_id, 'transaction', id, coalesce(description, '') || ' ' || coalesce(counterparty, '') from transactions;
insert into search_index (tenant_id, kind, ref_id, body) select tenant_id, 'invoice', id, number || ' ' || customer_name || ' ' || coalesce(customer_email, '') from invoices;
