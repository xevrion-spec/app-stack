/**
 * SSO routes (A8). Admin config is owner-only (humans); the start/callback pair is public (it is how you log in) and
 * lives outside /v1 so identity middleware does not run. Login state is single-use; redirect URIs must be on an
 * allowed origin.
 */
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { def, validationHook } from "../lib/route.js";
import { requireRole } from "../lib/auth.js";
import { auditStmt } from "../lib/audit.js";
import { AppError, badRequest, notFound } from "../lib/errors.js";
import { TenantDb } from "../lib/db.js";
import { assertIdpUrl, completeLogin, startLogin, type SsoConnection } from "../services/sso.js";
import { scope } from "./agent-reviews.js";

export const ssoAdmin = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
const ownerHuman: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal").apiKey) throw new AppError(403, "forbidden", "API keys cannot manage SSO");
  return requireRole("owner")(c, next);
};
ssoAdmin.use("/sso/oidc", ownerHuman);
const actor = (c: { get: (k: "principal") => { email: string } }) => c.get("principal").email;
const Domain = z
  .string()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "domain like example.com")
  .max(253);
const OidcIn = z
  .object({
    issuer: z.string().url().max(500),
    clientId: z.string().min(1).max(500),
    clientSecret: z.string().min(1).max(2000),
    authorizationEndpoint: z.string().url().max(2000),
    tokenEndpoint: z.string().url().max(2000),
    jwksUri: z.string().url().max(2000),
    /** Required: only these email domains may sign in (protects against shared IdPs such as consumer Google). */
    allowedDomains: z.array(Domain).min(1).max(50),
    defaultRole: z.enum(["reviewer", "accountant"]).default("reviewer"),
  })
  .openapi("OidcConnectionIn");
const OidcOut = z
  .object({
    issuer: z.string(),
    clientId: z.string(),
    authorizationEndpoint: z.string(),
    tokenEndpoint: z.string(),
    jwksUri: z.string(),
    allowedDomains: z.array(z.string()),
    defaultRole: z.enum(["reviewer", "accountant"]),
  })
  .openapi("OidcConnection");
const out = (r: SsoConnection) => ({
  issuer: r.issuer,
  clientId: r.client_id,
  authorizationEndpoint: r.authorization_endpoint,
  tokenEndpoint: r.token_endpoint,
  jwksUri: r.jwks_uri,
  allowedDomains: JSON.parse(r.allowed_domains_json) as string[],
  defaultRole: r.default_role,
});

ssoAdmin.openapi(
  def({
    method: "put",
    path: "/sso/oidc",
    tag: "Account",
    summary: "Configure OIDC single sign-on (JIT provisioning, never as owner)",
    body: OidcIn,
    response: OidcOut,
  }),
  async (c) => {
    const b = c.req.valid("json");
    for (const u of [b.authorizationEndpoint, b.tokenEndpoint, b.jwksUri]) assertIdpUrl(c.env, u);
    const db = scope(c);
    await db.batch([
      db.stmt(
        `insert into sso_connections (tenant_id, issuer, client_id, client_secret, authorization_endpoint, token_endpoint, jwks_uri, allowed_domains_json, default_role, created_by, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         on conflict(tenant_id) do update set issuer = excluded.issuer, client_id = excluded.client_id, client_secret = excluded.client_secret,
           authorization_endpoint = excluded.authorization_endpoint, token_endpoint = excluded.token_endpoint, jwks_uri = excluded.jwks_uri,
           allowed_domains_json = excluded.allowed_domains_json, default_role = excluded.default_role, updated_at = excluded.updated_at`,
        b.issuer,
        b.clientId,
        b.clientSecret,
        b.authorizationEndpoint,
        b.tokenEndpoint,
        b.jwksUri,
        JSON.stringify(b.allowedDomains.map((d) => d.toLowerCase())),
        b.defaultRole,
        actor(c),
        new Date().toISOString(),
      ),
      auditStmt(db, actor(c), "sso.configured", "oidc", { issuer: b.issuer, allowedDomains: b.allowedDomains, defaultRole: b.defaultRole }),
    ]);
    return c.json(out((await db.first<SsoConnection>("select * from sso_connections where tenant_id = ?1"))!), 200);
  },
);
ssoAdmin.openapi(
  def({ method: "get", path: "/sso/oidc", tag: "Account", summary: "OIDC connection (client secret is never returned)", response: OidcOut }),
  async (c) => {
    const r = await scope(c).first<SsoConnection>("select * from sso_connections where tenant_id = ?1");
    if (!r) throw notFound("SSO connection");
    return c.json(out(r), 200);
  },
);
ssoAdmin.openapi(
  def({
    method: "delete",
    path: "/sso/oidc",
    tag: "Account",
    summary: "Remove SSO and revoke every SSO session",
    response: z.object({ deleted: z.boolean(), sessionsRevoked: z.number() }),
  }),
  async (c) => {
    const db = scope(c);
    if (!(await db.first("select 1 from sso_connections where tenant_id = ?1"))) throw notFound("SSO connection");
    const [, n] = await db.batch([
      db.stmt("delete from sso_connections where tenant_id = ?1"),
      db.stmt("update sso_sessions set revoked_at = ?2 where tenant_id = ?1 and revoked_at is null", new Date().toISOString()),
      auditStmt(db, actor(c), "sso.deleted", "oidc"),
    ]);
    return c.json({ deleted: true, sessionsRevoked: n ?? 0 }, 200);
  },
);
ssoAdmin.openapi(
  def({
    method: "post",
    path: "/sso/logout",
    tag: "Account",
    summary: "Revoke all of the caller's SSO sessions",
    response: z.object({ sessionsRevoked: z.number() }),
  }),
  async (c) => {
    const db = scope(c);
    const [n] = await db.batch([
      db.stmt(
        "update sso_sessions set revoked_at = ?3 where tenant_id = ?1 and email = ?2 and revoked_at is null",
        c.get("principal").email,
        new Date().toISOString(),
      ),
      auditStmt(db, actor(c), "sso.logout", c.get("principal").email),
    ]);
    return c.json({ sessionsRevoked: n ?? 0 }, 200);
  },
);

/** Public half: mounted on the root app before /v1 identity. */
export const ssoPublic = new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
ssoPublic.openapi(
  def({
    method: "get",
    path: "/sso/oidc/start",
    tag: "Account",
    summary: "Begin OIDC login: returns the IdP authorization URL (PKCE S256, state, nonce)",
    query: z.object({ tenant: z.string().min(1).max(64), redirectUri: z.string().url().max(2000) }),
    response: z.object({ url: z.string() }),
  }),
  async (c) => {
    const q = c.req.valid("query");
    const allowed = (c.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(new URL(q.redirectUri).origin)) throw badRequest("redirectUri must be on an allowed origin");
    const conn = await new TenantDb(c.env.DB, q.tenant).first<SsoConnection>("select * from sso_connections where tenant_id = ?1");
    if (!conn) throw notFound("SSO connection");
    return c.json({ url: (await startLogin(c.env, conn, q.redirectUri)).url }, 200);
  },
);
ssoPublic.openapi(
  def({
    method: "post",
    path: "/sso/oidc/callback",
    tag: "Account",
    summary: "Finish OIDC login: exchanges the code, verifies the ID token, returns a session token (Bearer ses_...)",
    body: z.object({ code: z.string().min(1).max(4000), state: z.string().min(1).max(200) }),
    response: z.object({ token: z.string(), expiresAt: z.string(), tenantId: z.string(), email: z.string(), provisioned: z.boolean() }),
  }),
  async (c) => {
    const b = c.req.valid("json");
    const r = await completeLogin(c.env, b.code, b.state);
    return c.json({ token: r.token, expiresAt: r.expiresAt, tenantId: r.tenantId, email: r.email, provisioned: r.created }, 200);
  },
);
