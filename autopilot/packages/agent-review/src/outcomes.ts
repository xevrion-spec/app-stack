import { quantile } from "./analytics.js";

/**
 * D6 cost / latency / outcome analytics per action. Cost is only estimated when the customer supplies their own
 * loaded reviewer cost and minutes-per-review; we never invent a price.
 */
export interface RequestFact {
  action: string;
  status: "pending" | "escalated" | "approved" | "rejected" | "expired" | "cancelled";
  routeOutcome: "auto_approve" | "human" | "reject" | null;
  createdAt: string;
  decidedAt: string | null;
  humanDecisions: number;
  escalated: boolean;
}
export interface CostInputs {
  hourlyCost?: number;
  minutesPerDecision?: number;
}
export interface ActionSummary {
  action: string;
  requests: number;
  outcomes: Record<RequestFact["status"], number>;
  autoDecidedRate: number;
  escalationRate: number;
  expiryRate: number;
  humanDecisions: number;
  decisionLatency: { p50Seconds: number | null; p90Seconds: number | null; p99Seconds: number | null };
  estimatedHumanCost: number | null;
  estimatedCostAvoided: number | null;
}
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const STATUSES = ["pending", "escalated", "approved", "rejected", "expired", "cancelled"] as const;

function costOf(decisions: number, c: CostInputs): number | null {
  if (c.hourlyCost === undefined || c.minutesPerDecision === undefined) return null;
  return r2((decisions * c.minutesPerDecision * c.hourlyCost) / 60);
}

function summarise(action: string, rows: readonly RequestFact[], c: CostInputs): ActionSummary {
  const outcomes = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<RequestFact["status"], number>;
  for (const r of rows) outcomes[r.status]++;
  const auto = rows.filter((r) => r.routeOutcome === "auto_approve" || r.routeOutcome === "reject").length;
  const lat = rows
    .filter((r) => r.decidedAt !== null && r.routeOutcome !== "auto_approve" && r.routeOutcome !== "reject")
    .map((r) => Math.max(0, (Date.parse(r.decidedAt!) - Date.parse(r.createdAt)) / 1000))
    .sort((a, b) => a - b);
  const human = rows.reduce((s, r) => s + r.humanDecisions, 0);
  const avg = human / Math.max(1, rows.length - auto);
  const q = (p: number) => {
    const v = quantile(lat, p);
    return v === null ? null : r3(v);
  };
  return {
    action,
    requests: rows.length,
    outcomes,
    autoDecidedRate: r3(auto / rows.length),
    escalationRate: r3(rows.filter((r) => r.escalated).length / rows.length),
    expiryRate: r3(outcomes.expired / rows.length),
    humanDecisions: human,
    decisionLatency: { p50Seconds: q(0.5), p90Seconds: q(0.9), p99Seconds: q(0.99) },
    estimatedHumanCost: costOf(human, c),
    estimatedCostAvoided: costOf(auto * (rows.length > auto ? avg : 1), c),
  };
}

export function outcomeSummary(rows: readonly RequestFact[], c: CostInputs = {}): { total: ActionSummary | null; byAction: ActionSummary[] } {
  const by = new Map<string, RequestFact[]>();
  for (const r of rows) by.set(r.action, [...(by.get(r.action) ?? []), r]);
  const byAction = [...by].map(([a, g]) => summarise(a, g, c)).sort((x, y) => y.requests - x.requests || x.action.localeCompare(y.action));
  return { total: rows.length ? summarise("*", rows, c) : null, byAction };
}
