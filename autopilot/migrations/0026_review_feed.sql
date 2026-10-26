-- R2: tenant change feed for live inboxes (ordered scan by updated_at, id).
create index if not exists idx_rr_feed on review_requests(tenant_id, updated_at, id);
