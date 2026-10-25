/**
 * Feature flags (stored as JSON in KV under `flags`): global default, per-tenant overrides, and a deterministic percentage
 * rollout by tenant id hash. Unknown flags are off. Bad JSON fails safe (all off) rather than throwing.
 */
export interface FlagDef {
  default: boolean;
  tenants?: Record<string, boolean>;
  rolloutPercent?: number;
}
export type FlagSet = Record<string, FlagDef>;

export function parseFlags(json: string | null): FlagSet {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as FlagSet) : {};
  } catch {
    return {};
  }
}

export function bucketOf(tenantId: string): number {
  let h = 2166136261;
  for (let i = 0; i < tenantId.length; i++) h = Math.imul(h ^ tenantId.charCodeAt(i), 16777619);
  return (h >>> 0) % 100;
}

export function isEnabled(flags: FlagSet, name: string, tenantId: string): boolean {
  const f = flags[name];
  if (!f) return false;
  const o = f.tenants?.[tenantId];
  if (typeof o === "boolean") return o;
  if (typeof f.rolloutPercent === "number") return bucketOf(tenantId) < Math.max(0, Math.min(100, f.rolloutPercent));
  return f.default === true;
}

/** Plan quotas per month. Metered units feed billing_events. */
export const PLAN_QUOTAS: Record<string, Record<string, number>> = {
  free: { transactions: 500, automation_runs: 1_000, webhook_deliveries: 1_000, api_requests: 10_000 },
  starter: { transactions: 5_000, automation_runs: 20_000, webhook_deliveries: 20_000, api_requests: 200_000 },
  pro: { transactions: 50_000, automation_runs: 200_000, webhook_deliveries: 200_000, api_requests: 2_000_000 },
};
export function quotaCheck(plan: string | null, metric: string, used: number, adding = 1): { allowed: boolean; limit: number; remaining: number } {
  const limit = (PLAN_QUOTAS[plan ?? "free"] ?? PLAN_QUOTAS.free!)[metric] ?? Infinity;
  return { allowed: used + adding <= limit, limit, remaining: Math.max(0, limit - used - (used + adding <= limit ? adding : 0)) };
}
