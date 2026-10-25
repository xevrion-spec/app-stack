/**
 * Categorisation that learns from corrections. Each user override is evidence for (merchant key -> category). When a key has
 * enough consistent evidence it becomes a per-tenant rule with a confidence; conflicting or stale evidence lowers it.
 * Output rules plug straight into the existing rule engine (priority above the global keyword table).
 */
import { merchantKey } from "./text.js";

export interface Correction {
  description: string;
  categoryCode: string;
  vatRateCode?: string | null;
  at: string; // ISO timestamp
  amountPence?: number;
}
export interface LearnedRule {
  pattern: string;
  categoryCode: string;
  vatRateCode: string | null;
  confidence: number;
  evidence: number;
  conflicting: number;
  direction: "in" | "out" | "any";
}

/** Exponential decay: a correction loses half its weight every `halfLifeDays`. */
export function learnRules(
  corrections: Correction[],
  now: string,
  opts: { minEvidence?: number; minConfidence?: number; halfLifeDays?: number } = {},
): LearnedRule[] {
  const minEvidence = opts.minEvidence ?? 2;
  const minConf = opts.minConfidence ?? 0.75;
  const hl = opts.halfLifeDays ?? 180;
  const byKey = new Map<string, Correction[]>();
  for (const c of corrections) {
    const k = merchantKey(c.description);
    if (k.length < 3) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), c]);
  }
  const out: LearnedRule[] = [];
  for (const [key, cs] of byKey) {
    const w = new Map<string, number>();
    const count = new Map<string, number>();
    let total = 0;
    for (const c of cs) {
      const age = Math.max(0, (Date.parse(now) - Date.parse(c.at)) / 86_400_000);
      const weight = Math.pow(0.5, age / hl);
      w.set(c.categoryCode, (w.get(c.categoryCode) ?? 0) + weight);
      count.set(c.categoryCode, (count.get(c.categoryCode) ?? 0) + 1);
      total += weight;
    }
    const [code, weight] = [...w].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    const evidence = count.get(code)!;
    if (evidence < minEvidence) continue;
    const share = weight / total;
    // Shrinkage: more evidence -> closer to the observed share.
    const confidence = Math.round(((share * evidence) / (evidence + 0.5)) * 100) / 100;
    if (confidence < minConf) continue;
    const winners = cs.filter((c) => c.categoryCode === code);
    const latest = [...winners].sort((a, b) => b.at.localeCompare(a.at))[0]!;
    const signs = new Set(winners.map((c) => (c.amountPence === undefined ? "any" : c.amountPence > 0 ? "in" : "out")));
    out.push({
      pattern: key,
      categoryCode: code,
      vatRateCode: latest.vatRateCode ?? null,
      confidence,
      evidence,
      conflicting: cs.length - evidence,
      direction: signs.size === 1 ? ([...signs][0] as LearnedRule["direction"]) : "any",
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence || a.pattern.localeCompare(b.pattern));
}
