-- A10b: push audit streaming. One sink per tenant; cursor is the (at, request_id, seq) of the last delivered entry.
create table if not exists audit_sinks (
  tenant_id text primary key references tenants(id),
  url text not null,
  secret text not null,
  format text not null default 'ndjson' check (format in ('ndjson', 'cef')),
  status text not null default 'active' check (status in ('active', 'paused')),
  cursor_at text not null default '',
  cursor_request text not null default '',
  cursor_seq integer not null default 0,
  attempt integer not null default 0,
  next_attempt_at text not null default '',
  last_status integer,
  last_error text,
  delivered integer not null default 0,
  last_delivered_at text,
  created_by text not null,
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_ledger_stream on review_ledger(tenant_id, at, request_id, seq);
