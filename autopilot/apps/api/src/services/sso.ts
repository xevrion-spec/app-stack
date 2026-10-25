/**
 * Tenant OIDC SSO (A8): authorization-code flow with PKCE (S256), state + nonce (single use, 10 min, in KV), ID token
 * verified against the IdP's JWKS (iss, aud = client_id, exp, nonce, email_verified, allowed domains). Success JIT-
 * provisions a membership with the connection's default role (never owner) and issues a revocable session token.
 */
import { SignJWT, createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { randomToken, validateWebhookUrl } from "@xevrion/platform";
import type { Env } from "../env.js";
import { TenantDb, newId } from "../lib/db.js";
import { auditStmt } from "../lib/audit.js";
import { AppError, unauthenticated } from "../lib/errors.js";
import { devHttpHosts } from "./webhooks.js";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (u, i) => fetch(u, i);
/** Test hook: the mock IdP answers token and JWKS requests. */
export const __setSsoFetcher = (f: Fetcher | null) => {
  fetcher = f ?? ((u, i) => fetch(u, i));
};
export type SsoConnection = {
  tenant_id: string;
  issuer: string;
  client_id: string;
  client_secret: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  allowed_domains_json: string;
  default_role: "reviewer" | "accountant";
};
const SESSION_TTL_S = 8 * 3600;
const STATE_TTL_S = 600;
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** IdP endpoints must be https (or an allowed dev host) and not private/metadata addresses. */
export function assertIdpUrl(env: Env, url: string) {
  const r = validateWebhookUrl(url, { allowHttpHosts: devHttpHosts(env) });
  if (!r.ok) throw new AppError(400, "bad_request", `IdP URL not allowed: ${r.reason}`);
}
const sessionKey = (env: Env) => {
  if (!env.SESSION_SIGNING_KEY || env.SESSION_SIGNING_KEY.length < 32) throw new AppError(503, "sso_unconfigured", "SSO sessions are not configured");
  return new TextEncoder().encode(env.SESSION_SIGNING_KEY);
};

export async function startLogin(env: Env, conn: SsoConnection, redirectUri: string): Promise<{ url: string; state: string }> {
  sessionKey(env);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  await env.CONFIG.put(`sso:state:${state}`, JSON.stringify({ tenantId: conn.tenant_id, nonce, verifier, redirectUri }), { expirationTtl: STATE_TTL_S });
  const u = new URL(conn.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: conn.client_id,
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    u.searchParams.set(k, v);
  return { url: u.toString(), state };
}

type Claims = { email: string; sub: string; name?: string };
async function exchange(env: Env, conn: SsoConnection, code: string, st: { nonce: string; verifier: string; redirectUri: string }): Promise<Claims> {
  assertIdpUrl(env, conn.token_endpoint);
  assertIdpUrl(env, conn.jwks_uri);
  const res = await fetcher(conn.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${conn.client_id}:${conn.client_secret}`)}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: st.redirectUri, code_verifier: st.verifier }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw unauthenticated("IdP rejected the authorization code");
  const tok = (await res.json()) as { id_token?: unknown };
  if (typeof tok.id_token !== "string") throw unauthenticated("IdP returned no id_token");
  const jwks = (await (await fetcher(conn.jwks_uri, { signal: AbortSignal.timeout(10_000) })).json()) as JSONWebKeySet;
  try {
    const { payload } = await jwtVerify(tok.id_token, createLocalJWKSet(jwks), {
      issuer: conn.issuer,
      audience: conn.client_id,
      algorithms: ["RS256", "ES256", "EdDSA"],
      clockTolerance: 60,
    });
    if (payload.nonce !== st.nonce) throw new Error("nonce");
    if (payload.email_verified === false) throw new Error("unverified");
    if (typeof payload.email !== "string" || !payload.sub) throw new Error("claims");
    return { email: payload.email.toLowerCase(), sub: payload.sub, ...(typeof payload.name === "string" ? { name: payload.name } : {}) };
  } catch {
    throw unauthenticated("Invalid ID token");
  }
}

export async function completeLogin(
  env: Env,
  code: string,
  state: string,
): Promise<{ token: string; expiresAt: string; tenantId: string; email: string; created: boolean }> {
  const key = sessionKey(env);
  const raw = await env.CONFIG.get(`sso:state:${state}`);
  if (!raw) throw unauthenticated("Unknown or expired login state");
  await env.CONFIG.delete(`sso:state:${state}`); // single use, even if the rest fails
  const st = JSON.parse(raw) as { tenantId: string; nonce: string; verifier: string; redirectUri: string };
  const db = new TenantDb(env.DB, st.tenantId);
  const conn = await db.first<SsoConnection>("select * from sso_connections where tenant_id = ?1");
  if (!conn) throw unauthenticated("SSO is not configured for this tenant");
  const c = await exchange(env, conn, code, st);
  const domains = JSON.parse(conn.allowed_domains_json) as string[];
  if (!domains.includes(c.email.split("@")[1] ?? "")) throw new AppError(403, "forbidden", "Email domain is not allowed for this tenant");
  const user = await db.first<{ id: string; deactivated_at: string | null }>(
    "select id, deactivated_at from users where tenant_id = ?1 and email = ?2",
    c.email,
  );
  if (user?.deactivated_at) throw new AppError(403, "forbidden", "User is deactivated");
  const t = new Date();
  const sid = newId();
  const exp = new Date(t.getTime() + SESSION_TTL_S * 1000).toISOString();
  const actor = `sso:${c.email}`;
  await db.batch([
    ...(user
      ? []
      : [
          db.stmt(
            "insert into users (tenant_id, id, email, role, access_subject, display_name) values (?1, ?2, ?3, ?4, ?5, ?6)",
            newId(),
            c.email,
            conn.default_role,
            `oidc:${c.sub}`,
            c.name ?? null,
          ),
          auditStmt(db, actor, "user.jit_provisioned", c.email, { role: conn.default_role, issuer: conn.issuer }),
        ]),
    db.stmt(
      "insert into sso_sessions (tenant_id, id, email, subject, expires_at, created_at) values (?1, ?2, ?3, ?4, ?5, ?6)",
      sid,
      c.email,
      c.sub,
      exp,
      t.toISOString(),
    ),
    auditStmt(db, actor, "sso.login", sid, { issuer: conn.issuer }),
  ]);
  const token = await new SignJWT({ tid: st.tenantId, email: c.email })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(sid)
    .setSubject(c.sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.parse(exp) / 1000))
    .sign(key);
  return { token: `ses_${token}`, expiresAt: exp, tenantId: st.tenantId, email: c.email, created: !user };
}

/** identity middleware hook: verify signature + expiry, then the session row (revocation) and the user (deactivation). */
export async function verifySession(env: Env, token: string): Promise<{ email: string; subject: string; tenantId: string }> {
  try {
    const { payload } = await jwtVerify(token, sessionKey(env), { algorithms: ["HS256"] });
    const row = await env.DB.prepare(
      "select s.email from sso_sessions s join users u on u.tenant_id = s.tenant_id and u.email = s.email where s.id = ?1 and s.tenant_id = ?2 and s.revoked_at is null and s.expires_at > ?3 and u.deactivated_at is null",
    )
      .bind(payload.jti, payload.tid, new Date().toISOString())
      .first<{ email: string }>();
    if (!row || row.email !== payload.email) throw new Error("revoked");
    return { email: row.email, subject: `oidc:${String(payload.sub)}`, tenantId: String(payload.tid) };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw unauthenticated("Invalid, expired or revoked session");
  }
}
