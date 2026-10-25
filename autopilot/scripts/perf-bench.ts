/**
 * In-process API benchmark on synthetic data (real SQLite + migrations). Times hot endpoints at N transactions and, with
 * --without-0010, after dropping the 0010 indexes so the index gain can be measured.  npx tsx scripts/perf-bench.ts 100000
 */
import { readFileSync } from "node:fs";
import { makeEnv, client } from "../apps/api/test/harness.js";

const N = Number(process.argv[2] ?? 10000);
const DROP = process.argv.includes("--without-0010");
const A = "bench@example.test";
const h = makeEnv({ RATE_LIMIT_PER_MINUTE: "100000000" });
const call = client(h.env);
await call("POST", "/v1/tenants", { user: A, body: { name: "Bench (synthetic)" } });
// 200 other users across other tenants so the membership lookup has something to scan.
for (let i = 0; i < 200; i++) await call("POST", "/v1/tenants", { user: `other${i}@example.test`, body: { name: `O${i}` } });
const tid = (await call("GET", "/v1/me", { user: A })).json.tenantId as string;
const ins = h.raw.prepare(
  "insert into transactions (tenant_id, id, source, txn_date, description, amount_pence, currency, fingerprint, status, created_at) values (?, ?, 'csv', ?, ?, ?, 'GBP', ?, 'new', ?)",
);
h.raw.transaction(() => {
  for (let i = 0; i < N; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + (i % 365) * 86400000).toISOString().slice(0, 10);
    ins.run(
      tid,
      `t${i}`,
      d,
      `SYNTHETIC MERCHANT ${i % 97}`,
      i % 3 ? -(100 + (i % 5000)) : 25000 + i,
      `fp${i}`,
      `2026-01-01 ${String(Math.floor(i / 3600) % 24).padStart(2, "0")}:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
    );
  }
})();
if (DROP)
  for (const m of readFileSync("migrations-down/0010_perf_indexes.down.sql", "utf8").matchAll(/drop index if exists (\w+)/g))
    h.raw.exec(`drop index if exists ${m[1]}`);
h.raw.exec("analyze");
const cases: [string, string, unknown?][] = [
  ["GET", "/v1/me"],
  ["GET", "/v1/transactions?limit=50"],
  ["GET", "/v1/exceptions"],
  ["GET", "/v1/activity"],
  ["GET", "/v1/books/reports/pnl?from=2026-01-01&to=2026-12-31"],
  ["POST", "/v1/assistant/ask", { question: "What did I spend in 2026?", today: "2026-12-31" }],
  ["GET", "/v1/export/transactions.csv"],
];
const out: Record<string, { p50: number; p95: number }> = {};
for (const [m, p, body] of cases) {
  const runs = p.includes("export") || p.includes("ask") || p.includes("pnl") ? 5 : 40;
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    const r = await call(m, p, { user: A, ...(body ? { body } : {}) });
    if (r.status !== 200) throw new Error(`${p} ${r.status}`);
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  out[`${m} ${p.split("?")[0]}`] = {
    p50: +t[Math.floor(t.length * 0.5)]!.toFixed(1),
    p95: +t[Math.min(t.length - 1, Math.floor(t.length * 0.95))]!.toFixed(1),
  };
}
console.log(JSON.stringify({ n: N, indexes0010: !DROP, ms: out }, null, 1));
