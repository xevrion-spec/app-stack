import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { TenantDb } from "./db.js";
import { sha256Hex } from "../services/csv.js";
import { badRequest, conflict } from "./errors.js";

/**
 * Idempotency for unsafe methods: if `Idempotency-Key` is sent, the first successful (2xx) response is stored per tenant
 * and replayed for retries with the same key. Reusing a key on a different route is a 409.
 */
export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header("idempotency-key");
  if (!key || c.req.method === "GET") return next();
  if (key.length > 128) throw badRequest("Idempotency-Key too long");
  const db = new TenantDb(c.env.DB, c.get("principal").tenantId);
  const path = new URL(c.req.url).pathname;
  const reqSha = await sha256Hex(await c.req.raw.clone().arrayBuffer());
  const hit = await db.first<{ method: string; path: string; status: number; response_json: string; request_sha: string | null }>(
    "select method, path, status, response_json, request_sha from idempotency_keys where tenant_id = ?1 and key = ?2",
    key,
  );
  if (hit) {
    if (hit.method !== c.req.method || hit.path !== path) throw conflict("Idempotency-Key reused for a different request");
    if (hit.request_sha && hit.request_sha !== reqSha) throw conflict("Idempotency-Key reused with a different request body");
    return c.newResponse(hit.response_json, hit.status as 200, { "content-type": "application/json", "idempotent-replay": "true" });
  }
  await next();
  if (c.res.status >= 200 && c.res.status < 300 && (c.res.headers.get("content-type") ?? "").includes("json")) {
    const body = await c.res.clone().text();
    await db.run(
      "insert or ignore into idempotency_keys (tenant_id, key, method, path, status, response_json, request_sha) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      key,
      c.req.method,
      path,
      c.res.status,
      body,
      reqSha,
    );
  }
};
