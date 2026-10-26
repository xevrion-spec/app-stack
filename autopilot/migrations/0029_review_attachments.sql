-- R4: evidence attachments on review requests (bytes in R2; scanned before anyone can download them).
create table if not exists review_attachments (
  tenant_id text not null references tenants(id),
  id text not null,
  request_id text not null,
  name text not null,
  content_type text not null,
  size integer not null,
  sha256 text not null,
  r2_key text,
  scan_status text not null,
  scan_engine text not null,
  scan_detail text,
  uploaded_by text not null,
  created_at text not null,
  primary key (tenant_id, id)
);
create index if not exists idx_ratt_request on review_attachments(tenant_id, request_id, created_at);
