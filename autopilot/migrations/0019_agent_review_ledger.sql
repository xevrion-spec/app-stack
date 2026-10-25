-- Agent review layer A4: per-request hash-chained ledger (tamper-evident), chain head pinned on the request row,
-- unique(tenant_id, request_id, seq) is also the concurrency guard: two racing writers cannot
-- both append seq N, so the losing batch rolls back atomically.
create table review_ledger (
  tenant_id text not null,
  request_id text not null,
  seq integer not null,
  kind text not null,
  actor text not null,
  at text not null,
  data_json text not null,
  prev_hash text not null,
  hash text not null,
  primary key (tenant_id, request_id, seq)
);
create index idx_rledger_at on review_ledger(tenant_id, at);
alter table review_requests add column chain_seq integer not null default 0;
alter table review_requests add column chain_head text;
