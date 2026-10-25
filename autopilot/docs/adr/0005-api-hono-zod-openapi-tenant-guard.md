# ADR 0005: API on Hono + zod OpenAPI with a tenant-guarded data layer
Status: accepted (2026-10-25)

The API is a single Cloudflare Worker (Hono, `@hono/zod-openapi`). zod schemas are the single source of truth for validation, the OpenAPI 3.1 document (`openapi/openapi.json`, committed) and the generated SDK (`packages/sdk`). CI fails if the committed spec or SDK drift from the code.
All tenant data access goes through `TenantDb`, which binds the tenant as `?1` and throws on SQL that is not scoped by `tenant_id = ?1` (or an insert whose first value is `?1`). The only unscoped query is the membership lookup in auth. Auth is Cloudflare Access JWT (JWKS + AUD), failing closed in production; roles are `owner` and `reviewer`.
Trade-off: hand-written SQL (no ORM) for D1 control and auditability, guarded by a regex check plus isolation tests rather than row-level security (D1 has none).
