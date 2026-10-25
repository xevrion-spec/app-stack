import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Principal, Role } from "../env.js";
import { forbidden, unauthenticated } from "./errors.js";

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
  const env = c.env;
  const devEmail = c.req.header("x-dev-user");
  if (env.ENVIRONMENT !== "production" && devEmail) {
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
  const email = c.get("identityEmail");
  const wanted = c.req.header("x-tenant-id");
  // Membership lookup is the ONE query that is not tenant-scoped: it is how we discover the tenant.
  const rows =
    (await c.env.DB.prepare("select id, tenant_id, role from users where email = ?1").bind(email).all<{ id: string; tenant_id: string; role: string }>())
      .results ?? [];
  const row = wanted ? rows.find((r) => r.tenant_id === wanted) : rows[0];
  if (!row) throw forbidden(rows.length ? "Not a member of that tenant" : "No tenant membership for this user");
  const p: Principal = { userId: row.id, tenantId: row.tenant_id, email, role: (row.role === "owner" ? "owner" : "reviewer") as Role };
  c.set("principal", p);
  return next();
};

export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roles.includes(c.get("principal").role)) throw forbidden();
    return next();
  };
}
