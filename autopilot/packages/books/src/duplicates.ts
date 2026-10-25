/**
 * Duplicate detection across uploads. Exact: same externalId, or same date+amount+normalised description.
 * Probable: same amount, dates within `windowDays`, similar merchant (overlapping statements, pending→posted).
 */
import { merchantKey, similarity, daysBetween } from "./text.js";

export interface DupCandidate {
  id: string;
  date: string;
  description: string;
  amountPence: number;
  externalId?: string | null;
}
export interface DuplicateMatch {
  id: string;
  duplicateOf: string;
  kind: "exact" | "probable";
  score: number;
  reason: string;
}

// eslint-disable-next-line complexity -- single pass matcher; each branch is a documented match rule
export function findDuplicates(
  incoming: DupCandidate[],
  existing: DupCandidate[],
  opts: { windowDays?: number; minSimilarity?: number } = {},
): DuplicateMatch[] {
  const windowDays = opts.windowDays ?? 3;
  const minSim = opts.minSimilarity ?? 0.5;
  const out: DuplicateMatch[] = [];
  const byAmount = new Map<number, DupCandidate[]>();
  for (const e of existing) byAmount.set(e.amountPence, [...(byAmount.get(e.amountPence) ?? []), e]);
  const claimed = new Set<string>();
  const seenIncoming: DupCandidate[] = [];
  const byRef = new Map<string, DupCandidate>();
  for (const e of existing) if (e.externalId) byRef.set(e.externalId, e);
  for (const t of incoming) {
    const ref = t.externalId ? byRef.get(t.externalId) : undefined;
    if (ref && !claimed.has(ref.id)) {
      out.push({ id: t.id, duplicateOf: ref.id, kind: "exact", score: 1, reason: "same bank reference" });
      claimed.add(ref.id);
      continue;
    }
    const pool = [...(byAmount.get(t.amountPence) ?? []), ...seenIncoming.filter((s) => s.amountPence === t.amountPence)].filter((e) => !claimed.has(e.id));
    let best: DuplicateMatch | null = null;
    for (const e of pool) {
      if (t.externalId && e.externalId && t.externalId === e.externalId) {
        best = { id: t.id, duplicateOf: e.id, kind: "exact", score: 1, reason: "same bank reference" };
        break;
      }
      const gap = Math.abs(daysBetween(e.date, t.date));
      const mk = merchantKey(t.description);
      const ek = merchantKey(e.description);
      if (gap === 0 && t.description.trim().toUpperCase() === e.description.trim().toUpperCase()) {
        best = { id: t.id, duplicateOf: e.id, kind: "exact", score: 1, reason: "same date, amount and description" };
        break;
      }
      const sim = similarity(mk, ek);
      if (gap <= windowDays && sim >= minSim) {
        const score = Math.round((sim * 0.7 + (1 - gap / (windowDays + 1)) * 0.3) * 100) / 100;
        if (!best || score > best.score)
          best = { id: t.id, duplicateOf: e.id, kind: "probable", score, reason: `same amount, ${gap} day(s) apart, similar description` };
      }
    }
    if (best) {
      out.push(best);
      claimed.add(best.duplicateOf);
    } else seenIncoming.push(t);
  }
  return out;
}
