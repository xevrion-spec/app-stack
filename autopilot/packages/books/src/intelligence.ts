/**
 * Practice intelligence (ADR 0026): explainable anomaly detection, accuracy evaluation against accountant corrections,
 * drift alerts and a rules-based question router. Pure functions; every finding carries reason codes, a confidence and
 * evidence ids so a human can check it.
 */
import { merchantKey, daysBetween } from "./text.js";
import { learnRules, type LearnedRule } from "./learning.js";

export interface AnomalyTxn {
  id: string;
  date: string;
  description: string | null;
  amountPence: number;
  categoryCode: string | null;
  vatRateCode: string | null;
  vatPence: number | null;
  hasReceipt: boolean;
}
export type AnomalyCode = "duplicate_payment" | "missing_receipt" | "unusual_vat" | "round_sum" | "weekend_posting";
export interface Anomaly {
  code: AnomalyCode;
  transactionId: string;
  severity: "low" | "medium" | "high";
  confidence: number;
  reason: string;
  evidence: string[];
}
export interface AnomalyOptions {
  receiptThresholdPence?: number;
  roundSumMinPence?: number;
  duplicateWindowDays?: number;
}
const VAT_RATES: Record<string, number> = { STD: 0.2, RED: 0.05, ZERO: 0, EXEMPT: 0, OUT: 0 };
const isWeekend = (d: string) => {
  const w = new Date(`${d}T00:00:00Z`).getUTCDay();
  return w === 0 || w === 6;
};
const pounds = (p: number) => `£${(Math.abs(p) / 100).toFixed(2)}`;

function duplicateAnomalies(txns: AnomalyTxn[], window: number): Anomaly[] {
  const out: Anomaly[] = [];
  // Same signed amount and merchant key within the window (each item against the previous one in its group).
  const groups = new Map<string, AnomalyTxn[]>();
  for (const t of txns) {
    if (t.amountPence >= 0) continue;
    const k = `${t.amountPence}|${merchantKey(t.description ?? "")}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  for (const g of groups.values()) {
    const s = [...g].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1]!;
      const cur = s[i]!;
      const gap = daysBetween(prev.date, cur.date);
      if (gap > window) continue;
      out.push({
        code: "duplicate_payment",
        transactionId: cur.id,
        severity: gap <= 1 ? "high" : "medium",
        confidence: gap === 0 ? 0.9 : gap <= 1 ? 0.8 : 0.6,
        reason: `Same amount (${pounds(cur.amountPence)}) and payee as ${prev.id} ${gap} day(s) earlier`,
        evidence: [prev.id, cur.id],
      });
    }
  }
  return out;
}
function missingReceipt(t: AnomalyTxn, min: number): Anomaly | null {
  if (t.amountPence >= 0 || -t.amountPence < min || t.hasReceipt) return null;
  return {
    code: "missing_receipt",
    transactionId: t.id,
    severity: -t.amountPence >= min * 4 ? "high" : "medium",
    confidence: 0.95,
    reason: `Expense of ${pounds(t.amountPence)} has no receipt attached (threshold ${pounds(min)})`,
    evidence: [t.id],
  };
}
function unusualVat(t: AnomalyTxn): Anomaly | null {
  const rate = t.vatRateCode ? VAT_RATES[t.vatRateCode] : undefined;
  if (rate === undefined || t.vatPence == null || t.vatPence === 0) return null;
  const gross = Math.abs(t.amountPence);
  const expected = Math.round((gross * rate) / (1 + rate));
  const diff = Math.abs(Math.abs(t.vatPence) - expected);
  if (rate !== 0 && diff <= Math.max(2, expected * 0.02)) return null;
  return {
    code: "unusual_vat",
    transactionId: t.id,
    severity: rate === 0 ? "high" : "medium",
    confidence: rate === 0 ? 0.9 : 0.7,
    reason:
      rate === 0
        ? `VAT of ${pounds(t.vatPence)} on a ${t.vatRateCode} transaction`
        : `VAT ${pounds(t.vatPence)} differs from the ${t.vatRateCode} expectation ${pounds(expected)} for ${pounds(gross)} gross`,
    evidence: [t.id],
  };
}
const roundSum = (t: AnomalyTxn, min: number): Anomaly | null =>
  Math.abs(t.amountPence) >= min && Math.abs(t.amountPence) % 10_000 === 0
    ? { code: "round_sum", transactionId: t.id, severity: "low", confidence: 0.5, reason: `Round amount ${pounds(t.amountPence)}`, evidence: [t.id] }
    : null;
const weekend = (t: AnomalyTxn): Anomaly | null =>
  isWeekend(t.date)
    ? { code: "weekend_posting", transactionId: t.id, severity: "low", confidence: 0.4, reason: `Dated on a weekend (${t.date})`, evidence: [t.id] }
    : null;

/** Finds anomalies. Each transaction can carry several codes; output is sorted by severity then date. */
export function detectAnomalies(txns: AnomalyTxn[], o: AnomalyOptions = {}): Anomaly[] {
  const receiptMin = o.receiptThresholdPence ?? 25_000;
  const roundMin = o.roundSumMinPence ?? 50_000;
  const out = duplicateAnomalies(txns, o.duplicateWindowDays ?? 7);
  for (const t of txns) for (const a of [missingReceipt(t, receiptMin), unusualVat(t), roundSum(t, roundMin), weekend(t)]) if (a) out.push(a);
  const rank = { high: 0, medium: 1, low: 2 };
  const date = new Map(txns.map((t) => [t.id, t.date]));
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] || (date.get(a.transactionId) ?? "").localeCompare(date.get(b.transactionId) ?? "") || a.code.localeCompare(b.code),
  );
}

// ---------------- evaluation against accountant corrections ----------------
export interface ReviewRecord {
  tenantId: string;
  aiCategoryCode: string | null;
  aiConfidence: number | null;
  finalCategoryCode: string;
  method: "manual" | "bulk" | "auto_rule" | "qa";
  reviewedAt: string;
}
export interface AccuracyBucket {
  key: string;
  n: number;
  correct: number;
  accuracy: number | null;
  meanConfidence: number | null;
  calibrationGap: number | null;
}
const bucket = (key: string, rs: ReviewRecord[]): AccuracyBucket => {
  const n = rs.length;
  const correct = rs.filter((r) => r.aiCategoryCode === r.finalCategoryCode).length;
  const confs = rs.map((r) => r.aiConfidence).filter((c): c is number => c != null);
  const acc = n ? Math.round((correct / n) * 1000) / 1000 : null;
  const mc = confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 1000) / 1000 : null;
  return { key, n, correct, accuracy: acc, meanConfidence: mc, calibrationGap: acc != null && mc != null ? Math.round((mc - acc) * 1000) / 1000 : null };
};
/** Accuracy = share of reviewed items where the AI category survived review. Only human-reviewed methods count (auto_rule excluded). */
export function evaluate(records: ReviewRecord[]) {
  const human = records.filter((r) => r.method !== "auto_rule");
  const by = <K extends string>(f: (r: ReviewRecord) => K) => {
    const m = new Map<K, ReviewRecord[]>();
    for (const r of human) m.set(f(r), [...(m.get(f(r)) ?? []), r]);
    return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([k, rs]) => bucket(k, rs));
  };
  const confusion = new Map<string, number>();
  for (const r of human)
    if (r.aiCategoryCode !== r.finalCategoryCode)
      confusion.set(`${r.aiCategoryCode ?? "none"}→${r.finalCategoryCode}`, (confusion.get(`${r.aiCategoryCode ?? "none"}→${r.finalCategoryCode}`) ?? 0) + 1);
  const bands = by((r) =>
    r.aiConfidence == null ? "unknown" : r.aiConfidence >= 0.95 ? "0.95+" : r.aiConfidence >= 0.8 ? "0.80-0.95" : r.aiConfidence >= 0.5 ? "0.50-0.80" : "<0.50",
  );
  return {
    overall: bucket("all", human),
    byMonth: by((r) => r.reviewedAt.slice(0, 7)),
    byClient: by((r) => r.tenantId),
    byConfidenceBand: bands,
    topConfusions: [...confusion]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([pair, n]) => ({ pair, n })),
    excludedAutoApproved: records.length - human.length,
  };
}
export interface DriftAlert {
  code: "accuracy_drop" | "overconfidence" | "qa_failure_rate";
  scope: string;
  severity: "medium" | "high";
  reason: string;
  recent: number;
  baseline: number | null;
  n: number;
}
/** Compares the last `recentDays` to the `baselineDays` before it. Needs at least `minN` items in each window. */
export function driftAlerts(
  records: ReviewRecord[],
  asOf: string,
  o: { recentDays?: number; baselineDays?: number; minN?: number; dropPp?: number } = {},
): DriftAlert[] {
  const recentDays = o.recentDays ?? 30,
    baselineDays = o.baselineDays ?? 90,
    minN = o.minN ?? 20,
    drop = o.dropPp ?? 0.05;
  const age = (r: ReviewRecord) => daysBetween(r.reviewedAt.slice(0, 10), asOf);
  const human = records.filter((r) => r.method !== "auto_rule");
  const recent = human.filter((r) => age(r) >= 0 && age(r) < recentDays);
  const base = human.filter((r) => age(r) >= recentDays && age(r) < recentDays + baselineDays);
  const out: DriftAlert[] = [];
  const scopes = ["all", ...new Set(human.map((r) => r.tenantId))].sort((a, b) => (a === "all" ? -1 : b === "all" ? 1 : a.localeCompare(b)));
  for (const s of scopes) {
    const rr = s === "all" ? recent : recent.filter((r) => r.tenantId === s);
    const bb = s === "all" ? base : base.filter((r) => r.tenantId === s);
    if (rr.length < minN) continue;
    const r = bucket(s, rr);
    if (bb.length >= minN) {
      const b = bucket(s, bb);
      if (b.accuracy! - r.accuracy! > drop)
        out.push({
          code: "accuracy_drop",
          scope: s,
          severity: b.accuracy! - r.accuracy! > drop * 2 ? "high" : "medium",
          reason: `Accuracy fell from ${(b.accuracy! * 100).toFixed(1)}% to ${(r.accuracy! * 100).toFixed(1)}%`,
          recent: r.accuracy!,
          baseline: b.accuracy!,
          n: rr.length,
        });
    }
    if (r.calibrationGap != null && r.calibrationGap > 0.1)
      out.push({
        code: "overconfidence",
        scope: s,
        severity: r.calibrationGap > 0.2 ? "high" : "medium",
        reason: `Mean confidence ${(r.meanConfidence! * 100).toFixed(0)}% vs accuracy ${(r.accuracy! * 100).toFixed(0)}%`,
        recent: r.calibrationGap,
        baseline: null,
        n: rr.length,
      });
  }
  const qa = records.filter((r) => r.method === "qa" && age(r) >= 0 && age(r) < recentDays);
  if (qa.length >= Math.max(5, Math.floor(minN / 4))) {
    const fail = qa.filter((r) => r.aiCategoryCode !== r.finalCategoryCode).length / qa.length;
    if (fail > 0.05)
      out.push({
        code: "qa_failure_rate",
        scope: "all",
        severity: fail > 0.15 ? "high" : "medium",
        reason: `${(fail * 100).toFixed(0)}% of QA-sampled auto-approvals were corrected; tighten auto-approve thresholds`,
        recent: Math.round(fail * 1000) / 1000,
        baseline: null,
        n: qa.length,
      });
  }
  return out;
}

// ---------------- practice-level learning ----------------
export interface PracticeCorrection {
  reviewId: string;
  tenantId: string;
  description: string;
  categoryCode: string;
  amountPence: number;
  at: string;
}
export interface ScopedRule extends LearnedRule {
  scope: "practice" | "client";
  tenantId: string | null;
  clients: number;
  provenance: string[];
}
/**
 * Client rules come from one client's corrections. A pattern becomes a PRACTICE rule only when at least `minClients`
 * distinct clients independently agree on the category (one client cannot teach the whole firm).
 */
export function learnPracticeRules(cs: PracticeCorrection[], now: string, minClients = 2): ScopedRule[] {
  const out: ScopedRule[] = [];
  const byTenant = new Map<string, PracticeCorrection[]>();
  for (const c of cs) byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c]);
  const clientRules: ScopedRule[] = [];
  for (const [tid, list] of [...byTenant].sort((a, b) => a[0].localeCompare(b[0])))
    for (const r of learnRules(
      list.map((c) => ({ description: c.description, categoryCode: c.categoryCode, at: c.at, amountPence: c.amountPence })),
      now,
    )) {
      const prov = list.filter((c) => merchantKey(c.description) === r.pattern && c.categoryCode === r.categoryCode).map((c) => c.reviewId);
      clientRules.push({ ...r, scope: "client", tenantId: tid, clients: 1, provenance: prov.sort() });
    }
  const byPattern = new Map<string, ScopedRule[]>();
  for (const r of clientRules) byPattern.set(`${r.pattern}|${r.categoryCode}`, [...(byPattern.get(`${r.pattern}|${r.categoryCode}`) ?? []), r]);
  for (const rs of byPattern.values()) {
    if (rs.length >= minClients) {
      const evidence = rs.reduce((a, r) => a + r.evidence, 0);
      const conflicting = rs.reduce((a, r) => a + r.conflicting, 0);
      out.push({
        ...rs[0]!,
        scope: "practice",
        tenantId: null,
        clients: rs.length,
        evidence,
        conflicting,
        confidence: Math.round(Math.min(...rs.map((r) => r.confidence)) * 100) / 100,
        provenance: rs.flatMap((r) => r.provenance).sort(),
      });
    } else out.push(...rs);
  }
  return out.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "practice" ? -1 : 1) || b.confidence - a.confidence || a.pattern.localeCompare(b.pattern));
}
/** Explains which rule (if any) would categorise a description: client rules beat practice rules. */
export function suggestFromRules(
  description: string,
  amountPence: number,
  rules: Pick<ScopedRule, "pattern" | "categoryCode" | "confidence" | "scope" | "direction" | "provenance">[],
) {
  const k = merchantKey(description);
  const dirOk = (d: string) => d === "any" || (d === "in" ? amountPence > 0 : amountPence < 0);
  const hit = [...rules]
    .filter((r) => r.pattern === k && dirOk(r.direction))
    .sort((a, b) => (a.scope === b.scope ? b.confidence - a.confidence : a.scope === "client" ? -1 : 1))[0];
  if (!hit) return null;
  return {
    categoryCode: hit.categoryCode,
    confidence: hit.confidence,
    reasonCodes: [`learned_${hit.scope}_rule`],
    reason: `${hit.scope === "client" ? "This client's" : "Firm-wide"} reviewers categorised "${k}" as ${hit.categoryCode} (${hit.provenance.length} correction(s))`,
    evidence: hit.provenance.slice(0, 20),
  };
}

// ---------------- practice assistant router ----------------
export type PracticeIntent =
  "overdue_deadlines" | "upcoming_deadlines" | "review_backlog" | "worst_health" | "anomalies" | "open_queries" | "wip" | "missing_documents" | "accuracy";
const INTENTS: [PracticeIntent, RegExp][] = [
  ["overdue_deadlines", /\b(overdue|late|missed)\b.*\b(deadline|return|filing|vat|mtd)s?\b|\b(deadline|return|filing)s?\b.*\b(overdue|late|missed)\b/i],
  ["upcoming_deadlines", /\b(deadline|due|filing)s?\b|\bdue (soon|this|next)\b/i],
  ["review_backlog", /\b(review|awaiting|backlog|unreviewed|queue)\b/i],
  ["worst_health", /\b(health|risk|at risk|worst|struggling|attention)\b/i],
  ["anomalies", /\b(anomal\w*|duplicate|suspicious|unusual|round sum|weekend)\b/i],
  ["open_queries", /\b(quer(y|ies)|question|answered|waiting on (the )?client)\b/i],
  ["wip", /\b(wip|work in progress|unbilled|billable|bill)\b/i],
  ["missing_documents", /\b(documents?|receipts?|uploads?|paperwork|missing)\b/i],
  ["accuracy", /\b(accura\w*|drift|correct(ions)?|how good|precision)\b/i],
];
/** Deterministic, auditable routing. Order matters (specific before general). Returns null when nothing matches. */
export function routeIntent(question: string): { intent: PracticeIntent; matched: string } | null {
  for (const [intent, re] of INTENTS) {
    const m = question.match(re);
    if (m) return { intent, matched: m[0] };
  }
  return null;
}
export const ALL_INTENTS = INTENTS.map(([i]) => i);
