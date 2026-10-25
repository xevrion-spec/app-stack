/**
 * Held-out categorisation accuracy: lines the RULES DO NOT match (evals/golden/holdout.jsonl, synthetic, written apart
 * from the rules). Measures rules-only vs rules+LLM (FreeLLMAPI via LLM_BASE_URL) on the production code path.
 * A line marked `review: true` passes only if it is flagged for human review. "Silent errors" = wrong code AND not flagged.
 * Usage: LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=auto npx tsx scripts/eval-llm.ts [--runs 3]
 * Writes evals/results/llm-latest.json. Not a CI gate (needs the LLM). Never prints credentials.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cats from "../packages/domain-uk-tax/categories.json" with { type: "json" };
import { categoriseLines, categoriseByRules, openAiCompatible, type BankLine, type CategoryRule, type LlmClient } from "../packages/pipeline/src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const runs = Number(process.argv.includes("--runs") ? process.argv[process.argv.indexOf("--runs") + 1] : 1);
type Case = { desc: string; pence: number; expect: string | string[]; tags: string[]; review?: boolean };
const all: Case[] = readFileSync(`${ROOT}evals/golden/holdout.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const rules: CategoryRule[] = cats.accounts.flatMap((a) =>
  a.kw
    .filter((k) => k.trim().length >= 2)
    .map((k, i) => ({ id: `${a.code}-${i}`, pattern: k.trim().toUpperCase(), matchType: "contains" as const, categoryCode: a.code, priority: 100 })),
);
const codes = new Set([...cats.accounts.map((a) => a.code), "8000"]);
const toLine = (c: Case, i: number): BankLine => ({ id: `h${i}`, date: "2026-07-01", description: c.desc, amountPence: c.pence });
const cases = all.filter((c, i) => !categoriseByRules(toLine(c, i), rules));
const excluded = all.length - cases.length;
const lines = cases.map(toLine);

async function evaluate(llm?: LlmClient) {
  let invalid = 0;
  const counting: LlmClient | undefined = llm && { complete: async (p) => llm.complete(p) };
  const t0 = Date.now();
  const res = await categoriseLines(lines, rules, codes, counting);
  const ms = Date.now() - t0;
  if (res.exceptions.some((e) => e.reasonCode === "LLM_INVALID_OUTPUT")) invalid++;
  const flagged = new Set(res.exceptions.map((e) => e.subjectId).filter(Boolean));
  let correct = 0,
    silent = 0,
    reviewOk = 0,
    reviewN = 0,
    autoN = 0,
    byLlm = 0;
  const misses: string[] = [];
  cases.forEach((c, i) => {
    const got = res.items.find((x) => x.lineId === `h${i}`)!;
    if (got.method === "llm") byLlm++;
    const exp = Array.isArray(c.expect) ? c.expect : [c.expect];
    const codeOk = exp.includes(got.categoryCode);
    const isFlagged = flagged.has(`h${i}`);
    if (!isFlagged) autoN++;
    if (c.review) {
      reviewN++;
      if (isFlagged) reviewOk++;
      else misses.push(`${c.desc}: NOT flagged (${got.categoryCode} @${got.confidence})`);
    } else if (codeOk) correct++;
    else misses.push(`${c.desc}: got ${got.categoryCode} @${got.confidence}${isFlagged ? " (flagged)" : ""}`);
    if (!codeOk && !isFlagged) silent++;
  });
  const plain = cases.length - reviewN;
  return {
    codeAccuracy: Math.round((correct / plain) * 1000) / 10,
    correct,
    plain,
    reviewCasesFlagged: `${reviewOk}/${reviewN}`,
    silentErrors: silent,
    unflagged: autoN,
    decidedByLlm: byLlm,
    invalidOutputBatches: invalid,
    ms,
    misses,
  };
}

const baseline = await evaluate();
const llm = process.env.LLM_BASE_URL
  ? openAiCompatible(process.env.LLM_BASE_URL, process.env.LLM_API_KEY ?? "", process.env.LLM_MODEL ?? "auto", fetch, 60_000)
  : undefined;
const llmRuns = [];
if (llm) for (let r = 0; r < runs; r++) llmRuns.push(await evaluate(llm));
const out = {
  ranAt: new Date().toISOString(),
  data: "synthetic held-out lines the rules do not match (evals/golden/holdout.jsonl)",
  cases: cases.length,
  excludedBecauseRulesMatched: excluded,
  model: llm ? (process.env.LLM_MODEL ?? "auto") : null,
  rulesOnly: baseline,
  rulesPlusLlm: llmRuns,
};
mkdirSync(`${ROOT}evals/results`, { recursive: true });
writeFileSync(`${ROOT}evals/results/llm-latest.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, rulesOnly: { ...baseline, misses: baseline.misses.length } }, null, 1));
