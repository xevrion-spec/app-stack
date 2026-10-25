/**
 * Load test against a LOCAL API only (default http://127.0.0.1:8787, synthetic data). Refuses non-local targets.
 *   npm run local -- --api-only   (in another terminal)
 *   npx tsx scripts/load.ts --duration 20 --concurrency 20
 * Reports throughput, p50/p95/p99 latency and error/429 counts per scenario; exits 1 if read p95 > --p95 ms or errors > 1%.
 */
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1]! : d;
};
const BASE = arg("base", "http://127.0.0.1:8787");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(BASE)) {
  console.error("load.ts only targets a local API");
  process.exit(2);
}
const DURATION = Number(arg("duration", "15")) * 1000;
const CONCURRENCY = Number(arg("concurrency", "16"));
const P95 = Number(arg("p95", "250"));
const USER = `load-${Date.now()}@example.test`;

async function req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "x-dev-user": USER, ...extra };
  if (body !== undefined) headers["content-type"] = typeof body === "string" ? "text/csv" : "application/json";
  if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID();
  const t = performance.now();
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  await r.arrayBuffer();
  return { status: r.status, ms: performance.now() - t };
}

const csv = (n: number) =>
  "Date,Description,Amount\n" +
  Array.from(
    { length: n },
    (_, i) => `${String((i % 28) + 1).padStart(2, "0")}/07/2026,LOAD MERCHANT ${i % 50} REF ${Math.random().toString(36).slice(2)},-${(i % 90) + 1}.00`,
  ).join("\n");

const scenarios: [string, number, () => Promise<{ status: number; ms: number }>][] = [
  ["GET /v1/transactions", 40, () => req("GET", "/v1/transactions?limit=50&sort=-amount_pence&fields=id,amount_pence")],
  ["GET /v1/events", 15, () => req("GET", "/v1/events?limit=50")],
  ["GET /v1/search", 15, () => req("GET", "/v1/search?q=merchant")],
  [
    "POST /v1/invoices",
    15,
    () =>
      req("POST", "/v1/invoices", {
        customerName: "Load Co",
        issueDate: "2026-07-01",
        dueDate: "2026-07-31",
        lines: [{ description: "x", quantity: 1, unitPence: 1000, vatRateCode: "STD" }],
      }),
  ],
  ["POST /v1/uploads/bank-csv (50 rows)", 5, () => req("POST", "/v1/uploads/bank-csv", csv(50))],
  ["GET /v1/activity", 10, () => req("GET", "/v1/activity?limit=50")],
];
const total = scenarios.reduce((a, s) => a + s[1], 0);
const pick = () => {
  let r = Math.random() * total;
  for (const s of scenarios) if ((r -= s[1]) < 0) return s;
  return scenarios[0]!;
};

const setup = await req("POST", "/v1/tenants", { name: "Load Test Ltd" });
if (setup.status >= 400 && setup.status !== 409) throw new Error(`tenant setup failed: ${setup.status}`);
const stats = new Map<string, { ms: number[]; errors: number; limited: number }>();
const end = Date.now() + DURATION;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < end) {
      const [name, , run] = pick();
      const s = stats.get(name) ?? { ms: [], errors: 0, limited: 0 };
      stats.set(name, s);
      try {
        const r = await run();
        s.ms.push(r.ms);
        if (r.status === 429) s.limited++;
        else if (r.status >= 500) s.errors++;
      } catch {
        s.errors++;
      }
    }
  }),
);
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
let all: number[] = [];
let errs = 0;
console.log(`load: ${CONCURRENCY} workers x ${DURATION / 1000}s against ${BASE}`);
for (const [name, s] of stats) {
  all = all.concat(s.ms);
  errs += s.errors;
  console.log(
    `${name.padEnd(36)} n=${String(s.ms.length).padStart(6)}  p50=${q(s.ms, 0.5).toFixed(1)}ms  p95=${q(s.ms, 0.95).toFixed(1)}ms  p99=${q(s.ms, 0.99).toFixed(1)}ms  5xx=${s.errors}  429=${s.limited}`,
  );
}
const p95 = q(all, 0.95);
// Gate on read latency: writes (uploads run the pipeline in-process locally) are reported but not gated.
const readP95 = q(
  [...stats].filter(([n]) => n.startsWith("GET")).flatMap(([, s]) => s.ms),
  0.95,
);
console.log(
  `total n=${all.length}  rps=${(all.length / (DURATION / 1000)).toFixed(0)}  p95=${p95.toFixed(1)}ms  read-p95=${readP95.toFixed(1)}ms  error-rate=${((errs / Math.max(1, all.length)) * 100).toFixed(2)}%`,
);
if (readP95 > P95 || errs / Math.max(1, all.length) > 0.01) process.exit(1);
