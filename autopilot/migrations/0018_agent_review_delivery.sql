-- Agent review layer A3: per-request signed callbacks with retries/DLQ/redelivery. The project callback secret signs
-- callbacks (same HMAC scheme as webhooks). Additive only.
alter table review_projects add column callback_secret text;
alter table review_requests add column callback_url text;
create table if not exists review_callbacks (
  id text primary key,
  tenant_id text not null references tenants(id),
  request_id text not null references review_requests(id),
  url text not null,
  event_type text not null,
  body_json text not null,
  attempt integer not null default 0,
  status text not null default 'pending' check (status in ('pending', 'failed', 'succeeded', 'dead')),
  response_status integer,
  error text,
  duration_ms integer,
  next_attempt_at text,
  created_at text not null,
  updated_at text,
  unique (request_id, event_type)
);
create index if not exists idx_rcb_due on review_callbacks(status, next_attempt_at);
create index if not exists idx_rcb_request on review_callbacks(tenant_id, request_id);
