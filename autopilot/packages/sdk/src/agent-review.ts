/**
 * High-level client for the agent review layer: ask a human before a risky action, wait for the decision, and act
 * on the (possibly edited) payload. Dependency-free (fetch + WebCrypto), so it runs in Node 18+, Workers, Deno and browsers.
 *
 *   const reviews = new ReviewClient({ baseUrl, apiKey });
 *   const r = await reviews.requestAndWait({ action: "refund.issue", payload: { amount: 120 }, risk: "high" });
 *   if (r.status === "approved") await issueRefund(r.payload);
 */
import type { components, paths } from "./schema.js";

export type Review = components["schemas"]["ReviewRequest"];
export type ReviewInput = paths["/v1/agent-reviews"]["post"]["requestBody"]["content"]["application/json"];
export type Decision = "approve" | "reject" | "edit" | "escalate";
export type FinalStatus = "approved" | "rejected" | "expired" | "cancelled";
export const FINAL_STATUSES: ReadonlySet<string> = new Set<FinalStatus>(["approved", "rejected", "expired", "cancelled"]);

export interface ReviewClientOptions {
  baseUrl: string;
  /** `ap_…` API key with reviews:write (and reviews:read for waiting). */
  apiKey: string;
  fetch?: typeof fetch;
  /** Retries for network errors, 429 and 5xx (default 4). Writes are safe to retry: each call pins one Idempotency-Key. */
  retries?: number;
  /** Base backoff in ms (default 250; doubles per attempt with full jitter, capped at 8s; Retry-After wins when sent). */
  backoffMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class ReviewApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "ReviewApiError";
  }
}
/** Thrown by guarded tools when a human (or policy) said no, or nobody answered in time. */
export class ReviewNotApproved extends Error {
  constructor(readonly review: Review) {
    super(`Review ${review.id} ended ${review.status}`);
    this.name = "ReviewNotApproved";
  }
}

const RETRYABLE = (s: number) => s === 429 || s === 502 || s === 503 || s === 504 || s === 500;

export class ReviewClient {
  private readonly f: typeof fetch;
  private readonly base: string;
  constructor(private readonly o: ReviewClientOptions) {
    if (!o.apiKey) throw new Error("ReviewClient: apiKey is required");
    this.f = o.fetch ?? fetch;
    this.base = o.baseUrl.replace(/\/+$/, "");
  }

  private sleep(ms: number) {
    return (this.o.sleep ?? ((m) => new Promise<void>((r) => setTimeout(r, m))))(ms);
  }
  private backoff(attempt: number, retryAfter: string | null): number {
    const ra = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, 60_000);
    const cap = Math.min(8000, (this.o.backoffMs ?? 250) * 2 ** attempt);
    return Math.floor((this.o.random ?? Math.random)() * cap);
  }

  /** One logical call: retried on transient failures with the same Idempotency-Key. */
  async call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, idempotencyKey?: string): Promise<{ data: T; headers: Headers }> {
    const key = method === "GET" ? undefined : (idempotencyKey ?? crypto.randomUUID());
    const retries = this.o.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.f(
          new Request(`${this.base}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${this.o.apiKey}`,
              accept: "application/json",
              ...(body !== undefined ? { "content-type": "application/json" } : {}),
              ...(key ? { "idempotency-key": key } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          }),
        );
      } catch (e) {
        if (attempt >= retries) throw e;
        await this.sleep(this.backoff(attempt, null));
        continue;
      }
      if (res.ok) return { data: (await res.json()) as T, headers: res.headers };
      if (RETRYABLE(res.status) && attempt < retries) {
        await this.sleep(this.backoff(attempt, res.headers.get("retry-after")));
        continue;
      }
      const j = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; requestId?: string } };
      throw new ReviewApiError(
        res.status,
        j.error?.code ?? "http_error",
        j.error?.message ?? `HTTP ${res.status}`,
        j.error?.requestId ?? res.headers.get("x-request-id"),
      );
    }
  }

  /**
   * Ask for a review. Pass `idempotencyKey` (e.g. your run id + step) so a crashed-and-restarted agent gets the
   * same request back instead of a duplicate; `externalId` is used when no key is given.
   */
  async request(input: ReviewInput & { idempotencyKey?: string }): Promise<Review> {
    const { idempotencyKey, ...body } = input;
    const key = idempotencyKey ?? (body.externalId ? `ext:${body.externalId}` : undefined);
    return (await this.call<Review>("POST", "/v1/agent-reviews", body, key)).data;
  }
  async get(id: string): Promise<Review> {
    return (await this.call<Review>("GET", `/v1/agent-reviews/${encodeURIComponent(id)}`)).data;
  }

  /** Long-poll until final or `timeoutMs` (default 15 min). Returns the latest state either way; check `status`. */
  async wait(id: string, opts: { timeoutMs?: number } = {}): Promise<Review> {
    const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
    for (;;) {
      const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
      const { data } = await this.call<Review>("GET", `/v1/agent-reviews/${encodeURIComponent(id)}/wait?timeoutSeconds=${Math.min(25, left)}`);
      if (FINAL_STATUSES.has(data.status) || left === 0) return data;
    }
  }
  async requestAndWait(input: ReviewInput & { idempotencyKey?: string }, opts: { timeoutMs?: number } = {}): Promise<Review> {
    const r = await this.request(input);
    return FINAL_STATUSES.has(r.status) ? r : this.wait(r.id, opts);
  }
  async decide(id: string, decision: Decision, extra: { reason?: string; payload?: Record<string, unknown> } = {}): Promise<Review> {
    return (await this.call<Review>("POST", `/v1/agent-reviews/${encodeURIComponent(id)}/decisions`, { decision, ...extra })).data;
  }
  async cancel(id: string, reason?: string): Promise<Review> {
    return (await this.call<Review>("POST", `/v1/agent-reviews/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {})).data;
  }
  async receipt(id: string): Promise<SignedReceipt> {
    return (await this.call<SignedReceipt>("GET", `/v1/agent-reviews/${encodeURIComponent(id)}/receipt`)).data;
  }
  async receiptKeys(): Promise<PublicJwk[]> {
    return (await this.call<{ keys: PublicJwk[] }>("GET", "/v1/agent-review/receipt-keys")).data.keys;
  }
}

// ---------------- verification helpers (receiver side) ----------------
export type PublicJwk = { kty?: string; crv?: string; x?: string; kid: string };
export type SignedReceipt = { receipt: Record<string, unknown>; alg: "Ed25519"; kid: string; signature: string };
export type CallbackEvent = {
  /** Callback id: stable across retries and redeliveries; dedupe on it. */
  id: string;
  type: "review.completed";
  eventId: string;
  created: string;
  requestVersion: number;
  decidedAt: string | null;
  data: {
    requestId: string;
    projectId: string;
    status: FinalStatus;
    payload: Record<string, unknown> | null;
    payloadVersion: number;
    externalId: string | null;
  };
};

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hmac(secret: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

/**
 * Verify a callback or webhook from the review layer and return the parsed event. Pass every secret currently
 * valid (old + new during rotation). Rejects stale timestamps (replay protection, default 5 min).
 */
export async function verifyCallback(
  rawBody: string,
  signatureHeader: string | null | undefined,
  secrets: string[],
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): Promise<CallbackEvent> {
  const parts = (signatureHeader ?? "").split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find((p) => p[0] === "t")?.[1]);
  const sigs = parts.filter((p) => p[0] === "v1" && p[1]).map((p) => p[1]!);
  if (!Number.isInteger(t) || !sigs.length) throw new Error("signature header malformed");
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) throw new Error("signature timestamp outside tolerance");
  for (const s of secrets) {
    const want = await hmac(s, `${t}.${rawBody}`);
    if (sigs.some((g) => safeEqual(g, want))) return JSON.parse(rawBody) as CallbackEvent;
  }
  throw new Error("signature mismatch");
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}
/** Offline receipt verification: Ed25519 over the canonical receipt body with the key whose kid matches. */
export async function verifyReceipt(r: SignedReceipt, keys: PublicJwk[]): Promise<boolean> {
  const k = keys.find((x) => x.kid === r.kid);
  if (!k || r.alg !== "Ed25519") return false;
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: k.kty, crv: k.crv, x: k.x }, { name: "Ed25519" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(r.signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify("Ed25519", pub, sig, enc.encode(canonical(r.receipt)));
  } catch {
    return false;
  }
}
