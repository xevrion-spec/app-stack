-- Additive: store a hash of the request body so a reused Idempotency-Key with a different payload is rejected (409),
-- instead of silently replaying the first response.
alter table idempotency_keys add column request_sha text;
