# ADR 0012: Scoped, hashed API keys
Status: accepted (2026-10-25)

Keys look like `ap_live_<8-char prefix>_<secret>`; only `sha256(key)` is stored, the prefix is the lookup id. Keys carry explicit scopes (`transactions:read|write`, `invoices:read|write`, `reports:read`, `automations:write`, `webhooks:write`, `events:read`) mapped per route; anything unmapped is denied for keys. Keys cannot create tenants or manage users/keys. Rotation issues a new key and revokes the old one atomically; `last_used_at` is recorded.
Why: least privilege for integrations; a database leak does not leak usable keys (high-entropy secrets make a fast hash sufficient — no bcrypt needed). Trade-off: no per-key IP allow-lists or expiry yet.
