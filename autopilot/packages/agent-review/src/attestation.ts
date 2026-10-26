import { canonicalJson } from "./canonical.js";

/**
 * D7 regulator-style evidence packs: control statements evaluated from facts, a manifest hash, and an Ed25519
 * signature over the canonical pack. The framework references are a mapping aid for the customer's own compliance
 * team, not legal advice or a certification.
 */
export interface PackFacts {
  requests: number;
  humanRouted: number;
  humanDecisions: number;
  autoDecided: number;
  integrityChecked: number;
  integrityFailed: number;
  integrityTruncated: boolean;
  retentionDays: number | null;
  policyVersions: number;
  criticalAutoApproved: number;
  legalHolds: number;
  redactions: number;
}
export type ControlStatus = "evidenced" | "gap" | "not_applicable";
export interface Control {
  id: string;
  refs: string[];
  statement: string;
  status: ControlStatus;
  detail: string;
}
/** EU AI Act deployers must keep automatically generated logs for at least six months (Art. 26(6)). */
export const MIN_LOG_RETENTION_DAYS = 183;

function integrity(f: PackFacts): Control {
  const base = {
    id: "record-keeping",
    refs: ["EU AI Act Art. 12", "EU AI Act Art. 19", "NIST AI RMF MEASURE"],
    statement: "Every request has a tamper-evident, hash-chained event log",
  };
  if (!f.integrityChecked) return { ...base, status: "not_applicable", detail: "no requests in period" };
  if (f.integrityFailed) return { ...base, status: "gap", detail: `${f.integrityFailed} of ${f.integrityChecked} trails failed verification` };
  if (f.integrityTruncated) return { ...base, status: "gap", detail: `only the first ${f.integrityChecked} trails were verified; narrow the period` };
  return { ...base, status: "evidenced", detail: `${f.integrityChecked} trails verified` };
}
function oversight(f: PackFacts): Control {
  const base = {
    id: "human-oversight",
    refs: ["EU AI Act Art. 14", "NIST AI RMF MANAGE"],
    statement: "Agent actions are routed to people by versioned policy; critical risk is never auto-approved",
  };
  if (f.criticalAutoApproved) return { ...base, status: "gap", detail: `${f.criticalAutoApproved} critical requests were auto-approved` };
  if (!f.requests) return { ...base, status: "not_applicable", detail: "no requests in period" };
  return {
    ...base,
    status: "evidenced",
    detail: `${f.humanRouted} of ${f.requests} routed to people (${f.humanDecisions} decisions); ${f.autoDecided} decided by policy`,
  };
}
function retention(f: PackFacts): Control {
  const base = {
    id: "log-retention",
    refs: ["EU AI Act Art. 26(6)", "UK GDPR Art. 5(1)(e)"],
    statement: `Logs are kept at least ${MIN_LOG_RETENTION_DAYS} days and then minimised`,
  };
  if (f.retentionDays === null) return { ...base, status: "gap", detail: "no retention period set (kept indefinitely: storage limitation not evidenced)" };
  if (f.retentionDays < MIN_LOG_RETENTION_DAYS)
    return { ...base, status: "gap", detail: `retention ${f.retentionDays} days is below ${MIN_LOG_RETENTION_DAYS}` };
  return { ...base, status: "evidenced", detail: `retention ${f.retentionDays} days; ${f.legalHolds} on legal hold; ${f.redactions} redacted` };
}
function governance(f: PackFacts): Control {
  const base = {
    id: "policy-governance",
    refs: ["NIST AI RMF GOVERN"],
    statement: "Routing rules are immutable, versioned and hashed; every request records the version that routed it",
  };
  return f.policyVersions
    ? { ...base, status: "evidenced", detail: `${f.policyVersions} policy versions in force during the period` }
    : { ...base, status: "evidenced", detail: "built-in default policy (every request to a human)" };
}

export function evaluateControls(f: PackFacts): Control[] {
  return [integrity(f), oversight(f), retention(f), governance(f)];
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const b64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export interface SignedPack<T> {
  pack: T;
  manifestSha256: string;
  signature: { alg: "Ed25519"; kid: string; value: string } | null;
}
/** manifestSha256 = sha256(canonicalJson(pack)); the signature (when a key is configured) is over the same bytes. */
export async function sealPack<T>(pack: T, key: { key: CryptoKey; kid: string } | null): Promise<SignedPack<T>> {
  const bytes = enc.encode(canonicalJson(pack));
  const manifestSha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const signature = key ? { alg: "Ed25519" as const, kid: key.kid, value: b64u(await crypto.subtle.sign("Ed25519", key.key, bytes)) } : null;
  return { pack, manifestSha256, signature };
}

export async function verifyPack<T>(s: SignedPack<T>, keys: (JsonWebKey & { kid?: string })[]): Promise<{ ok: boolean; reason?: string }> {
  const bytes = enc.encode(canonicalJson(s.pack));
  if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== s.manifestSha256) return { ok: false, reason: "manifest_mismatch" };
  if (!s.signature) return { ok: false, reason: "unsigned" };
  const jwk = keys.find((k) => k.kid === s.signature!.kid);
  if (!jwk) return { ok: false, reason: "unknown_kid" };
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(s.signature.value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return (await crypto.subtle.verify("Ed25519", pub, sig, bytes)) ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}
