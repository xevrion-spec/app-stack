/**
 * Practice (accountancy firm) co-pilot: pure, deterministic logic used by the practice API. No I/O.
 * Health scores, review-age buckets and SLA states, per-client deadline calendars, QA sampling, auto-approve policy,
 * WIP / billing-ready maths. Tax dates come from deadlines.ts and are UNVERIFIED like every rate in this repo.
 */
import { mtdQuarterlyDeadlines, saDeadlines, taxYearOf, upcoming, vatDeadlines, type Deadline } from "./deadlines.js";

export type PracticeRole = "partner" | "manager" | "preparer" | "reviewer" | "readonly";
export const PRACTICE_ROLES: readonly PracticeRole[] = ["partner", "manager", "preparer", "reviewer", "readonly"];
/** Roles that see every client of the practice; preparers and reviewers see only clients they are assigned to. */
export const SEES_ALL_CLIENTS: ReadonlySet<PracticeRole> = new Set(["partner", "manager", "readonly"]);

export interface HealthInput {
  awaitingReview: number;
  oldestAwaitingDays: number;
  openQueries: number;
  overdueDeadlines: number;
  dueSoonDeadlines: number;
  anomalies: number;
  daysSinceLastActivity: number | null;
}
export interface Health {
  score: number;
  status: "green" | "amber" | "red";
  reasons: string[];
}
/** 100 = nothing needs attention. Each signal subtracts a capped penalty, and every penalty is explained. */
export function clientHealth(h: HealthInput): Health {
  const reasons: string[] = [];
  let score = 100;
  const pen = (cond: boolean, amount: number, reason: string) => {
    if (!cond) return;
    score -= amount;
    reasons.push(reason);
  };
  pen(h.overdueDeadlines > 0, Math.min(40, 25 * h.overdueDeadlines), `${h.overdueDeadlines} overdue deadline(s)`);
  pen(h.dueSoonDeadlines > 0, Math.min(10, 5 * h.dueSoonDeadlines), `${h.dueSoonDeadlines} deadline(s) within 14 days`);
  pen(h.oldestAwaitingDays > 7, Math.min(20, h.oldestAwaitingDays - 7), `oldest item awaiting review is ${h.oldestAwaitingDays} days old`);
  pen(h.awaitingReview > 50, 10, `${h.awaitingReview} items awaiting review`);
  pen(h.openQueries > 0, Math.min(10, 2 * h.openQueries), `${h.openQueries} open client quer${h.openQueries === 1 ? "y" : "ies"}`);
  pen(h.anomalies > 0, Math.min(15, 3 * h.anomalies), `${h.anomalies} anomal${h.anomalies === 1 ? "y" : "ies"} flagged`);
  pen(h.daysSinceLastActivity !== null && h.daysSinceLastActivity > 45, 10, `no bookkeeping activity for ${h.daysSinceLastActivity} days`);
  score = Math.max(0, score);
  return { score, status: score >= 80 ? "green" : score >= 50 ? "amber" : "red", reasons };
}

export const REVIEW_AGE_BUCKETS = ["0-2d", "3-7d", "8-14d", "15d+"] as const;
export type ReviewAgeBucket = (typeof REVIEW_AGE_BUCKETS)[number];
export function ageBucket(days: number): ReviewAgeBucket {
  if (days <= 2) return "0-2d";
  if (days <= 7) return "3-7d";
  if (days <= 14) return "8-14d";
  return "15d+";
}
export function bucketCounts(days: number[]): Record<ReviewAgeBucket, number> {
  const out = Object.fromEntries(REVIEW_AGE_BUCKETS.map((b) => [b, 0])) as Record<ReviewAgeBucket, number>;
  for (const d of days) out[ageBucket(d)]++;
  return out;
}
export type SlaState = "ok" | "due_soon" | "breached";
/** due_soon from 75% of the SLA window; breached once it is exceeded. */
export function slaState(ageHours: number, slaHours: number): SlaState {
  if (ageHours > slaHours) return "breached";
  if (ageHours >= slaHours * 0.75) return "due_soon";
  return "ok";
}

export interface ClientCalendarConfig {
  vatStagger: 1 | 2 | 3 | null;
  mtdItsa: boolean;
  saRequired: boolean;
}
const STAGGER_MONTHS = { 1: [3, 6, 9, 12], 2: [1, 4, 7, 10], 3: [2, 5, 8, 11] } as const;
/** Quarter end one period before the latest quarter end before `today` (stagger 1: Mar/Jun/Sep/Dec, 2: Jan/Apr/Jul/Oct,
 * 3: Feb/May/Aug/Nov). Starting there means a calendar of 4 periods covers the overdue, due and next returns. */
export function firstVatPeriodEnd(stagger: 1 | 2 | 3, today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const months: readonly number[] = STAGGER_MONTHS[stagger];
  let k = y * 12 + (m - 1) - 1; // month index of the previous month
  while (!months.includes((k % 12) + 1)) k--;
  k -= 3;
  return new Date(Date.UTC(Math.floor(k / 12), (k % 12) + 1, 0)).toISOString().slice(0, 10);
}
/** Deadlines for one client in a window around `today` (overdue up to 30 days back, up to `days` ahead). */
export function clientDeadlines(cfg: ClientCalendarConfig, today: string, days = 90): (Deadline & { daysLeft: number })[] {
  const ty = taxYearOf(today);
  const prevTy = `${Number(ty.slice(0, 4)) - 1}-${ty.slice(2, 4)}`;
  const all: Deadline[] = [];
  if (cfg.saRequired) all.push(...saDeadlines(prevTy), ...saDeadlines(ty));
  if (cfg.mtdItsa) all.push(...mtdQuarterlyDeadlines(prevTy), ...mtdQuarterlyDeadlines(ty));
  if (cfg.vatStagger) all.push(...vatDeadlines(firstVatPeriodEnd(cfg.vatStagger, today), 4));
  const seen = new Set<string>();
  return upcoming(all, today, days).filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
}

/** FNV-1a 32-bit: a stable, dependency-free hash for deterministic sampling. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** Deterministic QA sample: an item is sampled iff hash(seed:id) falls under the rate. At least one item when rate > 0. */
export function qaSample(ids: readonly string[], rate: number, seed: string): string[] {
  if (rate <= 0 || !ids.length) return [];
  if (rate >= 1) return [...ids];
  const picked = ids.filter((id) => fnv1a(`${seed}:${id}`) % 10_000 < Math.round(rate * 10_000));
  return picked.length ? picked : [ids.reduce((a, b) => (fnv1a(`${seed}:${a}`) <= fnv1a(`${seed}:${b}`) ? a : b))];
}

export interface AutoApprovePolicy {
  threshold: number;
  categories: string[];
}
export interface ReviewCandidate {
  id: string;
  categoryCode: string | null;
  confidence: number | null;
  status: string;
}
/** Auto-approval needs ALL of: an AI category (not suspense 9999), confidence >= threshold (floor 0.9), category allowlisted. */
export function autoApproveDecision(t: ReviewCandidate, p: AutoApprovePolicy): { approve: boolean; reason: string } {
  const threshold = Math.max(0.9, p.threshold);
  if (!t.categoryCode || t.categoryCode === "9999" || t.status === "needs_review") return { approve: false, reason: "no confident category" };
  if ((t.confidence ?? 0) < threshold) return { approve: false, reason: `confidence ${t.confidence ?? 0} below ${threshold}` };
  if (!p.categories.includes(t.categoryCode)) return { approve: false, reason: `category ${t.categoryCode} not allowlisted for auto-approval` };
  return { approve: true, reason: `category ${t.categoryCode} at confidence ${t.confidence} >= ${threshold}` };
}
export function parsePolicy(json: string | null | undefined): AutoApprovePolicy {
  try {
    const p = JSON.parse(json ?? "{}") as Partial<AutoApprovePolicy>;
    return {
      threshold: typeof p.threshold === "number" ? p.threshold : 0.97,
      categories: Array.isArray(p.categories) ? p.categories.filter((c): c is string => typeof c === "string") : [],
    };
  } catch {
    return { threshold: 0.97, categories: [] };
  }
}

export interface WipInput {
  feeModel: "fixed" | "hourly" | "outcome";
  feePence: number;
  hourlyRatePence: number;
  unbilledMinutes: number;
  completedOutcomes: number;
  monthsSinceLastBill: number;
}
/** Work in progress (internal valuation, not an invoice): hourly = time x rate; fixed = fee per month elapsed; outcome = fee per completed close. */
export function wipPence(w: WipInput): number {
  if (w.feeModel === "hourly") return Math.round((w.unbilledMinutes / 60) * w.hourlyRatePence);
  if (w.feeModel === "fixed") return w.feePence * Math.max(0, w.monthsSinceLastBill);
  return w.feePence * Math.max(0, w.completedOutcomes);
}

/** Stable confirmation token for a bulk action preview: same action + same targets + same counts = same token. */
export function bulkConfirmToken(action: string, targets: readonly string[], affected: number): string {
  return `bc_${fnv1a(`${action}|${[...targets].sort().join(",")}|${affected}`).toString(36)}`;
}
