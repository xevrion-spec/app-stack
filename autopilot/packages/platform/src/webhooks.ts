import { hmacSha256Hex, timingSafeEqual } from "./crypto.js";

/**
 * Outbound webhook signing (Stripe-style): header `Autopilot-Signature: t=<unix>,v1=<hex hmac(secret, "<t>.<body>")>`.
 * Receivers verify with `verifySignature` and reject timestamps outside the tolerance (replay protection).
 */
export const SIGNATURE_HEADER = "autopilot-signature";

export async function signPayload(secret: string, body: string, unixSeconds: number): Promise<string> {
  return `t=${unixSeconds},v1=${await hmacSha256Hex(secret, `${unixSeconds}.${body}`)}`;
}

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "stale" | "mismatch" };

/** Accepts several v1 signatures (secret rotation: old + new both valid during the overlap). */
export async function verifySignature(
  secrets: string[],
  header: string | null | undefined,
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): Promise<VerifyResult> {
  if (!header) return { ok: false, reason: "malformed" };
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find((p) => p[0] === "t")?.[1]);
  const sigs = parts.filter((p) => p[0] === "v1" && p[1]).map((p) => p[1]!);
  if (!Number.isInteger(t) || !sigs.length) return { ok: false, reason: "malformed" };
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return { ok: false, reason: "stale" };
  for (const s of secrets) {
    const want = await hmacSha256Hex(s, `${t}.${body}`);
    if (sigs.some((g) => timingSafeEqual(g, want))) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}

/** Retry schedule: exponential backoff with "full jitter", capped. attempt is 1-based (1 = first retry). */
export const RETRY_POLICY = { maxAttempts: 8, baseSeconds: 30, capSeconds: 6 * 3600 } as const;
export function backoffSeconds(attempt: number, rand: () => number = Math.random, p: { baseSeconds: number; capSeconds: number } = RETRY_POLICY): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt must be a positive integer");
  const ceiling = Math.min(p.capSeconds, p.baseSeconds * 2 ** (attempt - 1));
  // full jitter in [ceiling/2, ceiling] keeps a minimum spacing while de-synchronising retries
  return Math.max(1, Math.round(ceiling / 2 + rand() * (ceiling / 2)));
}

/** Which HTTP outcomes are worth retrying. 4xx (except 408/409/425/429) means the receiver rejected it: don't hammer. */
export function isRetryable(status: number | null): boolean {
  if (status === null) return true; // network error / timeout
  if (status >= 500) return true;
  return [408, 409, 425, 429].includes(status);
}

/** Auto-disable when an endpoint has failed continuously for this long or this many deliveries in a row. */
export const DISABLE_POLICY = { consecutiveFailures: 20, failingForHours: 72 } as const;
export function shouldDisable(
  consecutiveFailures: number,
  firstFailureAt: string | null,
  now: string,
  p: { consecutiveFailures: number; failingForHours: number } = DISABLE_POLICY,
): boolean {
  if (consecutiveFailures >= p.consecutiveFailures) return true;
  if (!firstFailureAt || consecutiveFailures === 0) return false;
  return Date.parse(now) - Date.parse(firstFailureAt) >= p.failingForHours * 3600_000 && consecutiveFailures >= 3;
}

/**
 * SSRF guard for user-supplied webhook URLs. https only (http allowed for explicit dev hosts), no credentials, default or
 * explicit 443/8443 ports, and no literal private/loopback/link-local/metadata addresses or internal-looking host names.
 * DNS rebinding is out of scope here: Workers' fetch cannot reach private networks, which is the second layer.
 */
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".localhost", ".lan", ".home", ".corp", ".intranet"];
export function validateWebhookUrl(raw: string, opts: { allowHttpHosts?: string[] } = {}): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (raw.length > 2048) return { ok: false, reason: "URL too long" };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const devHttp = u.protocol === "http:" && (opts.allowHttpHosts ?? []).includes(host);
  if (u.protocol !== "https:" && !devHttp) return { ok: false, reason: "https is required" };
  if (u.username || u.password) return { ok: false, reason: "credentials in URL are not allowed" };
  if (u.port && !["443", "8443"].includes(u.port) && !devHttp) return { ok: false, reason: "port not allowed" };
  if (devHttp) return { ok: true, url: u };
  if ((!host.includes(".") && !host.includes(":")) || host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)))
    return { ok: false, reason: "internal host names are not allowed" };
  if (isPrivateAddress(host)) return { ok: false, reason: "private or reserved address" };
  return { ok: true, url: u };
}

// eslint-disable-next-line complexity -- known debt (docs/quality.md): split in a follow-up
export function isPrivateAddress(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (host.includes(":")) {
    const h = host.toLowerCase();
    if (h === "::" || h === "::1") return true;
    const mapped = h.match(/^::ffff:(.+)$/);
    if (mapped) return mapped[1]!.includes(".") ? isPrivateAddress(mapped[1]!) : true;
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(h);
  }
  return false;
}

/** Parses dotted, and the decimal/hex/octal shorthand forms browsers and fetch accept (e.g. 2130706433, 0x7f.1). */
export function parseIpv4(host: string): [number, number, number, number] | null {
  if (!/^[0-9a-fx.]+$/i.test(host)) return null;
  const parts = host.split(".");
  if (parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums = parts.map((p) => (/^0x[0-9a-f]+$/i.test(p) ? parseInt(p, 16) : /^0[0-7]+$/.test(p) ? parseInt(p, 8) : /^\d+$/.test(p) ? parseInt(p, 10) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  const last = nums[nums.length - 1]!;
  const head = nums.slice(0, -1);
  if (head.some((n) => n > 255)) return null;
  const maxLast = 256 ** (5 - nums.length);
  if (last >= maxLast) return null;
  const value = head.reduce((acc, n, i) => acc + n * 256 ** (3 - i), 0) + last;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}
