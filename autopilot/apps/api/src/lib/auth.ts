import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Principal, Role } from "../env.js";
import { AppError, forbidden, unauthenticated } from "./errors.js";
import { verifySession } from "../services/sso.js";
import { hashApiKey, hasScope, ipAllowed, isKeyUsable, parseApiKey, timingSafeEqual, type Scope } from "@xevrion/platform";

const jwksCache = new Map<string, JWTVerifyGetKey>();
function jwks(team: string): JWTVerifyGetKey {
  let k = jwksCache.get(team);
  if (!k) {
    k = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, k);
  }
  return k;
}

/** Test hook: lets tests inject a local JWKS instead of fetching Cloudflare's. */
let keyOverride: JWTVerifyGetKey | null = null;
export const __setAccessKeyForTests = (k: JWTVerifyGetKey | null) => {
  keyOverride = k;
};

/**
 * Identity: verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion) against the team JWKS + AUD.
 * In development/test only, `x-dev-user` (email) is accepted so the app can run locally without Access.
 */
export const identity: MiddlewareHandler<AppEnv> = async (c, next) => {
  // The client portal has its own session auth (routes/portal.ts) and never accepts staff identities.
  if (c.req.path.startsWith("/v1/portal/")) return next();
  const env = c.env;
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer ap_")) return apiKeyAuth(c, auth.slice(7), next);
  if (auth?.startsWith("Bearer ses_")) {
    const sess = await verifySession(env, auth.slice(11));
    c.set("identityEmail", sess.email);
    c.set("identitySubject", sess.subject);
    c.set("ssoTenant", sess.tenantId);
    return next();
  }
  const devEmail = c.req.header("x-dev-user");
  // Fail closed: only explicit development/test environments trust x-dev-user. A missing or unexpected ENVIRONMENT
  // (e.g. a "staging" deploy or a typo) must never accept a forged identity header.
  if ((env.ENVIRONMENT === "development" || env.ENVIRONMENT === "test") && devEmail) {
    c.set("identityEmail", devEmail.toLowerCase());
    c.set("identitySubject", `dev:${devEmail.toLowerCase()}`);
    return next();
  }
  const token = c.req.header("cf-access-jwt-assertion");
  if (!token) throw unauthenticated();
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw unauthenticated("Access is not configured for this API");
  try {
    const { payload } = await jwtVerify(token, keyOverride ?? jwks(env.ACCESS_TEAM_DOMAIN), {
      issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
      audience: env.ACCESS_AUD,
    });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (!email || !payload.sub) throw new Error("missing claims");
    c.set("identityEmail", email);
    c.set("identitySubject", payload.sub);
  } catch {
    throw unauthenticated("Invalid or expired Access token");
  }
  return next();
};

/** Resolves the tenant membership for the identity. Picks `x-tenant-id` when the user belongs to several tenants. */
export const principal: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal")?.apiKey) return next();
  const email = c.get("identityEmail");
  // An SSO session is bound to the tenant that issued it; x-tenant-id cannot move it elsewhere.
  const wanted = c.get("ssoTenant") ?? c.req.header("x-tenant-id");
  // Membership lookup is the ONE query that is not tenant-scoped: it is how we discover the tenant.
  const rows =
    (
      await c.env.DB.prepare("select id, tenant_id, role from users where email = ?1 and deactivated_at is null")
        .bind(email)
        .all<{ id: string; tenant_id: string; role: string }>()
    ).results ?? [];
  const row = wanted ? rows.find((r) => r.tenant_id === wanted) : rows[0];
  if (!row) throw rows.length ? forbidden("Not a member of that tenant") : new AppError(403, "no_membership", "No tenant membership for this user");
  const p: Principal = {
    userId: row.id,
    tenantId: row.tenant_id,
    email,
    role: (row.role === "owner" || row.role === "accountant" ? row.role : "reviewer") as Role,
  };
  c.set("principal", p);
  return next();
};

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const r = c.get("principal").role;
    // An accountant can do everything a reviewer can, plus accountant-only actions (period close sign-off).
    if (!roles.includes(r) && !(r === "accountant" && roles.includes("reviewer"))) throw forbidden();
    return next();
  };
}

/**
 * API key auth (`Authorization: Bearer ap_live_<prefix>_<secret>`). Lookup by public prefix (the one unscoped query, like
 * membership), constant-time hash compare, expiry/revocation check, then a principal with scopes. last_used_at is
 * updated at most once a minute to avoid a write per request.
 */
async function apiKeyAuth(c: Parameters<MiddlewareHandler<AppEnv>>[0], key: string, next: () => Promise<void>) {
  if (c.req.method === "POST" && new URL(c.req.url).pathname === "/v1/tenants") throw new AppError(403, "insufficient_scope", "API keys cannot create tenants");
  const parsed = parseApiKey(key);
  if (!parsed) throw unauthenticated("Malformed API key");
  const row = await c.env.DB.prepare(
    "select id, tenant_id, prefix, key_hash, scopes_json, created_by, expires_at, revoked_at, last_used_at, allowed_cidrs_json from api_keys where prefix = ?1",
  )
    .bind(parsed.prefix)
    .first<{
      id: string;
      tenant_id: string;
      prefix: string;
      key_hash: string;
      scopes_json: string;
      created_by: string;
      expires_at: string | null;
      revoked_at: string | null;
      last_used_at: string | null;
      allowed_cidrs_json: string | null;
    }>();
  const now = new Date().toISOString();
  if (!row || !timingSafeEqual(row.key_hash, await hashApiKey(key)) || !isKeyUsable(row, now)) throw unauthenticated("Invalid, expired or revoked API key");
  // IP allowlist (A9a): fail closed when the edge did not tell us the client address.
  if (row.allowed_cidrs_json && !ipAllowed(c.req.header("cf-connecting-ip"), JSON.parse(row.allowed_cidrs_json) as string[]))
    throw new AppError(403, "ip_not_allowed", "This API key cannot be used from this network");
  if (!row.last_used_at || Date.parse(now) - Date.parse(row.last_used_at) > 60_000)
    await c.env.DB.prepare("update api_keys set last_used_at = ?2 where id = ?1").bind(row.id, now).run();
  const p: Principal = {
    userId: `api_key:${row.id}`,
    tenantId: row.tenant_id,
    email: `api_key:${row.prefix}`,
    role: "owner",
    apiKey: { id: row.id, prefix: row.prefix, scopes: JSON.parse(row.scopes_json) },
  };
  c.set("identityEmail", p.email);
  c.set("identitySubject", p.userId);
  c.set("principal", p);
  return next();
}

/** Route -> scope map for API-key principals. Anything not listed (users, tenant settings, API keys, uploads of
 * receipts...) is unavailable to keys by design. */
const SCOPE_RULES: [RegExp, "GET" | "WRITE" | "*", Scope][] = [
  [/^\/v1\/(transactions|search|categories|rules)(\/|$)/, "GET", "transactions:read"],
  [/^\/v1\/(transactions|rules)(\/|$)/, "WRITE", "transactions:write"],
  [/^\/v1\/uploads\/bank-csv$/, "WRITE", "transactions:write"],
  [/^\/v1\/(invoices|receivables|recurring-invoices)(\/|$)/, "GET", "invoices:read"],
  [/^\/v1\/(receivables|recurring-invoices)(\/|$)/, "WRITE", "invoices:write"],
  [/^\/v1\/invoices(\/|$)/, "WRITE", "invoices:write"],
  [/^\/v1\/(vat|sa|ledger|export|jobs|exceptions)(\/|$)/, "GET", "reports:read"],
  [/^\/v1\/books\/(imports|mileage-trips|rules)(\/|$)/, "WRITE", "transactions:write"],
  [/^\/v1\/books\/calculators(\/|$)/, "WRITE", "reports:read"],
  [/^\/v1\/books(\/|$)/, "GET", "reports:read"],
  [/^\/v1\/extract(\/|$)/, "WRITE", "transactions:write"],
  [/^\/v1\/(automations|triggers)(\/|$)/, "*", "automations:write"],
  [/^\/v1\/webhooks(\/|$)/, "*", "webhooks:write"],
  [/^\/v1\/(events|activity|realtime)(\/|$)/, "GET", "events:read"],
  [/^\/v1\/(me|tenant|usage|flags)$/, "GET", "events:read"],
  [/^\/v1\/agent-review\/audit\/export$/, "GET", "reviews:audit"],
  [/^\/v1\/scim\/v2\//, "*", "scim:write"],
  [/^\/v1\/agent-review\/receipt-keys$/, "GET", "reviews:read"],
  [/^\/v1\/agent-review\/events(\/stream)?$/, "GET", "reviews:read"],
  [/^\/v1\/agent-reviews\/simulate$/, "WRITE", "reviews:read"],
  [/^\/v1\/agent-reviews\/[^/]+\/decisions$/, "WRITE", "reviews:decide"],
  [/^\/v1\/agent-reviews(\/|$)/, "GET", "reviews:read"],
  [/^\/v1\/agent-reviews(\/|$)/, "WRITE", "reviews:write"],
  [/^\/v1\/review-projects(\/[^/]+\/policies(\/replay)?)?$/, "GET", "reviews:read"],
  [/^\/v1\/review-projects\/[^/]+\/policies\/replay$/, "WRITE", "reviews:read"],
];
export function scopeFor(method: string, path: string): Scope | null {
  const kind = method === "GET" || method === "HEAD" ? "GET" : "WRITE";
  for (const [re, m, scope] of SCOPE_RULES) if (re.test(path) && (m === "*" || m === kind)) return scope;
  return null;
}
export const requireScopes: MiddlewareHandler<AppEnv> = async (c, next) => {
  const k = c.get("principal")?.apiKey;
  if (!k) return next();
  const need = scopeFor(c.req.method, new URL(c.req.url).pathname);
  if (!need) throw new AppError(403, "insufficient_scope", "This endpoint is not available to API keys");
  if (!hasScope(k.scopes, need)) throw new AppError(403, "insufficient_scope", `API key lacks scope ${need}`, { required: need });
  return next();
};
