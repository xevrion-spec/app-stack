import { randomToken, sha256 } from "./crypto.js";

/**
 * API keys: `ap_live_<8-char prefix>_<secret>`. Only sha256(full key) is stored; the prefix is the public lookup id shown in
 * the UI. Keys carry scopes; "rotate" issues a new key and gives the old one a short grace window.
 */
export const SCOPES = [
  "transactions:read",
  "transactions:write",
  "invoices:read",
  "invoices:write",
  "reports:read",
  "automations:write",
  "webhooks:write",
  "events:read",
] as const;
export type Scope = (typeof SCOPES)[number];
const KEY_RE = /^ap_(live|test)_([a-z0-9]{8})_([A-Za-z0-9_-]{32,})$/;

export async function generateApiKey(env: "live" | "test" = "live"): Promise<{ key: string; prefix: string; hash: string }> {
  const prefix = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  const key = `ap_${env}_${prefix}_${randomToken(24)}`;
  return { key, prefix, hash: await sha256(key) };
}

export function parseApiKey(key: string): { env: "live" | "test"; prefix: string } | null {
  const m = KEY_RE.exec(key.trim());
  return m ? { env: m[1] as "live" | "test", prefix: m[2]! } : null;
}

export const hashApiKey = (key: string) => sha256(key.trim());

/** `transactions:write` implies `transactions:read`. */
export function hasScope(granted: string[], needed: Scope): boolean {
  if (granted.includes(needed)) return true;
  const [res, lvl] = needed.split(":");
  return lvl === "read" && granted.includes(`${res}:write`);
}

export function isKeyUsable(k: { revoked_at: string | null; expires_at: string | null }, now: string): boolean {
  if (k.revoked_at && k.revoked_at <= now) return false;
  if (k.expires_at && k.expires_at <= now) return false;
  return true;
}
