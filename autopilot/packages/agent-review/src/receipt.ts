import { canonicalJson } from "./canonical.js";

/**
 * Signed decision receipts: an Ed25519 signature over the canonical receipt body, verifiable offline by anyone holding
 * the published public key (no call back to us needed). The body pins the chain head, so a receipt also proves
 * the audit trail it was issued from.
 */
export interface ReceiptBody {
  v: 1;
  requestId: string;
  tenantId: string;
  projectId: string;
  action: string;
  status: "approved" | "rejected" | "expired" | "cancelled";
  payloadSha256: string;
  payloadVersion: number;
  decisions: { reviewer: string; decision: string; payloadVersion: number; at: string }[];
  policy: { version: number | null; ruleId: string | null };
  chain: { length: number; head: string };
  decidedAt: string | null;
  issuedAt: string;
}
export interface SignedReceipt {
  receipt: ReceiptBody;
  alg: "Ed25519";
  kid: string;
  signature: string;
}

const enc = new TextEncoder();
const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function signReceipt(body: ReceiptBody, key: CryptoKey, kid: string): Promise<SignedReceipt> {
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, enc.encode(canonicalJson(body))));
  return { receipt: body, alg: "Ed25519", kid, signature: b64u(sig) };
}

export type ReceiptVerdict = { ok: true } | { ok: false; reason: "unknown_kid" | "bad_alg" | "bad_signature" | "malformed" };

/** `keys`: public JWKs (OKP / Ed25519) with `kid`. */
export async function verifyReceipt(r: SignedReceipt, keys: (JsonWebKey & { kid?: string })[]): Promise<ReceiptVerdict> {
  if (r.alg !== "Ed25519") return { ok: false, reason: "bad_alg" };
  const jwk = keys.find((k) => k.kid === r.kid);
  if (!jwk) return { ok: false, reason: "unknown_kid" };
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("Ed25519", pub, unb64u(r.signature), enc.encode(canonicalJson(r.receipt)));
    return ok ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** Import a private Ed25519 JWK (as stored in the RECEIPT_SIGNING_JWK secret) and derive its public JWK. */
export async function loadSigningKey(privateJwkJson: string): Promise<{ key: CryptoKey; kid: string; publicJwk: JsonWebKey & { kid: string } }> {
  const j = JSON.parse(privateJwkJson) as JsonWebKey & { kid?: string };
  if (j.kty !== "OKP" || j.crv !== "Ed25519" || !j.d || !j.x || !j.kid) throw new Error("RECEIPT_SIGNING_JWK must be an Ed25519 private JWK with kid");
  const key = await crypto.subtle.importKey("jwk", j, { name: "Ed25519" }, false, ["sign"]);
  return { key, kid: j.kid, publicJwk: { kty: "OKP", crv: "Ed25519", x: j.x, kid: j.kid } };
}
