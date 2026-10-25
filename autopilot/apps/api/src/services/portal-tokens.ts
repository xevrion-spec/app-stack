/**
 * Client portal tokens (MOCK magic-link flow, ADR 0025). Tokens are random 256-bit values; only their sha256 is stored.
 * magic: single use, 15 minutes, exchanged for a session. session: 8 hours, revocable. Nothing is ever emailed.
 */
import { sha256Hex } from "./csv.js";

export const MAGIC_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 8 * 3_600_000;
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const randomToken = (prefix: "pm_" | "ps_") => `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`;
const TOKEN_RE = /^p[ms]_[A-Za-z0-9_-]{43}$/;

async function issue(db: D1Database, portalUserId: string, kind: "magic" | "session", now = Date.now()) {
  const token = randomToken(kind === "magic" ? "pm_" : "ps_");
  const expiresAt = new Date(now + (kind === "magic" ? MAGIC_TTL_MS : SESSION_TTL_MS)).toISOString();
  const stmt = db
    .prepare("insert into portal_tokens (token_hash, portal_user_id, kind, expires_at) values (?1, ?2, ?3, ?4)")
    .bind(await sha256Hex(token), portalUserId, kind, expiresAt);
  return { token, expiresAt, stmt };
}
export const issueMagicToken = (db: D1Database, portalUserId: string, now?: number) => issue(db, portalUserId, "magic", now);

export interface PortalSessionRow {
  portal_user_id: string;
  practice_id: string;
  tenant_id: string;
  email: string;
}
const LOOKUP =
  "select u.id portal_user_id, u.practice_id, u.tenant_id, u.email from portal_tokens k join portal_users u on u.id = k.portal_user_id join practice_clients pc on pc.practice_id = u.practice_id and pc.tenant_id = u.tenant_id where k.token_hash = ?1 and k.kind = ?2 and k.used_at is null and k.expires_at > ?3 and u.status = 'active' and pc.status != 'archived'";

/** Exchanges a magic token for a session, atomically consuming the magic token (a replay finds it used). */
export async function exchangeMagic(db: D1Database, token: string, now = Date.now()) {
  if (!TOKEN_RE.test(token) || !token.startsWith("pm_")) return null;
  const hash = await sha256Hex(token);
  const iso = new Date(now).toISOString();
  const row = await db.prepare(LOOKUP).bind(hash, "magic", iso).first<PortalSessionRow>();
  if (!row) return null;
  const consumed = await db.prepare("update portal_tokens set used_at = ?2 where token_hash = ?1 and used_at is null").bind(hash, iso).run();
  if (!consumed.meta?.changes) return null;
  const s = await issue(db, row.portal_user_id, "session", now);
  await s.stmt.run();
  return { ...row, sessionToken: s.token, expiresAt: s.expiresAt };
}
export async function lookupSession(db: D1Database, token: string, now = Date.now()) {
  if (!TOKEN_RE.test(token) || !token.startsWith("ps_")) return null;
  return db
    .prepare(LOOKUP)
    .bind(await sha256Hex(token), "session", new Date(now).toISOString())
    .first<PortalSessionRow>();
}
export async function endSession(db: D1Database, token: string, now = Date.now()) {
  await db
    .prepare("update portal_tokens set used_at = ?2 where token_hash = ?1 and kind = 'session'")
    .bind(await sha256Hex(token), new Date(now).toISOString())
    .run();
}
