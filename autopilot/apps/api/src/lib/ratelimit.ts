import type { MiddlewareHandler } from "hono";
import { takeToken, type Bucket } from "@xevrion/platform";
import type { AppEnv } from "../env.js";
import { AppError } from "./errors.js";

/**
 * Per-principal token bucket with IETF RateLimit headers. State is per isolate (a soft limit that smooths bursts);
 * the hard edge limit is the Cloudflare WAF rate-limit rule. Durable-Object backed limits are a later upgrade.
 */
const buckets = new Map<string, Bucket>();
let now = () => Date.now();
export const __setRateLimitClock = (f: (() => number) | null) => {
  now = f ?? (() => Date.now());
  buckets.clear();
};
export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const p = c.get("principal");
  const pr = c.get("practice");
  const po = c.get("portal");
  if (!p && !pr && !po) return next();
  // API keys get their own (lower) bucket per key, so one integration cannot exhaust a user's interactive budget.
  const perMin = p?.apiKey
    ? Math.max(1, Number(c.env.RATE_LIMIT_API_KEY_PER_MINUTE ?? 120) || 120)
    : Math.max(1, Number(c.env.RATE_LIMIT_PER_MINUTE ?? 600) || 600);
  const key = p ? (p.apiKey ? `key:${p.apiKey.id}` : `${p.tenantId}:${p.userId}`) : pr ? `practice:${pr.practiceId}:${pr.email}` : `portal:${po.portalUserId}`;
  const r = takeToken(buckets.get(key) ?? null, now(), perMin, perMin / 60);
  buckets.set(key, r.bucket);
  if (buckets.size > 10_000) buckets.delete(buckets.keys().next().value!);
  c.header("ratelimit-limit", String(perMin));
  c.header("ratelimit-remaining", String(r.remaining));
  c.header("ratelimit-reset", String(r.resetSeconds));
  if (!r.allowed) {
    c.header("retry-after", String(Math.max(1, Math.ceil(1 / (perMin / 60)))));
    throw new AppError(429, "rate_limited", "Too many requests");
  }
  return next();
};

/** API versioning: every response says which version served it; deprecated routes advertise Sunset + successor. */
const API_VERSION = "1";
const DEPRECATIONS: { method: string; path: RegExp; sunset: string; link: string }[] = [
  // Example policy entry: the flat invoice list will be replaced by a paginated one.
  { method: "GET", path: /^\/v1\/billing\/events$/, sunset: "2027-06-30", link: "/v1/usage" },
];
export const versioning: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("api-version", API_VERSION);
  const path = new URL(c.req.url).pathname;
  const d = DEPRECATIONS.find((x) => x.method === c.req.method && x.path.test(path));
  if (d) {
    c.header("deprecation", "true");
    c.header("sunset", new Date(`${d.sunset}T00:00:00Z`).toUTCString());
    c.header("link", `<${d.link}>; rel="successor-version"`);
  }
};
