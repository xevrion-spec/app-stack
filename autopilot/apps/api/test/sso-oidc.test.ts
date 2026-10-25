import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { makeEnv, client } from "./harness.js";
import { __setSsoFetcher } from "../src/services/sso.js";

const OWNER = "owner-sso@corp.example.test",
  ALICE = "alice@corp.example.test",
  OUTSIDER = "mallory@evil.example.test";
const ISS = "https://idp.example.test";
const APP = "https://app.example.test";
const KEY = "k".repeat(40);
let priv: CryptoKey, pubJwk: JWK, otherPriv: CryptoKey;
beforeAll(async () => {
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey as CryptoKey;
  pubJwk = { ...(await exportJWK(kp.publicKey)), kid: "idp-1", alg: "RS256", use: "sig" };
  otherPriv = (await generateKeyPair("RS256")).privateKey as CryptoKey;
});
afterEach(() => __setSsoFetcher(null));

/** Mock IdP: authorize binds a code to (nonce, PKCE challenge); /token checks the verifier and mints an ID token. */
type Grant = { challenge: string; claims: Record<string, unknown>; key?: CryptoKey; aud?: string; iss?: string; exp?: number };
function mockIdp() {
  const grants = new Map<string, Grant>();
  const tokenCalls: URLSearchParams[] = [];
  __setSsoFetcher(async (url, init) => {
    if (url === `${ISS}/jwks`) return Response.json({ keys: [pubJwk] });
    if (url === `${ISS}/token`) {
      const form = new URLSearchParams(String(init?.body));
      tokenCalls.push(form);
      const g = grants.get(form.get("code") ?? "");
      if (!g) return Response.json({ error: "invalid_grant" }, { status: 400 });
      grants.delete(form.get("code")!);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? "")));
      const chal = btoa(String.fromCharCode(...digest))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      if (chal !== g.challenge) return Response.json({ error: "invalid_grant", error_description: "pkce" }, { status: 400 });
      const id_token = await new SignJWT(g.claims)
        .setProtectedHeader({ alg: "RS256", kid: "idp-1" })
        .setIssuer(g.iss ?? ISS)
        .setAudience(g.aud ?? "client-1")
        .setIssuedAt()
        .setExpirationTime(g.exp ?? Math.floor(Date.now() / 1000) + 300)
        .sign(g.key ?? priv);
      return Response.json({ id_token, token_type: "Bearer" });
    }
    return new Response("not found", { status: 404 });
  });
  return { grants, tokenCalls };
}

async function setup(over: Record<string, string> = {}) {
  const h = makeEnv({ SESSION_SIGNING_KEY: KEY, ALLOWED_ORIGINS: APP, ...over });
  const call = client(h.env);
  await call("POST", "/v1/tenants", { user: OWNER, body: { name: "Corp (synthetic)" } });
  await call("POST", "/v1/tenants", { user: "other-owner@example.test", body: { name: "Other (synthetic)" } });
  const tenantId = (await call("GET", "/v1/me", { user: OWNER })).json.tenantId as string;
  const otherTenant = (await call("GET", "/v1/me", { user: "other-owner@example.test" })).json.tenantId as string;
  const configure = (b: Record<string, unknown> = {}) =>
    call("PUT", "/v1/sso/oidc", {
      user: OWNER,
      body: {
        issuer: ISS,
        clientId: "client-1",
        clientSecret: "synthetic-client-secret",
        authorizationEndpoint: `${ISS}/authorize`,
        tokenEndpoint: `${ISS}/token`,
        jwksUri: `${ISS}/jwks`,
        allowedDomains: ["corp.example.test"],
        ...b,
      },
    });
  const idp = mockIdp();
  /** Drive the browser leg: start, "log in" at the IdP (mint a code), return code + state. */
  const login = async (claims: Record<string, unknown>, g: Partial<Grant> = {}) => {
    const st = await call("GET", `/sso/oidc/start?tenant=${tenantId}&redirectUri=${encodeURIComponent(`${APP}/sso/callback`)}`);
    expect(st.status).toBe(200);
    const u = new URL(st.json.url);
    const code = `code-${Math.random().toString(36).slice(2)}`;
    idp.grants.set(code, { challenge: u.searchParams.get("code_challenge")!, claims: { nonce: u.searchParams.get("nonce"), ...claims }, ...g });
    return { code, state: u.searchParams.get("state")!, url: u };
  };
  const finish = (x: { code: string; state: string }) => call("POST", "/sso/oidc/callback", { body: x });
  return { ...h, call, tenantId, otherTenant, configure, idp, login, finish };
}

describe("OIDC SSO with a mock IdP (A8)", () => {
  it("full login: PKCE + nonce, JIT-provisions a reviewer, session works, is tenant-pinned and revocable", async () => {
    const s = await setup();
    expect((await s.configure()).status).toBe(200);
    const l = await s.login({ sub: "idp|alice", email: ALICE, email_verified: true, name: "Alice Synthetic" });
    expect(Object.fromEntries(l.url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      code_challenge_method: "S256",
      scope: "openid email profile",
    });
    const done = await s.finish(l);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ email: ALICE, tenantId: s.tenantId, provisioned: true });
    expect(done.json.token).toMatch(/^ses_/);
    expect(s.idp.tokenCalls[0]!.get("grant_type")).toBe("authorization_code");
    const auth = { authorization: `Bearer ${done.json.token}` };
    const me = await s.call("GET", "/v1/me", { headers: auth });
    expect(me.json).toMatchObject({ email: ALICE, role: "reviewer", tenantId: s.tenantId });
    expect((await s.call("GET", "/v1/me", { headers: { ...auth, "x-tenant-id": s.otherTenant } })).json.tenantId).toBe(s.tenantId);
    expect((await s.call("GET", "/v1/sso/oidc", { headers: auth })).status).toBe(403); // reviewers cannot see SSO config
    const audit = (s.raw.prepare("select action from audit_log where action in ('user.jit_provisioned','sso.login')").all() as { action: string }[]).map(
      (a) => a.action,
    );
    expect(audit.sort()).toEqual(["sso.login", "user.jit_provisioned"]);
    expect((await s.call("POST", "/v1/sso/logout", { headers: auth })).json).toEqual({ sessionsRevoked: 1 });
    expect((await s.call("GET", "/v1/me", { headers: auth })).status).toBe(401);
    // second login: same user, not re-provisioned
    expect((await s.finish(await s.login({ sub: "idp|alice", email: ALICE }))).json.provisioned).toBe(false);
  });

  it("rejects replayed/unknown state, bad nonce, wrong audience/issuer/key, expired and unverified tokens, PKCE mismatch, foreign domains", async () => {
    const s = await setup();
    await s.configure();
    const ok = await s.login({ sub: "a", email: ALICE });
    expect((await s.finish(ok)).status).toBe(200);
    expect((await s.finish(ok)).status).toBe(401); // state is single use
    expect((await s.finish({ code: "x", state: "nope" })).status).toBe(401);
    const cases: [Record<string, unknown>, Partial<Grant>, number][] = [
      [{ sub: "a", email: ALICE, nonce: "forged" }, {}, 401],
      [{ sub: "a", email: ALICE }, { aud: "someone-else" }, 401],
      [{ sub: "a", email: ALICE }, { iss: "https://evil.example.test" }, 401],
      [{ sub: "a", email: ALICE }, { key: otherPriv }, 401],
      [{ sub: "a", email: ALICE }, { exp: Math.floor(Date.now() / 1000) - 600 }, 401],
      [{ sub: "a", email: ALICE, email_verified: false }, {}, 401],
      [{ sub: "m", email: OUTSIDER }, {}, 403],
    ];
    for (const [claims, g, status] of cases)
      expect((await s.finish(await s.login(claims, g))).status, JSON.stringify({ claims, g: Object.keys(g) })).toBe(status);
    // PKCE: a code redeemed with a different verifier is refused by the IdP
    const l = await s.login({ sub: "a", email: ALICE });
    s.idp.grants.get(l.code)!.challenge = "tampered";
    expect((await s.finish(l)).status).toBe(401);
    expect(s.raw.prepare("select count(*) n from users where email = ?").get(OUTSIDER)).toEqual({ n: 0 });
  });

  it("config is owner-only, validated, never returns the secret; deleting SSO revokes sessions; unconfigured key is 503", async () => {
    const s = await setup();
    expect((await s.call("GET", `/sso/oidc/start?tenant=${s.tenantId}&redirectUri=${encodeURIComponent(`${APP}/cb`)}`)).status).toBe(404);
    expect((await s.configure({ allowedDomains: [] })).status).toBe(400);
    expect((await s.configure({ tokenEndpoint: "http://169.254.169.254/token" })).status).toBe(400);
    expect((await s.configure({ defaultRole: "owner" })).status).toBe(400);
    const got = await s.configure();
    expect(JSON.stringify(got.json)).not.toContain("synthetic-client-secret");
    expect(JSON.stringify((await s.call("GET", "/v1/sso/oidc", { user: OWNER })).json)).not.toContain("synthetic-client-secret");
    expect((await s.call("GET", "/v1/sso/oidc", { user: "other-owner@example.test" })).status).toBe(404);
    expect((await s.call("GET", `/sso/oidc/start?tenant=${s.tenantId}&redirectUri=${encodeURIComponent("https://evil.example.test/cb")}`)).status).toBe(400);
    const tok = (await s.finish(await s.login({ sub: "a", email: ALICE }))).json.token as string;
    expect((await s.call("DELETE", "/v1/sso/oidc", { user: OWNER })).json).toEqual({ deleted: true, sessionsRevoked: 1 });
    expect((await s.call("GET", "/v1/me", { headers: { authorization: `Bearer ${tok}` } })).status).toBe(401);
    expect((await s.call("GET", "/v1/me", { headers: { authorization: "Bearer ses_garbage" } })).status).toBe(401);
    const n = await setup({ SESSION_SIGNING_KEY: "" });
    await n.configure();
    expect((await n.call("GET", `/sso/oidc/start?tenant=${n.tenantId}&redirectUri=${encodeURIComponent(`${APP}/cb`)}`)).status).toBe(503);
  });

  it("an existing owner keeps their role through SSO; JIT accountant default works", async () => {
    const s = await setup();
    await s.configure({ defaultRole: "accountant" });
    const own = (await s.finish(await s.login({ sub: "o", email: OWNER }))).json;
    expect(own.provisioned).toBe(false);
    expect((await s.call("GET", "/v1/me", { headers: { authorization: `Bearer ${own.token}` } })).json.role).toBe("owner");
    const al = (await s.finish(await s.login({ sub: "a", email: ALICE }))).json;
    expect((await s.call("GET", "/v1/me", { headers: { authorization: `Bearer ${al.token}` } })).json.role).toBe("accountant");
  });
});
