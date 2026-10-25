/**
 * Golden eval gate for the TypeScript pipeline (the code the API runs).
 * - evals/golden/cases.jsonl: categorisation cases (expected codes; `review: true` means a human must be asked)
 * - evals/golden/scenarios.json: reconciliation and VAT scenarios
 * Offline by default (rules only, deterministic). With LLM_BASE_URL set, unknowns go to the LLM like production.
 * Usage: npm run evals [-- --threshold 0.9]. Writes evals/results/ts-latest.json; exits 1 below threshold.
 * When LANGFUSE_* env vars are set, the run and its score are traced to Langfuse.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cats from "../packages/domain-uk-tax/categories.json" with { type: "json" };
import {
  categoriseLines,
  detectAnomalies,
  reconcile,
  computeVatReturn,
  vatInvariantsHold,
  tracerFromEnv,
  openAiCompatible,
  type BankLine,
  type CategoryRule,
} from "../packages/pipeline/src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const threshold = Number(arg("--threshold") ?? 0.9);

type Case = { desc: string; pence: number; expect: string | string[]; tags: string[]; currency?: string; review?: boolean };
const cases: Case[] = readFileSync(`${ROOT}evals/golden/cases.jsonl`, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const scenarios = JSON.parse(readFileSync(`${ROOT}evals/golden/scenarios.json`, "utf8")) as Record<string, any>[];

const rules: CategoryRule[] = cats.accounts.flatMap((a) =>
  a.kw
    .filter((k) => k.trim().length >= 2)
    .map((k, i) => ({ id: `${a.code}-${i}`, pattern: k.trim().toUpperCase(), matchType: "contains" as const, categoryCode: a.code, priority: 100 })),
);
const codes = new Set([...cats.accounts.map((a) => a.code), "8000"]);
const llm = process.env.LLM_BASE_URL ? openAiCompatible(process.env.LLM_BASE_URL, process.env.LLM_API_KEY ?? "", process.env.LLM_MODEL ?? "auto") : undefined;
const tracer = tracerFromEnv(process.env);

type Row = { id: string; tags: string[]; pass: boolean; detail: string };
const rows: Row[] = [];
const trace = tracer.trace("eval:golden", { cases: cases.length, scenarios: scenarios.length, llm: !!llm });

const lines: BankLine[] = cases.map((c, i) => ({
  id: `c${i}`,
  date: "2026-07-01",
  description: c.desc,
  amountPence: c.pence,
  ...(c.currency ? { currency: c.currency } : {}),
}));
const res = await trace.span("categorise", { lines: lines.length }, () => categoriseLines(lines, rules, codes, llm));
const flagged = new Set([...res.exceptions, ...detectAnomalies(lines)].map((e) => e.subjectId).filter(Boolean));
cases.forEach((c, i) => {
  const got = res.items.find((x) => x.lineId === `c${i}`)!;
  const exp = Array.isArray(c.expect) ? c.expect : [c.expect];
  const codeOk = exp.includes(got.categoryCode);
  const reviewOk = c.review ? flagged.has(`c${i}`) : true;
  rows.push({
    id: c.desc,
    tags: c.tags,
    pass: codeOk && reviewOk,
    detail: `expect=${exp.join("|")} got=${got.categoryCode} (${got.method}, ${got.confidence})${c.review ? ` review=${flagged.has(`c${i}`)}` : ""}`,
  });
});

for (const s of scenarios) {
  if (s.kind === "reconcile") {
    const m = reconcile(s.lines, s.receipts, s.invoices)
      .map((x) => [x.lineId, x.refId].join(">"))
      .sort();
    const e = (s.expect as string[][]).map((p) => p.join(">")).sort();
    rows.push({
      id: s.id,
      tags: s.tags,
      pass: JSON.stringify(m) === JSON.stringify(e),
      detail: `expect=${e.join(",") || "none"} got=${m.join(",") || "none"}`,
    });
  } else if (s.kind === "vat") {
    const r = computeVatReturn(s.lines, { scheme: s.scheme, periodStart: "2026-07-01", periodEnd: "2026-09-30", flatRatePercent: s.flatRatePercent ?? null });
    const bad = Object.entries(s.expect as Record<string, number>).filter(([k, v]) => (r as unknown as Record<string, number>)[k] !== v);
    rows.push({
      id: s.id,
      tags: s.tags,
      pass: !bad.length && vatInvariantsHold(r),
      detail: bad.length ? bad.map(([k, v]) => `${k}: expect ${v} got ${(r as unknown as Record<string, number>)[k]}`).join("; ") : "ok",
    });
  }
}

const acc = rows.filter((r) => r.pass).length / rows.length;
const byTag: Record<string, { pass: number; total: number }> = {};
for (const r of rows)
  for (const t of r.tags) {
    const b = (byTag[t] ??= { pass: 0, total: 0 });
    b.total++;
    if (r.pass) b.pass++;
  }
trace.end({ accuracy: acc, byTag }, [{ name: "accuracy", value: acc }]);
await tracer.flush();

mkdirSync(`${ROOT}evals/results`, { recursive: true });
writeFileSync(`${ROOT}evals/results/ts-latest.json`, JSON.stringify({ accuracy: acc, threshold, total: rows.length, byTag, rows }, null, 2) + "\n");
for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.id.slice(0, 40).padEnd(40)} ${r.detail}`);
console.log(
  Object.entries(byTag)
    .map(([t, v]) => `${t} ${v.pass}/${v.total}`)
    .join("  "),
);
console.log(`accuracy=${acc.toFixed(3)} (${rows.filter((r) => r.pass).length}/${rows.length}) threshold=${threshold} -> ${acc >= threshold ? "PASS" : "FAIL"}`);
process.exit(acc >= threshold ? 0 : 1);
