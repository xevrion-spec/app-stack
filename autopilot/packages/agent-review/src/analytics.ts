import type { RiskLevel } from "./schemas.js";
import { PolicyDocument, type PolicyRule } from "./policy.js";

/**
 * D3 reviewer-quality analytics and D4 "learn when to stop" suggestions. Pure functions over decided history so
 * they can be property-tested and mutation-tested. Signals, not verdicts: low-sample reviewers get no rates.
 */
export const MIN_REVIEWER_SAMPLE = 10;
const FAST_SECONDS = 5;

export interface DecisionRow {
  reviewer: string;
  decision: "approve" | "reject" | "edit" | "escalate";
  requestId: string;
  requestCreatedAt: string;
  decidedAt: string;
  risk: RiskLevel;
}
export interface ReviewerStats {
  reviewer: string;
  decisions: number;
  counts: Record<DecisionRow["decision"], number>;
  medianSeconds: number | null;
  p90Seconds: number | null;
  approveRate: number | null;
  approveRateHighRisk: number | null;
  disagreementRate: number | null;
  flags: ("low_sample" | "fast_approvals" | "approves_high_risk_more")[];
}

const round = (x: number) => Math.round(x * 1000) / 1000;
export function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}
const rate = (num: number, den: number) => (den ? round(num / den) : null);

/** Per request, the set of verdicts (approve/reject) so each reviewer can be compared to their co-reviewers. */
function verdictsByRequest(rows: readonly DecisionRow[]) {
  const m = new Map<string, Map<string, "approve" | "reject">>();
  for (const r of rows) {
    if (r.decision !== "approve" && r.decision !== "reject") continue;
    const v = m.get(r.requestId) ?? new Map();
    v.set(r.reviewer, r.decision);
    m.set(r.requestId, v);
  }
  return m;
}

function disagreement(reviewer: string, verdicts: Map<string, Map<string, "approve" | "reject">>) {
  let shared = 0,
    differ = 0;
  for (const v of verdicts.values()) {
    const mine = v.get(reviewer);
    if (!mine || v.size < 2) continue;
    shared++;
    if ([...v].some(([who, d]) => who !== reviewer && d !== mine)) differ++;
  }
  return rate(differ, shared);
}

function statsFor(reviewer: string, mine: readonly DecisionRow[], verdicts: ReturnType<typeof verdictsByRequest>): ReviewerStats {
  const counts = { approve: 0, reject: 0, edit: 0, escalate: 0 };
  for (const r of mine) counts[r.decision]++;
  const secs = mine.map((r) => Math.max(0, (Date.parse(r.decidedAt) - Date.parse(r.requestCreatedAt)) / 1000)).sort((a, b) => a - b);
  const verdictRows = mine.filter((r) => r.decision === "approve" || r.decision === "reject");
  const high = verdictRows.filter((r) => r.risk === "high" || r.risk === "critical");
  const low = verdictRows.length < MIN_REVIEWER_SAMPLE;
  const approveRate = low ? null : rate(counts.approve, verdictRows.length);
  const approveRateHighRisk = low || high.length < MIN_REVIEWER_SAMPLE ? null : rate(high.filter((r) => r.decision === "approve").length, high.length);
  const median = quantile(secs, 0.5);
  const flags: ReviewerStats["flags"] = [];
  if (low) flags.push("low_sample");
  if (!low && median !== null && median < FAST_SECONDS && (approveRate ?? 0) >= 0.95) flags.push("fast_approvals");
  if (approveRate !== null && approveRateHighRisk !== null && approveRateHighRisk > approveRate) flags.push("approves_high_risk_more");
  return {
    reviewer,
    decisions: mine.length,
    counts,
    medianSeconds: median === null ? null : round(median),
    p90Seconds: secs.length ? round(quantile(secs, 0.9)!) : null,
    approveRate,
    approveRateHighRisk,
    disagreementRate: low ? null : disagreement(reviewer, verdicts),
    flags,
  };
}

export function reviewerStats(rows: readonly DecisionRow[]): ReviewerStats[] {
  const verdicts = verdictsByRequest(rows);
  const by = new Map<string, DecisionRow[]>();
  for (const r of rows) by.set(r.reviewer, [...(by.get(r.reviewer) ?? []), r]);
  return [...by].map(([who, mine]) => statsFor(who, mine, verdicts)).sort((a, b) => b.decisions - a.decisions || a.reviewer.localeCompare(b.reviewer));
}

/** Wilson score lower bound (95%): a conservative estimate of the true success rate given k of n. */
export function wilsonLower(k: number, n: number, z = 1.959964): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

export interface OutcomeRow {
  action: string;
  risk: RiskLevel;
  confidence: number | null;
  status: "approved" | "rejected" | "expired" | "cancelled";
  edited: boolean;
}
export interface SuggestOptions {
  minSample?: number;
  target?: number;
}
export interface Suggestion {
  action: string;
  risk: "low" | "medium";
  minConfidence: number;
  sample: number;
  cleanApprovals: number;
  wilsonLower: number;
  shadow: { wouldAutoApprove: number; wouldHaveBeenRejected: number; wouldHaveBeenEdited: number; excludedLowConfidence: number };
  rule: PolicyRule;
}
const SUGGESTIBLE: readonly RiskLevel[] = ["low", "medium"];

function suggestGroup(action: string, risk: "low" | "medium", rows: readonly OutcomeRow[], minSample: number, target: number): Suggestion | null {
  const confs = rows
    .filter((r) => r.status === "approved" && !r.edited && r.confidence !== null)
    .map((r) => r.confidence!)
    .sort((a, b) => a - b);
  if (confs.length < minSample) return null;
  const minConfidence = round(Math.max(0.5, quantile(confs, 0.1)!));
  const covered = rows.filter((r) => r.confidence !== null && r.confidence >= minConfidence);
  const clean = covered.filter((r) => r.status === "approved" && !r.edited).length;
  const lb = wilsonLower(clean, covered.length);
  if (covered.length < minSample || lb < target) return null;
  return {
    action,
    risk,
    minConfidence,
    sample: covered.length,
    cleanApprovals: clean,
    wilsonLower: round(lb),
    shadow: {
      wouldAutoApprove: covered.length,
      wouldHaveBeenRejected: covered.filter((r) => r.status === "rejected").length,
      wouldHaveBeenEdited: covered.filter((r) => r.edited).length,
      excludedLowConfidence: rows.length - covered.length,
    },
    rule: {
      id: `suggested-${risk}-${action.replace(/[^A-Za-z0-9]+/g, "-")}`.slice(0, 60),
      description: `Suggested from ${covered.length} human decisions (Wilson lower bound ${round(lb)}); review before activating`,
      when: { action, risk: [risk], minConfidence },
      then: { outcome: "auto_approve", approvals: 1 },
    },
  };
}

/**
 * Suggest auto-approve rules only where humans almost always approved unchanged. Guardrails: never high/critical,
 * minimum sample, Wilson lower bound >= target, minConfidence >= 0.5, timed-out/cancelled requests count against.
 * Output is a draft only; activating it goes through the normal canary + impact-preview flow.
 */
export function suggestAutoApprove(rows: readonly OutcomeRow[], opts: SuggestOptions = {}): Suggestion[] {
  const minSample = Math.max(20, opts.minSample ?? 50);
  const target = Math.min(0.999, Math.max(0.9, opts.target ?? 0.97));
  const groups = new Map<string, OutcomeRow[]>();
  for (const r of rows) {
    if (!SUGGESTIBLE.includes(r.risk) || r.action.length > 120 || r.action.includes("*")) continue;
    const k = `${r.risk}\u0000${r.action}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: Suggestion[] = [];
  for (const [k, g] of groups) {
    const [risk, action] = k.split("\u0000") as ["low" | "medium", string];
    const s = suggestGroup(action, risk, g, minSample, target);
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.sample - a.sample || a.rule.id.localeCompare(b.rule.id));
}

/** Prepend suggestions to the current policy and validate with the same schema the save path uses. */
export function draftPolicy(current: PolicyDocument, suggestions: readonly Suggestion[]): PolicyDocument {
  const existing = new Set(current.rules.map((r) => r.id));
  const add = suggestions.map((s) => s.rule).filter((r) => !existing.has(r.id));
  return PolicyDocument.parse({ rules: [...add, ...current.rules].slice(0, 200), default: current.default });
}
